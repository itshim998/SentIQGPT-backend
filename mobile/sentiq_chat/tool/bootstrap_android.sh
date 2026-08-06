#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

flutter create \
  --platforms=android \
  --org com.sentiqlabs \
  --project-name sentiq_chat \
  --empty \
  .

python3 - <<'PY'
from pathlib import Path

candidates = [
    Path("android/app/build.gradle.kts"),
    Path("android/app/build.gradle"),
]
for path in candidates:
    if not path.exists():
        continue
    text = path.read_text(encoding="utf-8")
    text = text.replace(
        'applicationId = "com.sentiqlabs.sentiq_chat"',
        'applicationId = "com.sentiqlabs.sentiqchat"',
    )
    text = text.replace(
        'applicationId "com.sentiqlabs.sentiq_chat"',
        'applicationId "com.sentiqlabs.sentiqchat"',
    )
    text = text.replace("minSdk = flutter.minSdkVersion", "minSdk = 28")
    text = text.replace("minSdkVersion flutter.minSdkVersion", "minSdkVersion 28")
    path.write_text(text, encoding="utf-8")
    break
else:
    raise SystemExit("Android application Gradle file was not generated")
PY

printf 'Android scaffold ready: com.sentiqlabs.sentiqchat, minSdk 28\n'
