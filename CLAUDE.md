# SuburbDesk — CLAUDE.md

Lu automatiquement à chaque session Claude Code. Source de vérité unique.
Agents spécialisés dans `.claude/` — lire avant chaque intervention.

---

## Identité projet

**Produit** : SuburbDesk (SaaS B2B leads vendeurs Perth WA)
**Fondateur** : Louis Coplot, agent Acton|Belle Property Cottesloe WA
**Vision** : livrer chaque matin aux agences premium de Perth les leads vendeurs scorés
**Stade** : MVP live, validation demande en cours, 0 client payant
**Domaine** : suburbdesk.com

---

## Stack

| Couche | Tech | URL |
|--------|------|-----|
| Frontend | React 18 + Vite 5 | suburbdesk.com (Vercel) |
| Backend | Flask 3 + Python | marketscraper-backend.onrender.com (Render free) |
| DB | Postgres (Neon prod) / SQLite local | `USE_POSTGRES` flag |
| Scraper | Playwright + BeautifulSoup4 | Source : REIWA.com.au |
| Email | Resend HTTP API | `RESEND_API_KEY` env |
| Letters | python-docx | |
| Cron | GitHub Actions | `0 21 * * *` UTC = 5h Perth |

**Repo** : github.com/louiscoplot-ui/MarketScraper
**Branche prod** : `claude/fix-scraper-missing-listings-PlwVM`

---

## Règle branches — TOUJOURS pousser sur 2 branches

```bash
git push origin HEAD:claude/fix-scraper-missing-listings-PlwVM
git push origin HEAD:<branche-courante-de-session>
```

La branche courante change à chaque session Claude Code (ex: `claude/fix-scraper-listings-2WFqJ`).
Vérifier avec `git branch --show-current` avant de pusher.
Si `main` bloqué en 403 → skip sans bloquer.

---

## Auth

- `access_key` : 32-char hex par user
- localStorage key : `agentdeck_access_key`
- HTTP header : `X-Access-Key`
- Interceptor global `main.jsx` — injecte header sur `/api/*`
- **`window.open()` et `<a href>` BYPASS l'interceptor** → tout download binaire = fetch+blob obligatoire
- Gate `before_request` dans `app.py` — exempt : `/api/auth/`, `/api/ping`
- `ADMIN_EMAIL` env → `role='admin'` automatique

---

## Vercel Timeout

**Hard limit : 25s.** Tout appel pouvant dépasser → utiliser BACKEND_DIRECT.

```js
// lib/api.js:15
const BACKEND_DIRECT = 'https://marketscraper-backend.onrender.com'
```

Utilisé par : Pipeline, Hot Vendors, Market Report, PipelinePrint, Letters.

---

## Multi-tenant / Scoping

```python
resolve_request_scope()   # → (user, allowed_ids|None) — None = admin
_require_admin()          # → 403 si non-admin
user_can_access_suburb()
get_user_allowed_suburb_names()
```

**Toute nouvelle route doit checker le scope.** Faille critique si absent.

---

## Règles non-négociables

| Règle | Detail |
|-------|--------|
| `py_compile` | Obligatoire sur TOUT fichier backend `.py` modifié |
| `Vite build` | Obligatoire sur TOUT fichier frontend modifié |
| Diff avant push | Toujours montrer le diff complet, attendre validation Louis |
| Un fix à la fois | Pas de batch sans accord explicite |
| Pas de refactor | Zéro amélioration non demandée |
| No new deps | Pas de nouvelle dépendance sans demande |
| fetch+blob | Jamais window.open pour downloads binaires |
| Migrations | Idempotentes, dans db_schema.py, wrappées try/except |
| Scope check | resolve_request_scope() ou _require_admin() sur toute route |
| Cite file:line | Pour chaque claim dans les audits |

---

## Format commit

```
fix(scope): résumé une ligne ≤72 chars

- Pourquoi ce changement (pas ce que le diff montre déjà)
- Edge case couvert si applicable
- Impact attendu
```

Préfixes : `fix:` `feat:` `perf:` `ux:` `sec:` `chore:`
Pas de "Co-Authored-By", pas de "Generated with Claude".

---

## Agents disponibles dans `.claude/`

| Agent | Quand l'utiliser |
|-------|-----------------|
| `suburbdesk-bugfixer` | Bug reporté — screenshot, erreur console, UI cassée |
| `suburbdesk-feature` | Nouvelle feature décrite en langage naturel |
| `suburbdesk-shipper` | Changements prêts → commit + dual-branch push |

---

## Bug Tracker — Statut HEAD

### 🔴 Sécurité (cross-tenant leaks) — PRIORITÉ MAX

| ID | Route | Problème | Fichier |
|----|-------|----------|---------|
| B1 | `GET /api/scrape/audit` | Dump toutes suburbs sans scope | scrape_api.py |
| B2 | `GET /api/hot-vendors/lookup` | Leak RP Data sans scope | hot_vendors_api.py |
| B3 | `PATCH /api/listings/<id>` | Write cross-tenant | listings_api.py |
| B4 | `PATCH /api/listings/note` | Write cross-tenant | listings_api.py |
| B5 | `PATCH /api/hot-vendors/note+status` | Write cross-tenant | hot_vendors_api.py |
| B7 | `/api/scrape/all` + `/api/scrape/cancel` | DoS sans ACL | scrape_api.py |
| B8 | `/api/scrape/debug/*` | Playwright sans ACL | scrape_api.py |
| B11 | `POST /api/import/rpdata` | Import cross-tenant | import_api.py |
| B15 | `GET /api/scrape/logs` | Dump toutes agences | scrape_api.py |

Fix pattern : `resolve_request_scope()` ou `_require_admin()` en tête de route.

### 🟡 UX dégradée

| ID | Composant | Problème | Fichier |
|----|-----------|----------|---------|
| D7 | ScrapeStatus | fetchScrapeStatus via Vercel proxy → timeout | App.jsx |
| D8 | Letters | downloadLetter via Vercel proxy → timeout | LetterGenerator.jsx |
| D10 | Admin | saveAssignments ne refresh pas liste users | AdminPanel.jsx |
| D17 | Listings | saveNote alert tardif sans contexte | ListingsTable.jsx |
| A4 | HotVendors | Pas de spinner + pas de cache sur switch rapport | HotVendorScoring.jsx |
| A5 | Listings | Export CSV : pas de feedback bouton | ListingsTable.jsx |

### 🟠 Performance

| ID | Problème | Fichier |
|----|----------|---------|
| P1 | `_real_neighbours` LIKE sans index → 6s | database.py |
| P2 | Double fetch `/api/suburbs` au mount | App.jsx |
| P3 | Export Excel 5min+ / 3000 lignes | export ou hot_vendors_api.py |

### 🔵 Scraper / Data

| ID | Problème | Fichier |
|----|----------|---------|
| S1 | "20/20 new" logs — trailing slash REIWA | scraper.py |
| S2 | Cron heure à vérifier (doit être `0 21 * * *` UTC) | .github/workflows/ |

### ✅ Fixés récemment

| Fix | Commit |
|-----|--------|
| Pipeline sold_date filtre strict + empty state | — |
| Report.jsx : Withdrawn en premier dans report-tables | 1149e75 |
| Multi-tenant profiles + suburb scoping | b39871c |
| Pipeline perf OSM prefetch async | 9208b4f |
| Keep-alive Render 14min | b6c9951 |
| Logo Acton lettre header green | 0327b83 |

---

## Pricing SaaS (validé, pas encore implémenté)

- Starter $99/mo : 1 suburb, 1 user, scrape 5am
- Pro $199/mo : 5 suburbs, 2 users, scrape 2x/jour, email digest
- Agency $349/mo : suburbs illimités, multi-user, white-label

---

## Patterns fréquents — copier/coller

### Download binaire authentifié
```js
const res = await fetch(`${BACKEND_DIRECT}/api/route`, {
  headers: { 'X-Access-Key': localStorage.getItem('agentdeck_access_key') }
})
const blob = await res.blob()
const url = URL.createObjectURL(blob)
const a = document.createElement('a'); a.href = url; a.download = 'file.xlsx'; a.click()
URL.revokeObjectURL(url)
```

### Route backend scopée
```python
@app.route('/api/resource', methods=['GET'])
def get_resource():
    user, allowed_ids = resolve_request_scope()
    # allowed_ids = None → admin, pas de filtre
    # allowed_ids = [1,2,3] → filtrer par suburb_id IN allowed_ids
```

### Migration idempotente
```python
# db_schema.py
try:
    _Cur.execute("ALTER TABLE listings ADD COLUMN new_col TEXT")
except Exception:
    pass  # déjà existe
```
