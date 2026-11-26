-- ============================================================================
-- MIGRATION 0020: Phase 6E — Zero-Grid Hardening, Bridge Baselines &
--                            master_sheet_grids Retirement
-- ============================================================================
-- Moves Google Sheet bridge 3-way merge baselines out of `master_sheet_grids`
-- onto `pulse_master_sync_configs.sheet_bridge_baseline`, and adds per-tenant
-- `grid_storage_retired` + `grid_retired_at` tracking on `public.clients` so
-- obsolete `master_sheet_grids` rows can be safely audited, backed up (v2),
-- and purged per tenant or across the full estate.
-- ============================================================================

ALTER TABLE public.pulse_master_sync_configs
  ADD COLUMN IF NOT EXISTS sheet_bridge_baseline JSONB;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS grid_storage_retired BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS grid_retired_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_clients_grid_storage_retired
  ON public.clients (grid_storage_retired);

NOTIFY pgrst, 'reload schema';
