#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "Azure Container App exec arguments are required." >&2
  exit 64
fi

if ! command -v script >/dev/null 2>&1; then
  echo "The util-linux script command is required for non-interactive Azure exec." >&2
  exit 69
fi

# Azure CLI's Container Apps exec implementation unconditionally configures
# stdin as a TTY after a successful command. GitHub-hosted runners have no TTY,
# so the CLI otherwise reports `(25, Inappropriate ioctl for device)` and exits
# non-zero after the remote command already succeeded. Build a shell-escaped
# argv string and run it in an isolated pseudo-terminal. `--return` preserves
# the actual Azure CLI exit status.
#
# The Container Apps exec control plane also enforces a low WebSocket-session
# rate limit. The full rollout previously opened four sessions in quick
# succession (runtime, readiness, NVIDIA, Pollinations); Azure accepted the
# NVIDIA verifier and rejected the adjacent Pollinations verifier with HTTP 429
# and Retry-After: 600. To avoid treating that control-plane throttle as an
# application failure, the two provider verifiers are executed in one remote
# session. The Pollinations result is cached only on the current runner and is
# replayed for the immediately following legacy workflow invocation.

args=("$@")
command_index=-1
command_value=""
app_name=""
resource_group=""
revision=""
replica=""
container_name=""

for index in "${!args[@]}"; do
  value="${args[$index]}"
  next_index=$((index + 1))
  case "${value}" in
    --command)
      if (( next_index < ${#args[@]} )); then
        command_index="${next_index}"
        command_value="${args[$next_index]}"
      fi
      ;;
    --name)
      (( next_index < ${#args[@]} )) && app_name="${args[$next_index]}"
      ;;
    --resource-group)
      (( next_index < ${#args[@]} )) && resource_group="${args[$next_index]}"
      ;;
    --revision)
      (( next_index < ${#args[@]} )) && revision="${args[$next_index]}"
      ;;
    --replica)
      (( next_index < ${#args[@]} )) && replica="${args[$next_index]}"
      ;;
    --container)
      (( next_index < ${#args[@]} )) && container_name="${args[$next_index]}"
      ;;
  esac
done

provider_bundle_nvidia_command='python backend/verifyNvidiaNemotronLive.py'
provider_bundle_pollinations_command='python backend/verifyPollinationsIntuitiveLive.py'
provider_bundle_remote_command='python backend/verifyNvidiaNemotronLive.py && python backend/verifyPollinationsIntuitiveLive.py'
provider_bundle_enabled="${SENTIQ_AZURE_EXEC_PROVIDER_BUNDLE_ENABLED:-true}"
provider_bundle_mode=""

cache_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/sentiq-azure-exec-cache"
mkdir -p "${cache_root}"
chmod 700 "${cache_root}" 2>/dev/null || true
cache_identity="$(printf '%s\0' \
  "${app_name}" \
  "${resource_group}" \
  "${revision}" \
  "${replica}" \
  "${container_name}" \
  | sha256sum \
  | awk '{print $1}')"
pollinations_cache="${cache_root}/pollinations-${cache_identity}.jsonl"

if [[ "${provider_bundle_enabled,,}" == "true" && "${command_value}" == "${provider_bundle_pollinations_command}" ]]; then
  if [[ -s "${pollinations_cache}" ]]; then
    cat "${pollinations_cache}"
    rm -f "${pollinations_cache}"
    exit 0
  fi
fi

if [[ "${provider_bundle_enabled,,}" == "true" && "${command_value}" == "${provider_bundle_nvidia_command}" ]]; then
  [[ "${command_index}" -ge 0 ]] || {
    echo "Azure exec command argument could not be resolved." >&2
    exit 64
  }
  args[$command_index]="${provider_bundle_remote_command}"
  provider_bundle_mode="providers"
fi

parse_positive_integer() {
  local value="$1"
  local fallback="$2"
  if [[ "${value}" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s\n' "${value}"
  else
    printf '%s\n' "${fallback}"
  fi
}

parse_nonnegative_integer() {
  local value="$1"
  local fallback="$2"
  if [[ "${value}" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "${value}"
  else
    printf '%s\n' "${fallback}"
  fi
}

max_attempts="$(parse_positive_integer "${SENTIQ_AZURE_EXEC_MAX_ATTEMPTS:-2}" 2)"
max_retry_delay_seconds="$(parse_nonnegative_integer "${SENTIQ_AZURE_EXEC_MAX_RETRY_DELAY_SECONDS:-60}" 60)"
base_retry_delay_seconds="$(parse_nonnegative_integer "${SENTIQ_AZURE_EXEC_BASE_RETRY_DELAY_SECONDS:-5}" 5)"

is_transient_control_plane_failure() {
  local path="$1"
  grep -aEiq \
    'Handshake status (429|5[0-9]{2})|HTTP (429|5[0-9]{2})|Too Many Requests|WebSocketBadStatusException|Retry-After|Bad Gateway|Service Unavailable|Gateway Timeout|connection reset by peer|temporarily unavailable' \
    "${path}"
}

resolve_retry_delay_seconds() {
  local path="$1"
  local attempt="$2"
  local retry_after=""
  retry_after="$(
    grep -aoEi 'Retry-After[^0-9]{0,16}[0-9]+' "${path}" 2>/dev/null \
      | grep -aoE '[0-9]+' \
      | tail -1 \
      || true
  )"
  local delay_seconds=$((base_retry_delay_seconds * attempt))
  if [[ "${retry_after}" =~ ^[0-9]+$ && "${retry_after}" -gt "${delay_seconds}" ]]; then
    delay_seconds="${retry_after}"
  fi
  if (( delay_seconds > max_retry_delay_seconds )); then
    delay_seconds="${max_retry_delay_seconds}"
  fi
  printf '%s\n' "${delay_seconds}"
}

attempt=1
while true; do
  attempt_log="$(mktemp "${cache_root}/attempt-${cache_identity}-${attempt}.XXXXXX.log")"
  printf -v azure_exec_command '%q ' az containerapp exec "${args[@]}"

  set +e
  script --quiet --return --command "${azure_exec_command}" /dev/null 2>&1 \
    | tee "${attempt_log}"
  exec_status="${PIPESTATUS[0]}"
  set -e

  if [[ "${exec_status}" -eq 0 ]]; then
    if [[ "${provider_bundle_mode}" == "providers" ]]; then
      cache_temp="${pollinations_cache}.tmp"
      grep -aE '"event"[[:space:]]*:[[:space:]]*"pollinations_intuitive_verification"' \
        "${attempt_log}" > "${cache_temp}" || true
      if [[ ! -s "${cache_temp}" ]] \
        || ! grep -aEq '"status"[[:space:]]*:[[:space:]]*"pass"' "${cache_temp}"; then
        rm -f "${cache_temp}" "${attempt_log}"
        echo "Bundled Pollinations verification did not emit a passing report." >&2
        exit 70
      fi
      chmod 600 "${cache_temp}" 2>/dev/null || true
      mv "${cache_temp}" "${pollinations_cache}"
    fi
    rm -f "${attempt_log}"
    exit 0
  fi

  if (( attempt >= max_attempts )) || ! is_transient_control_plane_failure "${attempt_log}"; then
    rm -f "${attempt_log}"
    exit "${exec_status}"
  fi

  retry_delay_seconds="$(resolve_retry_delay_seconds "${attempt_log}" "${attempt}")"
  echo "Azure Container Apps exec encountered a transient control-plane failure; retrying attempt $((attempt + 1))/${max_attempts} after ${retry_delay_seconds}s." >&2
  rm -f "${attempt_log}"
  if (( retry_delay_seconds > 0 )); then
    sleep "${retry_delay_seconds}"
  fi
  attempt=$((attempt + 1))
done
