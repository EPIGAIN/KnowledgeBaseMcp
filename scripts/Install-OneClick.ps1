[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ConfigFile,
    [string]$StateDir,
    [ValidateSet('auto','claude','codex','both','doubao','all')][string]$Clients='auto',
    [string]$ClientHome,
    [switch]$SkipTask
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding=[Console]::OutputEncoding
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
try {
    $ConfigFile=[IO.Path]::GetFullPath($ConfigFile)
    if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) { throw '请先复制并填写 company-knowledge.example.md，再把 ConfigFile 指向填写后的文件。' }
    if ($StateDir -and (-not [IO.Path]::IsPathRooted($StateDir) -or $StateDir -match '[\r\n]')) { throw '可选 StateDir 必须是本机绝对路径。' }
    if ($ClientHome -and -not [IO.Path]::IsPathRooted($ClientHome)) { throw 'ClientHome 必须为绝对路径。' }
    $node=(Get-Command node -ErrorAction Stop).Source
    $version=& $node --version
    if ($LASTEXITCODE -ne 0 -or [int]$version.Trim().TrimStart('v').Split('.')[0] -lt 22) { throw '需要 Node.js 22 或以上版本。' }
    $hasClaude=[bool](Get-Command claude -ErrorAction SilentlyContinue)
    $hasCodex=[bool](Get-Command codex -ErrorAction SilentlyContinue)
    if ($Clients -eq 'auto') {
        if ($hasClaude -and $hasCodex) { $Clients='both' }
        elseif ($hasClaude) { $Clients='claude' }
        elseif ($hasCodex) { $Clients='codex' }
        else { throw '未检测到 Claude Code / Codex。仅接入豆包时请明确指定 -Clients doubao。' }
    }
    if (($Clients -in @('claude','both','all') -and -not $hasClaude) -or ($Clients -in @('codex','both','all') -and -not $hasCodex)) { throw '指定的命令行客户端未安装。' }
    Write-Host '[1/3] 检查依赖...'
    Push-Location -LiteralPath $projectRoot
    try {
        & $node (Join-Path $PSScriptRoot 'check-dependencies.mjs')
        if ($LASTEXITCODE -ne 0) {
            & (Get-Command npm.cmd -ErrorAction Stop).Source ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
        }
    } finally { Pop-Location }
    Write-Host '[2/3] 校验 MD，应用配置并迁移已有状态和归档...'
    $arguments=@((Join-Path $projectRoot 'bin/kb.mjs'),'install','--scope','user','--client',$Clients,'--config-md',$ConfigFile)
    if ($StateDir) { $arguments += @('--state',$StateDir) }
    if ($ClientHome) { $arguments += @('--client-home',$ClientHome) }
    $output=& $node @arguments
    if ($LASTEXITCODE -ne 0) { throw '客户端配置失败，未完成安装。' }
    $installed=($output -join "`n") | ConvertFrom-Json
    $stateDirectory=$installed.sharedState
    $runtimeConfig=Get-Content -LiteralPath $installed.configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $schedule=$null
    if (-not $SkipTask) {
        Write-Host '[3/3] 注册并启动当前用户的后台监听...'
        $schedule=& (Join-Path $PSScriptRoot 'Register-ArchiveTask.ps1') -ConfigPath $installed.configPath -NodePath $node
        $started=[DateTime]::UtcNow
        Start-ScheduledTask -TaskName $schedule.TaskName
        $deadline=$started.AddSeconds(30)
        $fresh=$false
        do {
            Start-Sleep -Milliseconds 500
            $statusFile=Join-Path $stateDirectory 'watcher-status.json'
            if (Test-Path -LiteralPath $statusFile) {
                $status=Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
                $fresh=[DateTimeOffset]::Parse($status.checkedAt).UtcDateTime -ge $started
            }
        } while (-not $fresh -and [DateTime]::UtcNow -lt $deadline)
        if (-not $fresh -or (Get-ScheduledTask -TaskName $schedule.TaskName).State -ne 'Running') { throw '监听任务未正常启动；配置已保留，请检查任务计划程序。' }
        if ($status.status -eq 'error') { throw ('监听报告错误：'+$status.error.message) }
    } else { Write-Host '[3/3] 已按参数跳过后台任务注册。' }
    $manifest=[ordered]@{status='installed';installedAt=[DateTime]::UtcNow.ToString('o');configPath=$installed.configPath;settingsFile=$ConfigFile;clients=$Clients;workRoots=$runtimeConfig.workRoots;mdRoot=$runtimeConfig.mdRoot;filesRoot=$runtimeConfig.filesRoot;stateDir=$stateDirectory;stateRoot=$installed.stateRoot;migration=$installed.migration;schedule=$schedule}
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stateDirectory 'installation.json') -Encoding UTF8
    if ($installed.doubao) {
        Write-Host '豆包接入准备完成。还需在豆包的自定义连接器中填写以下 STDIO 参数：' -ForegroundColor Green
        Write-Host ('配置文件：'+$installed.doubao.registrationFile)
        Write-Host ('命令（粘贴到“命令”框）：'+$installed.doubao.commandField)
        Write-Host ('参数数组：'+(ConvertTo-Json -InputObject @($installed.doubao.args) -Compress))
        Write-Host ('整条命令行（只有一个输入框时）：'+$installed.doubao.commandLine)
        if ($installed.doubao.requiresQuoting) {
            Write-Host '注意：豆包把“命令”框按空格拆分参数。上面的命令已加英文双引号；漏掉引号会报 CONNECTOR_STDIO_EXECUTABLE_NOT_FOUND: COMMAND_NOT_FOUND。' -ForegroundColor Yellow
        }
        Write-Host '启用连接器后，在工作任务中开始工作会话；目标可访问时再由 Agent 询问姓名。没有安装豆包 Hook。'
    } else {
        Write-Host '配置完成。重启客户端，从已配置的工作目录打开新对话，并按正常流程信任 Hook。' -ForegroundColor Green
        Write-Host '两个目标可访问后，Agent 会主动询问姓名；回答后才开始采集。离线或非工作目录时暂停。'
    }
    Write-Host ('共享配置：'+$installed.configPath)
    Write-Host ('日常只需维护：'+$ConfigFile)
    Write-Host ('程序管理状态：'+$installed.stateRoot)
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
