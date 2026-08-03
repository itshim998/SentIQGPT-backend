"""Start the existing FastAPI LLM service with latency attribution installed."""

from __future__ import annotations

import os
import runpy

import fast_latency_httpx_stream
from fast_latency_observability import install


def main() -> None:
    install()
    # Groq-style generated SDKs consume httpx byte streams rather than
    # Response.iter_lines(), so install the byte-stream observer after the base
    # hooks while retaining the original iterators captured at import time.
    fast_latency_httpx_stream.install()
    service_path = os.path.join(os.path.dirname(__file__), "llm_service.py")
    runpy.run_path(service_path, run_name="__main__")


if __name__ == "__main__":
    main()
