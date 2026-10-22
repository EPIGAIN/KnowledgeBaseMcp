param([Parameter(Mandatory=$true)][string]$ConfigPath,[Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference='Stop'
& $NodePath (Join-Path $PSScriptRoot '..\bin\kb.mjs') watch --config $ConfigPath
exit $LASTEXITCODE
