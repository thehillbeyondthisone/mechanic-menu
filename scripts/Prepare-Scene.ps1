$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
$source = 'D:\Lustron\experiments\BLUNT\2026-11-04_repair-office-single-image\output\repair-office.ply'
if (!(Test-Path -LiteralPath $source)) { throw "Missing original: $source" }
New-Item -ItemType Directory -Path work,public/assets,evidence -Force | Out-Null
$before = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
node --max-old-space-size=4096 node_modules/@playcanvas/splat-transform/bin/cli.mjs -w -g cpu $source --decimate 300000 work/office-300k.ply
if ($LASTEXITCODE -ne 0) { throw 'Scene reduction failed' }
node node_modules/@playcanvas/splat-transform/bin/cli.mjs -w -g cpu work/office-300k.ply public/assets/office.compressed.ply
if ($LASTEXITCODE -ne 0) { throw 'Compression failed' }
$after = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
if ($before -ne $after) { throw 'Original source hash changed' }
Write-Host 'Scene prepared locally. Original hash unchanged.'
