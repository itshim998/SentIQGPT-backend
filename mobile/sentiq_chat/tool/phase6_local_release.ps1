param(
    [switch]$RunEmulators,
    [switch]$SkipBackend,
    [string]$ExpectedHeadSha = "",
    [string]$EvidenceRoot = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$templatePath = Join-Path $PSScriptRoot "phase6_local_release.impl.ps1.txt"
$runtimePath = Join-Path $PSScriptRoot ".phase6_local_release.runtime.ps1"

try {
    if (!(Test-Path $templatePath)) {
        throw "Phase 6 verifier template is missing: $templatePath"
    }

    $source = [System.IO.File]::ReadAllText($templatePath)

    # Windows PowerShell parses an interpolated variable followed immediately by
    # ':' as a scoped/drive-qualified variable. Materialize the implementation
    # with an explicitly delimited variable before parsing or executing it.
    $broken = 'failed for $Serial: $($output -join '' '')'
    $fixed = 'failed for ${Serial}: $($output -join '' '')'
    $matches = [regex]::Matches($source, [regex]::Escape($broken)).Count
    if ($matches -ne 1) {
        throw "Phase 6 verifier compatibility patch expected exactly one target, found $matches. Refusing to execute an unverified runtime script."
    }
    $source = $source.Replace($broken, $fixed)

    [System.IO.File]::WriteAllText(
        $runtimePath,
        $source,
        (New-Object System.Text.UTF8Encoding($false))
    )

    # Fail before any Flutter/Android work if another PowerShell parser issue is
    # present. This keeps local release verification fast and deterministic.
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $runtimePath,
        [ref]$tokens,
        [ref]$parseErrors
    ) | Out-Null

    if (($parseErrors | Measure-Object).Count -gt 0) {
        $messages = $parseErrors | ForEach-Object {
            "line $($_.Extent.StartLineNumber), column $($_.Extent.StartColumnNumber): $($_.Message)"
        }
        throw "Phase 6 verifier PowerShell parser preflight failed:`n$($messages -join "`n")"
    }

    $forward = @()
    if ($RunEmulators) {
        $forward += "-RunEmulators"
    }
    if ($SkipBackend) {
        $forward += "-SkipBackend"
    }
    if (![string]::IsNullOrWhiteSpace($ExpectedHeadSha)) {
        $forward += "-ExpectedHeadSha"
        $forward += $ExpectedHeadSha
    }
    if (![string]::IsNullOrWhiteSpace($EvidenceRoot)) {
        $forward += "-EvidenceRoot"
        $forward += $EvidenceRoot
    }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runtimePath @forward
    $verifierExitCode = $LASTEXITCODE
    if ($verifierExitCode -ne 0) {
        throw "Phase 6 verifier failed with exit code $verifierExitCode."
    }
}
finally {
    Remove-Item -Force $runtimePath -ErrorAction SilentlyContinue
}
