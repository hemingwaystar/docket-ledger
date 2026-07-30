-- 0022_mailbox_outbound.sql — per-mailbox send eligibility
--
-- Found via a 500 on the mailbox Edit dialog (bug #30 in STATE.md): the
-- prototype's "Outbound enabled / Receive-only" flag per mailbox had no
-- column — the UI checkbox went nowhere, and bootstrap was painting the
-- GLOBAL mail.outbound_enabled onto every row. Two different levers:
--
--   * desk.mailboxes.outbound  — MAY this address ever send? (eligibility;
--     uncheck for alert-only inboxes like noc@ that must never be a sender)
--   * mail.outbound_enabled    — master switch: does the suite send AT ALL
--     (the go-live flip; false = recorded-only mode)
--
-- Default TRUE: existing mailboxes stay send-eligible, matching what the
-- UI has displayed all along; receive-only is the deliberate opt-out.
ALTER TABLE desk.mailboxes
  ADD COLUMN outbound boolean NOT NULL DEFAULT true;
