# Hemingway Suite — Backend

Docket (helpdesk) + Ledger (time & billing) over **one shared PostgreSQL**,
deployed with Docker Compose behind a **host nginx** that owns TLS + HSTS.
Everything below the proxy is loopback-only.

```
 internet ──► host nginx (443, HSTS) ──► 127.0.0.1:8081  desk-api
                                     ──► 127.0.0.1:8082  ledger-api
              docker network "internal":  postgres ◄── desk-api / ledger-api /
                                          mail-worker / migrate / db-backup
```

## Segmentation (the point of the layout)

| Layer | Boundary |
|---|---|
| Schemas | `shared` (directory/auth/config) · `desk` · `ledger` · `audit` (append-only) |
| DB roles | `desk_api`, `ledger_api`, `mail_worker` — least-privilege grants in `0001_init.sql`; **DELETE granted nowhere** |
| Services | one container each; only the two APIs publish ports, loopback-only |
| Secrets | app credentials envelope-encrypted in `shared.secrets`, unwrapped by the file-mounted KEK (`secrets/README.md`); ledger-api never mounts the KEK |
| Invariants | immutability, sentinels, state machines = **database triggers**, not API convention |

## First boot

```sh
cd secrets
for f in pg_superuser_password pg_desk_api_password pg_ledger_api_password pg_mail_worker_password kek; do
  openssl rand -base64 32 | tr -d '\n' > "$f"
  chmod 600 "$f"
done
cd .. && docker compose up -d --build
docker compose logs migrate      # expect "apply 0001..., apply 0002..., migrations complete"
curl http://127.0.0.1:8081/readyz && curl http://127.0.0.1:8082/readyz
```

Then install `nginx/hemingway.conf.example` on the host and reload nginx.

## Day-2 operations

* **Schema change** → new file `db/migrations/NNNN_description.sql`, then
  `docker compose run --rm migrate`. Never edit an applied migration; the
  runner records filenames in `public.schema_migrations`.
* **Update a service** → edit, `docker compose up -d --build <service>`.
  The DB contract is the migrations, so services roll independently.
* **Backups** → `db-backup` writes a nightly `pg_dump -Fc` into `./backups/`
  (14-day retention). Copy off-host; back the **KEK up separately** — a dump
  alone cannot reveal app secrets, by design. Restore test:
  `pg_restore -d hemingway_test backups/<file>.dump`.
* **Config** → everything operational lives in `shared.app_config` and is
  GUI-editable per HANDOFF §7 — compose stays static.

## API quickstart

```sh
sh scripts/create-token.sh "my-first-token"     # prints the token once
export T="<token>"
curl -H "Authorization: Bearer $T" http://127.0.0.1:8081/api/tickets
curl -H "Authorization: Bearer $T" http://127.0.0.1:8081/api/reports/queue
curl -H "Authorization: Bearer $T" http://127.0.0.1:8082/api/entries
curl -H "Authorization: Bearer $T" http://127.0.0.1:8082/api/reports/utilization
# create a ticket, add a note with time (task_id only for project tickets):
curl -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"title":"Printer down","client":"Unassigned intake","group":"<group name>"}' \
  http://127.0.0.1:8081/api/tickets
```

Interactive docs: http://127.0.0.1:8081/docs and :8082/docs (loopback-only).

## What's implemented vs next

Done: full schema + seeds encoding HANDOFF §10 items 1–24a (interval time,
effective-dated rates, cents, sentinels, append-only audit, optimistic
locking, timesheet + project state machines, per-task/project-flat billing,
`ledger.priced()` as the one pricing ladder), compose topology, migration
runner, backup sidecar, nginx example, service scaffolds with health checks
and per-transaction audit actor.

Implemented in the API layer (desk-api now split into routers —
tickets/directory/projects — for manageability):

* PAT auth (`scripts/create-token.sh`; hashed, last-used stamped, 401s as prototyped)
* desk-api: ticket reads (DocketAPI mirror) · create · article-with-time ·
  PATCH props with optimistic version lock · tags · transactional merge
  (locked-period entries stay, noted) · pending_until · full directory writes
  (groups, agents+roles, clients+routing domains, contacts) · complete project
  lifecycle (create from template, task CRUD, per-task/project-flat billing,
  submit → approve → queue entries for timesheet review, admin unlock/relock);
  approved-and-locked projects answer 423 everywhere
* ledger-api: priced entries · utilization · periods (incl. project flat fees) ·
  entry submit · timesheet approve/return-with-reason/revoke · period
  approve-and-lock (refuses on Unclassified) · Odoo export payload +
  mark-exported (draft-invoice payload recorded in ledger.odoo_exports)
* mail-worker: pending-wake scheduler is LIVE (reopens, sys article, audited);
  the routing ladder (contact → domain auto-contact → sentinel + unrouted) is
  implemented and waiting on Graph consent, which the worker checks each pass

Auth + first live UI (this drop): DB-backed sessions shared by both APIs
(migration 0004; role matrix snapshotted at sign-in), local argon2id
passwords with TOTP MFA (stdlib RFC 6238; secrets envelope-encrypted under
the KEK), temp-password must-change flow, admin-direct resets that are never
emailed, server-side RBAC (`auth.need`) on every write endpoint — PATs remain
all-scope service credentials — and a served web UI at
http://127.0.0.1:8081/ui/ : HTS login (MFA-aware) + a live Docket queue and
ticket view with a note-and-time composer hitting the real API.

Bootstrap the first login:
```sh
sudo docker-compose run --rm migrate                      # applies 0004
sudo docker-compose up -d --build desk-api ledger-api
sudo docker compose exec desk-api python -m app.bootstrap you@yourdomain.com "Your Name"
# open http://127.0.0.1:8081/ui/ (or via SSH tunnel), sign in, change the temp password
```
NOTE: the session cookie ships with secure=False so it works pre-TLS; flip it
in app/sessions.py when the nginx HTTPS front goes live.

Next: settings/secrets endpoints (Graph + Entra consent, verification config),
Graph ingestion itself (subscription renew + delta poll over the ladder),
Entra OIDC as the second sign-in path, SLA escalation fan-out, then converting
the remaining prototype views onto the live UI.
