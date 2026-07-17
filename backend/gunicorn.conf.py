"""Gunicorn config — auto-loaded from the working directory by the
Render start command (gunicorn reads ./gunicorn.conf.py; CLI flags in
the dashboard, if any, still take precedence).

Why this exists: gunicorn's DEFAULT worker timeout is 30 seconds. The
Reports generation (POST /api/reports/generate = per-suburb SQL metrics
on Neon + one Claude narrative call + docx build) legitimately runs
20-60s+, so the default silently SIGKILLed the worker mid-request — the
browser saw a dropped connection ("Failed to fetch"), and the dyno also
lost any other in-flight request. Hot Vendors Excel builds (~30s cold)
were riding the same edge.

300s covers the worst realistic case (18 suburbs + a 45s-capped
narrative call) with margin, while still letting a genuinely hung
worker get reaped."""

timeout = 300
graceful_timeout = 30
