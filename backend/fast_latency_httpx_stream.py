"""Trace OpenAI-compatible httpx streams used by Groq-style SDK clients.

Imported before the base observability installer so the original httpx iterator
methods remain available even after the base module adds its generic hooks.
"""

from __future__ import annotations

from typing import Any, Iterator

import httpx

import fast_latency_observability as base

_ORIGINAL_ITER_BYTES = httpx.Response.iter_bytes
_ORIGINAL_ITER_LINES = httpx.Response.iter_lines
_INSTALLED = False
_MAX_SSE_PROBE_CHARS = 64 * 1024


def _response_trace(response: httpx.Response) -> tuple[str, str, str]:
    trace_id = base._safe_trace_id(getattr(response, "_sentiq_latency_trace_id", ""))
    provider = str(getattr(response, "_sentiq_latency_provider", "") or "")
    model = str(getattr(response, "_sentiq_latency_model", "") or "")
    return trace_id, provider, model


def _log_first_event(response: httpx.Response, trace_id: str, provider: str, model: str) -> None:
    if getattr(response, "_sentiq_latency_first_event_logged", False):
        return
    setattr(response, "_sentiq_latency_first_event_logged", True)
    base._log_latency(
        "python.provider_first_sse_event",
        trace_id=trace_id,
        provider=provider,
        model=model or None,
    )


def _log_first_visible(response: httpx.Response, trace_id: str, provider: str, model: str) -> None:
    if getattr(response, "_sentiq_latency_first_visible_logged", False):
        return
    setattr(response, "_sentiq_latency_first_visible_logged", True)
    base._log_latency(
        "python.provider_first_visible_delta",
        trace_id=trace_id,
        provider=provider,
        model=model or None,
    )


def _observe_sse_text(response: httpx.Response, text: str) -> None:
    trace_id, provider, model = _response_trace(response)
    if not trace_id or not provider or not text:
        return

    probe = str(getattr(response, "_sentiq_latency_sse_probe", "") or "") + text
    probe = probe.replace("\r\n", "\n").replace("\r", "\n")
    blocks = probe.split("\n\n")
    remainder = blocks.pop() if blocks else ""
    setattr(response, "_sentiq_latency_sse_probe", remainder[-_MAX_SSE_PROBE_CHARS:])

    for block in blocks:
        data_lines = [line for line in block.split("\n") if line.lstrip().startswith("data:")]
        if not data_lines:
            continue
        payload_lines = [line.lstrip() for line in data_lines]
        if not any(line[5:].strip() for line in payload_lines):
            continue
        _log_first_event(response, trace_id, provider, model)
        if any(base._line_has_visible_delta(line) for line in payload_lines):
            _log_first_visible(response, trace_id, provider, model)


def _observe_line(response: httpx.Response, line: Any) -> None:
    text = line.decode("utf-8", errors="ignore") if isinstance(line, bytes) else str(line or "")
    if not text.strip():
        return
    _observe_sse_text(response, f"{text}\n\n")


def install() -> None:
    global _INSTALLED
    if _INSTALLED:
        return
    _INSTALLED = True

    def patched_iter_bytes(self: httpx.Response, *args: Any, **kwargs: Any) -> Iterator[bytes]:
        for chunk in _ORIGINAL_ITER_BYTES(self, *args, **kwargs):
            if chunk:
                _observe_sse_text(self, chunk.decode("utf-8", errors="ignore"))
            yield chunk

    def patched_iter_lines(self: httpx.Response, *args: Any, **kwargs: Any) -> Iterator[str]:
        for line in _ORIGINAL_ITER_LINES(self, *args, **kwargs):
            _observe_line(self, line)
            yield line

    patched_iter_bytes.__sentiq_latency_wrapped__ = True
    patched_iter_lines.__sentiq_latency_wrapped__ = True
    httpx.Response.iter_bytes = patched_iter_bytes
    httpx.Response.iter_lines = patched_iter_lines


__all__ = ["install"]
