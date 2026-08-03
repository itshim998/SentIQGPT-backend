#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
wrapper="${repo_root}/scripts/execAzureContainerAppCommand.sh"
temp_root="$(mktemp -d)"
trap 'rm -rf "${temp_root}"' EXIT
mkdir -p "${temp_root}/bin" "${temp_root}/runner"

cat > "${temp_root}/bin/script" <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail
command_value=""
while (( $# > 0 )); do
  case "$1" in
    --command)
      command_value="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
[[ -n "${command_value}" ]] || exit 64
bash -c "${command_value}"
SCRIPT
chmod +x "${temp_root}/bin/script"

cat > "${temp_root}/bin/az" <<'AZ'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "${FAKE_AZ_CALL_LOG}"
command_value=""
args=("$@")
for index in "${!args[@]}"; do
  if [[ "${args[$index]}" == "--command" ]] && (( index + 1 < ${#args[@]} )); then
    command_value="${args[$((index + 1))]}"
  fi
done

if [[ "${command_value}" == *"remote-failure"* ]]; then
  echo '{"event":"remote_verification","status":"fail"}'
  exit 7
fi

if [[ "${command_value}" == *"transient-probe"* ]]; then
  current=0
  [[ -f "${FAKE_AZ_RETRY_STATE}" ]] && current="$(cat "${FAKE_AZ_RETRY_STATE}")"
  current=$((current + 1))
  printf '%s\n' "${current}" > "${FAKE_AZ_RETRY_STATE}"
  if [[ "${current}" == "1" ]]; then
    echo 'websocket._exceptions.WebSocketBadStatusException: Handshake status 429 Too Many Requests - Retry-After: 600'
    exit 1
  fi
  echo '{"event":"transient_probe","status":"pass"}'
  exit 0
fi

if [[ "${command_value}" == *"verifyNvidiaNemotronLive.py"* ]]; then
  for slot in 1 2 3 4 5 6; do
    printf '{"event":"independent_slot","slot":%s,"status":"pass"}\n' "${slot}"
  done
  echo '{"event":"summary","failures":0}'
fi
if [[ "${command_value}" == *"verifyPollinationsIntuitiveLive.py"* ]]; then
  echo '{"event":"pollinations_intuitive_verification","status":"pass"}'
fi
AZ
chmod +x "${temp_root}/bin/az"

export PATH="${temp_root}/bin:${PATH}"
export RUNNER_TEMP="${temp_root}/runner"
export FAKE_AZ_CALL_LOG="${temp_root}/az-calls.log"
export FAKE_AZ_RETRY_STATE="${temp_root}/retry-state"
: > "${FAKE_AZ_CALL_LOG}"

common_args=(
  --name sentiq-test
  --resource-group rg-test
  --revision revision-provider-bundle
  --replica replica-test
  --container sentiqgpt-backend
)

bash "${wrapper}" \
  "${common_args[@]}" \
  --command 'python backend/verifyNvidiaNemotronLive.py' \
  > "${temp_root}/nvidia.out"

bash "${wrapper}" \
  "${common_args[@]}" \
  --command 'python backend/verifyPollinationsIntuitiveLive.py' \
  > "${temp_root}/pollinations.out"

[[ "$(wc -l < "${FAKE_AZ_CALL_LOG}" | tr -d ' ')" == "1" ]]
grep -Eq '"event":"summary","failures":0' "${temp_root}/nvidia.out"
[[ "$(grep -Ec '"event":"independent_slot".*"status":"pass"' "${temp_root}/nvidia.out")" == "6" ]]
grep -Eq '"event":"pollinations_intuitive_verification","status":"pass"' "${temp_root}/pollinations.out"

: > "${FAKE_AZ_CALL_LOG}"
set +e
bash "${wrapper}" \
  --name sentiq-test \
  --resource-group rg-test \
  --revision revision-remote-failure \
  --replica replica-test \
  --container sentiqgpt-backend \
  --command remote-failure \
  > "${temp_root}/remote-failure.out" 2>&1
remote_status="$?"
set -e
[[ "${remote_status}" == "7" ]]
[[ "$(wc -l < "${FAKE_AZ_CALL_LOG}" | tr -d ' ')" == "1" ]]

: > "${FAKE_AZ_CALL_LOG}"
rm -f "${FAKE_AZ_RETRY_STATE}"
SENTIQ_AZURE_EXEC_MAX_ATTEMPTS=2 \
SENTIQ_AZURE_EXEC_BASE_RETRY_DELAY_SECONDS=0 \
SENTIQ_AZURE_EXEC_MAX_RETRY_DELAY_SECONDS=0 \
  bash "${wrapper}" \
    --name sentiq-test \
    --resource-group rg-test \
    --revision revision-transient-retry \
    --replica replica-test \
    --container sentiqgpt-backend \
    --command transient-probe \
    > "${temp_root}/transient.out" 2>&1

[[ "$(wc -l < "${FAKE_AZ_CALL_LOG}" | tr -d ' ')" == "2" ]]
grep -Eq '"event":"transient_probe","status":"pass"' "${temp_root}/transient.out"
grep -Eq 'transient control-plane failure; retrying attempt 2/2' "${temp_root}/transient.out"

printf '%s\n' 'Azure Container Apps exec throttle tests passed.'
