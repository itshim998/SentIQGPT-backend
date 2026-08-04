"""Start the FastAPI LLM service with production observability and stream gates."""

from __future__ import annotations

import importlib

import uvicorn

import fast_latency_httpx_stream
from fast_latency_observability import install as install_fast_latency_observability
from fast_speculative_input_safety import install as install_fast_speculative_input_safety


def main() -> None:
    install_fast_latency_observability()
    # Groq-style generated SDKs consume httpx byte streams rather than
    # Response.iter_lines(), so install the byte-stream observer after the base
    # hooks while retaining the original iterators captured at import time.
    fast_latency_httpx_stream.install()

    service = importlib.import_module("llm_service")
    install_fast_speculative_input_safety(service)
    uvicorn.run(
        service.app,
        host=service.LLM_SERVICE_HOST,
        port=service.LLM_SERVICE_PORT,
        log_level="info",
    )


if __name__ == "__main__":
    main()
