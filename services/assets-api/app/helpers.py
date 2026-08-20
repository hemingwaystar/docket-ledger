"""Shared helpers for assets-api. The load-bearing one is event(): the
per-entity attributed feed writer — the dual-audit doctrine (build 22) says
every mutating endpoint writes BOTH an assets.asset_events row AND an
audit.events row app='assets', in the same transaction as the business write."""
from datetime import date
from fastapi import HTTPException

ATYPES = ('Laptop', 'Desktop', 'Server', 'Network', 'Firewall',
          'Mobile', 'Printer', 'Peripheral', 'Other')
STATUSES = ('inuse', 'stock', 'repair', 'retired')
CONTRACT_KINDS = ('support', 'warranty', 'retainer', 'other')


def ms(dt):
    return int(dt.timestamp() * 1000) if dt else None


def cap_text(s: str, cap: int = 4000) -> str:
    s = s or ""
    return s if len(s) <= cap else s[:cap] + f"… [+{len(s) - cap} more chars]"


def event(cur, kind: str, entity_id, who: dict, body: str):
    """One attributed feed row — author_id stays NULL for PATs (build 24)."""
    cur.execute("""INSERT INTO assets.asset_events (kind, entity_id, author, author_id, body)
                   VALUES (%s, %s, %s, %s, %s)""",
                (kind, str(entity_id),
                 who.get("name") or who.get("label") or "API",
                 who.get("agent_id"), cap_text(body)))


def sane_date(v, field: str):
    """ISO date or None; the era guard mirrors the table CHECKs (bug #27's
    year-1930 class) so bad input 422s instead of surfacing as a DB error."""
    if v in (None, ""):
        return None
    try:
        d = date.fromisoformat(str(v))
    except ValueError:
        raise HTTPException(422, f"{field} must be YYYY-MM-DD")
    if not (date(2000, 1, 2) <= d <= date(2099, 12, 31)):
        raise HTTPException(422, f"{field} must fall between 2000 and 2099")
    return d


def term_ok(n: int) -> int:
    if not isinstance(n, int) or not (1 <= n <= 120):
        raise HTTPException(422, "term_months must be a whole number from 1 to 120")
    return n


def cents_ok(n, field: str = "cost_cents"):
    if n is None:
        return None
    # ceiling keeps absurd input a 422, not an int4-overflow 500 at the INSERT
    if not isinstance(n, int) or n < 0 or n > 2_000_000_000:
        raise HTTPException(422, f"{field} must be a whole number of cents from 0 to 2000000000")
    return n


def client_or_422(cur, client_id: str, allow_none: bool = False):
    """Resolve + guard a client id: must exist and must not be the intake
    sentinel — inventory always belongs to a real client (or, for licenses,
    to nobody = MSP-wide when allow_none)."""
    if client_id in (None, ""):
        if allow_none:
            return None
        raise HTTPException(422, "A client is required")
    cur.execute("SELECT is_sentinel, name FROM shared.clients WHERE id::text = %s", (client_id,))
    row = cur.fetchone()
    if row is None:
        raise HTTPException(422, "Unknown client")
    if row[0]:
        raise HTTPException(422, "The intake sentinel client cannot own inventory")
    return client_id


def term_label(months: int, recurring: bool) -> str:
    base = ("Monthly" if months == 1
            else f"{months // 12}-yr" if months % 12 == 0
            else f"{months}-mo")
    return base + (" recurring" if recurring else "")
