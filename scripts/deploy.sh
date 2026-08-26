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
# the anti-drift reset stays (its whole point — see header), but it REFUSES
# to silently destroy local edits (audit): show them and demand the flag.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has LOCAL CHANGES the deploy would reset:"
  git status --short
  if [ "${DEPLOY_FORCE:-}" != "1" ]; then
    echo "Refusing. Commit/stash them, or re-run with DEPLOY_FORCE=1 to discard."
    exit 1
  fi
  echo "DEPLOY_FORCE=1 — discarding local changes."
fi
git restore .
git pull
# build FIRST, then migrate, then swap containers (audit): migrating before
# the minutes-long build left OLD code serving the NEW schema for the whole
# build. Building first shrinks that window to the container swap.
sudo docker compose build desk-api ledger-api assets-api mail-worker
sudo docker compose run --rm migrate
sudo docker compose up -d desk-api ledger-api assets-api mail-worker
sudo docker compose ps
