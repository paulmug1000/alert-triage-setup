-- ============================================================================
-- PULSE ECOSYSTEM — MIGRATION 0018: PHASE 6C NATIVE ACCOUNTING & CRM CONNECTORS
-- ============================================================================
-- Phase 6C decouples external Accounting (Xero, QuickBooks Online) and CRM
-- (HubSpot, Pipedrive, Monday.com, ClickUp, Close, Capsule, Google Sheets,
-- Microsoft Excel) pull connectors from `compiledMasterGas.js` and
-- `master_sheet_grids`:
--   1. Adds `clients.connector_pull_mode` ('grid_gas' | 'shadow' | 'native')
--   2. Expands `public.pulse_master_sync_configs` with dedicated state columns
--      for external CRM identity bridges (`crm_google_bridge_grid`,
--      `crm_excel_bridge_grid`), raw Excel copy (`crm_excel_copy_grid`),
--      refreshed Chart of Accounts (`accounting_coa_categories`), and
--      connector runtime properties (`script_properties`, replacing
--      `GasScriptProps` for connector pull state & CRM swing guard locks).
--
-- Security model (AGENTS.md Rule 15):
-- 1. All Phase 6C tables remain behind existing default-deny RLS policies for
--    `anon` and `authenticated`; runtime access runs exclusively server-side
--    via `service_role`.
-- 2. All tenant state is scoped strictly by `client_id` / `client_name`.
-- ============================================================================

-- ============================================================================
-- 1. PHASE 6C CONNECTOR PULL MODE FLAG ON `public.clients`
-- ============================================================================
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS connector_pull_mode TEXT NOT NULL DEFAULT 'grid_gas';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clients_connector_pull_mode_check'
      AND conrelid = 'public.clients'::regclass
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_connector_pull_mode_check
      CHECK (connector_pull_mode IN ('grid_gas', 'shadow', 'native'));
  END IF;
END $$;

-- ============================================================================
-- 2. PHASE 6C CONNECTOR STATE COLUMNS ON `public.pulse_master_sync_configs`
-- ============================================================================
ALTER TABLE public.pulse_master_sync_configs
  ADD COLUMN IF NOT EXISTS crm_google_bridge_grid JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS crm_excel_bridge_grid JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS crm_excel_copy_grid JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS accounting_coa_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS script_properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS connectors_backfilled_at TIMESTAMPTZ;

NOTIFY pgrst, 'reload schema';
