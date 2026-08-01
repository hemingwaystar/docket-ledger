# Hemingway Suite — Production State & Handoff (v2)

**Date:** 2026-07-29 (build 2) · **Author:** build session with Claude
**Supersedes nothing — companions `HANDOFF.md` (the frontend/prototype handoff).**
This document is the authoritative record of the production system: what was
built, what broke and why, what remains, and how to operate it. It lives in
git (`docs/STATE.md`) so it travels with the code.

---

> Full narrative documentation — architecture, migration catalog, API
> inventory, done/not-done/roadmap, deploy + ops instructions — lives in
> **docs/DOCUMENTATION.md** (mirrored in the bundle as DOCUMENTATION.md).
> This file remains the living state doc: punch list + bug ledger win here.
>
> ✅ **SESSION WRAP 2026-07-30 — the mail arc is CLOSED.** Bug #33 (the
> arity slip that minted a ghost ticket every worker pass) is fixed,
> deployed, and confirmed: inbound ingests once per message and threads.
> Outbound is **proven and LIVE**: the `graph/test-send` pre-flight returned
> 202 + Message-ID for support@ (Mail.Send consented, access policy right),
> `mail.outbound_enabled` was flipped, and agent replies now transmit with
> `Service Ticket: [#id] Title` subjects. The go-live master switch lives in
> the GUI (Automations → Outbound routing) and genuinely mirrors.
>
> **UPDATE (7e+7f, same day evening): verify@ pre-flight PASSED — user
> confirmed verification emails send.** Build 7e shipped the
> filter-dropdown archive fix (ledger row 37, verify walk at the top of
> §5): archived groups/priorities/states/clients/activity-types no longer
> appear in any filter dropdown in either app unless the filter is
> currently set to one (then labeled "(archived)"). Build 7f fixed the
> mailbox Type select snapping back to Shared (ledger row 38, **migration
> 0024** — the field had no column, no mirror, and a bootstrap-fabricated
> constant all at once). Build 8 shipped TICKET LINKS (**migration 0025**,
> jumped the queue from the post-launch tail at the user's call): related
> links get their schema; parent/child hierarchy is strictly one level (a
> child can never be a parent — UI and API both say so); closing a parent
> prompts to cascade, and cascaded children file as the system state
> 'Closed: child ticket' so close-email triggers never fire per child.
>
> 🏗️ **BUILD 9 (2026-07-30, overnight): THE RESTRUCTURE.** The whole UI
> layer was rebuilt at the user's direction — prototype halves and live
> adapters are GONE. desk.html (5,597 lines) and ledger.html (3,092 lines)
> are now markup shells + css/ + js/ modules (18 desk files, 16 ledger);
> every control is ONE function that mutates local state and calls the API
> in the same body. The silent-controls + hydration-completeness sweep is
> thereby closed **as a category, by construction** — and performing the
> rework surfaced + fixed FIVE live defects the wrapper architecture had
> been hiding (ledger rows 39–43). Backend: tickets.py → app/tickets/
> package, ledger main.py → one module per concern (route tables verified
> identical); new wired-by-design endpoints for the states/priorities
> editors + a read-only PAT metadata card; ledger bootstrap now emits
> groups/roles/memberships (12 keys). deploy.sh EXISTS now. Full contract
> + fix list: **docs/REWORK-DESIGN.md**. Verification: every script through
> a real JS engine, every view rendered against empty state, all 44 .py
> compiled (real CPython via wasm), route tables diffed, endpoint parity
> 68/68, demo-grep zero hits across 50 files.
>
> ⚙️ **BUILD 10 (2026-07-31): five user asks, shipped.** (1) Bell "Mark all
> read" (server-scoped to YOUR visible rows; the ids path gained the same
> guard). (2) Queue tabs are OverviewDefs: admin-standardized in Settings →
> Queue tabs (`desk_ui` app_config, rides bootstrap), per-user
> reorder/hide/personal tabs via the queue's ⚙ (PUT /auth/me/prefs —
> account-scoped uprefs). The five shipped tabs are the default; parity is
> machine-verified. (3) Multi-select filter dropdowns across both apps'
> bars + the builder value pickers (engine comma any-of — semantics were
> already any-of; now documented; comma-labels honestly disabled).
> (4) Per-board outbound sender override — **MIGRATION 0026** + PATCH
> /api/settings/groups/{id}/sendas + both resolvers + a routing-card
> picker; one eligibility rule (outbound + unpaused) at every site.
> (5) Dashboard Queue-by-state show/hide (admin default + per-user ⚙).
> Verified same as build 9: browser-engine parse + empty-state renders,
> stock-install tabs-modal probe, multiCombo round-trip, 44/44 .py
> compile, endpoint parity, grants vs 0026. Design: docs/BUILD10-DESIGN.md.
> **The build-8 incident is CLOSED**: the malformed desk.ticket_links table
> (created by a truncated upload of the original 0025 — the GitHub web
> uploader, since retired) was dropped empty via console psql and the
> hardened 0025 applied clean; build 9 confirmed live by screenshots.
>
> 🎨 **BUILD 11 (2026-07-31): board filters at criteria parity, state
> decor, dashboard wrap.** (1) The queue filter bar gains state / tag /
> owner-scope multi-filters and the tab vocabulary gains **clients** —
> admin tabs, personal tabs and the bar all speak one OverviewDef
> vocabulary; the search box now rides the same qfApply seam as the CSV
> export (parity claim finally true), and ghost selections (renamed
> state, vanished tag) self-prune. (2) **MIGRATION 0027**: per-state
> `color` (palette token — the six st-* chip styles, pinned identically
> in css/state.js/settings.py) + `description`, editable on core AND
> custom states (labels stay protected; system states stay locked);
> swatch click-again resets to shipped default. (3) The Queue-by-state
> card wraps labels in a fixed grid track — every bar starts at the same
> x. Battery: browser probes (prune / clients-predicate / color-reset /
> palette), 44/44 .py compile, palette three-way equality.
> Design: docs/BUILD11-DESIGN.md.
>
> ⭐ **BUILD 12 (2026-07-31): priority colors, VIP contacts, periods page
> redesign.** (1) The state-decor swatches (pills + RGB square + ↺) land
> on the Priorities & SLA rows — **MIGRATION 0028** `priorities.color`
> (p1..p4 tokens or #rrggbb; one prioTagAttrs seam recolors the flag
> everywhere). (2) `contacts.vip` (0028 too): checkbox in the contact
> add/edit modals (an EXPLICIT boolean — unchecking clears it, row-38
> lesson), ★ VIP chips on the props-panel contact line + client contact
> rows + the contact picker, and a `vip` trigger condition ("yes"/"no",
> is / is not) wired through the builder AND the worker engine with one
> vocabulary. (3) Ledger's Billing Periods is now a searchable client
> list — current-period status + billable at a glance, rows expand to
> the full panel with the UNCHANGED approve/export/preview actions and a
> searchable period history; the sentinel intake bucket rides dimmed at
> the bottom only when it holds time. Battery green (browser probes:
> prio hex/token/reset flow, vip payload true/false, sentinel row,
> timezone-proof key round-trip; 44/44 .py). Design: BUILD12-DESIGN.md.
>
> **Still open, in order (details in §5):**
> 1. ~~USER: verify@ pre-flight~~ **DONE — confirmed 2026-07-30 evening.**
> 2. ~~USER: build-8 console surgery~~ **DONE 2026-07-31** — see the
>    build-10 banner above; ledger row 44 has the anatomy.
> 3. **USER: deploy build 10** — `git pull && ./deploy.sh` (0026 applies
>    before the rebuilt code starts — deploy.sh's order is load-bearing
>    on this drop). Then the §5 build-10 walks.
> 3b. **USER (previously): deploy build 9** — full image rebuild required (webui is
>    COPYed into images): `./deploy.sh` after pushing. Then run the §5
>    build-9 verify walks (top of the list).
> 4. **USER: served-UI staleness check** — markers moved in build 9: grep
>    "Add person" in `services/desk-api/webui/js/desk/views/directory.js`
>    (disk) and curl `/ui/js/desk/views/directory.js` (served). Most of
>    §5's walks are only meaningful on the current build.
> 5. **USER: identity cleanup** — create the `hemingway@` agent
>    (POST /api/directory/agents, role name exactly `Admin`) so OIDC
>    sign-in works; re-enroll MFA for `admin@` and flip `auth.mfa` back to
>    `"required"` (it sits at `"optional"` from the console lockout
>    recovery — see §6 runbook).
> 6. Then: **backups + restore drill**, then the post-launch tail
>    (Zammad import → portal → retainers; ticket links: DONE, build 8).
>
> Bug #33's full anatomy, the diagnostic transcript expectations, and the
> outbound pre-flight walk are preserved in §3 (chronology), §4 (ledger
> rows 33–36), and §5. Reading or editing the code itself? Start with
> **docs/CODE-GUIDE.md**.

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

**Confirmed working on the VM:** migrations 0001–0008 applied (0009–0018 in this
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
  `app_config('mail').outbound_enabled` — **flipped LIVE 2026-07-30** after
  the test-send pre-flight proved Mail.Send + access policy for support@;
  the GUI master switch (Automations → Outbound routing) now mirrors it.
  Outbound subjects carry the `Service Ticket: [#id] Title` prefix.
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
9. **Automations engine** (build 2, 0019): mail rules + ticket triggers
   execute in the worker off one event outbox; SLA warn/breach fan-out into
   a real notifications table + the bell; builders/SLA/business-hours fully
   wired; role create/rename + activity-type lifecycle from the Directory
   tab; Ledger role-permissions page dropped by decision.
10. **Entra OIDC** (build 3, no migration): second sign-in path — auth-code
    flow, KEK-sealed flow cookie, back-channel claim validation, agent match
    by oid/email, optional group→role mapping, one shared mint_session;
    login page gains the Microsoft button via /auth/methods; the whole
    Authentication settings card persists. Roadmap reordered by the user:
    OIDC → nginx → backups.
11. **nginx TLS front** (build 4): real config for
    helpdesk.hemingwaytechsolutions.com (Docket at /, Ledger stripped under
    /ledger/); Ledger UIs + suite pane made proxy-aware via their fetch
    funnels; uvicorn --proxy-headers both APIs; cookie secure flag now
    env-driven (COOKIE_SECURE); DNS-01 + NetBird-IP DNS keeps the suite
    overlay-only with a public-CA cert.
12. **Bugfix-33 + outbound lookover (2026-07-30 morning):** diagnosed and
    fixed the ghost-ticket storm (ledger row 33 — a one-character arity
    slip with three-symptom blast radius); `scripts/sql_arity_audit.py`
    joins the pre-ship battery; `apply_mail_rules` gets the bug-#29
    savepoint fence. Same session, a full outbound code walk: verified the
    send path sound end-to-end, fixed reply/trigger articles recording
    `mail_from` as NULL, added the 4 MB Graph-MIME guard (413 with the
    real reason), `list_mailboxes` now returns `outbound`, and shipped
    `POST /api/settings/graph/test-send` — the pre-flight that proves
    Mail.Send consent + access policy with one real send, no ticket, not
    gated on the master switch. Deployed live: inbound confirmed clean,
    test-send returned 202 + Message-ID for support@, and
    `mail.outbound_enabled` was flipped — **replies transmit for real**.
13. **Build 7 → 7d (2026-07-30 afternoon):** outbound subjects prefixed
    `Service Ticket: [#id] Title` (threading unaffected — the matcher
    searches anywhere); **OR condition groups** in mail rules AND triggers
    (conditions jsonb accepts list-of-lists: inner=AND, outer=OR; flat
    list = legacy single group; the builders save one group flat so
    existing rules re-save byte-identical; worker `_match()` normalizes;
    both builders rebuilt draft-based with "+ OR group"); the **master
    outbound switch entered the GUI** (Outbound routing card chip+toggle,
    confirm-on-enable, mirrors via `POST /api/settings/mail/outbound`,
    rolls back on refusal); verified tickets keep a **"Verify again"**
    button; silent-controls #5 (verification channel + thread-post
    toggles, ledger row 34) and #6 (group Delete button, row 35) found
    and fixed; the **served-UI staleness** diagnosis (an "Entra-synced"
    caption from no known bundle → disk-vs-served walk in §5); and the
    **archive-vanish hydration bug** (row 36) — bootstrap now emits ALL
    groups and ticket states with their `active` flag, so archived rows
    survive refresh. Console recoveries documented in §6: PAT mint, MFA
    lockout under the `required` policy, the VM's own-hostname DNS quirk.
14. **Build 7e (2026-07-30 evening): archived entries leave the FILTER
    dropdowns too.** verify@ pre-flight passed (user confirmed —
    verification emails send), then the user spotted archived groups
    listed unlabeled in the queue's "All groups" filter. The build-7d
    archive-aware sweep had covered value pickers but not filter bars.
    UI-only fix, both apps, one rule everywhere: archived
    groups/priorities/states/clients/activity-types leave every filter
    dropdown, EXCEPT the entry the filter is currently set to, which
    stays labeled "(archived)" so an active filter never lies. 15
    dropdowns touched: Docket queue filters (group/prio/client), Docket
    reports filters (group/client/prio/state), trigger-builder client
    condition lists (2), Ledger timesheet (type/client), approvals
    (client), client-page (type), reports (client/type). Bootstrap still
    emits archived rows (hydration-completeness, row 36) — the filtering
    is render-side only. Ledger row 37.
15. **Build 7f (2026-07-30 evening): the mailbox Type select saves.**
    User: flipping Shared → Licensed "just switches right back." Ledger
    row 38 — the partial-mirror sibling of the silent-control class:
    the Edit dialog's OTHER fields all mirrored (the wrapper PATCHes
    group/display_name/default_priority/outbound), which camouflaged the
    one field it dropped; beneath that, `desk.mailboxes` had no type
    column at all, and the bootstrap emission hard-coded
    `"type": "shared"` per row — so the post-save hydrate() was
    guaranteed to repaint Shared even if either other layer had been
    fixed alone. Fix at all three layers: migration 0024 adds
    `mailbox_type` ('shared'/'licensed', NOT NULL DEFAULT 'shared',
    CHECK), settings.py create/patch/list gain a `Literal`-validated
    `type` field (422 on junk; patch audits `type → licensed`),
    tickets.py bootstrap emits the real column, and the desk.html
    mirror wrapper reads `mbType` before the modal closes and sends it
    on both the PATCH and POST paths. Worker untouched (its mailbox
    queries name their columns). The type is operator-facing config —
    ingestion behavior is identical either way.
16. **Build 8 (2026-07-30 night): ticket links** — jumped the queue from
    the post-launch tail at the user's call. Migration 0025:
    `desk.ticket_links` (kind related/child, void-not-delete, partial
    uniques: one live parent per child, one live related row per pair)
    plus `ticket_states.is_system` and the seeded done-kind SYSTEM state
    **'Closed: child ticket'**. Design locked with the user: hierarchy is
    strictly ONE level — unlimited children per parent, but a child can
    NEVER itself be a parent, and both layers say so in the same sentence
    (UI toast + API 409). Closing a parent with open children prompts
    ("Close them too / Just this ticket / Cancel"); a confirmed cascade
    is one transaction (bug #33's lesson): parent → chosen resolved
    state, every open child → the system state, sys notes both sides,
    per-child audits, per-child 'state' events. THE POINT of the system
    state: close-email triggers match "state → Closed/Solved", so
    cascaded children never send close mail — the state IS the
    suppression, zero engine changes, and a trigger aimed at
    'Closed: child ticket' on purpose still fires. System states can't
    be hand-picked (patch 422s; manual pickers exclude them unless
    current). Parent bookkeeping in patch_ticket: last open child
    resolving posts "All child tickets are resolved … Ready to close?"
    on the parent; a child reopening under a closed parent posts a note
    too. Merge refuses tickets with live parent/child links (dangling
    stub guard). Bulk close never prompts — parents close alone.
    Bootstrap emits links/parentId/children on EVERY ticket (row 36's
    rule), related links render as bare #id when the other ticket is
    outside the hydrate window, and the mirror wraps
    doLink/unlink/doChild/unchild + the cascade from day one.
    **8b (same night):** first deploy failed at the migrate service
    (psql exit 3 — statement-level failure; exact ERROR line lives in
    `docker compose logs migrate`). Both new migrations rewritten
    transactional (BEGIN/COMMIT) and idempotent (IF NOT EXISTS +
    WHERE NOT EXISTS seed), and the related-pair index expressions
    got explicit parens — so a partial first apply can't strand state,
    a half-recorded apply re-runs clean, and "already exists" can never
    mask the original error again. NOTE HOUSE-WIDE: 0021/0023 are also
    multi-statement without BEGIN — same latent risk, grandfathered
    (applied clean everywhere); new multi-statement migrations wrap
    from now on.

17. **Build 9 (2026-07-30 overnight) — THE RESTRUCTURE.** At the user's
    direction ("all prototyping ripped out once and for all"), the entire
    UI layer was rebuilt: no prototype halves, no adapters, no demo data.
    desk.html 5,597 lines → a 100-line shell + css/desk.css + 18 js/desk
    files; ledger.html 3,092 lines → shell + css + 16 js/ledger files;
    login/index/suite split the same way. Every one of the old adapter's
    wrapped mutations (desk 78, ledger 21+2) became ONE function: local
    mutation, diff-guard, API call, oops-on-error — same optimistic feel,
    single code path. Backend: tickets.py (1,175 lines) → app/tickets/
    package of 7 routers + common.py; ledger main.py (965 lines) → 8
    modules with the static mount last; route tables machine-diffed
    identical. Wired-by-design additions: states + priorities editors
    (POST/PATCH /api/settings/states|priorities — the DDL always said
    "user-editable in Settings"; core/system rows refuse renames because
    the worker resolves them by label), read-only PAT card
    (GET /api/settings/tokens — metadata only, minting stays
    operator-side), agent hasPassword/mfa badges + pwReset/mfaReset via
    /auth/admin/*, priorities + state sids in desk bootstrap, ledger
    bootstrap grows groups/roles/tech-memberships (12 keys). Removed as
    lies: states/prios Delete buttons, fake API-token card, note-edit
    control (articles are immutable), signature/send-as editors (nothing
    server-side consumes them), Cc composer field (never persisted),
    client-side trigger/SLA execution (server-authoritative since 0019),
    biweekly cycle (server never had it). Five live defects found + fixed
    during the rework: ledger rows 39–43. deploy.sh finally exists
    (bug #10's one-command chain). Verification: browser JS engine parse
    (all 34 app files + 4 shells), every view rendered against empty
    state, endpoint parity desk 56/56 + ledger 17/17, all 44 .py compiled
    under real CPython (wasm), migrations byte-identical to 8b, zero
    demo-grep hits across 50 webui files. Contract + full fix list:
    docs/REWORK-DESIGN.md.

18. **Build 10 (2026-07-31) — five features + the incident autopsy.**
    Deploying build 9 first surfaced the build-8 incident's TRUE root
    cause (row 44: a truncated web-upload committed a malformed
    ticket_links table; DROP empty + re-migrate closed it) — and the
    web-upload path itself was retired: bundle→repo now goes through a
    real git client with sha256 verification ("Add files via upload"
    never again). Then the user's five asks: bell mark-all-read
    (visibility-scoped, both branches); admin-standardized +
    user-customizable queue tabs (OverviewDef vocabulary, desk_ui
    app_config + uprefs:<uuid> via PUT /auth/me/prefs, the shipped five
    tabs as the machine-verified-parity default); multi-select filter
    dropdowns everywhere incl. the builder value pickers (comma any-of —
    engine semantics were already any-of, now contractual; comma-labels
    disabled honestly); per-board outbound sender override (migration
    0026 desk.group_sendas, PATCH /api/settings/groups/{id}/sendas, both
    resolvers + bootstrap share one eligibility rule); dashboard
    Queue-by-state show/hide (admin default + per-user prefs). The two
    build workflows cross-verified each other's seams (the backend sweep
    caught four frontend blockers before the frontend's own verify ran);
    all fixed pre-push. Battery: browser parse + empty-state renders +
    stock-install modal probe + functional multiCombo round-trip, 44/44
    .py CPython compile, endpoint parity, 0026 grants audit. Design:
    docs/BUILD10-DESIGN.md.

19. **Build 11 (2026-07-31) — filter parity, state decor, dashboard
    wrap.** The queue filter bar reaches criteria parity with the tab
    config (state/tag/owner-scope multi-filters; one qfApply seam now
    also carries the search box, so table and CSV export finally agree
    to the row; qfNorm prunes ghost selections); OverviewDef gains
    `clients` across evaluator + admin card + personal tabs; migration
    0027 adds per-state color (six-token palette pinned identically in
    desk.css, state.js and settings.py — three-way equality is a battery
    check) and description, editable on core and custom states with
    click-again-to-reset and NULL-falls-through-to-shipped-decor
    semantics; the Queue-by-state card gets a wrap-friendly fixed grid.
    Verified with in-engine probes (prune, clients predicate, color
    reset, palette) + the standing battery. Design: BUILD11-DESIGN.md.

20. **Build 12 (2026-07-31) — priority colors, VIP, periods redesign.**
    Migration 0028 (`priorities.color` + `contacts.vip`). The decor
    pattern generalized: PRIO_PALETTE (p1..p4) + hex through one
    prioTagAttrs seam, swatches on the Priorities & SLA rows. VIP:
    explicit-boolean checkbox in the contact modals (unchecking clears —
    the row-38 seam done right), ★ chips at every contact render site,
    and a `vip` trigger condition with the vocabulary pinned in the
    builder AND the worker docstring. Ledger's Billing Periods became a
    searchable expandable client list; approve/export/preview relocated
    byte-equivalent (verified by diff); the sentinel intake bucket stays
    reachable (dimmed, only-when-holding-time) — a reachability
    regression the adversarial pass caught before ship. Process note:
    one workflow agent died mid-write (connection drop); the two
    verifiers precisely inventoried the missing half (priority swatch UI,
    entire VIP frontend) against the completed read-path, and the fixes
    were applied by hand from their findings — the
    cross-verification design carried a partial failure to a clean ship.
    Battery: browser probes + 44/44 .py + timezone-proof key round-trip.
    Design: BUILD12-DESIGN.md.

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

| 21 | "Return timesheet" alerted "Nothing to return" even though the click was a local no-op | the four ORIGINAL ledger wraps (classify/tsApprove/tsReturn/approvePeriod) predate the diff-guard pattern and mirrored unconditionally — a locally-refused click still hit the server, whose correct 409 then displayed as "Live sync failed" | diff-guards added to all four (now every wrap in both apps checks local state changed before mirroring); oops() reworded: 4xx detail shows as "Server declined: …", only detail-less failures say "Live sync failed" | A mirror must fire on state change, not on click — and a correct refusal labeled "failed" reads as broken plumbing |

| 21 | "Nothing to return on that sheet" 409 on Return; investigation found period-approve never mirrored + Revoke unwired | the 409 itself was truthful (same stale approved period as #20, invisible on the deployed build); auditing the flow exposed two real gaps: approvePeriod's wrap compared status synchronously but the flip happens in the confirm-modal callback → the mirror never fired (and would have fired on Cancel if unguarded); tsRevoke had no wrap at all | approvePeriod wrap watches for the post-confirm flip (60s window, silent give-up on dismiss); tsRevoke wrapped with change-detection; export mirror gated on approved→exported | Modal-deferred mutations can't be mirrored with synchronous diffs — watch for the state change, and mirror consent, not clicks |

| 22 | Return (and UI approve/revoke) NEVER worked — "Nothing to return" every time; two prior diagnoses blamed secondary state | the prototype prefixes period keys (M2026-07, W2026-07-20) but the server stores to_char formats (2026-07, 2026-W30) — every timesheets/* call matched zero rows by key; the "approved period" in the DB came from direct API calls, never the UI | srvPeriodKey() translates at the mirror boundary for approve/return/revoke; ledger bootstrap also falls back to the linked note's text for blank entry content (0013 grants ledger_api SELECT on desk.articles — caught pre-ship; the DML audit only covered write verbs, so cross-schema SELECT joins are now part of the audit) | When a user says a feature is flatly broken, diff the actual bytes both sides exchange before defending the server — identifier formats are part of the contract |

| 23 | (latent, caught by the extended audit) ticket merge with time, project approve with time, and inbound followups on project tickets would each 500 | three cross-schema SELECT joins never granted: desk_api reads billing_periods in merge's time-move and approve's timesheet-queue; mail_worker reads desk.projects for the locked-project followup exception | 0015 grants all three (read-only) | The audit now covers FROM/JOIN reads, not just write verbs — this row is that extension paying for itself |

| 24 | (latent since 0001, caught building the admin layer) client-WIDE rate overrides were unstorable | client_rates' PRIMARY KEY includes activity_type_id → forced NOT NULL, contradicting the documented "NULL = client-wide"; priced() and bootstrap read a branch that could never have rows | 0017 replaces the PK with two partial unique indexes (typed / wide), same-day collapse preserved | A PK is a NOT NULL in disguise — nullable-by-design columns can't live inside one |

| 25 | Ledger pane completely dead after the 0017 deploy — container crash-looping | crypto.py was copied from desk-api for the Odoo secret sealing, but ledger-api's image never installed `cryptography` → ModuleNotFoundError at import → uvicorn never started → :8082 served nothing | cryptography added to ledger requirements; a dependency audit (third-party imports vs each service's requirements.txt) joins the pre-ship checks | Copying a module across services copies its transitive dependencies too — every image's requirements must be re-verified, and a dead pane means check `docker compose logs` first |

| 26 | rate-override inputs (and, latently, every search box) ejected the cursor after one keystroke; each keystroke also scrolled to top | prototype-origin: oninput handlers end in a bare render() that rebuilds innerHTML — focus and caret die with the old DOM — and render() always scrollTo(0,0); the wiring worsened it by PUTting per keystroke | render() is now focus-preserving in BOTH apps (captures focused element id/data-fkey + caret, restores after rebuild; scroll-to-top only on view change); affected inputs carry data-fkey; rate mirrors debounced 600ms (client-wide override input discovered + wired to PUT rates in the process) | An innerHTML rebuild is a teleport — anything the user was holding (focus, caret, scroll) must be carried across explicitly |

**Billing-change semantics (0018, user-stated requirement):** a billing
change — rate, override, or billable flag, per-client or global — applies
to FUTURE time only; prior entries keep the pricing in effect when the work
happened. Rates already worked this way (every priced() rung resolves
valid_from <= entry date; overrides and resets are dated rows). 0018 closes
the one hole: type-level billable now rides effective-dated on
activity_type_rates, with the OLD value epoch-anchored on the first flip.
The UI now receives full rate/billable HISTORY so old entries also DISPLAY
their historical pricing, and a type's first-ever rate anchors at epoch
(no history = the rate existing entries should price at, not $0). Every
change audits (they always did) — and the Ledger Audit page now shows the
real audit.events tail instead of demo rows. Client cycle changes never
touched history: entries keep the period they were written into.

| 27 | Approvals grew a ghost "July 1930" timesheet with an unclassified entry — Ledger felt broken | a mistyped year in a span editor's datetime-local field sailed through with no bounds anywhere; the server accepted it, minted a 1930 billing period, and the sheet appeared | _sane_span() 422-guards every span write path (ledger classify, desk add/patch time: year >= 2020, <= now+400d); span inputs carry min/max; bootstrap hides empty OPEN periods, so voiding the garbage entry removes the ghost sheet AND the ghost period from every page | Any user-typed timestamp is untrusted input — bound it at the API, not just the widget |

| 28 | override field showed 150 but the entry priced $51 — looked like the caret bug returned | display staleness introduced by 0018's history emission: local edits updated the CURRENT value but not the history row, and the ladder consulted history first — so the $51 from the earlier backwards-typing write kept pricing until a re-hydrate (the prototype "fixed itself instantly" only because the demo had no history rows to go stale) | UI ladder now resolves overrides as-of via effRateN (null = inherit, before-first-row AND after-reset, matching priced()'s COALESCE exactly); local edits keep the today history row in step; saves hydrate softly once the PUT lands | When you add a second source of truth to a display path, every write path that fed the first must feed the second |
| 29 | Every ticket's SLA showed "in 416d"; worker logs "worker pass failed: could not convert string to float: '08:00'" every 30s — and each failing pass ROLLED BACK its ingested mail | 0002 seeded business_hours with "HH:MM" STRINGS; 0019's numeric seed lost to ON CONFLICT DO NOTHING; the UI's number-vs-string compare was always false → the 40,000-step walk guard capped out (40,000×15 min = 416d); worker's float() raised BEFORE commit, poisoning the whole pass | 0020 normalizes the row in place; both consumers now parse 8 / "8" / "08:00" / "18:30"; worker commits ingestion+wakes FIRST, engine passes fenced with their own commit/rollback | A config consumer is only as correct as every historical writer of that key — test against the SEEDED value, not the value you wish was there; and never let an optional subsystem sit between required work and its commit |

| 33 | One inbound email minted an identical NEW ticket every pass (#100023–100027), forever; dedup, threading, AND the delta cursor all appeared broken at once | the mail_in article INSERT listed 10 columns but 9 VALUES / 8 `%s` (is_auto's placeholder dropped in an edit); psycopg3 raises the mismatch CLIENT-SIDE, so the tx stayed ALIVE — the ticket INSERT before it committed while the article never did: no article ⇒ no dedup row, nothing to thread against, and the exception skipped the deltaLink save so the same message returned every pass | one-char fix (restore the `%s`); `scripts/sql_arity_audit.py` joins the pre-ship battery (AST-audits every literal execute() for placeholder-vs-params and INSERT column-vs-expression arity — found exactly this one across all 3 services); apply_mail_rules gets the bug-#29 savepoint fence found during the same review | A client-side driver error is NOT a SQL error — the transaction survives it, so everything executed before the bad statement can still commit; partial-commit ghosts are what "impossible" multi-symptom bugs look like. Arity is statically checkable: audit it, don't eyeball it |

| 34 | Email caller-verification always refused: "The EMAIL channel is disabled" even after clicking Enable; the chip showed Connected until a refresh flipped it back Off | silent-control class, FIFTH instance: the verification card's field edits (vcfgSet) mirrored via a debounced PUT, but the channel Enable/Disable buttons (vcfgToggle) and the thread-post toggle never did — the chip flipped locally while the server's verification.email.enabled stayed false, so /verify/start 409'd forever | both toggles wrapped with an IMMEDIATE full-VCFG PUT (no debounce — single-click state) and local rollback + honest toast on refusal; also: sender is verification@hemingwaytechsolutions.com and needs the Exchange access policy like support@ (prove via graph/test-send) | On a card where SOME controls mirror, the wired ones camouflage the dead ones — audit per CONTROL, not per card; and toggles must mirror immediately, debounce is for typing |
| 35 | Group "Delete" appeared to work, then the group returned on the next refresh | silent-control class, SIXTH instance — with a twist: no server endpoint SHOULD exist (no-delete convention; Archive is the removal), so the button could only ever lie: local splice + suite-bridge post, nothing persisted | the Delete button is REMOVED; Rename + Archive/Restore (both wired, audited) are the group lifecycle | When the convention says an operation must not exist, the UI must not offer it — a button with no legitimate mirror target is a lie by construction |
| 36 | Archiving a group made it vanish entirely — indistinguishable from a delete; same latent behavior for archived custom ticket states | the archive itself worked (server set active=false, paused its mailboxes, audited) — but bootstrap emitted groups WHERE active with no active field at all, so the post-archive re-hydrate rebuilt GROUPS without the archived row; the UI's archive rendering (dim + chip + Restore) existed and was simply never fed | bootstrap emits ALL groups and ALL ticket_states with their active flag; mapIn carries active onto hydrated custom states; consumer sweep confirmed pickers already filter (aGROUPS/aSTATES) and the deliberate unfiltered spots already label "(archived)" | Hydration must be COMPLETE for every state the UI can render, not just the happy subset — a filtered bootstrap starves correct UI into looking broken; sweep collections-vs-emissions like controls-vs-mirrors |
| 37 | Archived groups (Security, Test) listed unlabeled in the queue's "All groups" filter — as if never archived | the build-7d archive sweep covered VALUE pickers (aGROUPS/aSTATES/aPRIOS/aATYPES + labeled current-value exceptions) but the FILTER bars were a third consumer category nobody enumerated: Docket queue + reports filters and every Ledger filter iterated the raw collections | build 7e: all 15 filter dropdowns across both apps filter archived/inactive entries, keeping only the entry the filter is CURRENTLY set to, labeled "(archived)" — so hiding never silently breaks an applied filter; trigger-builder client condition lists go active-only (stored values still display via the not-in-list fallback); bootstrap untouched | "Every picker" means every CONSUMER of the collection — enumerate render sites by grepping the collection name, not by remembering the picker kinds; the archived-visibility rule is: management surfaces show all, choosers offer active, current values never vanish |
| 38 | Mailbox Type select wouldn’t hold — Shared → Licensed flipped locally, then snapped back to Shared | partial-mirror gap, the camouflage variant of the silent-control class: the Edit dialog’s mirror wrapper PATCHed every field EXCEPT type, so the card looked fully wired; beneath it no `mailbox_type` column existed, and bootstrap hard-coded `"type": "shared"` onto every emitted row — three independent layers each sufficient to cause the revert | migration 0024 (`mailbox_type` text NOT NULL DEFAULT ‘shared’ CHECK shared/licensed); settings.py create/patch/list carry a Literal-validated `type` (patch audits `type → …`); bootstrap emits the real column; the mirror reads mbType pre-close and sends it on PATCH and POST | A mostly-mirrored form hides its dropped fields better than a dead card hides dead buttons — diff the PAYLOAD against the modal’s field list, not the card against silence; and a bootstrap that fabricates a constant for a missing column plants the revert in advance: emit real columns or nothing |

| 39 | (found by the build-9 rework, live since gap #4 "closed") Server-approved billing periods rendered **Open** in Ledger's Billing Periods page; their entries looked editable; the Odoo export list stayed empty | the period-lock registry was seeded from bootstrap under SERVER period keys (`2026-07`) but every reader looked up UI-prefixed keys (`M2026-07`) — the registry was populated and 100% unreachable; the gap-#4 fix had shipped a seeding nobody could read | build 9: the registry is canonicalized on UI keys — `uiPeriodKey()` translates server keys ONCE in mapIn; the two Periods-page server calls translate back via `srvPeriodKey()` at the fetch boundary (verified by browser round-trip tests incl. ISO week-1/week-53 edges) | A fix that writes data nobody reads is indistinguishable from no fix — verify the READ path, not the write; key-format boundaries get one translation point per direction |
| 40 | (found by the build-9 rework, live in production) "Approve & lock" on the **Periods page** toasted success, then the lock evaporated on the next refresh; "Export to Odoo" was a dead button on the same path — while the Approvals page worked | same key-format split as row 39: the Periods page resolved the server period row with an untranslated UI key, so `PERIODS.find` never matched and the POST silently never fired (the Approvals page translated via srvPeriodKey — bug #22's fix — but Periods skipped it) | build 9: both call sites translate; a missing server row is now a LOUD toast ("approval was NOT saved") + rehydrate, never a silent skip | The second consumer of a translation is where it gets skipped — put the translation at the boundary helper, and make "couldn't mirror" audible: silent no-op + optimistic flip = fake success |
| 41 | (found by the build-9 rework) Visiting Ledger's Audit page corrupted the Approvals filters — stale/incompatible keys, resets to the wrong shape | `setAF` was declared TWICE (Approvals flavor and Audit flavor); function hoisting meant the Audit version won everywhere, and both views shared `state.af` with different shapes | build 9: Approvals keeps `state.af`/`setAF`; Audit gets `state.auf`/`setAuf` — one name, one home, verified single-definition by the globals audit | Two declarations of one global is a collision even when both "work" locally — hoisting picks a winner silently; audit for duplicate definitions, not just undefined references |
| 42 | (found by the build-9 rework) Project flat-fee pricing never saw server data — bootstrap's `projects` payload was discarded on every fresh load | the hydration branch guarded `if(state.projects!==undefined)` but the state literal never declared `projects` — only a suite-bridge event created it lazily, so direct Ledger loads dropped the key | build 9: `state.projects` is declared; the branch hydrates unconditionally (clear-then-fill) | An existence-guard on a key you own is a smell — declare the shape, hydrate unconditionally; guards belong on SERVER payloads, not on your own state |
| 43 | (caught pre-ship by the build-9 verify battery, would have been row-#30's twin) The new ticket-states editor would have toasted rename/archive success then reverted on refresh — for EVERY pre-existing state | bootstrap emitted states without their server uuid while the editor's PATCH gated on that uuid (`sid`) — the exact lying-chip anatomy of rows 30/38, reproduced by the rework itself before the adversarial review caught it | bootstrap emits `sid`; mapIn carries it; also fixed in the same pass: vcfg hydration dropped `postToThread` (an unrelated Settings edit would have silently re-enabled thread-posting an admin turned off) | The bug classes you just abolished will try to reincarnate in the new code — run the same battery against the rework that the rework was born from; adversarial verify catches what authorship can't |

| 44 | (closes the build-8 incident, 2026-07-31) migrate exited 3 on EVERY attempt — first masked as "relation ticket_links already exists", then, with the hardened 0025 finally on the VM, as the REAL error: column "voided_at" does not exist | the original build-8 upload (GitHub web UI drag-drop) shipped a TRUNCATED 0025 whose CREATE TABLE lacked voided_at/voided_by; with no tx wrapper it COMMITTED the malformed table before dying on the first index; every later attempt then hit the committed-wrong object — IF NOT EXISTS checks EXISTENCE, not correctness, so even the idempotent rewrite skipped the bad table and failed on its indexes | verified the table empty (links shipped in build 8 and desk-api had been down since, so nothing could have written a row), DROP TABLE via console psql, re-ran migrate: hardened 0025 applied clean and recorded; the web-upload path is retired — pushes now come from a real git client with sha256 verification | Idempotency heals a MISSING object, never a WRONG one — after any partial apply, inspect the committed object against the file, do not trust existence; and a committed-wrong object explains "impossible" persistent failures better than any corruption theory |
| 45 | (live, screenshot-reported) Ledger client page showed "Org #undefined" above the rates table; three sibling views showed the same | the UI rendered `c.zorg` — a prototype-era Zammad-organization-number vestige no bootstrap ever emitted (no number column exists in shared.clients at all); worse, suite-bridge FABRICATED `zorg: 100+len` for bridge-created clients, and previewPayload put the undefined into a `zammad_org_id` field the server's export payload doesn't even have | build 13: bootstrap emits `zorg = str(id)[:8]` (a real, stable short client id), all four renders say "client #<id8>", suite-bridge derives the same value instead of inventing one, and the Odoo preview/export both carry `client_id` (helpers.py gained the field for parity) | A field only a fabricator writes is a lie with a delay — when a prototype key survives into production, either back it with real data at the emitter or delete every consumer; and a client-side payload PREVIEW must be built from the same fields the server sends, or it reviews a fiction |
| 46 | (live, screenshot-reported) Billing Periods showed "July 1930 · Open · 0 entries +1 void" for Acme Corp — bug #27's ghost, still walking after the documented void-the-entry cleanup | three stacked causes: pfHistory() derived period keys from ALL entries INCLUDING void ones (the void that was supposed to bury the ghost kept resurrecting it, while periodState() fabricated a default open registry row); the composer's ride-along time INSERT was the LAST span writer with no _sane_span guard (a fresh 1930 could be minted any day); and the DB itself had zero era bounds — ensure_period would happily mint year-30 periods for any caller | build 13: pfHistory skips void-only periods (approvals already did); articles.py guards the ride-along span; migration 0031 re-dates the garbage entry to its created_at, deletes the empty pre-2000 shells owner-level, adds permanent era CHECKs on both tables, and re-issues ensure_period with a leading era guard | A cleanup that relies on every consumer filtering the tombstone is not a cleanup — kill the data, guard every writer, AND backstop the store; count the WRITERS of an invariant (four span paths, one unguarded) the way row 37 counted the consumers of a collection |
| 47 | (live) Local MFA was un-enrollable: the Directory badge said "no MFA" with no control anywhere to change it; under auth.mfa=required a password-only agent was hard locked out (403 with nowhere to go), and an enrollment that stalled mid-way could lock the account | the TOTP columns, verify(), and the login gate all shipped in build 9 — but no enrollment endpoint ever existed (secret minting had no writer), and the login gate keyed on SECRET PRESENCE, so a pending half-enrollment behaved like full enrollment and demanded codes the user could never have | build 13: two-phase enrollment (mint PENDING secret via session self-service or password-gated login-time enroll-start; first valid code confirms), the gate keys on totp_enrolled_at so pending secrets stay inert, admin reset/password panels consolidated in the per-agent Auth modal, and failure audits commit before their raise (the audit-then-raise rollback ate every failed-login row) | A feature is its WRITE path — columns plus a verifier plus a gate is scaffolding, not MFA; gate on the completed-state marker, never on artifact presence, or half-done state impersonates done; and an audit row written inside a transaction you are about to abort was never written at all |
| 48 | (caught pre-push by the build-13 adversarial verify battery — would have killed every desk-side time write the moment 0031 applied in prod) the era-guard migration re-issued ledger.ensure_period via CREATE OR REPLACE with only LANGUAGE plpgsql — silently stripping 0006's SECURITY DEFINER + pinned search_path; desk_api holds no grants on billing_periods, so the assign_period trigger would have died with "permission denied" on EVERY time entry, new period or not | CREATE OR REPLACE FUNCTION preserves ownership and ACLs but RESETS every unstated attribute to default — the spec draft carried the same omission, and "0003's body verbatim + guard" read as faithful precisely because 0006's ALTERs live in a different file than the body being copied | the re-issue restates SECURITY DEFINER SET search_path = ledger, shared, pg_temp (0009's inline pattern) and the header now warns every future re-issuer; the migrations verifier traced the failing path grant-by-grant before any deploy | Re-issuing a function means re-issuing its ATTRIBUTES, not just its body — grep prior migrations for ALTER FUNCTION on anything you OR REPLACE; and a "verbatim copy" of code whose critical property lives in ANOTHER file is the most faithful-looking way to break it |
Meta-lesson: every DB-layer failure was **least-privilege refusing an
unprovisioned path** — never corruption, never a broken invariant. The
segmentation model kept proving itself by saying "no" in exactly the right
places.

---

## 5. Punch list & known gaps (prioritized)

**Ordering (refreshed 2026-07-30, session end):**
1. **USER — close the session's tail:** ~~verify@ test-send~~ (DONE —
   confirmed 2026-07-30 evening) → deploy build 8b (RUNS MIGRATIONS
   0024 + 0025; supersedes 7e/7f/8 — includes all; first build-8 deploy
   hit migrate exit 3 → 8b makes both migrations transactional +
   idempotent, so re-running `up -d` after a partial apply is safe;
   root-cause via `sudo docker compose logs migrate`) → served-UI staleness walk below →
   hemingway@ agent create → MFA re-enroll for admin@ + `auth.mfa` back to
   `"required"` → then the accumulated verify walks below on the CURRENT
   desk.html.
2. **USER — ops list (unchanged, now urgent with outbound live):**
   Lightsail snapshot, off-VM `secrets/` + `.env` + dumps, `deploy.sh`
   committed and used, test-ticket archiving.
3. ~~CLAUDE — silent-controls + hydration-completeness sweep~~ **CLOSED BY
   BUILD 9, as a category:** the prototype/adapter split is gone; every
   control is one function containing both its local mutation and its API
   call, and mapIn consumes every bootstrap key. The rework surfaced and
   fixed five live members of the class on the way out (rows 39–43).
4. **CLAUDE — backups + restore drill** (dumps off-VM, KEK custody,
   scripted + drilled restore).
5. **Post-launch tail:** Zammad import → customer portal → retainers
   (ticket links: DONE, build 8). Known cosmetic: Ledger Swagger behind the proxy fetches
   Docket's spec (use NetBird ports).

**Verify after next deploy (latest bundle):**
- [ ] **BUILD 14 — no migration; frontend-only rebuild.** RELOAD THE APP TAB after deploying — the SPA keeps running pre-deploy scripts until refreshed (this is what made build 13 look missing).
- [ ] **Build 14 — date range:** queue filter bar shows "created" From/To date inputs → set a window → rows, the pager count, AND the CSV export all honor it; same on a client page's ticket list; clearing either input widens the window; boundary day is inclusive both ends.
- [ ] **Build 14a — pager always visible:** EVERY non-empty list in both apps shows the pager bar (size select "N / page" + "x–y of N" + Prev/Next) even when it has one row — the build-13 ≤10-row auto-hide also hid the size select and read as "pagination missing". Check the Docket queue, a client page, and Ledger Timesheets specifically.
- [ ] **Build 14 — no "All" row:** the queue-by-state pickers (Settings card AND the dashboard ⚙) list only states — no bold "All" first row; every other filter dropdown keeps its All row.
- [ ] **Build 14 — subtitles:** page headers show no explainer prose ("Every ticket, every group…", "Shared directory…", "Global defaults ·…" all gone, both apps); ticket pages keep "client · opened Xh ago"; client pages keep just the name; dashboards keep just the date/clock.
- [ ] **Build 14 — label-above settings:** every labeled text/number/select field on BOTH Settings pages renders its label above the input (Priorities & SLA first-response/resolution now stacked and uniform — the accidental VIP wrap is now the deliberate standard everywhere); toggles/buttons stay inline; every field still saves (spot-check an SLA hour + the Ledger billing cycle).
- [ ] **BUILD 13 — migrate applies 0029+0030+0031 in order** (`apply 0029_default_billing_rates.sql` / `0030_roles_lifecycle.sql` / `0031_era_guard_1930_cleanup.sql`, no ERROR lines; 0031's audit rows say "Entry span corrected" + "Ghost period removed"). Both containers rebuild after (desk-api ships articles.py/sessions.py changes, ledger-api ships bootstrap/admin).
- [ ] **Build 13 — time logging still works POST-0031 (row 48's near-miss):** log time on any ticket from Docket the moment the deploy lands → the entry appears in Ledger. If this fails with a permission error, ensure_period lost SECURITY DEFINER — restore per 0031's header before anything else.
- [ ] **Build 13 — org label (row 45):** Ledger → Clients → any client → the old "Org #undefined" cell now reads "client #<8 chars>"; dashboard + directory cards match; Odoo payload preview shows `client_id`, no `zammad_org_id`.
- [ ] **Build 13 — 1930 ghost is gone (row 46):** Billing Periods → Acme Corp → historical list has NO July 1930 row; try saving a span with year 1935 in the composer's ride-along time → 422 "outside the sane window".
- [ ] **Build 13 — default billing rates:** Ledger Settings → Default billing rates card: set a rate on one type → Clients → a client → flip "use global default rates" ON → an unclassified-rate entry of that type prices at the default; toggle that type OFF on the client → falls back to unbilled/its own rate; a client-specific rate still wins over the default; approved period totals do NOT move.
- [ ] **Build 13 — roles lifecycle:** Directory → Roles: Archive a custom role → dims + "(archived)" in its holder's select (holder keeps it, select shows the truth); Restore works; Delete on a held role → 409 naming the count; reassign the holder then Delete (no refresh between) → succeeds; core roles show neither button.
- [ ] **Build 13 — group membership UI:** agent rows assign groups via the multi-select combo (chips + type-to-search, multiple groups fine); the old per-agent checkbox matrix under Groups & membership is gone; membership still mirrors to Ledger client access.
- [ ] **Build 13 — local auth panel + MFA (row 47):** Directory → agent → Auth…: set a password (temp shows ONCE in the readonly field; Copy button only claims success when it copied); self-enroll MFA (secret + otpauth link) → confirm code → badge flips to MFA; wrong code → loud 401 AND a "Login failed" row in the audit log (the rollback bug is fixed — verify the row exists); admin Reset MFA clears it. NOTE: under auth.mfa=optional only admins can reach the panel — non-admin agents enroll at first sign-in once the policy flips to required (login page shows the enroll box on the 403).
- [ ] **Build 13 — client-page ticket filter + CSV:** Docket → client → Tickets card: state/tag/owner/search filters work; Export CSV honors the filter and the export permission; pagination (10/25/50/100, default 25) on this and every long list in BOTH apps; page size sticks per list.
- [ ] **Build 13 — chrome/copy removals:** no "Graph mail · Entra SSO" pill (desk), no "Docket linked · shared DB" pill (ledger), no "watch it land in Ledger live" banner, no fake "Sync now", no "Pricing, approval and invoicing happen in Ledger" explainer; queue-by-state config (Settings AND the dashboard ⚙) is a multi-select dropdown; website links on client cards open https://… in a new tab even when stored bare; bottom-left user card identical in both apps; Docket nav icons match Ledger's stroke style; Ledger Settings' Docket-connection field shows its baked-in host read-only.
- [ ] **BUILD 12 — migrate applies 0028** (`apply
      0028_prio_color_contact_vip.sql`, no ERROR lines).
- [ ] **Build 12 — priority colors:** recolor High via a pill and Urgent
      via the RGB square → flags change in the queue, ticket view, props
      and mailbox default tags, and SURVIVE refresh; ↺ returns the
      tier-order default.
- [ ] **Build 12 — VIP:** check VIP on a contact → ★ chips appear on the
      client row, the props contact line and the picker; UNCHECK and
      refresh — it stays off (explicit-boolean seam); build a trigger
      "on create, only if VIP is yes → set priority Urgent", send a test
      mail from that contact → priority flips and Runs increments; a
      non-VIP sender does not fire it.
- [ ] **Build 12 — periods page:** the client list renders with search;
      a row expands to current-period actions (approve/export/preview
      behave exactly as before — same confirms, same toasts) + history
      with its own search; the intake bucket appears dimmed at the
      bottom ONLY when it holds unassigned time.
- [ ] **BUILD 11 — migrate applies 0027** (`apply 0027_state_decor.sql`,
      no ERROR lines).
- [ ] **Build 11 — advanced filters:** queue bar shows state + tag +
      owner-scope alongside group/priority/client; two states picked =
      union; typed search + filters + CSV export all agree row-for-row;
      a personal tab filtered to one client shows exactly that client's
      tickets; the admin Queue-tabs card can build a client-scoped tab.
- [ ] **Build 11 — state decor:** recolor a custom state → chip changes
      EVERYWHERE (queue, ticket view, dashboard, pickers) and survives
      refresh; add a description → shows as the row subtitle; click the
      ringed swatch → back to default; core states recolor fine but still
      refuse rename; 'Closed: child ticket' offers no decor controls.
- [ ] **Build 11 — dashboard wrap:** long state names (Waiting Client
      Response) wrap inside a fixed-width pill; all bars start at the
      same x; no ellipsis anywhere on the card.
- [ ] **BUILD 10 — migrate applies 0026** (`apply 0026_group_sendas.sql`,
      no ERROR lines — deploy.sh runs migrate BEFORE the rebuilt code,
      which queries the new table unconditionally).
- [ ] **Build 10 — bell:** "Mark all read" zeroes the badge and SURVIVES
      refresh; another agent's bell is untouched.
- [ ] **Build 10 — queue tabs:** stock queue shows the same five tabs with
      identical counts as before; ⚙ opens Customize on a FRESH install; a
      personal reorder/hide survives refresh AND a different browser (it
      is account-scoped); Settings → Queue tabs edits change every user's
      default; admin Hide actually removes the tab from agents' queues.
- [ ] **Build 10 — multi-select filters:** pick two groups in the queue
      bar → union of both; clear → all; same on reports/audit and the
      Ledger bars; a trigger condition with two picked states fires on
      either (the Runs counter proves it).
- [ ] **Build 10 — sendas:** override a board to another outbound address
      → routing card chips "Override"; an agent reply AND a trigger email
      both send from the override (check the customer-visible From);
      clear → derived returns; a paused or receive-only mailbox can't be
      picked (and curl answers 422).
- [ ] **Build 10 — dashboard:** hide a state via the card's ⚙ → survives
      refresh; reset returns to the admin default.
- [ ] **BUILD 9 smoke (FIRST — everything else assumes it):** both apps
      load with real data (shells + css/ + js/ all served; webui is baked
      into images, so a stale UI here means the rebuild step was skipped);
      the browser console is CLEAN on load of /ui/desk.html and
      /ledger/ui/ledger.html (a 404 on any js/ file = the merge dropped a
      directory); sign-in → queue → open ticket → note → props edit →
      refresh: everything sticks. Then spot-walk one mutation per view.
- [ ] **Build 9 — ticket-states editor (NEW wiring):** Settings → rename a
      custom state → survives refresh; archive/restore it; try renaming
      'New'/'Open' → 409 "Core states keep their names"; the system state
      'Closed: child ticket' offers no edit control; duplicate label → 409
      not 500.
- [ ] **Build 9 — priorities editor (NEW wiring):** add a tier (label +
      rank) → survives refresh; archive it; rename 'Normal' → 409 (it is
      the ingestion fallback); duplicate rank → clean 409.
- [ ] **Build 9 — API access card:** lists real PATs (name, created, last
      used) read-only; no mint/revoke controls exist.
- [ ] **Build 9 — Directory agent badges:** password/MFA badges reflect
      reality (hasPassword/mfa from bootstrap); Reset password / Reset MFA
      round-trip through /auth/admin/* (temp password shown once).
- [ ] **Build 9 — Ledger fresh-load access (row L7):** open Ledger
      DIRECTLY (no Docket tab): Directory shows real groups/roles; a
      client with group-based access resolves membership correctly;
      Approvals group filter is populated.
- [ ] **Build 9 — period locks tell the truth (rows 39/40):** a
      server-approved period shows Approved/locked in Billing Periods on a
      fresh load; its entries render locked; "Approve & lock" from the
      PERIODS page survives refresh (this was silently broken before);
      Export lists approved periods and mark-exported records the SERVER
      ref; a period the server doesn't know answers a loud toast, not fake
      success.
- [ ] **Build 9 — Approvals↔Audit filters (row 41):** set Approvals
      filters, visit Audit, set its filters, return — Approvals filters
      intact.
- [ ] **Build 9 — client billing card:** "Billable by default" toggle
      persists (new control, previously an orphan function); billing cycle
      offers monthly/weekly only (biweekly removed — the server never had
      it).
- [ ] **Build 9 — verification config:** disable thread-posting, refresh,
      toggle SMS — thread-posting STAYS off (postToThread hydration fix).
- [ ] **Archived entries out of filter dropdowns (build 7e, row 37):** with
      Security + Test groups archived, the queue's "All groups" dropdown
      lists only All groups + Service Desk (+ any other active groups) —
      no archived rows, no "(archived)" clutter; same for priority, state,
      and client filters in the queue and reports bars, and Ledger's
      timesheet/approvals/client-page/reports filters for types + clients.
      Exception check: set a filter to a group, archive that group in the
      Directory, return — the filter still shows it labeled "(archived)"
      and still filters correctly; switch the filter away and it drops out
      of the list. Directory/Settings management surfaces still show
      archived rows dimmed with Restore (bootstrap untouched — row 36
      stays fixed)
- [ ] **Mailbox type saves (build 7f, row 38 — MIGRATION 0024 must run):**
      Edit support@ → Type: Licensed mailbox → Save → the row's chip reads
      "Licensed" and STAYS after a hard refresh; audit shows
      "Mailbox updated … type → licensed"; flip it back to Shared and that
      persists too; new mailboxes save whichever type was picked. A revert
      here now means the migration didn't run (bootstrap would 500 on the
      missing column rather than fabricate "shared", so a silent revert
      should be impossible post-7f)
- [ ] **Ticket links (build 8 — MIGRATION 0025 must run):**
      (1) Related: Link… two tickets → both props panels show the link;
      refresh → it SURVIVES (previously local-only); × unlinks both sides
      and survives refresh; audit shows linked/unlinked. (2) Child: on a
      normal ticket, Add child… → pick one → both panels show
      parent/children with live state chips + open count; sys notes on
      both. (3) THE REFUSAL, both layers: open the CHILD and click Add
      child… → toast "#X is a child of #Y — a child ticket can't be a
      parent"; then POST /api/tickets/{child}/links {kind:'child',...}
      via curl → 409 with the same sentence; also try making a PARENT a
      child of something → 409 "already has children". (4) Cascade: close
      a parent with ≥1 open child → prompt appears; "Close them too" →
      children land in "Closed: child ticket" (chip renders closed-style),
      each with "Closed with parent #id" note, parent notes the list;
      CRITICAL: with a "state → Closed → send reply" trigger enabled, NO
      close email goes out for any child (that's the whole design); audit
      has one row per child + the parent summary. (5) Manual pick refused:
      the state dropdown does NOT list "Closed: child ticket"; PATCH state
      to it via curl → 422 "system state". (6) Close the last open child
      by hand → parent gets "All child tickets are resolved … Ready to
      close?"; reopen a child under a closed parent → parent gets the
      reopen note. (7) Merge a linked ticket → 409 "unlink them before
      merging". (8) Bulk-close a parent → no prompt, children untouched
- [ ] **Mail ingestion (bug #33):** with the new worker up, close/merge the
      ghost tickets #100023–100027, unpause support@, send ONE test email →
      exactly one ticket appears WITH the email body as its mail_in article;
      `graph_subscriptions.last_delta_at` refreshes within ~60 s; the next
      few worker passes log no new tickets; reply to that email from the
      outside → it lands as a follow-up on the SAME ticket (threading now
      has message_ids to work with)
- [ ] **Battery addition:** `python3 scripts/sql_arity_audit.py` runs clean
      (exit 0) — run it as part of every future bundle's pre-ship checks
- [ ] **Outbound pre-flight (lookover pass, this bundle):** on the VM,
      `curl -s -X POST https://helpdesk…/api/settings/graph/test-send \
      -H 'Content-Type: application/json' -H "Authorization: Bearer $PAT" \
      -d '{"to":"YOUR@address","sender":"support@hemingwaytechsolutions.com"}'`
      → the test mail arrives (Message-ID in the JSON), audit shows
      "Outbound test sent". Repeat with `"sender":"verify@…"`. A 502 here
      names the real blocker: Mail.Send not consented, or the sender not in
      the Exchange application access policy — fix in Entra/Exchange and
      re-run. Only after both pass: flip `mail.outbound_enabled`, reply on a
      real ticket, and confirm the article shows the sending mailbox as its
      From (mail_from now recorded; it was silently NULL before this pass)
- [ ] **Outbound size guard:** a reply whose staged attachments push the
      encoded MIME past 4 MB now returns a clear 413 (Graph's sendMail hard
      limit) instead of Graph's opaque refusal — optional spot-check
- [ ] **Subject prefix (this bundle):** send a reply → the email arrives as
      "Service Ticket: [#100xxx] Title"; reply to it from outside → still
      threads onto the same ticket (the [#id] matcher searches anywhere in
      the subject, so the prefix and RE:/FW: chains are all safe)
- [ ] **OR conditions (this bundle):** in a trigger, add a condition, then
      "+ OR group" and a second condition → the list column reads
      "(a) or (b)"; fire an event matching only the second group → trigger
      runs. Edit an OLD rule → it opens as one group and saves unchanged
      (single group stores flat, so nothing existing is rewritten). Same in
      the mail-rule builder
- [ ] **Master send switch (this bundle):** Automations → Outbound routing
      card header shows "Sending live"/"Recorded-only" with a toggle;
      enabling asks for confirmation, the flip lands in audit as "Outbound
      sending enabled/disabled", survives a refresh (hydrated from
      bootstrap), and a server refusal rolls the chip back instead of lying
- [ ] **Verification channel toggles (this bundle — silent-control #5):**
      Settings → Caller verification → Enable on EMAIL → chip goes
      Connected AND STAYS Connected after a refresh (previously the flip
      never reached the server, so email codes always 409'd); audit shows
      the verification config change; then verify a caller by email on a
      ticket whose contact is your own address → code arrives from the
      configured sender. If the send 502s, run graph/test-send with
      "sender":"verification@hemingwaytechsolutions.com" — that address
      must be in the Exchange application access policy like support@
- [ ] **Re-verify (this bundle):** on an already-verified ticket the
      Identity panel keeps a "Verify again" button; running it again
      supersedes the old code, re-tags idempotently, and posts a fresh
      ✅ note
- [ ] **⚠ SERVED-UI STALENESS (found 2026-07-30, bug #10's class):** the
      live Directory rendered an Agents card captioned "Entra-synced —
      shared" — text that exists in NO current bundle. The served desk.html
      is old, which is why agent add/deactivate/membership appeared broken
      (the controls aren't in the old file). The bug-#10 habit, both sides:
      **markers moved in build 9** (desk.html is a shell now):
      `grep -c "Add person" services/desk-api/webui/js/desk/views/directory.js`
      on the repo (expect 1) and `curl -s
      http://$BIND_ADDR:8081/ui/js/desk/views/directory.js | grep -c
      "Add person"` (expect 1). disk=0 → the bundle→repo merge is dropping
      webui/ — fix the merge, push, pull; disk>0 served=0 → `sudo docker
      compose build desk-api && sudo docker compose up -d desk-api`
      (--no-cache if stubborn); both>0 → hard-refresh the browser. Then:
      Agents card shows "+ Add person" + Deactivate, membership checkboxes
      persist across refresh
- [ ] **Group Delete button REMOVED (silent-control #6):** it spliced
      locally with no server endpoint (correctly none exists — no-delete
      convention) and the group returned on refresh; Archive/Restore is the
      wired removal and stays
- [ ] **Archive survives hydration (this bundle):** archive a group → it
      stays in the Directory dimmed with an Archived chip and a Restore
      button, INCLUDING after a refresh (bootstrap previously emitted only
      active groups, so the post-archive hydrate made it vanish — looked
      like a delete); Restore brings it back live; its mailboxes pause on
      archive (resume manually); pickers stay clean (archived shows only
      labeled "(archived)" where a ticket already sits on it). Same fix for
      custom ticket STATES — archive one in Settings and it must persist
      dimmed across refresh too
- [ ] desk.html hydrates real data again (bug #13 fix); Graph card shows real
      tenant/app-id/rotation; rules/triggers hydrate from the server (empty until you create some); titles/signatures live
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
- [ ] Return a SUBMITTED sheet → entry goes back to the tech (Returned flag +
      reason), server-side, survives refresh — the bug #22 walk
- [ ] Timesheet rows show the note text as content when the entry rides on one
- [ ] Value-field feel (both apps): click a rate/number field → current value
      selects → type replaces it → Enter commits; full numbers and words land
      in every search box, caret stays, page doesn't jump; override PUTs fire
      once after typing settles (watch network tab)
- [ ] Cleanup + guard: void the July-1930 entry in its Ledger drawer → the
      1930 sheet AND period vanish everywhere; try saving a span with year
      1930 → clean 422 "check the year", widget won't even offer it
- [ ] Override display truth: type 150 in a per-type override → breakdown
      re-prices to $150 immediately and still $150 after refresh; reset →
      today's entries price at inherited rate, OLD entries keep their old
      override price (display AND export)
- [ ] Billing-history walk: note an old entry's rate/amount → change the type
      rate, a client override, and flip a type's billable → old entry's price
      and billable status UNCHANGED (display and export), new entry from
      today uses the new values; Audit Log page lists each change with
      actor/when/before→after
- [ ] Admin layer: change a client's cycle + billable default; toggle a
      type's billable + edit its rate; set/clear a per-client-type override
      (reset = inherit, priced() follows); set access mode + tech/group lists
      → all survive refresh; role perm toggle audits and applies at next
      sign-in
- [ ] New inbound HTML email renders formatted (no images/scripts), plain-text
      toggle works, paragraphs survive in the text view; old mails stay text
- [ ] Ledger Settings: defaults + Odoo fields persist across refresh; Save key
      seals the Odoo key (card shows rotation stamp, never the value)
- [ ] Ledger loop: select entries → submit → recall → edit a span →
      reclassify → void; approve timesheet → Revoke un-approves server-side →
      Return sends back with reason; approve period ONLY after modal confirm
      (Cancel = no server call) → export marks exported with a server ref;
      Return on an all-pending sheet = friendly local toast, no server alert
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

- [ ] **Automations (0019 — NEW):** create a mail rule (e.g. subject contains
      "test-rule" → tag `rulecheck`) → send a matching mail to support@ →
      ticket arrives tagged, ⚙ sys article names the rule, its Runs counter
      ticks up on the Automations page after refresh
- [ ] **Triggers:** enable an "on create → internal note" trigger with a
      template variable → next inbound ticket carries the rendered note + ⚡
      sys article; add a state-change trigger ("state → Closed" → note) →
      close a ticket in the UI → within ~30 s (one worker pass) the note
      lands; an "email the customer" action records the reply but shows
      RECORDED ONLY in audit while outbound is off
- [ ] **Auto-assign:** trigger with auto-assign round-robin on create →
      consecutive new tickets rotate owners within the board; least-loaded
      picks the idlest agent
- [ ] **Builder round-trip:** edit/disable/reorder rules and triggers →
      refresh → everything sticks; Delete on a trigger archives it (gone from
      the list, runs history kept in the DB)
- [ ] **SLA fix (bug #29):** after 0020 + rebuild, the queue's SLA column
      shows real countdowns (hours, not "in 416d"); worker logs are clean of
      "could not convert string to float"; a fresh test mail to support@
      becomes a ticket again within a pass (ingestion was rolling back while
      the bug was live)
- [ ] **SLA:** Settings → change a priority's first-response target and a
      business-hours day → refresh → sticks; a ticket left un-replied past
      its (short, for testing) target puts a warn then breach notice in the
      bell within a worker pass; each fires ONCE; bell click-through opens
      the ticket and marks it read (survives refresh)
- [ ] **Roles:** rename a custom role → refresh → renamed, members keep it;
      renaming a core role is refused with a clear message; + Add role
      persists (grant it perms after)
- [ ] **Activity types (Directory tab):** + Add type → appears in Ledger's
      Activity Types page (non-billable) and in classify pickers; rename
      sticks; Archive → gone from pickers in BOTH apps, old entries still
      show its name and price; Restore brings it back

- [ ] **OIDC (build 3):** after the Entra steps in DOCUMENTATION.md §6,
      port-forward `ssh -L 8081:<BIND_ADDR>:8081` → localhost login page
      shows "Sign in with Microsoft" once Settings → Authentication is
      Connected → the round trip signs you in as your agent (audit shows
      "Signed in (SSO)"); a Microsoft account with no matching agent gets a
      readable refusal on the login page, not a stack trace
- [ ] **OIDC settings:** toggle SSO/local/mapping, edit tenant/client
      ID/redirect URI → refresh → all stick; disabling BOTH sign-in paths is
      refused with the lockout toast; with mapping ON and a group object id
      in a role's field, next SSO sign-in applies that role (audit line
      names the mapping)

- [ ] **nginx front (build 4):** after DOCUMENTATION §6's walkthrough,
      https://helpdesk.hemingwaytechsolutions.com redirects http→https,
      serves the login page, and signs you in; suite shows BOTH panes live;
      the Ledger pane's network calls go to /ledger/api/* (devtools) and a
      timesheet round-trip works inside it; direct NetBird ports still work
      until the cookie flip
- [ ] **Cookie flip:** set COOKIE_SECURE=true + up -d desk-api → https
      sign-in works, direct http://<BIND_ADDR>:8081 sign-in now fails
      (expected); existing https session survives the restart sign-out check
- [ ] **Full SSO on the domain:** add the https redirect URI in Entra → the
      Microsoft button round-trips on https://helpdesk.… (no port-forward)

- [ ] **Verification (build 5):** enable a channel in Settings → Caller
      verification (SMS needs DID + API user + voipms secret; email needs
      from-address inside the Graph access policy) → on a ticket with a
      real contact, Verify caller → code arrives on the CONTACT's
      phone/inbox, never shown in the UI → correct read-back → Verified
      chip on the ticket, ✅ sys article, identity-verified tag, audit
      line; wrong code ×3 → ❌ FAILED article; expired code → distinct
      "send a new one" message; disabled channel → clear 409 in the modal
- [ ] **Mailbox edit (bug #30):** Edit the support@ mailbox, tick/untick
      Outbound, Save → no error, chip flips between Enabled and
      Receive-only, survives refresh; with outbound flipped ON globally
      later, a reply from a receive-only-mailbox group records with
      "sender mailbox is receive-only" in the audit line
- [ ] **Secrets card:** Save on any slot → "rotated just now by you"
      metadata appears after refresh (it PUTs for real now)

- [ ] **Attachments (build 6):** email yourself a ticket with a PDF +
      image → chips appear on the mail-in article, both download (image
      opens inline); reply with a file attached (outbound ON) → recipient
      gets a real attachment; attach a file to an internal NOTE → chip on
      the thread, nothing mailed; a 25 MB file → clean 422, not an nginx
      error page
- [ ] **Graph card (bug #32):** refresh the Automations page → the card
      shows the TRUE state; if Disconnected, Authenticate → either
      "Authenticated" (worker logs show polling within 60s, inbound test
      mail lands) or the real Microsoft error naming what to fix
- [ ] **Ticket create title (bug #31):** create a ticket named "Printer
      on fire" → the name shows in the queue immediately AND survives a
      refresh (server has it, not "(no subject)")
- [ ] **Orphan sweep:** upload in the composer, close without sending →
      worker log shows "swept 1 stale staged upload(s)" the day after

**Prototype-parity wiring queue:**
1. ~~Docket props panel, pending timers, merge~~ DONE
2. ~~Projects lifecycle in prototype UI~~ DONE (incl. new reopen endpoint)
3. ~~Directory + Docket settings~~ DONE this bundle: agent role changes,
   group create/rename/archive (archive pauses its mailboxes server-side,
   new PATCH /api/directory/groups), mailbox add/edit/pause (PATCH gains
   address/display_name/default_priority), canned responses (new endpoints +
   0014 archive-first `active`; bootstrap emits them), verification-page
   settings persist to app_config('verification') (feature ships later),
   Entra CSV import creates real contacts; kick-back message now shows
   (return sets returned_by; bootstrap emits the returner's name)
4. Ledger: entry submit/recall/void/span-edit + export DONE; period-lock
   display registry DONE (seeded from bootstrap); ~~Settings vestige~~ DONE (0016): Ledger's
   global defaults + Odoo connector hydrate from app_config('ledger'/'odoo')
   and persist (new PUT /api/config/{key}); the Odoo API key is now a
   KEK-sealed WRITE-ONLY secret (new PUT /api/secrets/odoo; KEK mounted into
   ledger-api in compose — regenerate nothing, same kek file) with rotation
   meta on the card; ~~admin pages~~ BUILT (0017): client billing
   cycle + billable default (column-scoped grant — "billing config lives in
   Ledger" is now literally true), activity-type billable + effective-dated
   base rates, per-client/per-type rate & billable overrides incl. reset
   (all-NULL row = inherit, history kept), client access rules (new
   ledger.client_access table, hydrated + persisted), and Docket's role
   editor (perms/note/Entra map via new PATCH /api/directory/roles — perms
   apply at next sign-in); ~~role RENAME + type CREATE/ARCHIVE~~ DONE
   (build 2): role create/rename (custom roles; core names fixed) and
   activity-type create/rename/archive wired from the Directory tab —
   Ledger's role-permissions page permanently dropped by decision (RBAC is
   Docket's Directory tab)
5. Article↔time linkage DONE (0012); ~~richer mail rendering~~ DONE (0016:
   articles.body_html stored at ingestion; sandboxed CSP-fenced iframe render
   — scripts & remote images blocked — with plain-text toggle; text fallback
   now preserves paragraphs; historical bodies remain text-only); remaining:
   ticket links (no schema yet, resets on hydrate until a links table exists)

**User-owned ops (flagged, not yet done):**
- [ ] Lightsail snapshot at "fully configured, pre-real-traffic"
- [ ] Exchange application access policy (fence Graph to helpdesk mailboxes)
- [ ] Off-instance copy of `secrets/` + `.env`; ship `./backups/` dumps off-VM
- [ ] Commit `deploy.sh`; use it for every drop
- [ ] Manual pre-launch ticket archiving (Archived state, via UI or psql)
- [ ] Flip `mail.outbound_enabled` + live reply test when ready for prod

**Feature roadmap (build order):**
1. Remaining parity wiring (above) until the local-only list is empty
2. ~~Server-side automations engine + SLA escalation fan-out~~ **DONE
   (build 2, 0019)** — mail rules run per inbound message; triggers fire on
   create/follow-up/state/priority/owner from one event outbox with
   recursion + mail-loop guards; trigger emails ride the agent-reply
   outbound path (gated, recorded-only pre-launch); SLA warn/breach notices
   are business-hours-aware, deduped, and land in a real notifications
   table feeding the bell; builders fully wired (archive-first delete,
   server runs counters)
3. ~~Entra OIDC as second sign-in path~~ **DONE (build 3)** — full SSO on
   the NetBird address still waits on nginx (Entra requires HTTPS redirect
   URIs; localhost port-forward is the interim test path)
4. ~~nginx + certbot~~ **code-side DONE (build 4)** — remaining go-live
   steps are user-owned (DNS record, DNS-01 issuance, install, verify,
   COOKIE_SECURE=true, https redirect URI in Entra); Ledger Swagger behind
   the proxy stays a known cosmetic limit (use NetBird ports)
5. Full backup process: dumps → S3 lifecycle, KEK custody separate from
   dumps, scripted + drilled restore runbook — **next build**, before the
   outbound flip
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
* **MFA lockout recovery (learned 2026-07-30):** clearing an agent's TOTP
  (`UPDATE shared.agents SET totp_secret_enc=NULL, totp_enrolled_at=NULL
  WHERE lower(email)=…`) is NOT enough while `auth.mfa` is `"required"` —
  login 403s "enroll first" and `/auth/mfa/enroll` needs a session
  (chicken-and-egg by design; another admin is the intended rescuer). The
  console IS the second admin in a one-admin shop: flip the policy
  (`UPDATE shared.app_config SET value=jsonb_set(value,'{mfa}','"optional"')
  WHERE key='auth'`), sign in, re-enroll, flip back to `"required"`. Write
  an audit.events row alongside any console surgery.
* **VM hostname quirk:** the VM cannot resolve its own public hostname
  (DNS A record → NetBird IP). VM-side curls go to `http://$BIND_ADDR:8081`
  directly, or add an `/etc/hosts` line mapping the hostname to $BIND_ADDR
  (TLS then validates normally through nginx).
* **Outbound pre-flight:** before trusting any NEW sender mailbox, prove
  it: `POST /api/settings/graph/test-send {"to":…, "sender":…}` — 202 +
  Message-ID = Mail.Send consented AND that sender is in the Exchange
  application access policy; a 403 names which is missing. Admin-only, no
  ticket, deliberately not gated on the master switch.
* **Served-UI staleness check:** when a UI feature "doesn't exist" that
  the bundle says it does, grep the marker string on disk AND in the served
  copy of the SAME file (build 9: features live in `webui/js/...`, so curl
  the js file, e.g. `curl -s
  http://$BIND_ADDR:8081/ui/js/desk/views/directory.js`) — disk=0 means the
  bundle→repo merge dropped `webui/`; disk>0 served=0 means rebuild
  desk-api; both>0 means hard-refresh. A console 404 for any js/ file on
  page load is the same class: the merge dropped a subdirectory.

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
