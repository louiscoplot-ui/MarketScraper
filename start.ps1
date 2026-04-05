# REIWA Market Tracker — Windows Start Script

$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend  = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"

# Backend
Start-Process powershell -ArgumentList "-NoExit", "-Command", `
  "Write-Host '--- BACKEND ---' -ForegroundColor Cyan; " + `
  "cd '$backend'; " + `
  "pip install -r requirements.txt -q; " + `
  "playwright install chromium; " + `
  "python app.py"

# Frontend
Start-Process powershell -ArgumentList "-NoExit", "-Command", `
  "Write-Host '--- FRONTEND ---' -ForegroundColor Green; " + `
  "cd '$frontend'; " + `
  "npm install --silent; " + `
  "npm run dev"

Start-Sleep 4
Start-Process "http://localhost:3000"

Write-Host ""
Write-Host "REIWA Market Tracker running!" -ForegroundColor Green
Write-Host "Frontend: http://localhost:3000"
Write-Host "Backend:  http://localhost:5000"
