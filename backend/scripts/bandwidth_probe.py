"""Proxy bandwidth probe — diagnostic, run manually on GitHub Actions.

Goal: decide how to cut residential-proxy bandwidth WITHOUT losing coverage.
Loads one REIWA for-sale suburb page through the proxy under 3 scenarios and
reports bytes downloaded + how many listing cards rendered:

  1. current   — block images/media/font/stylesheet (today's route_filter)
  2. no-js     — ALSO block scripts (tests if the grid renders without JS)
  3. xhr-watch — logs every XHR/fetch response (find the JSON data API)

No database, no writes — safe to run anytime (even while Neon is down). Needs
SCRAPE_PROXY in the env. Prints a comparison so we can pick the cheapest path
that still returns every listing.

Run: GitHub Actions → "Proxy bandwidth probe" → Run workflow.
"""
import os
import sys
import time
from urllib.parse import urlsplit

URL = ("https://reiwa.com.au/for-sale/cottesloe/"
       "?includesurroundingsuburbs=false&sortby=listdate")
SETTLE = 20

# Card selectors to try (REIWA markup has shifted before — count whichever
# matches so the probe survives a class rename).
CARD_SELECTORS = ['[class*="p-card"]', '[class*="listing"]', 'article',
                  '[data-testid*="card"]', '[class*="Card"]']

HEAVY_BASE = {'image', 'media', 'font', 'stylesheet'}


def parse_proxy(url):
    if not url:
        return None
    p = urlsplit(url)
    proxy = {"server": f"{(p.scheme or 'http')}://{p.hostname}:{p.port}"}
    if p.username:
        proxy["username"] = p.username
    if p.password:
        base = (p.password or '').split("_")[0]
        proxy["password"] = base + "_country-au"
    if p.username:
        proxy["username"] = p.username
    return proxy


def _route_handler(blocked_types):
    def handler(route):
        try:
            if route.request.resource_type in blocked_types:
                route.abort()
            else:
                host = (urlsplit(route.request.url).hostname or '').lower()
                if any(t in host for t in ('reiwa', 'cloudflare', 'cf-')):
                    route.continue_()
                else:
                    route.abort()
        except Exception:
            try:
                route.continue_()
            except Exception:
                pass
    return handler


def count_cards(page):
    best = 0
    for sel in CARD_SELECTORS:
        try:
            n = page.locator(sel).count()
            best = max(best, n)
        except Exception:
            pass
    return best


def run_scenario(pw, proxy, label, blocked_types, watch_xhr=False):
    from playwright.sync_api import TimeoutError as PWTimeout  # noqa
    args = ["--no-sandbox", "--disable-setuid-sandbox"]
    browser = pw.chromium.launch(headless=True, args=args, proxy=proxy)
    ctx = browser.new_context(locale="en-AU", viewport={"width": 1280, "height": 800})
    page = ctx.new_page()

    bytes_by_type = {}
    bytes_total = [0]
    xhr_hits = []

    def on_response(resp):
        try:
            rt = resp.request.resource_type
            body = resp.body()
            n = len(body) if body else 0
            bytes_total[0] += n
            bytes_by_type[rt] = bytes_by_type.get(rt, 0) + n
            if watch_xhr and rt in ('xhr', 'fetch') and n > 0:
                xhr_hits.append((n, resp.url[:120]))
        except Exception:
            pass

    page.on("response", on_response)
    page.route("**/*", _route_handler(blocked_types))

    t0 = time.time()
    cards = 0
    try:
        page.goto(URL, wait_until="domcontentloaded", timeout=45000)
        time.sleep(SETTLE)
        cards = count_cards(page)
    except Exception as e:
        print(f"  [{label}] load error: {e}")
    dt = time.time() - t0

    kb = bytes_total[0] / 1024.0
    print(f"\n--- {label} ---")
    print(f"  cards rendered : {cards}")
    print(f"  total download : {kb:.0f} KB ({kb/1024:.2f} MB)")
    for rt, b in sorted(bytes_by_type.items(), key=lambda x: -x[1]):
        print(f"     {rt:12s} {b/1024:8.0f} KB")
    if watch_xhr and xhr_hits:
        print("  top XHR/fetch (potential data API):")
        for n, u in sorted(xhr_hits, reverse=True)[:8]:
            print(f"     {n/1024:7.0f} KB  {u}")
    print(f"  time: {dt:.1f}s")
    try:
        browser.close()
    except Exception:
        pass
    return {'label': label, 'kb': kb, 'cards': cards}


def main():
    proxy = parse_proxy((os.environ.get("SCRAPE_PROXY") or "").strip())
    if not proxy:
        print("SCRAPE_PROXY not set — aborting probe.")
        sys.exit(1)
    from playwright.sync_api import sync_playwright

    results = []
    with sync_playwright() as pw:
        # 1) current behaviour
        results.append(run_scenario(pw, proxy, "current (block img/css/font/media)",
                                    set(HEAVY_BASE), watch_xhr=True))
        # 2) also block JS
        results.append(run_scenario(pw, proxy, "no-js (also block scripts)",
                                    set(HEAVY_BASE) | {'script'}))

    print("\n" + "=" * 60)
    print("VERDICT")
    cur = next((r for r in results if r['label'].startswith('current')), None)
    nojs = next((r for r in results if r['label'].startswith('no-js')), None)
    if cur and nojs:
        saved = cur['kb'] - nojs['kb']
        pct = (saved / cur['kb'] * 100) if cur['kb'] else 0
        print(f"  current : {cur['kb']:.0f} KB, {cur['cards']} cards")
        print(f"  no-js   : {nojs['kb']:.0f} KB, {nojs['cards']} cards")
        if nojs['cards'] >= max(1, cur['cards'] * 0.9):
            print(f"  => JS-BLOCK SAFE: same cards, saves ~{pct:.0f}% bandwidth. "
                  f"Ship it.")
        else:
            print(f"  => JS NEEDED: cards drop ({cur['cards']}→{nojs['cards']}). "
                  f"Don't block JS; use the XHR data API instead (see top XHR above).")
    print("=" * 60)


if __name__ == "__main__":
    main()
