# llm_adapter.py
"""
SentIQGPT v1 — Unified Dual-Model LLM Gateway (Production)

Providers:
  1. Google Gemini (3-key rotation) → reasoning, conversation, knowledge
  2. Groq (3-key rotation) → memory classification, summarization, routing

Design goals:
  - Dual-model architecture: reasoning (Gemini) + cognition (Groq)
  - Strict JSON where required
  - Task-aware routing to correct provider
  - Automatic key rotation on failure per provider
  - Token bucket rate limiting per provider
  - Disk cache (shelve) for deduplication
  - Simulation mode for dev/testing

Adapted from HealthIQ llm_adapter.py — evolved for general-purpose AI assistant.
"""

import os
import time
import json
import shelve
import hashlib
import threading
import logging
import importlib
from typing import Optional

import requests as _requests_lib

# ==============================
# Optional SDK imports
# ==============================
GENAI_MODULE = None
GROQ_MODULE = None

for name in ["google.generativeai", "google.genai", "genai"]:
    try:
        spec = importlib.util.find_spec(name)
        if spec:
            GENAI_MODULE = importlib.import_module(name)
            break
    except Exception:
        pass

try:
    spec = importlib.util.find_spec("groq")
    if spec:
        GROQ_MODULE = importlib.import_module("groq")
except Exception:
    pass

# ==============================
# Environment
# ==============================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

from dotenv import load_dotenv
load_dotenv(os.path.join(BASE_DIR, ".env"))

# --- Gemini keys ---
GEMINI_API_KEYS = [
    os.getenv("GEMINI_API_KEY", ""),
    os.getenv("GEMINI_API_KEY_2", ""),
    os.getenv("GEMINI_API_KEY_3", ""),
]
GEMINI_API_KEYS = [k for k in GEMINI_API_KEYS if k]
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

# --- Groq keys ---
GROQ_API_KEYS = [
    os.getenv("GROQ_API_KEY", ""),
    os.getenv("GROQ_API_KEY_2", ""),
    os.getenv("GROQ_API_KEY_3", ""),
]
GROQ_API_KEYS = [k for k in GROQ_API_KEYS if k]
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

# --- Smart model routing aliases ---
GEMINI_FAST_MODEL = os.getenv("SMART_MODEL_GEMINI_FAST", "gemini-2.5-flash-lite")
GEMINI_SEARCH_MODEL = os.getenv("SMART_MODEL_GEMINI_SEARCH", GEMINI_FAST_MODEL)
CODING_MODEL = os.getenv("SMART_MODEL_CODING", "qwen3-coder")
LIGHTWEIGHT_MODEL = os.getenv("SMART_MODEL_LIGHTWEIGHT", "gpt-4o-mini")

# --- Pollinations provider ---
POLLINATIONS_API_KEY = os.getenv("POLLINATIONS_API_KEY", "")
POLLINATIONS_BASE_URL = os.getenv("POLLINATIONS_BASE_URL", "https://text.pollinations.ai")
POLLINATIONS_TIMEOUT = int(os.getenv("POLLINATIONS_TIMEOUT", "90"))

# --- Cache & Rate Limits ---
_CACHE_FILE_ENV = os.getenv("SENTIQ_CACHE_FILE", "sentiq_cache.db")
CACHE_FILE = _CACHE_FILE_ENV if os.path.isabs(_CACHE_FILE_ENV) else os.path.join(BASE_DIR, _CACHE_FILE_ENV)
RPM = int(os.getenv("SENTIQ_RPM", "120"))

# ==============================
# Logger
# ==============================
logger = logging.getLogger("sentiqgpt.llm")
if not logger.handlers:
    h = logging.StreamHandler()
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(h)
logger.setLevel(logging.INFO)

# ==============================
# Rate Limiter (per-provider buckets)
# ==============================
class TokenBucket:
    def __init__(self, rpm: int):
        self.capacity = rpm
        self.tokens = float(rpm)
        self.rate = rpm / 60.0
        self.last = time.time()
        self.lock = threading.Lock()

    def consume(self, n: int = 1) -> bool:
        with self.lock:
            now = time.time()
            delta = now - self.last
            self.last = now
            self.tokens = min(self.capacity, self.tokens + delta * self.rate)
            if self.tokens >= n:
                self.tokens -= n
                return True
            return False

gemini_bucket = TokenBucket(RPM)
groq_bucket = TokenBucket(RPM)
pollinations_bucket = TokenBucket(RPM)

# ==============================
# Cache helpers
# ==============================
_shelve_lock = threading.Lock()

def _cache_key(prompt: str, task: str, model: str, provider: str, user_id: str = "") -> str:
    h = hashlib.sha256()
    h.update(f"{provider}|{task}|{model}|{user_id}|{prompt}".encode())
    return h.hexdigest()

def _cache_get(key: str) -> Optional[str]:
    try:
        with _shelve_lock:
            with shelve.open(CACHE_FILE) as db:
                if key in db:
                    return db[key]
    except Exception:
        pass
    return None

def _cache_set(key: str, value: str) -> None:
    try:
        with _shelve_lock:
            with shelve.open(CACHE_FILE) as db:
                db[key] = value
    except Exception:
        pass

# ==============================
# Task → Provider routing
# ==============================
_REGISTRY_PATH = os.path.join(BASE_DIR, "task_registry.json")
try:
    with open(_REGISTRY_PATH, "r", encoding="utf-8") as _f:
        _registry = json.load(_f)
    STRICT_JSON_TASKS = set(_registry.get("strict_json_tasks", []))
except Exception as _e:
    logger.error("Failed to load task_registry.json: %s — falling back to empty set.", _e)
    STRICT_JSON_TASKS = set()

# Tasks that should be routed to Groq instead of Gemini
GROQ_TASKS = {
    "memory_classify",
    "memory_summarize",
    "memory_compress",
    "route_classify",
}

# Everything else goes to Gemini
GEMINI_TASKS = {
    "chat",
    "file_extract",
    "image_generate",
    "general",
}

def get_provider_for_task(task: str) -> str:
    """Determine which provider handles a given task."""
    if task in GROQ_TASKS:
        return "groq"
    return "gemini"


def resolve_model_override(model_override: Optional[str], default_provider: str) -> tuple[str, Optional[str]]:
    """
    Resolve logical model names to concrete provider/model pairs.

    Routing table:
        gemini-fast        → gemini  (GEMINI_FAST_MODEL)
        gemini-search      → gemini  (GEMINI_SEARCH_MODEL)
        qwen3-coder-30b    → pollinations  (qwen3-coder)
        gpt-5-nano         → pollinations  (gpt-4o-mini)
        gemini-*           → gemini  (passthrough)
        unknown            → default_provider (passthrough)
    """
    if not model_override:
        return default_provider, None

    logical = model_override.strip().lower()

    if logical == "gemini-fast":
        return "gemini", GEMINI_FAST_MODEL

    if logical == "gemini-search":
        return "gemini", GEMINI_SEARCH_MODEL

    if logical == "qwen3-coder-30b":
        return "pollinations", CODING_MODEL

    if logical == "gpt-5-nano":
        return "pollinations", LIGHTWEIGHT_MODEL

    # Any other gemini-prefixed model stays on Gemini
    if logical.startswith("gemini"):
        return "gemini", model_override

    return default_provider, model_override

# ==============================
# Simulation (safe dev mode)
# ==============================
def simulated_response(prompt: str, task: str) -> str:
    if task in STRICT_JSON_TASKS:
        return json.dumps({"status": "simulated", "task": task})
    return "SIMULATED RESPONSE"

# ==============================
# Gemini invocation (key rotation)
# ==============================
_gemini_configure_lock = threading.Lock()

def _call_gemini(prompt: str, api_key: str, model: Optional[str] = None) -> str:
    if not GENAI_MODULE:
        raise RuntimeError("Gemini SDK not installed")
    if not api_key:
        raise RuntimeError("Gemini API key is empty")
    if not gemini_bucket.consume():
        raise RuntimeError("Gemini rate limit exceeded")

    with _gemini_configure_lock:
        if hasattr(GENAI_MODULE, "configure"):
            GENAI_MODULE.configure(api_key=api_key)
        model_obj = GENAI_MODULE.GenerativeModel(model or GEMINI_MODEL)

    resp = model_obj.generate_content(prompt)
    return getattr(resp, "text", str(resp))


def _call_gemini_stream(prompt: str, api_key: str, model: Optional[str] = None):
    """Streaming variant — yields text chunks."""
    if not GENAI_MODULE:
        raise RuntimeError("Gemini SDK not installed")
    if not api_key:
        raise RuntimeError("Gemini API key is empty")
    if not gemini_bucket.consume():
        raise RuntimeError("Gemini rate limit exceeded")

    with _gemini_configure_lock:
        if hasattr(GENAI_MODULE, "configure"):
            GENAI_MODULE.configure(api_key=api_key)
        model_obj = GENAI_MODULE.GenerativeModel(model or GEMINI_MODEL)

    response = model_obj.generate_content(prompt, stream=True)
    for chunk in response:
        text = getattr(chunk, "text", "")
        if text:
            yield text

def _invoke_gemini(prompt: str, model_override: Optional[str] = None) -> str:
    """Try all Gemini keys in rotation."""
    if not GEMINI_API_KEYS:
        raise RuntimeError("No Gemini API keys configured")

    last_error = None
    for idx, api_key in enumerate(GEMINI_API_KEYS, 1):
        try:
            result = _call_gemini(prompt, api_key, model_override)
            logger.info("Gemini key #%d succeeded", idx)
            return result
        except Exception as e:
            last_error = e
            logger.warning("Gemini key #%d failed: %s", idx, e)

    raise RuntimeError(f"All {len(GEMINI_API_KEYS)} Gemini keys failed: {last_error}")

# ==============================
# Groq invocation (key rotation)
# ==============================
def _call_groq(prompt: str, api_key: str, model: Optional[str] = None) -> str:
    if not GROQ_MODULE:
        raise RuntimeError("Groq SDK not installed")
    if not api_key:
        raise RuntimeError("Groq API key is empty")
    if not groq_bucket.consume():
        raise RuntimeError("Groq rate limit exceeded")

    client = GROQ_MODULE.Groq(api_key=api_key)
    response = client.chat.completions.create(
        model=model or GROQ_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
        max_tokens=2048,
    )
    return response.choices[0].message.content

def _invoke_groq(prompt: str, model_override: Optional[str] = None) -> str:
    """Try all Groq keys in rotation."""
    if not GROQ_API_KEYS:
        raise RuntimeError("No Groq API keys configured")

    last_error = None
    for idx, api_key in enumerate(GROQ_API_KEYS, 1):
        try:
            result = _call_groq(prompt, api_key, model_override)
            logger.info("Groq key #%d succeeded", idx)
            return result
        except Exception as e:
            last_error = e
            logger.warning("Groq key #%d failed: %s", idx, e)

    raise RuntimeError(f"All {len(GROQ_API_KEYS)} Groq keys failed: {last_error}")

# ==============================
# Pollinations invocation (HTTP)
# ==============================
def _call_pollinations(prompt: str, model: str, temperature: float = 0.7) -> str:
    """Call Pollinations text API (OpenAI-compatible /openai endpoint)."""
    if not pollinations_bucket.consume():
        raise RuntimeError("Pollinations rate limit exceeded")

    url = f"{POLLINATIONS_BASE_URL}/openai"
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if POLLINATIONS_API_KEY:
        headers["Authorization"] = f"Bearer {POLLINATIONS_API_KEY}"

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": prompt},
        ],
        "temperature": temperature,
    }

    logger.info("[Pollinations] endpoint=%s  model=%s  prompt_length=%d", url, model, len(prompt))
    resp = _requests_lib.post(url, json=payload, headers=headers, timeout=POLLINATIONS_TIMEOUT)
    resp.raise_for_status()

    # OpenAI-compatible JSON response
    try:
        data = resp.json()
        if isinstance(data, dict) and "choices" in data:
            result = data["choices"][0]["message"]["content"]
            logger.info("[Pollinations] response length=%d", len(result))
            return result
    except (ValueError, KeyError, IndexError):
        pass

    # Fallback: plain text body
    result = resp.text.strip()
    logger.info("[Pollinations] response length=%d (text fallback)", len(result))
    return result


def _call_pollinations_stream(prompt: str, model: str, temperature: float = 0.7):
    """
    Buffered-streaming variant for Pollinations.
    Fetches full response from /openai endpoint, then yields
    small chunks to simulate token-by-token streaming.
    """
    if not pollinations_bucket.consume():
        raise RuntimeError("Pollinations rate limit exceeded")

    url = f"{POLLINATIONS_BASE_URL}/openai"
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if POLLINATIONS_API_KEY:
        headers["Authorization"] = f"Bearer {POLLINATIONS_API_KEY}"

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": prompt},
        ],
        "temperature": temperature,
    }

    logger.info("[Pollinations] stream  endpoint=%s  model=%s  prompt_length=%d", url, model, len(prompt))
    resp = _requests_lib.post(url, json=payload, headers=headers, timeout=POLLINATIONS_TIMEOUT)
    resp.raise_for_status()

    # Extract text from OpenAI-compatible JSON, fall back to raw body
    full_text = ""
    try:
        data = resp.json()
        if isinstance(data, dict) and "choices" in data:
            full_text = data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError):
        pass
    if not full_text:
        full_text = resp.text.strip()

    logger.info("[Pollinations] stream response length=%d", len(full_text))

    # Yield in small chunks to simulate token-by-token streaming
    CHUNK_SIZE = 24
    for i in range(0, len(full_text), CHUNK_SIZE):
        yield full_text[i : i + CHUNK_SIZE]


# ==============================
# Unified Router
# ==============================
def call_llm_router(
    prompt: str,
    task: str = "general",
    use_simulation: bool = False,
    prefer: Optional[str] = None,
    model_override: Optional[str] = None,
    user_id: Optional[str] = None,
) -> str:
    """
    Route an LLM call to the correct provider based on task.

    Args:
        prompt: The full prompt text.
        task: Task identifier (determines provider routing).
        use_simulation: If True, return simulated response (dev mode).
        prefer: Force a specific provider ("gemini" or "groq").
        model_override: Override the default model for the provider.
        user_id: Optional user ID for cache isolation.

    Returns:
        LLM response text.
    """
    if use_simulation:
        return simulated_response(prompt, task)

    # Determine provider
    default_provider = prefer or get_provider_for_task(task)
    provider, resolved_override = resolve_model_override(model_override, default_provider)
    model = resolved_override or (GROQ_MODEL if provider == "groq" else GEMINI_MODEL)

    logger.info("[LLM Request] model=%s  provider=%s  task=%s  override=%s", model, provider, task, model_override)

    # Check cache
    key = _cache_key(prompt, task, model, provider, user_id or "")
    cached = _cache_get(key)
    if cached is not None:
        logger.info("Cache hit for task=%s provider=%s", task, provider)
        return cached

    # Enforce JSON if needed
    effective_prompt = prompt
    if task in STRICT_JSON_TASKS:
        effective_prompt = (
            "SYSTEM: Respond ONLY with valid JSON. "
            "No markdown. No explanations.\n\n" + prompt
        )

    # Invoke the correct provider
    try:
        if provider == "pollinations":
            result = _call_pollinations(effective_prompt, resolved_override or model)
        elif provider == "groq":
            result = _invoke_groq(effective_prompt, resolved_override)
        else:
            result = _invoke_gemini(effective_prompt, resolved_override)

        _cache_set(key, result)
        logger.info("Provider=%s succeeded for task=%s", provider, task)
        return result

    except Exception as e:
        logger.error("Provider=%s failed for task=%s: %s", provider, task, e)

        # Safety fallback: if any non-Gemini provider fails, degrade to
        # Gemini (gemini-fast) so the user always gets an answer.
        if provider != "gemini":
            try:
                logger.info("[Fallback] %s failed — switching to Gemini (%s)", provider, GEMINI_FAST_MODEL)
                fallback_result = _invoke_gemini(effective_prompt, GEMINI_FAST_MODEL)
                _cache_set(key, fallback_result)
                logger.info("Fallback Gemini path succeeded for task=%s", task)
                return fallback_result
            except Exception as fallback_error:
                logger.error("Fallback Gemini path failed for task=%s: %s", task, fallback_error)

        return json.dumps({"error": "provider_failed", "provider": provider, "detail": str(e)})

# ==============================
# Backward-compatible API
# ==============================
def call_llm(
    prompt: str,
    category: str = "general",
    use_simulation: bool = False,
    model_override: Optional[str] = None,
) -> str:
    return call_llm_router(
        prompt=prompt,
        task=category,
        use_simulation=use_simulation,
        model_override=model_override,
    )


# ==============================
# Streaming Router (multi-provider)
# ==============================
def stream_llm_router(
    prompt: str,
    task: str = "chat",
    model_override: Optional[str] = None,
):
    """
    Streaming variant — yields text chunks.
    Routes to Pollinations or Gemini based on model_override.
    Falls back to Gemini (gemini-fast) if Pollinations fails.
    """
    provider, resolved_override = resolve_model_override(model_override, "gemini")
    model = resolved_override or GEMINI_MODEL

    logger.info("[LLM Request] stream  model=%s  provider=%s  override=%s", model, provider, model_override)

    # --- Pollinations streaming path ---
    if provider == "pollinations":
        try:
            yield from _call_pollinations_stream(prompt, resolved_override or model)
            logger.info("[Provider] Pollinations stream succeeded for model=%s", model)
            return
        except Exception as e:
            logger.warning(
                "[Fallback] Pollinations stream failed: %s — switching to Gemini (%s)",
                e, GEMINI_FAST_MODEL,
            )
            # Fall through to Gemini below
            model = GEMINI_FAST_MODEL

    # --- Gemini streaming path ---
    if not GEMINI_API_KEYS:
        raise RuntimeError("No Gemini API keys configured")

    last_error = None
    for idx, api_key in enumerate(GEMINI_API_KEYS, 1):
        try:
            yield from _call_gemini_stream(prompt, api_key, model)
            logger.info("Gemini stream key #%d succeeded", idx)
            return
        except Exception as e:
            last_error = e
            logger.warning("Gemini stream key #%d failed: %s", idx, e)

    raise RuntimeError(f"All Gemini keys failed for streaming: {last_error}")
