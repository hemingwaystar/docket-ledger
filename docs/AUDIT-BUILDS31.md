# Builds 31–32 — the audit response (2026-08-25/26)

The full-codebase audit (101 agents, 257 findings: 3 critical · 60 high ·
75 medium · 76 low · 43 info) was answered in nine builds, in the audit's
own recommended order. **Every critical and every high finding is
addressed** (many highs were the same defect reported by several lenses).
Each build was adversarially reviewed by multi-agent workflows before or
immediately after commit; review findings were folded in.

## Build map

| Build | Commit theme | Migrations |
|---|---|---|
| 31a | CRIT-1: period-INSERT guard + re-home of stranded entries; composer probes the period BEFORE outbound mail | 0039 |
| 31b | CRIT-2/3: mail-worker per-message + per-mailbox savepoint fences (transients retry, poison skips with audit trace), NUL stripping, conflict-tolerant contact insert; attachment MIME normalization + inline allowlist (SVG never inline) + nosniff/CSP + header-safe filenames | — |
| 31c | Systemic RBAC server-side: desk ticket visibility (ONE `visibility_where`), ledger entry scope (ONE `entry_scope_where`, money-side carve-out), assets a_view/a_see_costs/a_view_audit; deleted-article stripping on every read path incl. files; field-level write gates; entry ownership; `l_edit_submitted` real; `ts_approved_by` stamped; ledger UI perm-set strip fix; thin-client sign-out revokes | — |
| 31d | Auth: 5-fails/15-min lockout (account + address) on login/MFA/change-password, nginx limit_req belt, TOTP replay pin, server-side `password_must_change`, self-service password change revokes other sessions, PAT scopes enforced when set, desk's caller-less Ledger-config write paths removed | 0040 |
| 31e | Worker: delta cursor resumes past 500 messages, per-event trigger savepoints (no duplicate customer mail), custom-state trigger actions resolve, `child-closed` slug matches, wake_pending wakes paused-kind only, every close path clears `pending_until`; 0025 fresh-DB bootstrap fix | (0025 amended) |
| 31f | Composer/intake truth: new-ticket note + owner reach the server, reply To override travels, contact pref/fax/notes persist, add_time returns the version bump; XSS sinks escaped (toast, initials, holidays, group members) | 0041 |
| 31g | Ledger data integrity: all agents hydrate (deactivated flagged), projects hydrate whole (clientId/title/tasks), entries carry the server's `period_key` + span edits re-home, sentinel type fallback (no more frozen pane), ghost-entry actions say "still syncing", locked deletes refuse honestly, capped-hydrate banner | 0042 |
| 31h | Retainers persist (endpoint + bootstrap + editor wiring + module toggle); Odoo copy says "recorded", not "posted" | 0043 |
| 31i | `scripts/restore.sh` (the working fresh-host order), real KEK rotation runbook in `secrets/README.md` | — |

## VM deploy notes

1. `git pull` on the VM, then the normal deploy: migrate runs **0039–0043**
   (all transactional + idempotent; 0039 re-homes any entries the INSERT
   hole stranded, with audit rows — expect zero on most installs).
2. **All four services rebuild** (desk-api, ledger-api, assets-api,
   mail-worker) — every one changed.
3. **nginx conf changed** (rate-limit zone + two `/auth/*` locations):
   re-copy `nginx/helpdesk.hemingwaytechsolutions.com.conf` to
   sites-available (re-run the `__BIND_ADDR__` sed), `nginx -t`, reload.
4. Behavior changes to expect after deploy:
   - Read-side RBAC is enforced in the DATA now. A role with only
     `view_own` sees only its tickets in every payload; money fields need
     `l_see_amounts` (or the lane's manage perm); assets needs `a_view`.
     **Check custom roles** — anything relying on the old
     everything-ships behavior needs its boxes ticked (27c precedent).
   - Login lockout: 5 failed attempts in 15 min → 15-min lock (per
     account and per address). TOTP codes are single-use now.
   - Temp-password sessions can only change the password.
   - Changing your own password signs out your other sessions.
   - Desk Settings no longer accepts the `odoo`/`retainers` config keys or
     the Odoo secret — Ledger's `l_manage_settings` routes own them.
   - PATs: existing tokens (empty scopes) stay all-scope. New tokens can
     be scoped: `sh scripts/create-token.sh "label" view_audit l_view_all`.
5. New table `shared.auth_throttle` (0040) holds transient lockout
   counters; rows are disposable.

## Known nuance (deliberate)

Closing a ticket now clears `pending_until` on every path (the worker no
longer resurrects closed tickets), but its **schedule blocks (0033) are
left untouched**. If a closed scheduled ticket is later reopened, the
auto-hold timer is not re-derived automatically — the blocks still render
in the Schedules bar, and any schedule edit rewrites `pending_until`. If
reopen-should-re-arm ever matters in practice, that's a small follow-up.

## The 32 series — mediums + actionable lows (2026-08-26)

| Build | Theme | Migrations |
|---|---|---|
| 32a | Ledger/billing server correctness: type-rate epoch anchoring survives billable flips (+ honest messaging), SQL status filter, export total = the same integer-cents sum as every money path (+ currency), timesheet/period TOCTOU predicates + locks, relative /ledger/ redirect, utilization month window, NOW refreshes per hydrate, Settings honesty, server-side payload preview | — |
| 32b | Desk + mail: CC pipeline REAL end-to-end, customer email sends LAST in add_article, merged-[#id] replies follow the merge, reopens/rule-escalations enqueue real events, receive-only trigger mail records honestly, 'Assignees changed' automation event, merge moves assignees/schedules, cascade skips locked-project children, 0036 tombstones enforced everywhere + edit_note guarded UPDATE | 0044 |
| 32c | Assets: same-client coverage = DB law (guard + prune-on-move triggers + cleanup), honest coverage-save toasts, complete per-entity change feeds + windowed audit endpoints | 0045 |
| 32d | Cross-cutting UI: served-bundle staleness banner, prefs jsonb merge (no cross-tab clobber), per-frame postMessage origins (direct-port works), id-first bridge entry sync, transport-failure net, gate alignments (title/roles/agents/default-rates), CSV formula guards, live audit Area filter, dashboard/report rule alignment, ~10 smaller UI truths | — |
| 32e | Platform: README installs the RIGHT nginx conf, migrate apply+record one invocation + 0021-0023 wrapped, COOKIE_SECURE default TRUE, backups 0600 + loud failure, CSP baseline, forwarded-IP trust scoped, non-root containers + .dockerignore, OIDC email match binds only UNBOUND agents, deploy.sh dirty-guard + build-before-migrate | — |
| 32f | Actionable lows: login timing oracle, constant-time verify compare, archived records read-only server-side, /api/directory gated, Swagger off the public front, script SQL-charset guards, worker 4 MB MIME guard + healthcheck heartbeat, kind-based wake state, desk time dual-write, a dozen small UI truths | — |

### Extra deploy notes for the 32 series
* Migrations **0044–0045** (idempotent). 0045 one-time-prunes any
  cross-client coverage rows (audited).
* **COOKIE_SECURE now defaults TRUE** — prod is behind TLS so nothing
  changes if the flip was done; a box that still relied on plain-http
  direct-port sign-in needs `COOKIE_SECURE=false` in `.env` explicitly.
* **Containers run as non-root** and uvicorn trusts X-Forwarded-* only
  from `FORWARDED_ALLOW_IPS` (default docker range) — override in `.env`
  if the proxy reaches containers from elsewhere.
* nginx conf changed again (CSP + docs-block + comments) — re-install.
* deploy.sh now refuses a dirty tree (`DEPLOY_FORCE=1` to discard) and
  builds images before migrating.
* Reply CC is live: inbound To/Cc parties are captured and CC'd on agent
  replies. Check a ticket's CC list before replying if that surprises.

## Accepted / deferred (documented, not churned)

* **Dead-code inventories** (unused tables/columns/grants/CSS/handlers/
  endpoints the audit catalogued as vestiges): left in place — several are
  documented Build 28–30 forward-wiring; wholesale deletion is churn with
  regression risk and no user value. Export lines 3008–3176, 3344–3533,
  3764–3827, 3932–4016, 4142–4289, 4394–4415.
* **SLA pause-awareness** (holds still count toward due; one-shot notices):
  a real feature change on the SLA engine — schedule as its own build.
* **Direct-port (NetBird) mode** bypasses nginx protections (body cap,
  CSP, rate limits) and its sign-out can't POST cross-origin: break-glass
  mode is overlay-only by design; use the https front for daily work.
* **KEK has no per-use AAD binding**; single key for all envelope crypto —
  acceptable at this scale, revisit if secrets multiply.
* **Messages with no internetMessageId** bypass dedup on a 410 resync
  (rare); concurrent pollers are self-healing post-31b (dup insert skips).
* **ends_on read-time roll** boundary-day nuance — Build 30's worker will
  own the authoritative roll.
* **DOCUMENTATION.md is frozen at build 8b** and STATE.md carries stale
  sections — a docs refresh pass is worth its own sitting.

## What remains from the audit

Nothing unaddressed at critical/high/medium. Remaining lows are the
accepted list above; info findings are observations/coverage notes (the
few actionable doc-drift ones were folded into 32g). The export
(`DOCKET-LEDGER-AUDIT-EXPORT.md`, outside the repo) has full detail.
