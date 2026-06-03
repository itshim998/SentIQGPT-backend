#!/usr/bin/env bash
set -Eeuo pipefail

export PORT="${PORT:-3001}"
export LLM_SERVICE_PORT="${LLM_SERVICE_PORT:-3002}"
export LLM_SERVICE_HOST="${LLM_SERVICE_HOST:-127.0.0.1}"
export LLM_SERVICE_URL="${LLM_SERVICE_URL:-http://127.0.0.1:${LLM_SERVICE_PORT}}"

if [[ "${NODE_ENV:-}" == "production" ]]; then
  if [[ -z "${SENTIQ_INTERNAL_SERVICE_TOKEN:-}" ]]; then
    echo "[startup] SENTIQ_INTERNAL_SERVICE_TOKEN is required in production"
    exit 1
  fi
  if [[ "${SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS:-false}" == "true" ]]; then
    echo "[startup] unsafe internal endpoints cannot be enabled in production"
    exit 1
  fi
  if [[ "${LLM_SERVICE_HOST}" != "127.0.0.1" ]]; then
    echo "[startup] LLM_SERVICE_HOST must remain bound to 127.0.0.1 in production"
    exit 1
  fi
  if [[ "${LLM_SERVICE_URL%/}" != "http://127.0.0.1:${LLM_SERVICE_PORT}" ]]; then
    echo "[startup] LLM_SERVICE_URL must remain on the internal loopback service in production"
    exit 1
  fi
fi

python_pid=""
node_pid=""

terminate() {
  trap - SIGTERM SIGINT
  echo "[startup] stopping services"
  if [[ -n "${node_pid}" ]]; then
    kill -TERM "${node_pid}" 2>/dev/null || true
  fi
  if [[ -n "${python_pid}" ]]; then
    kill -TERM "${python_pid}" 2>/dev/null || true
  fi
  if [[ -n "${node_pid}" ]]; then
    wait "${node_pid}" 2>/dev/null || true
  fi
  if [[ -n "${python_pid}" ]]; then
    wait "${python_pid}" 2>/dev/null || true
  fi
}

check_llm_health() {
  python - "${LLM_SERVICE_URL%/}/llm/health" <<'PY'
import sys
from urllib.request import urlopen

try:
    with urlopen(sys.argv[1], timeout=2) as response:
        sys.exit(0 if 200 <= response.status < 400 else 1)
except Exception:
    sys.exit(1)
PY
}

trap 'terminate; exit 143' SIGTERM SIGINT

echo "[startup] starting Python LLM service on ${LLM_SERVICE_HOST}:${LLM_SERVICE_PORT}"
python backend/llm_service.py &
python_pid="$!"

max_attempts="${LLM_SERVICE_STARTUP_ATTEMPTS:-60}"
attempt=1
until check_llm_health; do
  if ! kill -0 "${python_pid}" 2>/dev/null; then
    echo "[startup] Python LLM service exited before becoming healthy"
    wait "${python_pid}"
    exit "$?"
  fi

  if [[ "${attempt}" -ge "${max_attempts}" ]]; then
    echo "[startup] Python LLM service did not become healthy after ${max_attempts}s"
    terminate
    exit 1
  fi

  sleep 1
  attempt=$((attempt + 1))
done

echo "[startup] Python LLM service is healthy"
echo "[startup] starting Node API on port ${PORT}"
node dist/backend/server.js &
node_pid="$!"

set +e
wait -n "${python_pid}" "${node_pid}"
exit_status="$?"
set -e

echo "[startup] one service exited with status ${exit_status}; shutting down container"
terminate
exit "${exit_status}"
