# Builds 31a–31i — the audit response (2026-08-25)

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

## What remains

The audit's 75 medium / 76 low / 43 info findings are the next tranche
(the audit's own order puts them after the criticals + highs). The export
(`DOCKET-LEDGER-AUDIT-EXPORT.md`, outside the repo) has full detail; its
medium section starts at line 1365.
