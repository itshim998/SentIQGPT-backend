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
COPY backend/llm_service.py ./backend/llm_service.py
COPY llm_adapter.py task_registry.json ./
COPY scripts/start-container.sh ./scripts/start-container.sh

RUN chmod +x ./scripts/start-container.sh \
    && mkdir -p /tmp/matplotlib /tmp/.cache \
    && chown -R node:node /tmp/matplotlib /tmp/.cache

USER node

# Only the Node API is ingress-facing. The Python gateway binds to loopback.
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3001') + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./scripts/start-container.sh"]
