# Deploy Tomorrow Morning — Steps

Branch: `claude/define-excel-columns-XQ4UE`
Pushed during 29 Apr 2026 evening session.

## What's already on the branch

| File | Status | Purpose |
|---|---|---|
| `backend/db_schema.py` | NEW | `init_db()` extracted; adds `hot_vendor_uploads` + `hot_vendor_properties` tables |
| `backend/database.py` | MODIFIED | Slim shell; re-exports `init_db` from db_schema |
| `backend/hot_vendors_api.py` | NEW | CRUD endpoints for persisted RP Data scoring uploads |
| `backend/pipeline_api.py` | MODIFIED | `_match_hot_vendor` now uses new `hot_vendor_properties` table (fast normalized lookup) |
| `backend/listings_api.py` | NEW (pushed earlier) | PATCH `/api/listings/<id>` for inline date editing |

## Step 1 — Wire 2 new modules into app.py (web editor)

Open: https://github.com/louiscoplot-ui/MarketScraper/edit/claude/define-excel-columns-XQ4UE/backend/app.py

Find this line (near the top, around line ~30):
```python
register_pipeline_routes(app)
register_import_routes(app)
```

Add these 4 lines right after it:
```python
from hot_vendors_api import register_hot_vendors_routes
register_hot_vendors_routes(app)
from listings_api import register_listings_routes
register_listings_routes(app)
```

Commit message: `Wire hot_vendors_api + listings_api into app.py`

## Step 2 — Merge to main

Open: https://github.com/louiscoplot-ui/MarketScraper/compare/main...claude/define-excel-columns-XQ4UE

Click **Create pull request** → **Merge pull request** → **Confirm merge**.

Vercel auto-deploys from `main` (frontend ~2 min).
Render auto-deploys from `main` (backend ~2 min).

## Step 3 — Verify in 60 seconds

```bash
# Backend health
curl -s https://marketscraper-backend.onrender.com/api/ping

# Hot vendor table exists (lookup returns null match, NOT 500)
curl -s "https://marketscraper-backend.onrender.com/api/hot-vendors/lookup?address=1+test+st"
# Expected: {"match":null}

# Hot vendor uploads list (empty)
curl -s https://marketscraper-backend.onrender.com/api/hot-vendors/uploads
# Expected: {"uploads":[]}

# Pipeline still works
curl -s "https://marketscraper-backend.onrender.com/api/pipeline/tracking/grouped?suburb=Cottesloe&limit=5"
```

If `hot-vendors/lookup` returns a 500 → Render hasn't redeployed yet, wait 1 min and retry.

## Step 4 — Frontend Hot Vendor upload (later, optional)

`HotVendorScoring.jsx` still writes to localStorage. To persist:

```js
// After scoring rows in the frontend
fetch(`${API}/api/hot-vendors/uploads`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    filename: file.name,
    suburb: 'Cottesloe',
    agency: 'Belle Property',
    uploaded_by: 'Louis',
    median_holding_years: median,
    properties: scoredRows,
  })
}).then(r => r.json()).then(d => console.log('Saved upload', d.upload_id))
```

That's all — pipeline auto-match kicks in immediately for any address that matches `normalized_address`.

## Step 5 — Things I couldn't push tonight

| Task | Why blocked | Fix |
|---|---|---|
| `app.py` wire-up of 4 lines | 51KB > MCP push limit | You paste manually (Step 1 above) |
| `App.jsx` inline date edit UI | 53KB > MCP push limit | Refactor App.jsx into pages/ first (this weekend), then I can do it |
| `scraper.py` sold_date capture | 50KB > MCP push limit | RP Data CSV import (already working) is more reliable anyway |

## Best-results playbook for working with me

1. **Keep files under ~20KB.** When a file passes 20KB, refactor before adding more — otherwise I can't edit it via MCP.
2. **One feature per message.** If you ask 5 things at once, I make compromises. Drip them in.
3. **Tell me the risk level**: "don't break prod" vs "experiment freely". Changes how cautiously I code.
4. **Branches > main pushes.** Push to `claude/<feature>` branches; merge yourself when ready. Avoids the rollback dance from yesterday.
5. **If something breaks, send me the EXACT error**, not "ça marche pas". Render logs / browser console / curl response.

## Commits pushed tonight

```
4f531e3  Add listings_api.py PATCH endpoint (earlier session)
1f03919  Extract init_db() into db_schema.py + add hot_vendor tables
43cc43e  Slim down database.py — delegate init_db to db_schema.py
c02d635  Add hot_vendors_api.py — persisted CSV uploads + address lookup
009ecc7  Pipeline auto-match owner from hot_vendor_properties
```
