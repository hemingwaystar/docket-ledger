-- ============================================================================
-- 0015_join_read_grants.sql — the extended audit (write verbs AND cross-
-- schema SELECT joins, per bug #22's lesson) found three reads the code
-- performs that were never granted:
--
--   ledger.billing_periods SELECT→desk_api   merge moves open-period time to
--                                            the target ticket, and project
--                                            approve queues open-period time
--                                            for review — both JOIN periods
--                                            to honor the lock. Read-only:
--                                            desk still cannot write periods.
--   desk.projects          SELECT→mail_worker the routing ladder's
--                                            reopen-on-followup exception
--                                            checks approved+locked projects;
--                                            first followup on a project
--                                            ticket would have failed the poll
-- ============================================================================
BEGIN;

GRANT SELECT ON ledger.billing_periods TO desk_api;
GRANT SELECT ON desk.projects          TO mail_worker;

COMMIT;
