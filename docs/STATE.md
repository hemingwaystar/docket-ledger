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

Meta-lesson: every DB-layer failure was **least-privilege refusing an
unprovisioned path** — never corruption, never a broken invariant. The
segmentation model kept proving itself by saying "no" in exactly the right
places.

---

## 5. Punch list & known gaps (prioritized)

**Verify after next deploy (latest bundle):**
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
4. nginx + certbot go-live (user-reordered ahead of backups): one domain,
   `/desk/` + `/ledger/`, HSTS; add the production https redirect URI in
   Entra; flip session cookie `secure=True` (marked in `sessions.py` AND
   `oidc.py`); Swagger header tweak behind proxy — **next build**
5. Full backup process: dumps → S3 lifecycle, KEK custody separate from
   dumps, scripted + drilled restore runbook — before the outbound flip
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
