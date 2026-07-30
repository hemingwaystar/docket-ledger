-- 0023_attachment_flows.sql — attachments become a working pipeline
--
-- desk.attachments has existed since 0001 (bytea by reviewed decision: one
-- database, atomic backups at MSP scale) but nothing wrote to it. This
-- migration adds what the flows need:
--
--   * STAGING: the composer uploads files BEFORE the article exists
--     (upload → get ids → POST the article with attachment_ids), so
--     article_id becomes nullable and staged rows remember their uploader.
--     The worker sweeps staged orphans older than a day — the one DELETE
--     in the system, allowed because a never-attached upload is internal
--     garbage, not business data (the no-DELETE rule protects the latter).
--   * INBOUND METADATA: content_id + is_inline from Graph fileAttachments,
--     stored now so inline-image rendering can be added later without
--     re-ingesting.
ALTER TABLE desk.attachments
  ALTER COLUMN article_id DROP NOT NULL,
  ADD COLUMN staged_by  uuid REFERENCES shared.agents(id),
  ADD COLUMN content_id text,
  ADD COLUMN is_inline  boolean NOT NULL DEFAULT false;

CREATE INDEX attachments_staged_idx ON desk.attachments (created_at)
  WHERE article_id IS NULL;

GRANT DELETE ON desk.attachments TO mail_worker;   -- staged-orphan sweep only
