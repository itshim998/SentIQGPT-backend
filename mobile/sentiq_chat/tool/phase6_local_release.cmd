@echo off
setlocal

if "%~1"=="" (
  echo Usage: phase6_local_release.cmd ^<expected-pr-head-sha^>
  echo.
  echo This command runs the complete zero-GitHub-Actions Phase 6 gate,
  echo including backend compatibility, release APK/AAB signing, and API 28/API 35 emulators.
  exit /b 2
)

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo PowerShell was not found.
  exit /b 2
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0phase6_local_release.ps1" -RunEmulators -ExpectedHeadSha "%~1"
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Phase 6 local release verification failed with exit code %EXIT_CODE%.
  exit /b %EXIT_CODE%
)

echo.
echo Phase 6 local release verification completed successfully.
exit /b 0
