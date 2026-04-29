# Deploy Tomorrow Morning — One Click

Branch: `claude/define-excel-columns-XQ4UE`
Pushed during 29 Apr 2026 evening session.

**No manual editing required.** Everything is wired. Tomorrow morning is literally one merge.

## What's on the branch

### Backend refactor (app.py 51KB → 15KB)

Big files split so future changes can be pushed entirely via MCP:

| File | Status | Purpose |
|---|---|---|
| `backend/app.py` | SLIMMED 51KB → 15KB | Imports + simple route handlers + scrape endpoints |
| `backend/scrape_runner.py` | NEW 10KB | Background `run_scrape` / `run_scrape_all` workers |
| `backend/report_api.py` | NEW 8KB | `/api/report` market report handler |
| `backend/export_api.py` | NEW 15KB | `/api/listings/export` Excel builder |
| `backend/db_schema.py` | NEW 8KB | `init_db()` + new `hot_vendor_*` tables |
| `backend/database.py` | SLIMMED 28KB → 18KB | Connection layer + CRUD; re-exports `init_db` |

### New features

| File | Purpose |
|---|---|
| `backend/hot_vendors_api.py` | CRUD endpoints for persisted RP Data uploads + `/api/hot-vendors/lookup` for pipeline auto-match |
| `backend/listings_api.py` | PATCH `/api/listings/<id>` for inline date editing (pushed earlier) |
| `backend/pipeline_api.py` | Updated: `_match_hot_vendor` now uses `hot_vendor_properties` (fast normalized lookup) |

## Step 1 — Merge to main

Open: https://github.com/louiscoplot-ui/MarketScraper/compare/main...claude/define-excel-columns-XQ4UE

Click **Create pull request** → **Merge pull request** → **Confirm merge**.

Vercel auto-deploys frontend (~2 min).
Render auto-deploys backend (~2 min).

## Step 2 — Verify in 60 seconds

```bash
# Backend health
curl -s https://marketscraper-backend.onrender.com/api/ping
# Expected: {"status":"ok","app":"market-scraper"}

# Hot vendor lookup (table exists, no match yet)
curl -s "https://marketscraper-backend.onrender.com/api/hot-vendors/lookup?address=1+test+st"
# Expected: {"match":null}

# Hot vendor uploads list (empty)
curl -s https://marketscraper-backend.onrender.com/api/hot-vendors/uploads
# Expected: {"uploads":[]}

# Pipeline still works
curl -s "https://marketscraper-backend.onrender.com/api/pipeline/tracking/grouped?suburb=Cottesloe&limit=5"

# Excel export still works (was extracted to export_api.py)
curl -sI "https://marketscraper-backend.onrender.com/api/listings/export?suburb_ids=1" | head -1
# Expected: HTTP/2 200 (returns the .xlsx file)

# Market report still works (extracted to report_api.py)
curl -s "https://marketscraper-backend.onrender.com/api/report?suburb_ids=1" | head -c 100
```

If any return 500 → Render hasn't redeployed yet. Wait 1 min and retry.

If you see `ImportError` in Render logs → I missed an import in the refactor. The fix is one line — send me the exact log line and I'll patch it.

## Step 3 — Frontend Hot Vendor upload (later, optional)

`HotVendorScoring.jsx` still writes to localStorage. To persist across devices:

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

## Things I still can't push directly

| File | Size | What to do |
|---|---|---|
| `frontend/src/App.jsx` | 53KB | This weekend: refactor into `pages/Listings.jsx` + `pages/Settings.jsx` so I can edit it. Until then, web editor for App.jsx changes. |
| `backend/scraper.py` | 50KB | This weekend: extract `_parse_active`, `_parse_sold`, `_parse_detail` into separate files. Until then, web editor for scraper changes. |

Both manageable — same pattern as tonight's app.py split.

## Best-results playbook

1. **Files < 20KB.** When a file passes 20KB, refactor before adding more.
2. **One feature per message.** 5 things at once = compromises. Drip them in.
3. **Risk level upfront**: "don't break prod" vs "experiment freely". Changes how cautiously I code.
4. **Branches > main**. Push to `claude/<feature>` branches; merge yourself. Avoids the rollback dance.
5. **Exact errors when something breaks**. Render logs / browser console / curl response, not "ça marche pas".

## Commits pushed tonight

```
4f531e3  Add listings_api.py PATCH endpoint
1f03919  Extract init_db() into db_schema.py + add hot_vendor tables
43cc43e  Slim down database.py — delegate init_db to db_schema.py
c02d635  Add hot_vendors_api.py — persisted CSV uploads + address lookup
009ecc7  Pipeline auto-match owner from hot_vendor_properties
13151d5  Add deploy guide for tomorrow morning
71172d6  Extract scrape background workers to scrape_runner.py
eaadb95  Extract market_report to report_api.py
3c7e752  Extract export_listings to export_api.py
22e7d2e  Slim app.py — wire all 6 route modules + drop extracted code
```
