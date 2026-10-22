# Dot-sourced only into the terminal process; no user profile or policy changes.
$script:KbTraceConfig = [System.IO.File]::ReadAllText($env:KB_TRACE_CONFIG) | ConvertFrom-Json
$script:KbTraceRuntime = [string]$PID + '-' + [Guid]::NewGuid().ToString()
$script:KbTraceLog = Join-Path (Split-Path -Parent $env:KB_TRACE_CONFIG) ($script:KbTraceRuntime + '.jsonl')
$script:KbTracePaused = $false
function Test-KbTraceActive {
    if ($script:KbTracePaused) { return $false }
    try {
        $gate = [IO.File]::ReadAllText($script:KbTraceConfig.gateFile) | ConvertFrom-Json
        $control = @{enabled=$true; revision='initial'}
        if ([IO.File]::Exists($script:KbTraceConfig.controlFile)) { $control = [IO.File]::ReadAllText($script:KbTraceConfig.controlFile) | ConvertFrom-Json }
        if ($gate.available -and $gate.epoch -eq $script:KbTraceConfig.epoch -and $gate.leaseUntil -ge [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -and $control.enabled -and $control.revision -eq $script:KbTraceConfig.controlRevision) { return $true }
    } catch {}
    $script:KbTracePaused = $true
    Write-KbTraceEvent @{kind='paused'}
    return $false
}
function Write-KbTraceEvent($Data) {
    try {
        if ($Data.kind -eq 'write' -and -not (Test-KbTraceActive)) { return }
        $Data.runtime = $script:KbTraceRuntime; $Data.pid = $PID
        $Data.time = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        [System.IO.File]::AppendAllText($script:KbTraceLog, (($Data | ConvertTo-Json -Compress -Depth 5) + "`n"), [System.Text.UTF8Encoding]::new($false))
    } catch {}
}
function Get-KbFileFingerprint([string]$File) {
    if (-not (Test-KbTraceActive)) { return $null }
    if (-not [System.IO.File]::Exists($File)) { return $null }
    if (([System.IO.FileInfo]$File).Length -gt $script:KbTraceConfig.maxBytes) { return 'oversize' }
    $hash = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash([System.IO.File]::ReadAllBytes($File)))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}
function Get-KbWriteTargets([string]$Command, $Parameters) {
    $targets = @()
    if (-not (Test-KbTraceActive)) { return ,$targets }
    try {
        $paths = if ($Parameters.ContainsKey('LiteralPath')) { @($Parameters.LiteralPath) } elseif ($Parameters.ContainsKey('Path')) { @($Parameters.Path) } elseif ($Parameters.ContainsKey('FilePath')) { @($Parameters.FilePath) } else { @() }
        foreach ($value in $paths) {
            if (-not ($value -is [string]) -or $value.IndexOfAny([char[]]'*?[]') -ge 0) { continue }
            $file = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($value)
            if ($Command -eq 'Copy-Item' -or $Command -eq 'Move-Item') {
                if (-not [System.IO.File]::Exists($file) -or -not $Parameters.Destination) { continue }
                $destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath([string]$Parameters.Destination)
                $file = if ([System.IO.Directory]::Exists($destination)) { Join-Path $destination ([System.IO.Path]::GetFileName($file)) } else { $destination }
            } elseif ($Command -eq 'Rename-Item') {
                if (-not $Parameters.NewName) { continue }
                $file = Join-Path ([System.IO.Path]::GetDirectoryName($file)) ([string]$Parameters.NewName)
            }
            $file = [System.IO.Path]::GetFullPath($file)
            $prefix = $script:KbTraceConfig.root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
            if (-not $file.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
            $excluded = $false
            if ($script:KbTraceConfig.excludedPattern) {
                foreach ($part in ($file.Substring($prefix.Length) -split '[\\/]+')) {
                    if ([regex]::IsMatch($part, $script:KbTraceConfig.excludedPattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) { $excluded = $true }
                }
            }
            foreach ($root in $script:KbTraceConfig.excludeRoots) {
                if ($file -eq $root -or $file.StartsWith($root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { $excluded = $true }
            }
            if (-not $excluded) { $targets += @{ path = $file; before = (Get-KbFileFingerprint $file) } }
        }
    } catch {}
    return ,$targets
}
function Complete-KbWriteTargets($Targets) {
    foreach ($item in $Targets) {
        try {
            $after = Get-KbFileFingerprint $item.path
            if ($after -and $after -ne 'oversize') { Write-KbTraceEvent @{ kind = 'write'; path = $item.path; before = $item.before; sha256 = $after; size = ([System.IO.FileInfo]$item.path).Length } }
        } catch {}
    }
}
Write-KbTraceEvent @{ kind = 'start'; language = 'powershell' }
foreach ($name in @('Set-Content', 'Add-Content', 'Out-File', 'Export-Csv', 'Copy-Item', 'Move-Item', 'Rename-Item', 'New-Item')) {
    $resolved = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $resolved -or $resolved.CommandType -ne 'Cmdlet') { continue }
    $proxy = [System.Management.Automation.ProxyCommand]::Create([System.Management.Automation.CommandMetadata]::new($resolved))
    $before = '$kbWriteTargets = Get-KbWriteTargets -Command ''' + $name + ''' -Parameters $PSBoundParameters; $kbWriteErrorCount = $global:Error.Count; '
    $proxy = $proxy.Replace('$steppablePipeline.Begin($PSCmdlet)', $before + '$steppablePipeline.Begin($PSCmdlet)')
    $proxy = $proxy.Replace('$steppablePipeline.End()', '$steppablePipeline.End(); if ($global:Error.Count -eq $kbWriteErrorCount) { Complete-KbWriteTargets $kbWriteTargets }')
    Set-Item -LiteralPath ('Function:global:' + $name) -Value ([ScriptBlock]::Create($proxy))
}
# PostToolUse confirms completion for this shell. Child Python/Node processes
# additionally emit their own start/end records.
