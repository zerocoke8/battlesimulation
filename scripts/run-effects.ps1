param(
  [string]$Aseprite = 'C:\Program Files (x86)\Steam\steamapps\common\Aseprite\Aseprite.exe',
  [ValidateSet('all','1','2')][string]$Priority = 'all',
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $Aseprite)) { throw "Aseprite not found: $Aseprite" }
$outputDir = Join-Path $projectRoot 'art/effects'
New-Item -ItemType Directory -Force -Path (Join-Path $outputDir 'previews') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'public/effects') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'art/aseprite/effects') | Out-Null
if (-not $VerifyOnly) {
  $reportPath = Join-Path $outputDir 'build-status.json'
  if (Test-Path -LiteralPath $reportPath) { Remove-Item -LiteralPath $reportPath }
  $process = Start-Process -FilePath $Aseprite -ArgumentList @('--batch','--script-param','root=.','--script-param',"priority=$Priority",'--script','scripts/build_effects.lua') -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $outputDir 'build.log') -RedirectStandardError (Join-Path $outputDir 'build-error.log')
  Get-Content -LiteralPath (Join-Path $outputDir 'build.log')
  Get-Content -LiteralPath (Join-Path $outputDir 'build-error.log')
  if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $reportPath)) { throw 'Aseprite effect generation failed' }
  $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
  $expected = @{ all = @(61,260); '1' = @(21,100); '2' = @(40,160) }[$Priority]
  if (-not $report.passed -or $report.effects.Count -ne $expected[0] -or $report.frames -ne $expected[1]) { throw 'Incomplete effect export' }
}
$verificationPath = Join-Path $outputDir 'verification.json'
if (Test-Path -LiteralPath $verificationPath) { Remove-Item -LiteralPath $verificationPath }
$verification = Start-Process -FilePath $Aseprite -ArgumentList @('--batch','--script-param','root=.','--script','scripts/verify_effects.lua') -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $outputDir 'verify.log') -RedirectStandardError (Join-Path $outputDir 'verify-error.log')
Get-Content -LiteralPath (Join-Path $outputDir 'verify.log')
Get-Content -LiteralPath (Join-Path $outputDir 'verify-error.log')
if ($verification.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $verificationPath)) { throw 'Aseprite source verification failed' }
