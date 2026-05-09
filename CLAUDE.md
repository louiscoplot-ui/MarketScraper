# CLAUDE.md — SuburbDesk / MarketScraper

Lis ce fichier en entier avant chaque session. Il contient tout le contexte du projet.

---

## IDENTITE PROJET

Nom produit : SuburbDesk (nom repo : MarketScraper)
Fondateur : Louis Coplot, agent Belle Property Cottesloe, Perth WA
Vision : SaaS B2B leads vendeurs scores pour agences premium Perth WA
Stade : MVP live, 0 client payant, validation demande en cours
Cible principale : Acton | Belle Property (reseau Australie)
Domaine : www.suburbdesk.com

---

## REPO & BRANCHES

Repo : github.com/louiscoplot-ui/MarketScraper
Branche prod : claude/fix-scraper-missing-listings-PlwVM
Working branch locale : claude/fix-scraper-listings-4uUz9
HEAD prod actuel : 087f700

Push pattern obligatoire a chaque commit :
```
git push origin claude/fix-scraper-listings-4uUz9:claude/fix-scraper-missing-listings-PlwVM
git push origin claude/fix-scraper-listings-4uUz9:claude/fix-scraper-listings-4uUz9
# main -> 403 branch protection, skip systematiquement
# main est 24+ commits derriere PlwVM
```

---

## STACK

- Backend : Flask 3.0 + Postgres (Neon prod, DATABASE_URL) / SQLite local (reiwa.db, gitignored)
- No ORM. Raw SQL via _Conn/_Cur wrapper dans database.py
- Frontend : React 18.3.1 + Vite 5.4.11. No React Router. View state synced URL hash (App.jsx).
- Scraper : Playwright (Chromium) + BeautifulSoup4. Source : REIWA.com.au
- Email : Resend HTTP API (RESEND_API_KEY, EMAIL_FROM envs)
- Letters : python-docx
- Hosting : Vercel (frontend, 25s timeout HARD) + Render free tier (backend, cold start 30-60s)
- Cron : GitHub Actions 0 21 * * * UTC = 5am Perth
- Deps notables : bcrypt>=4.1.0 (password hashing, ajoute session 3)

---

## CONTRAINTES CRITIQUES

### Vercel 25s timeout HARD

Tout appel frontend pouvant depasser 25s DOIT passer par BACKEND_DIRECT.
BACKEND_DIRECT = https://marketscraper-backend.onrender.com (lib/api.js:15)
Deja sur BACKEND_DIRECT : Pipeline (generate, tracking, recent-sales, letter download),
Hot Vendors uploads, Market Report, PipelinePrint, Excel export
Pattern dangereux : fetch('/api/...') sur routes lentes -> timeout silencieux

### Render cold start 30-60s

Backend dort apres 15min idle. Keep-alive ping 14min en place (main.jsx).
Toujours afficher un message loading sur appels lents.
Pipeline affiche compteur 35->0 avec bouton Cancel pendant cold start.

### Auth interceptor

Header : X-Access-Key
localStorage key : agentdeck_access_key
Interceptor global : main.jsx:24-36 patches window.fetch sur /api/* et BACKEND_DIRECT/api/*
CRITIQUE : window.open() et href bypassen l'interceptor -> 401 silencieux
Regle absolue : tout download binaire = fetch+blob, jamais window.open

### REIWA rate limit

Delays 5-15s minimum entre requetes scraper. Ne jamais reduire sans tester.
Block IP = perte du scraper entier.

### Exceptions DB

Neon prod = psycopg2. Local = SQLite. Catcher les deux exceptions.
Ne pas utiliser sqlite3.IntegrityError seul en prod.

### Cache localStorage

CACHE_VERSION = v3
Keys : sd_cache_v3_<16-char-key-prefix>_<suffix>
Bump CACHE_VERSION si format reponse API change.

---

## AUTH

- access_key : 32-char hex, secrets.token_hex(16)
- Gate backend : app.py:73-85, exempts /api/auth/ et /api/ping
- ADMIN_EMAIL env : force role=admin (admin_api.py:74-76)
- POST /api/auth/login-by-email : body {email, password}
  Si password_hash set : bcrypt.checkpw -> 401 si fail
  Si password_hash NULL : grace 200 {access_key, password_set: False}
- POST /api/users/me/set-password : body {password}, min 8 chars, bcrypt.hashpw
  Route protegee par X-Access-Key (pas exemptee du gate)
- POST /api/auth/request-login-link : magic link via Resend (inchange)
- SetPasswordModal : modale non-dismissible forcee par AuthGate si password_set=false
  Pas de bouton x, pas de backdrop click, pas d'ESC
  Seul exit = submit valide -> window.location.reload()
- _row_to_dict : strip password_hash, expose password_set: bool

---

## MULTI-TENANT SCOPING (securite critique)

Toute route backend DOIT checker le scope avant de lire ou ecrire des donnees.
14 failles securite fermees en session 2 (commits 572a192 a 8acb545).

Helpers dans admin_api.py :

resolve_request_scope() -> (user, allowed_ids|None)
  None = admin (pas de filtre)
  liste vide = user sans suburbs assignes -> retourner []

user_can_access_suburb(name) -> bool
  Pour routes par nom de suburb (free text)

_require_admin() -> (user, err_response|None)
  Pour routes admin-only. Si non-admin : retourne 403.

get_user_allowed_suburb_names() -> (user, lower_names_set|None)
  None = admin

Pattern obligatoire sur toute route scopee :
```python
_user, allowed_ids = resolve_request_scope()
if allowed_ids is not None and suburb_id not in allowed_ids:
    return jsonify({'error': 'Not authorised'}), 403
```

Pattern obligatoire sur routes globales destructives :
```python
user, err = _require_admin()
if err: return err
```

---

## DATE FORMATS DB (ne pas uniformiser sans audit)

- listings.first_seen / last_seen / withdrawn_date : ISO YYYY-MM-DDTHH:MM:SS UTC naive
- listings.listing_date : DD/MM/YYYY
- listings.sold_date : ISO YYYY-MM-DD (legacy DD/MM/YYYY sur quelques rows)
- listings.sold_price : TEXT digits only
- pipeline_tracking.sent_date : YYYY-MM-DD
- Frontend : formatDateAU() -> dd/mm/yyyy
  Defini local Pipeline.jsx:43 ET Report.jsx:8 (duplication assumee, ne pas refactorer)

---

## FEATURES LIVE

| Feature | Description |
|---|---|
| Listings | Table scrape REIWA, filtres, edition inline, cache localStorage |
| Pipeline | Targets auto-generes depuis sold recents + OSM neighbours, pipeline_tracking |
| Market Report | Stats per-suburb, snapshots historiques, debounce 500ms |
| Hot Vendors | RP Data CSV -> scoring 0-100 -> Excel export |
| Admin | User CRUD + suburb assignment + agent profile |
| Auth | Magic link + login-by-email + password bcrypt + SetPasswordModal |
| Scraper | Cron 5am Perth + manual refresh + backfill sold_date nuit |
| Email digest | Morning report apres cron, scope par user, HTML + plain text |
| Letters | Word .docx branded, barre verte full-width, logo PNG |
| Back button | URL hash synced, browser back/forward fonctionnels |

---

## REGLES DE TRAVAIL

### Process strict

1. Diff avant push : montrer diff complet, attendre validation (sauf batching autorise)
2. Un fix a la fois sauf instruction explicite de batcher
3. Push sur les 2 branches a chaque commit (voir push pattern)
4. py_compile obligatoire sur tout fichier backend modifie AVANT commit
5. Vite build obligatoire sur tout fichier frontend modifie

Workaround Vite build (xlsx CDN bloque en sandbox) :
```bash
cd frontend && cp package.json package.json.bak
node -e "const p=require('./package.json'); delete p.dependencies?.xlsx; delete p.devDependencies?.xlsx; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2))"
npm install --no-audit --no-fund --silent && npm run build
mv package.json.bak package.json && rm -rf node_modules dist
```

6. Pas de refactor gratuit : zero amelioration non demandee
7. Lire les fichiers en entier avant de proposer un fix complexe
8. Cite file:line pour chaque claim dans les audits
9. No new dependencies sans demande explicite
10. Migrations : idempotentes, dans db_schema.py, wrappees try/except
11. Routes admin/scoped : toujours _require_admin() ou resolve_request_scope()
12. Tout le code et strings UI en anglais (cible AU)

### Format commit

Prefixes : fix: feat: perf: ux: sec: chore:
Body explique le POURQUOI, pas le quoi. Reference files:lines.

---

## BUGS CRITIQUES RESTANTS (HEAD 087f700)

### Backend performance (pas encore touches)

- database.py:182-193 : pas de connection pooling -> cold-connect 200-800ms x2 par request
- database.py:227-255 : get_suburbs 4 subqueries correlees (N+1)
- pipeline_api.py:867-870 : pipeline_tracking_grouped charge tout sans LIMIT
- pipeline_api.py:266-286 : _real_neighbours LIKE sans index -> 6s pour 30 sources
- admin_api.py:106-125 : get_user_allowed_suburb_names non-cached (4x par GET pipeline)
- app.py:73-85 : auth gate UPDATE last_seen a chaque /api/* (write amplification)
- hot_vendors_api.py:240-257 : _fetch_status_map IN-clause uncapped (SQLite limit 999)
- hot_vendors_api.py:456,731 : _hv_jobs ne purge pas les done (40MB RAM)

### Frontend UX (pas encore touches)

- App.jsx:262-279 : scrapeSuburb/Selected sans res.ok check
- App.jsx:107-133 : fetchScrapeStatus via Vercel proxy -> passer BACKEND_DIRECT
- Header.jsx:96 : export via Vercel proxy -> passer BACKEND_DIRECT
- ListingsView.jsx:87-112 : saveNote alert tardif sans contexte
- HotVendorScoring.jsx:15 : redefini BACKEND_DIRECT localement
- HotVendorScoring.jsx:477-491 : setStatus optimiste sans rollback
- Pipeline.jsx:115-147 + App.jsx : double fetch /api/suburbs
- EditableDateCell.jsx:18 : swap MM/DD US sans validation

### Features non commencees

- Stripe checkout (aucun code dans le repo)
- Landing page demo agences (pas de page publique)
- Backend perf (connection pooling, N+1, index manquants)

---

## CONTEXTE BUSINESS PERTH

Western Suburbs prestige : Cottesloe, Claremont, Nedlands, Dalkeith, Mosman Park, Peppermint Grove
Prix median : $2M-5M+. Commission agent : $30-50k par transaction.
1 listing recupere grace a SuburbDesk = 3 ans d'abonnement paye.

Outils concurrents actuels :
- CoreLogic : $5-8k/an. Owner data, AVM, historique. Pas de scoring, pas de workflow.
- PriceFinder : $3-5k/an. Sold data WA. Pas de pipeline prospection.
- REIWA Member tools : inclus adhesion. Pas de owner data.

Differentiation SuburbDesk :
1. Long-hold vendors (10-20 ans) identifies automatiquement -> signal que personne d'autre ne voit
2. Pipeline prospection + lettre Word branded en 1 clic
3. Scrape REIWA daily push (CoreLogic = pull a la demande)
4. 10x moins cher pour le workflow prospection specifiquement

Pitch a retenir : "1 listing recupere grace a SuburbDesk paie 3 ans d'abonnement"

---

## MOAT TECHNIQUE

1. Historique REIWA scrappe depuis debut = avantage cumulatif
2. Boucle complete : scrape -> score -> pipeline -> lettre
3. Long-hold scoring : identifie les owners qui hold depuis 15+ ans avant qu'ils decident de vendre
4. Prix : $99-349/mo vs $3-8k/an CoreLogic

---

Fin du fichier CLAUDE.md. Si tu lis ceci, tu as tout le contexte. Commence a coder.
