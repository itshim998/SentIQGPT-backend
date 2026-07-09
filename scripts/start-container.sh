#!/usr/bin/env bash
set -Eeuo pipefail

startup_now_ms() {
  local now
  now="$(date +%s%3N 2>/dev/null || true)"
  if [[ "${now}" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "${now}"
  else
    printf '%s000\n' "$(date +%s)"
  fi
}

startup_started_ms="$(startup_now_ms)"
startup_phase="script"
startup_error_logged="0"

startup_elapsed_ms() {
  local now
  now="$(startup_now_ms)"
  printf '%s\n' "$((now - startup_started_ms))"
}

startup_log() {
  echo "[Startup] ${1} elapsed=$(startup_elapsed_ms)ms"
}

startup_fail() {
  startup_error_logged="1"
  startup_log "${1}.failed"
}

startup_on_error() {
  local status="$?"
  if [[ "${startup_error_logged}" != "1" ]]; then
    startup_fail "${startup_phase}"
  fi
  exit "${status}"
}

trap 'startup_on_error' ERR
startup_log "script.begin"

export PORT="${PORT:-3001}"
export LLM_SERVICE_PORT="${LLM_SERVICE_PORT:-3002}"
export LLM_SERVICE_HOST="${LLM_SERVICE_HOST:-127.0.0.1}"
export LLM_SERVICE_URL="${LLM_SERVICE_URL:-http://127.0.0.1:${LLM_SERVICE_PORT}}"

if [[ "${NODE_ENV:-}" == "production" ]]; then
  if [[ -z "${SENTIQ_INTERNAL_SERVICE_TOKEN:-}" ]]; then
    startup_fail "production.internal-service-token"
    exit 1
  fi
  if [[ "${SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS:-false}" == "true" ]]; then
    startup_fail "production.internal-endpoints"
    exit 1
  fi
  if [[ "${LLM_SERVICE_HOST}" != "127.0.0.1" && "${LLM_SERVICE_HOST}" != "localhost" && "${LLM_SERVICE_HOST}" != "::1" ]]; then
    startup_fail "production.llm-host"
    exit 1
  fi
  if [[ "${LLM_SERVICE_URL}" != http://127.0.0.1:* && "${LLM_SERVICE_URL}" != http://localhost:* && "${LLM_SERVICE_URL}" != http://[::1]:* ]]; then
    startup_fail "production.llm-url"
    exit 1
  fi
fi

python_pid=""
node_pid=""

terminate() {
  trap - SIGTERM SIGINT
  startup_log "services.stopping"
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

startup_phase="python.process"
startup_log "python.process.starting"
python backend/llm_service.py &
python_pid="$!"

startup_phase="python.health"
startup_log "python.health.wait.begin"
max_attempts="${LLM_SERVICE_STARTUP_ATTEMPTS:-60}"
attempt=1
until check_llm_health; do
  if ! kill -0 "${python_pid}" 2>/dev/null; then
    startup_fail "python.health.process-exited"
    wait "${python_pid}"
    exit "$?"
  fi

  if [[ "${attempt}" -ge "${max_attempts}" ]]; then
    startup_fail "python.health.timeout"
    terminate
    exit 1
  fi

  sleep 1
  attempt=$((attempt + 1))
done

startup_log "python.health.ready"
startup_phase="node.process"
startup_log "node.process.starting"
node dist/backend/server.js &
node_pid="$!"

set +e
wait -n "${python_pid}" "${node_pid}"
exit_status="$?"
set -e

startup_log "runtime.service-exited"
terminate
exit "${exit_status}"
