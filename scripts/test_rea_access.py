#!/usr/bin/env python3
"""THROWAWAY — Phase 1 test d'accès realestate.com.au (lecture seule).

But unique : charger UNE page de résultats REA avec un contexte navigateur
réaliste et déterminer laquelle de ces situations on rencontre :
  (A) 200 + blob ArgonautExchange présent + annonces extraites -> ACCÈS OK
  (B) 200 mais blob absent -> challenge Akamai déguisée (status ment)
  (C) 403 / 429 -> blocage franc
  (D) timeout / erreur réseau -> autre chose

Ne fait partie d'aucun pipeline. Aucun INSERT, aucune DB, aucune écriture
hors du screenshot. Une seule requête vers REA, aucun retry, aucun proxy,
aucun contournement — mêmes conditions exactes que le scraper REIWA actuel.

Exit code : 0 si verdict (A), 1 sinon.

Usage :
  python3 scripts/test_rea_access.py
  python3 scripts/test_rea_access.py --suburb mount+lawley --postcode 6050
  python3 scripts/test_rea_access.py --screenshot /tmp/rea_test.png
"""

import argparse
import json
import os
import sys

from playwright.sync_api import sync_playwright

# UA Chrome desktop récent cohérent avec le Chromium bundled (chromium-1194).
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)

# Même binaire que la prod (scraper_utils.CHROMIUM_PATH). Sur un runner GHA
# `playwright install chromium` place son propre binaire — on laisse alors
# Playwright le résoudre (CHROMIUM_PATH = None).
CHROMIUM_PATH = os.environ.get(
    "CHROMIUM_PATH",
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
)
if not os.path.exists(CHROMIUM_PATH):
    CHROMIUM_PATH = None

IP_URL = "https://api.ipify.org"


def build_url(suburb, postcode):
    """URL de résultats REA « buy » triée par date de mise en ligne."""
    slug = suburb.strip().lower().replace(" ", "+")
    return (
        f"https://www.realestate.com.au/buy/in-{slug},+wa+{postcode}/list-1"
        "?includeSurrounding=false&activeSort=list-date"
    )


def line(char="-", n=68):
    print(char * n)


def safe_get(obj, *path, default=None):
    """Descend dans un mélange de dicts/lists sans jamais lever.

    Beaucoup de champs REA sont absents selon le type de bien
    (Retirement Living, Land, etc.) — chaque accès passe par ici.
    """
    cur = obj
    for key in path:
        if cur is None:
            return default
        try:
            cur = cur[key]
        except (KeyError, IndexError, TypeError):
            return default
    return cur if cur is not None else default


def extract_listings(raw):
    """Extrait items + pagination depuis window.ArgonautExchange.

    Chemin vérifié sur un échantillon réel de la page. Renvoie
    (items, pagination_dict). Lève si la structure est absente —
    l'appelant traite ça comme 'blob présent mais illisible'.
    """
    exp = raw["resi-property_listing-experience-web"]
    cache = json.loads(exp["urqlClientCache"])   # STRING JSON -> dict
    key = next(iter(cache))                       # première clé
    inner = json.loads(cache[key]["data"])        # data est aussi une STRING
    items = safe_get(inner, "buySearch", "results", "exact", "items",
                     default=[]) or []
    pag = safe_get(inner, "buySearch", "results", "pagination", default={}) or {}
    return items, pag


def summarise_listing(item):
    """Mapping tolérant d'une annonce -> dict de champs plats."""
    listing = item.get("listing", item) if isinstance(item, dict) else {}
    agents = [safe_get(p, "name") for p in (listing.get("listers") or [])]
    agents = [a for a in agents if a]
    return {
        "rea_id":  safe_get(listing, "id"),
        "address": safe_get(listing, "address", "display", "fullAddress"),
        "suburb":  safe_get(listing, "address", "suburb"),
        "price":   safe_get(listing, "price", "display"),
        "beds":    safe_get(listing, "generalFeatures", "bedrooms", "value"),
        "baths":   safe_get(listing, "generalFeatures", "bathrooms", "value"),
        "cars":    safe_get(listing, "generalFeatures", "parkingSpaces", "value"),
        "ptype":   safe_get(listing, "propertyType", "display"),
        "agency":  safe_get(listing, "listingCompany", "name"),
        "agents":  agents,
        "land":    safe_get(listing, "propertySizes", "land", "displayValue"),
        "badge":   safe_get(listing, "badge", "label"),
        "url":     safe_get(listing, "_links", "canonical", "href"),
    }


def fetch_public_ip(page):
    """IP publique de sortie — utile au diagnostic si REA bloque.

    Requête séparée, best-effort : un échec ne compromet pas le test REA.
    """
    try:
        resp = page.goto(IP_URL, wait_until="domcontentloaded", timeout=15000)
        if resp is not None and resp.ok:
            return (resp.text() or "").strip() or "(vide)"
        return f"(status {resp.status if resp else 'None'})"
    except Exception as e:
        return f"(indisponible : {type(e).__name__})"


def main():
    parser = argparse.ArgumentParser(description="Test d'accès REA (lecture seule)")
    parser.add_argument("--suburb", default="ellenbrook",
                        help="slug suburb REA (défaut: ellenbrook)")
    parser.add_argument("--postcode", default="6069",
                        help="code postal WA (défaut: 6069)")
    parser.add_argument("--screenshot", default="/tmp/rea_test.png",
                        help="chemin du screenshot (défaut: /tmp/rea_test.png)")
    args = parser.parse_args()

    target_url = build_url(args.suburb, args.postcode)
    shot_path = args.screenshot

    print("Phase 1 — test d'accès realestate.com.au (lecture seule, sans proxy)")
    line()
    print(f"URL cible  : {target_url}")
    print(f"Chromium   : {CHROMIUM_PATH or '(défaut Playwright)'}")
    print(f"User-Agent : {USER_AGENT}")
    line()

    status = None
    title = ""
    body_text = ""
    has_argonaut = False
    blob_size = None
    raw = None
    net_error = None
    public_ip = None

    with sync_playwright() as p:
        launch_opts = {
            "headless": True,
            "args": ["--no-sandbox", "--disable-setuid-sandbox"],
        }
        if CHROMIUM_PATH:
            launch_opts["executable_path"] = CHROMIUM_PATH

        browser = p.chromium.launch(**launch_opts)
        context = browser.new_context(
            user_agent=USER_AGENT,
            viewport={"width": 1440, "height": 900},
            locale="en-AU",
            timezone_id="Australia/Perth",
            extra_http_headers={
                "Accept-Language": "en-AU,en;q=0.9",
                "Accept": (
                    "text/html,application/xhtml+xml,application/xml;q=0.9,"
                    "image/avif,image/webp,*/*;q=0.8"
                ),
            },
        )

        # Neutralise le fingerprint headless le plus trivial.
        context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', "
            "{get: () => undefined});"
        )

        page = context.new_page()

        # IP publique en premier — loguée en tête de sortie pour le diagnostic.
        public_ip = fetch_public_ip(page)
        print(f"IP publique de sortie : {public_ip}")
        line()

        # LA requête REA — une seule, pas de retry.
        try:
            resp = page.goto(target_url, wait_until="networkidle",
                             timeout=60000)
            if resp is not None:
                status = resp.status
        except Exception as e:
            net_error = f"{type(e).__name__}: {e}"

        # Screenshot INDISPENSABLE : Akamai sert "Pardon Our Interruption"
        # en 200 — le status seul ment. On tente même après une erreur.
        try:
            page.screenshot(path=shot_path, full_page=False)
        except Exception:
            pass

        if net_error is None:
            try:
                title = (page.title() or "")[:300]
            except Exception:
                title = "(indisponible)"
            try:
                body_text = page.evaluate(
                    "() => document.body ? document.body.innerText : ''"
                )[:300]
            except Exception:
                body_text = "(indisponible)"
            try:
                has_argonaut = bool(page.evaluate(
                    "() => typeof window.ArgonautExchange !== 'undefined' "
                    "&& window.ArgonautExchange !== null"
                ))
            except Exception:
                has_argonaut = False
            if has_argonaut:
                try:
                    raw = page.evaluate("() => window.ArgonautExchange")
                    blob_size = len(json.dumps(raw))
                except Exception:
                    raw = None

        browser.close()

    # ---- Rapport ----
    line("=")
    print("RÉSULTAT")
    line("=")
    print(f"IP publique            : {public_ip}")
    print(f"HTTP status            : {status}")
    print(f"window.ArgonautExchange: {has_argonaut}")
    print(f"Taille blob (JSON)     : {blob_size} octets")
    print(f"Erreur réseau          : {net_error}")
    print(f"Screenshot             : {shot_path}"
          + ("" if os.path.exists(shot_path) else "  (NON écrit)"))
    line()
    print("TITLE (300 chars) :")
    print(f"  {title!r}")
    print("BODY  (300 chars) :")
    print(f"  {body_text!r}")
    line("=")

    # ---- Cas d'échec francs : diagnostic + sortie propre, aucun retry ----
    if net_error is not None:
        print("Diagnostic : erreur réseau/navigateur — pas de réponse HTTP.")
        print(f"  -> {net_error}")
        line("=")
        print("VERDICT : (D) timeout / erreur réseau — voir diagnostic")
        return 1

    if status in (403, 429):
        print(f"Diagnostic : blocage franc (HTTP {status}). Pas de retry.")
        print(f"  Titre page : {title!r}")
        print(f"  Screenshot : {shot_path}")
        line("=")
        print("VERDICT : (C) 403/429 — blocage franc")
        return 1

    if not has_argonaut:
        print("Diagnostic : blob ArgonautExchange ABSENT malgré la réponse.")
        print("  Probable challenge Akamai servie en 200 (status ment).")
        print(f"  Titre page : {title!r}")
        print(f"  Screenshot : {shot_path}")
        line("=")
        print("VERDICT : (B) 200 mais blob absent — challenge Akamai déguisée")
        return 1

    # ---- Blob présent : parse ----
    try:
        items, pag = extract_listings(raw)
    except Exception as e:
        print(f"Diagnostic : blob présent mais structure illisible : {e}")
        line("=")
        print("VERDICT : (B) blob présent mais non parsable — structure changée")
        return 1

    rows = [summarise_listing(it) for it in items]

    print(f"Annonces extraites du blob : {len(rows)}")
    print("Pagination annoncée        : "
          f"page={pag.get('page')} "
          f"maxPage={pag.get('maxPageNumberAvailable')} "
          f"more={pag.get('moreResultsAvailable')}")
    line()
    print("10 premières annonces :")
    for i, r in enumerate(rows[:10], 1):
        feats = f"{r['beds']}/{r['baths']}/{r['cars']}"
        badge = f" [{r['badge']}]" if r["badge"] else ""
        print(f"  {i:2d}. {r['address'] or '(sans adresse)'} — "
              f"{r['price'] or '(prix nc)'} — {r['ptype'] or '?'} "
              f"({feats}) — {r['agency'] or '?'}{badge}")
        if r["url"]:
            print(f"      {r['url']}")
    line("=")
    print(f"VERDICT : (A) ACCÈS OK — {len(rows)} annonces extraites "
          f"(page {pag.get('page')}/{pag.get('maxPageNumberAvailable')})")
    line("=")
    return 0


if __name__ == "__main__":
    sys.exit(main())
