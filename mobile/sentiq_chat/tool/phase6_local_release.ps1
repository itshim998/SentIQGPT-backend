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

$requiredNodeVersion = "20.20.2"
$nodeArchiveName = "node-v20.20.2-win-x64.zip"
$nodeArchiveUrl = "https://nodejs.org/dist/v20.20.2/node-v20.20.2-win-x64.zip"
$nodeShasumsUrl = "https://nodejs.org/dist/v20.20.2/SHASUMS256.txt"

$jdkAssetsUrl = "https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse"

function Get-CommandSource([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) { return $null }
    return $command.Source
}

function Invoke-Download([string]$Url, [string]$Destination) {
    $curl = Get-CommandSource "curl.exe"
    if ($null -ne $curl) {
        & $curl -L --fail --retry 3 --retry-delay 2 --output $Destination $Url
        if ($LASTEXITCODE -ne 0) {
            throw ("Download failed with curl exit code {0}: {1}" -f $LASTEXITCODE, $Url)
        }
        return
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
}

function Get-JavaMajor([string]$JavaCommand) {
    try {
        $output = & $JavaCommand -version 2>&1
        $text = $output -join "`n"
        $match = [regex]::Match($text, '(?:version|openjdk)\s+"?([0-9]+)')
        if (!$match.Success) {
            $match = [regex]::Match($text, '\b([0-9]+)(?:\.[0-9]+){1,3}\b')
        }
        if (!$match.Success) { return $null }
        return [int]$match.Groups[1].Value
    }
    catch { return $null }
}

function Get-NodeVersion([string]$NodeCommand) {
    try {
        $text = ((& $NodeCommand --version 2>&1) -join "").Trim()
        $match = [regex]::Match($text, '^v([0-9]+\.[0-9]+\.[0-9]+)$')
        if (!$match.Success) { return $null }
        return $match.Groups[1].Value
    }
    catch { return $null }
}

function Get-FlutterVersion([string]$FlutterCommand) {
    try {
        $output = & $FlutterCommand --version 2>&1
        if ($LASTEXITCODE -ne 0) { return $null }
        $match = [regex]::Match(($output -join "`n"), 'Flutter\s+([0-9]+\.[0-9]+\.[0-9]+)\b')
        if (!$match.Success) { return $null }
        return $match.Groups[1].Value
    }
    catch { return $null }
}

function Resolve-AndroidSdkCandidate {
    $candidates = New-Object System.Collections.Generic.List[string]
    if (![string]::IsNullOrWhiteSpace($env:ANDROID_SDK_ROOT)) { [void]$candidates.Add($env:ANDROID_SDK_ROOT) }
    if (![string]::IsNullOrWhiteSpace($env:ANDROID_HOME)) { [void]$candidates.Add($env:ANDROID_HOME) }
    if (![string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        [void]$candidates.Add((Join-Path $env:LOCALAPPDATA "Android\Sdk"))
    }

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
    }
    return $null
}

function Find-SdkManager([string]$SdkRoot) {
    if ([string]::IsNullOrWhiteSpace($SdkRoot)) { return $null }
    $root = Join-Path $SdkRoot "cmdline-tools"
    if (!(Test-Path $root)) { return $null }
    $match = Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq "sdkmanager.bat" -or $_.Name -eq "sdkmanager" } |
        Select-Object -First 1
    if ($null -eq $match) { return $null }
    return $match.FullName
}

function Show-HostPreflight {
    $issues = New-Object System.Collections.Generic.List[string]

    if ($null -eq (Get-Command "git" -ErrorAction SilentlyContinue)) {
        [void]$issues.Add("Git for Windows is required")
    }

    $bash = Get-Command "bash.exe" -ErrorAction SilentlyContinue
    if ($null -eq $bash) { $bash = Get-Command "bash" -ErrorAction SilentlyContinue }
    if ($null -eq $bash) {
        $git = Get-Command "git.exe" -ErrorAction SilentlyContinue
        $gitBashFound = $false
        if ($null -ne $git) {
            $gitRoot = Split-Path (Split-Path $git.Source -Parent) -Parent
            $gitBashFound = Test-Path (Join-Path $gitRoot "bin\bash.exe")
        }
        if (!$gitBashFound) { [void]$issues.Add("Git Bash is required") }
    }

    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        [void]$issues.Add("LOCALAPPDATA is unavailable, so private release toolchains cannot be installed")
    }

    $sdkRoot = Resolve-AndroidSdkCandidate
    if ($null -eq $sdkRoot) {
        [void]$issues.Add("Android SDK is required (install Android Studio or the Android command-line SDK)")
    }
    else {
        $env:ANDROID_SDK_ROOT = $sdkRoot
        $env:ANDROID_HOME = $sdkRoot
        if ($null -eq (Find-SdkManager $sdkRoot)) {
            [void]$issues.Add(("Android SDK Command-line Tools are missing under {0} (install 'Android SDK Command-line Tools (latest)' in Android Studio SDK Manager)" -f $sdkRoot))
        }
    }

    if ($issues.Count -gt 0) {
        $message = "Phase 6 host preflight found the following prerequisite issue(s):`n - " +
            ($issues -join "`n - ") +
            "`nNode 20, JDK 17, and Flutter 3.44.8 are bootstrapped privately by the verifier and do not need global installation."
        throw $message
    }
}

function Ensure-PinnedNode {
    $existing = Get-CommandSource "node"
    if ($null -ne $existing) {
        $existingVersion = Get-NodeVersion $existing
        if ($existingVersion -eq $requiredNodeVersion) {
            Write-Host ("Using Node {0} from PATH: {1}" -f $requiredNodeVersion, $existing) -ForegroundColor Green
            return
        }
        if ($null -ne $existingVersion) {
            Write-Host ("Node {0} is installed globally; the release gate will use private Node {1} without changing the global installation." -f $existingVersion, $requiredNodeVersion) -ForegroundColor Yellow
        }
    }

    $toolchainRoot = Join-Path $env:LOCALAPPDATA "SentIQ\toolchains"
    $nodeRoot = Join-Path $toolchainRoot ("node-{0}" -f $requiredNodeVersion)
    $nodeExe = Join-Path $nodeRoot "node.exe"

    if ((Test-Path $nodeExe) -and ((Get-NodeVersion $nodeExe) -eq $requiredNodeVersion)) {
        $env:PATH = "{0};{1}" -f $nodeRoot, $env:PATH
        Write-Host ("Using cached private Node {0}: {1}" -f $requiredNodeVersion, $nodeRoot) -ForegroundColor Green
        return
    }

    if (Test-Path $nodeRoot) { Remove-Item -Recurse -Force $nodeRoot }
    New-Item -ItemType Directory -Force -Path $toolchainRoot | Out-Null

    $archivePath = Join-Path $toolchainRoot $nodeArchiveName
    $shasumsPath = Join-Path $toolchainRoot ("node-{0}-SHASUMS256.txt" -f $requiredNodeVersion)
    $extractRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("sentiq-node-{0}-{1}" -f $requiredNodeVersion, [Guid]::NewGuid().ToString("N"))

    try {
        Write-Host ("Downloading private Node {0} for CI parity..." -f $requiredNodeVersion) -ForegroundColor Cyan
        Invoke-Download -Url $nodeArchiveUrl -Destination $archivePath
        Invoke-Download -Url $nodeShasumsUrl -Destination $shasumsPath

        $line = Get-Content $shasumsPath | Where-Object { $_ -match ([regex]::Escape($nodeArchiveName) + '$') } | Select-Object -First 1
        if ([string]::IsNullOrWhiteSpace($line)) {
            throw ("Official Node SHASUMS256.txt did not contain {0}." -f $nodeArchiveName)
        }
        $expectedHash = (($line -split '\s+')[0]).ToLowerInvariant()
        $actualHash = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            throw ("Node archive SHA-256 mismatch. Expected {0}, found {1}." -f $expectedHash, $actualHash)
        }
        Write-Host "Node archive SHA-256 verified against the official release manifest." -ForegroundColor Green

        New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
        $extracted = Join-Path $extractRoot ("node-v{0}-win-x64" -f $requiredNodeVersion)
        if (!(Test-Path (Join-Path $extracted "node.exe"))) {
            throw "The verified Node archive did not contain the expected Windows x64 layout."
        }
        Move-Item -Path $extracted -Destination $nodeRoot

        if ((Get-NodeVersion $nodeExe) -ne $requiredNodeVersion) {
            throw ("Bootstrapped Node did not report the expected version {0}." -f $requiredNodeVersion)
        }
        $env:PATH = "{0};{1}" -f $nodeRoot, $env:PATH
        Write-Host ("Private Node {0} is ready at {1}" -f $requiredNodeVersion, $nodeRoot) -ForegroundColor Green
    }
    finally {
        Remove-Item -Recurse -Force $extractRoot -ErrorAction SilentlyContinue
        Remove-Item -Force $archivePath -ErrorAction SilentlyContinue
        Remove-Item -Force $shasumsPath -ErrorAction SilentlyContinue
    }
}

function Ensure-PinnedJava17 {
    $existing = Get-CommandSource "java"
    if (($null -ne $existing) -and ((Get-JavaMajor $existing) -eq 17)) {
        Write-Host ("Using JDK 17 from PATH: {0}" -f $existing) -ForegroundColor Green
        return
    }

    $toolchainRoot = Join-Path $env:LOCALAPPDATA "SentIQ\toolchains"
    $jdkRoot = Join-Path $toolchainRoot "temurin-jdk-17"
    $javaExe = Join-Path $jdkRoot "bin\java.exe"

    if ((Test-Path $javaExe) -and ((Get-JavaMajor $javaExe) -eq 17)) {
        $env:JAVA_HOME = $jdkRoot
        $env:PATH = "{0};{1}" -f (Join-Path $jdkRoot "bin"), $env:PATH
        Write-Host ("Using cached private Temurin JDK 17: {0}" -f $jdkRoot) -ForegroundColor Green
        return
    }

    if (Test-Path $jdkRoot) { Remove-Item -Recurse -Force $jdkRoot }
    New-Item -ItemType Directory -Force -Path $toolchainRoot | Out-Null

    $metadataPath = Join-Path $toolchainRoot "temurin-jdk-17-metadata.json"
    $archivePath = Join-Path $toolchainRoot "temurin-jdk-17-windows-x64.zip"
    $extractRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("sentiq-jdk17-{0}" -f [Guid]::NewGuid().ToString("N"))

    try {
        Write-Host "Resolving the current Eclipse Temurin JDK 17 package from Adoptium metadata..." -ForegroundColor Cyan
        Invoke-Download -Url $jdkAssetsUrl -Destination $metadataPath
        $assets = Get-Content -Raw $metadataPath | ConvertFrom-Json
        if (($null -eq $assets) -or ($assets.Count -lt 1)) {
            throw "Adoptium returned no Windows x64 JDK 17 asset."
        }

        $package = $assets[0].binary.package
        $downloadUrl = [string]$package.link
        $expectedHash = ([string]$package.checksum).ToLowerInvariant()
        if ([string]::IsNullOrWhiteSpace($downloadUrl)) {
            throw "Adoptium metadata did not contain the JDK package download URL."
        }
        if ($expectedHash -notmatch '^[a-f0-9]{64}$') {
            throw "Adoptium metadata did not contain a valid SHA-256 checksum."
        }

        Write-Host "Downloading private Eclipse Temurin JDK 17..." -ForegroundColor Cyan
        Invoke-Download -Url $downloadUrl -Destination $archivePath
        $actualHash = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            throw ("Temurin JDK archive SHA-256 mismatch. Expected {0}, found {1}." -f $expectedHash, $actualHash)
        }
        Write-Host "Temurin JDK archive SHA-256 verified against Adoptium release metadata." -ForegroundColor Green

        New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
        $foundJava = Get-ChildItem -Path $extractRoot -Recurse -File -Filter "java.exe" -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '[\\/]bin[\\/]java\.exe$' } |
            Select-Object -First 1
        if ($null -eq $foundJava) {
            throw "The verified Temurin archive did not contain bin\java.exe."
        }
        $extractedJdk = Split-Path (Split-Path $foundJava.FullName -Parent) -Parent
        Move-Item -Path $extractedJdk -Destination $jdkRoot

        if ((Get-JavaMajor $javaExe) -ne 17) {
            throw "Bootstrapped Temurin JDK did not report Java 17."
        }
        $env:JAVA_HOME = $jdkRoot
        $env:PATH = "{0};{1}" -f (Join-Path $jdkRoot "bin"), $env:PATH
        Write-Host ("Private Temurin JDK 17 is ready at {0}" -f $jdkRoot) -ForegroundColor Green
    }
    finally {
        Remove-Item -Recurse -Force $extractRoot -ErrorAction SilentlyContinue
        Remove-Item -Force $archivePath -ErrorAction SilentlyContinue
        Remove-Item -Force $metadataPath -ErrorAction SilentlyContinue
    }
}

function Ensure-PinnedFlutter {
    $globalFlutter = Get-CommandSource "flutter"
    if ($null -ne $globalFlutter) {
        $globalVersion = Get-FlutterVersion $globalFlutter
        if ($globalVersion -eq $requiredFlutterVersion) {
            Write-Host ("Using Flutter {0} from PATH: {1}" -f $requiredFlutterVersion, $globalFlutter) -ForegroundColor Green
            return
        }
        if ($null -ne $globalVersion) {
            Write-Host ("Flutter {0} is on PATH, but this release gate is pinned to {1}. A private pinned SDK will be used." -f $globalVersion, $requiredFlutterVersion) -ForegroundColor Yellow
        }
    }

    $toolchainRoot = Join-Path $env:LOCALAPPDATA "SentIQ\toolchains"
    $flutterRoot = Join-Path $toolchainRoot ("flutter-{0}" -f $requiredFlutterVersion)
    $flutterBat = Join-Path $flutterRoot "bin\flutter.bat"

    if ((Test-Path $flutterBat) -and ((Get-FlutterVersion $flutterBat) -eq $requiredFlutterVersion)) {
        $env:PATH = "{0};{1}" -f (Join-Path $flutterRoot "bin"), $env:PATH
        Write-Host ("Using cached SentIQ Flutter {0}: {1}" -f $requiredFlutterVersion, $flutterRoot) -ForegroundColor Green
        return
    }

    if (Test-Path $flutterRoot) { Remove-Item -Recurse -Force $flutterRoot }
    New-Item -ItemType Directory -Force -Path $toolchainRoot | Out-Null
    $archivePath = Join-Path $toolchainRoot ("flutter_windows_{0}-stable.zip" -f $requiredFlutterVersion)
    $extractRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("sentiq-flutter-{0}-{1}" -f $requiredFlutterVersion, [Guid]::NewGuid().ToString("N"))

    try {
        Write-Host ("Flutter {0} was not found. Downloading the official pinned Windows SDK..." -f $requiredFlutterVersion) -ForegroundColor Cyan
        Invoke-Download -Url $flutterArchiveUrl -Destination $archivePath
        $actualHash = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
        if ($actualHash -ne $flutterArchiveSha256) {
            throw ("Downloaded Flutter SDK failed SHA-256 verification. Expected {0}, found {1}." -f $flutterArchiveSha256, $actualHash)
        }
        Write-Host "Flutter archive SHA-256 verified." -ForegroundColor Green

        New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
        Write-Host ("Extracting Flutter {0}. This can take several minutes on Windows." -f $requiredFlutterVersion) -ForegroundColor Cyan
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
        $extractedFlutter = Join-Path $extractRoot "flutter"
        if (!(Test-Path (Join-Path $extractedFlutter "bin\flutter.bat"))) {
            throw "The verified Flutter archive did not extract the expected flutter\bin\flutter.bat."
        }
        Move-Item -Path $extractedFlutter -Destination $flutterRoot

        if ((Get-FlutterVersion $flutterBat) -ne $requiredFlutterVersion) {
            throw ("Bootstrapped Flutter did not report the expected version {0}." -f $requiredFlutterVersion)
        }
        $env:PATH = "{0};{1}" -f (Join-Path $flutterRoot "bin"), $env:PATH
        Write-Host ("Pinned Flutter {0} is ready at {1}" -f $requiredFlutterVersion, $flutterRoot) -ForegroundColor Green
    }
    finally {
        Remove-Item -Recurse -Force $extractRoot -ErrorAction SilentlyContinue
        Remove-Item -Force $archivePath -ErrorAction SilentlyContinue
    }
}

function Confirm-PrivateToolchains {
    $node = Get-CommandSource "node"
    $java = Get-CommandSource "java"
    $flutter = Get-CommandSource "flutter"
    $dart = Get-CommandSource "dart"
    $npm = Get-CommandSource "npm"
    $npx = Get-CommandSource "npx"
    $keytool = Get-CommandSource "keytool"
    $jarsigner = Get-CommandSource "jarsigner"

    if (($null -eq $node) -or ((Get-NodeVersion $node) -ne $requiredNodeVersion)) {
        throw ("Node {0} bootstrap did not become active on PATH." -f $requiredNodeVersion)
    }
    if (($null -eq $java) -or ((Get-JavaMajor $java) -ne 17)) {
        throw "JDK 17 bootstrap did not become active on PATH."
    }
    foreach ($pair in @(
        @{ Name = "npm"; Value = $npm },
        @{ Name = "npx"; Value = $npx },
        @{ Name = "keytool"; Value = $keytool },
        @{ Name = "jarsigner"; Value = $jarsigner },
        @{ Name = "flutter"; Value = $flutter },
        @{ Name = "dart"; Value = $dart }
    )) {
        if ($null -eq $pair.Value) {
            throw ("Required command '{0}' is unavailable after private toolchain bootstrap." -f $pair.Name)
        }
    }
}

try {
    if (!(Test-Path $templatePath)) {
        throw ("Phase 6 verifier template is missing: {0}" -f $templatePath)
    }

    $source = [System.IO.File]::ReadAllText($templatePath)

    $legacy = 'failed for $Serial: $($output -join '' '')'
    $safe = 'failed for ${Serial}: $($output -join '' '')'
    $legacyCount = [regex]::Matches($source, [regex]::Escape($legacy)).Count
    if ($legacyCount -ne 1) {
        throw ("Phase 6 verifier compatibility patch expected exactly one target, found {0}. Refusing to execute an unverified runtime script." -f $legacyCount)
    }
    $source = $source.Replace($legacy, $safe)

    $ambiguous = [regex]::Matches($source, '\$(?!env:|global:|script:|local:|private:|using:)[A-Za-z_][A-Za-z0-9_]*:')
    if ($ambiguous.Count -gt 0) {
        $values = $ambiguous | ForEach-Object { $_.Value } | Sort-Object -Unique
        throw ("Generated verifier still contains ambiguous PowerShell variable interpolation: {0}" -f ($values -join ", "))
    }

    [System.IO.File]::WriteAllText(
        $runtimePath,
        $source,
        (New-Object System.Text.UTF8Encoding($false))
    )

    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $runtimePath,
        [ref]$tokens,
        [ref]$parseErrors
    ) | Out-Null
    if (($parseErrors | Measure-Object).Count -gt 0) {
        $messages = $parseErrors | ForEach-Object {
            "line {0}, column {1}: {2}" -f $_.Extent.StartLineNumber, $_.Extent.StartColumnNumber, $_.Message
        }
        throw ("Phase 6 verifier PowerShell parser preflight failed:`n{0}" -f ($messages -join "`n"))
    }

    Show-HostPreflight
    Ensure-PinnedNode
    Ensure-PinnedJava17
    Ensure-PinnedFlutter
    Confirm-PrivateToolchains

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
    if ($verifierExitCode -ne 0) {
        throw ("Phase 6 verifier failed with exit code {0}." -f $verifierExitCode)
    }
}
finally {
    Remove-Item -Force $runtimePath -ErrorAction SilentlyContinue
}
