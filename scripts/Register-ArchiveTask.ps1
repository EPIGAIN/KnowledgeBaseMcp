[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [string]$NodePath = (Get-Command node -ErrorAction Stop).Source,
    [switch]$Remove,
    [ValidatePattern('^([01][0-9]|2[0-3]):[0-5][0-9]$')][string]$DailyAt = '18:00'
)
$ErrorActionPreference = 'Stop'
$resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
$runnerPath = Join-Path $PSScriptRoot 'Watch-Archive.ps1'
foreach ($value in @($resolvedConfig, $NodePath, $runnerPath)) {
    if ($value.Contains('"') -or $value.Contains("`n")) { throw '任务路径不得包含双引号或换行。' }
}
$hashProvider = [System.Security.Cryptography.SHA256]::Create()
try { $hashBytes = $hashProvider.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($resolvedConfig)) }
finally { $hashProvider.Dispose() }
$suffix = ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').Substring(0, 12)
$taskName = "CompanyKnowledge-$suffix"
function Stop-OwnedWatcher {
    $config = Get-Content -LiteralPath $resolvedConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    $statusPaths = @((Join-Path (Split-Path -Parent $resolvedConfig) 'watcher-instance.json'), (Join-Path $config.stateDir 'watcher-status.json'))
    foreach ($statusPath in $statusPaths) { if (Test-Path -LiteralPath $statusPath) {
        $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $worker = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$status.pid) -ErrorAction SilentlyContinue
        if ($worker -and $worker.Name -eq 'node.exe' -and $worker.CommandLine.Contains($resolvedConfig) -and $worker.CommandLine -match ' watch --config ') {
            Stop-Process -Id $worker.ProcessId -Force -ErrorAction SilentlyContinue
        }
    } }
}
if ($Remove) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task -and $task.Description -ne ('CompanyKnowledge;config=' + $resolvedConfig)) { throw '任务所有权不匹配。' }
    if ($task -and $PSCmdlet.ShouldProcess($taskName, '移除知识归档后台任务')) {
        Stop-ScheduledTask -TaskName $taskName
        Stop-OwnedWatcher
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    return
}
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -ConfigPath "{1}" -NodePath "{2}"' -f $runnerPath, $resolvedConfig, $NodePath
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$periodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$daily = New-ScheduledTaskTrigger -Daily -At $DailyAt
$userName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$login = New-ScheduledTaskTrigger -AtLogOn -User $userName
$principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
if ($PSCmdlet.ShouldProcess($taskName, '注册每五分钟、每日固定时间及登录时的知识归档补传任务')) {
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $description = 'CompanyKnowledge;config=' + $resolvedConfig
    if ($existingTask -and $existingTask.Description -ne $description) {
        throw '存在同名但非本安装器管理的任务，拒绝覆盖。'
    }
    if ($existingTask -and $existingTask.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
    if ($existingTask) { Stop-OwnedWatcher }
    $registered = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($periodic, $daily, $login) -Principal $principal -Settings $settings -Description $description -Force
    $actual = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ($actual.Actions.Arguments -ne $arguments -or @($actual.Triggers).Count -ne 3) { throw '任务注册后校验失败。' }
    $result = [pscustomobject]@{ TaskName = $actual.TaskName; State = [string]$actual.State; ConfigPath = $resolvedConfig; DailyAt = $DailyAt; TimeZone = (Get-TimeZone).Id; RepetitionMinutes = 5; RunAtLogon = $true; RunOnlyWhenLoggedOn = $true }
    $config = Get-Content -LiteralPath $resolvedConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $config.stateDir 'schedule.json') -Encoding UTF8
    $result
}
