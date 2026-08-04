# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS node-deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci


FROM node-deps AS node-build

COPY tsconfig.json tsconfig.backend.json ./
COPY task_registry.json ./
COPY backend ./backend
RUN npm run build


FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=3001 \
    LLM_SERVICE_PORT=3002 \
    LLM_SERVICE_HOST=127.0.0.1 \
    LLM_SERVICE_URL=http://127.0.0.1:3002 \
    SENTIQ_CACHE_FILE=/tmp/sentiq_cache.db \
    SENTIQ_FAST_PARALLEL_INPUT_SAFETY_ENABLED=true \
    SENTIQ_FAST_PARALLEL_INPUT_SAFETY_FORCE_DISABLED=false \
    SENTIQ_FAST_SPECULATIVE_BUFFER_ITEMS=512 \
    MPLCONFIGDIR=/tmp/matplotlib \
    XDG_CACHE_HOME=/tmp/.cache

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      python3 \
      python3-venv \
      tini \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

ENV PATH="/opt/venv/bin:${PATH}"

COPY --from=node-build /app/dist ./dist
COPY backend/llm_service.py \
     backend/nvidia_nemotron.py \
     backend/verifyNvidiaNemotronLive.py \
     backend/verifyPollinationsIntuitiveLive.py \
     backend/run_llm_service.py \
     backend/fast_speculative_input_safety.py \
     backend/fast_latency_observability.py \
     backend/fast_latency_httpx_stream.py \
     ./backend/
COPY backend/observability/fast-latency-preload.cjs ./backend/observability/
COPY llm_adapter.py task_registry.json ./
COPY scripts/start-container.sh scripts/start-container-validated.sh ./scripts/

RUN chmod +x ./scripts/start-container.sh ./scripts/start-container-validated.sh \
    && mkdir -p /tmp/matplotlib /tmp/.cache \
    && chown -R node:node /tmp/matplotlib /tmp/.cache

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3001') + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./scripts/start-container-validated.sh"]
