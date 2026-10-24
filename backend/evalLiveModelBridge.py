"""
SentIQ Chat - Live Model Bridge for Natural Voice Evaluation
Invoked strictly by evalLiveNaturalVoice.ts when SENTIQ_NATURAL_VOICE_LIVE_EVAL=1.
Never invoked in CI or automated builds.
"""
import sys
import json
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from dotenv import load_dotenv
load_dotenv(PROJECT_ROOT / ".env")

from llm_adapter import call_llm_router


def main():
    if os.environ.get("SENTIQ_NATURAL_VOICE_LIVE_EVAL") != "1":
        sys.stderr.write("Live evaluation blocked: SENTIQ_NATURAL_VOICE_LIVE_EVAL=1 required.\n")
        sys.exit(1)

    raw_input = sys.stdin.read()
    if not raw_input:
        sys.stderr.write("Empty input payload.\n")
        sys.exit(1)

    try:
        data = json.loads(raw_input)
    except Exception as parse_err:
        sys.stderr.write(f"Malformed JSON payload: {parse_err}\n")
        sys.exit(1)

    prompt = data.get("prompt", "")
    model_override = data.get("model_override", "gpt-oss-120b")

    try:
        result = call_llm_router(
            prompt=prompt,
            task="general",
            model_override=model_override,
        )
        text = result["text"].strip()
        if "[MODEL_USED]" in text:
            text = text.split("\n", 1)[-1].strip()

        sys.stdout.write(json.dumps({"text": text}))
    except Exception as exc:
        sys.stderr.write(f"Model call failed: {exc}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
