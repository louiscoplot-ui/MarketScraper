#!/usr/bin/env bash
# Lance le backend Flask et le frontend React en parallèle

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Charger .env si présent
if [ -f "$ROOT/.env" ]; then
  export $(grep -v '^#' "$ROOT/.env" | xargs)
fi

if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "⚠  ANTHROPIC_API_KEY non défini. Copie .env.example en .env et ajoute ta clé."
  exit 1
fi

# Backend
echo "→ Démarrage du backend Flask (port 5000)..."
cd "$ROOT/backend"
if [ ! -d "venv" ]; then
  python3 -m venv venv
fi
source venv/bin/activate
pip install -q -r requirements.txt
python app.py &
BACKEND_PID=$!

# Frontend
echo "→ Démarrage du frontend React (port 3000)..."
cd "$ROOT/frontend"
npm install --silent
npm run dev &
FRONTEND_PID=$!

echo ""
echo "✓ Braindump lancé !"
echo "  Frontend : http://localhost:3000"
echo "  Backend  : http://localhost:5000"
echo ""
echo "Ctrl+C pour tout arrêter."

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
