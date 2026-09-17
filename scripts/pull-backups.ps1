# Pulls AbcPay Postgres dumps from the LAN test host and prunes old local rolling copies.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/pull-backups.ps1
# Schedule it (example, daily 09:30):
#   schtasks /Create /TN "AbcPay backup pull" /SC DAILY /ST 09:30 /TR "powershell -ExecutionPolicy Bypass -File $PWD\scripts\pull-backups.ps1"

param(
  [string]$PiUser = 'nghiacc',
  [string]$PiHost = '192.168.31.149',
  [string]$Key = "$env:USERPROFILE\firstgit-pi",
  [string]$RemoteDir = '/home/nghiacc/abcpay-backups',
  [string]$Dest = "$env:USERPROFILE\backups\abcpay",
  [int]$Keep = 30
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

Write-Output "pulling dumps from ${PiUser}@${PiHost}:$RemoteDir to $Dest"
scp -i $Key -o BatchMode=yes "${PiUser}@${PiHost}:$RemoteDir/*.dump" "$Dest\"
if ($LASTEXITCODE -ne 0) {
  throw "scp failed with exit code $LASTEXITCODE"
}

Get-ChildItem -Path $Dest -Filter 'rolling-*.dump' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip $Keep |
  ForEach-Object {
    Write-Output "pruning $($_.Name)"
    Remove-Item -LiteralPath $_.FullName -Force
  }

Get-ChildItem -Path $Dest | Select-Object Name, Length, LastWriteTime
