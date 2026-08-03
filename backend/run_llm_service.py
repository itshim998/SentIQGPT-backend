"""Start the existing FastAPI LLM service with latency attribution installed."""

from __future__ import annotations

import os
import runpy

from fast_latency_observability import install


def main() -> None:
    install()
    service_path = os.path.join(os.path.dirname(__file__), "llm_service.py")
    runpy.run_path(service_path, run_name="__main__")


if __name__ == "__main__":
    main()
