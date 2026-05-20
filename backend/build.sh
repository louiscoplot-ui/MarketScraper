#!/usr/bin/env bash
# Render build script — set this as the service's Build Command in the
# Render dashboard (Settings → Build & Deploy → Build Command):
#
#     cd backend && bash build.sh
#
# Without it, Render only runs `pip install -r requirements.txt` and
# Playwright's chromium binary never lands at $HOME/.cache/ms-playwright,
# so every browser launch fails with
#     "BrowserType.launch: Executable doesn't exist at /opt/render/.cache/..."

set -e

echo "==> pip install"
pip install --upgrade pip
pip install -r requirements.txt

echo "==> playwright install chromium"
# Render's free tier already has the OS libs Chromium needs, and
# --with-deps requires sudo which the build user doesn't have.
python -m playwright install chromium
