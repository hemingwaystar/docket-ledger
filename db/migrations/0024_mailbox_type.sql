-- 0024_mailbox_type.sql — the mailbox Type select gets a real column
--
-- Found the same way as 0022 (bug #30's class, ledger row 38): the Edit
-- dialog's Shared/Licensed select flipped locally and snapped back on the
-- post-save hydrate. Three layers were missing at once: the mirror PATCH
-- dropped the field, no column existed to receive it, and bootstrap
-- hard-coded "shared" onto every emitted row — so the revert was
-- guaranteed even if any single layer had been fixed alone.
--
-- The type is operator-facing config, not behavior: ingestion runs on the
-- same app-scoped Graph subscription either way (shared needs no license;
-- licensed works identically). Recording it matters for license audits
-- and for knowing which addresses cost money.
--
-- Default 'shared': every existing row has displayed "Shared" all along,
-- so the default states what the UI already claimed.
ALTER TABLE desk.mailboxes
  ADD COLUMN mailbox_type text NOT NULL DEFAULT 'shared'
    CHECK (mailbox_type IN ('shared', 'licensed'));
