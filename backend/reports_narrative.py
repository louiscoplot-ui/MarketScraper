"""Reports narrative — the AI "so what / now what" layer on top of the
calculated metrics (reports_engine.py).

One guarded Claude call per report, via the SAME raw-HTTP helper the
Sentinel morning brief uses (signals/brief_builder.py:generate_text —
`requests` only, no SDK, project rule: no new deps). The model is
claude-sonnet-4-6 (brief_builder's default, overridable via BRIEF_MODEL).
Key comes from the ANTHROPIC_API_KEY env var (must be added on Render
for prod narrative; without it every report still generates,
numbers-only).

Hard rules, mirrored from the Sentinel brief:
  * The model may ONLY comment on the numbers it is given. The system
    prompt forbids inventing figures, agent names, addresses or trends,
    and requires it to say when a metric is absent.
  * Any failure (missing key, HTTP error, timeout, refusal, unparseable
    output) returns {} — the docx layer then renders the report without
    narrative instead of failing the generation. Failures are logged.
"""

import json
import logging

from signals.brief_builder import generate_text

logger = logging.getLogger(__name__)

_SYSTEM = (
    "You write short interpretation paragraphs for a branded real-estate "
    "market report covering suburbs of Perth, Western Australia. You are "
    "given a JSON object of pre-calculated metrics — these numbers are "
    "the ONLY facts you may use. Absolute rules: never invent a number, "
    "an agent name, an address, an agency, or a trend that is not present "
    "in the data; when a metric is null or flagged as unavailable, say "
    "plainly that it is not available rather than estimating it; repeat "
    "any small-sample flags so the reader knows the confidence level. "
    "Audience: a real-estate agency principal. Tone: sober, factual, "
    "professional; Australian English and real-estate terminology; no "
    "exclamation marks, no hype, no advice on specific pricing. Each "
    "value should be 2-4 sentences: what the numbers say ('so what') and "
    "what is worth watching or acting on ('now what'), grounded strictly "
    "in the given data. Do not mention that you are an AI.\n"
    "Respond with ONLY a JSON object (no markdown fence, no prose around "
    "it) whose keys are exactly the block names requested in the user "
    "message and whose values are the paragraph strings."
)

# Blocks each report type asks the model to interpret. Keys must match
# what reports_docx.py looks up.
BLOCKS_BY_TYPE = {
    'suburb_intelligence': ['momentum', 'velocity', 'pricing', 'stock',
                            'competitive', 'flags'],
    'director_dashboard': ['house_view', 'heat_map', 'share_movement',
                           'opportunities'],
    'monthly_deep_dive': ['discount', 'price_bands', 'stale'],
    'vendor_benchmark': ['market_conditions', 'bands'],
}


def build_narratives(report_type, metrics):
    """Narrative paragraphs for one report: {block_name: text}. `metrics`
    is the engine output (list of per-suburb dicts). Returns {} on ANY
    failure — callers must render the numbers-only report in that case."""
    blocks = BLOCKS_BY_TYPE.get(report_type)
    if not blocks:
        return {}
    try:
        payload = json.dumps(metrics, default=str)
    except (TypeError, ValueError):
        logger.exception("reports_narrative: metrics not serialisable")
        return {}
    # Keep the prompt within a sane budget — the engine output is compact
    # (a few KB/suburb) but stale-flag lists could stack up on many
    # suburbs. Hard cap rather than trimming semantically.
    if len(payload) > 60_000:
        payload = payload[:60_000]

    user_content = (
        f"Report type: {report_type}.\n"
        f"Write one interpretation paragraph for each of these blocks: "
        f"{', '.join(blocks)}.\n"
        f"Calculated metrics (per suburb):\n{payload}"
    )
    text = generate_text(_SYSTEM, user_content, max_tokens=1500, timeout=45)
    if not text:
        logger.warning("reports_narrative: no narrative for %s (API "
                       "unavailable or refused) — shipping numbers-only",
                       report_type)
        return {}
    # Model was told to output bare JSON, but tolerate a stray fence.
    cleaned = text.strip()
    if cleaned.startswith('```'):
        cleaned = cleaned.strip('`')
        if cleaned.startswith('json'):
            cleaned = cleaned[4:]
    try:
        data = json.loads(cleaned)
    except (ValueError, TypeError):
        logger.warning("reports_narrative: unparseable narrative JSON for "
                       "%s — shipping numbers-only", report_type)
        return {}
    if not isinstance(data, dict):
        return {}
    # Only keep the requested blocks, as plain strings.
    return {k: str(v).strip() for k, v in data.items()
            if k in blocks and isinstance(v, str) and v.strip()}
