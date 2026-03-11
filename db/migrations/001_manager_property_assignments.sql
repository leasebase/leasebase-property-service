-- property_service schema: manager_property_assignments table
-- Idempotent: safe to re-run on existing databases (IF NOT EXISTS guards).
--
-- NOTE: properties + units tables already exist in property_service schema
-- (created prior to this migration). This migration adds the
-- manager_property_assignments table used by PM scope resolution.
--
-- Run as leasebase_admin:
--   psql -h <host> -U leasebase_admin -d leasebase -f db/migrations/001_manager_property_assignments.sql

SET search_path TO property_service, public;

CREATE TABLE IF NOT EXISTS manager_property_assignments (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id  TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  property_id      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mpa_org_user
  ON manager_property_assignments(organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_mpa_org_property
  ON manager_property_assignments(organization_id, property_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mpa_org_user_property_unique
  ON manager_property_assignments(organization_id, user_id, property_id);
