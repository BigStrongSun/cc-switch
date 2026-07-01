param(
    [string]$OutputRoot = "",
    [int]$LogTailLines = 800,
    [string]$Trace = "",
    [int]$SinceMinutes = 0,
    [switch]$Follow,
    [int]$FollowSeconds = 90
)

$ErrorActionPreference = "Stop"

# 返回仓库根目录，便于脚本从任意工作目录启动时仍能稳定写入默认输出目录。
function Get-RepoRoot {
    $scriptDir = Split-Path -Parent $PSCommandPath
    return (Resolve-Path (Join-Path $scriptDir "..")).Path
}

# 为一次诊断创建独立输出目录，避免覆盖上一次证据。
function New-DiagnosticOutputDir {
    param([string]$Root)

    if ([string]::IsNullOrWhiteSpace($Root)) {
        $Root = Join-Path (Get-RepoRoot) "scripts/logs/codex-oauth-diagnostics"
    }
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $dir = Join-Path $Root $stamp
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    return (Resolve-Path $dir).Path
}

# 判断字段名是否包含敏感认证语义，后续只保留长度和哈希，不输出明文。
function Test-SensitiveName {
    param([string]$Name)

    if ([string]::IsNullOrWhiteSpace($Name)) {
        return $false
    }
    return $Name -match '(?i)(token|secret|api[_-]?key|authorization|bearer|cookie|session_token|refresh|access|account[_-]?id|chatgpt[-_]?account)'
}

# 对敏感值只输出长度和短哈希；非敏感值原样保留，方便定位 provider/model/route。
function Protect-ScalarValue {
    param(
        [string]$Name,
        [object]$Value
    )

    if ($null -eq $Value) {
        return $null
    }
    $text = [string]$Value
    if ((Test-SensitiveName $Name) -or $text -match '(?i)^bearer\s+' -or $text -match '^sk-[A-Za-z0-9]') {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $hash = $sha.ComputeHash($bytes)
        $sha.Dispose()
        $hex = -join ($hash | ForEach-Object { $_.ToString("x2") })
        return @{
            present = $true
            length = $text.Length
            sha256_prefix = $hex.Substring(0, 12)
        }
    }
    return $Value
}

# 递归清洗 JSON/TOML 派生对象，保留结构但移除 token 明文。
function Protect-ObjectTree {
    param(
        [string]$Name,
        [object]$Value
    )

    if ($null -eq $Value) {
        return $null
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $result = [ordered]@{}
        foreach ($key in $Value.Keys) {
            $result[$key] = Protect-ObjectTree -Name ([string]$key) -Value $Value[$key]
        }
        return $result
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $result = [ordered]@{}
        foreach ($prop in $Value.PSObject.Properties) {
            $result[$prop.Name] = Protect-ObjectTree -Name $prop.Name -Value $prop.Value
        }
        return $result
    }
    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        $items = @()
        foreach ($item in $Value) {
            $items += Protect-ObjectTree -Name $Name -Value $item
        }
        return $items
    }
    return Protect-ScalarValue -Name $Name -Value $Value
}

# 清洗 config.toml 文本中的 provider scoped token 或其它认证字段。
function Protect-ConfigText {
    param([string]$Text)

    $lines = @()
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match '^\s*([^#=\s]+)\s*=\s*"(.*)"\s*$') {
            $name = $Matches[1]
            $value = $Matches[2]
            if ((Test-SensitiveName $name) -and $value -ne "PROXY_MANAGED") {
                $safe = Protect-ScalarValue -Name $name -Value $value
                $lines += ('{0} = "<redacted len={1} sha256={2}>"' -f $name, $safe.length, $safe.sha256_prefix)
                continue
            }
        }
        $lines += $line
    }
    return ($lines -join [Environment]::NewLine)
}

# 读取 auth.json 并输出结构化元数据；无法解析时保留错误，不阻塞其它证据采集。
function Get-AuthMetadata {
    param([string]$AuthPath)

    if (-not (Test-Path -LiteralPath $AuthPath)) {
        return @{ exists = $false; path = $AuthPath }
    }
    $item = Get-Item -LiteralPath $AuthPath
    try {
        $json = Get-Content -LiteralPath $AuthPath -Raw | ConvertFrom-Json
        return @{
            exists = $true
            path = $AuthPath
            length = $item.Length
            last_write_time = $item.LastWriteTime.ToString("o")
            metadata = Protect-ObjectTree -Name "auth" -Value $json
        }
    } catch {
        return @{
            exists = $true
            path = $AuthPath
            length = $item.Length
            last_write_time = $item.LastWriteTime.ToString("o")
            parse_error = $_.Exception.Message
        }
    }
}

# 解析 codex-router.log 的单行 key=value 结构，便于按 trace/status/capacity 过滤。
function ConvertFrom-RouterLogLine {
    param([string]$Line)

    $trimmed = $Line.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        return $null
    }
    $eventIndex = $trimmed.IndexOf(" event=")
    if ($eventIndex -ge 0) {
        $timestamp = $trimmed.Substring(0, $eventIndex)
        $payload = $trimmed.Substring($eventIndex + 1)
    } else {
        $timestamp = "<unknown>"
        $payload = $trimmed
    }

    $record = [ordered]@{ timestamp = $timestamp; raw = $trimmed }
    foreach ($part in ($payload -split '\s+')) {
        $pair = $part.Split("=", 2)
        if ($pair.Count -eq 2) {
            $record[$pair[0]] = $pair[1]
        }
    }
    return [pscustomobject]$record
}

# 从 router log 中筛出与本次排查相关的事件，保持原始 raw 行方便回溯。
function Select-RouterEvents {
    param(
        [string]$LogPath,
        [int]$TailLines,
        [string]$TraceFilter,
        [int]$SinceMinutesFilter
    )

    if (-not (Test-Path -LiteralPath $LogPath)) {
        return @()
    }
    $lines = Get-Content -LiteralPath $LogPath -Tail $TailLines
    $events = @()
    foreach ($line in $lines) {
        $event = ConvertFrom-RouterLogLine -Line $line
        if ($null -eq $event) {
            continue
        }
        if (-not [string]::IsNullOrWhiteSpace($TraceFilter) -and $event.trace -ne $TraceFilter) {
            continue
        }
        if ($SinceMinutesFilter -gt 0 -and $event.timestamp -ne "<unknown>") {
            $parsed = [datetime]::MinValue
            if ([datetime]::TryParse($event.timestamp, [ref]$parsed)) {
                if ($parsed -lt (Get-Date).AddMinutes(-1 * $SinceMinutesFilter)) {
                    continue
                }
            }
        }
        $events += $event
    }
    return $events
}

# 把对象稳定写成 UTF-8 JSON，供后续 diff 或 issue 附件使用。
function Write-JsonFile {
    param(
        [string]$Path,
        [object]$Value
    )

    $Value | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $Path -Encoding UTF8
}

$outputDir = New-DiagnosticOutputDir -Root $OutputRoot
$codexDir = Join-Path $env:USERPROFILE ".codex"
$ccSwitchDir = Join-Path $env:USERPROFILE ".cc-switch"
$configPath = Join-Path $codexDir "config.toml"
$authPath = Join-Path $codexDir "auth.json"
$routerLogPath = Join-Path $ccSwitchDir "logs/codex-router.log"

if (Test-Path -LiteralPath $configPath) {
    $safeConfig = Protect-ConfigText -Text (Get-Content -LiteralPath $configPath -Raw)
    Set-Content -LiteralPath (Join-Path $outputDir "config.sanitized.toml") -Value $safeConfig -Encoding UTF8
}

Write-JsonFile -Path (Join-Path $outputDir "auth.metadata.json") -Value (Get-AuthMetadata -AuthPath $authPath)

$events = Select-RouterEvents -LogPath $routerLogPath -TailLines $LogTailLines -TraceFilter $Trace -SinceMinutesFilter $SinceMinutes
Write-JsonFile -Path (Join-Path $outputDir "router-events.json") -Value $events
$events | ForEach-Object { $_.raw } | Set-Content -LiteralPath (Join-Path $outputDir "router-events.raw.log") -Encoding UTF8

$capacityEvents = @($events | Where-Object {
    ($_.raw -match '(?i)capacity|Selected_model_is_at_capacity|Selected model is at capacity') -or
    ($_.status -and $_.status -notmatch '^2')
})
Write-JsonFile -Path (Join-Path $outputDir "router-events.capacity-or-error.json") -Value $capacityEvents

$summary = [ordered]@{
    generated_at = (Get-Date).ToString("o")
    output_dir = $outputDir
    config_path = $configPath
    auth_path = $authPath
    router_log_path = $routerLogPath
    router_event_count = @($events).Count
    capacity_or_error_count = @($capacityEvents).Count
    trace_filter = $Trace
    tail_lines = $LogTailLines
    since_minutes = $SinceMinutes
    follow_enabled = [bool]$Follow
}
Write-JsonFile -Path (Join-Path $outputDir "summary.json") -Value $summary

Write-Host "Codex OAuth diagnostics written to: $outputDir"
Write-Host ("Router events: {0}; capacity/error candidates: {1}" -f @($events).Count, @($capacityEvents).Count)

if ($Follow) {
    Write-Host "Following router log for $FollowSeconds seconds. Press Ctrl+C to stop earlier."
    $deadline = (Get-Date).AddSeconds($FollowSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $routerLogPath) {
            Get-Content -LiteralPath $routerLogPath -Tail 20 | Set-Content -LiteralPath (Join-Path $outputDir "router-follow-latest.raw.log") -Encoding UTF8
        }
        Start-Sleep -Seconds 2
    }
}

