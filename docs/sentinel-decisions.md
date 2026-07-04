# Sentinel — Décisions d'architecture (Étape 2 + décisions prises en autonomie)

Document exigé par `docs/sentinel-handoff.md` (Étape 2 + règle « décision documentée »).
Chaque décision cite le code au moment de la branche `claude/sentinel-s1-s4` (base `704cda7`).

---

## Étape 2 — `listing_transitions` / `listing_snapshots` vs `listing_events`

### 1. D'où viennent ces tables ?

- **Commit créateur** : `81a415a` — "feat(signals): LOOP-1 listing_transitions + diff engine", 24/06/2026.
- **Schémas** : `backend/db_schema.py:128-152`.
  - `listing_transitions(id, listing_id, suburb TEXT, address, transition_type, from_status, to_status, detected_at, metadata JSON TEXT, processed, processed_at)` — append-only.
  - `listing_snapshots(listing_id PK, suburb TEXT, status, sold_price, price_text, captured_at)` — état du run PRÉCÉDENT uniquement, réécrit delete+insert à chaque run (`signals/diff_engine.py:207-214`). Ce n'est PAS un historique.
- **Écrivain unique** : `signals/diff_engine.run_diff()` (`diff_engine.py:157-224`), appelé par suburb depuis `scripts/run_daily_scrape.py:298`. Le chemin de scrape manuel UI (`scrape_runner.py`) ne l'appelle pas.
- **Premières données réelles** : run 52 du 01/07/2026 (premier run nightly avec ce code — le cron plantait sur quota Neon du 24 au 30/06). Transitions live confirmées au run 54 (03/07).

### 2. Live ou orphelines ?

**LIVE.** Consommateurs en prod :
- LOOP-2 `signals/withdrawn_orphan.py`, LOOP-3 `sale_fallen.py`, LOOP-4 `sold_reveal.py`,
  LOOP-6 `strata_contagion.py` — lisent `listing_transitions` (flag `processed`),
  génèrent leads pipeline / alertes email (gated `SIGNALS_LIVE`) / lettres.
- Routes `signals_api.py` (badge, listes, ZIP lettres) + monitoring admin `app.py:1099-1143`.
- Sections du digest matinal `email_digest.py`.

### 3. `listing_transitions` fait-elle déjà ce que S1 demande ?

**Partiellement — insuffisant tel quel :**

| Besoin S1 | Couvert ? |
|---|---|
| withdrawn, relisted, price_drop | ✅ (`_classify`, diff_engine.py:95-152) |
| price_rise, agency_change, sold | ❌ absents |
| back_on_market | ≈ `sale_fallen` (under_offer→active) |
| plusieurs events par listing par run | ❌ `_classify` retourne UN type max (priorité) |
| relisted par MATCHING D'ADRESSE (nouvel ID REIWA) | ❌ uniquement le flip withdrawn→active de la MÊME ligne |
| colonne `source` (daily_diff vs backfill) | ❌ |
| historique pré-01/07 | ❌ (snapshots inexistants avant) |

### 4. Décision : ÉTENDRE l'infrastructure, table d'événements dédiée

**`listing_events` est créée, alimentée par LA MÊME passe de comparaison que
`listing_transitions`** : `run_diff()` appelle le nouveau module pur
`signals/event_detector.py` sur les mêmes données en mémoire et écrit les deux tables.

Pourquoi pas tout dans `listing_transitions` : sa sémantique (1 transition max par
listing/run, flag `processed`) appartient aux LOOP-2..6 **live** qui envoient emails et
lettres. Y injecter des types nouveaux, du multi-événement et des lignes backfillées
= risque d'alertes rétroactives et de dérive sémantique sur un système en prod.

Pourquoi pas un détecteur parallèle indépendant : il lui faudrait son propre snapshot
« état précédent » — or `run_diff` DÉTRUIT le snapshot en le réécrivant
(diff_engine.py:207). Deux consommateurs du même snapshot ne peuvent pas coexister
sans partager la passe. D'où : une passe, deux sorties.

Coûts acceptés : +1 table, +1 colonne `agency` sur `listing_snapshots`
(ALTER additif idempotent — nécessaire pour `agency_change`), zéro changement de
comportement pour les LOOPs existants.

---

## Décisions prises en autonomie (règle handoff : conservateur + documenté)

### D1 — `normalize_address` Sentinel : nouvelle fonction, l'existante intouchée
Il existe déjà `database.normalize_address()` (database.py:135) dont la sortie est
STOCKÉE dans 3 tables (`listings.normalized_address`, `hot_vendor_properties`,
`listing_notes`) et jointe par le digest, le pipeline et l'import RP Data. La modifier
casserait silencieusement ces joins (clés stockées ≠ clés recalculées).
→ `event_detector.normalize_address()` = version Sentinel (unités `2/80`·`Unit 2, 80`·
`2 / 80` convergentes, suffixe lettre conservé, apostrophes/punctuation strip,
suburb/WA/code postal terminaux strip, table d'abréviations étendue). Utilisée par les
modules Sentinel UNIQUEMENT (S1 relisted, S3 matching). L'existante n'est pas touchée.

### D2 — Règle « withdrawn après 3 scrapes réussis d'absence »
L'absence par-listing AVANT le flip de statut n'est pas observable sans modifier le
scraper (zone interdite : `verify_disappeared_listings` + guards). Le flip
`status='withdrawn'` est déjà gaté par les guards anti-cascade du 18/06
(`mark_withdrawn(confident=True)` exige une couverture complète vérifiée —
scrape_runner.py:247-301) : un flip n'arrive qu'après un scrape RÉUSSI qui a couvert
le suburb. Implémentation retenue : l'événement `withdrawn` est émis quand le flip
apparaît dans le diff **ET** que les 3 derniers `scrape_logs` du suburb sont sains
(complétés, `forsale_count > 0`) — la validité se mesure en scrapes réussis, jamais en
jours calendaires. C'est une approximation prudente de la règle des 3 scrapes ;
l'absence par-listing exacte exigerait un compteur dans le scraper (hors périmètre).
Risque résiduel signalé : un retrait réel pendant une série de scrapes dégradés est
émis avec retard (jamais à tort).

### D3 — price_drop / price_rise : tout changement de prix parsable est un événement
Le seuil 3% de `_classify` reste propre aux transitions (LOOPs). `listing_events`
journalise le FAIT (prix ancien → nouveau, en int via `_price_to_int`) ; c'est le
Signal Engine (S2) qui applique des seuils. Les reformatages sans changement de valeur
(« $1.2m » → « $1,200,000 ») ne produisent rien (comparaison sur entiers parsés).

### D4 — Backfill : fenêtres valides et sources
Fenêtres TROUS exclues (handoff) : ]17/06 19:01 → 19/06 05:48[, ]24/06 00:00 →
01/07 00:00[, ]01/07 18:49 → 03/07 17:38[ (UTC).
Sources d'events rétroactifs — UNIQUEMENT ce qui est append-only ou jamais réécrit :
- `price_history` (append-only) → price_drop/price_rise, `detected_at = changed_at`.
- `listings.sold_date` non-NULL → sold, `detected_at = sold_date`.
- `listings.withdrawn_date` non-NULL **et status encore withdrawn** → withdrawn.
- **AUCUN relisted rétroactif** : les cycles retrait→re-listing sont détruits par le
  scraper (`withdrawn_date` effacé au relist database.py:442 ; lignes withdrawn
  homonymes supprimées database.py:416-420). Inventer ces événements = données fausses.
- Idempotent : clé (listing_id, event_type, detected_at), vérification avant insert.

### D5 — Événements live émis uniquement par le cron
`run_diff` n'est appelé que par le run nightly (pas par les scrapes manuels UI) —
comportement existant conservé pour les events (cohérence transitions/events, et un
scrape manuel en journée produirait des deltas partiels). Limite documentée.
