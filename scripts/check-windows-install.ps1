$ErrorActionPreference = 'Stop'
$work = Join-Path $env:RUNNER_TEMP 'hrrrwork-install-smoke'
New-Item -ItemType Directory -Force $work | Out-Null
$installer = (Resolve-Path 'release/Hrrrwork-2.0.0-win-x64.exe').Path
$target = Join-Path $work 'Hrrrwork/Hrrrwork.exe'
$marker = Join-Path $work 'result'
& './resources/update-install.ps1' 99999999 $installer $target '2.0.0' 'ci-smoke' $marker 'windows'
if ((Get-Content -Raw $marker) -ne 'ci-smoke') { throw 'Install helper did not confirm success' }
if ((Get-Item $target).VersionInfo.ProductVersion -notmatch '^2\.0\.0') { throw 'Wrong installed version' }
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith((Split-Path $target)) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Output 'Windows NSIS installation and helper success marker verified.'
