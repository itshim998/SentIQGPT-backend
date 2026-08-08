param(
    [switch]$RunEmulators,
    [switch]$SkipBackend,
    [string]$ExpectedHeadSha = "",
    [string]$EvidenceRoot = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$env:CI = "true"
$env:FLUTTER_SUPPRESS_ANALYTICS = "true"
$env:DART_SUPPRESS_ANALYTICS = "true"

$templatePath = Join-Path $PSScriptRoot "phase6_local_release.impl.ps1.txt"
$runtimePath = Join-Path $PSScriptRoot ".phase6_local_release.runtime.ps1"

$requiredFlutterVersion = "3.44.8"
$flutterArchiveUrl = "https://storage.googleapis.com/flutter_infra_release/releases/stable/windows/flutter_windows_3.44.8-stable.zip"
$flutterArchiveSha256 = "095c108a08e0377d8a6501fed65aeb288908a070ed3f135e525dc6431c7686e4"

$requiredNodeVersion = "20.20.2"
$nodeArchiveName = "node-v20.20.2-win-x64.zip"
$nodeArchiveUrl = "https://nodejs.org/dist/v20.20.2/node-v20.20.2-win-x64.zip"
$nodeShasumsUrl = "https://nodejs.org/dist/v20.20.2/SHASUMS256.txt"

$requiredGradleVersion = "9.1.0"
$gradleArchiveName = "gradle-9.1.0-all.zip"
$gradleArchiveUrl = "https://services.gradle.org/distributions/gradle-9.1.0-all.zip"
$gradleArchiveSha256 = "b84e04fa845fecba48551f425957641074fcc00a88a84d2aae5808743b35fc85"

$jdkAssetsUrl = "https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse"

$script:SelectedNodeRoot = $null
$script:SelectedJavaHome = $null
$script:SelectedFlutterRoot = $null
$script:LastFlutterProbe = $null

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

function ConvertTo-NativeArgument([AllowEmptyString()][string]$Value) {
    if ($Value.IndexOf('"') -ge 0) {
        throw "Native command arguments containing quotes are not supported by the Phase 6 runner."
    }
    return '"' + $Value + '"'
}

function Invoke-NativeProcessCapture {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = "",
        [string]$StandardInput = ""
    )

    $process = $null
    try {
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $extension = [System.IO.Path]::GetExtension($FilePath)
        if (($extension -eq ".bat") -or ($extension -eq ".cmd")) {
            if ([string]::IsNullOrWhiteSpace($env:ComSpec)) {
                throw "COMSPEC is unavailable, so Windows batch tools cannot be executed."
            }
            $commandTokens = @((ConvertTo-NativeArgument $FilePath))
            $commandTokens += $Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }
            $startInfo.FileName = $env:ComSpec
            $startInfo.Arguments = '/d /s /c "' + ($commandTokens -join ' ') + '"'
        }
        else {
            $startInfo.FileName = $FilePath
            $startInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
        }
        if (![string]::IsNullOrWhiteSpace($WorkingDirectory)) {
            $startInfo.WorkingDirectory = $WorkingDirectory
        }
        $startInfo.UseShellExecute = $false
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.RedirectStandardInput = ![string]::IsNullOrEmpty($StandardInput)
        $startInfo.CreateNoWindow = $true

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        if (!$process.Start()) { throw "Native process could not be started: $FilePath" }

        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if ($startInfo.RedirectStandardInput) {
            $process.StandardInput.Write($StandardInput)
            $process.StandardInput.Close()
        }
        $process.WaitForExit()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout = $stdout.TrimEnd()
            Stderr = $stderr.TrimEnd()
            Combined = (($stdout + "`n" + $stderr).Trim())
        }
    }
    finally {
        if ($null -ne $process) { $process.Dispose() }
    }
}

function Get-NativeProcessText([string]$FilePath, [string[]]$Arguments) {
    try {
        $result = Invoke-NativeProcessCapture -FilePath $FilePath -Arguments $Arguments
        if ($result.ExitCode -ne 0) { return $null }
        return $result.Combined
    }
    catch { return $null }
}

function Add-ProcessGitSafeDirectory([string]$Directory) {
    $count = 0
    if (![string]::IsNullOrWhiteSpace($env:GIT_CONFIG_COUNT)) {
        if (!([int]::TryParse($env:GIT_CONFIG_COUNT, [ref]$count)) -or ($count -lt 0)) {
            throw "GIT_CONFIG_COUNT is invalid; refusing to overwrite the caller's Git configuration environment."
        }
    }

    for ($index = 0; $index -lt $count; $index++) {
        $key = [Environment]::GetEnvironmentVariable(("GIT_CONFIG_KEY_{0}" -f $index), "Process")
        $value = [Environment]::GetEnvironmentVariable(("GIT_CONFIG_VALUE_{0}" -f $index), "Process")
        if (($key -eq "safe.directory") -and ($value -eq $Directory)) { return }
    }

    [Environment]::SetEnvironmentVariable(("GIT_CONFIG_KEY_{0}" -f $count), "safe.directory", "Process")
    [Environment]::SetEnvironmentVariable(("GIT_CONFIG_VALUE_{0}" -f $count), $Directory, "Process")
    [Environment]::SetEnvironmentVariable("GIT_CONFIG_COUNT", ($count + 1).ToString(), "Process")
}

function Get-JavaMajor([string]$JavaCommand) {
    $text = Get-NativeProcessText -FilePath $JavaCommand -Arguments @("-version")
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }

    $match = [regex]::Match($text, '(?:openjdk|java)\s+version\s+"?([0-9]+)')
    if (!$match.Success) {
        $match = [regex]::Match($text, 'version\s+"?([0-9]+)')
    }
    if (!$match.Success) {
        $match = [regex]::Match($text, '\b([0-9]+)(?:\.[0-9]+){1,3}\b')
    }
    if (!$match.Success) { return $null }
    return [int]$match.Groups[1].Value
}

function Get-NodeVersion([string]$NodeCommand) {
    $text = Get-NativeProcessText -FilePath $NodeCommand -Arguments @("--version")
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    $match = [regex]::Match($text.Trim(), '^v([0-9]+\.[0-9]+\.[0-9]+)$')
    if (!$match.Success) { return $null }
    return $match.Groups[1].Value
}

function Get-FlutterVersion([string]$FlutterCommand) {
    try {
        $script:LastFlutterProbe = Invoke-NativeProcessCapture -FilePath $FlutterCommand -Arguments @("--version")
        if ($script:LastFlutterProbe.ExitCode -ne 0) { return $null }
        $match = [regex]::Match($script:LastFlutterProbe.Combined, 'Flutter\s+([0-9]+\.[0-9]+\.[0-9]+)\b')
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

function Find-GitBash {
    $candidates = New-Object System.Collections.Generic.List[string]
    $git = Get-Command "git.exe" -ErrorAction SilentlyContinue
    if ($null -ne $git) {
        $gitRoot = Split-Path (Split-Path $git.Source -Parent) -Parent
        [void]$candidates.Add((Join-Path $gitRoot "bin\bash.exe"))
        [void]$candidates.Add((Join-Path $gitRoot "usr\bin\bash.exe"))
    }
    $pathBash = Get-Command "bash.exe" -ErrorAction SilentlyContinue
    if ($null -eq $pathBash) { $pathBash = Get-Command "bash" -ErrorAction SilentlyContinue }
    if ($null -ne $pathBash) { [void]$candidates.Add($pathBash.Source) }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (!(Test-Path -LiteralPath $candidate)) { continue }
        try {
            $probe = Invoke-NativeProcessCapture -FilePath $candidate -Arguments @('--version')
            if (($probe.ExitCode -eq 0) -and ($probe.Combined -match 'GNU bash')) { return $candidate }
        }
        catch {}
    }
    return $null
}

function Show-HostPreflight {
    $issues = New-Object System.Collections.Generic.List[string]

    if ($null -eq (Get-Command "git" -ErrorAction SilentlyContinue)) {
        [void]$issues.Add("Git for Windows is required")
    }

    if ($null -eq (Find-GitBash)) { [void]$issues.Add("A working Git Bash installation is required") }

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
            $script:SelectedNodeRoot = Split-Path $existing -Parent
            $env:PATH = "{0};{1}" -f $script:SelectedNodeRoot, $env:PATH
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
        $script:SelectedNodeRoot = $nodeRoot
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
        if (!(Test-Path $shasumsPath)) {
            Invoke-Download -Url $nodeShasumsUrl -Destination $shasumsPath
        }

        $line = Get-Content $shasumsPath | Where-Object { $_ -match ([regex]::Escape($nodeArchiveName) + '$') } | Select-Object -First 1
        if ([string]::IsNullOrWhiteSpace($line)) {
            throw ("Official Node SHASUMS256.txt did not contain {0}." -f $nodeArchiveName)
        }
        $expectedHash = (($line -split '\s+')[0]).ToLowerInvariant()
        if ((Test-Path $archivePath) -and ((Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant() -ne $expectedHash)) {
            Remove-Item -Force $archivePath
        }
        if (!(Test-Path $archivePath)) {
            Write-Host ("Downloading private Node {0} for CI parity..." -f $requiredNodeVersion) -ForegroundColor Cyan
            Invoke-Download -Url $nodeArchiveUrl -Destination $archivePath
        }
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
        $script:SelectedNodeRoot = $nodeRoot
        $env:PATH = "{0};{1}" -f $nodeRoot, $env:PATH
        Write-Host ("Private Node {0} is ready at {1}" -f $requiredNodeVersion, $nodeRoot) -ForegroundColor Green
    }
    finally {
        Remove-Item -Recurse -Force $extractRoot -ErrorAction SilentlyContinue
    }
}

function Ensure-PinnedJava17 {
    $existing = Get-CommandSource "java"
    if (($null -ne $existing) -and ((Get-JavaMajor $existing) -eq 17)) {
        $javaHome = Split-Path (Split-Path $existing -Parent) -Parent
        if ((Test-Path (Join-Path $javaHome "bin\keytool.exe")) -and (Test-Path (Join-Path $javaHome "bin\jarsigner.exe"))) {
            $script:SelectedJavaHome = $javaHome
            $env:JAVA_HOME = $javaHome
            $env:PATH = "{0};{1}" -f (Join-Path $javaHome "bin"), $env:PATH
            Write-Host ("Using JDK 17 from PATH: {0}" -f $existing) -ForegroundColor Green
            return
        }
    }

    $toolchainRoot = Join-Path $env:LOCALAPPDATA "SentIQ\toolchains"
    $jdkRoot = Join-Path $toolchainRoot "temurin-jdk-17"
    $javaExe = Join-Path $jdkRoot "bin\java.exe"

    if ((Test-Path $javaExe) -and ((Get-JavaMajor $javaExe) -eq 17)) {
        $script:SelectedJavaHome = $jdkRoot
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

        if ((Test-Path $archivePath) -and ((Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant() -ne $expectedHash)) {
            Remove-Item -Force $archivePath
        }
        if (!(Test-Path $archivePath)) {
            Write-Host "Downloading private Eclipse Temurin JDK 17..." -ForegroundColor Cyan
            Invoke-Download -Url $downloadUrl -Destination $archivePath
        }
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
        $script:SelectedJavaHome = $jdkRoot
        $env:JAVA_HOME = $jdkRoot
        $env:PATH = "{0};{1}" -f (Join-Path $jdkRoot "bin"), $env:PATH
        Write-Host ("Private Temurin JDK 17 is ready at {0}" -f $jdkRoot) -ForegroundColor Green
    }
    finally {
        Remove-Item -Recurse -Force $extractRoot -ErrorAction SilentlyContinue
    }
}

function Ensure-PinnedFlutter {
    $globalFlutter = Get-CommandSource "flutter"
    if ($null -ne $globalFlutter) {
        $globalFlutterRoot = Split-Path (Split-Path $globalFlutter -Parent) -Parent
        Add-ProcessGitSafeDirectory $globalFlutterRoot
        $globalVersion = Get-FlutterVersion $globalFlutter
        if ($globalVersion -eq $requiredFlutterVersion) {
            $script:SelectedFlutterRoot = $globalFlutterRoot
            $env:PATH = "{0};{1}" -f (Join-Path $globalFlutterRoot "bin"), $env:PATH
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
    Add-ProcessGitSafeDirectory $flutterRoot

    if ((Test-Path $flutterBat) -and ((Get-FlutterVersion $flutterBat) -eq $requiredFlutterVersion)) {
        $script:SelectedFlutterRoot = $flutterRoot
        $env:PATH = "{0};{1}" -f (Join-Path $flutterRoot "bin"), $env:PATH
        Write-Host ("Using cached SentIQ Flutter {0}: {1}" -f $requiredFlutterVersion, $flutterRoot) -ForegroundColor Green
        return
    }

    if ((Test-Path $flutterBat) -and ($null -ne $script:LastFlutterProbe) -and ($script:LastFlutterProbe.ExitCode -ne 0)) {
        throw ("Cached Flutter version probe failed with exit code {0}.`nstdout:`n{1}`nstderr:`n{2}" -f $script:LastFlutterProbe.ExitCode, $script:LastFlutterProbe.Stdout, $script:LastFlutterProbe.Stderr)
    }

    if (Test-Path $flutterRoot) { Remove-Item -Recurse -Force $flutterRoot }
    New-Item -ItemType Directory -Force -Path $toolchainRoot | Out-Null
    $archivePath = Join-Path $toolchainRoot ("flutter_windows_{0}-stable.zip" -f $requiredFlutterVersion)
    $extractRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("sentiq-flutter-{0}-{1}" -f $requiredFlutterVersion, [Guid]::NewGuid().ToString("N"))

    try {
        if ((Test-Path $archivePath) -and ((Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant() -ne $flutterArchiveSha256)) {
            Remove-Item -Force $archivePath
        }
        if (!(Test-Path $archivePath)) {
            Write-Host ("Flutter {0} was not found. Downloading the official pinned Windows SDK..." -f $requiredFlutterVersion) -ForegroundColor Cyan
            Invoke-Download -Url $flutterArchiveUrl -Destination $archivePath
        }
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
            $exitCode = if ($null -eq $script:LastFlutterProbe) { "not started" } else { $script:LastFlutterProbe.ExitCode }
            $stdout = if ($null -eq $script:LastFlutterProbe) { "" } else { $script:LastFlutterProbe.Stdout }
            $stderr = if ($null -eq $script:LastFlutterProbe) { "" } else { $script:LastFlutterProbe.Stderr }
            throw ("Bootstrapped Flutter did not report {0} (exit {1}).`nstdout:`n{2}`nstderr:`n{3}" -f $requiredFlutterVersion, $exitCode, $stdout, $stderr)
        }
        $script:SelectedFlutterRoot = $flutterRoot
        $env:PATH = "{0};{1}" -f (Join-Path $flutterRoot "bin"), $env:PATH
        Write-Host ("Pinned Flutter {0} is ready at {1}" -f $requiredFlutterVersion, $flutterRoot) -ForegroundColor Green
    }
    finally {
        Remove-Item -Recurse -Force $extractRoot -ErrorAction SilentlyContinue
    }
}

function Confirm-PrivateToolchains {
    if ([string]::IsNullOrWhiteSpace($script:SelectedNodeRoot)) { throw "Pinned Node root was not selected." }
    if ([string]::IsNullOrWhiteSpace($script:SelectedJavaHome)) { throw "Pinned JDK home was not selected." }
    if ([string]::IsNullOrWhiteSpace($script:SelectedFlutterRoot)) { throw "Pinned Flutter root was not selected." }

    $commands = [ordered]@{
        node = Join-Path $script:SelectedNodeRoot "node.exe"
        npm = Join-Path $script:SelectedNodeRoot "npm.cmd"
        npx = Join-Path $script:SelectedNodeRoot "npx.cmd"
        java = Join-Path $script:SelectedJavaHome "bin\java.exe"
        keytool = Join-Path $script:SelectedJavaHome "bin\keytool.exe"
        jarsigner = Join-Path $script:SelectedJavaHome "bin\jarsigner.exe"
        flutter = Join-Path $script:SelectedFlutterRoot "bin\flutter.bat"
        dart = Join-Path $script:SelectedFlutterRoot "bin\dart.bat"
    }
    foreach ($entry in $commands.GetEnumerator()) {
        if (!(Test-Path -LiteralPath $entry.Value)) {
            throw ("Selected {0} executable is missing: {1}" -f $entry.Key, $entry.Value)
        }
    }

    if ((Get-NodeVersion $commands.node) -ne $requiredNodeVersion) {
        throw ("Selected Node executable is not version {0}: {1}" -f $requiredNodeVersion, $commands.node)
    }
    if ((Get-JavaMajor $commands.java) -ne 17) {
        throw ("Selected Java executable is not JDK 17: {0}" -f $commands.java)
    }
    if ((Get-FlutterVersion $commands.flutter) -ne $requiredFlutterVersion) {
        throw ("Selected Flutter executable is not version {0}: {1}" -f $requiredFlutterVersion, $commands.flutter)
    }

    $probes = @(
        @{ Name = "dart"; Path = $commands.dart; Arguments = @("--version") },
        @{ Name = "npm"; Path = $commands.npm; Arguments = @("--version") },
        @{ Name = "npx"; Path = $commands.npx; Arguments = @("--version") },
        @{ Name = "keytool"; Path = $commands.keytool; Arguments = @("-help") },
        @{ Name = "jarsigner"; Path = $commands.jarsigner; Arguments = @("-help") }
    )
    $probeResults = @{}
    foreach ($probe in $probes) {
        $result = Invoke-NativeProcessCapture -FilePath $probe.Path -Arguments $probe.Arguments
        if ($result.ExitCode -ne 0) {
            throw ("Selected {0} probe failed with exit code {1}: {2}" -f $probe.Name, $result.ExitCode, $result.Combined)
        }
        $probeResults[$probe.Name] = $result.Combined
    }
    if ($probeResults.dart -notmatch 'Dart SDK version:\s+([0-9]+\.[0-9]+\.[0-9]+)') {
        throw ("Selected Dart executable did not report an SDK version: {0}" -f $probeResults.dart)
    }

    $env:SENTIQ_PINNED_NODE_ROOT = $script:SelectedNodeRoot
    $env:SENTIQ_PINNED_JAVA_HOME = $script:SelectedJavaHome
    $env:SENTIQ_PINNED_FLUTTER_ROOT = $script:SelectedFlutterRoot

    Write-Host ("Validated Node {0}: {1}" -f $requiredNodeVersion, $commands.node) -ForegroundColor Green
    Write-Host ("Validated npm {0} and npx {1} from the selected Node root." -f $probeResults.npm, $probeResults.npx) -ForegroundColor Green
    Write-Host ("Validated JDK 17, keytool, and jarsigner: {0}" -f $script:SelectedJavaHome) -ForegroundColor Green
    Write-Host ("Validated Flutter {0} with {1}: {2}" -f $requiredFlutterVersion, ($probeResults.dart -split "`r?`n")[0], $commands.flutter) -ForegroundColor Green
}

function Ensure-PinnedGradleArchive {
    $toolchainRoot = Join-Path $env:LOCALAPPDATA "SentIQ\toolchains"
    New-Item -ItemType Directory -Force -Path $toolchainRoot | Out-Null
    $archivePath = Join-Path $toolchainRoot $gradleArchiveName

    if ((Test-Path $archivePath) -and ((Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant() -ne $gradleArchiveSha256)) {
        Remove-Item -Force $archivePath
    }
    if (!(Test-Path $archivePath)) {
        Write-Host ("Downloading the official Gradle {0} distribution for the local wrapper cache..." -f $requiredGradleVersion) -ForegroundColor Cyan
        Invoke-Download -Url $gradleArchiveUrl -Destination $archivePath
    }

    $actualHash = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
    if ($actualHash -ne $gradleArchiveSha256) {
        throw ("Gradle archive SHA-256 mismatch. Expected {0}, found {1}." -f $gradleArchiveSha256, $actualHash)
    }
    $env:SENTIQ_PINNED_GRADLE_ARCHIVE = $archivePath
    $env:SENTIQ_PINNED_GRADLE_URL = $gradleArchiveUrl
    $env:SENTIQ_PINNED_GRADLE_SHA256 = $gradleArchiveSha256
    Write-Host ("Gradle {0} archive SHA-256 verified and cached: {1}" -f $requiredGradleVersion, $archivePath) -ForegroundColor Green
}

function Configure-PrivateFlutterState {
    $stateRoot = Join-Path $env:LOCALAPPDATA "SentIQ\flutter-state"
    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
    $env:APPDATA = $stateRoot

    $flutter = Join-Path $script:SelectedFlutterRoot "bin\flutter.bat"
    $result = Invoke-NativeProcessCapture -FilePath $flutter -Arguments @("config", "--jdk-dir", $script:SelectedJavaHome)
    if ($result.ExitCode -ne 0) {
        throw ("Could not bind the private Flutter configuration to the selected JDK (exit {0}): {1}" -f $result.ExitCode, $result.Combined)
    }

    $configPath = Join-Path $stateRoot ".flutter_settings"
    if (!(Test-Path $configPath)) { throw "Flutter did not create its private configuration file: $configPath" }
    $config = Get-Content -Raw $configPath | ConvertFrom-Json
    if ([string]$config.'jdk-dir' -ne $script:SelectedJavaHome) {
        throw ("Private Flutter configuration did not retain the selected JDK. Expected {0}, found {1}." -f $script:SelectedJavaHome, $config.'jdk-dir')
    }
    $env:SENTIQ_FLUTTER_APPDATA = $stateRoot
    Write-Host ("Flutter Android builds are bound to the selected Temurin JDK through private process state: {0}" -f $stateRoot) -ForegroundColor Green
}

try {
    if (!(Test-Path $templatePath)) {
        throw ("Phase 6 verifier template is missing: {0}" -f $templatePath)
    }

    $source = [System.IO.File]::ReadAllText($templatePath)

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
    Ensure-PinnedGradleArchive
    Configure-PrivateFlutterState

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
