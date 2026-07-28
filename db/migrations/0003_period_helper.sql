-- ============================================================================
-- 0003_period_helper.sql — billing-period assignment lives in the DB so
-- desk-api (logging time from tickets) and ledger-api (edits, approvals)
-- can never disagree about which period an entry belongs to.
-- period_key: monthly → '2026-07' · weekly → ISO '2026-W31', from started_at
-- and the client's cycle. Get-or-create, concurrency-safe.
-- ============================================================================
BEGIN;

CREATE FUNCTION ledger.period_key_for(p_client uuid, p_at timestamptz)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE c.billing_cycle
           WHEN 'weekly' THEN to_char(p_at, 'IYYY-"W"IW')
           ELSE to_char(p_at, 'YYYY-MM')
         END
  FROM shared.clients c WHERE c.id = p_client
$$;

CREATE FUNCTION ledger.ensure_period(p_client uuid, p_at timestamptz)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE k text; pid uuid;
BEGIN
  k := ledger.period_key_for(p_client, p_at);
  IF k IS NULL THEN RAISE EXCEPTION 'unknown client %', p_client; END IF;
  INSERT INTO ledger.billing_periods (client_id, period_key)
  VALUES (p_client, k)
  ON CONFLICT (client_id, period_key) DO NOTHING;
  SELECT id INTO pid FROM ledger.billing_periods
   WHERE client_id = p_client AND period_key = k;
  RETURN pid;
END $$;

-- entries always land in the right period, even if the caller forgets
CREATE FUNCTION ledger.assign_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.period_id IS NULL THEN
    NEW.period_id := ledger.ensure_period(NEW.client_id, NEW.started_at);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assign_period BEFORE INSERT ON ledger.time_entries
  FOR EACH ROW EXECUTE FUNCTION ledger.assign_period();

GRANT EXECUTE ON FUNCTION ledger.period_key_for(uuid, timestamptz),
                          ledger.ensure_period(uuid, timestamptz)
  TO desk_api, ledger_api, mail_worker;

COMMIT;
