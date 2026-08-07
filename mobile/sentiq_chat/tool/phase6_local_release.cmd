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

set "VERIFIER_PS1=%~dp0phase6_local_release.ps1"

rem Parse the wrapper from a separate PowerShell process before executing it.
rem This catches wrapper-level syntax errors that the wrapper cannot catch itself.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:VERIFIER_PS1,[ref]$tokens,[ref]$errors) ^| Out-Null; if ($errors.Count -gt 0) { $errors ^| ForEach-Object { Write-Error ('Phase 6 wrapper parser preflight: ' + $_.Message) }; exit 3 }"
if errorlevel 1 goto parser_failed

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%VERIFIER_PS1%" -RunEmulators -ExpectedHeadSha "%~1"
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Phase 6 local release verification failed with exit code %EXIT_CODE%.
  exit /b %EXIT_CODE%
)

echo.
echo Phase 6 local release verification completed successfully.
exit /b 0

:parser_failed
echo.
echo Phase 6 local release wrapper failed parser preflight. No Flutter, backend, signing, or emulator work was started.
exit /b 3
