"""SENTINEL S3 — the self-labeling prediction ledger (the moat).

Two passes, both run by the nightly cron after the signal engine:

1. write_predictions_from_signals(): every vendor_signal with
   score >= PREDICTION_THRESHOLD gets ONE pending prediction per
   normalized address (no duplicates while one is still pending).
2. verify_predictions(): the scraper itself labels outcomes — a pending
   prediction whose address shows up as a NEW listing (sentinel-normalized
   match, listed after the prediction) becomes outcome='listed'; past its
   horizon it becomes 'not_listed'. No human labeling, ever.

Matching quality is critical (docs/sentinel-handoff.md: "la qualité de ce
matching est critique") — it uses signals/event_detector.normalize_address
(imported, NOT duplicated) and is ALWAYS scoped by suburb_id so identical
street addresses in different suburbs can never cross-label.

Never raises out of the public functions — the cron must survive.
"""
import json
import logging
from datetime import datetime, timedelta

from database import get_db
from signals.event_detector import normalize_address

logger = logging.getLogger(__name__)

PREDICTION_THRESHOLD = 0.5
DEFAULT_HORIZON_DAYS = 180


def write_predictions_from_signals():
    """Create pending predictions for strong signals. Returns summary."""
    summary = {'created': 0, 'already_pending': 0}
    conn = get_db()
    try:
        signals = conn.execute(
            "SELECT id, address, normalized_address, suburb_id, score, "
            "reason_codes FROM vendor_signals "
            "WHERE score >= ? AND status != 'dismissed'",
            (PREDICTION_THRESHOLD,)
        ).fetchall()
        for srow in signals:
            s = dict(srow)
            norm = s['normalized_address'] or normalize_address(s['address'])
            if not norm:
                continue
            pending = conn.execute(
                "SELECT 1 FROM predictions WHERE suburb_id = ? "
                "AND normalized_address = ? AND outcome = 'pending'",
                (s['suburb_id'], norm)
            ).fetchone()
            if pending:
                summary['already_pending'] += 1
                continue
            conn.execute(
                "INSERT INTO predictions (address, normalized_address, "
                "suburb_id, score_at_prediction, reason_codes, horizon_days) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (s['address'], norm, s['suburb_id'], s['score'],
                 s['reason_codes'], DEFAULT_HORIZON_DAYS)
            )
            summary['created'] += 1
        conn.commit()
        logger.info("prediction ledger: %(created)d new prediction(s), "
                    "%(already_pending)d already pending", summary)
        return summary
    except Exception:
        conn.rollback()
        logger.exception("write_predictions_from_signals failed")
        summary['error'] = True
        return summary
    finally:
        conn.close()


def verify_predictions():
    """Self-labeling pass. Returns {'listed': n, 'not_listed': n}."""
    summary = {'listed': 0, 'not_listed': 0, 'checked': 0}
    conn = get_db()
    try:
        now = datetime.utcnow()
        now_iso = now.isoformat()
        pending = [dict(r) for r in conn.execute(
            "SELECT id, normalized_address, suburb_id, predicted_at, "
            "horizon_days FROM predictions WHERE outcome = 'pending'"
        ).fetchall()]
        if not pending:
            return summary

        # one pass over current listings per involved suburb — no N×M query
        suburb_ids = sorted({p['suburb_id'] for p in pending})
        suburb_names = {dict(r)['id']: dict(r)['name'] for r in conn.execute(
            "SELECT id, name FROM suburbs").fetchall()}
        listings_by_suburb = {}
        for sid in suburb_ids:
            rows = conn.execute(
                "SELECT id, address, first_seen, listing_date "
                "FROM listings WHERE suburb_id = ? "
                "AND status IN ('active', 'under_offer', 'sold')", (sid,)
            ).fetchall()
            idx = {}
            for r in rows:
                d = dict(r)
                k = normalize_address(d['address'], suburb_names.get(sid))
                if k:
                    idx.setdefault(k, []).append(d)
            listings_by_suburb[sid] = idx

        for p in pending:
            summary['checked'] += 1
            matches = listings_by_suburb.get(p['suburb_id'], {}) \
                .get(p['normalized_address'], [])
            hit = None
            for m in matches:
                # listed AFTER the prediction — first_seen is the scrape
                # observation date (ISO); a match seen before the
                # prediction was already on market and must not count.
                seen = str(m.get('first_seen') or '')[:19]
                if seen and seen > str(p['predicted_at'])[:19]:
                    hit = m
                    break
            if hit:
                conn.execute(
                    "UPDATE predictions SET outcome = 'listed', "
                    "outcome_verified_at = ?, listed_listing_id = ? "
                    "WHERE id = ?", (now_iso, hit['id'], p['id'])
                )
                summary['listed'] += 1
                continue
            horizon = int(p.get('horizon_days') or DEFAULT_HORIZON_DAYS)
            deadline = None
            try:
                deadline = (datetime.strptime(str(p['predicted_at'])[:10],
                                              '%Y-%m-%d')
                            + timedelta(days=horizon))
            except Exception:
                pass
            if deadline and now > deadline:
                conn.execute(
                    "UPDATE predictions SET outcome = 'not_listed', "
                    "outcome_verified_at = ? WHERE id = ?", (now_iso, p['id'])
                )
                summary['not_listed'] += 1

        conn.commit()
        logger.info("prediction verify: %(checked)d checked, "
                    "%(listed)d listed, %(not_listed)d expired", summary)
        return summary
    except Exception:
        conn.rollback()
        logger.exception("verify_predictions failed")
        summary['error'] = True
        return summary
    finally:
        conn.close()


def precision_stats(allowed_suburb_ids=None):
    """Aggregates for GET /api/precision — per month: predictions made,
    confirmed listed, expired, hit rate. allowed_suburb_ids=None → all."""
    conn = get_db()
    try:
        where, params = [], []
        if allowed_suburb_ids is not None:
            if not allowed_suburb_ids:
                return {'months': [], 'totals': {}}
            ph = ','.join(['?'] * len(allowed_suburb_ids))
            where.append(f"suburb_id IN ({ph})")
            params.extend(allowed_suburb_ids)
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        rows = [dict(r) for r in conn.execute(
            "SELECT SUBSTR(predicted_at, 1, 7) AS month, outcome, "
            "COUNT(*) AS n FROM predictions" + clause +
            " GROUP BY SUBSTR(predicted_at, 1, 7), outcome "
            "ORDER BY month", params
        ).fetchall()]
        months = {}
        for r in rows:
            m = months.setdefault(r['month'], {'month': r['month'],
                                               'pending': 0, 'listed': 0,
                                               'not_listed': 0})
            m[r['outcome']] = r['n']
        out = []
        for m in months.values():
            resolved = m['listed'] + m['not_listed']
            m['hit_rate'] = round(m['listed'] / resolved, 3) if resolved else None
            out.append(m)
        totals = {
            'predictions': sum(m['pending'] + m['listed'] + m['not_listed']
                               for m in out),
            'listed': sum(m['listed'] for m in out),
            'not_listed': sum(m['not_listed'] for m in out),
            'pending': sum(m['pending'] for m in out),
        }
        resolved = totals['listed'] + totals['not_listed']
        totals['hit_rate'] = (round(totals['listed'] / resolved, 3)
                              if resolved else None)
        return {'months': out, 'totals': totals}
    finally:
        conn.close()
