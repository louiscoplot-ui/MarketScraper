@echo off
title MarketScraper
echo ========================================
echo    MarketScraper - Starting...
echo ========================================
echo.

REM Add Git to PATH if needed
set PATH=%PATH%;C:\Users\LouisCoplot\AppData\Local\Programs\Git\bin
set PATH=%PATH%;C:\Program Files\nodejs\

REM Get the directory where this .bat file is located
cd /d "%~dp0"

echo [1/2] Starting backend...
cd backend
start "MarketScraper Backend" cmd /k "pip install -r requirements.txt >nul 2>&1 && echo Backend running on http://localhost:5000 && python app.py"

echo [2/2] Starting frontend...
cd ..\frontend
start "MarketScraper Frontend" cmd /k "npm install >nul 2>&1 && echo Frontend starting... && npm run dev"

echo.
echo ========================================
echo  Opening browser in 8 seconds...
echo  Backend: http://localhost:5000
echo  Frontend: http://localhost:3000
echo ========================================
timeout /t 8 >nul
start http://localhost:3000

echo.
echo You can close this window.
timeout /t 3 >nul
