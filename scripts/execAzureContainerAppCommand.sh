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
printf -v azure_exec_command '%q ' az containerapp exec "$@"
script --quiet --return --command "${azure_exec_command}" /dev/null
