#!/bin/sh
# Creates a PAT for the APIs. Run from the repo root on the host.
# Usage: sh scripts/create-token.sh <label> <owner-email> [--days N] <scope ...|ALL>
#   owner-email  the ACTIVE agent the token belongs to (0050): its actions are
#                attributed to them, a scoped token sees only what they may
#                see, and deactivating them kills the token.
#   --days N     lifetime, default 90, max 365 (0050: every token expires).
#   scopes       least-privilege: need() holds the token to exactly those
#                permission keys (e.g. view_audit l_view_all a_view).
#   ALL          an all-scope service token — bypasses per-user visibility.
#                Must be asked for explicitly; prefer scopes.
set -eu
LABEL="${1:-}"; OWNER="${2:-}"
[ -n "$LABEL" ] && [ -n "$OWNER" ] || {
  echo "usage: sh scripts/create-token.sh <label> <owner-email> [--days N] <scope ...|ALL>" >&2; exit 1; }
# label, owner and scopes ride into a SQL string — constrain the charset
# instead of trusting the caller (audit: the raw interpolation was injectable)
case "$LABEL" in (*[!A-Za-z0-9._-]*)
  echo "label must use only letters, digits, . _ -" >&2; exit 1;; esac
case "$OWNER" in (*[!A-Za-z0-9.@_+-]*|"")
  echo "owner-email has characters outside A-Z a-z 0-9 . @ _ + -" >&2; exit 1;; esac
shift 2
DAYS=90
if [ "${1:-}" = "--days" ]; then
  [ "$#" -ge 2 ] || { echo "--days needs a number" >&2; exit 1; }
  DAYS="$2"; shift 2
  case "$DAYS" in (""|*[!0-9]*) echo "--days must be a whole number" >&2; exit 1;; esac
  if [ "$DAYS" -lt 1 ] || [ "$DAYS" -gt 365 ]; then
    echo "--days must be between 1 and 365" >&2; exit 1; fi
fi
[ "$#" -gt 0 ] || { echo "name the scopes, or ALL for an all-scope token" >&2; exit 1; }
SCOPES=""
if [ "$1" = "ALL" ] && [ "$#" -eq 1 ]; then
  echo "WARNING: all-scope token — it bypasses per-user ticket visibility." >&2
else
  for s in "$@"; do
    case "$s" in (*[!a-z0-9_]*|"")
      echo "scope '$s' must use only lowercase letters, digits, _ (or pass ALL alone)" >&2; exit 1;; esac
    SCOPES="${SCOPES}${SCOPES:+,}\"$s\""
  done
fi
TOKEN="$(openssl rand -hex 32)"
HASH="$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)"
OUT="$(docker compose exec -T postgres psql -U postgres -d hemingway -qtA -v ON_ERROR_STOP=1 -c \
  "WITH o AS (SELECT id FROM shared.agents WHERE lower(email) = lower('$OWNER') AND active),
        t AS (INSERT INTO shared.api_tokens (label, token_hash, scopes, created_by, expires_at)
              SELECT '$LABEL', '$HASH', '{$SCOPES}', o.id, now() + interval '$DAYS days' FROM o
              RETURNING id, created_by)
   INSERT INTO audit.events (app, action, actor, detail)
   SELECT 'auth', 'API token created', 'agent:' || t.created_by,
          'label: $LABEL, owner: $OWNER, scopes: {${SCOPES:-ALL}}, expires in $DAYS days' FROM t
   RETURNING 'ok';")"
[ "$OUT" = "ok" ] || { echo "no ACTIVE agent with email $OWNER — token NOT created" >&2; exit 1; }
echo "Token for \"$LABEL\" (owner $OWNER; scopes: ${SCOPES:-ALL}; expires in $DAYS days)."
echo "Shown once — only its hash is stored:"
echo "  $TOKEN"
echo "Use it:  curl -H 'Authorization: Bearer $TOKEN' http://127.0.0.1:8081/api/tickets"
