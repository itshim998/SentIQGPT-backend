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
$requiredFlutterVersion = "3.44.8"
$flutterArchiveUrl = "https://storage.googleapis.com/flutter_infra_release/releases/stable/windows/flutter_windows_3.44.8-stable.zip"
$flutterArchiveSha256 = "095c108a08e0377d8a6501fed65aeb288908a070ed3f135e525dc6431c7686e4"

function Get-CommandSource([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) { return $null }
    return $command.Source
}

function Get-FlutterVersion([string]$FlutterCommand) {
    try {
        $output = & $FlutterCommand --version 2>&1
        if ($LASTEXITCODE -ne 0) { return $null }
        $text = ($output -join "`n")
        $match = [regex]::Match($text, 'Flutter\s+([0-9]+\.[0-9]+\.[0-9]+)\b')
        if (!$match.Success) { return $null }
        return $match.Groups[1].Value
    }
    catch { return $null }
}

function Get-JavaMajor([string]$JavaCommand) {
    try {
        $output = & $JavaCommand -version 2>&1
        $text = ($output -join "`n")
        $match = [regex]::Match($text, 'version\s+"?([0-9]+)')
        if (!$match.Success) { return $null }
        return [int]$match.Groups[1].Value
    }
    catch { return $null }
}

function Ensure-CommonJava17 {
    $java = Get-CommandSource "java"
    if (($null -ne $java) -and ((Get-JavaMajor $java) -eq 17)) { return }

    $candidateBins = New-Object System.Collections.Generic.List[string]
    if (![string]::IsNullOrWhiteSpace($env:JAVA_HOME)) {
        [void]$candidateBins.Add((Join-Path $env:JAVA_HOME 'bin'))
    }

    foreach ($pattern in @(
        'C:\Program Files\Eclipse Adoptium\jdk-17*\bin',
        'C:\Program Files\Microsoft\jdk-17*\bin',
        'C:\Program Files\Java\jdk-17*\bin'
    )) {
        Get-Item $pattern -ErrorAction SilentlyContinue | ForEach-Object { [void]$candidateBins.Add($_.FullName) }
    }

    foreach ($bin in $candidateBins) {
        $candidate = Join-Path $bin 'java.exe'
        if ((Test-Path $candidate) -and ((Get-JavaMajor $candidate) -eq 17)) {
            $env:JAVA_HOME = (Split-Path $bin -Parent)
            $env:PATH = "$bin;$env:PATH"
            Write-Host "Using JDK 17 from $($env:JAVA_HOME)" -ForegroundColor Green
            return
        }
    }
}

function Resolve-AndroidSdkCandidate {
    foreach ($candidate in @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME, (Join-Path $env:LOCALAPPDATA 'Android\Sdk'))) {
        if (![string]::IsNullOrWhiteSpace($candidate) -and (Test-Path $candidate)) {
            return (Resolve-Path $candidate).Path
        }
    }
    return $null
}

function Find-SdkManager([string]$SdkRoot) {
    if ([string]::IsNullOrWhiteSpace($SdkRoot)) { return $null }
    $cmdline = Join-Path $SdkRoot 'cmdline-tools'
    if (!(Test-Path $cmdline)) { return $null }
    $match = Get-ChildItem -Path $cmdline -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'sdkmanager.bat' -or $_.Name -eq 'sdkmanager' } |
        Select-Object -First 1
    if ($null -eq $match) { return $null }
    return $match.FullName
}

function Show-WorkstationPreflight {
    Ensure-CommonJava17
    $issues = New-Object System.Collections.Generic.List[string]

    foreach ($name in @('git', 'node', 'npm', 'npx', 'java', 'keytool', 'jarsigner')) {
        if ($null -eq (Get-Command $name -ErrorAction SilentlyContinue)) {
            [void]$issues.Add("$name is not installed or not on PATH")
        }
    }

    $node = Get-CommandSource 'node'
    if ($null -ne $node) {
        try {
            $nodeVersion = ((& $node --version 2>&1) -join '').Trim()
            if ($nodeVersion -notmatch '^v20\.') {
                [void]$issues.Add("Node 20.x is required for CI parity; found $nodeVersion")
            }
        }
        catch { [void]$issues.Add('Node version could not be read') }
    }

    $java = Get-CommandSource 'java'
    if ($null -ne $java) {
        $major = Get-JavaMajor $java
        if ($major -ne 17) {
            [void]$issues.Add("JDK 17 is required for CI parity; found Java $major")
        }
    }

    $bash = Get-Command "bash.exe" -ErrorAction SilentlyContinue
    if ($null -eq $bash) { $bash = Get-Command "bash" -ErrorAction SilentlyContinue }
    if ($null -eq $bash) {
        $git = Get-Command "git.exe" -ErrorAction SilentlyContinue
        $gitBashFound = $false
        if ($null -ne $git) {
            $gitRoot = Split-Path (Split-Path $git.Source -Parent) -Parent
            $candidate = Join-Path $gitRoot "bin\bash.exe"
            $gitBashFound = Test-Path $candidate
        }
        if (!$gitBashFound) { [void]$issues.Add('Git Bash is required') }
    }

    $sdkRoot = Resolve-AndroidSdkCandidate
    if ($null -eq $sdkRoot) {
        [void]$issues.Add('Android SDK is required (install Android Studio or the Android command-line SDK)')
    }
    else {
        $env:ANDROID_SDK_ROOT = $sdkRoot
        $env:ANDROID_HOME = $sdkRoot
        if ($null -eq (Find-SdkManager $sdkRoot)) {
            [void]$issues.Add("Android SDK Command-line Tools are missing under $sdkRoot (install 'Android SDK Command-line Tools (latest)' in Android Studio SDK Manager)")
        }
    }

    if ($issues.Count -gt 0) {
        $message = "Phase 6 workstation preflight found the following prerequisite issue(s):`n - " + ($issues -join "`n - ") + "`nFix these workstation prerequisites once, then rerun the same one-command gate. Flutter itself will be installed automatically."
        throw $message
    }
}

function Ensure-PinnedFlutter {
    $globalFlutter = Get-CommandSource "flutter"
    if ($null -ne $globalFlutter) {
        $globalVersion = Get-FlutterVersion $globalFlutter
        if ($globalVersion -eq $requiredFlutterVersion) {
            Write-Host "Using Flutter $requiredFlutterVersion from PATH: $globalFlutter" -ForegroundColor Green
            return
        }
        if ($null -ne $globalVersion) {
            Write-Host "Flutter $globalVersion is on PATH, but this release gate is pinned to $requiredFlutterVersion. A private pinned SDK will be used." -ForegroundColor Yellow
        }
    }

    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "LOCALAPPDATA is unavailable, so the pinned Flutter SDK cannot be bootstrapped safely."
    }

    $toolchainRoot = Join-Path $env:LOCALAPPDATA "SentIQ\toolchains"
    $flutterRoot = Join-Path $toolchainRoot "flutter-$requiredFlutterVersion"
    $flutterBat = Join-Path $flutterRoot "bin\flutter.bat"

    if (Test-Path $flutterBat) {
        $localVersion = Get-FlutterVersion $flutterBat
        if ($localVersion -eq $requiredFlutterVersion) {
            $env:PATH = "$(Join-Path $flutterRoot 'bin');$env:PATH"
            Write-Host "Using cached SentIQ Flutter $requiredFlutterVersion: $flutterRoot" -ForegroundColor Green
            return
        }
        Write-Host "Cached Flutter SDK is incomplete or has the wrong version; rebuilding it." -ForegroundColor Yellow
        Remove-Item -Recurse -Force $flutterRoot
    }

    New-Item -ItemType Directory -Force -Path $toolchainRoot | Out-Null
    $archivePath = Join-Path $toolchainRoot "flutter_windows_${requiredFlutterVersion}-stable.zip"
    $extractRoot = Join-Path ([System.IO.Path]::GetTempPath()) "sentiq-flutter-$requiredFlutterVersion-$([Guid]::NewGuid().ToString('N'))"

    try {
        $needDownload = $true
        if (Test-Path $archivePath) {
            $cachedHash = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
            if ($cachedHash -eq $flutterArchiveSha256) {
                $needDownload = $false
                Write-Host "Using previously downloaded, SHA-256 verified Flutter archive." -ForegroundColor Green
            }
            else {
                Write-Host "Discarding cached Flutter archive because its SHA-256 does not match the official release." -ForegroundColor Yellow
                Remove-Item -Force $archivePath
            }
        }

        if ($needDownload) {
            Write-Host "Flutter $requiredFlutterVersion was not found. Downloading the official pinned Windows SDK..." -ForegroundColor Cyan
            $curl = Get-CommandSource "curl.exe"
            if ($null -ne $curl) {
                & $curl -L --fail --retry 3 --retry-delay 2 --output $archivePath $flutterArchiveUrl
                if ($LASTEXITCODE -ne 0) { throw "Flutter SDK download failed with curl exit code $LASTEXITCODE." }
            }
            else {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                Invoke-WebRequest -UseBasicParsing -Uri $flutterArchiveUrl -OutFile $archivePath
            }
        }

        $actualHash = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
        if ($actualHash -ne $flutterArchiveSha256) {
            Remove-Item -Force $archivePath -ErrorAction SilentlyContinue
            throw "Downloaded Flutter SDK failed SHA-256 verification. Expected $flutterArchiveSha256, found $actualHash."
        }
        Write-Host "Flutter archive SHA-256 verified." -ForegroundColor Green

        New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
        Write-Host "Extracting Flutter $requiredFlutterVersion. This can take several minutes on Windows." -ForegroundColor Cyan
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
        $extractedFlutter = Join-Path $extractRoot "flutter"
        if (!(Test-Path (Join-Path $extractedFlutter "bin\flutter.bat"))) {
            throw "The verified Flutter archive did not extract the expected flutter\bin\flutter.bat."
        }
        if (Test-Path $flutterRoot) { Remove-Item -Recurse -Force $flutterRoot }
        Move-Item -Path $extractedFlutter -Destination $flutterRoot

        $installedVersion = Get-FlutterVersion $flutterBat
        if ($installedVersion -ne $requiredFlutterVersion) {
            throw "Bootstrapped Flutter reported '$installedVersion'; expected '$requiredFlutterVersion'."
        }

        $env:PATH = "$(Join-Path $flutterRoot 'bin');$env:PATH"
        Write-Host "Pinned Flutter $requiredFlutterVersion is ready at $flutterRoot" -ForegroundColor Green
    }
    finally {
        Remove-Item -Recurse -Force $extractRoot -ErrorAction SilentlyContinue
    }
}

function Confirm-FlutterCommands {
    $missing = @()
    foreach ($name in @('flutter', 'dart')) {
        if ($null -eq (Get-Command $name -ErrorAction SilentlyContinue)) { $missing += $name }
    }
    if ($missing.Count -gt 0) {
        throw "Automatic Flutter bootstrap completed but command(s) are still unavailable: $($missing -join ', ')."
    }
}

try {
    if (!(Test-Path $templatePath)) { throw "Phase 6 verifier template is missing: $templatePath" }

    $source = [System.IO.File]::ReadAllText($templatePath)
    $broken = 'failed for $Serial: $($output -join '' '')'
    $fixed = 'failed for ${Serial}: $($output -join '' '')'
    $matches = [regex]::Matches($source, [regex]::Escape($broken)).Count
    if ($matches -ne 1) {
        throw "Phase 6 verifier compatibility patch expected exactly one target, found $matches. Refusing to execute an unverified runtime script."
    }
    $source = $source.Replace($broken, $fixed)

    [System.IO.File]::WriteAllText($runtimePath, $source, (New-Object System.Text.UTF8Encoding($false)))

    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($runtimePath, [ref]$tokens, [ref]$parseErrors) | Out-Null
    if (($parseErrors | Measure-Object).Count -gt 0) {
        $messages = $parseErrors | ForEach-Object { "line $($_.Extent.StartLineNumber), column $($_.Extent.StartColumnNumber): $($_.Message)" }
        throw "Phase 6 verifier PowerShell parser preflight failed:`n$($messages -join "`n")"
    }

    # Check every non-Flutter workstation prerequisite before downloading the
    # relatively large Flutter SDK, so failures are reported together and early.
    Show-WorkstationPreflight
    Ensure-PinnedFlutter
    Confirm-FlutterCommands

    $forward = @()
    if ($RunEmulators) { $forward += "-RunEmulators" }
    if ($SkipBackend) { $forward += "-SkipBackend" }
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
    if ($verifierExitCode -ne 0) { throw "Phase 6 verifier failed with exit code $verifierExitCode." }
}
finally {
    Remove-Item -Force $runtimePath -ErrorAction SilentlyContinue
}
