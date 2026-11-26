-- Migration 0021: Explicit deny-all RLS policies, privilege lockdown, and Stage 2 NOT NULL constraints
-- Purpose:
--   1. Ensure all Stage 1-3 public tables and pulse_private.cron_secrets have RLS enabled,
--      explicit FOR ALL TO anon, authenticated deny policies, and no PUBLIC/anon/authenticated privileges.
--   2. Revoke PUBLIC/anon/authenticated sequence privileges in schema public.
--   3. Enforce NOT NULL constraints on Stage 2 / Phase 4 foreign keys and sheet row numbers.

-- 1. Explicit RLS + privilege lockdown across Stage 1-3 public tables and cron_secrets
DO $$
DECLARE
  tbl TEXT;
  public_tables TEXT[] := ARRAY[
    'clients',
    'users',
    'tenant_integrations',
    'sync_schedules',
    'alert_memory',
    'activity_logs',
    'pma_tasks',
    'client_setup_state',
    'eom_cycles_and_tasks',
    'system_config',
    'tenant_key_info',
    'master_sheet_grids',
    'client_jobs',
    'client_outgoings',
    'client_salaries',
    'client_budgets_and_targets',
    'client_cash_balances'
  ];
BEGIN
  FOREACH tbl IN ARRAY public_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_deny_public_access', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
      tbl || '_deny_public_access',
      tbl
    );
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO postgres, service_role', tbl);
  END LOOP;
END
$$;

ALTER TABLE pulse_private.cron_secrets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cron_secrets_deny_public_access ON pulse_private.cron_secrets;
CREATE POLICY cron_secrets_deny_public_access
  ON pulse_private.cron_secrets
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE pulse_private.cron_secrets FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE pulse_private.cron_secrets TO postgres, service_role;

-- 2. Lock down public sequences
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, service_role;

-- 3. Enforce NOT NULL on Stage 2 / Phase 4 relational columns (live DB pre-verified with 0 NULL rows)
ALTER TABLE public.accounting_invoices
  ALTER COLUMN client_id SET NOT NULL,
  ALTER COLUMN sheet_row_num SET NOT NULL;

ALTER TABLE public.accounting_direct_costs
  ALTER COLUMN client_id SET NOT NULL,
  ALTER COLUMN sheet_row_num SET NOT NULL;

ALTER TABLE public.accounting_pl_lines
  ALTER COLUMN client_id SET NOT NULL;

ALTER TABLE public.crm_deals_raw
  ALTER COLUMN client_id SET NOT NULL,
  ALTER COLUMN sheet_row_num SET NOT NULL;

ALTER TABLE public.time_entries_raw
  ALTER COLUMN client_id SET NOT NULL;

ALTER TABLE public.bank_recon_periods
  ALTER COLUMN client_id SET NOT NULL;

ALTER TABLE public.bank_recon_items
  ALTER COLUMN client_id SET NOT NULL;

ALTER TABLE public.bank_recon_learning_map
  ALTER COLUMN client_id SET NOT NULL;

NOTIFY pgrst, 'reload schema';
