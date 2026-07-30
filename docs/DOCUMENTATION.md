# Hemingway Suite — Complete Project Documentation
### Docket (helpdesk) + Ledger (time & billing) · replacing Zammad
**As of 2026-07-29 (build 4) · migrations 0001–0020 · bundle “hemingway-backend.zip”**

This is the full-picture document: what the system is, what has been built and
verified, what is in this bundle awaiting deployment, what remains, what comes
next, and how to operate all of it. Two companion documents stay authoritative
for their niches: **`docs/STATE.md`** (the living state doc — mirrored at the
bundle root as `HANDOFF-2-PRODUCTION.md`) carries the current punch list and
the complete 28-entry bug ledger verbatim; **`HANDOFF.md`** describes the
original frontend prototypes. When this file and STATE.md disagree, STATE.md
wins — it is updated every build round.

---

## 1. What this system is

Hemingway Tech Solutions is retiring Zammad and a browser timer in favor of a
purpose-built two-app suite sharing one PostgreSQL database:

* **Docket** — the helpdesk. Microsoft Graph turns real inbound email into
  tickets (delta polling, no inbound ports). Agents sign in (argon2id +
  optional TOTP), work the queue, write notes and replies, attach time to
  articles, manage clients/contacts/agents/groups/mailboxes/roles, and run
  fixed-fee or task-based projects with an approval/freeze lifecycle.
  Outbound replies are fully built but transmit only when
  `mail.outbound_enabled` is flipped (they are recorded and audited
  “RECORDED ONLY” until then).
* **Ledger** — time & billing. Every time entry is priced by **one** SQL
  function (`ledger.priced()`) used identically by the API, reports, and the
  Odoo export. Technicians submit timesheets; managers approve, return
  (with a reason the tech sees), or revoke; billing periods march one-way
  through open → approved → exported; exports produce an Odoo draft-invoice
  payload and a server reference. The admin layer (rates, overrides, access
  rules, activity types, client billing config) is live as of 0017–0018.
* **Platform** — one Postgres with four schemas and three least-privilege DB
  roles; append-only audit; business invariants enforced *in the database*
  (not API convention); Docker Compose bound to a NetBird overlay address;
  secrets envelope-encrypted (AES-256-GCM) under a file-mounted KEK with a
  write-only API; DB-backed sessions; server-side RBAC on every write;
  nightly local dumps.

**Production reality:** live since 2026-07-28 on the Lightsail VM
**Docket-Ledger-Prod** (`~/docket-ledger`), reachable over NetBird at
`${BIND_ADDR}` from `.env`. Real mail into `support@` has produced tickets
past #100017. The suite UI (`:8081/ui/suite.html`) hosts both prototype-parity
apps side by side.

---

## 2. Architecture

```
 internet ──► (future: host nginx :443 + HSTS, /desk/ + /ledger/)
                                         NetBird overlay
                                           ├──► ${BIND_ADDR}:8081  desk-api   ─┐
                                           └──► ${BIND_ADDR}:8082  ledger-api ─┤ one PostgreSQL
        docker internal network: postgres · migrate · mail-worker · db-backup ─┘
```

### 2.1 Schemas and roles
* `shared` — directory (clients, contacts, agents, groups), auth (roles,
  permissions, sessions), `app_config`, KEK-sealed `secrets`.
* `desk` — tickets, articles (now with `body_html`), mailboxes, Graph
  cursors, tags, canned responses, projects + tasks, automation rules
  (storage only — engine unbuilt), verification scaffolding.
* `ledger` — time entries, activity types + effective-dated
  `activity_type_rates` (rate **and**, since 0018, billable), per-client
  `client_rates` (typed and client-wide lanes since 0017), billing periods,
  `client_access`, retainers (schema only), the `priced()` function, the
  `project_flat_lines` view.
* `audit` — `audit.events`, append-only; UPDATE/DELETE granted to **no one**.

Roles `desk_api`, `ledger_api`, `mail_worker` hold least privilege. DELETE is
granted nowhere except documented exceptions (sessions 0005; ticket_tags 0009;
client_domains/agent_groups/project_tasks 0011 — all “replace-style” link
rewrites; role_permissions 0017). `ALTER DEFAULT PRIVILEGES` (0005) makes new
tables inherit correct grants. Cross-cutting writes are narrow: ledger_api may
UPDATE exactly two columns on `shared.clients` (billing_cycle,
billable_default — column-scoped grant, 0017).

### 2.2 Invariants that live in the database
Interval time with generated hours; integer cents everywhere; effective-dated
rates on every lane; sentinel rows trigger-guarded; optimistic locking
(version + touch triggers); the timesheet freeze guard and the
approved-project freeze (both SECURITY DEFINER with pinned search_path — bugs
#6/#19 taught why); the one-way period state machine; automatic period
assignment (`ledger.ensure_period`); and `ledger.priced()` as the single
pricing authority. The billing-history rule (§6.5) is likewise DB-resolved:
every pricing rung reads `valid_from <= the entry’s own date`.

### 2.3 Auth
DB-backed sessions (`shared.sessions`), opaque `hts_session` cookie
(HttpOnly, SameSite=lax, **secure=False until TLS go-live — marked in
sessions.py**). Passwords argon2id; TOTP (RFC-6238, stdlib) with KEK-sealed
secrets; admin-direct resets; `python -m app.bootstrap` mints the first
admin. PATs are all-scope service credentials (`scripts/create-token.sh`).
`auth.need()` enforces any-of RBAC on every write. **Permissions are
snapshotted into the session at sign-in** — role edits apply at each agent’s
next login (the role editor’s audit line says so).

### 2.4 Mail pipeline
Delta polling with cursors; Message-ID idempotency; Auto-Submitted mail never
changes ticket state; `[#100123]` and In-Reply-To threading; reopen-on-followup
except approved+locked projects; routing ladder: known contact → known client
domain (auto-creates the contact) → sentinel client + `unrouted` tag. Since
0016 the worker stores the **original HTML** body alongside a
paragraph-preserving plain-text version. Replies send *as the group mailbox*
via Graph sendMail with true In-Reply-To/References, behind the
`mail.outbound_enabled` flag (currently **false**).

### 2.5 The two-tier UI and the mirror architecture
1. **Functional shells** (`/ui/index.html` on both ports) — small, fully
   wired, always-true fallbacks.
2. **Prototype-parity apps** (`/ui/desk.html`, `/ui/ledger.html`,
   `/ui/suite.html`) — the *actual prototype files*, demo behavior gated
   behind `window.LIVE_MODE`, hydrated by `/api/bootstrap` endpoints that
   speak each prototype’s native vocabulary, with every mutation wrapped
   **local-first-then-mirror** by an adapter IIFE at the end of each file.

Adapter conventions (each one paid for by a numbered bug):
* **Mirror consent, not clicks** — every wrap diffs local state before
  POSTing; locally-refused actions never reach the server (#21).
* **Modal-deferred mutations are watched, not diffed** — period approval
  mirrors only after the confirm flips state; Cancel = no call (#21).
* **Translate identifiers at the boundary** — `srvPeriodKey()` maps the
  prototype’s `M2026-07`/`W2026-07-20` keys to the server’s
  `2026-07`/`2026-W30` (#22).
* **Feed every source of truth** — local rate/billable edits update both the
  current value *and* the today history row; saves soft-hydrate on success
  (#28).
* **Focus-preserving render** — `render()` captures the focused element
  (id/`data-fkey`) and caret, restores after the innerHTML rebuild, walks the
  caret to end where the caret API is missing, and scrolls to top only on
  view change (#26 and follow-ups).
* **Uniform input ergonomics** — click a value field → current value
  selects → typing replaces → Enter commits; combos select-all on open;
  hydration failures are always loud (#13).
* **Debounce high-frequency mirrors** (rates 600ms, settings 600ms, access
  500ms) so one settled value produces one PUT.

---

## 3. Migration catalog (0001–0020)

| # | Contents |
|---|---|
| 0001 | Full schema: four schemas, all tables/triggers/guards, `priced()`, grants |
| 0002 | Seed: states, priorities, roles/permissions, sentinel client + type, templates |
| 0003 | Period auto-assignment trigger |
| 0004 | Sessions table (auth) |
| 0005 | Grant repair + `ALTER DEFAULT PRIVILEGES` (bug #5) |
| 0006 | `ensure_period` → SECURITY DEFINER (bug #6) |
| 0007 | Settings/Graph scaffolding |
| 0008 | `mail.outbound_enabled` flag, default off |
| 0009 | `ledger.reclient_ticket_entries()` (client-move follows open time); ticket_tags DELETE |
| 0010 | `shared.clients.profile` jsonb (extended directory fields) |
| 0011 | Four DML-audit grants (client_domains/agent_groups/project_tasks DELETE; mail_worker contacts INSERT) |
| 0012 | `time_entries.article_id` (note↔time link); freeze guard → SECURITY DEFINER |
| 0013 | ledger_api SELECT on desk.articles (note-body content fallback) |
| 0014 | `canned_responses.active` (archive-first) |
| 0015 | Join-read grants: desk_api SELECT billing_periods; mail_worker SELECT desk.projects |
| 0016 | `articles.body_html`; ledger_api INSERT/UPDATE on app_config + secrets; KEK into ledger-api (compose) |
| 0017 | Admin layer: client_rates PK → partial unique indexes (bug #24 — client-wide lane storable); `ledger.client_access`; column-scoped clients UPDATE → ledger_api; role_permissions DELETE → desk_api |
| 0018 | `activity_type_rates.billable`; `priced()` replaced (verbatim 0001 body + as-of billable rung) — billing changes never re-price history |
| 0019 | **Automations engine**: rule table extensions (events/order/archive), event outbox, notifications, SLA-notice dedupe, SLA + business-hours config seeds; engine grants (incl. two latent gaps: mail_worker round_robin INSERT + ticket_tags SELECT); desk_api column-scoped `INSERT/UPDATE(name, active)` on activity_types |
| 0020 | Bug #29: normalize 0002's `"HH:MM"`-string business_hours in place (the "416d SLA" + worker-pass rollback); both consumers also parse any historical shape now |

Migrations are append-only, applied exactly once (`public.schema_migrations`),
run via the `migrate` compose service.

---

## 4. API inventory

**desk-api (:8081)** — `/auth/*` (login, TOTP, password change);
`/api/bootstrap` (prototype-shaped state incl. canned, vcfg, bodyHtml);
tickets: PATCH `/api/tickets/{id}` (props/title/contact/pending),
`/client` (move), `/merge`, `/time` + `PATCH /api/time/{id}`, tags, articles
(notes/replies), projects (create/tasks/billing/submit/approve/unlock/relock/
`/reopen`); directory: clients, contacts, agents, `PATCH /groups/{handle}`,
`POST /roles` + `PATCH /roles/{name}` (now incl. `rename` — custom roles
only), `POST /types` + `PATCH /types/{id}` (activity-type create / rename /
archive — names & lifecycle; billable/rates stay in Ledger); settings: config
GET/PUT (now incl. `sla`), secrets (write-only), mailboxes POST/PATCH, canned
POST/PATCH, `graph/test`; automations: `POST/PATCH /api/automations/rules`,
`POST /api/automations/rules/order`, `GET /api/automations/notifications` +
`/read`; OIDC: `GET /auth/oidc/login` → Entra → `GET /auth/oidc/callback`,
plus unauthenticated `GET /auth/methods` (which sign-in doors are open).

**ledger-api (:8082)** — `/api/bootstrap` (entries w/ histories, periods w/
approval meta, access, cfg, audit tail, odooSecret meta); entries:
`PATCH /api/entries/{id}` (classify/span/void), `/submit`, `/recall`;
timesheets: `/approve`, `/return`, `/revoke`; periods: `/approve`,
`/mark-exported`; export payload; admin (0017–0018): `PATCH /api/clients/{id}`
(cycle/billable_default), `PATCH /api/types/{id}`, `PUT /api/types/{id}/rate`,
`PUT /api/clients/{id}/rates`, `PUT /api/clients/{id}/access`;
`PUT /api/config/{key}` (ledger/odoo/retainers), `PUT /api/secrets/odoo`;
`POST /api/types` (create — service/API parity with Docket's Directory UI).

Swagger at `:8081/docs` and `:8082/docs` is the authoritative,
always-current list.

---

## 5. DONE — the feature inventory as it stands

**Docket, end to end:** email→ticket ingestion; the full working loop
(state/priority/owner/group, rename, pending-wake, transactional merge,
client/org move with open time following, primary-contact picker driving
reply-recipient and verification target); notes + replies with canned
responses; formatted inbound email (sandboxed, CSP-fenced iframe — scripts
and remote images blocked — with plain-text toggle; paragraphs survive in
text); ticket-side time (attach to note, inline edit, void) persistent and
chip-linked via `article_id`; the entire project lifecycle with
approved-freeze; directory management (clients + profile fields, contacts,
Entra CSV import, agent roles, groups with archive-pauses-mailboxes);
settings (mailboxes add/edit/pause, config flags, canned responses,
verification page persistence); the role editor (perms/note/Entra map,
next-sign-in semantics, **create + rename** — core roles keep their names);
activity-type lifecycle from the Directory tab (**create / rename /
archive-restore** — names here, billable + rates in Ledger; archived types
vanish from pickers in both apps while existing entries keep their name and
pricing).

**The automations engine (0019 — NEW, this build):** the Rules and Triggers
builders now drive a real evaluator in the mail-worker.
*Mail rules* run top-to-bottom on every inbound message (route to board, set
or floor priority, tag, notify the board) — later rules see earlier changes,
exactly like the prototype. *Ticket triggers* fire on
create / follow-up / state-change(-to) / priority / owner events from BOTH
sources — mail ingestion and API/UI mutations — through one outbox
(`desk.automation_events`, drained each worker pass with SKIP LOCKED).
Trigger actions: email the customer (template variables, the same outbound
resolution + `mail.outbound_enabled` gate as agent replies — **recorded-only
until launch**), internal note, tag, set state/priority, move board, and
auto-assign (true round-robin via `round_robin_cursors`, or least-loaded).
Guards: recursion (follow-on events carry depth, capped at 3) and mail loops
(email actions never answer auto-generated mail). Every fire writes the ⚙/⚡
sys article, bumps the rule's runs counter, and audits.
*SLA fan-out*: per-priority first-response/resolution targets and the
business-hours calendar are now server config (Settings edits persist);
the worker walks business hours (15-min steps, timezone-aware, holiday-aware)
and writes warn (≤2 h) and breach notices **once each** per clock into
`desk.notifications` — targeted at the ticket's board and its owner. The
bell hydrates from the server (60 s poll), click-through marks read, and the
old client-side escalation simulator is retired. Rule/trigger deletion is
archive-first, so runs history survives.

**Entra OIDC sign-in (build 3 — NEW, no migration needed):** the second auth
path, user-ordered ahead of nginx. Authorization-code flow as a confidential
client: `/auth/oidc/login` sends the browser to Entra with state + nonce in a
KEK-sealed cookie; `/auth/oidc/callback` exchanges the code using the
`entra_oidc` secret, validates aud/exp/nonce/tid on the back-channel token
(OIDC Core §3.1.3.7 — TLS server validation stands in for signature checks on
direct token-endpoint responses), matches the agent by Entra object id or
email (object id learned on first sign-in), optionally applies **Entra role
mapping** (`groups` claim vs `shared.roles.entra_group`; on multiple matches
the most-permissioned role wins; no match = role untouched), and mints the
IDENTICAL session local login mints (one factored `mint_session`). MFA for
SSO is Entra's job — local TOTP policy applies to passwords only. The login
page probes `/auth/methods`: a "Sign in with Microsoft" button appears when
SSO is on, the password form hides when local passwords are off (with a
lockout guard in Settings so you can never disable both), and callback
errors surface as readable messages. The whole Authentication settings card
(SSO toggle, tenant, client ID, redirect URI, role mapping, local
passwords + MFA policy) now persists to `app_config('auth')`; tenant and
client ID default to the Graph app registration — one Entra app for
ingestion, verification sends, and sign-in. **Entra constraint:** redirect
URIs must be HTTPS (`http://localhost` is the sole exception) — solved by the
nginx front below.

**nginx TLS front (build 4 — NEW):** ready-to-install config at
`nginx/helpdesk.hemingwaytechsolutions.com.conf` — one hostname, Docket at
the root path space (its fetch URLs are absolute by design, bug #8), Ledger
proxied under `/ledger/` with the prefix stripped. Both Ledger UIs and the
suite pane are now **proxy-aware**: they compute a base from their own URL
(one `$fetch` funnel each), so the same files work identically on the https
front and on direct NetBird ports. uvicorn honors `X-Forwarded-Proto` in
both APIs, so OIDC's derived redirect URI is correctly https behind the
proxy. The session-cookie `secure` flag is now **env-driven**
(`COOKIE_SECURE=true` in `.env` once the front is verified — no code edit at
go-live, no deploy-order lockout risk; after the flip, sign-in works only
over https, by design). DNS-01 issuance means no inbound port 80/443 is ever
required: point the DNS A record at the **NetBird IP** and the suite stays
overlay-only with a real public-CA certificate. Known cosmetic limit:
Ledger's Swagger behind the proxy fetches Docket's spec — use the NetBird
ports for Ledger's Swagger.

**Ledger, end to end:** live entry feed with note-content fallback; submit →
recall → span-edit → reclassify → void with all gates; timesheet
approve/return-with-reason/revoke (the kick-back message shows who and why);
period lock display truthful (registry seeded from bootstrap);
approve-period only on modal confirm; export → mark-exported with server
ref; **the admin layer**: client billing cycle + billable default,
activity-type billable + effective-dated base rates, per-client-type and
client-wide rate/billable overrides with reset-to-inherit (history kept),
client access rules; Ledger settings persisted (`ledger`/`odoo` config), the
Odoo API key KEK-sealed write-only with rotation meta; the Audit page showing
the real `audit.events` tail.

**Billing-history semantics (the 0018 guarantee):** any billing change —
rate, override, billable flag, per-client or global — applies to future time
only. Prior entries keep the pricing in effect when the work happened, in
the export *and* on screen (full history ships to the UI). First-ever type
rates anchor at epoch so existing entries price rather than zero. Every
change is audited with actor and before→after.

**Cross-cutting UX:** searchable combos for every client picker;
focus/caret/scroll-preserving renders; select-on-click + Enter-commits value
fields; span editors bounded and server-validated (`_sane_span`, 422);
empty open periods hidden; loud hydration failures.

**Pre-ship audit battery** (run on every bundle): grants audit (every
INSERT/UPDATE/DELETE **and** cross-schema FROM/JOIN in all three services vs
migrations, view- and function-aware, DEFAULT-PRIVILEGES-aware); dependency
audit (third-party imports vs each service’s requirements.txt); `node --check`
on every script block; `py_compile` on every Python file; fetch-URL vs
route-table cross-check.

---

## 6. Deploying THIS bundle + one-time cleanups

```bash
# workstation: push the bundle contents to GitHub as usual
# VM:
cd ~/docket-ledger
git restore . && git pull
sudo docker compose run --rm migrate            # applies through 0020
sudo docker compose up -d --build desk-api ledger-api mail-worker
sudo docker compose ps                          # all Up
```

One-time cleanups, if not already done:
1. **Void the July-1930 entry** in its Ledger drawer — the ghost sheet and
   period vanish everywhere (bug #27’s guards prevent recurrence).
2. **Reset the stale test period** approved during 7/28 API testing, if you
   want it open again:
   ```bash
   sudo docker compose exec postgres psql -U postgres hemingway -c \
   "UPDATE ledger.billing_periods SET status='open', approved_at=NULL, approved_by=NULL WHERE status<>'open';
    UPDATE ledger.time_entries SET ts_approved_at=NULL, ts_approved_by=NULL WHERE ts_approved_at IS NOT NULL;"
   ```
3. **Re-enter any rate that still shows the backwards value** (type once,
   Enter) — bug #28’s fix keeps display and server in step from now on.

4. **Rebuild all three services** (the command above already does) — the
   mail-worker gained modules and a pinned `tzdata`; a stale worker image
   would run the old loop with no engine (bug #25’s dependency audit ran
   clean on this bundle).
5. After the worker restarts, confirm its logs are clean — while bug #29 was
   live every pass rolled back, so any mail received in that window arrives
   in a burst on the first healthy pass (idempotent on Message-ID; expected).

**Enabling SSO (one-time, in Entra + Settings):**
1. In the existing Graph app registration: *Authentication → Add a
   platform → Web*, redirect URI `http://localhost:8081/auth/oidc/callback`
   (the pre-nginx test URI; add the real `https://…/auth/oidc/callback` at
   go-live — Entra refuses plain-http non-localhost URIs).
2. *Certificates & secrets* → new client secret → paste it into Docket →
   Settings → Authentication (the Entra secret slot; write-only as always).
3. Optional role mapping: *Token configuration → Add groups claim →
   Security groups* — the token then carries group OBJECT IDs; put each
   group's object id in the mapping field next to its role.
4. Settings → Authentication: tenant + client ID prefill from the Graph
   registration (override if you split apps), leave redirect URI blank to
   derive from the request, press **Connect**.
5. Test without nginx: `ssh -L 8081:<BIND_ADDR>:8081 <vm>` then browse
   `http://localhost:8081/ui/login.html` → "Sign in with Microsoft".

**nginx + certbot (DNS-01) go-live walkthrough:**
1. **DNS:** create an A record `helpdesk.hemingwaytechsolutions.com` →
   the VM's **NetBird IP** (the `BIND_ADDR` from `.env`). The name resolves
   publicly but only NetBird peers can reach it — the suite stays
   overlay-only with a real certificate, and DNS-01 never needs inbound
   80/443. (Alternative: point it at the Lightsail public IP and open
   TCP 80+443 in the Lightsail firewall if you ever want it public.)
2. **Certificate (manual DNS-01):**
   ```bash
   sudo apt-get update && sudo apt-get install -y certbot nginx
   sudo certbot certonly --manual --preferred-challenges dns \
        -d helpdesk.hemingwaytechsolutions.com
   ```
   Certbot prints a value for a TXT record at
   `_acme-challenge.helpdesk.hemingwaytechsolutions.com` — create it at your
   DNS provider, confirm propagation from another shell
   (`dig +short TXT _acme-challenge.helpdesk.hemingwaytechsolutions.com`),
   then press Enter. **Renewal caveat:** `--manual` without an auth hook
   cannot auto-renew — set a ~75-day reminder to rerun it (new TXT value
   each time), or switch to your DNS provider's certbot plugin
   (e.g. `python3-certbot-dns-cloudflare`) for hands-free renewal, adding
   `--deploy-hook 'systemctl reload nginx'`.
3. **Install the config:**
   ```bash
   sudo cp ~/docket-ledger/nginx/helpdesk.hemingwaytechsolutions.com.conf \
        /etc/nginx/sites-available/
   sudo sed -i "s/__BIND_ADDR__/$(grep ^BIND_ADDR ~/docket-ledger/.env | cut -d= -f2)/" \
        /etc/nginx/sites-available/helpdesk.hemingwaytechsolutions.com.conf
   sudo ln -s ../sites-available/helpdesk.hemingwaytechsolutions.com.conf \
        /etc/nginx/sites-enabled/
   sudo rm -f /etc/nginx/sites-enabled/default
   sudo nginx -t && sudo systemctl reload nginx
   ```
4. **Verify over https** (STATE.md §5 has the walk): login, suite with BOTH
   panes live, Ledger working inside `/ledger/`, working loop + timesheet
   round-trips.
5. **Flip the cookie:** add `COOKIE_SECURE=true` to `~/docket-ledger/.env`,
   then `sudo docker compose up -d desk-api`. From here sign-in works only
   on the https front (NetBird direct ports remain for Swagger and
   break-glass reads).
6. **Finish SSO:** in the Entra app registration, add redirect URI
   `https://helpdesk.hemingwaytechsolutions.com/auth/oidc/callback`, then
   run the OIDC walk on the real domain.

Then run the **verification walks in STATE.md §5** — they cover the
directory round-trip, the Docket working loop, project lifecycle, time
survival, the full Ledger loop (including the bug-#22 Return walk),
the admin layer, billing-history behavior, formatted email, settings
persistence, and the input-feel checks. Each walk names its expected outcome.

---

## 7. NOT done — the honest inventory

**Feature builds not yet started:**
* **Full backup process** — dumps → S3 lifecycle, KEK custody separate from
  dumps, scripted and *drilled* restore runbook. Today: nightly local
  `pg_dump -Fc`, 14-day retention, **local only**.
* **nginx/TLS go-live steps** — the config and proxy-aware apps shipped in
  build 4; what remains is yours: DNS record, certbot DNS-01 issuance,
  install + reload, `COOKIE_SECURE=true`, and the https redirect URI in
  Entra (walkthrough in §6).
* **Zammad history import; customer portal; attachments UI; verification
  (SMS/email) execution flows; retainers UI** (schema affordances exist for
  all of these).
* **Ticket links** — navigational only, no schema; resets on hydrate until a
  links table is built.

**Resolved this build (formerly “server-API-only”):** role rename and
role create are wired (Directory tab); activity-type create/rename/archive
is wired (Directory tab); Ledger’s role-permissions page is **permanently
dropped by decision** — RBAC lives in Docket’s Directory tab, full stop.

**User-owned operational items (flagged, still open):**
* Lightsail snapshot at “fully configured, pre-real-traffic”.
* Exchange **application access policy** fencing Graph to helpdesk mailboxes.
* Off-instance copies of `secrets/` + `.env`; ship `./backups/` dumps off-VM.
* Commit `deploy.sh` and use it for every drop.
* Pre-launch archiving of test tickets.
* Flip `mail.outbound_enabled` + one live reply test at launch.

---

## 8. WILL be done — recommended order

1. **Your verify pass** on this bundle (STATE.md §5 — automations + OIDC
   walks).
2. **Your ops list** (§7 above) — snapshot, access policy, off-instance
   secrets/dumps, deploy.sh.
3. **nginx/TLS go-live (your steps — build 4 shipped everything code-side):**
   DNS A record → certbot DNS-01 → install the config → verify →
   `COOKIE_SECURE=true` → https redirect URI in Entra → full SSO test.
4. **Backup process** build → restore drill (next build on my side) — in
   place BEFORE the go-live flips below, so real customer mail never runs
   uncovered.
5. **Go-live flips:** `mail.outbound_enabled` → live reply test → real
   traffic.
6. Post-launch tail: Zammad import → portal → attachments → verification
   flows → retainers → ticket links.

---

## 9. Operations quick reference

* **Deploy:** `./deploy.sh`, or the four-command chain in §6. “It didn’t
  change” means a skipped chain step until proven otherwise (bug #10).
* **Access:** login `:8081/ui/login.html` · suite `:8081/ui/suite.html` ·
  Swagger `:8081/docs`, `:8082/docs`. Everything binds `${BIND_ADDR}`
  (NetBird IP; never 0.0.0.0).
* **Logs first:** `sudo docker compose logs --tail 20 <svc>` — a dead pane
  is a crash-looping container until proven otherwise (bug #25).
* **Tokens:** `sh scripts/create-token.sh "<label>"`; displayed = burned.
* **Flags:** `mail.outbound_enabled`, `graph.connected`, `auth.mfa`,
  `retainers.enabled` — via Settings UI or `PUT /api/settings/config/{key}`.
* **Secrets:** write-only via the UIs/API; the KEK file + `secrets/` +
  `.env` are the only non-reproducible files besides pgdata — back them up
  separately from dumps (a dump without the KEK reveals nothing, by design).
* **Bug archaeology:** STATE.md §4 holds all 29 production bugs with root
  cause, fix, and lesson. The meta-lesson has held the whole way: every
  DB-layer failure was least-privilege refusing an unprovisioned path —
  never corruption, never a broken invariant.

---

## 10. Conventions for all future work

Numbered append-only migrations; grants ride DEFAULT PRIVILEGES; every
cross-schema trigger gets the definer-rights question at creation. No DELETE
(documented exceptions only) — void/archive-first. Integer cents;
effective-dated rates; `priced()` is the only pricing authority; billing
changes never re-price history. Secrets never in compose/env/git.
Customer-touching features ship default-off. Client pickers are always the
searchable combo. Prototype conversions hydrate via bootstrap in the
prototype’s vocabulary; mutations are local-first-then-mirror with
change-detection; hydration failures are loud. Any user-typed timestamp is
untrusted input. Deploys are one command. And when a person says a feature
is flatly broken: diff the actual bytes both sides exchange before defending
the server.
