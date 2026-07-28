#!/usr/bin/env bash
set -Eeuo pipefail

# The compiled preflight prints only safe booleans, counts, policy limits, and
# issue codes. It never prints API keys, database credentials, or bearer tokens.
node dist/backend/verifyNemotronDeploymentReadiness.js

exec ./scripts/start-container.sh
