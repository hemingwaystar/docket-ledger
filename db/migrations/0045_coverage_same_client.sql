-- ============================================================================
-- 0045_coverage_same_client.sql — the same-client coverage invariant becomes
-- LAW at the database (audit). set_covered_assets always promised 'coverage
-- never silently spans clients', but the promise lived in one endpoint:
-- PATCH-moving a contract or an asset to another client left
-- assets.contract_assets rows pointing across clients — wrong coverage on
-- detail pages today, wrong billing pools when Build 29 consumes them.
--
--   1) membership guard: INSERT/UPDATE on contract_assets refuses a
--      cross-client pair outright.
--   2) self-healing moves: changing a contract's or an asset's client_id
--      prunes the memberships that no longer match, with an audit trail —
--      the exact behavior the webui approximated client-side, now enforced
--      for every caller (PATs and scripts included).
--   3) one-time cleanup of any cross-client rows already standing.
-- Triggers run as the calling role; assets_api holds DELETE on
-- contract_assets (0037's full-replace PUT) and INSERT on audit.events.
-- Transactional + idempotent (build-8b rules).
-- ============================================================================
BEGIN;

-- 3) cleanup FIRST (the guard below would not block existing rows anyway,
--    but the prune triggers only fire on future moves)
WITH gone AS (
  DELETE FROM assets.contract_assets ca
   USING assets.contracts c, assets.assets a
   WHERE c.id = ca.contract_id AND a.id = ca.asset_id
     AND c.client_id <> a.client_id
  RETURNING ca.contract_id, ca.asset_id
)
INSERT INTO audit.events (app, action, entity, detail)
SELECT 'assets', 'Cross-client coverage pruned', 'contract:' || g.contract_id,
       'asset ' || g.asset_id || ' unlinked by migration 0045 — contract and asset belong to different clients'
  FROM gone g;

-- 1) the membership guard
CREATE OR REPLACE FUNCTION assets.guard_coverage_client()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT c.client_id FROM assets.contracts c WHERE c.id = NEW.contract_id)
     IS DISTINCT FROM
     (SELECT a.client_id FROM assets.assets a WHERE a.id = NEW.asset_id) THEN
    RAISE EXCEPTION 'coverage cannot span clients — the asset belongs to a different client than the contract';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_coverage_client ON assets.contract_assets;
CREATE TRIGGER guard_coverage_client BEFORE INSERT OR UPDATE ON assets.contract_assets
  FOR EACH ROW EXECUTE FUNCTION assets.guard_coverage_client();

-- 2a) contract moves prune their now-foreign coverage
CREATE OR REPLACE FUNCTION assets.prune_contract_coverage()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  DELETE FROM assets.contract_assets ca
   USING assets.assets a
   WHERE ca.contract_id = NEW.id AND a.id = ca.asset_id
     AND a.client_id <> NEW.client_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    INSERT INTO audit.events (app, action, entity, detail)
    VALUES ('assets', 'Coverage pruned on client move', 'contract:' || NEW.id,
            n || ' asset link' || CASE WHEN n = 1 THEN '' ELSE 's' END ||
            ' dropped — the contract moved to another client');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS prune_contract_coverage ON assets.contracts;
CREATE TRIGGER prune_contract_coverage AFTER UPDATE OF client_id ON assets.contracts
  FOR EACH ROW WHEN (OLD.client_id IS DISTINCT FROM NEW.client_id)
  EXECUTE FUNCTION assets.prune_contract_coverage();

-- 2b) asset moves prune their now-foreign memberships
CREATE OR REPLACE FUNCTION assets.prune_asset_coverage()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  DELETE FROM assets.contract_assets ca
   USING assets.contracts c
   WHERE ca.asset_id = NEW.id AND c.id = ca.contract_id
     AND c.client_id <> NEW.client_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    INSERT INTO audit.events (app, action, entity, detail)
    VALUES ('assets', 'Coverage pruned on client move', 'asset:' || NEW.id,
            n || ' contract link' || CASE WHEN n = 1 THEN '' ELSE 's' END ||
            ' dropped — the asset moved to another client');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS prune_asset_coverage ON assets.assets;
CREATE TRIGGER prune_asset_coverage AFTER UPDATE OF client_id ON assets.assets
  FOR EACH ROW WHEN (OLD.client_id IS DISTINCT FROM NEW.client_id)
  EXECUTE FUNCTION assets.prune_asset_coverage();

COMMIT;
