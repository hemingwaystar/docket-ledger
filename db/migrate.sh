#!/bin/sh
# Applies db/migrations/*.sql in filename order, exactly once each.
# Then sets runtime role passwords from the mounted secret files.
set -eu
export PGPASSWORD="$(cat "$PGPASSFILE_SOURCE")"

psql -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

for f in /db/migrations/*.sql; do
  name="$(basename "$f")"
  done="$(psql -tA -c "SELECT 1 FROM public.schema_migrations WHERE filename='$name'")"
  if [ "$done" = "1" ]; then
    echo "skip  $name"
  else
    echo "apply $name"
    psql -v ON_ERROR_STOP=1 -q -f "$f"
    psql -v ON_ERROR_STOP=1 -q -c "INSERT INTO public.schema_migrations(filename) VALUES ('$name')"
  fi
done

# runtime role passwords come from files, never from SQL in the repo
for role in desk_api ledger_api mail_worker assets_api; do
  pw="$(cat /run/secrets/pg_${role}_password)"
  psql -v ON_ERROR_STOP=1 -q -c "ALTER ROLE ${role} WITH PASSWORD '$(printf %s "$pw" | sed "s/'/''/g")'"
done
echo "migrations complete"
