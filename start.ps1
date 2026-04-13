# MarketScraper — Windows Start Script

$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend  = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"

# Pull latest code
Write-Host "Updating code..." -ForegroundColor Yellow
Set-Location $root
git pull origin claude/fix-real-estate-scraper-JjXLV 2>$null

# Backend
Start-Process powershell -ArgumentList "-NoExit", "-Command", `
  "Write-Host '--- BACKEND ---' -ForegroundColor Cyan; " + `
  "cd '$backend'; " + `
  "python -m venv venv; " + `
  ".\venv\Scripts\activate; " + `
  "pip install setuptools -q; " + `
  "pip install -r requirements.txt -q; " + `
  "python app.py"

# Frontend
Start-Process powershell -ArgumentList "-NoExit", "-Command", `
  "Write-Host '--- FRONTEND ---' -ForegroundColor Green; " + `
  "cd '$frontend'; " + `
  "npm install; " + `
  "npm run dev"

Start-Sleep 6
Start-Process "http://localhost:3000"

Write-Host ""
Write-Host "MarketScraper running!" -ForegroundColor Green
Write-Host "Frontend: http://localhost:3000"
Write-Host "Backend:  http://localhost:5000"
