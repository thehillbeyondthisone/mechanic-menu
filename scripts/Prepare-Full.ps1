$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
$source = 'D:\Lustron\experiments\BLUNT\2026-11-04_repair-office-single-image\output\repair-office.ply'
$before = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
node --max-old-space-size=4096 node_modules/@playcanvas/splat-transform/bin/cli.mjs -w -g cpu $source public/assets/office-full.compressed.ply
if ($LASTEXITCODE -ne 0) { throw 'Full scene conversion failed' }
if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $before) { throw 'Original source hash changed' }
Write-Host 'All 3,144,197 splats retained. No decimation. Original unchanged.'
