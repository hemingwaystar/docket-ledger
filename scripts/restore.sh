#!/bin/sh
# Restore a nightly pg_dump -Fc backup onto a FRESH host — in the ONE order
# that works (audit). The naive path (restore first, then compose up) bricks
# the stack: the restored public.schema_migrations makes migrate.sh skip
# every migration, so the cluster ROLES the migrations create (desk_api,
# ledger_api, mail_worker, assets_api) never exist, migrate's ALTER ROLE
# loop dies under set -eu, and all four services wait forever on
# service_completed_successfully.
#
# Working order: bring the stack up EMPTY first (migrate applies 0001..NNNN
# against the fresh database, creating the roles and schema), THEN lay the
# dump's data over it with pg_restore --clean. The restored
# schema_migrations is then consistent with what is actually applied.
#
# Remember (secrets/README.md): the KEK file is NOT in the dump — restore it
# from its separate backup or every sealed secret is unreadable by design.
#
# Usage: sh scripts/restore.sh /path/to/hemingway-YYYY-MM-DD.dump
set -eu
DUMP="${1:?usage: sh scripts/restore.sh <dump-file>}"
[ -f "$DUMP" ] || { echo "no such file: $DUMP" >&2; exit 1; }

echo "1/3  fresh stack up — migrations create schema + roles on the empty DB…"
docker compose up -d --wait postgres
docker compose run --rm migrate
echo "2/3  restoring $(basename "$DUMP") over the migrated schema…"
docker compose cp "$DUMP" postgres:/tmp/restore.dump
docker compose exec -T postgres sh -c \
  'PGPASSWORD=$(cat /run/secrets/pg_superuser_password) pg_restore --clean --if-exists -U postgres -d hemingway /tmp/restore.dump'
docker compose exec -T postgres rm -f /tmp/restore.dump
echo "3/3  starting the services…"
docker compose up -d
echo "Done. Verify: docker compose ps · then sign in and check a ticket, a period, an asset."
