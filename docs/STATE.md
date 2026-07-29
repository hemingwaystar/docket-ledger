# Hemingway Suite — Production State & Handoff (v2)

**Date:** 2026-07-28 · **Author:** build session with Claude
**Supersedes nothing — companions `HANDOFF.md` (the frontend/prototype handoff).**
This document is the authoritative record of the production system: what was
built, what broke and why, what remains, and how to operate it. It lives in
git (`docs/STATE.md`) so it travels with the code.

---

## 1. Executive state

In one arc, the project went from clickable HTML prototypes to a **live,
authenticated, mail-ingesting helpdesk and billing suite** running on an AWS
Lightsail VM ("Docket-Ledger-Prod", `~/docket-ledger`, reached over NetBird):

* **Docket** (helpdesk): real email → tickets via Microsoft Graph; agents sign
  in, work the queue, add notes, log time, reply (staged), manage the
  directory, run projects — through both a functional shell UI and the
  full-fidelity prototype UI.
* **Ledger** (time & billing): every time entry priced by one SQL ladder;
  timesheet submit → manager approve/return → period lock → Odoo
  draft-invoice payload; functional shell UI and prototype UI.
* **Platform**: one PostgreSQL, four schemas, least-privilege DB roles,
  append-only audit, DB-enforced invariants, Docker Compose behind a
  loopback/overlay bind, secrets envelope-encrypted under a file-mounted KEK,
  DB-backed sessions with argon2id + TOTP, server-side RBAC, nightly local
  dumps.

**Confirmed working on the VM:** migrations 0001–0008 applied (0009–0012 in this
bundle: reclient entry-move fn + ticket_tags DELETE grant; client profile
jsonb; DML-grant audit — four grants the code always needed; article↔time
link + freeze-guard definer rights); login +
password change; ticket #100000 → then ingested tickets up past #100017;
notes with time flowing to Ledger; PAT + session auth; Graph ingestion live
(support@ → Service Desk); both shell UIs; Docket prototype UI live with the
automations page rendering real mailbox state.

**In the latest bundle, pending deploy/verification:** the `ms()` bootstrap
500 fix + hydration-failure armor; Ledger prototype UI (`:8082/ui/ledger.html`)
and the suite pane pointing at it; demo-vestige sweep (Graph card, secrets,
rules, titles, signatures); live clock fix (both prototypes ran on the pinned
demo `NOW`, so every "Updated" read *just now* and SLA countdowns were skewed
— now real-time when `LIVE_MODE`); **client/organization move wired end-to-end**
(props-panel Client picker + unrouted Move banner → `POST
/api/tickets/{id}/client`, migration 0009); **directory writes wired** —
client create/edit/archive and contact create/edit persist (new clients were
vanishing on the next hydrate; extended modal fields now round-trip via the
0010 `profile` jsonb; new `PATCH /api/contacts/{id}`); **every client picker
is now the searchable `combo()`** — Docket queue/report filters, ticket props,
unrouted banner, new-project modal, plus the component ported into Ledger for
its timesheet/approvals/reports filters and the entry modal; **the full Docket working
loop now mirrors** — props (state/priority/owner/group), title rename,
pending-wake timer, merge, and the ENTIRE project lifecycle (create w/
template tasks, task add/rename/remove/toggle, task + project billing,
submit/reopen/approve/unlock/relock — new `POST /api/projects/{id}/reopen`);
**Ledger's working loop mirrors too** — entry submit + NEW recall
(`POST /api/entries/{id}/recall`), span edits + voids (extended
`PATCH /api/entries/{id}`), and period export → `mark-exported`;
**ticket-side time is
persistent** — "+ time" on an existing note, inline span/type/task edits, and
chip removal all mirror (`POST /api/tickets/{id}/time`, `PATCH
/api/time/{entry_id}`; removal = void, and desk bootstrap now omits voided
entries to match "removed here, Ledger keeps the row"); entries carry
`article_id` (0012) so chips relink on every hydrate — including on
composer-attached time, which closes the "chips don't show on notes" gap;
**primary-contact
picker on the ticket** (props panel, under Client) — sets `contact_id` via
`PATCH /api/tickets/{id}` (`contact` accepts uuid/email, `""` clears), which
is the person caller-verification targets and the address the reply ladder
resolves to (explicit override → ticket contact → last inbound sender).

---

## 2. Architecture as built

```
 internet ──► (future: host nginx 443 + HSTS)          NetBird overlay
                                            └──► ${BIND_ADDR}:8081 desk-api ──┐
                                            └──► ${BIND_ADDR}:8082 ledger-api ┤ one PG
        docker "internal" network: postgres · migrate · mail-worker · db-backup┘
```

* **Schemas:** `shared` (directory, auth, config, secrets, sessions) ·
  `desk` (tickets, mail, projects, verification) · `ledger` (time, rates,
  periods, exports) · `audit` (append-only; UPDATE/DELETE granted to no one).
* **DB roles:** `desk_api`, `ledger_api`, `mail_worker` — least privilege;
  DELETE granted nowhere except `shared.sessions` (deliberate, documented
  exception: expired login sessions are ephemeral auth artifacts).
  Migration 0005 added `ALTER DEFAULT PRIVILEGES` per schema so future tables
  inherit correct grants automatically.
* **Invariants live in the DB**, not API convention: interval time with
  generated hours; integer cents; effective-dated rate tables; sentinel rows
  trigger-guarded; optimistic locking (`version` + touch trigger); timesheet
  freeze; approved-project freeze; one-way period state machine; period
  auto-assignment trigger (`ledger.ensure_period`, SECURITY DEFINER with
  pinned search_path); `ledger.priced()` as the single pricing ladder used by
  API, reports and export alike.
* **Secrets:** app credentials (Graph, future Entra/voip/Twilio) are sealed
  AES-256-GCM under the KEK file (`secrets/kek`), stored in `shared.secrets`
  behind a WRITE-ONLY API (metadata out, plaintext never). The five files in
  `secrets/` + `.env` are the only non-reproducible files besides pgdata.
* **Auth:** DB-backed sessions (`shared.sessions`, migration 0004), opaque
  cookie `hts_session` (HttpOnly, SameSite=lax, **secure=False until TLS —
  flip at go-live**), permissions snapshotted at sign-in per §10.2; local
  argon2id passwords; stdlib RFC-6238 TOTP with KEK-sealed secrets;
  admin-direct resets, never emailed; `python -m app.bootstrap` mints the
  first admin. PATs remain all-scope service credentials
  (`scripts/create-token.sh`). `auth.need()` enforces RBAC on every write.
* **Mail:** polling model (delta queries + cursor in
  `desk.graph_subscriptions.delta_link`; no webhooks, no inbound port).
  Ingestion: Message-ID idempotent; Auto-Submitted never changes state;
  `[#100123]` / In-Reply-To threading; reopen-on-followup except approved
  locked projects; routing ladder contact → domain (auto-contact) → sentinel
  + `unrouted` tag. Reply-out sends AS the group mailbox via base64-MIME
  `sendMail` (real In-Reply-To/References), gated by
  `app_config('mail').outbound_enabled` — **currently false**; replies are
  recorded and audited "RECORDED ONLY" until flipped.
* **UI strategy — two tiers, deliberately:**
  1. *Functional shells* (`/ui/index.html` on 8081, `/ui/index.html` on
     8082): small, fully wired, always-true fallbacks.
  2. *Prototype-parity* (`/ui/desk.html`, `/ui/ledger.html`,
     `/ui/suite.html` container): the actual prototype files with demo seed
     gated behind `window.LIVE_MODE`, hydrated by `/api/bootstrap` endpoints
     that emit state in the prototypes' native vocabulary, with mutations
     wrapped local-first-then-mirror. Unwired mutations are local-only and
     revert on hydrate (shrinking list — see §5).

---

## 3. Build chronology (this arc)

1. **Schema + platform** (0001/0002, compose, KEK, nginx example) → first
   live migration ran clean.
2. **API v1** (PAT auth, ticket/entry reads, create, article-with-time,
   utilization, periods; 0003 period trigger) → #100000 created via API.
3. **API v2** (routers; directory writes; PATCH w/ optimistic lock; tags;
   transactional merge; full project lifecycle w/ 423 lock; timesheet
   return/revoke; period approve; Odoo export; pending-wake scheduler live).
4. **Auth + first UI** (0004 sessions; argon2id/TOTP; RBAC wiring; bootstrap
   command; login + queue/ticket shell) → signed in, worked a ticket.
5. **Settings + Graph ingestion** (0007; config/secrets/mailboxes API;
   graph/test; full delta-poll ingestion) → real email became tickets.
6. **Reply-out** (0008 flag default-off; MIME sender; reply UI; meta;
   state/priority/owner controls).
7. **Ledger shell UI** (My time / Approvals / Periods; export preview).
8. **Prototype parity** (desk bootstrap + desk.html adapter; suite container;
   ledger bootstrap + ledger.html adapter; automations fixes; vestige sweep;
   hydration armor).

---

## 4. Live-debug ledger — every production bug, cause → fix → lesson

| # | Symptom | Root cause | Fix | Lesson |
|---|---|---|---|---|
| 1 | README quick-cmd exploded | `sed` self-extraction of a doc block | explicit commands | Never ship "clever" doc-executing one-liners |
| 2 | secrets not writable | dir root-owned (sudo extraction) | chown; later: git as admin, docker with sudo, never `sudo su` for repo work | Mixed-privilege file ops are the #1 hygiene trap |
| 3 | compose refused | YAML `key:{` missing space (my alignment) | space; validate YAML before shipping | Machine-validate every config artifact |
| 4 | readyz 500 | `SET x = %s` can't be parameterized in PG | `set_config()` | Utility statements don't take bind params |
| 5 | login 500 | 0004 table created after `ON ALL TABLES` grants ran | 0005 grants + DEFAULT PRIVILEGES | Grants are point-in-time; defaults make the class extinct |
| 6 | note+time 500 | trigger fn ran with caller's (desk_api) rights on periods | SECURITY DEFINER + pinned search_path (0006) | Cross-schema triggers need definer rights, not wider grants |
| 7 | `/ui/` 404 despite correct image | `root_path` breaks StaticFiles path resolution on direct access | drop root_path | root_path is proxy-only semantics; verify served vs on-disk |
| 8 | login "Method Not Allowed" | relative fetch URLs resolved under /ui/ → static mount | absolute `/auth/…` `/api/…` | Static-served SPAs: absolute API paths always |
| 9 | UI fixes not appearing | browser cache | no-cache headers on /ui | Cache headers are a launch requirement, not polish |
| 10 | repeated "same error" rounds | skipped step in manual deploy chain (push, pull, or rebuild) | `deploy.sh` (restore→pull→migrate→rebuild-all→ps); split-brain check habit: on-disk grep **and** served-curl grep | One-command deploys; always test disk vs served separately |
| 11 | secrets + .env vanished | git cleanup mishap during root-session recovery | full reset (cheap pre-data); rule: back up `secrets/` + `.env` off-instance | Know your non-reproducible file set; back it up before it matters |
| 12 | automations tab dead ×2 | demo ids (mailboxes, then RULES group refs) dangling after hydration | hydrate real mailboxes/roles; sanitize/clear demo data | Every hydrated view must be audited for demo-id lookups |
| 13 | all demo data "returned" | new bootstrap code used `ms()` before definition → 500 → **silent** fallback to baked-in constants | define-before-use; **armor**: loud alert + ⚠ title on sync failure; cosmetic overwrites in try/catch | Silent fallback to plausible-looking data is the worst failure mode — make failure unmissable |

| 14 | every ticket "Updated: just now"; SLA clocks skewed | prototypes keep a pinned demo clock (`NOW='2026-07-26'`); live timestamps sat in its future so all "ago" math went negative | `NOW = LIVE_MODE ? new Date() : pinned` in desk.html + ledger.html | Demo affordances must be LIVE_MODE-gated the moment real data arrives — audit constants, not just seed data |
| 15 | contact add: "Live sync failed: Not Found" | live-adapter wrap called /api/contacts; the router prefix is /api/directory | corrected both contact URLs | Mirror URLs come from the router prefix, not the entity name — grep the APIRouter(prefix=) before wiring |
| 16 | (latent, caught in review) tag removal would 500 | tags endpoint DELETEs from desk.ticket_tags but the grant was never made | 0009 grants DELETE on ticket_tags (2nd documented exception after sessions) | Grep every DML verb in the code against the grants list — least-privilege finds these in prod otherwise |
| 17 | org "Edit details" → "Live sync failed: unknown" | patch_client rewrites shared.client_domains via DELETE — never granted; a FULL code-vs-grants audit then found 3 more: agent_groups DELETE (agent group edits), project_tasks DELETE (checklist task removal), and mail_worker INSERT on shared.contacts (domain-match auto-contact would have failed on the first real unknown-sender email) | 0011 grants all four, each documented | Bug #16's lesson executed: audited every INSERT/UPDATE/DELETE in all 3 services against grants — the class is now provably empty |

| 19 | (latent, caught in review) any ticket-side time-entry edit would 500 | guard_entry_immutability reads billing_periods as the CALLING role; desk_api has no grants there — 0001's "edits (triggers gate)" UPDATE grant was never exercisable | 0012: guard becomes SECURITY DEFINER w/ pinned search_path (the 0006 treatment); desk endpoints convert guard refusals to 409s | Every cross-schema trigger gets the definer-rights question at creation — grep for the next one before it fires |

| 20 | timesheet edit refused "approved period" while the UI showed nothing approved | the DB was right — the Unassigned-intake 2026-07 period WAS approved during 7/28 API testing; the UI's period-lock registry was never seeded from bootstrap (gap #4), so approved periods rendered open — plus timesheet-flow guard raises surfaced as raw 500 "unknown" | mapIn seeds state.periods from bootstrap (w/ approvedAt/By, exportRef now emitted); guard raises → 409 with the real message in approve/return/revoke + entry PATCH | When the UI and DB disagree, hydrate the UI's belief — a correct refusal with an invisible cause reads as a bug |

Meta-lesson: every DB-layer failure was **least-privilege refusing an
unprovisioned path** — never corruption, never a broken invariant. The
segmentation model kept proving itself by saying "no" in exactly the right
places.

---

## 5. Punch list & known gaps (prioritized)

**Verify after next deploy (latest bundle):**
- [ ] desk.html hydrates real data again (bug #13 fix); Graph card shows real
      tenant/app-id/rotation; rules/triggers empty; titles/signatures live
- [ ] `:8082/ui/ledger.html` renders; suite split shows both prototypes
- [ ] Updated column shows real ages; SLA countdowns real (bug #14 fix)
- [ ] Org "Edit details" saves (domains rewrite — needs 0011); agent group
      edits save; project task removal works; auto-contact on inbound mail
      from a known client domain works
- [ ] New client persists across hydrate (create "Acme Corp" → refresh →
      still there, with industry/address fields intact); archive/restore
      sticks; contact add/edit sticks
- [ ] Client pickers everywhere are type-to-search combos (queue + report
      filters, ticket props, unrouted banner, project modal; Ledger filters
      + entry modal)
- [ ] Working loop: change state/priority/owner/group, rename, set a wake
      timer, merge two tickets → all survive refresh with sys/audit trails
- [ ] Projects: create from template → tasks appear; toggle/add/rename/remove
      tasks; set billing; submit → reopen → submit → approve → unlock →
      relock — each step survives refresh; approved = frozen everywhere
- [ ] Billing Periods page shows the truly-approved period as approved (with
      who/when); Docket drawer on an entry shows "note #xxxx" only when the
      entry rides on one; combos select-all on focus; ticket contact picker
      opens empty (no "— none —" prefill) when unset
- [ ] Ledger loop: select entries → submit → recall → edit a span →
      reclassify → void; approve timesheet → approve period → export marks
      exported with a server ref
- [ ] Time survives: "+ time" on an existing note → refresh → chip still on
      that note, entry in Ledger; inline span/type edits stick; × removes it
      here and Ledger shows a voided row; composer-attached time shows its
      chip after refresh
- [ ] Primary contact: picker under Client lists that client's people; change
      it → sys article, audit line, and the composer's reply-to follows;
      "— none —" clears; after a client move the picker offers the new
      client's contacts
- [ ] Client move: props-panel picker re-homes a ticket; unrouted Move claims
      the sender as a contact; open entries follow, approved/locked stay; sys
      article + audit line appear; `unrouted` tag drops

**Prototype-parity wiring queue:**
1. ~~Docket props panel, pending timers, merge~~ DONE
2. ~~Projects lifecycle in prototype UI~~ DONE (incl. new reopen endpoint)
3. Directory: clients + contacts DONE; remaining: agents/groups edits,
   Entra CSV contact import mirror, Docket settings pages (mailbox
   add/edit, config flags, canned responses — endpoints exist for
   mailboxes/config)
4. Ledger: entry submit/recall/void/span-edit + export DONE; period-lock
   display registry DONE (seeded from bootstrap); remaining: admin/settings pages (client cycle,
   rates & overrides, access rules, role perms, activity types — NO
   endpoints yet; these are feature builds, not wiring), Ledger
   demo-vestige sweep (Settings texts/secret cards)
5. Article↔time linkage DONE (0012); remaining: richer mail body rendering
   (HTML stripped to text); ticket links (purely navigational — no schema
   yet, resets on hydrate by design until a links table exists)

**User-owned ops (flagged, not yet done):**
- [ ] Lightsail snapshot at "fully configured, pre-real-traffic"
- [ ] Exchange application access policy (fence Graph to helpdesk mailboxes)
- [ ] Off-instance copy of `secrets/` + `.env`; ship `./backups/` dumps off-VM
- [ ] Commit `deploy.sh`; use it for every drop
- [ ] Manual pre-launch ticket archiving (Archived state, via UI or psql)
- [ ] Flip `mail.outbound_enabled` + live reply test when ready for prod

**Feature roadmap (build order):**
1. Remaining parity wiring (above) until the local-only list is empty
2. Server-side automations engine (rules/triggers execute; the UI builders
   already exist) + SLA escalation fan-out (notifications)
3. Entra OIDC as second sign-in path (config exists; `entra_oidc` secret slot
   exists)
4. Full backup process: dumps → S3 lifecycle, KEK custody separate from
   dumps, scripted + drilled restore runbook
5. nginx + certbot go-live: one domain, `/desk/` + `/ledger/`, HSTS; flip
   session cookie `secure=True` (marked in `sessions.py`); Swagger header
   tweak behind proxy
6. Later: Zammad history import migration; customer portal (schema
   affordances exist); attachments UI; verification (SMS/email) flows;
   retainers UI

---

## 6. Operational runbook

* **Deploy:** push from workstation → on VM `./deploy.sh` (or: `git restore .
  && git pull && sudo docker-compose run --rm migrate && sudo docker-compose
  up -d --build desk-api ledger-api mail-worker`). Migrations are append-only
  numbered files, applied exactly once (`public.schema_migrations`).
* **Access:** UIs bind `${BIND_ADDR}` from `.env` (VM's NetBird IP;
  loopback default; **never 0.0.0.0**). Login `:8081/ui/login.html`; suite
  `:8081/ui/suite.html`; Swagger `:8081/docs`, `:8082/docs`.
* **First-run bootstrap:** generate 5 secret files (loop in
  `secrets/README.md`) → `up -d --build` → `docker compose exec desk-api
  python -m app.bootstrap <email> "<name>"` → sign in → forced change.
  Groups/agents/clients via `/api/directory`; mailboxes + Graph via
  `/api/settings` (Entra walkthrough in README "Connecting mail").
* **Tokens:** `sh scripts/create-token.sh "<label>"` (plaintext once; treat
  any displayed/screenshotted token as burned — revoke by label via psql).
* **Config flags of note:** `mail.outbound_enabled` (replies transmit),
  `graph.connected` (ingestion runs), `auth.mfa` (optional|required),
  `retainers.enabled`.
* **Backups today:** nightly `pg_dump -Fc` → `./backups/`, 14-day retention;
  **local only** until the backup build. KEK must be backed up separately
  from dumps — a dump without the KEK reveals no secrets, by design.
* **Debug habit (from bug #10):** check the file **on disk** and the file
  **being served** as two separate facts; `docker compose logs --tail 20
  <svc>` before theorizing; hydration failures now announce themselves.

---

## 7. Conventions locked in

* Migrations: numbered, append-only, never edited after apply; grants ride
  DEFAULT PRIVILEGES; every new cross-schema trigger considers definer
  rights.
* No DELETE anywhere (sessions + ticket_tags excepted — both documented);
  void/archive-first.
* All money integer cents; all rates effective-dated; `ledger.priced()` is
  the only pricing authority.
* Secrets never in compose/env/git; write-only API; KEK is the floor.
* New features ship behind default-off flags when they touch customers
  (reply-out set the pattern).
* Client/company pickers are ALWAYS the searchable `combo()` component
  (both apps), never a bare `<select>` — current and future.
* UI: two tiers (shell + prototype-parity); prototype conversions hydrate
  via `/api/bootstrap` speaking the prototype's own shape; mutation wiring is
  local-first-then-mirror; hydration failure is always loud.
* Deploys are one command; "it didn't change" means a skipped chain step
  until proven otherwise.
