"""Redacted, single-request live verification for NVIDIA key slot 1.

This script reads the untracked local .env, sends one minimal request through
nvidia-slot-1 only, and prints safe status/usage metadata. It never prints the
credential, prompt, visible answer text, hidden reasoning, headers, or raw
provider responses.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from dotenv import load_dotenv

from nvidia_nemotron import NvidiaNemotronProvider


ROOT = Path(__file__).resolve().parents[1]
SLOT_ID = "nvidia-slot-1"
MINIMAL_PROMPT = "Reply with the single word OK."


def main() -> int:
    load_dotenv(ROOT / ".env")
    source = dict(os.environ)
    source["SENTIQ_NVIDIA_PROVIDER_ENABLED"] = "true"
    provider = NvidiaNemotronProvider.from_env(environ=source)

    if SLOT_ID not in provider.pool.safe_slot_ids():
        print(json.dumps({
            "event": "nvidia_slot_verification",
            "slot_id": SLOT_ID,
            "status": "fail",
            "category": "configuration",
            "status_code": None,
        }))
        return 2

    try:
        text, usage = provider.complete_on_slot(
            SLOT_ID,
            MINIMAL_PROMPT,
            max_tokens=64,
            reasoning_budget=16,
        )
        passed = bool(text.strip())
        print(json.dumps({
            "event": "nvidia_slot_verification",
            "slot_id": SLOT_ID,
            "status": "pass" if passed else "fail",
            "category": None if passed else "empty_response",
            "status_code": 200 if passed else None,
            "visible_chars": len(text),
            "reasoning_marker_visible": any(
                marker in text.lower()
                for marker in ("reasoning_content", "<think>", "</think>")
            ),
            "usage": {
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
                "total_tokens": usage.total_tokens,
                "hidden_reasoning_tokens": usage.hidden_reasoning_tokens,
                "source": usage.source,
            },
        }))
        return 0 if passed else 1
    except Exception as error:
        print(json.dumps({
            "event": "nvidia_slot_verification",
            "slot_id": SLOT_ID,
            "status": "fail",
            "category": getattr(error, "category", "internal"),
            "status_code": getattr(error, "status_code", None),
        }))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
