"""Cloudflare bypass probe — THROWAWAY. Now confirms the Chromium path
through the working residential proxy (param on password + geo-au).

curl already proved the proxy returns real REIWA listings (HTTP 200,
114 p-cards). This checks whether Playwright/patchright Chromium can use
the same authenticated proxy in headless mode (it had
ERR_PROXY_AUTH_UNSUPPORTED earlier, but that was with wrong creds).
"""

import os
import sys
import time
from urllib.parse import urlsplit

URL = ("https://reiwa.com.au/for-sale/cottesloe/"
       "?includesurroundingsuburbs=false&sortby=listdate")
SETTLE = 25
POLL = 2.5


def parse_proxy(url):
    if not url:
        return None
    p = urlsplit(url)
    proxy = {"server": f"{(p.scheme or 'http')}://{p.hostname}:{p.port}"}
    if p.username:
        proxy["username"] = p.username
    if p.password:
        proxy["password"] = p.password
    return proxy


def make_working(proxy):
    """Append IPRoyal AU geo targeting to the PASSWORD (the format that
    returned HTTP 200 + 114 p-cards under curl). Idempotent."""
    if not proxy:
        return None
    out = dict(proxy)
    pw = out.get("password", "") or ""
    base = pw.split("_")[0]            # strip any existing _params
    out["password"] = base + "_country-au"
    return out


def run(engine_sync, label, proxy, at="context", headless=True):
    print(f"\n{'='*64}\n[{label}] at={at} headless={headless}\n{'='*64}")
    args = ["--no-sandbox", "--disable-setuid-sandbox"]
    t0 = time.time()
    try:
        with engine_sync() as pw:
            if at == "launch":
                browser = pw.chromium.launch(headless=headless, args=args, proxy=proxy)
                ctx = browser.new_context(locale="en-AU",
                                          viewport={"width": 1280, "height": 800})
            else:
                browser = pw.chromium.launch(headless=headless, args=args)
                ctx = browser.new_context(locale="en-AU",
                                          viewport={"width": 1280, "height": 800},
                                          proxy=proxy)
            page = ctx.new_page()
            # Mirror the real scraper's route_filter (heavy assets +
            # third-party hosts blocked) so we measure realistic bandwidth.
            def _filter(route):
                req = route.request
                host = (urlsplit(req.url).hostname or "").lower()
                if (req.resource_type in ("image", "media", "font", "stylesheet")
                        or not any(t in host for t in ("reiwa", "cloudflare", "cf-"))):
                    route.abort()
                else:
                    route.continue_()
            page.route("**/*", _filter)
            # Tally transferred bytes via Content-Length to size the saving.
            bytes_seen = {"n": 0}

            def _tally(resp):
                try:
                    cl = resp.headers.get("content-length")
                    if cl:
                        bytes_seen["n"] += int(cl)
                except Exception:
                    pass
            page.on("response", _tally)
            err = None
            for att in range(1, 3):
                try:
                    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
                    err = None
                    break
                except Exception as e:
                    err = str(e).splitlines()[0]
                    print(f"  goto attempt {att}: {err}")
                    time.sleep(3)
            cards = 0
            deadline = time.time() + SETTLE
            while time.time() < deadline:
                try:
                    cards = page.evaluate(
                        "()=>document.querySelectorAll('[class*=\"p-card\"]').length")
                except Exception:
                    cards = -1
                if cards and cards > 0:
                    break
                time.sleep(POLL)
            try:
                title = page.title()
            except Exception:
                title = "<err>"
            ok = bool(cards and cards > 0)
            kb = bytes_seen["n"] / 1024.0
            print(f"  VERDICT : {'PASS ✅' if ok else 'FAIL ❌'}  cards={cards} "
                  f"title={title!r} elapsed={time.time()-t0:.1f}s "
                  f"transfer≈{kb:.0f} KB (1 for-sale page)")
            browser.close()
            return ok
    except Exception as e:
        print(f"  ENGINE ERROR: {str(e).splitlines()[0]}")
        return False


def main():
    base = parse_proxy(os.environ.get("SCRAPE_PROXY", "").strip())
    if not base:
        print("SCRAPE_PROXY not set — abort.")
        sys.exit(0)
    proxy = make_working(base)
    print(f"Using proxy server={proxy['server']} geo=au (param on password)")

    results = {}
    try:
        from playwright.sync_api import sync_playwright as pw_play
        results["playwright/context"] = run(pw_play, "playwright/context", proxy, at="context")
        results["playwright/launch"] = run(pw_play, "playwright/launch", proxy, at="launch")
    except Exception as e:
        print(f"playwright import failed: {e}")
    try:
        from patchright.sync_api import sync_playwright as pw_patch
        results["patchright/context"] = run(pw_patch, "patchright/context", proxy, at="context")
    except Exception as e:
        print(f"patchright import failed: {e}")

    print(f"\n{'#'*64}\nSUMMARY\n{'#'*64}")
    for k, v in results.items():
        print(f"  {k:24s} -> {'PASS' if v else 'FAIL'}")
    if any(results.values()):
        print("\n→ ✅ Chromium works through the proxy. Wire this config into the "
              "scraper launches and we're done.")
    else:
        print("\n→ ❌ Chromium still can't auth the proxy in headless. Next step: "
              "local proxy forwarder (Chromium → 127.0.0.1 no-auth → IPRoyal).")
    sys.exit(0)


if __name__ == "__main__":
    main()
