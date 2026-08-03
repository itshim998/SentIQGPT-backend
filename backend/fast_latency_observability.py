"""Low-overhead Fast-mode latency attribution.

The module never logs prompts, responses, credentials, or raw request bodies. It
uses the client request identifier propagated by the Node preload as a trace key.
"""

from __future__ import annotations

import contextlib
import contextvars
import json
import os
import re
import time
from typing import Any, Iterator, Optional
from urllib.parse import urlparse

SCHEMA_VERSION = 1
TRACE_HEADER = b"x-sentiq-latency-trace"
SAFE_TRACE_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
ENABLED = os.getenv("SENTIQ_FAST_LATENCY_OBSERVABILITY_ENABLED", "true").strip().lower() != "false"

_trace_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("sentiq_fast_latency_trace_id", default="")
_request_started_ns_var: contextvars.ContextVar[int] = contextvars.ContextVar(
    "sentiq_fast_latency_request_started_ns",
    default=0,
)
_installed = False


def _safe_trace_id(value: Any) -> str:
    trace_id = str(value or "").strip()
    return trace_id if SAFE_TRACE_PATTERN.fullmatch(trace_id) else ""


def _now_ns() -> int:
    return time.perf_counter_ns()


def _round_ms(value: float) -> float:
    return max(0.0, round(float(value), 1))


def _elapsed_ms(started_ns: int) -> float:
    return _round_ms((_now_ns() - started_ns) / 1_000_000)


def _compact(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if item is not None and item != ""}


def _log_latency(phase: str, *, trace_id: Optional[str] = None, **fields: Any) -> None:
    resolved_trace = _safe_trace_id(trace_id or _trace_id_var.get())
    if not resolved_trace:
        return
    request_started_ns = _request_started_ns_var.get()
    payload = _compact({
        "schema_version": SCHEMA_VERSION,
        "scope": "fast_latency",
        "layer": "python",
        "phase": phase,
        "trace_id": resolved_trace,
        "execution_mode": "fast",
        "elapsed_ms": _elapsed_ms(request_started_ns) if request_started_ns else None,
        "epoch_ms": int(time.time() * 1000),
        **fields,
    })
    print(json.dumps(payload, separators=(",", ":"), sort_keys=True), flush=True)


@contextlib.contextmanager
def latency_trace_context(trace_id: str) -> Iterator[None]:
    """Test/support helper for explicitly scoped provider calls."""

    safe_trace = _safe_trace_id(trace_id)
    trace_token = _trace_id_var.set(safe_trace)
    start_token = _request_started_ns_var.set(_now_ns())
    try:
        yield
    finally:
        _request_started_ns_var.reset(start_token)
        _trace_id_var.reset(trace_token)


def _extract_scope_trace(scope: dict[str, Any]) -> str:
    for name, value in scope.get("headers") or []:
        if name.lower() == TRACE_HEADER:
            try:
                return _safe_trace_id(value.decode("ascii", errors="ignore"))
            except Exception:
                return ""
    return ""


def _request_json_from_httpx(request: Any) -> dict[str, Any]:
    try:
        content = request.content
        if not content:
            return {}
        if isinstance(content, bytes):
            content = content.decode("utf-8", errors="ignore")
        parsed = json.loads(content)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _request_json_from_requests(kwargs: dict[str, Any]) -> dict[str, Any]:
    payload = kwargs.get("json")
    if isinstance(payload, dict):
        return payload
    data = kwargs.get("data")
    if isinstance(data, bytes):
        data = data.decode("utf-8", errors="ignore")
    if isinstance(data, str):
        try:
            parsed = json.loads(data)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _provider_from_url_and_payload(url: str, payload: dict[str, Any]) -> tuple[str, str]:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    model = str(payload.get("model") or "").strip()
    normalized_model = model.lower()
    if normalized_model == "qwen-safety":
        return "safety", model
    if "api.groq.com" in host:
        return "groq", model
    if "generativelanguage.googleapis.com" in host or "googleapis.com" in host:
        return "gemini", model
    if "pollinations" in host:
        return "pollinations", model
    if "integrate.api.nvidia.com" in host:
        return "nvidia", model
    return "", model


def _line_has_visible_delta(line: Any) -> bool:
    if isinstance(line, bytes):
        text = line.decode("utf-8", errors="ignore")
    else:
        text = str(line or "")
    text = text.strip()
    if not text.startswith("data:"):
        return False
    payload_text = text[5:].strip()
    if not payload_text or payload_text == "[DONE]":
        return False
    try:
        payload = json.loads(payload_text)
    except Exception:
        return False
    if not isinstance(payload, dict):
        return False
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return False
    first = choices[0] if isinstance(choices[0], dict) else {}
    delta = first.get("delta") if isinstance(first.get("delta"), dict) else {}
    content = delta.get("content")
    if isinstance(content, str) and content:
        return True
    if isinstance(content, list) and content:
        return True
    tool_calls = delta.get("tool_calls")
    return isinstance(tool_calls, list) and bool(tool_calls)


def _attach_response_trace(response: Any, trace_id: str, provider: str, model: str) -> None:
    try:
        setattr(response, "_sentiq_latency_trace_id", trace_id)
        setattr(response, "_sentiq_latency_provider", provider)
        setattr(response, "_sentiq_latency_model", model)
    except Exception:
        pass


def _install_fastapi_patch() -> None:
    try:
        from fastapi.applications import FastAPI
    except Exception:
        return
    if getattr(FastAPI.__call__, "__sentiq_latency_wrapped__", False):
        return

    original_call = FastAPI.__call__

    async def patched_call(self: Any, scope: dict[str, Any], receive: Any, send: Any) -> Any:
        trace_id = _extract_scope_trace(scope) if scope.get("type") == "http" else ""
        path = str(scope.get("path") or "")
        if not trace_id or path not in {"/llm/stream", "/llm/invoke"}:
            return await original_call(self, scope, receive, send)
        trace_token = _trace_id_var.set(trace_id)
        start_token = _request_started_ns_var.set(_now_ns())
        _log_latency("python.request_received", endpoint=path, method=scope.get("method"))
        try:
            return await original_call(self, scope, receive, send)
        except Exception as error:
            _log_latency("python.request_failed", error_name=type(error).__name__)
            raise
        finally:
            _log_latency("python.request_completed")
            _request_started_ns_var.reset(start_token)
            _trace_id_var.reset(trace_token)

    patched_call.__sentiq_latency_wrapped__ = True
    FastAPI.__call__ = patched_call


def _install_httpx_patch() -> None:
    try:
        import httpx
    except Exception:
        return

    if not getattr(httpx.Client.send, "__sentiq_latency_wrapped__", False):
        original_send = httpx.Client.send

        def patched_send(self: Any, request: Any, *args: Any, **kwargs: Any) -> Any:
            trace_id = _safe_trace_id(_trace_id_var.get())
            if not trace_id:
                return original_send(self, request, *args, **kwargs)
            payload = _request_json_from_httpx(request)
            provider, model = _provider_from_url_and_payload(str(request.url), payload)
            if not provider:
                return original_send(self, request, *args, **kwargs)
            phase_prefix = "python.safety" if provider == "safety" else "python.provider"
            started_ns = _now_ns()
            _log_latency(
                f"{phase_prefix}_request_started",
                provider=provider,
                model=model or None,
                host=request.url.host,
            )
            try:
                response = original_send(self, request, *args, **kwargs)
            except Exception as error:
                _log_latency(
                    f"{phase_prefix}_request_failed",
                    provider=provider,
                    model=model or None,
                    duration_ms=_elapsed_ms(started_ns),
                    error_name=type(error).__name__,
                )
                raise
            _attach_response_trace(response, trace_id, provider, model)
            _log_latency(
                f"{phase_prefix}_response_headers_received",
                provider=provider,
                model=model or None,
                status_code=response.status_code,
                duration_ms=_elapsed_ms(started_ns),
            )
            if provider == "safety" and not kwargs.get("stream"):
                _log_latency(
                    "python.safety_request_completed",
                    provider=provider,
                    model=model or None,
                    status_code=response.status_code,
                    duration_ms=_elapsed_ms(started_ns),
                )
            return response

        patched_send.__sentiq_latency_wrapped__ = True
        httpx.Client.send = patched_send

    if not getattr(httpx.Response.iter_lines, "__sentiq_latency_wrapped__", False):
        original_iter_lines = httpx.Response.iter_lines

        def patched_iter_lines(self: Any, *args: Any, **kwargs: Any) -> Iterator[str]:
            trace_id = _safe_trace_id(getattr(self, "_sentiq_latency_trace_id", ""))
            provider = str(getattr(self, "_sentiq_latency_provider", "") or "")
            model = str(getattr(self, "_sentiq_latency_model", "") or "")
            first_event_logged = False
            first_visible_logged = False
            for line in original_iter_lines(self, *args, **kwargs):
                if trace_id and provider and str(line or "").strip() and not first_event_logged:
                    first_event_logged = True
                    _log_latency(
                        "python.provider_first_sse_event",
                        trace_id=trace_id,
                        provider=provider,
                        model=model or None,
                    )
                if trace_id and provider and not first_visible_logged and _line_has_visible_delta(line):
                    first_visible_logged = True
                    _log_latency(
                        "python.provider_first_visible_delta",
                        trace_id=trace_id,
                        provider=provider,
                        model=model or None,
                    )
                yield line

        patched_iter_lines.__sentiq_latency_wrapped__ = True
        httpx.Response.iter_lines = patched_iter_lines


def _install_requests_patch() -> None:
    try:
        import requests
    except Exception:
        return

    if not getattr(requests.sessions.Session.request, "__sentiq_latency_wrapped__", False):
        original_request = requests.sessions.Session.request

        def patched_request(self: Any, method: str, url: str, **kwargs: Any) -> Any:
            trace_id = _safe_trace_id(_trace_id_var.get())
            if not trace_id:
                return original_request(self, method, url, **kwargs)
            payload = _request_json_from_requests(kwargs)
            provider, model = _provider_from_url_and_payload(url, payload)
            if not provider:
                return original_request(self, method, url, **kwargs)
            phase_prefix = "python.safety" if provider == "safety" else "python.provider"
            started_ns = _now_ns()
            _log_latency(
                f"{phase_prefix}_request_started",
                provider=provider,
                model=model or None,
                host=urlparse(url).hostname,
            )
            try:
                response = original_request(self, method, url, **kwargs)
            except Exception as error:
                _log_latency(
                    f"{phase_prefix}_request_failed",
                    provider=provider,
                    model=model or None,
                    duration_ms=_elapsed_ms(started_ns),
                    error_name=type(error).__name__,
                )
                raise
            _attach_response_trace(response, trace_id, provider, model)
            _log_latency(
                f"{phase_prefix}_response_headers_received",
                provider=provider,
                model=model or None,
                status_code=response.status_code,
                duration_ms=_elapsed_ms(started_ns),
            )
            if provider == "safety" and not kwargs.get("stream"):
                _log_latency(
                    "python.safety_request_completed",
                    provider=provider,
                    model=model or None,
                    status_code=response.status_code,
                    duration_ms=_elapsed_ms(started_ns),
                )
            return response

        patched_request.__sentiq_latency_wrapped__ = True
        requests.sessions.Session.request = patched_request

    if not getattr(requests.models.Response.iter_lines, "__sentiq_latency_wrapped__", False):
        original_iter_lines = requests.models.Response.iter_lines

        def patched_iter_lines(self: Any, *args: Any, **kwargs: Any) -> Iterator[Any]:
            trace_id = _safe_trace_id(getattr(self, "_sentiq_latency_trace_id", ""))
            provider = str(getattr(self, "_sentiq_latency_provider", "") or "")
            model = str(getattr(self, "_sentiq_latency_model", "") or "")
            first_event_logged = False
            first_visible_logged = False
            for line in original_iter_lines(self, *args, **kwargs):
                if trace_id and provider and str(line or "").strip() and not first_event_logged:
                    first_event_logged = True
                    _log_latency(
                        "python.provider_first_sse_event",
                        trace_id=trace_id,
                        provider=provider,
                        model=model or None,
                    )
                if trace_id and provider and not first_visible_logged and _line_has_visible_delta(line):
                    first_visible_logged = True
                    _log_latency(
                        "python.provider_first_visible_delta",
                        trace_id=trace_id,
                        provider=provider,
                        model=model or None,
                    )
                yield line

        patched_iter_lines.__sentiq_latency_wrapped__ = True
        requests.models.Response.iter_lines = patched_iter_lines


def install() -> None:
    global _installed
    if _installed or not ENABLED:
        return
    _installed = True
    _install_fastapi_patch()
    _install_httpx_patch()
    _install_requests_patch()
    print(json.dumps({
        "schema_version": SCHEMA_VERSION,
        "scope": "fast_latency",
        "layer": "python",
        "phase": "observability_installed",
        "epoch_ms": int(time.time() * 1000),
    }, separators=(",", ":"), sort_keys=True), flush=True)


__all__ = [
    "install",
    "latency_trace_context",
    "_line_has_visible_delta",
    "_safe_trace_id",
]
