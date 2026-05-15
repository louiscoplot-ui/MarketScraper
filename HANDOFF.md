# SuburbDesk / MarketScraper — Session handoff

## 1. STACK & REPO

**Repo** : `github.com/louiscoplot-ui/MarketScraper`

**Branches** :
- `claude/fix-scraper-missing-listings-PlwVM` → `50f4799` ✅ HEAD prod
- `claude/fix-scraper-listings-2WFqJ` → `50f4799` ✅ alias miroir (working branch session)
- `main` → bloqué HTTP 403 toute la session (28+ commits de retard, déploiement-side decision required)

Push pattern stable, exécuté ~38 fois ce session :

```bash
git push origin HEAD:claude/fix-scraper-listings-2WFqJ
git push origin HEAD:claude/fix-scraper-missing-listings-PlwVM
git push origin HEAD:main   # → 403, skip
```

**Stack (inchangé) :**
- Backend Flask 3 + Postgres Neon prod / SQLite local (`USE_POSTGRES`)
- No ORM. Raw SQL via `_Conn/_Cur` wrapper dans `database.py`.
- **NEW : `get_db_conn()` context manager** (commit `bdc3f03`) — try/finally guarantees `conn.close()`.
- Frontend React 18 + Vite 5.4.11. No router. View synced URL hash.
- Scraper Playwright + BeautifulSoup4. Source : REIWA.com.au.
- Email Resend HTTP API.
- Hosting : Vercel (frontend, **25s edge timeout hard**) + Render free tier (backend, cold start 30-60s).
- Cron : GitHub Actions `0 21 * * *` UTC = 5am Perth.

**Vercel timeout workaround** : `frontend/src/lib/api.js:15` exports `BACKEND_DIRECT`. Used by Pipeline, Hot Vendors, Rental upload/export, Letters, etc.

**localStorage cache** : `sd_cache_v3_<16hex>_<suffix>`. **NO TTL** — values persist until `CACHE_VERSION` bumps. Confirmed during cache debugging.

---

## 2. COMMITS DE CETTE SESSION (38 commits, ordre chronologique)

Session HEAD à l'arrivée : `4167d11`. À la sortie : `50f4799`.

| # | Hash | Type | Domaine | Effet |
|---|------|------|---------|-------|
| 1 | `0f637e9` | ux | letter | `pipeline_letter.py:_green_header` alignement bannière LEFT → RIGHT |
| 2 | `1149e75` | ux | report | Report.jsx : bloc Withdrawn déplacé en 1er dans `report-tables` |
| 3 | `9de1338` | chore | docs | CLAUDE.md refresh + agent specs (suburbdesk-bugfixer/feature/shipper) |
| 4 | `61d1d80` | ux | hot-vendors | Spinner + `useRef(new Map())` cache mémoire sur switch report dans HotVendorScoring.jsx |
| 5 | `3e405d1` | ux | header | Export button : `isExporting` state, disabled + "Exporting…" pendant fetch (Header.jsx, **pas** HotVendorScoring qui avait déjà `excelLoading`) |
| 6 | `026bb61` | chore | infra | keep-alive ping (vient de l'auto-deploy GHA, pas de moi) |
| 7 | `18da9a9` | fix | pipeline | `pipeline_tracking_grouped` accepte `?days=` + filtre strict `source_sold_date >= cutoff` (ISO only à ce stade) |
| 8 | `384ce11` | chore | docs | CLAUDE.md ajoute section "Prompts prêts à exécuter" |
| 9 | `28db44a` | perf | excel | `lru_cache` sur `_font/_fill/_ctr/_lft` dans `hot_vendor_excel.py` + `_extras.py` → 3000-row export 5min → ~30s |
| 10 | `2fe9402` | fix | scrape | `fetchScrapeStatus` + polling switched to `BOOT_API` (= BACKEND_DIRECT) — App.jsx |
| 11 | `2076d62` | fix | pipeline | Filtre tracking days gère ISO `YYYY-MM-DD` **ET** legacy DD/MM/YYYY via SUBSTR + concat OR branch (régression du #7 qui rejetait les rows DD/MM) |
| 12 | `cab84d5` | fix | cron | `scripts/run_daily_scrape.py` appelle `_generate_pipeline_for_suburb(name, days=30, enforce_acl=False)` après chaque scrape — sales du jour atterrissent enfin dans pipeline_tracking |
| 13 | `5066f38` | feat | admin | `POST /api/admin/pipeline-backfill` — admin-only, walks every active suburb avec days=60 |
| 14 | `d98981c` | fix | pipeline | `_parse_address` strip "N/" prefix (`_UNIT_PREFIX_RE`) + suffix letter (`_LETTER_SUFFIX_RE`) avant regex principal. "2/80 Mooro Dr" et "110A Rochdale Rd" trouvent enfin des voisins OSM |
| 15 | `c0fd4ea` | chore | docs | Bug Tracker : déplace 7 entries vers ✅, supprime A4/A5/D7/D8 de 🟡, ajoute P4 dans 🟠 |
| 16 | `3a239ec` | chore | docs | Bug Tracker : section 🔴 vidée (les 11 routes B1-B15 sont closes depuis session 2), P3 dupliqué supprimé, ligne consolidée dans ✅ |
| 17 | `46135fe` | feat | admin | `POST /api/admin/send-digest-test` — admin-only, envoie le digest matin à soi-même |
| 18 | `4daf0b6` | ux | login | Login.jsx : "Sign in with my email" devient le bouton primaire, Enter bind à lui; "Send login link" devient secondaire outline; helper text sous chaque bouton |
| 19 | `ce9566b` | feat | rental | **Phase 1** — `db_schema.py` : `rental_listings`, `rental_owners`, `rental_suburbs`, `users.rental_access`, seed 15 suburbs |
| 20 | `01c6faf` | feat | rental | **Phase 2** — `backend/rental_scraper.py` Playwright + BS4 standalone, status lifecycle New/Active/Leased |
| 21 | `513f93c` | feat | rental | **Phase 3** — `backend/rental_api.py` 10 routes + wired in `app.py`, multi-sheet Excel import |
| 22 | `090faaa` | feat | rental | **Phase 4** — `.github/workflows/daily-scrape.yml` step "Scrape rental listings" après sales |
| 23 | `e18f285` | feat | rental | **Phase 5** — `frontend/src/pages/RentalView.jsx` + Header.jsx tab gate + AdminUsers Rental column & Rental Suburbs panel |
| 24 | `98fdda0` | ux | rental | Sidebar contextuelle : `view === 'rentals'` → sidebar slimmer rental ; sales sidebar inchangée. `RentalView` accepte `suburb`+`setSuburb` props |
| 25 | `538aa5c` | ux | rental | RentalView refonte visuelle : palette teal/blue/slate, status pill toggles, DOM badge (green/orange/red), cream-tinted owner cells, skeleton rows, empty state 🏠 icon |
| 26 | `c152cc4` | i18n | rental | Strings FR → EN ("À louer" → "For Rent", etc.) |
| 27 | `6271a4c` | perf | rental | localStorage stale-while-revalidate via `readCache/writeCache` (mirror useListings.js), composite index `(suburb, status)`, lean SELECT (drop `first_seen`/`last_seen`/`id`) |
| 28 | `0e3fd02` | ux | rental | Notes column visible sur une ligne via `<colgroup>` + widths + ellipsis + labels courts (Bd/Ba/Pk, Price/wk). Agency/Agent dropdowns (agent scoped par agency) |
| 29 | `a407d30` | fix | rental | Excel import → field-level merge: ne remplit que les colonnes vides en DB. Réponse `{inserted, enriched, skipped, suburbs}` |
| 30 | `7c1ae0b` | fix | rental | Cache localStorage : drop `.length > 0` predicate, console.log diagnostics, defensive String coercion |
| 31 | `4e7767a` | feat | rental admin | Multi-select checkbox + Save batch (`PATCH /api/admin/rental-suburbs/batch`) + Add suburb section visible + scraper inline comment + "ℹ️ Active suburbs are automatically scraped daily at 5am Perth time." |
| 32 | `f20b7ea` | feat | rental | Sidebar multi-suburb (Set<name>) + `Promise.all` parallel fetch + merged sort. RentalView accepte `selectedNames` |
| 33 | `ee1104c` | fix | rental | (a) Scraper `RENTAL_SCRAPE_ABORT_THRESHOLD=5` guard contre mass-Leased on DOM change; (b) Backend `/api/rentals/owner` accepts partial bodies (key-presence builds dynamic SET); (c) Frontend `patchOwner` envoie un seul champ; (d) **`Promise.all` → batches de 3 + 500ms gap + `Promise.allSettled` + `setLoading(false)` dans `finally`** (kill du spinner infini); (e) Select all / Deselect all dans sidebar; (f) `rentalDefaultedRef` auto-fill all suburbs au premier load |
| 34 | `f1f484c` | fix | rental | (a) `_resolve_rental_scope` simplifié : drop intersection user_suburbs (sales), tout rental-eligible user voit tous active rental_suburbs; (b) `setLoading(false)` après FIRST batch (rows stream in); (c) **Excel export** `GET /api/rentals/export[?suburb=...]` route + button next to Import |
| 35 | `bdc3f03` | sec | backend | **FIX 1** `pipeline_letter_download` : `_enrich_owner_names(conn, source_suburb)` moved APRÈS ACL check. **FIX 2** `/api/scrape/compare/<id>` : `resolve_request_scope()` gate ajouté. Helper `get_db_conn()` context manager dans database.py |
| 36 | `7cb1c44` | sec | rental | **FIX 3 partial** — 2 sites convertis à `with get_db_conn() as conn:` dans rental_api.py. 49 sites restants à sweep (carte complète plus bas) |
| 37 | `50f4799` | feat | rental | **Per-user rental suburb assignment** : `rental_user_suburbs` table + `_resolve_rental_scope` retourne explicit-set OU None fallback + 3 admin routes (GET/POST/DELETE) + AdminUsers.jsx "Rental" button + modal (mirror sales `.admin-assign-modal`) avec checkboxes + diff-based Save |

---

## 3. ÉTAT FINAL DES FEATURES

### Rental module (créé entièrement en cette session)

**DB** : `rental_listings` (UNIQUE(address,suburb) + status/suburb indexes + composite (suburb,status)) · `rental_owners` (UNIQUE(address,suburb)) · `rental_suburbs` (15 seed) · `rental_user_suburbs` (per-user assignments, fallback "all" si vide) · `users.rental_access` column.

**Backend routes** (`backend/rental_api.py`) :
- User-facing : `GET /api/rentals/suburbs`, `GET /api/rentals/<suburb>`, `PATCH /api/rentals/owner` (partial-body aware), `POST /api/rentals/import` (multi-sheet xlsx, field-level merge non-destructive), `GET /api/rentals/export[?suburb=...]` (multi-sheet xlsx avec SUMMARY)
- Admin allowlist : `GET/POST/PATCH/DELETE /api/admin/rental-suburbs[/<id>]`, `PATCH /api/admin/rental-suburbs/batch` (multi-select save)
- Admin per-user : `PATCH /api/admin/users/<id>/rental-access`, `GET/POST /api/admin/users/<id>/rental-suburbs`, `DELETE /api/admin/users/<id>/rental-suburbs/<name>`

**Scraper** (`backend/rental_scraper.py`) :
- Standalone Playwright + BS4. `RENTAL_SCRAPE_ABORT_THRESHOLD = 5` — refuse de marquer Leased si scrape vide AND ≥5 active rows en DB.
- Délais 1-2s/page, 5-7s/suburb (NE PAS RÉDUIRE).
- Lifecycle New/Active/Leased.
- Wired into `.github/workflows/daily-scrape.yml` après le sales step.

**Frontend** (`frontend/src/pages/RentalView.jsx`) :
- Multi-suburb fetch par batches de 3 + 500ms gap (kill du spinner infini).
- `setLoading(false)` dans `finally` ET après le FIRST batch (rows stream in).
- `AbortController` sur suburb-set change.
- `setListings(sortMerged(all))` à chaque batch — table populée progressivement.
- localStorage stale-while-revalidate par suburb (key `sd_cache_v3_<16hex>_rentals_<suburb-lower>`).
- Sidebar contextuelle dans App.jsx (`view === 'rentals'` → liste rental_suburbs, checkboxes multi-select, Select all / Deselect all, default fill all).
- Header h2 : "Rental — Cottesloe" (1) / "Rental — N suburbs" / "Rental".
- Counter : "Loaded X / Y suburbs" (amber si X<Y après fin de load).
- Status pill toggles "For Rent (n)" / "Leased (n)" client-side filter.
- Agency / Agent dropdowns (agent scoped par agency, useEffect reset on agency change).
- Compact mode toggle (`rentals_compact` localStorage).
- DOM badge green/orange/red ≤14d / ≤30d / >30d.
- Owner cells cream tint (#fefce8) + dotted underline hover + save-flash 1.2s.
- Excel import button (BACKEND_DIRECT) + Excel export button (BACKEND_DIRECT, ?suburb si 1 sélectionné).
- Status badges premium palette : New blue saph / Active teal / Leased slate italic.
- Skeleton rows pendant fetch initial.
- Empty states context-aware.

**Admin UI** (`frontend/src/pages/AdminUsers.jsx`) :
- "Rental" column avec ON/OFF pill par user (admins auto-on).
- "Rental" action button per row → modal per-user assignment (checkboxes, diff-based save).
- "Rental Suburbs" panel : multi-select checkboxes + Select all / Deselect all + Save changes (batch endpoint), visible Add suburb section, "ℹ️ Active suburbs are automatically scraped daily at 5am Perth time."

### Autres features ajoutées

- `POST /api/admin/pipeline-backfill` — admin-only one-shot, regenerate pipeline_tracking for every active suburb (days=60).
- `POST /api/admin/send-digest-test` — admin envoie le digest à soi-même.

---

## 4. RÈGLES DE TRAVAIL (intégrales — exact carbon du début de session)

**Process strict** :
1. Diff avant push : montrer le diff complet, attendre validation user (sauf batching autorisé via "always go" / "push direct sans attendre").
2. Un fix à la fois sauf instruction explicite de batcher.
3. Push sur les 2 branches : `claude/fix-scraper-missing-listings-PlwVM` ET `main`. **main bloqué 403 toute la session → skip silencieux.** Working branch session = `claude/fix-scraper-listings-2WFqJ`.
4. `py_compile` obligatoire sur tout fichier backend modifié AVANT commit.
5. Vite build local sur tout fichier frontend modifié — workaround xlsx tarball CDN bloqué :
   ```bash
   cd frontend && cp package.json package.json.bak && \
   python3 -c "import json; p=json.load(open('package.json')); p.get('dependencies',{}).pop('xlsx',None); p.get('devDependencies',{}).pop('xlsx',None); json.dump(p, open('package.json','w'), indent=2)" && \
   npm install --no-audit --no-fund --silent && npm run build && \
   mv package.json.bak package.json && rm -rf node_modules dist
   ```
6. Pas de refactor gratuit.
7. No new dependencies sans demande explicite.
8. Lire les fichiers en entier avant fix touchant à de la logique non-triviale.
9. Cite file:line pour chaque claim dans les audits.
10. Cache version bump quand le format de réponse API change (CACHE_VERSION = 'v3').
11. Migrations idempotentes dans `db_schema.py`, wrappées try/except.
12. Routes admin/scoped : toujours `_require_admin()` ou `resolve_request_scope()`.
13. **Tout le code et strings UI en anglais** (cible AU). Helper-text login restés en EN malgré l'exemple FR dans le prompt — règle 13 prime.
14. CLAUDE.md à racine : référence HEAD régulièrement mis à jour cette session (3 commits docs).

**Format commit** :
- Prefixes : `fix:` `feat:` `perf:` `ux:` `sec:` `chore:` `i18n:`
- Body explique le pourquoi, pas le quoi. Référence files:lines.
- HEREDOC pour multi-line.
- Pas de "Co-Authored-By", pas de "Generated with Claude".

---

## 5. AUDIT RESULTS (3 agents parallèles, fin de session)

Audit lancé en background, 3 agents (backend / rental+scrapers / frontend), 93 findings totaux.

**Severity mix** : 15 BLOQUANT, 31 DÉGRADÉ, 17 LENT, 30 SILENCIEUX.

**BLOQUANT items fixés cette session** :
- ✅ `bdc3f03` — `pipeline_letter_download` enrich-before-ACL leak (audit B/3)
- ✅ `bdc3f03` — `/api/scrape/compare/<id>` no scope (audit B/1-2)
- ✅ `ee1104c` — Rental scraper mass-Leased on DOM change (audit R/7+8)
- ✅ `ee1104c` — RentalView owner PATCH race (audit F/3)
- ✅ `ee1104c` — RentalView no AbortController on suburb switch (audit F/2)
- ✅ `ee1104c` — Spinner infini sur Promise.all 15 suburbs (audit F implicit)

**BLOQUANT restants (non touchés)** :
- Pipeline.jsx:312 `/api/pipeline/generate` via Vercel proxy → 504 + infinite retry loop
- Pipeline.jsx:401 patchEntry via Vercel proxy + silent failure (optimistic state diverges from DB)
- HotVendorScoring.jsx:495-510 setStatus PATCH silent failure (UI vs DB diverge)
- SetPasswordModal.jsx:33-36 no logout fallback when API permanently fails
- app.py:48 seed_admin_if_needed swallows init_db exception (admin locked out)
- **51 sites get_db()/conn.close() without try/finally** (sweep started in `7cb1c44`, 2 sites done in rental_api.py, 49 remaining — voir section 7)

---

## 6. BUGS RESTANTS DOCUMENTÉS

**Pipeline cold-start (Vercel proxy)** :
- `Pipeline.jsx:312` `/api/pipeline/generate` — 504 → retry → 504 loop. Switch to BACKEND_DIRECT (single-line fix).
- `Pipeline.jsx:401` patchEntry — silent failure. Switch to BACKEND_DIRECT + visible "Save failed — retry" badge.
- `Pipeline.jsx:992` manual-add — same fix.
- `Header.jsx:117` Export listings (.xlsx) — same fix.
- `Pipeline.jsx:677` PipelinePrint via window.open — bypass interceptor (low risk per audit).

**HotVendors data-loss / races** :
- `HotVendorScoring.jsx:495-510` setStatus error swallowed silently. Revert on catch + toast.
- `HotVendorScoring.jsx:135-158` auto-load races with in-flight upload.
- `HotVendorScoring.jsx:125,179` `reportCache.current` unbounded growth.
- `HotVendorScoring.jsx:289-316` resume effect double-fires under StrictMode.

**App.jsx bootstrap** :
- `App.jsx:50-77` `/api/admin/me` + `/api/rentals/suburbs` via Vercel proxy at mount → cold start can hide Rental tab.
- `App.jsx:248,280` `await res.json()` after non-ok → crashes on HTML 502.
- `App.jsx:306-322` scrapeSuburb/Selected sans res.ok check.

**Auth / scope** :
- `auth_api.py:48-62` email enumeration via 404/401 distinction.
- `auth_api.py:28-46` no rate limit on magic-link request.
- `admin_api.py:326-336` no audit log on role change.

**Data correctness** :
- `pipeline_api.py:1226` `sold_date != SUBSTR(first_seen,1,10)` excludes legitimate same-day sales.
- `listings_api.py:108-115` sold_price PATCH stores int-string, scraper stores "$1,250,000" — sort inconsistency.
- `import_api.py:295-303` import_rpdata pulls every listing in DB into memory (~10MB at scale).
- `database.py:264-289` LEFT JOIN listing_notes without single-column index on `listings.normalized_address`.

**Rental edge cases** :
- `rental_api.py:265-272` import fill-empty-only too conservative for `status` / `date_leased` (lifecycle fields should always overwrite).
- `rental_scraper.py:84-88` `'today' in txt` substring match → fuzzy date_listed corruption ("Auction today at 12pm" → date_listed=today).
- `rental_scraper.py:149-156` price regex doesn't capture "$2,600 - $2,800" weekly ranges → blank price.
- `scraper_detail.py:300-302` Playwright timeout confused with 'gone' status → false withdrawals.

**Cron / infra** :
- `keep-render-warm.yml:35` `exit 1` after 3 failed pings — no alert configured.
- `daily-scrape.yml:60-65` rental scrape step shares `timeout-minutes: 350` budget with sales — risk of mid-run kill.

---

## 7. CONN-LEAK SWEEP — état précis

`backend/database.py` exporte maintenant `get_db_conn()` context manager (commit `bdc3f03`). Migration de l'existant en cours :

| File | Total sites | Converted | Remaining |
|------|-------------|-----------|-----------|
| `app.py` | 11 | 0 | **9 unsafe** (9 mapped + 2 already-safe) |
| `admin_api.py` | 11 | 0 | **9 unsafe** |
| `pipeline_api.py` | 13 | 0 | **11 unsafe** |
| `hot_vendors_api.py` | 11 | 0 | **7 unsafe** |
| `rental_api.py` | 11 | 2 ✅ | 9 unsafe (mostly `try/finally` already) |
| `auth_api.py` | 4 | 0 | **4 unsafe** |
| `listings_api.py` | 2 | 0 | **2 unsafe** |
| `import_api.py` | 1 | 0 | **1 unsafe** |
| `export_api.py` | 1 | 0 | **1 unsafe** |
| **TOTAL** | **65** | **2** | **53** |

(Plus 23 sites in `database.py` / `db_schema.py` / scripts — non-route, lower priority.)

Mapping exact des unsafe sites (output de la session pour reprise) :

```
app.py: 103, 159, 171, 209, 276, 339, 423, 446, 478, 512, 620
admin_api.py: 61, 90, 122, 164, 218, 338, 359, 367, 383
pipeline_api.py: 605, 730, 768, 835, 881, 1010, 1084, 1197, 1220, 1376, 1416
hot_vendors_api.py: 538, 605, 658, 693, 854, 921, 940
rental_api.py: 425, 515, 703, 719, 754, 799, 821, 851 (8 remaining, mostly already in try/finally)
auth_api.py: 34, 56, 91, 136
listings_api.py: 140, 192
import_api.py: 291
export_api.py: 368
```

Pattern de conversion (mécanique mais indent-sensitive) :

```python
# Before:
conn = get_db()
... body ...
conn.close()

# After:
with get_db_conn() as conn:
    ... body indented ...
```

**Prompt prêt pour la prochaine session** :

> Continue the get_db_conn sweep started in bdc3f03 / 7cb1c44. Convert every remaining `conn = get_db(); ...; conn.close()` site (53 mapped above) to `with get_db_conn() as conn:`. One file per commit, py_compile after each, push both branches. Start with admin_api.py.

---

## 8. CLAUDE.md (racine) — état

À jour des derniers refresh (`9de1338` → `c0fd4ea` → `3a239ec`). Section 🔴 Sécurité vidée (11 routes B1-B15 closes). 🟡/🟠/✅ refrechies. À refresh aux prochains commits :
- Ajouter une section "Rental module" résumant l'architecture (DB, routes, scraper, frontend).
- Documenter `get_db_conn` comme nouveau pattern obligatoire pour les nouvelles routes.
- Documenter `rental_user_suburbs` + fallback "no rows = all".
- Ajouter `RENTAL_SCRAPE_ABORT_THRESHOLD` à la liste des constantes critiques.

---

## 9. PROCHAINS FIXES PRIORITAIRES (top 5 par sévérité)

1. **Pipeline cold-start sweep** — `Pipeline.jsx:312,401,992` + `Header.jsx:117` : 4 swaps de `/api` → `BACKEND_DIRECT`. ~10 min total. **BLOQUANT**.
2. **HotVendor setStatus silent failure** — `HotVendorScoring.jsx:495-510` : on catch, revert optimistic + toast. ~15 min. **BLOQUANT (data loss)**.
3. **Conn-leak sweep** — 53 sites restants, fichier par fichier. ~1-2h dédié. **BLOQUANT under load**.
4. **App.jsx bootstrap cold-start** — `/api/admin/me` + `/api/rentals/suburbs` → BACKEND_DIRECT + `fetchWithRetry`. ~10 min. **DÉGRADÉ** (Rental tab cachée si me=null).
5. **SetPasswordModal logout escape hatch** — `SetPasswordModal.jsx:33-36` : sign-out link inside the card to clear access_key + reload. ~10 min. **BLOQUANT** (user stuck).

---

## 10. ÉTAT BRANCHES AU HANDOFF

```
Local & remote claude/fix-scraper-missing-listings-PlwVM HEAD = 50f4799
Local & remote claude/fix-scraper-listings-2WFqJ        HEAD = 50f4799 (synced)
Remote main                                              HEAD = a4887f0 (28+ commits de retard, push 403)
```

Auto-deploy GHA workflow déploie depuis PlwVM → Render. Tous les fixes de cette session sont LIVE sur prod après chaque push (Render redeploy ~2-3 min). Vercel frontend redeploy via `npm run build` côté Vercel sur push de PlwVM.

**`main` bloqué depuis 5+ sessions** — décision opérateur requise (lever protection / PR PlwVM → main / push manuel local). Tant que main n'est pas sync, le repo GitHub homepage affiche du code de plusieurs mois en arrière.

---

## 11. PROMPTS PRÊTS À EXÉCUTER (au prochain démarrage)

### A — Pipeline cold-start sweep (BLOQUANT, ~10 min)

> Repo MarketScraper. Branche claude/fix-scraper-missing-listings-PlwVM. Push 2 branches. 4 swaps mécaniques de Vercel proxy vers BACKEND_DIRECT pour kill les cold-start 504 :
> - Pipeline.jsx:312 `/api/pipeline/generate` → BACKEND_DIRECT
> - Pipeline.jsx:401 patchEntry → BACKEND_DIRECT + visible "Save failed" toast on catch
> - Pipeline.jsx:992 manual-add → BACKEND_DIRECT
> - Header.jsx:117 export listings → BACKEND_DIRECT
> Vite build. Push direct.

### B — Conn-leak sweep (BLOQUANT under load, 1-2h)

> Continue the get_db_conn sweep started in bdc3f03/7cb1c44. Convert 53 remaining sites (mapping in handoff §7). One file per commit, py_compile after each, push both branches. Start with admin_api.py.

### C — HotVendor setStatus revert (BLOQUANT data loss, ~15 min)

> Repo MarketScraper. Branche PlwVM. Push 2 branches. `HotVendorScoring.jsx:495-510` setStatus catches the PATCH error with only console.error. Add: on catch, revert setStatuses for that row + toast "Could not save status — please retry". Pattern from saveNote handler in the same file. Vite build. Push.

### D — App.jsx bootstrap cold-start (DÉGRADÉ, ~10 min)

> Repo MarketScraper. Branche PlwVM. Push 2 branches. App.jsx:50-77 fetches `/api/admin/me` and `/api/rentals/suburbs` via Vercel proxy at mount. Switch both to BACKEND_DIRECT + fetchWithRetry from lib/api. Rental tab visibility breaks on cold-start without this. Vite build. Push.

### E — SetPasswordModal escape hatch (BLOQUANT, ~10 min)

> Repo MarketScraper. Branche PlwVM. Push 2 branches. SetPasswordModal.jsx is non-dismissible — when API is permanently unreachable, user is stuck. Add a small "Sign out" link inside the modal that clears access_key from localStorage and reloads. Vite build. Push.

---

## 12. INSIGHTS DE LA SESSION (pour le prochain agent)

1. **CLAUDE.md "Prompts prêts à exécuter" works** — Louis adds new tasks faster than agents can ship. The queue pattern (user queues prompt → agent finishes current + addresses next) ran ~15 times this session without breakage. New tasks via system-reminder arrive mid-edit; finish the file, push, address next.

2. **The user's hypothesis is sometimes wrong, but the bug is real** — three times this session the user diagnosed a bug with wrong root cause (cache TTL, partial-body PATCH, conn-pool exhaustion) but the symptom was a real bug. Always verify with code reads before agreeing with the hypothesis OR pushing back.

3. **Multi-suburb Promise.all on Render free dyno = death** — saturates the worker pool, some requests never resolve, `try/finally` on the IIFE never fires. Pattern that works: batches of 3 + 500ms gap + `Promise.allSettled` + `setLoading(false)` in unconditional `finally`. Used twice this session (Rental fetch + import refresh).

4. **`with get_db_conn() as conn:` requires indent-sensitive edits** — the user wanted a 53-site sweep in one session; I shipped 2 demonstrative sites + the helper + a clean map for the rest. The user accepted this scope. Lesson: be honest about edit volume vs context budget.

5. **REIWA DOM changes are an existential threat to the rental scraper** — single class rename (`p-details__add`) flips every listing Leased. `RENTAL_SCRAPE_ABORT_THRESHOLD = 5` guard ships in `ee1104c`. Sales scraper has its own `confident` guard (different mechanism). Both need watching.

6. **Vercel 25s edge timeout** is the #1 prod issue. Every NEW heavy backend call must go via `BACKEND_DIRECT` from day one. The conn-leak sweep is the #2 prod issue (latent). #3 is HotVendor silent failures.

7. **All audit findings are recoverable as Top-10 ready-to-paste prompts** at end of audit report — Louis liked that format. Repeat it.

Fin du handoff. Branche PlwVM ready à recevoir le prochain fix.
