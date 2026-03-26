"""
SentIQGPT v1 — LLM Gateway (FastAPI Service)

Persistent HTTP service wrapping the dual-model llm_adapter.
Eliminates process startup overhead.

Endpoints:
  POST /llm/invoke  — Invoke LLM with task + prompt (auto-routes to Gemini or Groq)
  GET  /llm/health  — Health check
"""

import os
import sys
import json
import logging
from datetime import date

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Any, Optional
import uvicorn
import requests

# --- Environment ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(BASE_DIR)

from dotenv import load_dotenv
load_dotenv(os.path.join(PARENT_DIR, ".env"))

# Import the unified router from the parent-level llm_adapter
sys.path.insert(0, PARENT_DIR)
from llm_adapter import (
    call_llm_router,
    stream_llm_router,
    get_provider_for_task,
    GEMINI_API_KEYS,
    GROQ_API_KEYS,
    GEMINI_MODEL,
    GROQ_MODEL,
    STRICT_JSON_TASKS,
)

# --- Logger ---
logger = logging.getLogger("sentiqgpt.llm_service")
if not logger.handlers:
    h = logging.StreamHandler()
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(h)
logger.setLevel(logging.INFO)

LLM_SERVICE_PORT = int(os.getenv("LLM_SERVICE_PORT", "3002"))
REQUESTS_PER_DAY = 50
SUPABASE_REST_TIMEOUT_SECONDS = 15
CONTROL_DB_NUMBER = 1
VALID_DB_NUMBERS = {1, 2, 3, 4}
GUEST_USER_ID = "guest"
GUEST_MODEL_OVERRIDE = "gemini-fast"

# ============================
# FastAPI Application
# ============================

app = FastAPI(title="SentIQGPT LLM Service", version="1.0.0")


class LLMInvokeRequest(BaseModel):
    prompt: str
    task: str = "general"
    use_simulation: bool = False
    prefer: Optional[str] = None
    model_override: Optional[str] = None
    user_id: Optional[str] = None
    max_output_tokens: Optional[int] = None


class LLMInvokeResponse(BaseModel):
    result: Any
    provider: str
    cached: bool = False


class EmbedRequest(BaseModel):
    text: str


def read_required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise Exception(f"Missing required environment variable: {name}")
    return value


def get_db_config(db_number: int) -> tuple[str, str]:
    if db_number not in VALID_DB_NUMBERS:
        raise Exception(f"Invalid assigned_db value: {db_number}")

    base_url = read_required_env(f"SUPABASE_URL_{db_number}").rstrip("/")
    service_role_key = read_required_env(f"SUPABASE_SERVICE_ROLE_KEY_{db_number}")
    return base_url, service_role_key


def build_rest_headers(service_role_key: str, *, prefer: Optional[str] = None) -> dict[str, str]:
    headers = {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def supabase_rest_request(
    method: str,
    db_number: int,
    table: str,
    *,
    params: Optional[dict[str, str]] = None,
    json_body: Optional[dict[str, Any]] = None,
    prefer: Optional[str] = None,
) -> Any:
    base_url, service_role_key = get_db_config(db_number)
    response = requests.request(
        method=method,
        url=f"{base_url}/rest/v1/{table}",
        headers=build_rest_headers(service_role_key, prefer=prefer),
        params=params,
        json=json_body,
        timeout=SUPABASE_REST_TIMEOUT_SECONDS,
    )

    if not response.ok:
        raise Exception(
            f"Supabase request failed for {table} ({response.status_code}): {response.text[:300]}"
        )

    if not response.text.strip():
        return None

    return response.json()


def supabase_rpc_request(
    db_number: int,
    function_name: str,
    *,
    json_body: Optional[dict[str, Any]] = None,
) -> Any:
    base_url, service_role_key = get_db_config(db_number)
    response = requests.request(
        method="POST",
        url=f"{base_url}/rest/v1/rpc/{function_name}",
        headers=build_rest_headers(service_role_key),
        json=json_body,
        timeout=SUPABASE_REST_TIMEOUT_SECONDS,
    )

    if not response.ok:
        raise Exception(
            f"Supabase RPC failed for {function_name} ({response.status_code}): {response.text[:300]}"
        )

    if not response.text.strip():
        return None

    return response.json()


def require_user_id(user_id: Optional[str]) -> str:
    normalized_user_id = (user_id or "").strip()
    if not normalized_user_id:
        raise Exception("User ID required for LLM usage")
    return normalized_user_id


def is_guest_user(user_id: Optional[str]) -> bool:
    return (user_id or "").strip() == GUEST_USER_ID


def resolve_user_db(user_id: str) -> int:
    data = supabase_rest_request(
        "GET",
        CONTROL_DB_NUMBER,
        "user_db_map",
        params={
            "user_id": f"eq.{user_id}",
            "select": "assigned_db",
        },
    )

    if not isinstance(data, list) or not data:
        raise Exception(f"No database assignment found for user {user_id}")

    assigned_db = data[0].get("assigned_db")
    if not isinstance(assigned_db, int) or assigned_db not in VALID_DB_NUMBERS:
        raise Exception(f"Invalid assigned_db value for user {user_id}: {assigned_db}")

    return assigned_db


def get_today_iso_date() -> str:
    return date.today().isoformat()


def fetch_usage_row(user_id: str, db_number: int) -> Optional[dict[str, Any]]:
    data = supabase_rest_request(
        "GET",
        db_number,
        "usage_logs",
        params={
            "user_id": f"eq.{user_id}",
            "date": f"eq.{get_today_iso_date()}",
            "select": "id,requests_count",
        },
    )

    if not isinstance(data, list) or not data:
        return None

    return data[0]


def insert_usage_row(user_id: str, db_number: int) -> None:
    supabase_rest_request(
        "POST",
        db_number,
        "usage_logs",
        params={"on_conflict": "user_id,date"},
        json_body={
            "user_id": user_id,
            "date": get_today_iso_date(),
            "requests_count": 0,
            "tokens_used": 0,
            "images_generated": 0,
        },
        prefer="resolution=ignore-duplicates,return=minimal",
    )


def ensure_usage_row(user_id: str, db_number: int) -> dict[str, Any]:
    usage_row = fetch_usage_row(user_id, db_number)
    if usage_row is not None:
        return usage_row

    insert_usage_row(user_id, db_number)
    usage_row = fetch_usage_row(user_id, db_number)
    if usage_row is None:
        raise Exception(f"Failed to ensure usage row for user {user_id}")

    return usage_row


def increment_requests_count(user_id: str, db_number: int, current_count: int) -> None:
    supabase_rest_request(
        "PATCH",
        db_number,
        "usage_logs",
        params={
            "user_id": f"eq.{user_id}",
            "date": f"eq.{get_today_iso_date()}",
        },
        json_body={"requests_count": current_count + 1},
        prefer="return=minimal",
    )


def get_enforced_usage(user_id: str) -> tuple[int, dict[str, Any]]:
    assigned_db = resolve_user_db(user_id)
    usage_row = ensure_usage_row(user_id, assigned_db)
    requests_count = int(usage_row.get("requests_count") or 0)

    if requests_count >= REQUESTS_PER_DAY:
        raise Exception("Daily request limit reached")

    return assigned_db, usage_row


def reserve_llm_request_slot(user_id: str) -> int:
    assigned_db = resolve_user_db(user_id)
    reserved = supabase_rpc_request(
        assigned_db,
        "reserve_daily_llm_request",
        json_body={
            "p_user_id": user_id,
            "p_daily_limit": REQUESTS_PER_DAY,
        },
    )
    if reserved is not True:
        raise Exception("Daily request limit reached")
    return assigned_db


@app.get("/llm/health")
async def health_check():
    return {
        "status": "ok",
        "system": "SentIQGPT",
        "gemini_keys_configured": len(GEMINI_API_KEYS),
        "groq_keys_configured": len(GROQ_API_KEYS),
        "gemini_model": GEMINI_MODEL,
        "embedding_model": EMBEDDING_MODEL,
        "groq_model": GROQ_MODEL,
        "strict_json_tasks": len(STRICT_JSON_TASKS),
    }


@app.post("/llm/invoke", response_model=LLMInvokeResponse)
async def invoke_llm(request: LLMInvokeRequest):
    try:
        if is_guest_user(request.user_id):
            user_id = GUEST_USER_ID
            effective_model_override = GUEST_MODEL_OVERRIDE
        else:
            user_id = require_user_id(request.user_id)
            reserve_llm_request_slot(user_id)
            effective_model_override = request.model_override
        result = call_llm_router(
            prompt=request.prompt,
            task=request.task,
            use_simulation=request.use_simulation,
            prefer=request.prefer,
            model_override=effective_model_override,
            user_id=user_id,
            max_output_tokens=request.max_output_tokens,
        )
        # Resolve the actual provider (not just the prefer hint)
        from llm_adapter import resolve_model_override, get_provider_for_task
        default_prov = request.prefer or get_provider_for_task(request.task)
        resolved_prov, _ = resolve_model_override(effective_model_override, default_prov)
        return LLMInvokeResponse(result=result, provider=resolved_prov)
    except Exception as e:
        logger.error("LLM invocation failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/llm/stream")
async def stream_llm(request: LLMInvokeRequest):
    """SSE streaming endpoint for provider responses as text/event-stream."""
    def event_generator():
        try:
            if is_guest_user(request.user_id):
                user_id = GUEST_USER_ID
                effective_model_override = GUEST_MODEL_OVERRIDE
            else:
                user_id = require_user_id(request.user_id)
                reserve_llm_request_slot(user_id)
                effective_model_override = request.model_override
            for chunk in stream_llm_router(
                prompt=request.prompt,
                task=request.task,
                model_override=effective_model_override,
                user_id=user_id,
            ):
                # SSE format: data: <text>\n\n
                yield f"data: {json.dumps({'text': chunk})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.error("Streaming failed: %s", e)
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ============================
# Vision (multimodal) endpoint
# ============================

class VisionRequest(BaseModel):
    prompt: str
    image_base64: str
    mime_type: str = "image/jpeg"
    model_override: Optional[str] = None
    user_id: Optional[str] = None

@app.post("/llm/vision")
async def vision_llm(request: VisionRequest):
    """Analyze an image using Gemini Vision (multimodal)."""
    user_id = require_user_id(request.user_id)
    if is_guest_user(user_id):
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not request.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt must be non-empty")
    if not request.image_base64:
        raise HTTPException(status_code=400, detail="image_base64 must be non-empty")
    # Limit base64 payload: ~20MB decoded
    if len(request.image_base64) > 28_000_000:
        raise HTTPException(status_code=400, detail="Image too large (max ~20MB)")
    try:
        reserve_llm_request_slot(user_id)
        from llm_adapter import _invoke_gemini_vision
        result = _invoke_gemini_vision(
            prompt=request.prompt,
            image_base64=request.image_base64,
            mime_type=request.mime_type,
            model_override=request.model_override,
        )
        return {"result": result, "provider": "gemini-vision"}
    except Exception as e:
        logger.error("Vision invocation failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


# ============================
# Embedding endpoint
# ============================

EMBEDDING_MODEL = os.getenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001")

import threading
_embed_lock = threading.Lock()

def _generate_embedding(text: str, api_key: str) -> list:
    """Generate a vector embedding using the Gemini embedding API."""
    import google.generativeai as genai
    with _embed_lock:
        genai.configure(api_key=api_key)
    result = genai.embed_content(
        model=f"models/{EMBEDDING_MODEL}",
        content=text,
        task_type="retrieval_document",
    )
    return result["embedding"]


def _embedding_model_missing(error: Exception) -> bool:
    message = str(error).lower()
    return "404" in message or "not found" in message


@app.post("/llm/embed")
async def embed_text(request: EmbedRequest):
    """Generate a vector embedding for the given text using Gemini."""
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="text must be non-empty")
    if not GEMINI_API_KEYS:
        logger.warning("No Gemini API keys configured for embeddings - skipping")
        return {"embedding": [], "skipped": True, "reason": "no_keys"}

    last_error = None
    logger.info("[Embedding] model=%s", EMBEDDING_MODEL)
    for idx, api_key in enumerate(GEMINI_API_KEYS, 1):
        try:
            embedding = _generate_embedding(request.text, api_key)
            logger.info("Embedding generated via Gemini key #%d (%d dims)", idx, len(embedding))
            return {"embedding": embedding}
        except Exception as e:
            last_error = e
            logger.warning("Embedding key #%d failed: %s", idx, e)
            if _embedding_model_missing(e):
                logger.warning(
                    "Embedding model %s is unavailable - disabling embeddings for this request",
                    EMBEDDING_MODEL,
                )
                break

    # Non-fatal: return empty so the pipeline can continue without embeddings
    logger.warning("All Gemini keys failed for embedding — skipping (non-fatal): %s", last_error)
    return {"embedding": [], "skipped": True, "reason": "unavailable"}


# ============================
# Chart rendering endpoint
# ============================

class ChartRenderRequest(BaseModel):
    code: str


# Patterns forbidden in chart code (case-insensitive, compiled once for efficiency).
# These guard against shell injection, file system access, and network calls in
# user-visible code that the Python interpreter would execute.
import re as _re
_FORBIDDEN_CODE_PATTERNS = [
    _re.compile(r"\bimport\s+os\b", _re.IGNORECASE),
    _re.compile(r"\bimport\s+subprocess\b", _re.IGNORECASE),
    _re.compile(r"\bimport\s+sys\b", _re.IGNORECASE),
    _re.compile(r"\b__import__\s*\(", _re.IGNORECASE),
    _re.compile(r"\bexec\s*\(", _re.IGNORECASE),
    _re.compile(r"\beval\s*\(", _re.IGNORECASE),
    _re.compile(r"\bopen\s*\(", _re.IGNORECASE),
    _re.compile(r"\bsocket\b", _re.IGNORECASE),
    _re.compile(r"\burllib\b", _re.IGNORECASE),
    _re.compile(r"\brequests\b", _re.IGNORECASE),
]


@app.post("/chart/render")
async def render_chart(request: ChartRenderRequest):
    """Execute matplotlib chart code and return a base64 PNG preview.

    The code must be self-contained matplotlib Python (generated by the
    chartRenderer).  The script is expected to print a data URI of the form
    ``data:image/png;base64,<base64>`` to stdout.

    Returns {"preview": "data:image/png;base64,..."} on success.
    Returns {"preview": null, "error": "..."} on failure (non-fatal).
    """
    import subprocess

    if not request.code or not request.code.strip():
        raise HTTPException(status_code=400, detail="code must be non-empty")

    # Safeguard: only allow code that is generated by our own system.
    # We validate that it imports matplotlib and numpy (our generated code
    # always does this) and does not contain shell/OS calls.
    for pat in _FORBIDDEN_CODE_PATTERNS:
        if pat.search(request.code):
            raise HTTPException(
                status_code=400,
                detail=f"Forbidden pattern in chart code: {pat.pattern!r}",
            )

    try:
        proc = subprocess.run(
            [sys.executable, "-c", request.code],
            capture_output=True,
            text=True,
            timeout=30,
        )
        stdout = proc.stdout.strip()
        if proc.returncode != 0:
            logger.warning("Chart render failed (rc=%d): %s", proc.returncode, proc.stderr[:200])
            return {"preview": None, "error": proc.stderr[:200]}

        # Find the data URI in stdout
        for line in stdout.splitlines():
            if line.startswith("data:image/png;base64,"):
                logger.info("Chart rendered successfully (%d chars)", len(line))
                return {"preview": line}

        logger.warning("Chart code ran but produced no data URI")
        return {"preview": None, "error": "no data URI in stdout"}
    except subprocess.TimeoutExpired:
        logger.warning("Chart render timed out")
        return {"preview": None, "error": "render timed out"}
    except Exception as e:
        logger.error("Chart render error: %s", e)
        return {"preview": None, "error": str(e)}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=LLM_SERVICE_PORT, log_level="info")
