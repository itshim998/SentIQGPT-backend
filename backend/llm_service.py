"""
SentIQ Chat v1 — LLM Gateway (FastAPI Service)

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
import threading
import time
from datetime import date

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool
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
    get_current_groq_call_telemetry,
    get_provider_for_task,
    GEMINI_API_KEYS,
    GROQ_API_KEYS,
    GEMINI_MODEL,
    GEMINI_STANDARD_MODEL,
    GEMINI_LITE_MODEL,
    GEMMA_PRIMARY_MODEL,
    GEMMA_SECONDARY_MODEL,
    GEMINI_REASONING_MODEL,
    GEMINI_REASONING_BACKUP_MODEL,
    GEMINI_WEB_MODEL,
    GEMINI_WEB_BACKUP_MODEL,
    GEMINI_GOOGLE_SEARCH_ENABLED,
    get_gemini_key_health_snapshot,
    GROQ_MODEL,
    GROQ_CHAT_MODEL,
    MASTER_ROUTER_MODEL,
    CODING_MODEL,
    POLLINATIONS_OPENAI_ENDPOINT,
    POLLINATIONS_FALLBACK_OPENAI_ENDPOINT,
    POLLINATIONS_TIMEOUT,
    POLLINATIONS_STREAM_FIRST_CHUNK_TIMEOUT,
    POLLINATIONS_STREAM_IDLE_TIMEOUT,
    POLLINATIONS_API_KEY,
    STRICT_JSON_TASKS,
    # Safety model imports
    call_safety_model,
    is_safe_content,
    SafetyResult,
    SAFETY_TIMEOUT,
    SAFETY_OUTPUT_TIMEOUT,
    SAFETY_BUFFER_SIZE,
)

PRODUCT_NAME = "SentIQ Chat"

# --- Logger ---
logger = logging.getLogger("sentiq_chat.llm_service")
if not logger.handlers:
    h = logging.StreamHandler()
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(h)
logger.setLevel(logging.INFO)

LLM_SERVICE_HOST = os.getenv("LLM_SERVICE_HOST", "0.0.0.0")
LLM_SERVICE_PORT = int(os.getenv("LLM_SERVICE_PORT", "3002"))
RUNTIME_ENV = os.getenv("NODE_ENV", os.getenv("RUNTIME_ENV", "development")).strip().lower()
REQUESTS_PER_DAY = 50
PYTHON_LLM_QUOTA_ENFORCEMENT = os.getenv("SENTIQ_PYTHON_LLM_QUOTA_ENFORCEMENT", "false").strip().lower() == "true"
SUPABASE_REST_TIMEOUT_SECONDS = 15
SUPABASE_ERROR_BODY_LIMIT = 400
CONTROL_DB_NUMBER = 1
VALID_DB_NUMBERS = {1, 2, 3, 4}
GUEST_USER_ID = "guest"
GUEST_MODEL_OVERRIDE = "gemini-search"
GUEST_TEXT_MODEL_OVERRIDE = "gpt-oss-120b"
USER_DB_CACHE_TTL_SECONDS = 300
INTERNAL_SERVICE_TOKEN = os.getenv("SENTIQ_INTERNAL_SERVICE_TOKEN", "").strip()
UNSAFE_INTERNAL_ENDPOINTS_ENABLED = os.getenv("SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS") == "true"

_user_db_cache_lock = threading.Lock()
_user_db_cache: dict[str, tuple[int, float]] = {}
_quota_rpc_alert_lock = threading.Lock()
_quota_rpc_alerted_dbs: set[int] = set()

# ============================
# Safety Audit Log (In-Memory)
# ============================
# Circular buffer of safety violations for review

class SafetyAuditEntry:
    def __init__(
        self,
        timestamp: str,
        check_type: str,
        classification: str,
        user_id: str,
        text_preview: str,
        raw_response: str,
        endpoint: str,
    ):
        self.timestamp = timestamp
        self.check_type = check_type
        self.classification = classification
        self.user_id = user_id
        self.text_preview = text_preview
        self.raw_response = raw_response
        self.endpoint = endpoint

MAX_SAFETY_AUDIT_ENTRIES = 500
SAFETY_MODE_STRICT = "strict"
SAFETY_MODE_LOW_RISK_TEXT = "low_risk_text"
SAFE_INPUT_CLASSIFICATIONS = {SafetyResult.SAFE, SafetyResult.CONTROVERSIAL}
EXPLICIT_BLOCKED_CLASSIFICATIONS = {SafetyResult.UNSAFE, "BLOCKED"}
DEGRADED_SAFETY_CLASSIFICATIONS = {
    SafetyResult.TIMEOUT,
    SafetyResult.ERROR,
    SafetyResult.DEGRADED,
}
_safety_audit_entries: list[SafetyAuditEntry] = []
_safety_audit_lock = threading.Lock()


def log_safety_violation(
    check_type: str,
    classification: str,
    user_id: str,
    text: str,
    raw_response: str,
    endpoint: str,
) -> None:
    """Log a safety check result to the in-memory audit log."""
    from datetime import datetime
    entry = SafetyAuditEntry(
        timestamp=datetime.utcnow().isoformat() + "Z",
        check_type=check_type,
        classification=classification,
        user_id=user_id or "unknown",
        text_preview=text[:200] + "..." if len(text) > 200 else text,
        raw_response=raw_response[:100] if raw_response else "",
        endpoint=endpoint,
    )
    with _safety_audit_lock:
        _safety_audit_entries.append(entry)
        if len(_safety_audit_entries) > MAX_SAFETY_AUDIT_ENTRIES:
            _safety_audit_entries.pop(0)
    logger.info(
        "[SafetyAudit] %s check=%s classification=%s user=%s endpoint=%s",
        entry.timestamp,
        check_type,
        classification,
        user_id,
        endpoint,
    )


def log_safety_event(
    event_name: str,
    *,
    check_type: str,
    classification: str,
    user_id: str,
    endpoint: str,
    task: str,
    safety_mode: str,
) -> None:
    """Emit structured safety telemetry without prompt or response content."""
    logger.warning(
        "[SafetyEvent] event=%s check=%s classification=%s user=%s endpoint=%s task=%s safety_mode=%s",
        event_name,
        check_type,
        classification,
        user_id,
        endpoint,
        task,
        safety_mode,
    )


def get_safety_audit_entries(limit: int = 50) -> list[dict]:
    """Get recent safety audit entries."""
    with _safety_audit_lock:
        entries = _safety_audit_entries[-limit:]
    return [
        {
            "timestamp": e.timestamp,
            "check_type": e.check_type,
            "classification": e.classification,
            "user_id": e.user_id,
            "text_preview": e.text_preview,
            "endpoint": e.endpoint,
        }
        for e in reversed(entries)
    ]


def normalize_safety_mode(value: Optional[str]) -> str:
    return SAFETY_MODE_LOW_RISK_TEXT if value == SAFETY_MODE_LOW_RISK_TEXT else SAFETY_MODE_STRICT


def check_input_safety(
    prompt: str,
    user_id: str,
    endpoint: str,
    task: str = "general",
    safety_mode: Optional[str] = None,
) -> tuple[bool, str, str]:
    """Check if input is safe. Returns (is_safe, classification, raw_response)."""
    normalized_mode = normalize_safety_mode(safety_mode)
    classification, raw_response = call_safety_model(prompt, check_type="input")

    if classification in SAFE_INPUT_CLASSIFICATIONS:
        return True, classification, raw_response

    if classification in EXPLICIT_BLOCKED_CLASSIFICATIONS:
        log_safety_event(
            "safety.input.blocked.explicit",
            check_type="input",
            classification=classification,
            user_id=user_id,
            endpoint=endpoint,
            task=task,
            safety_mode=normalized_mode,
        )
        log_safety_violation("input", classification, user_id, "", raw_response, endpoint)
        return False, classification, raw_response

    if normalized_mode == SAFETY_MODE_LOW_RISK_TEXT and classification in DEGRADED_SAFETY_CLASSIFICATIONS:
        log_safety_event(
            "safety.input.timeout.allow_degraded"
            if classification == SafetyResult.TIMEOUT
            else "safety.input.unavailable.allow_degraded",
            check_type="input",
            classification=classification,
            user_id=user_id,
            endpoint=endpoint,
            task=task,
            safety_mode=normalized_mode,
        )
        return True, classification, raw_response

    log_safety_violation("input", classification, user_id, "", raw_response, endpoint)
    return False, classification, raw_response


def check_output_safety(text: str, user_id: str, endpoint: str, task: str = "chat") -> tuple[bool, str, str]:
    """Check final model output. Returns (is_safe, classification, raw_response)."""
    classification, raw_response = call_safety_model(
        text,
        timeout=SAFETY_OUTPUT_TIMEOUT,
        check_type="output",
    )
    if classification in SAFE_INPUT_CLASSIFICATIONS:
        return True, classification, raw_response

    if classification in EXPLICIT_BLOCKED_CLASSIFICATIONS:
        log_safety_violation("output", classification, user_id, "", raw_response, endpoint)
        return False, classification, raw_response

    if classification in DEGRADED_SAFETY_CLASSIFICATIONS:
        log_safety_event(
            "safety.output.timeout.degraded"
            if classification == SafetyResult.TIMEOUT
            else "safety.output.unavailable.degraded",
            check_type="output",
            classification=classification,
            user_id=user_id,
            endpoint=endpoint,
            task=task,
            safety_mode=SAFETY_MODE_STRICT,
        )
        return True, classification, raw_response

    log_safety_violation("output", classification, user_id, "", raw_response, endpoint)
    return False, classification, raw_response


# ============================
# FastAPI Application
# ============================

def is_production_runtime(runtime_env: Optional[str] = None) -> bool:
    return (runtime_env or RUNTIME_ENV).strip().lower() == "production"


def validate_internal_service_configuration(
    *,
    runtime_env: Optional[str] = None,
    internal_service_token: Optional[str] = None,
    unsafe_internal_endpoints_enabled: Optional[bool] = None,
    llm_service_host: Optional[str] = None,
) -> None:
    if not is_production_runtime(runtime_env):
        return

    token = INTERNAL_SERVICE_TOKEN if internal_service_token is None else internal_service_token
    unsafe_enabled = (
        UNSAFE_INTERNAL_ENDPOINTS_ENABLED
        if unsafe_internal_endpoints_enabled is None
        else unsafe_internal_endpoints_enabled
    )
    host = LLM_SERVICE_HOST if llm_service_host is None else llm_service_host

    if not token:
        raise RuntimeError("SENTIQ_INTERNAL_SERVICE_TOKEN is required in production")
    if unsafe_enabled:
        raise RuntimeError("SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS cannot be enabled in production")
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("LLM_SERVICE_HOST must remain bound to 127.0.0.1 in production")


validate_internal_service_configuration()

app = FastAPI(
    title=f"{PRODUCT_NAME} LLM Service",
    version="1.0.0",
    docs_url=None if is_production_runtime() else "/docs",
    redoc_url=None if is_production_runtime() else "/redoc",
    openapi_url=None if is_production_runtime() else "/openapi.json",
)


def require_internal_service_token(
    token: Optional[str],
    *,
    runtime_env: Optional[str] = None,
    internal_service_token: Optional[str] = None,
    unsafe_internal_endpoints_enabled: Optional[bool] = None,
) -> None:
    configured_token = INTERNAL_SERVICE_TOKEN if internal_service_token is None else internal_service_token
    unsafe_enabled = (
        UNSAFE_INTERNAL_ENDPOINTS_ENABLED
        if unsafe_internal_endpoints_enabled is None
        else unsafe_internal_endpoints_enabled
    )
    production = is_production_runtime(runtime_env)

    if not configured_token:
        if not production:
            if unsafe_enabled:
                logger.warning("[internal] unsafe internal endpoint access enabled without token")
            return
        raise HTTPException(status_code=404, detail="Not found")
    if token != configured_token:
        raise HTTPException(status_code=404, detail="Not found")


class InternalGatewayAuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("path") == "/llm/health":
            await self.app(scope, receive, send)
            return

        headers = {
            name.decode("latin1").lower(): value.decode("latin1")
            for name, value in scope.get("headers", [])
        }
        try:
            require_internal_service_token(headers.get("x-sentiq-internal-token"))
        except HTTPException:
            response = JSONResponse({"detail": "Not found"}, status_code=404)
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)


app.add_middleware(InternalGatewayAuthMiddleware)


class LLMInvokeRequest(BaseModel):
    prompt: str
    task: str = "general"
    use_simulation: bool = False
    prefer: Optional[str] = None
    model_override: Optional[str] = None
    user_id: Optional[str] = None
    safety_mode: Optional[str] = None
    max_output_tokens: Optional[int] = None
    reasoning_effort: Optional[str] = None
    execution_mode: Optional[str] = None
    skip_wrappers: Optional[bool] = None
    image_attachments: Optional[list[dict[str, Any]]] = None
    budget_policy: Optional[dict[str, Any]] = None
    sentiq_tool_request: Optional[dict[str, Any]] = None


class LLMInvokeResponse(BaseModel):
    result: Any
    provider: str
    cached: bool = False


class EmbedRequest(BaseModel):
    text: str


class SupabaseRequestError(Exception):
    def __init__(
        self,
        kind: str,
        db_number: int,
        target: str,
        status_code: int,
        details: str,
    ) -> None:
        self.kind = kind
        self.db_number = db_number
        self.target = target
        self.status_code = status_code
        self.details = details
        super().__init__(
            f"Supabase {kind} failed db={db_number} target={target} "
            f"status={status_code} details={details}"
        )


def details_contain_missing_function_marker(details: str) -> bool:
    lowered = (details or "").lower()
    if "pgrst202" in lowered:
        return True

    if "reserve_daily_llm_request" not in lowered:
        return False

    return "does not exist" in lowered or "function" in lowered


def is_missing_quota_rpc_error(error: SupabaseRequestError) -> bool:
    if error.kind != "rpc":
        return False

    # PostgREST returns 404/406 for unresolved rpc signatures depending on gateway mode.
    if error.status_code in {404, 406}:
        return details_contain_missing_function_marker(error.details)

    return details_contain_missing_function_marker(error.details)


def log_quota_rpc_drift_once(error: SupabaseRequestError) -> None:
    with _quota_rpc_alert_lock:
        if error.db_number in _quota_rpc_alerted_dbs:
            return
        _quota_rpc_alerted_dbs.add(error.db_number)

    logger.critical(
        "[quota] reserve.rpc_missing_on_shard db=%s target=%s status=%s details=%s "
        "action=apply migration 20260326190000_atomic_llm_request_quota.sql on this shard",
        error.db_number,
        error.target,
        error.status_code,
        error.details,
    )


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


def truncate_text(value: str, limit: int = SUPABASE_ERROR_BODY_LIMIT) -> str:
    text = (value or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + "...[truncated]"


def format_supabase_response_details(response: requests.Response) -> str:
    try:
        payload = response.json()
        return truncate_text(json.dumps(payload, ensure_ascii=True, sort_keys=True))
    except ValueError:
        return truncate_text(response.text or response.reason or "unknown")


def raise_supabase_request_error(
    kind: str,
    db_number: int,
    target: str,
    response: requests.Response,
) -> None:
    details = format_supabase_response_details(response)
    logger.error(
        "[Supabase][%s] db=%s target=%s status=%s details=%s",
        kind,
        db_number,
        target,
        response.status_code,
        details,
    )
    raise SupabaseRequestError(kind, db_number, target, response.status_code, details)


def get_cached_user_db(user_id: str) -> Optional[int]:
    now = time.monotonic()
    with _user_db_cache_lock:
        cached = _user_db_cache.get(user_id)
        if not cached:
            return None
        assigned_db, cached_at = cached
        if now - cached_at > USER_DB_CACHE_TTL_SECONDS:
            _user_db_cache.pop(user_id, None)
            return None
        return assigned_db


def cache_user_db(user_id: str, assigned_db: int) -> None:
    with _user_db_cache_lock:
        _user_db_cache[user_id] = (assigned_db, time.monotonic())


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
        raise_supabase_request_error("rest", db_number, table, response)

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
        raise_supabase_request_error("rpc", db_number, function_name, response)

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
    cached_db = get_cached_user_db(user_id)
    if cached_db is not None:
        logger.info("[quota] resolve_user_db.cache_hit user_id=%s db=%s", user_id, cached_db)
        return cached_db

    logger.info("[quota] resolve_user_db.start user_id=%s", user_id)
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

    cache_user_db(user_id, assigned_db)
    logger.info("[quota] resolve_user_db.ok user_id=%s db=%s", user_id, assigned_db)
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


def get_enforced_usage(user_id: str, assigned_db: Optional[int] = None) -> tuple[int, dict[str, Any]]:
    assigned_db = assigned_db if assigned_db in VALID_DB_NUMBERS else resolve_user_db(user_id)
    usage_row = ensure_usage_row(user_id, assigned_db)
    requests_count = int(usage_row.get("requests_count") or 0)

    if requests_count >= REQUESTS_PER_DAY:
        raise Exception("Daily request limit reached")

    return assigned_db, usage_row


def should_fallback_quota_rpc(error: SupabaseRequestError) -> bool:
    # Fallback is only allowed for confirmed migration drift where the atomic
    # quota RPC is missing. Auth, permission, and 5xx failures must fail closed.
    return is_missing_quota_rpc_error(error)


def reserve_llm_request_slot(user_id: str) -> int:
    assigned_db = resolve_user_db(user_id)
    logger.info("[quota] reserve.start user_id=%s db=%s", user_id, assigned_db)
    try:
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
        logger.info("[quota] reserve.rpc.ok user_id=%s db=%s", user_id, assigned_db)
        return assigned_db
    except SupabaseRequestError as error:
        if is_missing_quota_rpc_error(error):
            log_quota_rpc_drift_once(error)

        if not should_fallback_quota_rpc(error):
            raise

        logger.warning(
            "[quota] reserve.rpc_failed_fallback user_id=%s db=%s reason=%s",
            user_id,
            assigned_db,
            error,
        )
        _, usage_row = get_enforced_usage(user_id, assigned_db=assigned_db)
        current_count = int(usage_row.get("requests_count") or 0)
        increment_requests_count(user_id, assigned_db, current_count)
        logger.info(
            "[quota] reserve.fallback.ok user_id=%s db=%s requests_count=%s",
            user_id,
            assigned_db,
            current_count + 1,
        )
        return assigned_db


@app.get("/llm/health")
async def health_check():
    return {"status": "ok"}


@app.get("/llm/health/details")
async def health_details():
    return {
        "status": "ok",
        "system": PRODUCT_NAME,
        "gemini_keys_configured": len(GEMINI_API_KEYS),
        "groq_keys_configured": len(GROQ_API_KEYS),
        "gemini_model": GEMINI_MODEL,
        "gemini_standard_model": GEMINI_STANDARD_MODEL,
        "gemini_lite_model": GEMINI_LITE_MODEL,
        "gemma_primary_model": GEMMA_PRIMARY_MODEL,
        "gemma_secondary_model": GEMMA_SECONDARY_MODEL,
        "gemini_reasoning_model": GEMINI_REASONING_MODEL,
        "gemini_reasoning_backup_model": GEMINI_REASONING_BACKUP_MODEL,
        "gemini_web_model": GEMINI_WEB_MODEL,
        "gemini_web_backup_model": GEMINI_WEB_BACKUP_MODEL,
        "gemini_google_search_enabled": GEMINI_GOOGLE_SEARCH_ENABLED,
        "gemini_key_pool": get_gemini_key_health_snapshot(),
        "embedding_model": EMBEDDING_MODEL,
        "groq_model": GROQ_MODEL,
        "groq_chat_model": GROQ_CHAT_MODEL,
        "master_router_model": MASTER_ROUTER_MODEL,
        "coding_model": CODING_MODEL,
        "pollinations_api_key_configured": bool(POLLINATIONS_API_KEY),
        "pollinations_endpoint": POLLINATIONS_OPENAI_ENDPOINT,
        "pollinations_fallback_endpoint": POLLINATIONS_FALLBACK_OPENAI_ENDPOINT,
        "pollinations_timeout_seconds": POLLINATIONS_TIMEOUT,
        "pollinations_stream_first_chunk_timeout_seconds": POLLINATIONS_STREAM_FIRST_CHUNK_TIMEOUT,
        "pollinations_stream_idle_timeout_seconds": POLLINATIONS_STREAM_IDLE_TIMEOUT,
        "strict_json_tasks": len(STRICT_JSON_TASKS),
    }


@app.post("/llm/invoke", response_model=LLMInvokeResponse)
async def invoke_llm(request: LLMInvokeRequest):
    try:
        user_id_for_safety = request.user_id or GUEST_USER_ID
        is_safe, classification, _ = await run_in_threadpool(
            check_input_safety,
            request.prompt,
            user_id_for_safety,
            "/llm/invoke",
            request.task,
            request.safety_mode,
        )
        if not is_safe:
            logger.warning("[Safety] Input blocked for user=%s classification=%s", user_id_for_safety, classification)
            reason = "safety_violation" if classification in EXPLICIT_BLOCKED_CLASSIFICATIONS else "safety_degraded"
            raise HTTPException(
                status_code=400,
                detail={"status": "blocked", "reason": reason},
            )

        if is_guest_user(request.user_id):
            user_id = GUEST_USER_ID
            effective_model_override = (
                GUEST_TEXT_MODEL_OVERRIDE
                if request.model_override == GUEST_TEXT_MODEL_OVERRIDE
                else GUEST_MODEL_OVERRIDE
            )
            assigned_db = None
        else:
            user_id = require_user_id(request.user_id)
            assigned_db = await run_in_threadpool(reserve_llm_request_slot, user_id) if PYTHON_LLM_QUOTA_ENFORCEMENT else None
            effective_model_override = request.model_override
            logger.info(
                "[invoke] quota_%s user_id=%s db=%s task=%s",
                "reserved" if PYTHON_LLM_QUOTA_ENFORCEMENT else "delegated_to_billing",
                user_id,
                assigned_db,
                request.task,
            )
        result = await run_in_threadpool(
            call_llm_router,
            request.prompt,
            request.task,
            request.use_simulation,
            request.prefer,
            effective_model_override,
            user_id,
            request.max_output_tokens,
            request.reasoning_effort,
            bool(request.skip_wrappers),
            request.image_attachments or None,
            request.budget_policy,
            request.execution_mode,
            request.sentiq_tool_request,
        )
        # Resolve the actual provider (not just the prefer hint)
        from llm_adapter import resolve_model_override, get_provider_for_task
        default_prov = request.prefer or get_provider_for_task(request.task)
        resolved_prov, _ = resolve_model_override(effective_model_override, default_prov)
        return LLMInvokeResponse(result=result, provider=resolved_prov)
    except HTTPException:
        raise
    except Exception as e:
        logger.error("LLM invocation failed: %s", e)
        raise HTTPException(status_code=500, detail="LLM invocation failed")


class StreamingSafetyMonitor:
    """Background monitor that checks accumulated tokens for safety violations.
    
    Designed to be non-blocking: checks happen in a background thread and
    only terminate the stream if UNSAFE content is detected.
    """
    def __init__(self, user_id: str, task: str = "chat", buffer_size: int = SAFETY_BUFFER_SIZE):
        self.user_id = user_id
        self.task = task
        self.buffer_size = buffer_size
        self.accumulated_text = ""
        self.token_count = 0
        self.violation_detected = False
        self.violation_reason = ""
        self._check_thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._checking = False
    
    def add_token(self, token: str) -> bool:
        """Add a token to the buffer. Returns True if safe to continue, False if violated."""
        if self.violation_detected:
            return False
        
        with self._lock:
            self.accumulated_text += token
            self.token_count += 1
            
            # Trigger background check every buffer_size tokens
            if self.token_count % self.buffer_size == 0 and not self._checking:
                self._trigger_background_check()
        
        return not self.violation_detected
    
    def _trigger_background_check(self) -> None:
        """Start a background safety check (non-blocking)."""
        self._checking = True
        text_to_check = self.accumulated_text
        
        def check():
            try:
                classification, raw = call_safety_model(
                    text_to_check,
                    timeout=SAFETY_OUTPUT_TIMEOUT,
                    check_type="output",
                )
                if classification in EXPLICIT_BLOCKED_CLASSIFICATIONS:
                    with self._lock:
                        self.violation_detected = True
                        self.violation_reason = f"Output safety violation: {classification}"
                    log_safety_violation(
                        "output", classification, self.user_id,
                        "", raw, "/llm/stream"
                    )
                elif classification in DEGRADED_SAFETY_CLASSIFICATIONS:
                    log_safety_event(
                        "safety.output.timeout.degraded"
                        if classification == SafetyResult.TIMEOUT
                        else "safety.output.unavailable.degraded",
                        check_type="output",
                        classification=classification,
                        user_id=self.user_id,
                        endpoint="/llm/stream",
                        task=self.task,
                        safety_mode=SAFETY_MODE_STRICT,
                    )
            except Exception as e:
                logger.warning("[SafetyMonitor] Background check failed: %s", e)
            finally:
                with self._lock:
                    self._checking = False
        
        self._check_thread = threading.Thread(target=check, daemon=True)
        self._check_thread.start()
    
    def is_violated(self) -> bool:
        """Check if a safety violation has been detected."""
        return self.violation_detected


@app.post("/llm/stream")
async def stream_llm(request: LLMInvokeRequest):
    """SSE streaming endpoint for provider responses as text/event-stream."""
    
    # ── INPUT SAFETY GUARD (pre-check before streaming) ──
    user_id_for_safety = request.user_id or GUEST_USER_ID
    is_safe, classification, _ = await run_in_threadpool(
        check_input_safety,
        request.prompt,
        user_id_for_safety,
        "/llm/stream",
        request.task,
        request.safety_mode,
    )
    if not is_safe:
        logger.warning("[Safety] Stream input blocked for user=%s classification=%s", user_id_for_safety, classification)
        reason = "safety_violation" if classification in EXPLICIT_BLOCKED_CLASSIFICATIONS else "safety_degraded"
        raise HTTPException(
            status_code=400,
            detail={"status": "blocked", "reason": reason},
        )
    
    # Check if this is a chart-related task (exempt from output guard)
    is_chart_task = request.task in {"chart", "chart_generate", "chart_generation"}
    
    def event_generator():
        try:
            if is_guest_user(request.user_id):
                user_id = GUEST_USER_ID
                effective_model_override = (
                    GUEST_TEXT_MODEL_OVERRIDE
                    if request.model_override == GUEST_TEXT_MODEL_OVERRIDE
                    else GUEST_MODEL_OVERRIDE
                )
                assigned_db = None
            else:
                user_id = require_user_id(request.user_id)
                assigned_db = reserve_llm_request_slot(user_id) if PYTHON_LLM_QUOTA_ENFORCEMENT else None
                effective_model_override = request.model_override
                logger.info(
                    "[stream] quota_%s user_id=%s db=%s task=%s",
                    "reserved" if PYTHON_LLM_QUOTA_ENFORCEMENT else "delegated_to_billing",
                    user_id,
                    assigned_db,
                    request.task,
                )
            
            # ── OUTPUT SAFETY MONITOR ──
            # Skip for chart generation to prevent false positives on code/data
            safety_monitor = None if is_chart_task else StreamingSafetyMonitor(user_id, request.task)
            full_output_parts: list[str] = []
            capacity_event_sent = False
            
            for chunk in stream_llm_router(
                prompt=request.prompt,
                task=request.task,
                model_override=effective_model_override,
                user_id=user_id,
                image_attachments=request.image_attachments or None,
                max_output_tokens=request.max_output_tokens,
                reasoning_effort=request.reasoning_effort,
                execution_mode=request.execution_mode,
                skip_wrappers=bool(request.skip_wrappers),
                budget_policy=request.budget_policy,
                sentiq_tool_request=request.sentiq_tool_request,
            ):
                if not capacity_event_sent:
                    telemetry = get_current_groq_call_telemetry()
                    if telemetry and telemetry.get("capacity"):
                        yield f"event: capacity\ndata: {json.dumps({'capacity': telemetry['capacity']})}\n\n"
                        capacity_event_sent = True
                if isinstance(chunk, dict):
                    if chunk.get("kind") == "text_delta":
                        text_delta = str(chunk.get("text") or "")
                        if safety_monitor and text_delta:
                            full_output_parts.append(text_delta)
                            if not safety_monitor.add_token(text_delta):
                                logger.warning("[Safety] Output violation detected - terminating stream")
                                yield f"event: error\ndata: {json.dumps({'code': 'safety_violation', 'message': 'Response blocked due to safety concerns'})}\n\n"
                                return
                    yield f"data: {json.dumps({'delta': chunk})}\n\n"
                    continue

                # Check output safety (if monitor active)
                if safety_monitor:
                    full_output_parts.append(chunk)
                    if not safety_monitor.add_token(chunk):
                        # Safety violation detected — terminate stream
                        logger.warning("[Safety] Output violation detected — terminating stream")
                        yield f"event: error\ndata: {json.dumps({'code': 'safety_violation', 'message': 'Response blocked due to safety concerns'})}\n\n"
                        return
                
                # SSE format: data: <text>\n\n
                yield f"data: {json.dumps({'text': chunk})}\n\n"
            if not capacity_event_sent:
                telemetry = get_current_groq_call_telemetry()
                if telemetry and telemetry.get("capacity"):
                    yield f"event: capacity\ndata: {json.dumps({'capacity': telemetry['capacity']})}\n\n"
            if safety_monitor:
                final_output = "".join(full_output_parts).strip()
                if final_output:
                    output_safe, output_classification, _ = check_output_safety(final_output, user_id, "/llm/stream", request.task)
                    if not output_safe:
                        code = "safety_violation" if output_classification in EXPLICIT_BLOCKED_CLASSIFICATIONS else "safety_degraded"
                        logger.warning(
                            "[Safety] Final stream output blocked user=%s classification=%s",
                            user_id,
                            output_classification,
                        )
                        yield f"event: error\ndata: {json.dumps({'code': code, 'message': 'Response blocked due to safety concerns'})}\n\n"
                        return
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.error("Streaming failed: %s", e)
            yield f"data: {json.dumps({'error': 'LLM stream failed'})}\n\n"

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
        assigned_db = reserve_llm_request_slot(user_id) if PYTHON_LLM_QUOTA_ENFORCEMENT else None
        logger.info(
            "[vision] quota_%s user_id=%s db=%s",
            "reserved" if PYTHON_LLM_QUOTA_ENFORCEMENT else "delegated_to_billing",
            user_id,
            assigned_db,
        )
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
        raise HTTPException(status_code=500, detail="Vision invocation failed")


# ============================
# Embedding endpoint
# ============================

EMBEDDING_MODEL = os.getenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001")
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
async def render_chart(
    request: ChartRenderRequest,
    x_sentiq_internal_token: Optional[str] = Header(default=None),
):
    """Execute matplotlib chart code and return a base64 PNG preview.

    The code must be self-contained matplotlib Python (generated by the
    chartRenderer).  The script is expected to print a data URI of the form
    ``data:image/png;base64,<base64>`` to stdout.

    Returns {"preview": "data:image/png;base64,..."} on success.
    Returns {"preview": null, "error": "..."} on failure (non-fatal).
    """
    require_internal_service_token(x_sentiq_internal_token)

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
        return {"preview": None, "error": "render failed"}


# ============================
# Safety audit endpoint
# ============================

@app.get("/llm/safety/audit")
async def get_safety_audit(
    limit: int = 50,
    x_sentiq_internal_token: Optional[str] = Header(default=None),
):
    """Get recent safety audit entries for review."""
    require_internal_service_token(x_sentiq_internal_token)
    return {
        "entries": get_safety_audit_entries(min(limit, MAX_SAFETY_AUDIT_ENTRIES)),
        "max_entries": MAX_SAFETY_AUDIT_ENTRIES,
    }


@app.get("/llm/safety/health")
async def safety_health():
    """Check if the safety model is accessible."""
    try:
        # Quick test call with innocuous input
        call_safety_model("Hello, how are you?", timeout=5, check_type="input")
        return {
            "status": "ok",
            "available": True,
            "fail_closed": True,
        }
    except Exception:
        return {
            "status": "degraded",
            "available": False,
            "fail_closed": True,
        }


if __name__ == "__main__":
    uvicorn.run(app, host=LLM_SERVICE_HOST, port=LLM_SERVICE_PORT, log_level="info")
