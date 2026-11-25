-- ============================================================================
-- PULSE ECOSYSTEM — MIGRATION 0014: PHASE 4A+4B MASTER RELATIONAL INGESTION
-- ============================================================================
-- Upgrades Stage 2 Master mirror tables (accounting_invoices,
-- accounting_direct_costs, accounting_pl_lines, crm_deals_raw, time_entries_raw)
-- for idempotent upserts + 100% lossless round-trip reconstruction, adds
-- pulse_master_sync_configs, and adds master_ingestion_mode / master_read_mode
-- feature flags on public.clients.
--
-- Security model (AGENTS.md Rule 15):
-- 1. Row-Level Security (RLS) is enabled on all tables with explicit
--    default-deny policies for `anon` and `authenticated`; runtime access runs
--    exclusively server-side via `service_role`.
-- 2. All tenant data is scoped by `client_id` / `client_name` with ON DELETE CASCADE.
-- ============================================================================

-- ============================================================================
-- 1. PHASE 4A+4B CLIENT MODE FLAGS ON `public.clients`
-- ============================================================================
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS master_ingestion_mode TEXT NOT NULL DEFAULT 'grid';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clients_master_ingestion_mode_check'
      AND conrelid = 'public.clients'::regclass
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_master_ingestion_mode_check
      CHECK (master_ingestion_mode IN ('grid', 'relational'));
  END IF;
END $$;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS master_read_mode TEXT NOT NULL DEFAULT 'grid';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clients_master_read_mode_check'
      AND conrelid = 'public.clients'::regclass
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_master_read_mode_check
      CHECK (master_read_mode IN ('grid', 'relational'));
  END IF;
END $$;

-- ============================================================================
-- 2. UPGRADE `public.accounting_invoices` (InvFromApp + RevFromApp)
-- ============================================================================
ALTER TABLE public.accounting_invoices
  ADD COLUMN IF NOT EXISTS record_kind TEXT NOT NULL DEFAULT 'invoice',
  ADD COLUMN IF NOT EXISTS sheet_row_num INTEGER,
  ADD COLUMN IF NOT EXISTS reference TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS sent_to_contact TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS recharged_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS draft_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounting_invoices_record_kind_check'
      AND conrelid = 'public.accounting_invoices'::regclass
  ) THEN
    ALTER TABLE public.accounting_invoices
      ADD CONSTRAINT accounting_invoices_record_kind_check
      CHECK (record_kind IN ('invoice', 'revenue_line'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_accounting_invoices_client_kind_row'
      AND conrelid = 'public.accounting_invoices'::regclass
  ) THEN
    ALTER TABLE public.accounting_invoices
      ADD CONSTRAINT uq_accounting_invoices_client_kind_row
      UNIQUE (client_id, record_kind, sheet_row_num);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_accounting_invoices_client_id_inv_no
  ON public.accounting_invoices (client_id, invoice_number);

CREATE INDEX IF NOT EXISTS idx_accounting_invoices_client_id_ext_id
  ON public.accounting_invoices (client_id, external_id);

ALTER TABLE public.accounting_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accounting_invoices_deny_all_anon ON public.accounting_invoices;
CREATE POLICY accounting_invoices_deny_all_anon
  ON public.accounting_invoices
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.accounting_invoices FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.accounting_invoices TO postgres, service_role;

-- ============================================================================
-- 3. UPGRADE `public.accounting_direct_costs` (JnlsFromApp)
-- ============================================================================
ALTER TABLE public.accounting_direct_costs
  ADD COLUMN IF NOT EXISTS sheet_row_num INTEGER,
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_accounting_direct_costs_client_row'
      AND conrelid = 'public.accounting_direct_costs'::regclass
  ) THEN
    ALTER TABLE public.accounting_direct_costs
      ADD CONSTRAINT uq_accounting_direct_costs_client_row
      UNIQUE (client_id, sheet_row_num);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_accounting_direct_costs_client_id_ext_id
  ON public.accounting_direct_costs (client_id, external_id);

ALTER TABLE public.accounting_direct_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accounting_direct_costs_deny_all_anon ON public.accounting_direct_costs;
CREATE POLICY accounting_direct_costs_deny_all_anon
  ON public.accounting_direct_costs
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.accounting_direct_costs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.accounting_direct_costs TO postgres, service_role;

-- ============================================================================
-- 4. UPGRADE `public.accounting_pl_lines` (PLFromApp + Year0PLFromApp)
-- ============================================================================
DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.accounting_pl_lines'::regclass
      AND contype = 'u'
      AND conname <> 'uq_accounting_pl_lines_client_tab_row'
  LOOP
    EXECUTE format('ALTER TABLE public.accounting_pl_lines DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE public.accounting_pl_lines
  ALTER COLUMN month_date SET DEFAULT '',
  ALTER COLUMN account_name SET DEFAULT '';

ALTER TABLE public.accounting_pl_lines
  ADD COLUMN IF NOT EXISTS source_tab TEXT NOT NULL DEFAULT 'PLFromApp',
  ADD COLUMN IF NOT EXISTS sheet_row_num INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS row_kind TEXT NOT NULL DEFAULT 'account',
  ADD COLUMN IF NOT EXISTS monthly_amounts JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS raw_row JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounting_pl_lines_source_tab_check'
      AND conrelid = 'public.accounting_pl_lines'::regclass
  ) THEN
    ALTER TABLE public.accounting_pl_lines
      ADD CONSTRAINT accounting_pl_lines_source_tab_check
      CHECK (source_tab IN ('PLFromApp', 'Year0PLFromApp'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounting_pl_lines_row_kind_check'
      AND conrelid = 'public.accounting_pl_lines'::regclass
  ) THEN
    ALTER TABLE public.accounting_pl_lines
      ADD CONSTRAINT accounting_pl_lines_row_kind_check
      CHECK (row_kind IN ('section', 'account', 'total', 'blank'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_accounting_pl_lines_client_tab_row'
      AND conrelid = 'public.accounting_pl_lines'::regclass
  ) THEN
    ALTER TABLE public.accounting_pl_lines
      ADD CONSTRAINT uq_accounting_pl_lines_client_tab_row
      UNIQUE (client_id, source_tab, sheet_row_num);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_accounting_pl_lines_client_id_tab
  ON public.accounting_pl_lines (client_id, source_tab, sheet_row_num);

ALTER TABLE public.accounting_pl_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accounting_pl_lines_deny_all_anon ON public.accounting_pl_lines;
CREATE POLICY accounting_pl_lines_deny_all_anon
  ON public.accounting_pl_lines
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.accounting_pl_lines FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.accounting_pl_lines TO postgres, service_role;

-- ============================================================================
-- 5. UPGRADE `public.crm_deals_raw` (DataFromCRM + CRMList)
-- ============================================================================
DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.crm_deals_raw'::regclass
      AND contype = 'u'
      AND conname <> 'uq_crm_deals_raw_client_row'
  LOOP
    EXECUTE format('ALTER TABLE public.crm_deals_raw DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE public.crm_deals_raw
  ALTER COLUMN external_id SET DEFAULT '';

ALTER TABLE public.crm_deals_raw
  ADD COLUMN IF NOT EXISTS sheet_row_num INTEGER,
  ADD COLUMN IF NOT EXISTS date_added TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS raw_row JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS crm_list_row JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS matched_job_id UUID REFERENCES public.pulse_jobs(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_crm_deals_raw_client_row'
      AND conrelid = 'public.crm_deals_raw'::regclass
  ) THEN
    ALTER TABLE public.crm_deals_raw
      ADD CONSTRAINT uq_crm_deals_raw_client_row
      UNIQUE (client_id, sheet_row_num);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_crm_deals_raw_client_id_ext_id
  ON public.crm_deals_raw (client_id, external_id);

CREATE INDEX IF NOT EXISTS idx_crm_deals_raw_matched_job
  ON public.crm_deals_raw (matched_job_id)
  WHERE matched_job_id IS NOT NULL;

ALTER TABLE public.crm_deals_raw ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_deals_raw_deny_all_anon ON public.crm_deals_raw;
CREATE POLICY crm_deals_raw_deny_all_anon
  ON public.crm_deals_raw
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.crm_deals_raw FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.crm_deals_raw TO postgres, service_role;

-- ============================================================================
-- 6. UPGRADE `public.time_entries_raw` (DataFromTime + ProjectsFromTime + TimeComp)
-- ============================================================================
DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.time_entries_raw'::regclass
      AND contype = 'u'
      AND conname <> 'uq_time_entries_raw_client_kind_row'
  LOOP
    EXECUTE format('ALTER TABLE public.time_entries_raw DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE public.time_entries_raw
  ALTER COLUMN month_date SET DEFAULT '',
  ALTER COLUMN staff_name SET DEFAULT '';

ALTER TABLE public.time_entries_raw
  ADD COLUMN IF NOT EXISTS entry_kind TEXT NOT NULL DEFAULT 'staff_month',
  ADD COLUMN IF NOT EXISTS sheet_row_num INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS total_hours NUMERIC(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS billable_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS non_billable_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS budget_hours NUMERIC(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS budget_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS fte NUMERIC(10, 4) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS util_target_pct NUMERIC(10, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS days_pattern TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS is_included BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES public.pulse_employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS raw_row JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'time_entries_raw_entry_kind_check'
      AND conrelid = 'public.time_entries_raw'::regclass
  ) THEN
    ALTER TABLE public.time_entries_raw
      ADD CONSTRAINT time_entries_raw_entry_kind_check
      CHECK (entry_kind IN ('staff_month', 'project_month', 'staff_config'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_time_entries_raw_client_kind_row'
      AND conrelid = 'public.time_entries_raw'::regclass
  ) THEN
    ALTER TABLE public.time_entries_raw
      ADD CONSTRAINT uq_time_entries_raw_client_kind_row
      UNIQUE (client_id, entry_kind, sheet_row_num);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_time_entries_raw_employee
  ON public.time_entries_raw (employee_id)
  WHERE employee_id IS NOT NULL;

ALTER TABLE public.time_entries_raw ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS time_entries_raw_deny_all_anon ON public.time_entries_raw;
CREATE POLICY time_entries_raw_deny_all_anon
  ON public.time_entries_raw
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.time_entries_raw FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.time_entries_raw TO postgres, service_role;

-- ============================================================================
-- 7. CREATE `public.pulse_master_sync_configs` (Master headers, mappings & controls)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_master_sync_configs (
  client_id UUID PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL UNIQUE,
  inv_headers JSONB NOT NULL DEFAULT '[]'::jsonb,
  rev_headers JSONB NOT NULL DEFAULT '[]'::jsonb,
  jnl_headers JSONB NOT NULL DEFAULT '[]'::jsonb,
  pl_headers JSONB NOT NULL DEFAULT '[]'::jsonb,
  year0_pl_headers JSONB NOT NULL DEFAULT '[]'::jsonb,
  crm_raw_headers JSONB NOT NULL DEFAULT '[]'::jsonb,
  time_data_headers JSONB NOT NULL DEFAULT '[]'::jsonb,
  time_projects_headers JSONB NOT NULL DEFAULT '[]'::jsonb,
  inv_app_list_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  jnl_app_list_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  inv_comp_controls JSONB NOT NULL DEFAULT '{}'::jsonb,
  dir_comp_controls JSONB NOT NULL DEFAULT '{}'::jsonb,
  crm_list_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  crm_comp_controls JSONB NOT NULL DEFAULT '{}'::jsonb,
  pl_comp_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  time_comp_controls JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_pulse_master_sync_configs_updated_at ON public.pulse_master_sync_configs;
CREATE TRIGGER trg_pulse_master_sync_configs_updated_at
  BEFORE UPDATE ON public.pulse_master_sync_configs
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_master_sync_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_master_sync_configs_deny_all_anon ON public.pulse_master_sync_configs;
CREATE POLICY pulse_master_sync_configs_deny_all_anon
  ON public.pulse_master_sync_configs
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_master_sync_configs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_master_sync_configs TO postgres, service_role;
