#!/bin/sh
# Restore a nightly pg_dump -Fc backup onto a FRESH host — in the ONE order
# that works (audit). The naive path (restore first, then compose up) bricks
# the stack: the restored public.schema_migrations makes migrate.sh skip
# every migration, so the cluster ROLES the migrations create (desk_api,
# ledger_api, mail_worker, assets_api) never exist, migrate's ALTER ROLE
# loop dies under set -eu, and all four services wait forever on
# service_completed_successfully.
#
# Working order:
#   1. stack up EMPTY — migrate applies 0001..NNNN, creating roles + schema;
#   2. pg_restore --clean the dump over it. When the dump predates the
#      checkout (the NORMAL DR case) pg_restore exits 1 for benign reasons —
#      objects newer migrations created aren't in the dump's TOC, so its
#      DROP/CREATE SCHEMA statements error while every table restores fine.
#      That exit is TOLERATED; anything truly broken surfaces in step 3.
#   3. re-run migrate: the restored schema_migrations is the DUMP's, so the
#      migrations newer than the dump re-apply (all are idempotent) and the
#      tripwire checks validate the restored data;
#   4. services up.
#
# Remember (secrets/README.md): the KEK file is NOT in the dump — restore it
# from its separate backup or every sealed secret is unreadable by design.
#
# Usage: sh scripts/restore.sh /path/to/hemingway-YYYY-MM-DD.dump
set -eu
DUMP="${1:?usage: sh scripts/restore.sh <dump-file>}"
[ -f "$DUMP" ] || { echo "no such file: $DUMP" >&2; exit 1; }

# DR-only guard (audit 32g): restore.sh --clean-drops and OVERWRITES the target
# DB. It is documented for a FRESH host, but nothing enforced that — pointed at a
# live populated prod DB it would irreversibly destroy it. If a postgres is
# already up with an initialized schema, refuse unless the operator confirms.
# (A fresh host has no running postgres yet, so this probe simply finds nothing
# and the restore proceeds.)
ROWS="$(docker compose exec -T postgres sh -c \
  'PGPASSWORD=$(cat /run/secrets/pg_superuser_password) psql -tA -U postgres -d hemingway -c "SELECT count(*) FROM public.schema_migrations"' 2>/dev/null | tr -d '[:space:]')"
if [ -n "$ROWS" ] && [ "$ROWS" != "0" ] && [ "${RESTORE_CONFIRM:-}" != "1" ]; then
  echo "A running postgres with an initialized schema was found ($ROWS migrations applied)." >&2
  echo "restore.sh --clean-drops and OVERWRITES every table; it is meant for a FRESH host." >&2
  echo "To overwrite THIS database on purpose, re-run with RESTORE_CONFIRM=1." >&2
  exit 1
fi

echo "1/4  fresh stack up — migrations create schema + roles on the empty DB…"
docker compose up -d --wait postgres
docker compose run --rm migrate

echo "2/4  restoring $(basename "$DUMP") over the migrated schema…"
docker compose cp "$DUMP" postgres:/tmp/restore.dump
rc=0
docker compose exec -T postgres sh -c \
  'PGPASSWORD=$(cat /run/secrets/pg_superuser_password) pg_restore --clean --if-exists -U postgres -d hemingway /tmp/restore.dump' \
  || rc=$?
if [ "$rc" != "0" ]; then
  # do NOT swallow the code (audit 32g: `|| echo` hid a genuinely failed
  # restore). A non-zero here is EXPECTED when the dump predates the checkout
  # (schema-level DROP/CREATE noise) and the data restores regardless — but a
  # corrupt dump or wrong password ALSO surfaces here, so make it loud and
  # confirm tables restored before trusting step 3.
  echo "  ⚠ pg_restore exited $rc — review the output above. Benign when the dump" >&2
  echo "    predates the checkout (schema DROP/CREATE noise); NOT benign if the dump" >&2
  echo "    is corrupt or the password is wrong. Verify a table row count before step 3." >&2
fi
docker compose exec -T postgres rm -f /tmp/restore.dump

echo "3/4  re-running migrations newer than the dump (restored schema_migrations is the dump's)…"
docker compose run --rm migrate

echo "4/4  starting the services…"
docker compose up -d
echo "Done. Verify: docker compose ps · then sign in and check a ticket, a period, an asset."
