# Demain matin — Checklist à suivre dans l'ordre

Tu n'as qu'à suivre les étapes une par une. Si quelque chose casse, tu me copies l'erreur exacte ici et je fix.

---

## ✅ ÉTAPE 1 — Deploy le travail du soir (5 min)

### 1.1 Merger la PR
Ouvre cette URL et clique **Create pull request** → **Merge pull request** → **Confirm merge** :

https://github.com/louiscoplot-ui/MarketScraper/compare/main...claude/define-excel-columns-XQ4UE

### 1.2 Attendre les deploys
- Vercel auto-deploy (frontend) — ~2 min
- Render auto-deploy (backend) — ~2 min
- Total : 2 minutes café ☕

### 1.3 Tests backend (60 sec, copie-colle dans n'importe quel terminal)

```bash
curl -s https://marketscraper-backend.onrender.com/api/ping
# attendu: {"status":"ok","app":"market-scraper"}

curl -s "https://marketscraper-backend.onrender.com/api/hot-vendors/lookup?address=1+test+st"
# attendu: {"match":null}

curl -s https://marketscraper-backend.onrender.com/api/hot-vendors/uploads
# attendu: {"uploads":[]}

curl -sI "https://marketscraper-backend.onrender.com/api/listings/export?suburb_ids=1" | head -1
# attendu: HTTP/2 200

curl -s "https://marketscraper-backend.onrender.com/api/pipeline/tracking/grouped?suburb=Cottesloe&limit=5" | head -c 100
# attendu: du JSON avec "groups"
```

**Si un truc renvoie 500 → attends 1 minute (Render redémarre encore) puis retry.**

**Si toujours 500 après 3 min → tu m'envoies le log Render (Dashboard → Logs).**

---

## ✅ ÉTAPE 2 — Smoke test visuel (5 min)

Ouvre l'app dans ton navigateur. Clique sur chaque onglet, vérifie que ça s'affiche :

- [ ] **Listings** → tableau avec listings, filtres (Active/Sold/etc), suburbs sidebar
- [ ] **Pipeline** → liste des lettres groupées par voisin
- [ ] **Hot Vendors** → page upload CSV
- [ ] **Market Report** (clique "Market Report" en haut) → cards stats + graphes
- [ ] **View Logs** → tableau historique des scrapes
- [ ] **Theme** (bouton en haut à droite) → modal avec 4 presets

**Si une vue est blanche / cassée → tu m'envoies :**
1. Screenshot de la page
2. Screenshot de la console (F12 → Console)

---

## ✅ ÉTAPE 3 — Redesign visuel (1 h)

### 3.1 — Avant de m'écrire, choisis 1 site de référence

Réponds avec **un seul lien** parmi :
- Linear (https://linear.app) — minimaliste, sombre/clair, super pro
- Notion (https://notion.so) — épuré, beaucoup de blanc
- Stripe Dashboard — tableaux ultra propres, beaucoup de data
- Pipedrive — CRM, listings table proche de notre cas
- Autre site que tu connais

### 3.2 — Phase 1 : Header pro avec tabs (~30 min, je code, tu regardes Vercel)

Je transforme :
- Header neutre (fond blanc cassé, gris foncé) — zéro signature de marque
- Slot logo vide 48×48px à gauche (prêt pour ton PNG plus tard)
- Tabs : `Listings · Pipeline · Market Report · Hot Vendors` (souligné actif)
- Actions secondaires (Scrape, Export, Logs, Theme) groupées en menu `⋯`
- Typo Inter (gratuit, propre, type Linear/Vercel)

**Tu regardes en live sur Vercel pendant que je push, tu me dis "j'aime / change X".**

### 3.3 — Phase 2 : Tableau Listings dense + sticky (~20 min)

- Police 13px sur les colonnes nombres (au lieu de 14)
- Padding cellules réduit (compact)
- Sticky header (header reste visible quand tu scrolles)
- Sticky 1ère colonne Address (visible quand tu scrolles à droite)
- Status en pastille discrète (point coloré + texte gris) au lieu de badge plein

### 3.4 — Phase 3 : Toggle Acton (~10 min)

- Dans la modal Theme, ajoute en haut un preset **"Acton | Belle"** :
  - Vert `#00563F` (boutons primaires + underline tabs actif)
  - Reste neutre
- Click sur le preset = thème vert immédiat
- Sauvé en localStorage (persistant)
- Tu peux switcher avant chaque démo

---

## ✅ ÉTAPE 4 — Si tu veux pousser plus loin (optionnel, plus tard)

- Skeleton loaders au lieu de "Loading..."
- Toast notifications au lieu de `alert()`
- Drag-resize des colonnes du tableau
- Export PDF du Market Report
- Frontend Hot Vendor → POST sur `/api/hot-vendors/uploads` (persiste les uploads RP Data en DB)
- Inline edit des dates dans le tableau Listings (l'endpoint backend existe déjà : PATCH /api/listings/<id>)

---

## 🚨 Si tu as un problème, donne-moi exactement :

1. **Quelle étape** (1.3 / 2 / 3.2 etc)
2. **Ce que tu vois** (texte d'erreur, ou screenshot)
3. **Ce que t'attendais**

Pas de "ça marche pas" stp 😄 — j'ai besoin du détail pour fix vite.

---

## 📝 Note pour la session de demain

J'ai pleine autonomie code maintenant — backend ET frontend tous les fichiers sous 25KB.
Je peux éditer, push, et tu vois en live sur Vercel en 2 min.
Tu décides du visuel, je code.
