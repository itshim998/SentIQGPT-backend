#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/scripts/start-container.sh"

fail() {
  echo "FAIL | $1" >&2
  exit 1
}

run_real_startup_smoke() {
  local log_file
  local supervisor_pid
  local complete=0
  log_file="$(mktemp)"

  NODE_ENV=development "${ROOT_DIR}/scripts/start-container.sh" > "${log_file}" 2>&1 &
  supervisor_pid="$!"

  for ((attempt = 1; attempt <= 75; attempt += 1)); do
    if grep -q "\[Startup\] python.health.ready" "${log_file}" \
      && grep -q "\[Boot\] summary .*ready=true" "${log_file}"; then
      complete=1
      break
    fi
    if ! kill -0 "${supervisor_pid}" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  local health_status="000"
  local ready_status="000"
  if [[ "${complete}" -eq 1 ]]; then
    health_status="$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3001/health || true)"
    ready_status="$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3001/ready || true)"
    if [[ "${health_status}" != "200" || "${ready_status}" != "200" ]]; then
      complete=0
    fi
  fi

  kill -TERM "${supervisor_pid}" 2>/dev/null || true
  wait "${supervisor_pid}" 2>/dev/null || true
  local report
  report="$(grep -E "^\[Startup\]|^\[Boot\].*(verifyShardMigrations|express.listen.ready|summary)" "${log_file}" || true)"
  report="${report}"$'\n'"[Smoke] probes health=${health_status} ready=${ready_status}"
  printf '%s\n' "${report}"
  if [[ -n "${SENTIQ_SMOKE_REPORT_FILE:-}" ]]; then
    printf '%s\n' "${report}" > "${SENTIQ_SMOKE_REPORT_FILE}"
  fi
  rm -f "${log_file}"
  [[ "${complete}" -eq 1 ]]
}

if [[ "${1:-}" == "--smoke" ]]; then
  run_real_startup_smoke
  exit "$?"
fi

python_health_failures=0
for _ in 1 2 3 4 5; do
  record_python_health_result "false" 6 || fail "transient Python health failures tripped the watchdog early"
done
record_python_health_result "true" 6 || fail "Python health recovery should reset the watchdog"
[[ "${python_health_failures}" -eq 0 ]] || fail "Python health recovery did not reset the failure count"
record_python_health_result "false" 6 || fail "one post-recovery failure should be tolerated"
[[ "${python_health_failures}" -eq 1 ]] || fail "post-recovery failure count is incorrect"

python_health_failures=0
for _ in 1 2 3 4 5; do
  record_python_health_result "false" 6 || fail "watchdog failed before six consecutive failures"
done
if record_python_health_result "false" 6; then
  fail "watchdog did not fail on the sixth consecutive health failure"
fi
echo "PASS | Python watchdog tolerates transient failures and fails on six consecutive failures"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

start_python_process() {
  startup_now_ms > "${tmp_dir}/python-started"
  sleep 5 &
  python_pid="$!"
}

start_node_process() {
  startup_now_ms > "${tmp_dir}/node-started"
  sleep 5 &
  node_pid="$!"
}

check_llm_health() {
  return 0
}

start_python_health_watchdog() {
  sleep 0.2 &
  watchdog_pid="$!"
}

set +e
(main) > "${tmp_dir}/parallel.log" 2>&1
parallel_status="$?"
set -e
[[ "${parallel_status}" -ne 0 ]] || fail "synthetic supervisor exit should be nonzero"
python_started="$(<"${tmp_dir}/python-started")"
node_started="$(<"${tmp_dir}/node-started")"
start_delta=$((node_started - python_started))
[[ "${start_delta}" -ge 0 && "${start_delta}" -lt 250 ]] || fail "Python and Node start delta was ${start_delta}ms"
echo "PASS | Python and Node synthetic start delta=${start_delta}ms"

health_calls=0
check_llm_health() {
  health_calls=$((health_calls + 1))
  [[ "${health_calls}" -eq 1 ]]
}

start_python_health_watchdog() {
  monitor_python_health 0 6 &
  watchdog_pid="$!"
}

set +e
(main) > "${tmp_dir}/sustained.log" 2>&1
sustained_status="$?"
set -e
[[ "${sustained_status}" -ne 0 ]] || fail "sustained Python health failure should fail the supervisor"
grep -q "\[Startup\] python.health.sustained.failed" "${tmp_dir}/sustained.log" \
  || fail "sustained Python health failure log label was missing"
echo "PASS | live but unhealthy Python eventually fails the container supervisor"
