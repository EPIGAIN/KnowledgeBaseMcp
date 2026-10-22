param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$NodePath
)
$ErrorActionPreference = 'Stop'
$entryPath = Join-Path $PSScriptRoot '..\bin\kb.mjs'
& $NodePath $entryPath background --config $ConfigPath
exit $LASTEXITCODE
