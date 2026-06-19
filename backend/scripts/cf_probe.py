"""Cloudflare bypass probe — THROWAWAY diagnostic, never imported by app.

Goal: settle empirically whether REIWA's Cloudflare block is driven by
browser FINGERPRINT (which a stealth engine can beat for free) or by IP
REPUTATION (datacenter IP — which only a residential proxy/IP fixes).

Method: load the SAME REIWA for-sale page from the SAME GitHub Actions
runner IP with three engine/config variants and report, for each,
whether real listing cards rendered or a Cloudflare challenge was served:

  1. playwright  headless           — control; mirrors today's prod, expect FAIL
  2. patchright  headless           — cheap drop-in candidate
  3. patchright  headed (xvfb) +    — patchright's max-stealth recommended
     persistent context               config (best free shot)

Interpretation:
  - vanilla FAIL + patchright PASS  → fingerprint was the signal → free fix works
  - ALL FAIL                        → IP reputation dominant → free cloud fix won't
                                       cut it; need residential IP (laptop/proxy)

No DB writes. No secrets. Safe to run on a throwaway workflow_dispatch.
"""

import sys
import time
import tempfile

URL = ("https://reiwa.com.au/for-sale/cottesloe/"
       "?includesurroundingsuburbs=false&sortby=listdate")

CHALLENGE_MARKERS = (
    "just a moment",
    "performing security verification",
    "verify you are human",
    "checking your browser",
    "needs to review the security",
    "cf-chl",
)

# Give Cloudflare's non-interactive JS challenge time to auto-solve and
# redirect to the real page before we judge the outcome.
SETTLE_SECONDS = 25
POLL_EVERY = 2.5


def _count_cards(page):
    try:
        return page.evaluate(
            "() => document.querySelectorAll('[class*=\"p-card\"]').length"
        )
    except Exception:
        return -1


def _judge(page):
    """Return (cards, title, challenge_detected, body_snippet, html_len)."""
    cards = _count_cards(page)
    try:
        title = page.title()
    except Exception:
        title = "<title err>"
    try:
        body = page.evaluate(
            "() => document.body ? document.body.innerText.slice(0, 400) : ''"
        )
    except Exception:
        body = ""
    try:
        html_len = page.evaluate("() => document.documentElement.outerHTML.length")
    except Exception:
        html_len = -1
    hay = (title + " " + body).lower()
    challenge = any(m in hay for m in CHALLENGE_MARKERS)
    return cards, title, challenge, body.replace("\n", " ")[:200], html_len


def probe(label, sync_pw, headless=True, persistent=False):
    print(f"\n{'='*70}\n[{label}] headless={headless} persistent={persistent}\n{'='*70}")
    t0 = time.time()
    launch_args = ['--no-sandbox', '--disable-setuid-sandbox']
    try:
        with sync_pw() as p:
            if persistent:
                user_dir = tempfile.mkdtemp(prefix="cfprobe-")
                ctx = p.chromium.launch_persistent_context(
                    user_dir,
                    headless=headless,
                    channel="chromium",
                    args=launch_args,
                    locale="en-AU",
                    no_viewport=True,
                )
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                browser = None
            else:
                browser = p.chromium.launch(headless=headless, args=launch_args)
                ctx = browser.new_context(locale="en-AU",
                                          viewport={'width': 1280, 'height': 800})
                page = ctx.new_page()

            try:
                page.goto(URL, wait_until="domcontentloaded", timeout=60000)
            except Exception as e:
                print(f"  goto error: {e}")

            # Poll while the JS challenge may be auto-solving.
            deadline = time.time() + SETTLE_SECONDS
            cards = 0
            while time.time() < deadline:
                cards = _count_cards(page)
                if cards and cards > 0:
                    break
                time.sleep(POLL_EVERY)

            cards, title, challenge, snippet, html_len = _judge(page)
            elapsed = time.time() - t0
            verdict = "PASS ✅ (real cards)" if (cards and cards > 0) else (
                "FAIL ❌ (challenge)" if challenge else "FAIL ❌ (no cards, no challenge marker)")
            print(f"  VERDICT      : {verdict}")
            print(f"  cards        : {cards}")
            print(f"  title        : {title!r}")
            print(f"  challenge    : {challenge}")
            print(f"  html_len     : {html_len}")
            print(f"  elapsed      : {elapsed:.1f}s")
            print(f"  body[:200]   : {snippet!r}")

            try:
                ctx.close()
            except Exception:
                pass
            if browser:
                browser.close()
            return {'label': label, 'cards': cards, 'challenge': challenge,
                    'pass': bool(cards and cards > 0)}
    except Exception as e:
        print(f"  ENGINE ERROR : {e}")
        return {'label': label, 'cards': -1, 'challenge': None, 'pass': False,
                'error': str(e)}


def main():
    results = []

    # 1. Control — vanilla Playwright, exactly like prod.
    try:
        from playwright.sync_api import sync_playwright as pw_vanilla
        results.append(probe("playwright/vanilla", pw_vanilla, headless=True))
    except Exception as e:
        print(f"playwright import failed: {e}")

    # 2 & 3. patchright candidate.
    try:
        from patchright.sync_api import sync_playwright as pw_patch
        results.append(probe("patchright/headless", pw_patch, headless=True))
        results.append(probe("patchright/headed+persistent", pw_patch,
                             headless=False, persistent=True))
    except Exception as e:
        print(f"patchright import failed: {e}")

    print(f"\n{'#'*70}\nSUMMARY\n{'#'*70}")
    for r in results:
        print(f"  {r['label']:34s} -> {'PASS' if r['pass'] else 'FAIL'} "
              f"(cards={r['cards']}, challenge={r['challenge']})")

    vanilla_pass = any(r['pass'] for r in results if 'vanilla' in r['label'])
    patch_pass = any(r['pass'] for r in results if 'patchright' in r['label'])
    print(f"\nREAD:")
    if patch_pass and not vanilla_pass:
        print("  → FINGERPRINT was the block. patchright drop-in = FREE fix. Proceed.")
    elif patch_pass and vanilla_pass:
        print("  → Both passed — block may be intermittent / IP-reputation based today.")
    else:
        print("  → patchright did NOT pass from this datacenter IP. Likely IP reputation.")
        print("    Free cloud fix won't cut it → residential IP (laptop) or paid proxy.")
    sys.exit(0)


if __name__ == "__main__":
    main()
