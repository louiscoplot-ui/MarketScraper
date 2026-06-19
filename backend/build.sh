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

echo "==> playwright install chromium + chromium-headless-shell"
# Render's free tier already has the OS libs Chromium needs, and
# --with-deps requires sudo which the build user doesn't have.
#
# Playwright 1.49+ split headless launches into a separate
# `chromium-headless-shell` binary. `playwright install chromium` no
# longer covers it on every channel, so headless=True launches fail
# with: "Executable doesn't exist at .../chromium_headless_shell-XXXX/...".
# We install both variants explicitly — the shell install is cheap (~80MB)
# and idempotent, so `|| true` keeps the build green even if a future
# Playwright release renames or removes the channel.
python -m playwright install chromium
python -m playwright install chromium-headless-shell || true
