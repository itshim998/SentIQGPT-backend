import io
import json
import logging
import unittest
from types import SimpleNamespace

from nvidia_nemotron import (
    NvidiaAllKeysUnavailableError,
    NvidiaConfigurationError,
    NvidiaKeyPool,
    NvidiaKeyRecord,
    NvidiaNemotronProvider,
    NvidiaPoolSettings,
    NvidiaProviderError,
    NvidiaProviderSettings,
    discover_nvidia_key_records,
)
from verifyNvidiaNemotronLive import (
    safe_result,
    verify_independent_slot,
)


def frame(payload):
    return f"data: {json.dumps(payload)}"


class FakeResponse:
    def __init__(self, lines=(), status_code=200, headers=None):
        self._lines = list(lines)
        self.status_code = status_code
        self.headers = headers or {}
        self.closed = False

    def iter_lines(self, decode_unicode=True):
        del decode_unicode
        for line in self._lines:
            if isinstance(line, BaseException):
                raise line
            yield line

    def close(self):
        self.closed = True


class RequestSequence:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, url, **kwargs):
        self.calls.append(
            {
                "url": url,
                "model": kwargs["json"]["model"],
                "max_tokens": kwargs["json"]["max_tokens"],
                "reasoning_budget": kwargs["json"]["reasoning_budget"],
            }
        )
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


def records(count=2):
    return [
        NvidiaKeyRecord(index=index, env_name=f"NVIDIA_API_KEY_{index}", key=f"secret-value-{index}")
        for index in range(1, count + 1)
    ]


def provider_with(responses, count=2, now=None):
    request = RequestSequence(responses)
    pool = NvidiaKeyPool(
        records(count),
        settings=NvidiaPoolSettings(
            transient_cooldown_ms=1_000,
            rate_limit_cooldown_ms=3_000,
            auth_failure_cooldown_ms=10_000,
        ),
        now_ms=now,
    )
    provider = NvidiaNemotronProvider(
        NvidiaProviderSettings(enabled=True),
        pool,
        request=request,
    )
    return provider, request


def visible_response(text="Visible answer.", *, reasoning=None, usage=True):
    lines = []
    if reasoning is not None:
        lines.append(frame({"choices": [{"delta": {"reasoning_content": reasoning}}]}))
    lines.extend(
        [
            frame({"choices": []}),
            frame({"metadata": {"terminal": False}}),
            frame({"choices": [{"delta": {"content": text}}]}),
        ]
    )
    if usage:
        lines.append(
            frame(
                {
                    "choices": [],
                    "usage": {
                        "prompt_tokens": 5,
                        "completion_tokens": 7,
                        "total_tokens": 12,
                    },
                }
            )
        )
    lines.append("data: [DONE]")
    return FakeResponse(lines)


class NvidiaNemotronProviderTests(unittest.TestCase):
    def test_live_verifier_retries_retryable_empty_stream_on_fresh_provider(self):
        usage = SimpleNamespace(
            input_tokens=1,
            output_tokens=1,
            total_tokens=2,
            hidden_reasoning_tokens=0,
            source="reported",
        )
        outcomes = [
            NvidiaProviderError("empty", category="empty_stream"),
            ("OK", usage),
        ]
        factory_calls = []
        sleeps = []

        class VerificationProvider:
            def __init__(self, outcome):
                self.outcome = outcome

            def complete_on_slot(self, *_args, **_kwargs):
                if isinstance(self.outcome, BaseException):
                    raise self.outcome
                return self.outcome

        def factory():
            factory_calls.append(True)
            return VerificationProvider(outcomes.pop(0))

        result = verify_independent_slot(factory, "nvidia-slot-4", sleep=sleeps.append)
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(result["retry_categories"], ["empty_stream"])
        self.assertEqual(len(factory_calls), 2)
        self.assertEqual(sleeps, [1.0])

    def test_live_verifier_does_not_retry_authentication_failure(self):
        sleeps = []

        class AuthenticationFailureProvider:
            def complete_on_slot(self, *_args, **_kwargs):
                raise NvidiaProviderError("rejected", category="auth", status_code=401)

        result = verify_independent_slot(
            AuthenticationFailureProvider,
            "nvidia-slot-1",
            sleep=sleeps.append,
        )
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["category"], "auth")
        self.assertEqual(result["attempts"], 1)
        self.assertEqual(sleeps, [])

    def test_live_verifier_rejects_public_reasoning_markers(self):
        usage = SimpleNamespace(
            input_tokens=1,
            output_tokens=1,
            total_tokens=2,
            hidden_reasoning_tokens=0,
            source="reported",
        )
        result = safe_result("nvidia-slot-1", "<think>hidden</think> OK", usage)
        self.assertEqual(result["status"], "fail")
        self.assertTrue(result["reasoning_marker_visible"])

    def test_arbitrary_indexed_key_discovery(self):
        environment = {
            **{f"NVIDIA_API_KEY_{index}": f"key-{index}" for index in range(1, 7)},
            "NVIDIA_API_KEY_8": "key-8",
            "NVIDIA_API_KEY_11": "key-11",
        }
        found = discover_nvidia_key_records(environment)
        self.assertEqual([record.index for record in found], [1, 2, 3, 4, 5, 6, 8, 11])
        self.assertEqual([record.slot_id for record in found][-2:], ["nvidia-slot-8", "nvidia-slot-11"])

    def test_six_unique_key_slots(self):
        found = discover_nvidia_key_records(
            {f"NVIDIA_API_KEY_{index}": f"unique-key-{index}" for index in range(1, 7)}
        )
        self.assertEqual(
            [record.slot_id for record in found],
            [f"nvidia-slot-{index}" for index in range(1, 7)],
        )

    def test_missing_blank_and_duplicate_indexes(self):
        found = discover_nvidia_key_records(
            {
                "NVIDIA_API_KEY_1": "same-secret",
                "NVIDIA_API_KEY_2": "  ",
                "NVIDIA_API_KEY_4": "same-secret",
                "NVIDIA_API_KEY_7": "different-secret",
                "NVIDIA_API_KEY_0": "ignored",
                "NVIDIA_API_KEY_X": "ignored",
            }
        )
        self.assertEqual([record.slot_id for record in found], ["nvidia-slot-1", "nvidia-slot-7"])

    def test_dormant_when_disabled_and_clear_error_without_keys(self):
        disabled = NvidiaNemotronProvider.from_env(
            environ={
                "SENTIQ_NVIDIA_PROVIDER_ENABLED": "false",
                "NVIDIA_API_KEY_1": "must-not-load",
            }
        )
        self.assertFalse(disabled.safe_diagnostics()["enabled"])
        self.assertEqual(disabled.safe_diagnostics()["configured_slots"], [])

        enabled = NvidiaNemotronProvider.from_env(
            environ={"SENTIQ_NVIDIA_PROVIDER_ENABLED": "true"}
        )
        with self.assertRaisesRegex(NvidiaConfigurationError, "no usable indexed key slots"):
            enabled.complete("prompt", max_tokens=20, reasoning_budget=5)

    def test_diagnostics_and_logs_never_contain_key_material(self):
        provider, _ = provider_with([visible_response()], count=1)
        capture = io.StringIO()
        handler = logging.StreamHandler(capture)
        logger = logging.getLogger("sentiq_chat.nvidia")
        logger.addHandler(handler)
        old_level = logger.level
        logger.setLevel(logging.INFO)
        try:
            text, _, slot_id = provider.complete("prompt", max_tokens=20, reasoning_budget=5)
            self.assertEqual(text, "Visible answer.")
            self.assertEqual(slot_id, "nvidia-slot-1")
            serialized = json.dumps(provider.safe_diagnostics()) + capture.getvalue()
            self.assertNotIn("secret-value", serialized)
            self.assertNotIn("NVIDIA_API_KEY", serialized)
            self.assertIn("nvidia-slot-1", serialized)
        finally:
            logger.removeHandler(handler)
            logger.setLevel(old_level)

    def test_fair_rotation_and_concurrent_least_in_flight(self):
        pool = NvidiaKeyPool(records(3))
        first = pool.acquire()
        second = pool.acquire()
        third = pool.acquire()
        self.assertEqual(
            [first.slot_id, second.slot_id, third.slot_id],
            ["nvidia-slot-1", "nvidia-slot-2", "nvidia-slot-3"],
        )
        self.assertEqual([item["in_flight"] for item in pool.diagnostics()], [1, 1, 1])
        pool.release_cancelled(first)
        fourth = pool.acquire()
        self.assertEqual(fourth.slot_id, "nvidia-slot-1")

    def test_cooldown_skip_and_recovery(self):
        clock = [1_000]
        pool = NvidiaKeyPool(
            records(2),
            settings=NvidiaPoolSettings(
                transient_cooldown_ms=500,
                rate_limit_cooldown_ms=1_000,
                auth_failure_cooldown_ms=2_000,
            ),
            now_ms=lambda: clock[0],
        )
        first = pool.acquire()
        pool.release_failure(first, NvidiaProviderError("network", category="transient"))
        self.assertEqual(pool.acquire().slot_id, "nvidia-slot-2")
        clock[0] = 1_501
        recovered = pool.acquire({"nvidia-slot-2"})
        self.assertEqual(recovered.slot_id, "nvidia-slot-1")

    def test_429_retry_after_and_invalid_credentials(self):
        clock = [5_000]
        pool = NvidiaKeyPool(
            records(2),
            settings=NvidiaPoolSettings(
                transient_cooldown_ms=500,
                rate_limit_cooldown_ms=1_000,
                auth_failure_cooldown_ms=2_000,
            ),
            now_ms=lambda: clock[0],
        )
        limited = pool.acquire()
        pool.release_failure(
            limited,
            NvidiaProviderError(
                "limited",
                category="rate_limit",
                status_code=429,
                retry_after_ms=4_000,
            ),
        )
        limited_state = pool.diagnostics()[0]
        self.assertEqual(limited_state["cooldown_until_ms"], 9_000)
        self.assertEqual(limited_state["last_429_ms"], 5_000)

        invalid = pool.acquire()
        pool.release_failure(
            invalid,
            NvidiaProviderError("auth", category="auth", status_code=401),
        )
        invalid_state = pool.diagnostics()[1]
        self.assertFalse(invalid_state["enabled"])

    def test_reasoning_is_hidden_and_reported_usage_is_forwarded(self):
        provider, request = provider_with(
            [visible_response("Public text.", reasoning="private internal reasoning")],
            count=1,
        )
        events = list(provider.stream("prompt", max_tokens=6_000, reasoning_budget=2_000))
        self.assertEqual([event for event in events if isinstance(event, str)], ["Public text."])
        usage_event = events[-1]
        self.assertEqual(usage_event["kind"], "provider_usage")
        self.assertGreater(usage_event["usage"]["hidden_reasoning_tokens"], 0)
        self.assertGreaterEqual(
            usage_event["usage"]["output_tokens"],
            usage_event["usage"]["hidden_reasoning_tokens"],
        )
        self.assertEqual(
            usage_event["usage"]["total_tokens"],
            usage_event["usage"]["input_tokens"] + usage_event["usage"]["output_tokens"],
        )
        self.assertNotIn("private internal reasoning", json.dumps(events))
        self.assertEqual(request.calls[0]["max_tokens"], 6_000)
        self.assertEqual(request.calls[0]["reasoning_budget"], 2_000)

    def test_estimated_usage_includes_hidden_reasoning(self):
        response = visible_response("short", reasoning="reasoning " * 20, usage=False)
        provider, _ = provider_with([response], count=1)
        _, usage, _ = provider.complete("input prompt", max_tokens=100, reasoning_budget=50)
        self.assertEqual(usage.source, "estimated")
        self.assertGreater(usage.output_tokens, usage.hidden_reasoning_tokens)
        self.assertEqual(usage.total_tokens, usage.input_tokens + usage.output_tokens)

    def test_safe_fallback_before_visible_content(self):
        failed_before_visible = FakeResponse(
            [
                frame({"choices": [{"delta": {"reasoning_content": "discard me"}}]}),
                RuntimeError("connection lost"),
            ]
        )
        provider, request = provider_with(
            [failed_before_visible, visible_response("second slot")],
            count=2,
        )
        text, _, slot_id = provider.complete("prompt", max_tokens=100, reasoning_budget=20)
        self.assertEqual(text, "second slot")
        self.assertEqual(slot_id, "nvidia-slot-2")
        self.assertEqual(len(request.calls), 2)

    def test_no_fallback_after_visible_content(self):
        partial = FakeResponse(
            [
                frame({"choices": [{"delta": {"content": "partial"}}]}),
                RuntimeError("connection lost"),
            ]
        )
        provider, request = provider_with([partial, visible_response("duplicate")], count=2)
        with self.assertRaises(NvidiaProviderError):
            list(provider.stream("prompt", max_tokens=100, reasoning_budget=20))
        self.assertEqual(len(request.calls), 1)

    def test_429_auth_5xx_timeout_empty_and_malformed_failures(self):
        failures = [
            FakeResponse(status_code=429, headers={"Retry-After": "7"}),
            FakeResponse(status_code=401),
            FakeResponse(status_code=503),
            TimeoutError("timeout"),
            FakeResponse(["data: [DONE]"]),
            FakeResponse(["data: not-json"]),
        ]
        for response in failures:
            with self.subTest(response=response):
                provider, _ = provider_with([response], count=1)
                with self.assertRaises((NvidiaProviderError, NvidiaAllKeysUnavailableError)):
                    list(provider.stream("prompt", max_tokens=50, reasoning_budget=10))
                state = provider.safe_diagnostics()["slots"][0]
                self.assertEqual(state["in_flight"], 0)
                self.assertGreaterEqual(state["consecutive_failures"], 1)

    def test_cancellation_during_visible_output_releases_resources(self):
        response = visible_response("visible")
        provider, _ = provider_with([response], count=1)
        stream = provider.stream("prompt", max_tokens=50, reasoning_budget=10)
        self.assertEqual(next(stream), "visible")
        stream.close()
        self.assertTrue(response.closed)
        self.assertEqual(provider.safe_diagnostics()["slots"][0]["in_flight"], 0)

    def test_cancellation_during_hidden_reasoning_releases_resources(self):
        response = FakeResponse(
            [
                frame({"choices": [{"delta": {"reasoning_content": "hidden"}}]}),
                GeneratorExit(),
            ]
        )
        provider, _ = provider_with([response], count=1)
        stream = provider.stream("prompt", max_tokens=50, reasoning_budget=10)
        with self.assertRaises(GeneratorExit):
            next(stream)
        self.assertTrue(response.closed)
        self.assertEqual(provider.safe_diagnostics()["slots"][0]["in_flight"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
