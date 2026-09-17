param(
  [string]$Aseprite = 'C:\Program Files (x86)\Steam\steamapps\common\Aseprite\Aseprite.exe',
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $Aseprite)) { throw "Aseprite not found: $Aseprite" }
Push-Location $projectRoot
try {
  if (-not $VerifyOnly) {
    $buildStatus = Join-Path $projectRoot 'art/build-status.json'
    if (Test-Path -LiteralPath $buildStatus) { Remove-Item -LiteralPath $buildStatus }
    $build = Start-Process -FilePath $Aseprite -ArgumentList @('--batch','--script-param','root=.','--script','scripts/build_sprites.lua') -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $projectRoot 'art/build.log') -RedirectStandardError (Join-Path $projectRoot 'art/build-error.log')
    Get-Content -LiteralPath (Join-Path $projectRoot 'art/build.log')
    Get-Content -LiteralPath (Join-Path $projectRoot 'art/build-error.log')
    if ($build.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $buildStatus)) { throw 'Aseprite generation failed' }
  }
  # Aseprite can report a Lua error while returning exit code zero; inspect report too.
  $reportPath = Join-Path $projectRoot 'art/verification.json'
  if (Test-Path -LiteralPath $reportPath) { Remove-Item -LiteralPath $reportPath }
  $verification = Start-Process -FilePath $Aseprite -ArgumentList @('--batch','--script-param','root=.','--script','scripts/verify_sprites.lua') -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $projectRoot 'art/verify.log') -RedirectStandardError (Join-Path $projectRoot 'art/verify-error.log')
  Get-Content -LiteralPath (Join-Path $projectRoot 'art/verify.log')
  Get-Content -LiteralPath (Join-Path $projectRoot 'art/verify-error.log')
  if (-not (Test-Path -LiteralPath $reportPath)) { throw 'Verification did not finish' }
  $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
  if (-not $report.passed) { throw "Sprite verification failed: $($report.errors.Count) errors" }
} finally { Pop-Location }
