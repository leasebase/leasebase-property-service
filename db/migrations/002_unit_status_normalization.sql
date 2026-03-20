-- property_service: normalize unit status vocabulary AVAILABLE → VACANT
--
-- Business rationale:
--   The preferred business language for an unoccupied unit is VACANT, not AVAILABLE.
--   This migration renames all existing AVAILABLE values to VACANT and updates
--   the column default so new units are created as VACANT.
--
-- Preserved values: OCCUPIED, MAINTENANCE, OFFLINE (unchanged)
--
-- Idempotent: safe to re-run (UPDATE with explicit WHERE guard, DO block for default).
--
-- Run as leasebase_admin:
--   psql -h <host> -U leasebase_admin -d leasebase -f db/migrations/002_unit_status_normalization.sql

SET search_path TO property_service, public;

-- ── 1. Rename existing AVAILABLE rows to VACANT ───────────────────────────────

UPDATE property_service.units
SET status = 'VACANT', updated_at = NOW()
WHERE status = 'AVAILABLE';

-- ── 2. Update column default to VACANT ───────────────────────────────────────

DO $$ BEGIN
  -- Only change the default if it is still set to AVAILABLE
  -- (guards against re-runs after the default has already been updated)
  ALTER TABLE property_service.units
    ALTER COLUMN status SET DEFAULT 'VACANT';
END $$;

-- ── 3. Schema-dev compatibility note ─────────────────────────────────────────
-- The Prisma schema in leasebase-schema-dev has a corresponding migration that
-- aligns the public.Unit table default to VACANT.  Both must be deployed in sync.
