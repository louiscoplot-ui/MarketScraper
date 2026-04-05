#!/usr/bin/env bash
# REIWA Market Tracker — Start script

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Backend
echo "Starting backend..."
cd "$ROOT/backend"
if [ ! -d "venv" ]; then
  python3 -m venv venv
fi
source venv/bin/activate
pip install -q -r requirements.txt

# Install Playwright browser if needed
echo "Checking Playwright browser..."
playwright install chromium --with-deps 2>/dev/null || playwright install chromium 2>/dev/null || echo "Note: Install Chromium manually with 'playwright install chromium'"

python app.py &
BACKEND_PID=$!

# Frontend
echo "Starting frontend..."
cd "$ROOT/frontend"
npm install --silent 2>/dev/null
npm run dev &
FRONTEND_PID=$!

echo ""
echo "================================================"
echo "  REIWA Market Tracker"
echo "  Frontend: http://localhost:3000"
echo "  Backend:  http://localhost:5000"
echo "================================================"
echo ""
echo "Ctrl+C to stop."

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
