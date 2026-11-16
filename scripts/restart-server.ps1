# Restart the API server in the background and show the last lines of its log.
param(
  [int]$WaitSeconds = 12
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Log = Join-Path $Root 'data\server.log'

# Stop whatever is running the API from this checkout.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$Root*" -and $_.CommandLine -match "tsx|src/index.ts|dist/index.js" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'data') | Out-Null
Remove-Item "$Log*" -Force -ErrorAction SilentlyContinue

$server = Join-Path $Root 'server'
$p = Start-Process -FilePath 'npx.cmd' `
  -ArgumentList 'tsx', '--env-file=../.env', 'src/index.ts' `
  -WorkingDirectory $server `
  -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" `
  -PassThru -WindowStyle Hidden

Start-Sleep -Seconds $WaitSeconds
if ($p.HasExited) {
  Write-Host "Server exited. Last error lines:"
  Get-Content "$Log.err" -Tail 25 -ErrorAction SilentlyContinue
  exit 1
}
Write-Host "Server running (pid $($p.Id)). Log:"
Get-Content $Log -Tail 10 -ErrorAction SilentlyContinue
