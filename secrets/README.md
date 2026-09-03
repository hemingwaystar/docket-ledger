# Secrets bootstrap

Create these six files before first `docker compose up` (never commit them —
this directory is gitignored except for this README):

    pg_superuser_password    Postgres superuser (compose + backups + migrations)
    pg_desk_api_password     runtime role: desk_api
    pg_ledger_api_password   runtime role: ledger_api
    pg_mail_worker_password  runtime role: mail_worker
    pg_assets_api_password   runtime role: assets_api
    kek                      32 random bytes, base64 — the key-encryption key

Generate them. The API containers run as non-root uid/gid **10001** and read
these files over the read-only bind mount, so each must be group-readable by
gid 10001 — a `chmod 600` root/owner-only file makes every service crash-loop
on the first `docker compose up`. (scripts/deploy.sh re-applies this on every
deploy; set it here so the very first bring-up works too.)

    for f in pg_superuser_password pg_desk_api_password pg_ledger_api_password pg_mail_worker_password pg_assets_api_password kek; do
      openssl rand -base64 32 | tr -d '\n' > "$f"
      sudo chgrp 10001 "$f" && chmod 640 "$f"
    done

## Why a file-mounted KEK

HANDOFF §10.15 requires app secrets (Entra OIDC, Graph, voip.ms, Twilio) to
live envelope-encrypted in the database with a write-only API — never in
compose or env. Self-hosted, there is no cloud KMS, so the key that unwraps
them must exist somewhere: this file is that floor. It is mounted read-only
into desk-api, ledger-api (for the Odoo secret) and mail-worker; assets-api
never sees it.

Rotating the KEK (the REAL procedure — no re-encrypt command exists; the
one this file used to name was never built, and following that fiction
would have left every sealed blob undecryptable):
  1. Have the PLAINTEXTS of every sealed secret at hand (Graph client
     secret, Entra OIDC secret, Odoo API key, voip.ms/Twilio if set) —
     they are write-only in the DB and cannot be exported.
  2. Replace ./secrets/kek with the new key file; restart the stack.
  3. Re-enter each secret through its write-only UI: Docket Settings for
     graph/entra_oidc/voipms/twilio, Ledger Settings for the Odoo key.
     Saving re-seals under the new KEK.
  4. TOTP seeds are ALSO KEK-sealed but live on shared.agents
     (totp_secret_enc), so they cannot be re-entered: clear enrollments
     (docs/STATE.md has the SQL) and have every agent re-enroll at next
     sign-in.
  5. Expect Graph mail + SSO to fail between steps 2 and 3 — do this in a
     maintenance window.
Back the KEK up SEPARATELY from database dumps — a dump without the
KEK cannot reveal the app secrets, which is the point.
