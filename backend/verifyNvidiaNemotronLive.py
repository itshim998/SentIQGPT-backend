"""Low-cost, redacted live verification for the NVIDIA Nemotron key pool.

This script prints safe slot identifiers and aggregate counts only. It never
prints credentials, prompts, visible response text, hidden reasoning, headers,
or raw provider responses.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv

from nvidia_nemotron import (
    NvidiaNemotronProvider,
    NvidiaProviderError,
)


ROOT = Path(__file__).resolve().parents[1]
MINIMAL_PROMPT = "Reply with the single word OK."
MAX_INDEPENDENT_ATTEMPTS = 3
RETRYABLE_INDEPENDENT_CATEGORIES = frozenset({
    "empty_stream",
    "rate_limit",
    "transient",
})


def safe_result(slot_id: str, text: str, usage) -> dict[str, object]:
    normalized = text.lower()
    reasoning_marker_visible = (
        "reasoning_content" in normalized
        or "<think>" in normalized
        or "</think>" in normalized
    )
    return {
        "slot_id": slot_id,
        "status": "pass" if text.strip() and not reasoning_marker_visible else "fail",
        "visible_chars": len(text),
        "reasoning_marker_visible": reasoning_marker_visible,
        "usage": {
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "total_tokens": usage.total_tokens,
            "hidden_reasoning_tokens": usage.hidden_reasoning_tokens,
            "source": usage.source,
        },
    }


def is_retryable_independent_error(error: BaseException) -> bool:
    return getattr(error, "category", "") in RETRYABLE_INDEPENDENT_CATEGORIES


def verify_independent_slot(
    provider_factory,
    slot_id: str,
    *,
    max_attempts: int = MAX_INDEPENDENT_ATTEMPTS,
    sleep=time.sleep,
) -> dict[str, object]:
    if max_attempts < 1:
        raise ValueError("max_attempts must be at least one.")

    retry_categories: list[str] = []
    for attempt in range(1, max_attempts + 1):
        try:
            provider = provider_factory()
            text, usage = provider.complete_on_slot(
                slot_id,
                MINIMAL_PROMPT,
                max_tokens=64,
                reasoning_budget=16,
            )
            result = safe_result(slot_id, text, usage)
            if result["status"] == "pass":
                return {
                    **result,
                    "attempts": attempt,
                    "retry_categories": retry_categories,
                }
            category = (
                "public_reasoning_marker"
                if result["reasoning_marker_visible"]
                else "empty_stream"
            )
            error = NvidiaProviderError(
                "Independent slot verification returned unsafe public output.",
                category=category,
            )
        except Exception as caught:
            error = caught

        category = str(getattr(error, "category", "internal"))
        status_code = getattr(error, "status_code", None)
        if attempt < max_attempts and is_retryable_independent_error(error):
            retry_categories.append(category)
            sleep(float(attempt))
            continue
        return {
            "slot_id": slot_id,
            "status": "fail",
            "category": category,
            "status_code": status_code,
            "attempts": attempt,
            "retry_categories": retry_categories,
        }

    raise AssertionError("Independent slot verification exhausted without a result.")


def main() -> int:
    load_dotenv(ROOT / ".env")
    source = dict(os.environ)
    source["SENTIQ_NVIDIA_PROVIDER_ENABLED"] = "true"
    provider = NvidiaNemotronProvider.from_env(environ=source)
    slot_ids = provider.pool.safe_slot_ids()
    print(json.dumps({"event": "configured_slots", "slot_ids": slot_ids}))
    if not slot_ids:
        print(json.dumps({"event": "configuration_error", "status": "no_usable_slots"}))
        return 2

    failures = 0
    for slot_id in slot_ids:
        result = verify_independent_slot(
            lambda: NvidiaNemotronProvider.from_env(environ=source),
            slot_id,
        )
        failures += int(result["status"] != "pass")
        print(json.dumps({"event": "independent_slot", **result}))

    pooled_provider = NvidiaNemotronProvider.from_env(environ=source)
    selected_slots: list[str] = []
    for _ in slot_ids:
        try:
            text, usage, selected_slot = pooled_provider.complete(
                MINIMAL_PROMPT,
                max_tokens=64,
                reasoning_budget=16,
            )
            selected_slots.append(selected_slot)
            result = safe_result(selected_slot, text, usage)
            failures += int(result["status"] != "pass")
            print(json.dumps({"event": "pooled_request", **result}))
        except Exception as error:
            failures += 1
            print(json.dumps({
                "event": "pooled_request",
                "status": "fail",
                "category": getattr(error, "category", "internal"),
                "status_code": getattr(error, "status_code", None),
            }))
    enabled_slots = {
        str(slot["slot_id"])
        for slot in pooled_provider.safe_diagnostics()["slots"]
        if slot["enabled"]
    }
    print(json.dumps({
        "event": "pooled_rotation",
        "selected_slot_ids": selected_slots,
        "covered_all_configured_slots": set(selected_slots) == set(slot_ids),
        "covered_all_enabled_slots": set(selected_slots) == enabled_slots,
    }))

    unavailable = pooled_provider.pool.acquire()
    if unavailable is not None:
        pooled_provider.pool.release_failure(
            unavailable,
            NvidiaProviderError("simulated transient test-harness failure", category="transient"),
        )
        try:
            text, usage, selected_slot = pooled_provider.complete(
                MINIMAL_PROMPT,
                max_tokens=64,
                reasoning_budget=16,
            )
            skipped = selected_slot != unavailable.slot_id
            failures += int(not skipped or not text.strip())
            print(json.dumps({
                "event": "unavailable_slot_skip",
                "unavailable_slot_id": unavailable.slot_id,
                "selected_slot_id": selected_slot,
                "status": "pass" if skipped and text.strip() else "fail",
                "usage_source": usage.source,
            }))
        except Exception as error:
            failures += 1
            print(json.dumps({
                "event": "unavailable_slot_skip",
                "unavailable_slot_id": unavailable.slot_id,
                "status": "fail",
                "category": getattr(error, "category", "internal"),
            }))

    cancellation_provider = NvidiaNemotronProvider.from_env(environ=source)
    stream = cancellation_provider.stream(
        MINIMAL_PROMPT,
        max_tokens=64,
        reasoning_budget=16,
    )
    cancellation_visible = False
    cancellation_error: Exception | None = None
    try:
        for item in stream:
            if isinstance(item, str) and item.strip():
                cancellation_visible = True
                break
    except Exception as error:
        cancellation_error = error
    finally:
        stream.close()
    in_flight_after_cancel = sum(
        int(slot["in_flight"])
        for slot in cancellation_provider.safe_diagnostics()["slots"]
    )
    cancellation_ok = cancellation_error is None and cancellation_visible and in_flight_after_cancel == 0
    failures += int(not cancellation_ok)
    print(json.dumps({
        "event": "cancellation",
        "status": "pass" if cancellation_ok else "fail",
        "visible_started": cancellation_visible,
        "in_flight_after_cancel": in_flight_after_cancel,
        "category": getattr(cancellation_error, "category", None),
    }))

    print(json.dumps({"event": "summary", "failures": failures}))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
