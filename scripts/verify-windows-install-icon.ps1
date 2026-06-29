param(
    [string]$RepoRoot = "",
    [string]$InstallDir = "",
    [string]$AppName = "CCSwitchMulti",
    [string]$ExeName = "cc-switch.exe"
)

$ErrorActionPreference = "Stop"

# 解析仓库根目录，允许脚本从任意当前目录启动。
function Get-RepoRoot {
    param([string]$RequestedRoot)

    if (-not [string]::IsNullOrWhiteSpace($RequestedRoot)) {
        return (Resolve-Path -LiteralPath $RequestedRoot).Path
    }

    $scriptDir = Split-Path -Parent $PSCommandPath
    $rootPath = Join-Path $scriptDir ".."
    return (Resolve-Path -LiteralPath $rootPath).Path
}

# 解析安装目录；默认使用 NSIS per-user 安装路径。
function Get-InstallDir {
    param([string]$RequestedInstallDir, [string]$AppName)

    if (-not [string]::IsNullOrWhiteSpace($RequestedInstallDir)) {
        return (Resolve-Path -LiteralPath $RequestedInstallDir).Path
    }

    return (Join-Path $env:LOCALAPPDATA $AppName)
}

# 把 ico/exe 的关联图标提取成 PNG hash，用于比对资源是否真的一致。
function Get-AssociatedIconHash {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "icon source does not exist: $Path"
    }

    Add-Type -AssemblyName System.Drawing
    $tempPath = Join-Path $env:TEMP ("ccswitch-icon-{0}.png" -f ([guid]::NewGuid().ToString("N")))
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Path)
    if ($null -eq $icon) {
        throw "failed to extract associated icon: $Path"
    }

    try {
        $bitmap = $icon.ToBitmap()
        try {
            $bitmap.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $bitmap.Dispose()
        }
        return (Get-FileHash -LiteralPath $tempPath -Algorithm SHA256).Hash
    } finally {
        $icon.Dispose()
        Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
}

# 读取 Windows 快捷方式，验证目标和显式图标都指向安装目录里的新版 exe。
function Assert-ShortcutIcon {
    param(
        [string]$ShortcutPath,
        [string]$ExpectedTarget,
        [bool]$Required
    )

    if (-not (Test-Path -LiteralPath $ShortcutPath)) {
        if ($Required) {
            throw "required shortcut does not exist: $ShortcutPath"
        }
        return [pscustomobject]@{
            Path = $ShortcutPath
            Status = "missing-optional"
            TargetPath = ""
            IconLocation = ""
        }
    }

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $expectedIcon = "$ExpectedTarget,0"
    if ($shortcut.TargetPath -ne $ExpectedTarget) {
        throw "shortcut target mismatch: $ShortcutPath target=$($shortcut.TargetPath) expected=$ExpectedTarget"
    }
    if ($shortcut.IconLocation -ne $expectedIcon) {
        throw "shortcut icon mismatch: $ShortcutPath icon=$($shortcut.IconLocation) expected=$expectedIcon"
    }

    return [pscustomobject]@{
        Path = $ShortcutPath
        Status = "ok"
        TargetPath = $shortcut.TargetPath
        IconLocation = $shortcut.IconLocation
    }
}

$repoRootResolved = Get-RepoRoot -RequestedRoot $RepoRoot
$installDirResolved = Get-InstallDir -RequestedInstallDir $InstallDir -AppName $AppName
$sourceIcon = Join-Path $repoRootResolved "src-tauri\icons\icon.ico"
$installedExe = Join-Path $installDirResolved $ExeName

if (-not (Test-Path -LiteralPath $installedExe)) {
    throw "installed exe does not exist: $installedExe"
}

$sourceHash = Get-AssociatedIconHash -Path $sourceIcon
$installedHash = Get-AssociatedIconHash -Path $installedExe
if ($sourceHash -ne $installedHash) {
    throw "installed exe icon does not match source icon: source=$sourceHash installed=$installedHash"
}

$startMenuLink = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$AppName.lnk"
$desktopLink = Join-Path $env:USERPROFILE "Desktop\$AppName.lnk"
$taskbarLink = Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\$AppName.lnk"
$shortcutResults = @(
    (Assert-ShortcutIcon -ShortcutPath $startMenuLink -ExpectedTarget $installedExe -Required $true)
    (Assert-ShortcutIcon -ShortcutPath $desktopLink -ExpectedTarget $installedExe -Required $false)
    (Assert-ShortcutIcon -ShortcutPath $taskbarLink -ExpectedTarget $installedExe -Required $false)
)

[pscustomobject]@{
    Status = "ok"
    SourceIcon = $sourceIcon
    InstalledExe = $installedExe
    SourceIconHash = $sourceHash
    InstalledIconHash = $installedHash
    Shortcuts = $shortcutResults
} | ConvertTo-Json -Depth 5

