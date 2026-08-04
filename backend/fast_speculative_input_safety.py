"""Buffered provider speculation for ordinary Fast text streams.

The provider may begin while the existing input-safety classifier runs, but no
response headers or provider bytes are released until the classifier approves
the request. Ineligible requests delegate to the original /llm/stream handler.
"""

from __future__ import annotations

import contextvars
import json
import os
import queue
import threading
import time
from collections.abc import Callable, Iterator
from typing import Any, Optional

from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

FEATURE_FLAG = "SENTIQ_FAST_PARALLEL_INPUT_SAFETY_ENABLED"
BUFFER_ITEMS_ENV = "SENTIQ_FAST_SPECULATIVE_BUFFER_ITEMS"
DEFAULT_BUFFER_ITEMS = 512
ELIGIBLE_TASKS = frozenset({"chat", "general"})
_END = object()


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _buffer_item_limit() -> int:
    try:
        configured = int(os.getenv(BUFFER_ITEMS_ENV, str(DEFAULT_BUFFER_ITEMS)))
    except (TypeError, ValueError):
        configured = DEFAULT_BUFFER_ITEMS
    return max(32, min(4096, configured))


def _execution_mode(request: Any) -> str:
    explicit = str(getattr(request, "execution_mode", "") or "").strip().lower()
    if explicit:
        return explicit
    policy = getattr(request, "budget_policy", None)
    if isinstance(policy, dict):
        return str(policy.get("execution_mode") or "").strip().lower()
    return "fast"


def is_ordinary_fast_text_request(request: Any, service: Any) -> bool:
    """Return True only for the narrow, reversible speculative lane."""
    if not _env_bool(FEATURE_FLAG, False):
        return False
    if bool(getattr(service, "PYTHON_LLM_QUOTA_ENFORCEMENT", False)):
        return False
    if _execution_mode(request) != "fast":
        return False
    if str(getattr(request, "task", "") or "").strip().lower() not in ELIGIBLE_TASKS:
        return False
    if bool(getattr(request, "use_simulation", False)):
        return False
    if getattr(request, "image_attachments", None):
        return False
    if getattr(request, "sentiq_tool_request", None):
        return False
    if str(getattr(request, "tool_transport_mode", "none") or "none") != "none":
        return False
    if getattr(request, "required_capabilities", None):
        return False
    return True


class SpeculativeProviderBuffer:
    """Run a synchronous provider iterator in one context-preserving thread."""

    def __init__(
        self,
        iterator_factory: Callable[[], Iterator[Any]],
        telemetry_supplier: Optional[Callable[[], Optional[dict[str, Any]]]] = None,
        *,
        max_items: Optional[int] = None,
    ) -> None:
        self._iterator_factory = iterator_factory
        self._telemetry_supplier = telemetry_supplier
        self._queue: queue.Queue[Any] = queue.Queue(maxsize=max_items or _buffer_item_limit())
        self._cancelled = threading.Event()
        self._done = threading.Event()
        self._started = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._telemetry_lock = threading.Lock()
        self._telemetry: Optional[dict[str, Any]] = None
        self._cancel_reason = ""

    def start(self) -> None:
        if self._thread is not None:
            return
        context = contextvars.copy_context()
        self._thread = threading.Thread(
            target=lambda: context.run(self._run),
            name="sentiq-fast-speculative-provider",
            daemon=True,
        )
        self._thread.start()
        self._started.wait(timeout=1.0)

    def cancel(self, reason: str) -> None:
        self._cancel_reason = reason
        self._cancelled.set()

    def wait(self, timeout: Optional[float] = None) -> bool:
        return self._done.wait(timeout)

    def buffered_items(self) -> int:
        return self._queue.qsize()

    def telemetry(self) -> Optional[dict[str, Any]]:
        with self._telemetry_lock:
            return dict(self._telemetry) if isinstance(self._telemetry, dict) else None

    def _capture_telemetry(self) -> None:
        if self._telemetry_supplier is None:
            return
        try:
            telemetry = self._telemetry_supplier()
        except Exception:
            return
        if isinstance(telemetry, dict):
            with self._telemetry_lock:
                self._telemetry = dict(telemetry)

    def _put(self, value: Any) -> bool:
        while not self._cancelled.is_set():
            try:
                self._queue.put(value, timeout=0.1)
                return True
            except queue.Full:
                continue
        return False

    def _run(self) -> None:
        iterator: Optional[Iterator[Any]] = None
        self._started.set()
        try:
            iterator = iter(self._iterator_factory())
            for chunk in iterator:
                self._capture_telemetry()
                if self._cancelled.is_set():
                    break
                if not self._put(("chunk", chunk)):
                    break
            self._capture_telemetry()
            if not self._cancelled.is_set():
                self._put(("end", _END))
        except BaseException as error:
            self._capture_telemetry()
            if not self._cancelled.is_set():
                self._put(("error", error))
        finally:
            if iterator is not None:
                close = getattr(iterator, "close", None)
                if callable(close):
                    try:
                        close()
                    except Exception:
                        pass
            self._done.set()

    def iter_chunks(self) -> Iterator[Any]:
        while True:
            kind, value = self._queue.get()
            if kind == "chunk":
                yield value
                continue
            if kind == "error":
                raise value
            return


def _resolve_stream_identity(service: Any, request: Any) -> tuple[str, Optional[str]]:
    if service.is_guest_user(request.user_id):
        user_id = service.GUEST_USER_ID
        effective_model_override = (
            service.GUEST_TEXT_MODEL_OVERRIDE
            if request.model_override == service.GUEST_TEXT_MODEL_OVERRIDE
            else service.GUEST_MODEL_OVERRIDE
        )
        return user_id, effective_model_override
    return service.require_user_id(request.user_id), request.model_override


def _provider_iterator(service: Any, request: Any, user_id: str, model_override: Optional[str]) -> Iterator[Any]:
    return service.stream_llm_router(
        prompt=request.prompt,
        task=request.task,
        model_override=model_override,
        user_id=user_id,
        image_attachments=request.image_attachments or None,
        max_output_tokens=request.max_output_tokens,
        reasoning_effort=request.reasoning_effort,
        execution_mode=request.execution_mode,
        skip_wrappers=bool(request.skip_wrappers),
        budget_policy=request.budget_policy,
        sentiq_tool_request=request.sentiq_tool_request,
        required_capabilities=request.required_capabilities,
        tool_transport_mode=request.tool_transport_mode,
    )


def _speculative_event_generator(
    service: Any,
    request: Any,
    user_id: str,
    source: SpeculativeProviderBuffer,
) -> Iterator[str]:
    safety_monitor = service.StreamingSafetyMonitor(user_id, request.task)
    full_output_parts: list[str] = []
    capacity_event_sent = False

    try:
        for chunk in source.iter_chunks():
            if not capacity_event_sent:
                telemetry = source.telemetry()
                if telemetry and telemetry.get("capacity"):
                    yield f"event: capacity\ndata: {json.dumps({'capacity': telemetry['capacity']})}\n\n"
                    capacity_event_sent = True

            if isinstance(chunk, dict):
                if chunk.get("kind") == "provider_usage":
                    usage = chunk.get("usage") if isinstance(chunk.get("usage"), dict) else {}
                    yield f"event: usage\ndata: {json.dumps({'usage': usage})}\n\n"
                    continue
                if chunk.get("kind") == "text_delta":
                    text_delta = str(chunk.get("text") or "")
                    if text_delta:
                        full_output_parts.append(text_delta)
                        if not safety_monitor.add_token(text_delta):
                            service.logger.warning("[Safety] Output violation detected - terminating speculative stream")
                            yield f"event: error\ndata: {json.dumps({'code': 'safety_violation', 'message': 'Response blocked due to safety concerns'})}\n\n"
                            return
                yield f"data: {json.dumps({'delta': chunk})}\n\n"
                continue

            text_chunk = str(chunk)
            full_output_parts.append(text_chunk)
            if not safety_monitor.add_token(text_chunk):
                service.logger.warning("[Safety] Output violation detected - terminating speculative stream")
                yield f"event: error\ndata: {json.dumps({'code': 'safety_violation', 'message': 'Response blocked due to safety concerns'})}\n\n"
                return
            yield f"data: {json.dumps({'text': text_chunk})}\n\n"

        if not capacity_event_sent:
            telemetry = source.telemetry()
            if telemetry and telemetry.get("capacity"):
                yield f"event: capacity\ndata: {json.dumps({'capacity': telemetry['capacity']})}\n\n"

        final_output = "".join(full_output_parts).strip()
        if final_output:
            output_safe, output_classification, _ = service.check_output_safety(
                final_output,
                user_id,
                "/llm/stream",
                request.task,
            )
            if not output_safe:
                code = (
                    "safety_violation"
                    if output_classification in service.EXPLICIT_BLOCKED_CLASSIFICATIONS
                    else "safety_degraded"
                )
                service.logger.warning(
                    "[Safety] Final speculative stream output blocked user=%s classification=%s",
                    user_id,
                    output_classification,
                )
                yield f"event: error\ndata: {json.dumps({'code': code, 'message': 'Response blocked due to safety concerns'})}\n\n"
                return
        yield "data: [DONE]\n\n"
    except GeneratorExit:
        raise
    except service.ModelToolCapabilityUnavailableError as error:
        service.logger.error("Streaming tool capability unavailable: %s", error)
        yield f"event: error\ndata: {json.dumps({'code': error.code, 'message': str(error)})}\n\n"
    except Exception as error:
        service.logger.error("Speculative streaming failed: %s", error)
        yield f"data: {json.dumps({'error': 'LLM stream failed'})}\n\n"
    finally:
        source.cancel("consumer_closed")


def build_stream_endpoint(service: Any, original_stream: Callable[..., Any]) -> Callable[..., Any]:
    async def endpoint(request: Any):
        if not is_ordinary_fast_text_request(request, service):
            return await original_stream(request)

        user_id, effective_model_override = _resolve_stream_identity(service, request)
        service.log_model_tool_gateway_diagnostic(request, effective_model_override, streaming=True)
        service.logger.info(
            "[FastSpeculation] provider_started user=%s task=%s mode=fast release_gate=input_safety",
            user_id,
            request.task,
        )

        source = SpeculativeProviderBuffer(
            lambda: _provider_iterator(service, request, user_id, effective_model_override),
            service.get_current_groq_call_telemetry,
        )
        source.start()
        safety_started = time.perf_counter()
        try:
            is_safe, classification, _ = await run_in_threadpool(
                service.check_input_safety,
                request.prompt,
                user_id,
                "/llm/stream",
                request.task,
                request.safety_mode,
            )
        except BaseException:
            source.cancel("input_safety_exception")
            raise

        safety_duration_ms = round((time.perf_counter() - safety_started) * 1000, 1)
        if not is_safe:
            source.cancel("input_safety_blocked")
            source.wait(timeout=0.25)
            service.logger.warning(
                "[Safety] Speculative stream input blocked user=%s classification=%s buffered_items=%s",
                user_id,
                classification,
                source.buffered_items(),
            )
            reason = (
                "safety_violation"
                if classification in service.EXPLICIT_BLOCKED_CLASSIFICATIONS
                else "safety_degraded"
            )
            raise HTTPException(
                status_code=400,
                detail={"status": "blocked", "reason": reason},
            )

        service.logger.info(
            "[FastSpeculation] input_safety_approved user=%s classification=%s duration_ms=%s buffered_items=%s",
            user_id,
            classification,
            safety_duration_ms,
            source.buffered_items(),
        )
        return StreamingResponse(
            _speculative_event_generator(service, request, user_id, source),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    return endpoint


def install(service: Any) -> None:
    """Replace only the POST /llm/stream route before Uvicorn starts."""
    app = service.app
    if getattr(app.state, "fast_speculative_input_safety_installed", False):
        return

    original_stream = service.stream_llm
    endpoint = build_stream_endpoint(service, original_stream)
    endpoint.__name__ = "stream_llm_with_speculative_input_safety"
    endpoint.__annotations__ = {"request": service.LLMInvokeRequest}

    retained_routes = []
    removed = 0
    for route in app.router.routes:
        methods = set(getattr(route, "methods", set()) or set())
        if getattr(route, "path", None) == "/llm/stream" and "POST" in methods:
            removed += 1
            continue
        retained_routes.append(route)
    if removed != 1:
        raise RuntimeError(f"Expected exactly one POST /llm/stream route, found {removed}")
    app.router.routes = retained_routes
    app.add_api_route("/llm/stream", endpoint, methods=["POST"])
    app.state.fast_speculative_input_safety_installed = True
    service.logger.info(
        "[FastSpeculation] installed enabled=%s buffer_items=%s eligible_tasks=%s",
        _env_bool(FEATURE_FLAG, False),
        _buffer_item_limit(),
        ",".join(sorted(ELIGIBLE_TASKS)),
    )
