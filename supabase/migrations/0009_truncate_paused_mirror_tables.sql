-- ============================================================================
-- PULSE ECOSYSTEM — MIGRATION 0009: TRUNCATE PAUSED MIRROR TABLES
-- ============================================================================
-- Context: Following Tier 2 Option A (v2.166+), per-edit writes to the 14
-- write-only relational mirror tables are paused by default
-- (PULSE_SYNC_NORMALIZED_MIRROR_TABLES=false), because all live Portal & PMA
-- paths read directly from `master_sheet_grids` / `tenant_key_info` /
-- `alert_memory` / `clients`.
--
-- What this migration does (idempotent):
--   Safely truncates the ~27,800 stale historical rows in those 14 paused
--   mirror tables to reclaim Postgres table & index disk space immediately.
--   Table schemas remain intact so `Backfill SQL mirror tables` or future
--   re-enablement continues to work without schema changes.
--
-- NEVER touches live runtime or control-plane tables:
--   clients, users, tenant_integrations, sync_schedules, alert_memory,
--   activity_logs, client_setup_state, eom_cycles_and_tasks, system_config,
--   tenant_key_info, master_sheet_grids.
-- ============================================================================

DO $$
DECLARE
  v_tables TEXT[] := ARRAY[
    'accounting_invoices',
    'accounting_direct_costs',
    'accounting_pl_lines',
    'crm_deals_raw',
    'time_entries_raw',
    'bank_recon_periods',
    'bank_recon_items',
    'bank_recon_learning_map',
    'client_jobs',
    'client_outgoings',
    'client_salaries',
    'client_budgets_and_targets',
    'client_cash_balances',
    'pma_tasks'
  ];
  v_tbl TEXT;
BEGIN
  FOREACH v_tbl IN ARRAY v_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      EXECUTE format('TRUNCATE TABLE public.%I RESTART IDENTITY CASCADE', v_tbl);
    END IF;
  END LOOP;
END $$;
