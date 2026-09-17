param([string]$Aseprite = 'C:\Program Files (x86)\Steam\steamapps\common\Aseprite\Aseprite.exe')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $Aseprite)) { throw "Aseprite not found: $Aseprite" }
$outputDir = Join-Path $projectRoot 'art/effects'
New-Item -ItemType Directory -Force -Path (Join-Path $outputDir 'previews') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'public/effects') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'art/aseprite/effects') | Out-Null
$reportPath = Join-Path $outputDir 'manifest.json'
if (Test-Path -LiteralPath $reportPath) { Remove-Item -LiteralPath $reportPath }
$process = Start-Process -FilePath $Aseprite -ArgumentList @('--batch','--script-param','root=.','--script','scripts/build_effects.lua') -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $outputDir 'build.log') -RedirectStandardError (Join-Path $outputDir 'build-error.log')
Get-Content -LiteralPath (Join-Path $outputDir 'build.log')
Get-Content -LiteralPath (Join-Path $outputDir 'build-error.log')
if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $reportPath)) { throw 'Aseprite effect generation failed' }
$report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
if (-not $report.passed -or $report.effects.Count -ne 21 -or $report.frames -ne 100) { throw 'Incomplete effect export' }
$verificationPath = Join-Path $outputDir 'verification.json'
if (Test-Path -LiteralPath $verificationPath) { Remove-Item -LiteralPath $verificationPath }
$verification = Start-Process -FilePath $Aseprite -ArgumentList @('--batch','--script-param','root=.','--script','scripts/verify_effects.lua') -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $outputDir 'verify.log') -RedirectStandardError (Join-Path $outputDir 'verify-error.log')
Get-Content -LiteralPath (Join-Path $outputDir 'verify.log')
Get-Content -LiteralPath (Join-Path $outputDir 'verify-error.log')
if ($verification.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $verificationPath)) { throw 'Aseprite source verification failed' }
