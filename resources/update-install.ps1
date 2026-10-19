param([int]$ParentId, [string]$Installer, [string]$Target, [string]$Version, [string]$Token, [string]$Marker, [string]$Kind)
$ErrorActionPreference = 'Stop'
try {
  if ($Kind -ne 'windows') { throw 'Unexpected installer kind' }
  try { Wait-Process -Id $ParentId -Timeout 60 -ErrorAction Stop } catch { if (Get-Process -Id $ParentId -ErrorAction SilentlyContinue) { throw } }
  $install = Start-Process -FilePath $Installer -ArgumentList @('/S', '--updated') -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw 'Installer did not complete' }
  $actual = (Get-Item -LiteralPath $Target).VersionInfo.ProductVersion
  if ($actual -ne $Version -and -not $actual.StartsWith("$Version.")) { throw 'Installed version does not match' }
  [IO.File]::WriteAllText($Marker, $Token)
  Start-Process -FilePath $Target -ArgumentList '--updated'
} catch {
  [IO.File]::WriteAllText($Marker, "failed:$Token")
  Write-Error $_
  exit 1
}
