#!/bin/sh
# Creates a PAT for the APIs. Run from the repo root on the host.
# Usage: sh scripts/create-token.sh "reporting-script" [scope ...]
#   No scopes  → all-scope service token (legacy behavior).
#   With scopes → least-privilege: need() holds the token to exactly those
#                 permission keys (e.g. view_audit l_view_all a_view).
set -eu
LABEL="${1:-api-token}"
shift 2>/dev/null || true
SCOPES=""
for s in "$@"; do
  SCOPES="${SCOPES}${SCOPES:+,}\"$s\""
done
TOKEN="$(openssl rand -hex 32)"
HASH="$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)"
docker compose exec -T postgres psql -U postgres -d hemingway -q -c \
  "INSERT INTO shared.api_tokens (label, token_hash, scopes) VALUES ('$LABEL', '$HASH', '{$SCOPES}');
   INSERT INTO audit.events (app, action, detail) VALUES ('auth', 'API token created', 'label: $LABEL, scopes: {$SCOPES}');"
echo "Token for \"$LABEL\" (shown once, hash stored; scopes: ${SCOPES:-all}):"
echo "  $TOKEN"
echo "Use it:  curl -H 'Authorization: Bearer $TOKEN' http://127.0.0.1:8081/api/tickets"
