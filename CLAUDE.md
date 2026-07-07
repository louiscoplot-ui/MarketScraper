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
| Cron | GitHub Actions | sales `0 16 * * 0-5`, rentals `30 16 * * 0-5` UTC = minuit Perth lun–sam (dimanche Perth supprimé — conso proxy) |
| Proxy | IPRoyal résidentiel (facturé/GB) | direct-d'abord + cache JS depuis 07/07 — escalade auto si challenge Cloudflare |

**Repo** : github.com/louiscoplot-ui/MarketScraper
**Branche prod** : `claude/fix-scraper-missing-listings-PlwVM`

---

## Règle branches — Push sur PlwVM UNIQUEMENT

```bash
git push origin HEAD:claude/fix-scraper-missing-listings-PlwVM
```

**`main` est une branche orpheline archivée — ne jamais pusher dessus.**
Historiques divergents : `git merge-base HEAD origin/main` retourne vide.
Tout push sur `main` (normal ou `--force`) est interdit.

La branche courante de session (ex: `claude/fix-sprint-handoff-path-XXXX`) peut
être poussée en miroir si utile, mais PlwVM est la seule branche prod.

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

### 🔴 Sécurité (cross-tenant leaks)

**Sprint S0 clos au HEAD le 02/07/2026** — B1–B15 (scope/ACL backend) et
D7/D8 (BACKEND_DIRECT frontend) vérifiés route par route, plus S-1/S-2/S-3
mergés en prod (voir ✅ Fixés récemment). Aucune faille ouverte au HEAD.
Garder le pattern pour toute nouvelle route :
`resolve_request_scope()` ou `_require_admin()` en tête.

### 🟡 UX dégradée

Aucune ouverte au HEAD (07/07/2026). D10 et D17 étaient déjà fixés dans
les composants réécrits (AdminUsers.jsx `refresh()` après save ;
ListingsView.jsx alerte nommée par adresse) — entrées tracker périmées.

### 🟠 Performance

Aucune ouverte au HEAD (07/07/2026).
- P1 : mitigé — `_real_neighbours` est OSM-first avec cache
  (pipeline_api.py) ; le LIKE n'est plus qu'un fallback rare, borné
  LIMIT 1000, non indexable (wildcard initial).
- P2 : fixé — un seul fetch `/api/suburbs` au mount.
- P4 : fixé — pipeline auto-généré dans le cron nocturne (cab84d5).

### 🔵 Scraper / Data

Aucune ouverte au HEAD (07/07/2026). S1 ("20/20 new") fixé par
`normalize_reiwa_url` (source unique de vérité des URLs).

**Correction historique S2 (07/07/2026)** : le narratif du 02/07 était
faux. La branche par défaut du repo EST PlwVM (pas main) ; le vrai
workflow nightly est `.github/workflows/scrape_sales.yml` (16:00 UTC)
+ `scrape_rental.yml` (16:30 UTC), hébergés et exécutés sur PlwVM.
Les vraies causes des trous de données : Cloudflare (17-19/06), quota
Neon (24/06-01/07), solde IPRoyal (01-03/07).

### 💰 Conso proxy (fix 07/07/2026, commit 9f15b7b)

~430MB/nuit → ~0 (direct passe) ou ~130MB (nuit entière via proxy).
Trois mécanismes, tous dans scraper_utils.py :
1. Cache JS in-process (l'interception route désactivait le cache
   Chromium → 1.7MB re-téléchargés par page = 70% de la facture).
2. Direct-d'abord : proxy seulement après challenge Cloudflare détecté
   (`proxy_forced()` process-wide) ; verify_disappeared protégé contre
   les faux 'gone' en direct (retry batch complet via proxy).
3. Run du dimanche Perth supprimé (cron `* * 0-5`).
Vérif : logs GHA `proxy=on/off | asset cache {hits, mb_saved}`.

### ✅ Fixés récemment

| Fix | Commit |
|-----|--------|
| SENTINEL S1-S4 mergé en prod — events, signaux vendeurs, prediction ledger, morning brief + Today view (07/07/2026) | d85739c…7d82b11 |
| Conso proxy −70% min : cache JS + direct-d'abord + skip dimanche | 9f15b7b |
| Market Trends figés — snapshots désormais pris par le cron nocturne | b9569b0 |
| Badge sale-fallen cliquable — panneau adresse/date + GET /api/signals/sale-fallen | 8a73ad1 |
| Sprint S0 clos — B1-B15 + D7/D8 audités au HEAD, prod synchro (02/07/2026) | — |
| S-1 — admin takeover via login-by-email (grace path) | 4f78299 |
| S-2 — scope manquant sur /api/rentals/export | 53fc20a |
| S-3 — scope-gate POST /api/hot-vendors/uploads (legacy) | fa10667 |
| UX-1 — placeholders contact sur lettres clients | c532cc4 |
| D-3 — backfill sold_date destructif → one-shot (table schema_migrations) | aad303b |
| B-8 — faux succès magic-link sur cold start Render | 5b98ef4 |
| Set/Change password UI (contrepartie S-1) | 0b0246d, 2f8edec |
| Cron daily-scrape → exécute le code PlwVM au lieu de main archivé | main |
| Script filet de sécurité backup_sold_dates.py (avant migration D-3) | — |
| Sécurité — 11 routes scope-gated (B1-B15) | 572a192…8acb545 |
| Adresses strata/suffixe lettre OSM (2/80, 110A) | d98981c |
| Pipeline backfill route admin one-shot | 5066f38 |
| Pipeline auto-gen dans cron daily 5am | cab84d5 |
| Pipeline day filter (DD/MM/YYYY + ISO dual format) | 2076d62 |
| fetchScrapeStatus via BACKEND_DIRECT (D7) | 2fe9402 |
| Excel export 5min → 30s via lru_cache (A6/P3) | 28db44a |
| HotVendors spinner + cache mémoire switch report (A4) | 61d1d80 |
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

---

## Prompts prêts à exécuter

### A5 — Export CSV feedback bouton
Lis frontend/src/HotVendorScoring.jsx en entier.
Ajouter isExportingCSV state (useState false). Au clic export CSV : disabled + "Exporting...".
Après blob : reset. Copier pattern bouton download existant dans le fichier.
Ne pas toucher logique fetch+blob. Vite build. Diff. Attends validation.

### A6 — Export Excel trop lent
Lis le fichier backend qui génère l'export Excel en entier (chercher route /api/export ou /api/hot-vendors/export).
Problème : 5min+ pour 3000 lignes. Probablement openpyxl cell-by-cell en mode normal.
Fix : passer en write_only mode + append_row(). Si pandas déjà importé : DataFrame.to_excel().
Pas de nouvelle dépendance sans accord. py_compile. Diff. Attends validation.

### D7 — fetchScrapeStatus timeout
Lis App.jsx ou le composant scrape status en entier.
fetchScrapeStatus passe par Vercel proxy → timeout 25s. Remplacer URL par BACKEND_DIRECT.
Ne pas changer logique fetch ni gestion erreur. Vite build. Diff. Attends validation.

### D8 — downloadLetter timeout
Lis LetterGenerator.jsx en entier.
downloadLetter passe par Vercel proxy → timeout. Remplacer par BACKEND_DIRECT + fetch+blob.
Pattern : voir bouton Word déjà authentifié dans le même fichier. Vite build. Diff. Attends validation.
