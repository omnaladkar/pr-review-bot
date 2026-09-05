# Install Ollama and pull the EXAONE Korean model (free, local, no VPN/API key).
# Run from PowerShell as Administrator:
#   powershell -ExecutionPolicy Bypass -File scripts/setup-ollama.ps1

$ErrorActionPreference = "Stop"

$Model = if ($env:OLLAMA_MODEL) { $env:OLLAMA_MODEL } else { "exaone3.5:2.4b" }

Write-Host "==> Checking Ollama..." -ForegroundColor Cyan
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollama) {
  Write-Host "    Ollama not found. Installing via winget..." -ForegroundColor Yellow
  winget install --id=Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
  Write-Host "    Refresh PATH ..."
  $env:PATH = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# Start the Ollama server if not running.
$running = Test-NetConnection -ComputerName localhost -Port 11434 -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $running) {
  Write-Host "==> Starting Ollama server..." -ForegroundColor Cyan
  Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
  Start-Sleep -Seconds 5
}

if (-not (Test-NetConnection -ComputerName localhost -Port 11434 -InformationLevel Quiet -WarningAction SilentlyContinue)) {
  Write-Host "    Could not reach Ollama on port 11434." -ForegroundColor Red
  Write-Host "    Check that the Ollama app is installed via https://ollama.com/download and retry." -ForegroundColor Red
  exit 1
}

Write-Host "==> Pulling Korean model: $Model (about 1.6GB for 2.4b)..." -ForegroundColor Cyan
ollama pull $Model

Write-Host ""
Write-Host "==> Done. Test it:" -ForegroundColor Green
Write-Host "    ollama run $Model"
Write-Host ""
Write-Host "==> The PR bot uses it automatically:"
Write-Host "    node dist/index.js run -o <owner> -r <repo> -p <PR> --ollama $Model"