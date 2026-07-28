#!/bin/sh
# Creates a PAT for the APIs. Run from the repo root on the host.
# Usage: sh scripts/create-token.sh "reporting-script"
set -eu
LABEL="${1:-api-token}"
TOKEN="$(openssl rand -hex 32)"
HASH="$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)"
docker compose exec -T postgres psql -U postgres -d hemingway -q -c \
  "INSERT INTO shared.api_tokens (label, token_hash) VALUES ('$LABEL', '$HASH');
   INSERT INTO audit.events (app, action, detail) VALUES ('auth', 'API token created', 'label: $LABEL');"
echo "Token for \"$LABEL\" (shown once, hash stored):"
echo "  $TOKEN"
echo "Use it:  curl -H 'Authorization: Bearer $TOKEN' http://127.0.0.1:8081/api/tickets"
