# Build 14 — design contract (2026-08-01)

Post-build-13 feedback round. User asks: date range on the ticket search
filter; remove the "all" option in the queue-by-state list; remaining
arbitrary text ("Every ticket, every group — the working queue"); make
label-above-input the standard for settings fields ("first response
showing above on the vip sla — i would like this to be the standard").
Also diagnosed this round: "still can't archive/delete roles / no pages"
was the SPA tab running pre-deploy scripts — the served build 13 was
verified current via live probes; the fix is reloading the app tab after
a deploy (walk item added).

* **Date range**: qf/clf gain `from`/`to` ('YYYY-MM-DD', ''=unbounded),
  inclusive local-day window on t.createdAt (spanMs local parse — DST-safe
  by construction), applied with the other filters BEFORE paginate so CSV
  and counts follow; norms coerce legacy filter shapes.
* **noAll**: multiCombo gains an optional 6th arg suppressing its built-in
  "All" clear-row; passed ONLY by the two queue-by-state hidden-state
  pickers (in a hide-list "All" reads as hide-everything while actually
  clearing). All other combos unchanged; ledger signature kept in parity.
* **Subtitles**: static page-header explainer prose retired in BOTH apps;
  data survives (dashboard clock/date, ticket "client · opened ago",
  client name). render() hides the empty subtitle node.
* **Label-above**: both Settings pages restructured so every labeled
  text/number/select renders label-above-input (.field + new compact
  .field.inline-sm/.fgrid utilities, shared blocks byte-identical across
  the two sheets). Toggles/buttons/chips stay inline. Zero handler/id
  changes — verified by byte-diffing the attribute sets before/after.

Verification: 3 implementers on disjoint files → 2 adversarial verifiers;
runtime harnesses in headless Edge (89 desk + 23 ledger checks incl.
00:00:00.000/23:59:59.999 boundaries at UTC-4 and DST-transition days);
handler/id byte-diff proves no dead controls; repo-wide grep proves no
surviving removed phrase. One parity finding (ledger client subtitle
suffix) fixed pre-push. No migrations, no endpoint changes.
