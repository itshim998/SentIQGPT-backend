"""
SentIQGPT v1 — LLM Gateway (FastAPI Service)

Persistent HTTP service wrapping the dual-model llm_adapter.
Eliminates process startup overhead.

Endpoints:
  POST /llm/invoke  — Invoke LLM with task + prompt (auto-routes to Gemini or Groq)
  GET  /llm/health  — Health check
"""

import os
import sys
import json
import logging

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional
import uvicorn

# --- Environment ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(BASE_DIR)

from dotenv import load_dotenv
load_dotenv(os.path.join(PARENT_DIR, ".env"))

# Import the unified router from the parent-level llm_adapter
sys.path.insert(0, PARENT_DIR)
from llm_adapter import (
    call_llm_router,
    stream_llm_router,
    get_provider_for_task,
    GEMINI_API_KEYS,
    GROQ_API_KEYS,
    GEMINI_MODEL,
    GROQ_MODEL,
    STRICT_JSON_TASKS,
)

# --- Logger ---
logger = logging.getLogger("sentiqgpt.llm_service")
if not logger.handlers:
    h = logging.StreamHandler()
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(h)
logger.setLevel(logging.INFO)

LLM_SERVICE_PORT = int(os.getenv("LLM_SERVICE_PORT", "3002"))

# ============================
# FastAPI Application
# ============================

app = FastAPI(title="SentIQGPT LLM Service", version="1.0.0")


class LLMInvokeRequest(BaseModel):
    prompt: str
    task: str = "general"
    use_simulation: bool = False
    prefer: Optional[str] = None
    model_override: Optional[str] = None
    user_id: Optional[str] = None


class LLMInvokeResponse(BaseModel):
    result: str
    provider: str
    cached: bool = False


class EmbedRequest(BaseModel):
    text: str


@app.get("/llm/health")
async def health_check():
    return {
        "status": "ok",
        "system": "SentIQGPT",
        "gemini_keys_configured": len(GEMINI_API_KEYS),
        "groq_keys_configured": len(GROQ_API_KEYS),
        "gemini_model": GEMINI_MODEL,
        "groq_model": GROQ_MODEL,
        "strict_json_tasks": len(STRICT_JSON_TASKS),
    }


@app.post("/llm/invoke", response_model=LLMInvokeResponse)
async def invoke_llm(request: LLMInvokeRequest):
    try:
        result = call_llm_router(
            prompt=request.prompt,
            task=request.task,
            use_simulation=request.use_simulation,
            prefer=request.prefer,
            model_override=request.model_override,
            user_id=request.user_id,
        )
        # Resolve the actual provider (not just the prefer hint)
        from llm_adapter import resolve_model_override, get_provider_for_task
        default_prov = request.prefer or get_provider_for_task(request.task)
        resolved_prov, _ = resolve_model_override(request.model_override, default_prov)
        return LLMInvokeResponse(result=result, provider=resolved_prov)
    except Exception as e:
        logger.error("LLM invocation failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/llm/stream")
async def stream_llm(request: LLMInvokeRequest):
    """SSE streaming endpoint — streams Gemini responses as text/event-stream."""
    def event_generator():
        try:
            for chunk in stream_llm_router(
                prompt=request.prompt,
                task=request.task,
                model_override=request.model_override,
            ):
                # SSE format: data: <text>\n\n
                yield f"data: {json.dumps({'text': chunk})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.error("Streaming failed: %s", e)
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ============================
# Embedding endpoint
# ============================

EMBEDDING_MODEL = os.getenv("GEMINI_EMBEDDING_MODEL", "text-embedding-004")

import threading
_embed_lock = threading.Lock()

def _generate_embedding(text: str, api_key: str) -> list:
    """Generate a vector embedding using the Gemini embedding API."""
    import google.generativeai as genai
    with _embed_lock:
        genai.configure(api_key=api_key)
    result = genai.embed_content(
        model=f"models/{EMBEDDING_MODEL}",
        content=text,
        task_type="retrieval_document",
    )
    return result["embedding"]


@app.post("/llm/embed")
async def embed_text(request: EmbedRequest):
    """Generate a vector embedding for the given text using Gemini."""
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="text must be non-empty")
    if not GEMINI_API_KEYS:
        raise HTTPException(status_code=503, detail="No Gemini API keys configured")

    last_error = None
    for idx, api_key in enumerate(GEMINI_API_KEYS, 1):
        try:
            embedding = _generate_embedding(request.text, api_key)
            logger.info("Embedding generated via Gemini key #%d (%d dims)", idx, len(embedding))
            return {"embedding": embedding}
        except Exception as e:
            last_error = e
            logger.warning("Embedding key #%d failed: %s", idx, e)

    logger.error("All Gemini keys failed for embedding: %s", last_error)
    raise HTTPException(status_code=500, detail=str(last_error))


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=LLM_SERVICE_PORT, log_level="info")
