# SuburbDesk — Tous les prompts Claude Code
# Généré le 24/06/2026 | 13 prompts | 4 catégories

---

## HEADER STANDARD (inclus dans chaque prompt)
```
Repo : github.com/louiscoplot-ui/MarketScraper
Branche : claude/fix-scraper-missing-listings-PlwVM
Push sur les 2 branches : claude/fix-scraper-missing-listings-PlwVM ET main
BACKEND_DIRECT = https://marketscraper-backend.onrender.com
Auth : X-Access-Key (localStorage key : agentdeck_access_key)
```

---

# ═══════════════════════════════════════════
# CATÉGORIE A — SÉCURITÉ (fixes bloquants)
# ═══════════════════════════════════════════

## PROMPT SEC-1 — Bulk fix cross-tenant leaks (B1 B2 B3 B4 B5)

```
Repo : github.com/louiscoplot-ui/MarketScraper
Branche : claude/fix-scraper-missing-listings-PlwVM
Push sur les 2 branches : claude/fix-scraper-missing-listings-PlwVM ET main

SEC BULK FIX — cross-tenant leaks critiques (5 routes)

Lis ces fichiers EN ENTIER avant de coder :
- scraper_api.py
- hot_vendors_api.py
- listings_api.py

Routes à corriger dans cet ordre exact :

1. GET /api/scrape/audit [scraper_api.py]
   Problème : dump toutes suburbs sans scope check
   Fix : ajouter resolve_request_scope() → filtrer par allowed_suburb_ids si non-admin
   Si non-admin et suburb hors scope : 403 {"error": "forbidden"}

2. GET /api/hot-vendors/lookup [hot_vendors_api.py]
   Problème : leak RP Data cross-tenant sans scope
   Fix : resolve_request_scope() → filtrer hot vendors par suburb_id autorisés

3. PATCH /api/listings/<id> [listings_api.py]
   Problème : write cross-tenant — user peut modifier listing d'une autre agence
   Fix : après resolve_request_scope(), vérifier que listing.suburb_id est dans allowed_suburb_ids
   Si non : 403. Ne pas modifier le reste de la logique PATCH.

4. PATCH /api/listings/note [listings_api.py]
   Même problème, même fix que route 3.

5. PATCH /api/hot-vendors/note et PATCH /api/hot-vendors/status [hot_vendors_api.py]
   Même problème — vérifier ownership avant write.

RÈGLES :
- resolve_request_scope() retourne (user, allowed_ids|None) — None = admin (pas de filtre)
- Pour chaque route : py_compile sur le fichier modifié
- Fixer route 1 en premier. Montre diff complet. Attends ma validation avant de passer à la route 2.
- Zéro modification de logique métier autour des fixes sécurité.
```

---

## PROMPT SEC-2 — Fix routes scraper sans ACL (B7 B8 B15)

```
Repo : github.com/louiscoplot-ui/MarketScraper
Branche : claude/fix-scraper-missing-listings-PlwVM
Push sur les 2 branches : claude/fix-scraper-missing-listings-PlwVM ET main

SEC FIX — routes scraper dangereuses sans ACL (3 routes)

Lis scraper_api.py EN ENTIER.

Routes à sécuriser :

1. POST /api/scrape/all et POST /api/scrape/cancel
   Problème : n'importe quel user authentifié peut lancer ou annuler le scrape global → DoS + sabotage inter-agences
   Fix : ajouter _require_admin() en tête de chaque route
   Si non-admin : 403 {"error": "admin required"}

2. GET /api/scrape/debug/* (toutes les routes debug)
   Problème : spawn Playwright sans ACL → consommation ressources + exposition interne
   Fix : _require_admin() sur toutes les routes /api/scrape/debug/
   Alternative si c'est un blueprint : ajouter before_request _require_admin sur le blueprint debug

3. GET /api/scrape/logs
   Problème : dump activité de TOUTES les agences sans filtre
   Fix : resolve_request_scope() → si non-admin, filtrer logs par suburb_id de l'user

py_compile sur scraper_api.py après chaque groupe.
Montre diff route 1+2. Attends validation. Puis route 3.
```

---

## PROMPT SEC-3 — Fix import RP Data cross-tenant (B11)

```
Repo : github.com/louiscoplot-ui/MarketScraper
Branche : claude/fix-scraper-missing-listings-PlwVM
Push sur les 2 branches : claude/fix-scraper-missing-listings-PlwVM ET main

SEC FIX — import RP Data cross-tenant (B11)

Lis le fichier qui contient POST /api/import/rpdata EN ENTIER.

Problème : un user peut uploader un CSV RP Data et écraser les données d'un suburb
qu'il ne devrait pas avoir accès. L'import ne vérifie pas que les suburb_id du CSV
correspondent aux suburbs autorisés de l'user.

Fix :
1. Ajouter resolve_request_scope() en tête de la route
2. Après parsing du CSV, pour chaque ligne : vérifier que suburb_id (ou suburb_name)
   est dans allowed_suburb_ids de l'user
3. Si une ligne est hors scope : la skipper (ne pas la rejeter entièrement — juste ignorer)
4. Retourner dans la réponse JSON : {imported: N, skipped_out_of_scope: M}
5. Si l'user est admin (allowed_ids=None) : import total comme avant

NE PAS toucher :
- La logique de parsing CSV
- Le format de la réponse de succès (juste ajouter skipped_out_of_scope)

py_compile. Montre diff complet. Attends ma validation.
```

---

# ═══════════════════════════════════════════
# CATÉGORIE B — LOOPS BUSINESS (signaux Fable)
# ═══════════════════════════════════════════

## PROMPT LOOP-1 — Table listing_transitions + Diff Engine (fondation de tous les loops)

```
Repo : github.com/louiscoplot-ui/MarketScraper
Branche : claude/fix-scraper-missing-listings-PlwVM
Push sur les 2 branches : claude/fix-scraper-missing-listings-PlwVM ET main

FEAT BACKEND — listing_transitions table + diff engine (fondation des signal loops)

Lis database.py et scraper.py EN ENTIER avant de coder.

CONTEXTE :
Tous les signal loops (withdrawn orphelin, vente tombée, sold price reveal, contagion strata)
ont besoin de détecter des TRANSITIONS dans les listings d'un run à l'autre.
Actuellement le scraper écrase l'état sans garder d'historique des changements.
Ce sprint crée l'infrastructure commune à tous les loops.

IMPLÉMENTATION :

1. MIGRATION — nouvelle table listing_transitions dans db_schema.py :
   ```sql
   CREATE TABLE IF NOT EXISTS listing_transitions (
     id SERIAL PRIMARY KEY,
     listing_id INTEGER REFERENCES listings(id),
     suburb VARCHAR(100),
     address TEXT,
     transition_type VARCHAR(50),  -- 'withdrawn', 'sale_fallen', 'sold_price_revealed', 'price_drop', 'relisted', 'strata_sale'
     from_status VARCHAR(50),
     to_status VARCHAR(50),
     detected_at TIMESTAMP DEFAULT NOW(),
     metadata JSONB,               -- données context : ancien prix, withdrawn_date, sold_price, etc.
     processed BOOLEAN DEFAULT FALSE,
     processed_at TIMESTAMP
   );
   CREATE INDEX IF NOT EXISTS idx_transitions_suburb ON listing_transitions(suburb);
   CREATE INDEX IF NOT EXISTS idx_transitions_type ON listing_transitions(transition_type);
   CREATE INDEX IF NOT EXISTS idx_transitions_processed ON listing_transitions(processed);
   ```
   Migration idempotente, wrappée try/except.

2. DIFF ENGINE — nouveau fichier signals/diff_engine.py :
   Fonction : run_diff(suburb: str) -> list[dict]
   - Charge l'état actuel de la DB pour ce suburb (tous listings)
   - Compare avec le snapshot de la veille (champ last_seen + status)
   - Détecte et INSERT dans listing_transitions :
     * active → withdrawn : transition_type='withdrawn', metadata={withdrawn_date, days_listed, last_price}
     * under_offer → active : type='sale_fallen', metadata={property_address, original_price}
     * sold_price NULL → valeur : type='sold_price_revealed', metadata={sold_price, sold_date, suburb}
     * price_list réduit >3% : type='price_drop', metadata={old_price, new_price, pct_change}
     * withdrawn → active (même adresse) : type='relisted', metadata={days_withdrawn}
   - Retourne la liste des transitions détectées ce run

3. INTEGRATION dans le flow scraper existant :
   Après chaque scrape suburb réussi → appeler signals/diff_engine.run_diff(suburb)
   Ne pas modifier la logique de scrape elle-même.

4. ENDPOINT admin (lecture seule) : GET /api/admin/transitions
   - _require_admin() obligatoire
   - Params : ?suburb=&type=&processed=false&limit=50
   - Retourne les transitions récentes pour monitoring

py_compile sur tous fichiers backend créés/modifiés.
Montre diff complet (migration + diff_engine + intégration scraper). Attends ma validation.
```

---

## PROMPT LOOP-2 — Withdrawn Orphelin Loop

```
Repo : github.com/louiscoplot-ui/MarketScraper
Branche : claude/fix-scraper-missing-listings-PlwVM
Push sur les 2 branches : claude/fix-scraper-missing-listings-PlwVM ET main

FEAT — Withdrawn Orphelin Loop (Signal #1)

Prérequis : listing_transitions table existe (sprint LOOP-1 complété).
Lis database.py, scraper.py, et le fichier qui génère les letters .docx EN ENTIER.

CONTEXTE BUSINESS :
En WA, l'exclusive agency agreement standard expire à ~90 jours.
Un bien withdrawn il y a 60–120j sans relist = vendeur motivé + mandat expiré + agent en disgrâce.
C'est la fenêtre exacte où l'approche cold est acceptée. Aucun outil concurrent ne détecte ça.

IMPLÉMENTATION :

1. CRON TASK — signals/withdrawn_orphan.py :
   Fonction : process_withdrawn_orphans()
   - Query : SELECT * FROM listings WHERE status='withdrawn'
     AND withdrawn_date BETWEEN NOW()-INTERVAL '120 days' AND NOW()-INTERVAL '60 days'
     AND id NOT IN (SELECT listing_id FROM listing_transitions WHERE transition_type='relisted'
                    AND detected_at > withdrawn_date)
   - Pour chaque résultat : vérifier qu'une transition 'withdrawn' existe dans listing_transitions
     (sinon créer l'entrée rétroactivement)
   - Vérifier qu'on n'a pas déjà traité ce withdrawn orphelin (processed=True dans transitions)
   - Si nouveau : générer une entrée Pipeline + marquer processed=True

2. GÉNÉRATION LETTRE — réutiliser python-docx existant :
   Générer un .docx par withdrawn orphelin avec :
   - Adresse du bien
   - Date de retrait (withdrawn_date formatée en DD/MM/YYYY)
   - Jours depuis retrait (calculé)
   - Template message : "Nous avons remarqué que votre propriété au [adresse] a été
     retirée du marché il y a [X] jours. Le marché des western suburbs a évolué depuis —
     [suburb] affiche actuellement [N] ventes actives et une médiane de $[mediane].
     Nous aimerions vous partager une analyse confidentielle."
   - Signer au nom de l'agent connecté (depuis user profile)

3. DIGEST ENRICHI — ajouter section "Withdrawn orphelins" dans le morning email digest :
   Format : liste des nouvelles opportunités withdrawn avec adresse + jours + last_price
   Seulement les nouvelles (processed passé à True ce run)
   Scopé par suburb de l'user (resolve_request_scope)

4. ENDPOINT : POST /api/signals/withdrawn-orphans/run
   - _require_admin() pour trigger manuel
   - Retourne {detected: N, letters_generated: N, suburbs_covered: [...]}

5. CRON GITHUB ACTIONS — ajouter job dans scrape.yml :
   Schedule : `10 21 * * *` UTC (5h10 Perth — 10 min après le scrape principal)
   Lance process_withdrawn_orphans()

py_compile sur tous fichiers modifiés. Migration si nouvelle colonne nécessaire.
Montre diff complet. Attends ma validation.
```

---

## PROMPT LOOP-3 — Vente Tombée Loop (alerte 15 min)

```
Repo : github.com/louiscoplot-ui/MarketScraper
Branche : claude/fix-scraper-missing-listings-PlwVM
Push sur les 2 branches : claude/fix-scraper-missing-listings-PlwVM ET main

FEAT — Vente Tombée Loop (Signal #3)

Prérequis : listing_transitions table + diff_engine (sprint LOOP-1 complété).
Lis database.py et le fichier email digest EN ENTIER.

CONTEXTE BUSINESS :
Under offer → retour active = finance refusée ou building inspection ratée.
Vendeur émotionnellement engagé à vendre, confiance dans l'agent ébranlée.
Fenêtre d'action : 2 semaines MAX. L'automatisation est le moat ici — l'agent concurrent ne le voit que le lendemain.

IMPLÉMENTATION :

1. DETECTION — déjà dans diff_engine (transition_type='sale_fallen').
   Ce sprint traite les transitions non-processed de type 'sale_fallen'.

2. ALERTE IMMÉDIATE — signals/sale_fallen.py :
   Fonction : process_sale_fallen_alerts()
   - Query listing_transitions WHERE type='sale_fallen' AND processed=FALSE
   - Pour chaque résultat :
     a. Récupérer les détails du listing (adresse, suburb, last_price, agent suburb)
     b. Envoyer email alerte immédiate via Resend à l'agent du suburb concerné
     c. Marquer processed=TRUE + processed_at=NOW()

3. FORMAT EMAIL ALERTE :
   Sujet : "🔔 Vente tombée — [adresse] est revenu active"
   Body HTML :
   - En-tête : "Opportunité détectée ce matin"
   - Détails : adresse, prix affiché ($X), suburb, date du retour active
   - Script d'appel suggéré (généré par Claude API) :
     "Bonjour [nom si dispo], je suis [agent] de Belle Property.
      J'ai vu que votre propriété au [adresse] est revenue available — je comprends
      que ça peut être décevant. Nous avons actuellement [N] acheteurs qualifiés
      sur [suburb] — est-ce que vous seriez disponible pour une conversation rapide ?"
   - Footer : "Cette alerte expire dans 14 jours"

4. EXPIRATION — cron quotidien qui marque les sale_fallen >14j comme expirés
   dans une colonne metadata.expired=true (pas de suppression, juste flag)

5. INTÉGRATION CRON :
   Ajouter dans scrape.yml job post-scrape :
   Schedule : `15 21 * * *` UTC (5h15 Perth)
   Lance process_sale_fallen_alerts()

6. FRONTEND — badge "Ventes tombées" dans le dashboard principal :
   Compteur des sale_fallen actifs (<14j, non-expirés) pour le suburb de l'user
   Click → filtre listings sur ces propriétés

py_compile tous fichiers backend. Vite build si frontend modifié.
Montre diff complet. Attends ma validation.
```

---

## PROMPT LOOP-4 — Sold Price Reveal Loop

```
Repo : github.com/louiscoplot-ui/MarketScraper
Branche : claude/fix-scraper-missing-listings-PlwVM
Push sur les 2 branches : claude/fix-scraper-missing-listings-PlwVM ET main

FEAT — Sold Price Reveal Loop (Signal #13)

Prérequis : listing_transitions table (sprint LOOP-1).
Le backfill sold_price tourne déjà la nuit. Ce sprint branche dessus.
Lis database.py, le fichier backfill_sold, et le fichier letters .docx EN ENTIER.

CONTEXTE BUSINESS :
Quand un sold_price devient public, les voisins qui ont vu le bien "Under Offer"
sont psychologiquement prêts à entendre parler de LEUR bien. C'est le timing parfait.
Le backfill tourne déjà — il suffit de détecter le passage NULL → valeur.

IMPLÉMENTATION :

1. DETECTION — améliorer le backfill sold_price existant :
   Après chaque mise à jour sold_price : si la valeur précédente était NULL
   → INSERT dans listing_transitions (type='sold_price_revealed',
     metadata={sold_price, sold_date, address, suburb})
   Ne pas modifier le reste de la logique backfill.

2. GÉNÉRATION LETTRES VOISINS — signals/sold_reveal.py :
   Fonction : process_sold_reveals()
   - Query listing_transitions WHERE type='sold_price_revealed' AND processed=FALSE
   - Pour chaque vente révélée :
     a. Récupérer les voisins OSM dans un rayon de 150m (réutiliser la logique Pipeline existante)
     b. Pour chaque voisin : générer une lettre .docx avec python-docx :
        Template : "Votre voisin au [adresse vendue] vient de se vendre $[sold_price].
                   C'est [+X% / -X%] par rapport à la médiane actuelle de [suburb].
                   Souhaitez-vous savoir ce que vaut votre propriété aujourd'hui ?"
     c. Bundler les lettres dans un ZIP par suburb
     d. Marquer processed=TRUE

3. DIGEST MATINAL :
   Ajouter section "Sold price révélés hier" dans le morning digest de l'agent :
   - Liste : adresse vendue + prix + nombre de lettres générées
   - Lien vers download ZIP des lettres (.docx) via fetch+blob (PAS window.open)

4. ENDPOINT : GET /api/signals/sold-reveals/letters?transition_id=X
   - resolve_request_scope() — scoper par suburb
   - Retourne le ZIP des lettres voisins via fetch+blob
   - Utiliser BACKEND_DIRECT côté frontend (potentiellement >25s si many neighbours)

5. CRON : `20 21 * * *` UTC dans scrape.yml (5h20 Perth, après backfill)

py_compile tous fichiers backend. Vite build si frontend.
Montre diff complet. Attends ma validation.
```

---

## PROMPT LOOP-5 — Appraisal Follow-up Loop (J+30/60/90)

```
Repo : github.com/louiscoplot-ui/MarketScraper
Branche : claude/fix-scraper-missing-listings-PlwVM
Push sur les 2 branches : claude/fix-scraper-missing-listings-PlwVM ET main

FEAT — Appraisal Follow-up Loop

Lis database.py et app.py EN ENTIER avant de coder.

CONTEXTE BUSINESS :
90% des agents ne font pas de suivi après une appraisal. Le mandat se gagne
dans le suivi, pas dans la présentation initiale. Ce loop automatise 3 relances
avec un NOUVEAU data point à chaque fois — pas un email générique.

MIGRATION — nouvelle table appraisals dans db_schema.py :
```sql
CREATE TABLE IF NOT EXISTS appraisals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  address TEXT NOT NULL,
  suburb VARCHAR(100),
  vendor_name VARCHAR(200),
  vendor_email VARCHAR(200),
  vendor_phone VARCHAR(50),
  appraisal_date DATE NOT NULL,
  estimated_price INTEGER,
  notes TEXT,
  status VARCHAR(50) DEFAULT 'active',  -- active, won, lost
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS appraisal_followups (
  id SERIAL PRIMARY KEY,
  appraisal_id INTEGER REFERENCES appraisals(id),
  scheduled_for DATE NOT NULL,
  followup_day INTEGER NOT NULL,  -- 30, 60, ou 90
  sent_at TIMESTAMP,
  email_subject TEXT,
  data_point_used TEXT,  -- description du data point injecté
  status VARCHAR(50) DEFAULT 'pending'  -- pending, sent, skipped
);
```
Migrations idempotentes, wrappées try/except.

BACKEND :

1. POST /api/appraisals — créer une appraisal + programmer 3 followups auto :
   - resolve_request_scope() — scoper à l'user
   - Input : {address, suburb, vendor_name, vendor_email, appraisal_date, estimated_price, notes}
   - INSERT appraisal + INSERT 3 lignes appraisal_followups (J+30, J+60, J+90)
   - Retourne {appraisal_id, followup_dates: [date30, date60, date90]}

2. GET /api/appraisals — liste appraisals de l'user avec statut followups
   resolve_request_scope()

3. PATCH /api/appraisals/<id>/status — l'agent tague won/lost
   resolve_request_scope() + vérif ownership

4. CRON FOLLOWUP — signals/appraisal_followup.py :
   Fonction : send_due_followups()
   - Query appraisal_followups WHERE scheduled_for <= TODAY AND status='pending'
   - Pour chaque followup dû :
     a. Récupérer les données fraîches du suburb (depuis Market Report stats)
     b. Construire le data point selon le jour :
        J+30 : "Depuis notre rencontre, [N] propriétés ont été vendues à [suburb] (médiane $X)"
        J+60 : "Le stock disponible à [suburb] a [baissé/augmenté] de X% ce mois"
        J+90 : "La médiane à [suburb] a évolué de $X depuis notre évaluation"
     c. Envoyer email à vendor_email via Resend
     d. Marquer status='sent' + sent_at + data_point_used
   Schedule : `30 21 * * *` UTC dans scrape.yml

FRONTEND — onglet "Appraisals" dans le dashboard :
- Form : Nouvelle appraisal (adresse, suburb, nom vendeur, email, date, prix estimé)
- Liste appraisals avec statut (active/won/lost) + prochaine relance dans X jours
- Bouton "Marquer gagné/perdu" → PATCH status
- Badge ROI : si won, affiche commission estimée (prix × 2.5%)
- Pattern UI : copier le style de la vue Pipeline existante

py_compile tous fichiers backend. Vite build frontend.
Commencer par backend (migration + routes). Montre diff. Attends validation. Puis frontend.
```

---

## PROMPT LOOP-6 — Contagion Complexe Loop (strata)

```
Repo : github.com/louiscoplot-ui/MarketScraper
Branche : claude/fix-scraper-missing-listings-PlwVM
Push sur les 2 branches : claude/fix-scraper-missing-listings-PlwVM ET main

FEAT — Contagion Complexe Loop (Signal #8)

Prérequis : listing_transitions (LOOP-1), sold_price_revealed détection (LOOP-4).
Lis database.py et le fichier letters .docx EN ENTIER.

CONTEXTE BUSINESS :
Quand 1 unit vend bien dans un strata 1960s–70s de Claremont/Mosman Park,
2–3 voisins listent dans les 6 mois (effet d'ancrage + peur des special levies).
Dès une vente dans un complexe → lettres à tout le building = volume × avec effort minimal.

IMPLÉMENTATION :

1. DETECTION STRATA — dans diff_engine, améliorer la classification :
   Quand transition_type='sold_price_revealed' :
   - Vérifier si l'adresse contient un numéro d'unit (pattern : "X/[N] [Rue]" ou "Unit X")
   - Si oui : marquer metadata.is_strata=True + metadata.strata_number=N
     (extraire le numéro de strata du listing si disponible dans les données REIWA)

2. TABLE strata_complexes — dans db_schema.py :
   ```sql
   CREATE TABLE IF NOT EXISTS strata_complexes (
     id SERIAL PRIMARY KEY,
     street_address TEXT NOT NULL,  -- "18 Goldsworthy Rd, Claremont"
     suburb VARCHAR(100),
     total_units INTEGER,
     unit_addresses TEXT[],  -- array d'adresses connues dans ce complexe
     last_sale_date DATE,
     last_sale_price INTEGER,
     created_at TIMESTAMP DEFAULT NOW(),
     UNIQUE(street_address)
   );
   ```
   Idempotent, try/except.

3. ENRICHISSEMENT STRATA — signals/strata_contagion.py :
   Fonction : process_strata_sales()
   - Pour chaque sold_price_revealed avec is_strata=True (non-processed) :
     a. Extraire l'adresse du complexe (sans numéro d'unit)
     b. Upsert dans strata_complexes avec la dernière vente
     c. Identifier les autres units du même complexe dans les listings DB
        (query : listings WHERE address LIKE '%[adresse complexe]%' AND id != listing_id)
     d. Générer une lettre .docx pour chaque unit identifié :
        "L'unit [N] au [adresse complexe] vient de se vendre $[sold_price].
         Votre bien dans le même complexe bénéficie de cet ancrage de prix.
         C'est souvent le signal qui pousse les propriétaires voisins à agir —
         contactez-nous avant que le marché ne le fasse pour vous."
     e. Marquer transition processed=TRUE

4. DIGEST :
   Section "Contagion strata" dans le morning digest :
   "[Complexe] — 1 vente à $X → [N] lettres générées pour les units du complexe"

py_compile tous fichiers. Montre diff complet. Attends ma validation.
```

---

# ═══════════════════════════════════════════
# CATÉGORIE C — PERFORMANCE & ROBUSTESSE
# ═══════════════════════════════════════════

## PROMPT PERF-1 — Fix timeouts UX dégradée (D7 D8 D10 D17)

```
Repo : github.com/louiscoplot-ui/MarketScraper
Branche : claude/fix-scraper-missing-listings-PlwVM
Push sur les 2 branches : claude/fix-scraper-missing-listings-PlwVM ET main

FIX UX BULK — 4 problèmes UX dégradée

Lis ces fichiers EN ENTIER : frontend/src/lib/api.js et tous les composants mentionnés.

Fixe dans cet ordre — 1 par 1, validation avant de passer au suivant :

--- FIX D7 : fetchScrapeStatus via Vercel proxy ---
Localise fetchScrapeStatus dans le frontend.
Problème : appelle /api/scrape/status via Vercel proxy → timeout 25s possible.
Fix : remplacer l'URL par ${BACKEND_DIRECT}/api/scrape/status
BACKEND_DIRECT est dans lib/api.js:15.
Vite build. Montre diff. Attends validation.

--- FIX D8 : downloadLetter via window.open ou Vercel proxy ---
Localise downloadLetter dans le frontend.
Problème : window.open() bypass l'interceptor X-Access-Key → 401.
         OU appel via Vercel proxy → timeout sur gros docx.
Fix :
- Remplacer par fetch() avec header X-Access-Key
- URL : ${BACKEND_DIRECT}/api/letters/download (ou chemin existant)
- response.blob() → URL.createObjectURL() → clic programmatique → revokeObjectURL()
- Copier le pattern d'un autre bouton de téléchargement qui marche déjà dans le projet
Vite build. Montre diff. Attends validation.

--- FIX D10 : saveAssignments ne refresh pas la liste users ---
Localise saveAssignments dans le composant Admin.
Problème : après save, la liste users n'est pas rechargée → l'admin doit refresh manuellement.
Fix minimal : après le fetch saveAssignments réussi, appeler fetchUsers() (ou équivalent)
Ne pas changer le reste de la logique.
Vite build. Montre diff. Attends validation.

--- FIX D17 : saveNote alerte tardive sans contexte ---
Localise saveNote dans les listings.
Problème : l'alerte de succès/erreur apparaît sans indiquer QUELLE note a été sauvée.
Fix : remplacer alert() générique par un feedback inline sous le champ note
Format : "✓ Note sauvegardée" en vert pendant 2s, puis disparaît (setTimeout)
Copier le pattern de feedback inline s'il existe déjà ailleurs dans le projet.
Vite build. Montre diff. Attends validation.
```

---

## PROMPT PERF-2 — ROI Tracker (anti-churn + pitch Hanscomb)

```
Repo : github.com/louiscoplot-ui/MarketScraper
Branche : claude/fix-scraper-missing-listings-PlwVM
Push sur les 2 branches : claude/fix-scraper-missing-listings-PlwVM ET main

FEAT — ROI Tracker (anti-churn + metric pitch)

Prérequis : appraisals table (sprint LOOP-5).
Lis database.py et le composant Admin EN ENTIER.

CONTEXTE BUSINESS :
C'est la feature qui tue le churn ET écrit les case studies pour Peter Hanscomb.
Quand un agent peut voir "$140k de commissions générées via SuburbDesk ce trimestre",
il ne peut plus partir. Et c'est le seul chiffre qui compte pour un investisseur.

MIGRATION — ajout colonne commission_value dans appraisals :
```sql
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS commission_value INTEGER;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS mandate_source VARCHAR(100);
-- mandate_source : 'withdrawn_orphan' | 'sale_fallen' | 'sold_reveal' | 'pipeline' | 'manual'
```

BACKEND :

1. PATCH /api/appraisals/<id>/won — marquer mandat gagné avec commission :
   Input : {commission_value: INTEGER, mandate_source: VARCHAR}
   resolve_request_scope() + vérif ownership
   Met à jour status='won' + commission_value + mandate_source

2. GET /api/roi/summary — dashboard ROI pour l'user :
   resolve_request_scope()
   Retourne :
   {
     total_mandates_won: N,
     total_commission_aud: X,
     this_quarter: {mandates: N, commission: X},
     by_source: [{source: 'withdrawn_orphan', count: N, commission: X}, ...],
     signals_detected_30d: N,  -- depuis listing_transitions
     letters_generated_30d: N
   }

3. GET /api/admin/pitch-snapshot — métriques pour pitch Hanscomb :
   _require_admin()
   Combine roi/summary de TOUS les users + métriques globales
   Appelle Claude API pour générer 3 bullets pitch percutants :
   System : "3 bullet points max 20 mots chacun pour pitcher une PropTech B2B.
   Format JSON : [{bullet: '...'}]"
   Retourne métriques + bullets

FRONTEND :

1. Widget ROI dans le dashboard principal (en-dessous des stats suburb) :
   - Carte "Mandats gagnés" : N total + $X commissions
   - Détail par source (barre horizontale simple)
   - Bouton "Marquer comme gagné" sur chaque appraisal active

2. Page Admin → onglet "Pitch Snapshot" :
   - Bouton "Générer snapshot"
   - Affiche métriques globales + 3 bullets Claude
   - Bouton "Copier pour PowerPoint" → navigator.clipboard.writeText()

py_compile backend. Vite build frontend.
Commencer par migration + routes backend. Montre diff. Attends validation. Puis frontend.
```

---

# ═══════════════════════════════════════════
# CATÉGORIE D — INFRA MICROSITES
# ═══════════════════════════════════════════

## PROMPT MICRO-1 — QR Streets (upgrade lettres Pipeline)

```
Repo : github.com/louiscoplot-ui/MarketScraper
Branche : claude/fix-scraper-missing-listings-PlwVM
Push sur les 2 branches : claude/fix-scraper-missing-listings-PlwVM ET main

FEAT — QR Streets : lettres Pipeline trackables

Lis le fichier qui génère les lettres .docx ET database.py EN ENTIER.

CONTEXTE BUSINESS :
Chaque lettre Word envoyée est actuellement un canal mort — on ne sait pas
qui l'a reçue, qui l'a lue. En ajoutant un QR code unique par lettre,
on transforme le print en canal digital trackable. Un scan = lead chaud nominal.

MIGRATION :
```sql
CREATE TABLE IF NOT EXISTS letter_qr_codes (
  id SERIAL PRIMARY KEY,
  token VARCHAR(64) UNIQUE NOT NULL,  -- UUID court
  listing_id INTEGER REFERENCES listings(id),
  recipient_address TEXT,
  suburb VARCHAR(100),
  user_id INTEGER REFERENCES users(id),
  letter_type VARCHAR(50),  -- 'pipeline', 'withdrawn', 'sold_reveal', 'strata'
  generated_at TIMESTAMP DEFAULT NOW(),
  scanned_at TIMESTAMP,
  scan_count INTEGER DEFAULT 0
);
```

BACKEND :

1. Modifier la génération .docx pour inclure un QR :
   - À chaque génération de lettre : créer un token UUID court (8 chars)
   - Insérer dans letter_qr_codes
   - Générer un QR code (library qrcode, déjà installée ou pip install qrcode[pil])
   - URL encodée : https://suburbdesk.com/r/{token}
   - Insérer le QR en bas de chaque lettre .docx (image 2cm × 2cm)
   - Texte sous le QR : "Voir les ventes récentes de votre rue →"

2. GET /api/qr/{token} — endpoint public (exempt auth) :
   - Lookup token dans letter_qr_codes
   - UPDATE scan_count + scanned_at (premier scan seulement)
   - Envoyer notification email à user_id via Resend :
     Sujet : "🔔 QR scanné — [recipient_address]"
     Body : "Un propriétaire au [recipient_address] vient de scanner votre lettre [letter_type].
             Il y a [X] jours depuis l'envoi. C'est le moment d'appeler."
   - Redirect vers une landing page (pour l'instant : vers suburbdesk.com ou page statique)

3. GET /api/qr/stats — stats QR pour l'user :
   resolve_request_scope()
   Retourne : {total_letters: N, total_scanned: M, scan_rate_pct: X, recent_scans: [...]}

FRONTEND — widget "QR Scans" dans le dashboard :
- Compteur lettres envoyées vs scannées
- Liste des 5 derniers scans (adresse + date + type lettre)
- Taux de scan global

Vérifier que qrcode[pil] est installable sans casser l'env (pip install qrcode[pil]).
py_compile tous fichiers backend. Vite build frontend.
Montre diff complet. Attends ma validation.
```

---

## ORDRE D'EXECUTION RECOMMANDÉ

1. SEC-1 + SEC-2 + SEC-3  →  Sécuriser avant tout
2. PERF-1                  →  UX fixes rapides (1 jour)
3. LOOP-1                  →  Fondation listing_transitions (tout dépend de ça)
4. LOOP-2                  →  Withdrawn orphelin (données déjà en DB)
5. LOOP-3                  →  Vente tombée (même infra)
6. LOOP-4                  →  Sold price reveal (backfill existant)
7. LOOP-5                  →  Appraisal follow-up (nouveau modèle)
8. PERF-2                  →  ROI Tracker (prérequis : LOOP-5)
9. LOOP-6                  →  Contagion strata
10. MICRO-1                →  QR Streets (upgrade lettres)
