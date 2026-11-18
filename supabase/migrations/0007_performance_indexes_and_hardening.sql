-- ============================================================================
-- PULSE ECOSYSTEM — MIGRATION 0007: PERFORMANCE INDEXES & HARDENING
-- ============================================================================
-- 1. Drop 14 redundant single/lookup B-tree indexes already backed by UNIQUE
--    constraints or superseded by wider composite/covering indexes below.
-- 2. Add covering, composite, and partial indexes targeting the highest-frequency
--    Supabase queries across master_sheet_grids, alert_memory, and activity_logs.
-- 3. Harden pulse_set_updated_at() with explicit SECURITY INVOKER + fixed search_path.
-- ============================================================================

-- 1. Drop redundant B-tree indexes (0001 / 0002 / 0004)
DROP INDEX IF EXISTS public.idx_clients_normalized_key;
DROP INDEX IF EXISTS public.idx_users_email;
DROP INDEX IF EXISTS public.idx_tenant_integrations_client_key;
DROP INDEX IF EXISTS public.idx_sync_schedules_client_name;
DROP INDEX IF EXISTS public.idx_client_setup_state_norm_key;
DROP INDEX IF EXISTS public.idx_eom_cycles_month_client;
DROP INDEX IF EXISTS public.idx_tenant_key_info_norm_key;
DROP INDEX IF EXISTS public.idx_master_sheet_grids_lookup;
DROP INDEX IF EXISTS public.idx_master_sheet_grids_client_id;
DROP INDEX IF EXISTS public.idx_bank_recon_periods_client;
DROP INDEX IF EXISTS public.idx_client_jobs_lookup;
DROP INDEX IF EXISTS public.idx_client_salaries_lookup;
DROP INDEX IF EXISTS public.idx_client_budgets_lookup;
DROP INDEX IF EXISTS public.idx_client_cash_balances_lookup;

-- 2. Add high-value composite, covering, and partial indexes
CREATE INDEX IF NOT EXISTS idx_master_sheet_grids_role_tab
  ON public.master_sheet_grids (sheet_role, tab_name, client_name);

CREATE INDEX IF NOT EXISTS idx_master_sheet_grids_meta_cover
  ON public.master_sheet_grids (client_name, sheet_role, tab_name)
  INCLUDE (row_count, col_count, updated_at);

CREATE INDEX IF NOT EXISTS idx_master_sheet_grids_client_role_tab
  ON public.master_sheet_grids (client_id, sheet_role, tab_name);

CREATE INDEX IF NOT EXISTS idx_alert_memory_row_idx
  ON public.alert_memory (sheet_row_index ASC);

CREATE INDEX IF NOT EXISTS idx_alert_memory_handled_ordered
  ON public.alert_memory (sheet_row_index ASC)
  INCLUDE (fingerprint_hash, status)
  WHERE status NOT IN ('cached', 'pending_automation');

CREATE INDEX IF NOT EXISTS idx_alert_memory_status_client_row
  ON public.alert_memory (status, client_name, sheet_row_index ASC);

CREATE INDEX IF NOT EXISTS idx_alert_memory_updated_desc
  ON public.alert_memory (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_logs_source_logged
  ON public.activity_logs (source, logged_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_logs_source_client_lower
  ON public.activity_logs (source, lower(client_name), logged_at DESC);

-- 3. Harden timestamp trigger helper function
CREATE OR REPLACE FUNCTION public.pulse_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
