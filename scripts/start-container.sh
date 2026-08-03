#!/usr/bin/env bash
set -Eeuo pipefail

PYTHON_HEALTH_INTERVAL_SECONDS=10
PYTHON_HEALTH_FAILURE_THRESHOLD=6

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
python_pid=""
node_pid=""
watchdog_pid=""
termination_started="0"
python_health_failures=0
child_exit_status=1

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

terminate() {
  if [[ "${termination_started}" == "1" ]]; then
    return
  fi
  termination_started="1"
  trap - SIGTERM SIGINT
  startup_log "services.stopping"

  if [[ -n "${watchdog_pid}" ]]; then
    kill -TERM "${watchdog_pid}" 2>/dev/null || true
  fi
  if [[ -n "${node_pid}" ]]; then
    kill -TERM "${node_pid}" 2>/dev/null || true
  fi
  if [[ -n "${python_pid}" ]]; then
    kill -TERM "${python_pid}" 2>/dev/null || true
  fi

  if [[ -n "${watchdog_pid}" ]]; then
    wait "${watchdog_pid}" 2>/dev/null || true
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

record_python_health_result() {
  local healthy="$1"
  local failure_threshold="$2"

  if [[ "${healthy}" == "true" ]]; then
    python_health_failures=0
    return 0
  fi

  python_health_failures=$((python_health_failures + 1))
  if [[ "${python_health_failures}" -ge "${failure_threshold}" ]]; then
    return 1
  fi
  return 0
}

monitor_python_health() {
  local interval_seconds="$1"
  local failure_threshold="$2"
  python_health_failures=0

  while true; do
    sleep "${interval_seconds}"
    if check_llm_health; then
      record_python_health_result "true" "${failure_threshold}"
      continue
    fi
    if ! record_python_health_result "false" "${failure_threshold}"; then
      startup_fail "python.health.sustained"
      return 1
    fi
  done
}

start_python_process() {
  python backend/run_llm_service.py &
  python_pid="$!"
}

start_node_process() {
  node dist/backend/server.js &
  node_pid="$!"
}

start_python_health_watchdog() {
  monitor_python_health "${PYTHON_HEALTH_INTERVAL_SECONDS}" "${PYTHON_HEALTH_FAILURE_THRESHOLD}" &
  watchdog_pid="$!"
}

reap_child() {
  local pid="$1"
  set +e
  wait "${pid}"
  child_exit_status="$?"
  set -e
  if [[ "${child_exit_status}" -eq 0 ]]; then
    child_exit_status=1
  fi
}

validate_runtime_configuration() {
  if [[ "${NODE_ENV:-}" != "production" ]]; then
    return
  fi
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
}

configure_fast_latency_observability() {
  local repo_root
  repo_root="$(pwd)"
  local node_preload="${repo_root}/backend/observability/fast-latency-preload.cjs"

  export SENTIQ_FAST_LATENCY_OBSERVABILITY_ENABLED="${SENTIQ_FAST_LATENCY_OBSERVABILITY_ENABLED:-true}"
  export SENTIQ_FAST_LATENCY_SAMPLE_RATE="${SENTIQ_FAST_LATENCY_SAMPLE_RATE:-1}"

  if [[ " ${NODE_OPTIONS:-} " != *" --require=${node_preload} "* ]]; then
    export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--require=${node_preload}"
  fi
}

main() {
  startup_started_ms="$(startup_now_ms)"
  startup_phase="script"
  startup_error_logged="0"
  termination_started="0"

  trap 'startup_on_error' ERR
  trap 'terminate; exit 143' SIGTERM SIGINT
  startup_log "script.begin"

  export PORT="${PORT:-3001}"
  export LLM_SERVICE_PORT="${LLM_SERVICE_PORT:-3002}"
  export LLM_SERVICE_HOST="${LLM_SERVICE_HOST:-127.0.0.1}"
  export LLM_SERVICE_URL="${LLM_SERVICE_URL:-http://127.0.0.1:${LLM_SERVICE_PORT}}"
  configure_fast_latency_observability
  validate_runtime_configuration

  startup_phase="python.process"
  startup_log "python.process.starting"
  start_python_process

  startup_phase="node.process"
  startup_log "node.process.starting"
  start_node_process

  startup_phase="python.health"
  startup_log "python.health.wait.begin"
  local max_attempts="${LLM_SERVICE_STARTUP_ATTEMPTS:-60}"
  local attempt=1
  if ! [[ "${max_attempts}" =~ ^[1-9][0-9]*$ ]]; then
    startup_fail "python.health.config"
    terminate
    exit 1
  fi

  until check_llm_health; do
    if ! kill -0 "${python_pid}" 2>/dev/null; then
      startup_fail "python.health.process-exited"
      reap_child "${python_pid}"
      terminate
      exit "${child_exit_status}"
    fi
    if ! kill -0 "${node_pid}" 2>/dev/null; then
      startup_fail "node.process.exited"
      reap_child "${node_pid}"
      terminate
      exit "${child_exit_status}"
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
  startup_phase="runtime"
  start_python_health_watchdog

  set +e
  wait -n "${python_pid}" "${node_pid}" "${watchdog_pid}"
  local exit_status="$?"
  set -e
  if [[ "${exit_status}" -eq 0 ]]; then
    exit_status=1
  fi

  if ! kill -0 "${watchdog_pid}" 2>/dev/null; then
    startup_error_logged="1"
  elif ! kill -0 "${python_pid}" 2>/dev/null; then
    startup_fail "python.process.exited"
  elif ! kill -0 "${node_pid}" 2>/dev/null; then
    startup_fail "node.process.exited"
  else
    startup_fail "runtime.service-exited"
  fi

  terminate
  exit "${exit_status}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
