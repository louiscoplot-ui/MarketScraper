"""Perth time helpers — Australia/Perth is UTC+8 with no DST so a
fixed offset is both correct and dependency-free (no pytz / zoneinfo
needed). Use these anywhere you'd reach for datetime.utcnow() or
datetime.now() to compute "now in Perth" — e.g. cron cutoffs,
relative date math ("N days ago"), end-user-visible timestamps.

LEAVE datetime.utcnow() in place when the value is an absolute
timestamp compared against a DB column also written in UTC (e.g. OSM
cache TTL math, contacted_at audit). Mixing perth_now with UTC-stored
values introduces an 8h drift bug.
"""

from datetime import datetime, timedelta

_PERTH_OFFSET = timedelta(hours=8)


def perth_now():
    return datetime.utcnow() + _PERTH_OFFSET


def perth_today():
    return perth_now().date()
