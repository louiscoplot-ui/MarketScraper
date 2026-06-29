# SuburbDesk — Architecture

Vue d'ensemble du système. Le diagramme rendu (`architecture.png` / `.svg`)
est généré depuis Graphviz ; ci-dessous la version Mermaid éditable qui se
rend nativement sur GitHub.

> 🟩 = travail des signal loops (cette semaine). 🟥 = le ping keep-warm qui
> réveille Neon (cause de surconsommation compute identifiée).

```mermaid
flowchart TB
    agent["Agent (navigateur)<br/>suburbdesk.com"]

    subgraph FE["Frontend — React + Vite (Vercel)"]
        shell["App.jsx / Header<br/>lib/api.js (BACKEND_DIRECT)<br/>main.jsx keep-alive ping"]
        pages["Pages: Listings · Pipeline · Appraisals*<br/>Market Report · Hot Vendors · Rental · Admin"]
    end

    subgraph BE["Backend — Flask (Render) · app.py"]
        gate["before_request gate<br/>resolve_request_scope() / _require_admin()"]
        core["Routes existantes<br/>auth · admin · listings · pipeline<br/>hot_vendors · report · export · import · rental"]
        newr["Routes NOUVELLES<br/>signals_api (LOOP 2/3/4/6)<br/>appraisals_api (LOOP-5) · roi_api (PERF-2)"]:::new
        subgraph SIG["signals/ — signal loops"]
            diff["diff_engine (LOOP-1)<br/>snapshot run-à-run"]:::new
            wo["withdrawn_orphan (2)"]:::new
            sf["sale_fallen (3) [SIGNALS_LIVE]"]:::new
            sr["sold_reveal (4)"]:::new
            af["appraisal_followup (5) [SIGNALS_LIVE]"]:::new
            st["strata_contagion (6)"]:::new
        end
        letters["pipeline_letter.py<br/>.docx (python-docx)"]
        digest["email_digest.py<br/>Morning Brief"]
    end

    subgraph DB["Base — Postgres (Neon) / SQLite (local)"]
        dbcore[("listings · suburbs · scrape_logs<br/>pipeline_tracking · hot_vendor_* · users · user_suburbs")]
        dbnew[("NOUVELLES TABLES<br/>listing_transitions · listing_snapshots<br/>appraisals · appraisal_followups · strata_complexes")]:::new
    end

    subgraph CRON["Scraping & Cron (GitHub Actions)"]
        cron["scrape_sales.yml (0 16 UTC)<br/>run_daily_scrape.py"]
        scraper["scraper.py + scraper_*<br/>healing_loop (self-recovery)"]
        warm["keep-render-warm (14 min)<br/>keepalive · auto-deploy"]
    end

    reiwa["REIWA.com.au (source)"]
    resend["Resend (emails)"]
    osm["OSM / Overpass (voisins 150m)"]
    claude["Claude API (pitch bullets)"]

    agent --> shell --> pages
    shell -->|"/api/* +X-Access-Key"| gate
    gate --> core --> dbcore
    gate --> newr --> dbnew
    newr -.-> diff
    cron --> scraper --> reiwa
    scraper -->|upsert| dbcore
    cron -->|après chaque suburb| diff -->|transitions + snapshots| dbnew
    cron --> wo & sf & sr & af & st
    wo & sr & st --> letters
    sf & af --> resend
    cron --> digest --> resend
    sr & st --> osm
    newr -.->|pitch| claude
    warm ==>|"ping → réveille Neon"| gate

    classDef new fill:#c8e6c9,stroke:#2e7d32;
    linkStyle 17 stroke:#c62828,stroke-width:2px;
```

## Notes
- **Auth** : toute route `/api/*` passe par le gate (`X-Access-Key`), exemptés `/api/auth/`, `/api/ping`, `/api/legal/`.
- **Signal loops** : `diff_engine` (LOOP-1) détecte les transitions entre deux scrapes via snapshot ; les autres loops consomment ces transitions.
- **`[SIGNALS_LIVE]`** : `sale_fallen` et `appraisal_followup` envoient de vrais emails — gardés en dry-run tant que `SIGNALS_LIVE` n'est pas activé.
- **Conso compute** : `/api/ping` interroge la base ; le keep-warm (14 min) + un onglet ouvert (ping 5 min) empêchent Neon de se suspendre → surconsommation CU-hrs.
