# SENTINEL — Handoff & Plan d'exécution
**Projet : MarketScraper / SuburbDesk — Louis Coplot**
**Date : 03/07/2026 — Ce document est la source de vérité de la séquence en cours.**

> **Instruction pour Claude Code :** lis ce document EN ENTIER, puis le CLAUDE.md du repo (qui prime sur ce doc pour les règles techniques). Ensuite, identifie dans la section "SÉQUENCE" ci-dessous la première étape non cochée et reprends exactement là. Ne refais pas ce qui est marqué ✅. Respecte toutes les règles de travail du CLAUDE.md (diff avant push, py_compile, Vite build, scope sur toute route, push PlwVM uniquement, jamais main).

---

## 1. ÉTAT DES LIEUX (vérifié le 03/07/2026)

### Infra & prod
- **Branche prod = branche par défaut = `claude/fix-scraper-missing-listings-PlwVM`** (déploiement continu Render/Vercel). `main` = orpheline archivée, push interdit (exception unique déjà faite : 67289ee, sans effet, inoffensif).
- **Le workflow nightly réel est `scrape_sales.yml` sur PlwVM** (~16:00-18:00 UTC). `daily-scrape.yml` sur main n'a JAMAIS tourné (jamais enregistré côté Actions). L'entrée SC2 du bug tracker était une hypothèse fausse — non-problème.
- S0 sécurité : **clos** (B1-B15, S-1/S-2/S-3, UX-1, D-3, B-8, D7/D8 — vérifiés ligne par ligne, mergés en prod).
- Table `schema_migrations(key, applied_at)` en place : toute migration one-shot destructive DOIT être gatée par `_migration_done`/`_mark_migration`.
- Auth : magic link obligatoire pour comptes sans mot de passe (S-1) ; parcours onboarding = magic link → set password (AccountModal/PasswordCard).
- Backup `sold_dates` fait (CSV local chez Louis, hors repo). Mot de passe Neon roté, secrets Render + GitHub mis à jour.

### Le scraper — timeline des incidents (root cause établie par investigation Fable, run par run)
| Période | Événement | Statut |
|---|---|---|
| ≤ 16/06 | Scraping DIRECT sans proxy depuis GitHub Actions, fonctionnel | historique |
| 17/06 19:01 UTC (run 35) | **Rupture 1** : Cloudflare/REIWA bloque les IP datacenter GHA (timeouts, cascade de faux withdrawn) | résolu |
| 18/06 | Guards anti-mass-withdraw + recovery posés (d910d98, 89ee4b1…) — **ils ont protégé la base lors de tous les incidents suivants : 0 faux withdrawn** | ✅ en place |
| 19/06 05:48 (2e8be15) | **Proxy résidentiel IPRoyal ajouté** (`geo.iproyal.com:12321`, user:pass dans secret `SCRAPE_PROXY`, code : `scraper_utils.py:128-157`, consommé par `scraper.py:68`). Blocage hosts tiers a60b9db | ✅ en place |
| 19-23/06 (runs 40-44) | Proxy fonctionnel, scrapes complets 2-3h | données VALIDES |
| 24-30/06 (runs 45-51) | **Trou Neon** : quota compute épuisé, crash à init_db AVANT tout scrape. Aucune donnée. Reset auto le 01/07 | TROU DE DONNÉES |
| 01/07 jusqu'à 18:49 UTC (run 52) | Scrape sain 45 min (tous suburbs pleins). Premiers `listing_snapshots` posés à ce run | données VALIDES |
| 01/07 18:49 UTC | **Rupture 2 : solde IPRoyal épuisé** en plein run → ERR_TUNNEL_CONNECTION_FAILED | cause confirmée (solde=0) |
| 02/07 (run 53) | Échec total 18/18 suburbs (1168+ erreurs tunnel), "success" workflow trompeur (healing_loop avale les échecs). 0 dégât données grâce aux guards | TROU DE DONNÉES |
| 03/07 | **Louis recharge IPRoyal** → le run de cette nuit doit confirmer la reprise | ⏳ EN COURS |

### Décisions prises (ne pas rediscuter, exécuter)
1. **Court terme : on garde IPRoyal rechargé.** Sentinel se calibre sur les fenêtres de scrape valides (19-23/06 + 01/07 partiel + tout ce qui suit la reprise).
2. **Le coût proxy est un problème économique reconnu** (0 client payant, coût variable qui grimpe avec les suburbs). La migration vers un scrape local sur IP résidentielle (modèle du rental scraper de Louis, jamais bloqué) est **envisagée mais PAS décidée** — "on avisera" après la reprise. Ne pas l'implémenter sans instruction explicite de Louis.
3. **Go-to-market : mono-agence Acton | Belle Property.** Patron (Grant) = design partner n°1, collègues ensuite. Pas de démarchage d'agences concurrentes.
4. Après S4 : **STOP code, pilote Grant 2 semaines.** C'est l'usage qui décide de la suite (S5 calibration vs Listing Autopsy), pas l'enthousiasme.

---

## 2. SÉQUENCE — reprendre à la première étape non cochée

### ✅ Étape 0 — Sécurité + synchro (FAIT)
S0 clos, PlwVM synchronisée, backup fait, credentials rotés.

### ⏳ Étape 1 — Reprise du scrape (EN COURS, côté Louis)
- [x] Recharger le solde IPRoyal (+ activer auto-top-up si dispo)
- [ ] **Vérifier le run de cette nuit** : Actions → scrape_sales.yml → le run doit montrer les 18 suburbs avec des counts normaux, ZÉRO ERR_TUNNEL_CONNECTION_FAILED
- [ ] Vérifier le digest email du matin (arrive, scopé, données fraîches)
- [ ] Parcours auth complet sur la prod : magic link → set password → re-login email+mot de passe
- ⚠️ Si le run échoue encore malgré la recharge : STOP, diagnostic avant tout — ne pas lancer Sentinel sur un scrape cassé.

### ☐ Étape 2 — Clarification pré-S1 (OBLIGATOIRE avant S1, investigation lecture seule)
L'investigation du 03/07 a révélé l'existence de tables **`listing_snapshots`** (premières lignes posées au run 52 du 01/07) et **`listing_transitions`** (vide avant). Chevauchement potentiel avec la table `listing_events` que S1 prévoit de créer.
À faire, AVANT de coder S1 :
1. D'où viennent ces tables ? Commit créateur, module qui les écrit (file:line), schéma exact.
2. Utilisées par une feature live, ou orphelines ?
3. `listing_transitions` fait-elle DÉJÀ ce que S1 doit faire ? Si oui → S1 ÉTEND l'existant au lieu de créer une table parallèle.
4. Conclusion claire : réutiliser / étendre / créer en parallèle sans conflit. Adapter le sprint S1 en conséquence et documenter la décision.

### ☐ Étape 3 — Sprints Sentinel S1→S4 (branche isolée, autonomie, validation finale unique)

**Règles d'autonomie pour toute la chaîne :**
- Branche `claude/sentinel-s1-s4` depuis PlwVM. AUCUN push sur PlwVM ni main sans validation du diff global par Louis à la fin.
- Un commit par sprint. Auto-vérification après chaque sprint (py_compile, Vite build si frontend, toute route scopée via `resolve_request_scope()` ou `_require_admin()`, migrations destructives gatées schema_migrations).
- "Backfill terminé" / "migration appliquée" = RÉELLEMENT exécuté et vérifié en base, pas relu statiquement. Permission bloquée = stop et rapport, pas de contournement.
- Interdits absolus : modifier les délais de politesse du scraper (5-15s), ajouter une requête REIWA à un flux existant, nouvelle dépendance non signalée, toucher aux formats de dates (mixed par design), refactor hors périmètre.
- `normalize_address()` écrite UNE fois en S1, importée partout ensuite.
- Ambiguïté bloquante → option la plus conservatrice, décision documentée, on continue.

**⚠️ RÈGLE TROUS DE DONNÉES (s'applique à S1 backfill ET S3 backtest) :**
Les fenêtres suivantes sont des TROUS (absence de scrape, PAS absence de listings) :
- 17/06 fin de run 35 → 19/06 mise en prod proxy (période dégradée/tests)
- 24/06 → 30/06 inclus (crash Neon, runs 45-51)
- 01/07 après 18:49 UTC → reprise confirmée du proxy (run 53 inclus)
Pour ces fenêtres : AUCUN event généré (surtout pas de withdrawn). La règle "withdrawn confirmé après 3 scrapes consécutifs d'absence" compte uniquement les scrapes RÉELLEMENT réussis, jamais les jours calendaires. Si le code raisonne en jours → signaler comme risque et corriger. Idéalement : détecter les scrapes valides depuis les données elles-mêmes (un run où un suburb a 0 listings alors qu'il en avait ~200 la veille = scrape raté, pas retrait massif — les guards du 18/06 contiennent déjà cette logique, s'en inspirer/réutiliser).

---

#### SPRINT S1 — Market Memory
Transformer le scraper d'un système d'états en système d'événements + backfiller l'historique valide.
*(Adapter selon la conclusion de l'Étape 2 : si listing_transitions couvre déjà ce besoin, étendre au lieu de créer.)*

1. Migration gatée schema_migrations : table `listing_events`
   `(id, listing_id, suburb_id, address, event_type TEXT CHECK (event_type IN ('price_drop','price_rise','withdrawn','relisted','agency_change','sold','back_on_market')), old_value TEXT, new_value TEXT, detected_at TEXT ISO, source TEXT DEFAULT 'daily_diff')`
2. `event_detector.py` :
   - `normalize_address(addr) -> str` : minuscules, abréviations (st/street, ave/avenue, formats unit), trim. Fonction pure, testable.
   - `detect_events(previous_state, current_state) -> list[dict]`. Règles : prix modifié → price_drop/price_rise ; présent hier absent aujourd'hui sans sold_date → withdrawn SEULEMENT après 3 scrapes RÉUSSIS consécutifs d'absence ; adresse normalisée vue en withdrawn qui réapparaît → relisted (+ agency_change si l'agence diffère).
   - Branchement APRÈS l'écriture des listings dans le flux existant, données déjà en mémoire, aucune requête REIWA supplémentaire.
3. `backfill_events.py` one-shot : rejoue l'historique chronologiquement (fenêtres valides uniquement, cf. règle trous). Idempotent (clé listing_id + event_type + detected_at). Résumé loggé par suburb. EXÉCUTER réellement et vérifier les counts.
4. `GET /api/events?suburb=&type=&days=30` — scopé, pagination 100 max.

Commit : `feat(events): market memory — event detection + backfill`

#### SPRINT S2 — Signal Engine (prérequis : S1)
1. Migration gatée : `vendor_signals(id, address, suburb_id, score REAL, reason_codes TEXT JSON, source_event_ids TEXT JSON, created_at, status TEXT DEFAULT 'new' CHECK (status IN ('new','actioned','dismissed')))` et `signal_weights(id, feature_name TEXT UNIQUE, weight REAL, updated_at)`.
2. `signal_engine.py` : poids v1 seedés par la migration — withdrawn <18 mois : 0.35 | relisted autre agence : 0.30 | détention >10 ans + gain latent (données Hot Vendors RP Data existantes) : 0.20 | 2+ ventes record dans la rue <6 mois : 0.15 | price_drops répétés chez un concurrent : 0.25. Score = somme plafonnée à 1.0. **CHAQUE signal porte ses reason_codes en clair** (ex : "Withdrawn Nov 2025 after 94 days") — exigence d'explicabilité NON NÉGOCIABLE (conformité transparence des décisions automatisées, déc. 2026). Jamais de score sans raisons.
3. Run à la fin du cron quotidien + `POST /api/signals/rebuild` (admin) + `GET /api/signals?suburb=` (scopé, tri score desc).
4. Vue UI "Signals" : nouvelle view dans App.jsx (pattern view-state existant, PAS de router), tableau score + raisons + boutons Dismiss / Mark actioned.

Commit : `feat(signals): explainable vendor signal engine v1`

#### SPRINT S3 — Prediction Ledger, LE MOAT (prérequis : S2)
1. Migration gatée : `predictions(id, address, suburb_id, score_at_prediction REAL, reason_codes TEXT JSON, predicted_at, horizon_days INTEGER DEFAULT 180, outcome TEXT DEFAULT 'pending' CHECK (outcome IN ('pending','listed','not_listed')), outcome_verified_at, listed_listing_id)`.
2. À chaque `vendor_signal` créé avec score ≥ 0.5 : écrire une prediction (UNE seule active par adresse normalisée).
3. `prediction_ledger.py`, exécuté à chaque scrape : matcher les nouvelles annonces contre les predictions pending via `normalize_address` (importée de S1, pas dupliquée). Match → outcome='listed'. Horizon dépassé → 'not_listed'. **C'est l'auto-étiquetage : le scraper vérifie lui-même les prédictions — c'est le moat produit, la qualité de ce matching est critique.**
4. `backtest_signals.py` one-shot : rejouer les `listing_events` historiques (fenêtres valides uniquement) → quels signaux auraient précédé de vrais listings ? Sortie : précision par feature + baseline aléatoire du suburb, loggée + CSV. **EXÉCUTER réellement — les chiffres du rapport final doivent être de vrais résultats, pas des estimations. Ces chiffres seront montrés au patron de Louis.**
5. `GET /api/precision` (scopé) : prédictions, confirmées, taux vs baseline, par mois — carte "Precision" dans l'UI Signals.

Commit : `feat(ledger): self-labeling prediction outcomes + backtest`

#### SPRINT S4 — Morning Brief, LE PRODUIT (prérequis : S3)
1. Migration gatée : `briefs(id, user_id, brief_date, items TEXT JSON, sent_at, opened_at)` et `brief_actions(id, brief_id, signal_id, action_type TEXT CHECK (action_type IN ('letter','call_logged','dismissed')), acted_at, converted_to_appraisal INTEGER DEFAULT 0, converted_to_listing INTEGER DEFAULT 0)`.
2. `brief_builder.py` après le cron : top 5 `vendor_signals` 'new' par user (scopés user_suburbs), narrative par item via l'API Claude (modèle `claude-sonnet-4-6`, prompt strictement contraint aux données du signal, ton sobre, 2 phrases max par item, JAMAIS d'invention). Envoi Resend (réutiliser le pattern du digest existant). Pixel/lien de tracking d'ouverture → briefs.opened_at.
3. Vue UI "Today" (view PAR DÉFAUT au login) : les 5 items, boutons "Generate letter" (python-docx existant, template ADAPTÉ au type de signal — la lettre withdrawn ≠ la lettre street record), "Log call", "Dismiss" → brief_actions. Téléchargement lettre en fetch+blob via BACKEND_DIRECT (window.open interdit — bypass l'interceptor X-Access-Key).
4. Case à cocher sur items actionnés : "→ appraisal ?" "→ listing ?" (l'attribution, une saisie d'un clic — c'est la SEULE saisie manuelle demandée à l'agent).

Commit : `feat(brief): morning brief with one-click actions + attribution`

#### Livrable final Étape 3
Rapport de handoff : par sprint fichiers touchés file:line, décisions prises en autonomie et pourquoi, **résultat RÉEL du backtest S3 (chiffres)**, diff global PlwVM → claude/sentinel-s1-s4, checklist de vérifications manuelles avant merge. **NE PAS MERGER — validation de Louis obligatoire.**

### ☐ Étape 4 — Merge + déploiement (après validation Louis du diff global)
- Merge vers PlwVM → deploy auto Render/Vercel. Vérifier les migrations au boot (schema_migrations).
- Vérifier le premier brief réel du lendemain matin (contenu, scope, lien lettre).

### ☐ Étape 5 — PILOTE (2 semaines, PAS DE CODE)
- Louis met le brief dans les mains de Grant (design partner n°1). Collègues Acton | Belle ensuite (leurs suburbs sont déjà scrapés).
- Instrumenter : ouverture des briefs, actions, conversions (les tables S4 le font déjà).
- **La décision S5 vient de l'usage** : "trop de faux positifs" → S5 = calibration des poids sur le backtest + issues réelles. "Je veux gagner plus d'appraisals" → S5 = Listing Autopsy (~70% du travail déjà fait par S1 : rapport de campagne par adresse — DOM réels, trajectoires de prix, retraits, benchmark par agence, stratégie de prix argumentée).

### ☐ Étape 6+ — Backlog ordonné (déclencheurs, PAS de dates)
| Idée | Déclencheur |
|---|---|
| S5a Calibration des poids | Retour pilote : faux positifs |
| S5b Listing Autopsy (rapport de campagne pour gagner les mandats) | Retour pilote : gagner des appraisals |
| Dossier pré-appraisal (matter file, 1 semaine) | Un appraisal important de Grant à l'agenda |
| Vendor Journey Agent (nurture 6-24 mois post-appraisal) | Après S5 |
| Campaign Reporting Agent (rapport vendeur hebdo auto) | Après S5 |
| Market Pulse : données→vidéo hebdo auto (SuburbDesk × MotionCut) | **Premiers clients PAYANTS sur Sentinel** (Grant + 3-4 collègues abonnés). Pas avant. |
| Migration scrape local sans proxy (modèle rental scraper) | Décision Louis — coût IPRoyal vs premier client payant. Le déclencheur pour RÉINTRODUIRE cloud+proxy si migration faite : le premier client payant. |
| AVM premium multimodal | 12+ mois d'events propres |
| Data co-op benchmarks / moonshots | Sortie du mono-agence |

---

## 3. RAPPELS CRITIQUES (à ne jamais perdre)

- **Le brief est le produit, pas le dashboard.** Toute énergie UI au-delà du minimum est du gaspillage avant le pilote.
- **Le moat = la boucle d'auto-étiquetage** (le scraper vérifie les prédictions) + la série temporelle accumulée. Chaque jour de scrape propre creuse l'avantage. Chaque jour de scrape sale l'empoisonne — d'où la priorité absolue à la qualité du scrape.
- **Les chiffres montrés à Grant doivent être vrais.** Le backtest S3 doit être réellement exécuté ; un chiffre de précision halluciné ou optimiste détruirait la crédibilité du produit ET de Louis dans sa propre agence.
- **Explicabilité non négociable** : reason_codes sur chaque score (exigence produit + conformité décisions automatisées déc. 2026 — c'est aussi un argument de vente contre les boîtes noires type Cotality/Propic).
- **Ne jamais toucher aux délais de politesse REIWA (5-15s).** La fragilité du scrape est le risque existentiel n°1 du projet.
- Pricing de référence (non implémenté) : Starter 99 $ / Pro 199 $ / Agency 349 $ + add-on 49 $/agent senior. Contexte mono-agence : viser un deal bureau (type Agency), un seul décideur (Grant/head office).
- Positionnement vs concurrence : Cotality Propensity to List (~500$+/mois, national, SANS workflow) ; Propic Advantage (~160$/pers/mois, conversationnel, sans mémoire longitudinale locale). SuburbDesk = la boucle locale fermée signal → action → issue vérifiée, 10× moins cher, explicable.

## 4. SI QUELQUE CHOSE NE COLLE PAS
Si ce document contredit le CLAUDE.md du repo → le CLAUDE.md prime (il est versionné et plus frais). Si l'état du repo contredit les deux (ex : un sprint déjà partiellement commencé sur une branche sentinel existante) → inventorier l'existant d'abord, rapporter l'écart à Louis, ne rien écraser.
