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

echo "1/4  fresh stack up — migrations create schema + roles on the empty DB…"
docker compose up -d --wait postgres
docker compose run --rm migrate

echo "2/4  restoring $(basename "$DUMP") over the migrated schema…"
docker compose cp "$DUMP" postgres:/tmp/restore.dump
docker compose exec -T postgres sh -c \
  'PGPASSWORD=$(cat /run/secrets/pg_superuser_password) pg_restore --clean --if-exists -U postgres -d hemingway /tmp/restore.dump' \
  || echo "  pg_restore reported errors — EXPECTED when the dump predates the checkout (schema-level DROP/CREATE noise); data restores regardless. Review the output above."
docker compose exec -T postgres rm -f /tmp/restore.dump

echo "3/4  re-running migrations newer than the dump (restored schema_migrations is the dump's)…"
docker compose run --rm migrate

echo "4/4  starting the services…"
docker compose up -d
echo "Done. Verify: docker compose ps · then sign in and check a ticket, a period, an asset."
