#!/usr/bin/env python3
"""Contract tests for ordinary Fast speculative input safety."""

from __future__ import annotations

import asyncio
import contextvars
import logging
import os
import threading
import time
from types import SimpleNamespace
from typing import Any

from fastapi import HTTPException

import fast_speculative_input_safety as speculative


class FakeCapabilityError(RuntimeError):
    code = "model_tool_capability_unavailable"


class FakeSafetyMonitor:
    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        self.tokens: list[str] = []

    def add_token(self, token: str) -> bool:
        self.tokens.append(token)
        return True


class FakeService:
    PYTHON_LLM_QUOTA_ENFORCEMENT = False
    GUEST_USER_ID = "guest"
    GUEST_TEXT_MODEL_OVERRIDE = "gpt-oss-120b"
    GUEST_MODEL_OVERRIDE = "gemini-search"
    EXPLICIT_BLOCKED_CLASSIFICATIONS = {"UNSAFE", "BLOCKED"}
    ModelToolCapabilityUnavailableError = FakeCapabilityError
    StreamingSafetyMonitor = FakeSafetyMonitor
    logger = logging.getLogger("fast-speculative-test")

    def __init__(self, safety_check, provider_factory) -> None:
        self.check_input_safety = safety_check
        self._provider_factory = provider_factory
        self.log_calls = 0

    @staticmethod
    def is_guest_user(user_id: str | None) -> bool:
        return user_id == "guest"

    @staticmethod
    def require_user_id(user_id: str | None) -> str:
        if not user_id:
            raise RuntimeError("user required")
        return user_id

    def log_model_tool_gateway_diagnostic(self, *_args: Any, **_kwargs: Any) -> None:
        self.log_calls += 1

    def stream_llm_router(self, **_kwargs: Any):
        return self._provider_factory()

    @staticmethod
    def get_current_groq_call_telemetry() -> None:
        return None

    @staticmethod
    def check_output_safety(*_args: Any, **_kwargs: Any) -> tuple[bool, str, str]:
        return True, "SAFE", "SAFE"


def request(**overrides: Any) -> SimpleNamespace:
    values = {
        "prompt": "Reply with exactly: OK",
        "task": "chat",
        "use_simulation": False,
        "prefer": "groq",
        "model_override": "gpt-oss-120b",
        "user_id": "user-1",
        "safety_mode": "strict",
        "max_output_tokens": 2500,
        "reasoning_effort": "low",
        "execution_mode": "fast",
        "skip_wrappers": True,
        "image_attachments": None,
        "budget_policy": {"execution_mode": "fast"},
        "sentiq_tool_request": None,
        "tool_transport_mode": "none",
        "required_capabilities": None,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def assert_true(value: Any, label: str) -> None:
    if not value:
        raise AssertionError(label)


def assert_equal(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def test_eligibility_is_narrow() -> None:
    previous = os.environ.get(speculative.FEATURE_FLAG)
    os.environ[speculative.FEATURE_FLAG] = "true"
    service = SimpleNamespace(PYTHON_LLM_QUOTA_ENFORCEMENT=False)
    try:
        assert_true(speculative.is_ordinary_fast_text_request(request(), service), "ordinary Fast chat should qualify")
        assert_true(not speculative.is_ordinary_fast_text_request(request(execution_mode="intuitive"), service), "Intuitive must not qualify")
        assert_true(not speculative.is_ordinary_fast_text_request(request(task="chart_generate"), service), "artifact task must not qualify")
        assert_true(not speculative.is_ordinary_fast_text_request(request(image_attachments=[{"base64": "x"}]), service), "image input must not qualify")
        assert_true(not speculative.is_ordinary_fast_text_request(request(sentiq_tool_request={"tools": []}, tool_transport_mode="streaming"), service), "tools must not qualify")
        assert_true(not speculative.is_ordinary_fast_text_request(request(required_capabilities=["image_input"]), service), "capability-bearing request must not qualify")
        service.PYTHON_LLM_QUOTA_ENFORCEMENT = True
        assert_true(not speculative.is_ordinary_fast_text_request(request(), service), "Python quota enforcement must force serial path")
    finally:
        if previous is None:
            os.environ.pop(speculative.FEATURE_FLAG, None)
        else:
            os.environ[speculative.FEATURE_FLAG] = previous


def test_buffer_preserves_context_and_order() -> None:
    trace = contextvars.ContextVar("trace", default="missing")
    observed: list[str] = []

    def provider():
        observed.append(trace.get())
        yield "A"
        yield "B"

    token = trace.set("trace-123")
    try:
        source = speculative.SpeculativeProviderBuffer(provider, max_items=32)
        source.start()
        chunks = list(source.iter_chunks())
    finally:
        trace.reset(token)

    assert_equal(observed, ["trace-123"], "latency context propagation")
    assert_equal(chunks, ["A", "B"], "provider chunk order")
    assert_true(source.wait(1.0), "provider thread should finish")


async def consume_response(response) -> str:
    parts: list[str] = []
    async for chunk in response.body_iterator:
        parts.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk))
    return "".join(parts)


async def test_provider_overlaps_safety_without_early_release() -> None:
    previous = os.environ.get(speculative.FEATURE_FLAG)
    os.environ[speculative.FEATURE_FLAG] = "true"
    safety_release = threading.Event()
    provider_started = threading.Event()

    def safety_check(*_args: Any, **_kwargs: Any):
        if not safety_release.wait(2.0):
            raise RuntimeError("safety gate test timed out")
        return True, "SAFE", "SAFE"

    def provider():
        provider_started.set()
        yield "OK"

    service = FakeService(safety_check, provider)
    delegated = False

    async def original_stream(_request):
        nonlocal delegated
        delegated = True
        return "delegated"

    endpoint = speculative.build_stream_endpoint(service, original_stream)
    task = asyncio.create_task(endpoint(request()))
    try:
        started = await asyncio.to_thread(provider_started.wait, 1.0)
        assert_true(started, "provider must start while safety is pending")
        await asyncio.sleep(0.05)
        assert_true(not task.done(), "no response may be returned before safety approval")
        safety_release.set()
        response = await asyncio.wait_for(task, 2.0)
        body = await asyncio.wait_for(consume_response(response), 2.0)
        assert_true("OK" in body, "approved provider output must be released")
        assert_true("[DONE]" in body, "approved stream must terminate normally")
        assert_true(not delegated, "eligible request must not use serial endpoint")
        assert_equal(service.log_calls, 1, "route diagnostic count")
    finally:
        safety_release.set()
        if previous is None:
            os.environ.pop(speculative.FEATURE_FLAG, None)
        else:
            os.environ[speculative.FEATURE_FLAG] = previous


async def test_blocked_input_discards_speculative_output() -> None:
    previous = os.environ.get(speculative.FEATURE_FLAG)
    os.environ[speculative.FEATURE_FLAG] = "true"
    provider_started = threading.Event()
    provider_finished = threading.Event()

    def safety_check(*_args: Any, **_kwargs: Any):
        assert_true(provider_started.wait(1.0), "provider should already be speculative")
        return False, "UNSAFE", "UNSAFE"

    def provider():
        try:
            provider_started.set()
            yield "SECRET-NOT-RELEASED"
        finally:
            provider_finished.set()

    service = FakeService(safety_check, provider)

    async def original_stream(_request):
        raise AssertionError("blocked eligible request delegated unexpectedly")

    endpoint = speculative.build_stream_endpoint(service, original_stream)
    try:
        try:
            await endpoint(request())
        except HTTPException as error:
            assert_equal(error.status_code, 400, "blocked HTTP status")
            assert_equal(error.detail, {"status": "blocked", "reason": "safety_violation"}, "blocked response contract")
        else:
            raise AssertionError("blocked request returned a streaming response")
        assert_true(provider_finished.wait(1.0), "speculative provider iterator must close")
    finally:
        if previous is None:
            os.environ.pop(speculative.FEATURE_FLAG, None)
        else:
            os.environ[speculative.FEATURE_FLAG] = previous


async def test_ineligible_request_delegates_unchanged() -> None:
    previous = os.environ.get(speculative.FEATURE_FLAG)
    os.environ[speculative.FEATURE_FLAG] = "true"
    service = FakeService(lambda *_args, **_kwargs: (True, "SAFE", "SAFE"), lambda: iter(["unused"]))
    calls = 0

    async def original_stream(_request):
        nonlocal calls
        calls += 1
        return "serial-result"

    endpoint = speculative.build_stream_endpoint(service, original_stream)
    try:
        result = await endpoint(request(execution_mode="intuitive"))
        assert_equal(result, "serial-result", "delegated result")
        assert_equal(calls, 1, "serial endpoint call count")
    finally:
        if previous is None:
            os.environ.pop(speculative.FEATURE_FLAG, None)
        else:
            os.environ[speculative.FEATURE_FLAG] = previous


def main() -> None:
    test_eligibility_is_narrow()
    print("PASS | eligibility_is_narrow")
    test_buffer_preserves_context_and_order()
    print("PASS | buffer_preserves_context_and_order")
    asyncio.run(test_provider_overlaps_safety_without_early_release())
    print("PASS | provider_overlaps_safety_without_early_release")
    asyncio.run(test_blocked_input_discards_speculative_output())
    print("PASS | blocked_input_discards_speculative_output")
    asyncio.run(test_ineligible_request_delegates_unchanged())
    print("PASS | ineligible_request_delegates_unchanged")
    print("Fast speculative input-safety validation passed.")


if __name__ == "__main__":
    main()
