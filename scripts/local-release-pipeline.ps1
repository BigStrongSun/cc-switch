param(
    [string]$ReleaseRoot = "",
    [switch]$SkipBuild,
    [switch]$NoTypecheck,
    [string]$Reason = "manual"
)

$ErrorActionPreference = "Stop"

# Resolve the repository root for hook, terminal, and scheduled calls.
function Get-RepoRoot {
    $scriptDir = Split-Path -Parent $PSCommandPath
    return (Resolve-Path (Join-Path $scriptDir "..")).Path
}

# Build the default Chinese release folder name from char codes to avoid source encoding issues.
function Get-DefaultReleaseRoot {
    param([string]$RepoRoot)

    $workspaceRoot = Split-Path -Parent $RepoRoot
    $folderName = @([char]0x6700, [char]0x65B0, [char]0x7248, "ccswitchmulti") -join ""
    return Join-Path $workspaceRoot $folderName
}

# Write timestamped log lines so post-commit background failures are traceable.
function Write-Log {
    param([string]$Message)

    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Write-Host $line
}

# Run a command and stop the pipeline with a clear error when it fails.
function Invoke-CheckedCommand {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )

    Write-Log ("RUN {0} {1}" -f $FilePath, ($Arguments -join " "))
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE"
    }
}

# Create a lock file so repeated commits cannot run multiple Tauri builds at the same time.
function Enter-PipelineLock {
    param([string]$LockPath)

    if (Test-Path -LiteralPath $LockPath) {
        $lockAge = (Get-Date) - (Get-Item -LiteralPath $LockPath).LastWriteTime
        if ($lockAge.TotalHours -lt 6) {
            throw "local release pipeline is already running. Lock: $LockPath"
        }
        Remove-Item -LiteralPath $LockPath -Force
    }

    New-Item -ItemType File -Path $LockPath -Force -Value (Get-Date).ToString("o") | Out-Null
}

# Write release metadata into the export folder so the artifact can be traced to a commit.
function Write-ReleaseMetadata {
    param(
        [string]$Root,
        [string]$RepoRoot,
        [string]$Reason
    )

    $commit = (& git -C $RepoRoot rev-parse HEAD).Trim()
    $branch = (& git -C $RepoRoot rev-parse --abbrev-ref HEAD).Trim()
    $packageJson = Get-Content -LiteralPath (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
    $metadata = @(
        "# Local Release Metadata",
        "",
        "Reason: $Reason",
        "Branch: $branch",
        "Commit: $commit",
        "Version: $($packageJson.version)",
        "GeneratedAt: $(Get-Date -Format o)"
    ) -join "`r`n"

    Set-Content -LiteralPath (Join-Path $Root "RELEASE-METADATA.md") -Value $metadata -Encoding UTF8
}

$repoRoot = Get-RepoRoot
$releaseRoot = if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    Get-DefaultReleaseRoot -RepoRoot $repoRoot
} else {
    $ReleaseRoot
}
$logDir = Join-Path $repoRoot "scripts\logs"
$lockPath = Join-Path $logDir "local-release.lock"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

try {
    Enter-PipelineLock -LockPath $lockPath
    Push-Location $repoRoot

    Write-Log "Local release pipeline started. reason=$Reason target=$releaseRoot"

    if (-not $NoTypecheck) {
        Invoke-CheckedCommand -FilePath "pnpm" -Arguments @("typecheck")
    }

    $exportArgs = @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts/export-latest-ccswitchmulti.ps1",
        "-ReleaseRoot",
        $releaseRoot
    )
    if ($SkipBuild) {
        $exportArgs += "-SkipBuild"
    }

    Invoke-CheckedCommand -FilePath "powershell" -Arguments $exportArgs
    Write-ReleaseMetadata -Root $releaseRoot -RepoRoot $repoRoot -Reason $Reason

    Write-Log "Local release pipeline completed. Artifacts exported to: $releaseRoot"
} finally {
    Pop-Location -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
