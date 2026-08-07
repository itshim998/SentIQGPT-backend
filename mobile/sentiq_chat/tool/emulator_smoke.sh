#!/usr/bin/env sh
set -eu

api_level="${1:-unknown}"
apk="/tmp/sentiq-emulator/build/app/outputs/flutter-apk/app-debug.apk"
install_log="/tmp/android-install-${api_level}.txt"
start_log="/tmp/android-start-${api_level}.txt"
restart_log="/tmp/android-restart-${api_level}.txt"
logcat_log="/tmp/android-logcat-${api_level}.txt"
package_name="com.sentiqlabs.sentiqchat"
activity_name="com.sentiqlabs.sentiq_chat.MainActivity"

capture_logcat() {
  adb logcat -d -t 800 >"${logcat_log}" 2>&1 || true
}

fail_with_logcat() {
  capture_logcat
  tail -n 200 "${logcat_log}" || true
  exit 1
}

if [ ! -f "${apk}" ]; then
  echo "Missing emulator APK: ${apk}" | tee "${install_log}"
  exit 1
fi

adb wait-for-device
if ! adb install -r -t "${apk}" >"${install_log}" 2>&1; then
  cat "${install_log}"
  exit 1
fi
cat "${install_log}"

adb shell pm clear "${package_name}" >/dev/null 2>&1 || true
if ! adb shell am start -W -n "${package_name}/${activity_name}" >"${start_log}" 2>&1; then
  cat "${start_log}"
  fail_with_logcat
fi
cat "${start_log}"
sleep 4

pid="$(adb shell pidof "${package_name}" | tr -d '\r')" || true
if [ -z "${pid}" ]; then
  fail_with_logcat
fi

adb shell am force-stop "${package_name}"
if ! adb shell am start -W -n "${package_name}/${activity_name}" >"${restart_log}" 2>&1; then
  cat "${restart_log}"
  fail_with_logcat
fi
cat "${restart_log}"
sleep 2

pid="$(adb shell pidof "${package_name}" | tr -d '\r')" || true
if [ -z "${pid}" ]; then
  fail_with_logcat
fi

capture_logcat
if grep -A20 'FATAL EXCEPTION' "${logcat_log}" | grep -q "${package_name}"; then
  echo 'SentIQ Chat fatal exception detected' >&2
  exit 1
fi
