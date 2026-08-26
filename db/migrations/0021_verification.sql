-- 0021_verification.sql — caller verification (one-time codes over SMS/email)
--
-- The prototype's verify flow becomes real: an agent sends a 6-digit code to
-- the contact info ON FILE (never a number the caller reads out), the caller
-- reads it back, and the outcome lands on the ticket either way. This table
-- is the server-side truth for those flows — codes are stored HASHED (sha256)
-- so even a database read can't reveal one; the plaintext exists only in the
-- outbound message.
--
-- Conventions honored:
--   * append-only migration; no edits to prior files
--   * desk_api gets DML via the 0005 DEFAULT PRIVILEGES on schema desk —
--     no per-table grant needed here
--   * the verification feature is CUSTOMER-TOUCHING → its config seeds with
--     BOTH channels disabled (same default-off stance as mail.outbound_enabled);
--     enabling a channel in Settings is the conscious go-live flip

-- BEGIN/COMMIT retrofitted (audit): a mid-file failure must roll back clean
-- and never leave unrecorded half-applied DDL. Applied DBs skip this file.
BEGIN;

CREATE TABLE desk.verifications (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id     bigint      NOT NULL REFERENCES desk.tickets(id),
    contact_id    uuid                 REFERENCES shared.contacts(id),
    channel       text        NOT NULL CHECK (channel IN ('sms', 'email')),
    masked        text        NOT NULL,             -- what the agent saw: ***3390 / b***@r***.com
    code_hash     text        NOT NULL,             -- sha256 hex of the 6 digits
    expires_at    timestamptz NOT NULL,
    attempts_left int         NOT NULL,
    status        text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'verified', 'failed', 'expired')),
    created_by    uuid REFERENCES shared.agents(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    resolved_at   timestamptz
);

-- the start endpoint expires prior pending rows per ticket; this keeps that
-- lookup (and the check endpoint's fetch) on an index
CREATE INDEX verifications_ticket_pending
    ON desk.verifications (ticket_id) WHERE status = 'pending';

-- Default-OFF seed. If an operator already saved the card (key exists), the
-- ON CONFLICT leaves their values alone — bug #29's lesson says to note that
-- explicitly: BOTH consumers (verification.py, the settings card) read this
-- exact shape, and verification.py tolerates missing keys with these same
-- defaults, so a pre-existing partial value cannot crash the feature.
INSERT INTO shared.app_config (key, value) VALUES ('verification', jsonb_build_object(
    'sms',   jsonb_build_object('enabled', false, 'provider', 'voip.ms',
                                'did', '', 'apiUser', '', 'twilioSid', ''),
    'email', jsonb_build_object('enabled', false, 'from', ''),
    'ttlMin', 5, 'attempts', 3, 'postToThread', true))
ON CONFLICT (key) DO NOTHING;

COMMIT;
