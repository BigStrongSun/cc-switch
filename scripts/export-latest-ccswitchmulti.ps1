param(
    [string]$ReleaseRoot = "",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

# Resolve the repository root. This script may be called from any directory.
function Get-RepoRoot {
    $scriptDir = Split-Path -Parent $PSCommandPath
    return (Resolve-Path (Join-Path $scriptDir "..")).Path
}

# Build the requested Chinese export directory name without relying on source-file encoding.
function Get-DefaultExportFolderName {
    return @([char]0x6700, [char]0x65B0, [char]0x7248, "ccswitchmulti") -join ""
}

# Resolve the final export directory. By default it sits under the LLMservice root.
function Get-ExportRoot {
    param([string]$RepoRoot, [string]$RequestedRoot)

    if (-not [string]::IsNullOrWhiteSpace($RequestedRoot)) {
        return $RequestedRoot
    }

    $workspaceRoot = Split-Path -Parent $RepoRoot
    return Join-Path $workspaceRoot (Get-DefaultExportFolderName)
}

# Copy matched build artifacts and return the copied file count.
function Copy-Artifacts {
    param(
        [string]$Pattern,
        [string]$Destination
    )

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $items = @(Get-ChildItem -Path $Pattern -File -ErrorAction SilentlyContinue)
    foreach ($item in $items) {
        Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $Destination $item.Name) -Force
    }
    return $items.Count
}

# Clear release output without failing the whole export when an old exe is still running.
function Clear-ExportRoot {
    param([string]$Root)

    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    $items = @(Get-ChildItem -LiteralPath $Root -Force -ErrorAction SilentlyContinue)
    foreach ($item in $items) {
        try {
            Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop
        } catch {
            Write-Warning "Could not remove old release item '$($item.FullName)': $($_.Exception.Message)"
        }
    }
}

# Copy the raw exe while tolerating the common case where the stable alias is still running.
function Copy-RawExe {
    param(
        [string]$SourceExe,
        [string]$Destination,
        [string]$Version
    )

    if (-not (Test-Path -LiteralPath $SourceExe)) {
        return
    }

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $versionedName = "CCSwitchMulti_$Version`_x64.exe"
    Copy-Item -LiteralPath $SourceExe -Destination (Join-Path $Destination $versionedName) -Force

    $stablePath = Join-Path $Destination "CCSwitchMulti.exe"
    try {
        Copy-Item -LiteralPath $SourceExe -Destination $stablePath -Force -ErrorAction Stop
        Remove-Item -LiteralPath (Join-Path $Destination "RAW_EXE_ALIAS_LOCKED.txt") -Force -ErrorAction SilentlyContinue
    } catch {
        $note = @(
            "CCSwitchMulti.exe could not be replaced because it is probably running.",
            "The fresh raw executable was still exported as $versionedName.",
            "Close the running app and rerun the export if you need the stable alias updated.",
            "Error: $($_.Exception.Message)"
        ) -join "`r`n"
        Set-Content -LiteralPath (Join-Path $Destination "RAW_EXE_ALIAS_LOCKED.txt") -Value $note -Encoding UTF8
        Write-Warning $note
    }
}

# Copy the standalone Codex history repair Python tool.
function Copy-HistoryRepairPythonTool {
    param(
        [string]$SourceDir,
        [string]$Destination
    )

    if (-not (Test-Path -LiteralPath (Join-Path $SourceDir "codex_history_tool.py"))) {
        Write-Warning "Codex history Python tool was not found: $SourceDir"
        return
    }

    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem -LiteralPath $SourceDir -Force |
        Where-Object { $_.Name -ne "__pycache__" -and $_.Extension -ne ".pyc" } |
        ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
        }
}

# Detect a local Tauri signing key when one is available outside the repository.
function Initialize-TauriSigningKey {
    param([string]$DefaultKeyPath)

    if (-not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)) {
        return $true
    }
    if (-not (Test-Path -LiteralPath $DefaultKeyPath)) {
        return $false
    }

    Write-Host "Using local Tauri updater signing key: $DefaultKeyPath"
    return $true
}

# Sign exported Windows setup manually. This avoids the Tauri build-time updater
# signer path hanging while still producing the .sig required by latest.json.
function Write-TauriSetupSignature {
    param(
        [string]$RepoRoot,
        [string]$SetupPath,
        [string]$SigningKeyPath
    )

    if (-not (Test-Path -LiteralPath $SetupPath)) {
        Write-Warning "setup signature skipped because the setup exe was not found: $SetupPath"
        return $false
    }
    if (-not (Test-Path -LiteralPath $SigningKeyPath)) {
        Write-Warning "setup signature skipped because the Tauri signing key was not found: $SigningKeyPath"
        return $false
    }

    Push-Location $RepoRoot
    try {
        $signatureOutput = pnpm tauri signer sign --private-key-path $SigningKeyPath --password= $SetupPath
        if ($LASTEXITCODE -ne 0) {
            throw "tauri signer failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }

    $sigPath = "$SetupPath.sig"
    if (Test-Path -LiteralPath $sigPath) {
        $writtenSignature = (Get-Content -LiteralPath $sigPath -Raw).Trim()
        if (-not [string]::IsNullOrWhiteSpace($writtenSignature)) {
            return $true
        }
    }

    $signature = ""
    for ($index = 0; $index -lt $signatureOutput.Count; $index++) {
        if ([string]$signatureOutput[$index] -eq "Public signature:" -and ($index + 1) -lt $signatureOutput.Count) {
            $signature = ([string]$signatureOutput[$index + 1]).Trim()
            break
        }
    }
    if ([string]::IsNullOrWhiteSpace($signature)) {
        throw "tauri signer returned an empty signature for $SetupPath"
    }
    Set-Content -LiteralPath $sigPath -Value $signature -Encoding UTF8
    return $true
}

# Write a clear note for platforms that cannot be built on the current host.
function Write-PlatformNote {
    param(
        [string]$Path,
        [string]$Platform,
        [string]$Reason
    )

    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $content = @(
        "# $Platform build note",
        "",
        $Reason,
        "",
        "This directory was generated by scripts/export-latest-ccswitchmulti.ps1.",
        "Build this platform on its native OS, or configure a complete cross-compile toolchain, then run the same export script."
    ) -join "`r`n"
    Set-Content -LiteralPath (Join-Path $Path "BUILD_ON_PLATFORM.md") -Value $content -Encoding UTF8
}

# Write SHA256 checksums for all exported artifacts.
function Write-Checksums {
    param([string]$Root)

    $files = @(Get-ChildItem -Path $Root -Recurse -File | Where-Object { $_.Name -ne "SHA256SUMS.txt" })
    $lines = foreach ($file in $files) {
        $hash = Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256
        $relative = $file.FullName.Substring($Root.Length).TrimStart("\", "/")
        "$($hash.Hash)  $relative"
    }
    Set-Content -LiteralPath (Join-Path $Root "SHA256SUMS.txt") -Value ($lines -join "`r`n") -Encoding UTF8
}

# Write the root release README so testers know which artifact to use.
function Write-ReleaseReadme {
    param(
        [string]$Root,
        [string]$Version
    )

    $content = @(
        "# Latest CCSwitchMulti",
        "",
        "Version: $Version",
        "",
        "Directories:",
        "- windows/installer: Windows installers, including NSIS setup and MSI when available.",
        "- windows/portable: Windows portable zip. Unzip and run the executable.",
        "- windows/raw-exe: Raw Tauri release executable for quick local verification.",
        "- tools/codex-history-tool: Standalone Python script for listing and repairing Codex Desktop history visibility.",
        "- linux and macos: Build notes when this Windows host cannot produce native artifacts.",
        "- latest.json: Tauri updater index when updater signatures are available.",
        "- SHA256SUMS.txt: SHA256 checksums for exported files.",
        "",
        "Note: the portable build still stores app data under the user's normal system app-data directory."
    ) -join "`r`n"
    Set-Content -LiteralPath (Join-Path $Root "README.md") -Value $content -Encoding UTF8
}

# Write the Tauri updater index for the current Windows release asset.
function Write-LatestJson {
    param(
        [string]$Root,
        [string]$Version,
        [string]$Repo
    )

    $installerDir = Join-Path $Root "windows\installer"
    $setup = Get-ChildItem -LiteralPath $installerDir -Filter "CCSwitchMulti_$Version`_x64-setup.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $setup) {
        Write-Warning "latest.json skipped because the Windows setup exe was not exported."
        return
    }

    $sigPath = "$($setup.FullName).sig"
    if (-not (Test-Path -LiteralPath $sigPath)) {
        Write-Warning "latest.json skipped because the Windows setup signature was not exported: $sigPath"
        return
    }

    $signature = (Get-Content -LiteralPath $sigPath -Raw).Trim()
    $tag = "v$Version"
    $assetUrl = "https://github.com/$Repo/releases/download/$tag/$($setup.Name)"
    $payload = [ordered]@{
        version = $Version
        notes = "CCSwitchMulti $tag"
        pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        platforms = [ordered]@{
            "windows-x86_64" = [ordered]@{
                signature = $signature
                url = $assetUrl
            }
        }
    }
    $json = $payload | ConvertTo-Json -Depth 8
    Set-Content -LiteralPath (Join-Path $Root "latest.json") -Value $json -Encoding UTF8
}

$repoRoot = Get-RepoRoot
$exportRoot = Get-ExportRoot -RepoRoot $repoRoot -RequestedRoot $ReleaseRoot
$tauriDir = Join-Path $repoRoot "src-tauri"
$releaseDir = Join-Path $tauriDir "target\release"
$bundleDir = Join-Path $releaseDir "bundle"
$packageJson = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
$githubRepo = "BigStrongSun/cc-switch"
$defaultSigningKeyPath = Join-Path $env:USERPROFILE ".ccswitchmulti\tauri-update.key"
$hasUpdaterSigningKey = Initialize-TauriSigningKey -DefaultKeyPath $defaultSigningKeyPath

if (-not $SkipBuild) {
    Push-Location $repoRoot
    $buildConfig = New-TemporaryFile
    try {
        if (-not $hasUpdaterSigningKey) {
            Write-Warning "Tauri updater signing key was not found. Building without updater signatures."
        }
        $override = @{
            bundle = @{
                createUpdaterArtifacts = $false
            }
        } | ConvertTo-Json -Depth 8
        Set-Content -LiteralPath $buildConfig.FullName -Value $override -Encoding UTF8
        pnpm tauri build --bundles nsis --config $buildConfig.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "tauri build failed with exit code $LASTEXITCODE"
        }
    } finally {
        Remove-Item -LiteralPath $buildConfig.FullName -Force -ErrorAction SilentlyContinue
        Pop-Location
    }
}

Clear-ExportRoot -Root $exportRoot

$windowsInstaller = Join-Path $exportRoot "windows\installer"
$windowsPortable = Join-Path $exportRoot "windows\portable"
$windowsRawExe = Join-Path $exportRoot "windows\raw-exe"
$historyTool = Join-Path $exportRoot "tools\codex-history-tool"

$currentSetupPattern = Join-Path $bundleDir "nsis\CCSwitchMulti_$version`_x64-setup.exe"
Copy-Artifacts -Pattern $currentSetupPattern -Destination $windowsInstaller | Out-Null
# bundle 目录里可能残留旧版本签名；这里只复制当前安装包匹配的签名。
Copy-Artifacts -Pattern "$currentSetupPattern.sig" -Destination $windowsInstaller | Out-Null
if ($hasUpdaterSigningKey) {
    $exportedSetup = Join-Path $windowsInstaller "CCSwitchMulti_$version`_x64-setup.exe"
    Write-TauriSetupSignature -RepoRoot $repoRoot -SetupPath $exportedSetup -SigningKeyPath $defaultSigningKeyPath | Out-Null
}

$sourceExe = Join-Path $releaseDir "cc-switch.exe"
if (Test-Path -LiteralPath $sourceExe) {
    $stage = Join-Path $windowsPortable "CCSwitchMulti_portable_stage"
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Copy-Item -LiteralPath $sourceExe -Destination (Join-Path $stage "CCSwitchMulti.exe") -Force
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath (Join-Path $windowsPortable "CCSwitchMulti_$version`_x64-portable.zip") -Force
    Remove-Item -LiteralPath $stage -Recurse -Force
}

Copy-RawExe -SourceExe $sourceExe -Destination $windowsRawExe -Version $version
Copy-HistoryRepairPythonTool -SourceDir (Join-Path $repoRoot "scripts\codex-history-tool") -Destination $historyTool

Write-PlatformNote -Path (Join-Path $exportRoot "linux") -Platform "Linux" -Reason "Run pnpm tauri build on a Linux host with Rust, Node/pnpm, and Tauri WebKit/GTK dependencies installed, then run this export script."
Write-PlatformNote -Path (Join-Path $exportRoot "macos") -Platform "macOS" -Reason "Run pnpm tauri build on a macOS host with Xcode Command Line Tools, Rust, and Node/pnpm installed, then run this export script."
Copy-Item -LiteralPath (Join-Path $exportRoot "linux\BUILD_ON_PLATFORM.md") -Destination (Join-Path $exportRoot "linux-build-note.md") -Force
Copy-Item -LiteralPath (Join-Path $exportRoot "macos\BUILD_ON_PLATFORM.md") -Destination (Join-Path $exportRoot "macos-build-note.md") -Force
Write-ReleaseReadme -Root $exportRoot -Version $version
if ($hasUpdaterSigningKey) {
    Write-LatestJson -Root $exportRoot -Version $version -Repo $githubRepo
}
Write-Checksums -Root $exportRoot

Write-Host "Exported CCSwitchMulti release artifacts to: $exportRoot"
