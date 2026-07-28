# Secrets bootstrap

Create these five files before first `docker compose up` (never commit them —
this directory is gitignored except for this README):

    pg_superuser_password    Postgres superuser (compose + backups + migrations)
    pg_desk_api_password     runtime role: desk_api
    pg_ledger_api_password   runtime role: ledger_api
    pg_mail_worker_password  runtime role: mail_worker
    kek                      32 random bytes, base64 — the key-encryption key

Generate them:

    for f in pg_superuser_password pg_desk_api_password pg_ledger_api_password pg_mail_worker_password; do
      openssl rand -base64 32 | tr -d '\n' > "$f"; chmod 600 "$f"
    done
    openssl rand -base64 32 | tr -d '\n' > kek; chmod 600 kek

## Why a file-mounted KEK

HANDOFF §10.15 requires app secrets (Entra OIDC, Graph, voip.ms, Twilio) to
live envelope-encrypted in the database with a write-only API — never in
compose or env. Self-hosted, there is no cloud KMS, so the key that unwraps
them must exist somewhere: this file is that floor. It is mounted read-only
into desk-api and mail-worker only; ledger-api never sees it. Rotating the
KEK: generate a new file as `kek.new`, run the re-encrypt admin command
(re-wraps every shared.secrets row, stamps the new kek_id), swap the files,
restart. Back the KEK up SEPARATELY from database dumps — a dump without the
KEK cannot reveal the app secrets, which is the point.
