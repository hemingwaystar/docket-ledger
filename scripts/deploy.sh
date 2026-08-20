#!/bin/sh
# One-command deploy (bug #10: every "repeated same error" round traced to a
# skipped step in the manual chain — push, pull, or rebuild). Run from
# anywhere on the VM; cd's to the repo root itself.
# After deploying, keep the split-brain habit (docs/STATE.md §6): check the
# marker string on disk AND as served, as two separate facts —
#   grep -c "Add person" services/desk-api/webui/js/desk/views/directory.js
#   curl -s http://$BIND_ADDR:8081/ui/js/desk/views/directory.js | grep -c "Add person"
set -eu
cd "$(dirname "$0")/.."
git restore .
git pull
sudo docker compose run --rm migrate
sudo docker compose up -d --build desk-api ledger-api assets-api mail-worker
sudo docker compose ps
