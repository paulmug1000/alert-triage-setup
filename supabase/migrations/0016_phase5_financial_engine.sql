-- ============================================================================
-- PULSE ECOSYSTEM — MIGRATION 0016: PHASE 5 FINANCIAL CALCULATION ENGINE
-- ============================================================================
-- Covers Phase 5A (Calcs job monthly rollups + Year0Data historical baseline),
-- Phase 5B (Dashboard, Performance & GPbyPL financial statements), and
-- Phase 5C (36-month VAT schedules, 36-month Cash flow forecast & Client
-- KeyInfo / ErrorCheck / formula blueprint configs) with 100% lossless
-- cell-for-cell reconstruction across both FORMATTED_VALUE and UNFORMATTED_VALUE.
--
-- Security model (AGENTS.md Rule 15):
-- 1. Row-Level Security (RLS) is enabled on all 6 tables with explicit
--    default-deny policies for `anon` and `authenticated`; runtime access runs
--    exclusively server-side via `service_role`.
-- 2. All tenant data is scoped by `client_id` / `client_name` with ON DELETE CASCADE.
-- ============================================================================

-- ============================================================================
-- 1. PHASE 5 CLIENT MODE FLAGS ON `public.clients`
-- ============================================================================
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS financials_mode TEXT NOT NULL DEFAULT 'grid';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clients_financials_mode_check'
      AND conrelid = 'public.clients'::regclass
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_financials_mode_check
      CHECK (financials_mode IN ('grid', 'relational'));
  END IF;
END $$;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS financials_read_mode TEXT NOT NULL DEFAULT 'grid';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clients_financials_read_mode_check'
      AND conrelid = 'public.clients'::regclass
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_financials_read_mode_check
      CHECK (financials_read_mode IN ('grid', 'relational'));
  END IF;
END $$;

-- ============================================================================
-- 2. PHASE 5A: `public.pulse_job_monthly_rollups` (Calcs monthly outputs)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_job_monthly_rollups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  month_index INTEGER NOT NULL,
  month_serial NUMERIC(14, 4),
  iso_month TEXT NOT NULL DEFAULT '',
  confirmed_revenue NUMERIC(20, 4),
  confirmed_net_income NUMERIC(20, 4),
  confirmed_direct_costs NUMERIC(20, 4),
  pipeline_revenue NUMERIC(20, 4),
  pipeline_income NUMERIC(20, 4),
  pipeline_direct_costs NUMERIC(20, 4),
  confirmed_cash_in NUMERIC(20, 4),
  pipeline_cash_in NUMERIC(20, 4),
  confirmed_direct_costs_out NUMERIC(20, 4),
  pipeline_direct_costs_out NUMERIC(20, 4),
  raw_row JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pulse_job_monthly_rollups_client_month UNIQUE (client_id, month_index)
);

CREATE INDEX IF NOT EXISTS idx_pulse_job_monthly_rollups_client_id
  ON public.pulse_job_monthly_rollups (client_id, month_index);

DROP TRIGGER IF EXISTS trg_pulse_job_monthly_rollups_updated_at ON public.pulse_job_monthly_rollups;
CREATE TRIGGER trg_pulse_job_monthly_rollups_updated_at
  BEFORE UPDATE ON public.pulse_job_monthly_rollups
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_job_monthly_rollups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_job_monthly_rollups_deny_all_anon ON public.pulse_job_monthly_rollups;
CREATE POLICY pulse_job_monthly_rollups_deny_all_anon
  ON public.pulse_job_monthly_rollups
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_job_monthly_rollups FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_job_monthly_rollups TO postgres, service_role;

-- ============================================================================
-- 3. PHASE 5A: `public.pulse_year0_lines` (Year0Data historical P&L baseline)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_year0_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  line_label TEXT NOT NULL DEFAULT '',
  fy0_months JSONB NOT NULL DEFAULT '[]'::jsonb,
  fy0_total NUMERIC(20, 4),
  raw_row JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pulse_year0_lines_client_row UNIQUE (client_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_pulse_year0_lines_client_id
  ON public.pulse_year0_lines (client_id, row_index);

DROP TRIGGER IF EXISTS trg_pulse_year0_lines_updated_at ON public.pulse_year0_lines;
CREATE TRIGGER trg_pulse_year0_lines_updated_at
  BEFORE UPDATE ON public.pulse_year0_lines
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_year0_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_year0_lines_deny_all_anon ON public.pulse_year0_lines;
CREATE POLICY pulse_year0_lines_deny_all_anon
  ON public.pulse_year0_lines
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_year0_lines FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_year0_lines TO postgres, service_role;

-- ============================================================================
-- 4. PHASE 5B: `public.pulse_financial_statements` (Dashboard, Performance, GPbyPL)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_financial_statements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  statement_type TEXT NOT NULL CHECK (statement_type IN ('dashboard', 'performance', 'gp_by_pl')),
  row_index INTEGER NOT NULL,
  section TEXT NOT NULL DEFAULT '',
  line_label TEXT NOT NULL DEFAULT '',
  fy1_months JSONB NOT NULL DEFAULT '[]'::jsonb,
  fy1_total NUMERIC(20, 4),
  fy2_months JSONB NOT NULL DEFAULT '[]'::jsonb,
  fy2_total NUMERIC(20, 4),
  fy3_months JSONB NOT NULL DEFAULT '[]'::jsonb,
  fy3_total NUMERIC(20, 4),
  raw_row JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pulse_financial_statements_client_type_row UNIQUE (client_id, statement_type, row_index)
);

CREATE INDEX IF NOT EXISTS idx_pulse_financial_statements_client_type
  ON public.pulse_financial_statements (client_id, statement_type, row_index);

DROP TRIGGER IF EXISTS trg_pulse_financial_statements_updated_at ON public.pulse_financial_statements;
CREATE TRIGGER trg_pulse_financial_statements_updated_at
  BEFORE UPDATE ON public.pulse_financial_statements
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_financial_statements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_financial_statements_deny_all_anon ON public.pulse_financial_statements;
CREATE POLICY pulse_financial_statements_deny_all_anon
  ON public.pulse_financial_statements
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_financial_statements FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_financial_statements TO postgres, service_role;

-- ============================================================================
-- 5. PHASE 5C: `public.pulse_vat_schedules` (VAT 36-month return schedules)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_vat_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  scheme TEXT NOT NULL DEFAULT '',
  line_label TEXT NOT NULL DEFAULT '',
  fy1_months JSONB NOT NULL DEFAULT '[]'::jsonb,
  fy2_months JSONB NOT NULL DEFAULT '[]'::jsonb,
  fy3_months JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_row JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pulse_vat_schedules_client_row UNIQUE (client_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_pulse_vat_schedules_client_id
  ON public.pulse_vat_schedules (client_id, row_index);

DROP TRIGGER IF EXISTS trg_pulse_vat_schedules_updated_at ON public.pulse_vat_schedules;
CREATE TRIGGER trg_pulse_vat_schedules_updated_at
  BEFORE UPDATE ON public.pulse_vat_schedules
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_vat_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_vat_schedules_deny_all_anon ON public.pulse_vat_schedules;
CREATE POLICY pulse_vat_schedules_deny_all_anon
  ON public.pulse_vat_schedules
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_vat_schedules FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_vat_schedules TO postgres, service_role;

-- ============================================================================
-- 6. PHASE 5C: `public.pulse_cashflow_lines` (Cash 36-month flow forecast)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_cashflow_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  section TEXT NOT NULL DEFAULT '',
  line_label TEXT NOT NULL DEFAULT '',
  monthly_values JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_row JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pulse_cashflow_lines_client_row UNIQUE (client_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_pulse_cashflow_lines_client_id
  ON public.pulse_cashflow_lines (client_id, row_index);

DROP TRIGGER IF EXISTS trg_pulse_cashflow_lines_updated_at ON public.pulse_cashflow_lines;
CREATE TRIGGER trg_pulse_cashflow_lines_updated_at
  BEFORE UPDATE ON public.pulse_cashflow_lines
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_cashflow_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_cashflow_lines_deny_all_anon ON public.pulse_cashflow_lines;
CREATE POLICY pulse_cashflow_lines_deny_all_anon
  ON public.pulse_cashflow_lines
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_cashflow_lines FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_cashflow_lines TO postgres, service_role;

-- ============================================================================
-- 7. CONFIG & BLUEPRINTS: `public.pulse_financial_configs`
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_financial_configs (
  client_id UUID PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL UNIQUE,
  client_key_info_grid JSONB NOT NULL DEFAULT '[]'::jsonb,
  client_key_info_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_check_grid JSONB NOT NULL DEFAULT '[]'::jsonb,
  tab_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  formula_blueprints JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_pulse_financial_configs_updated_at ON public.pulse_financial_configs;
CREATE TRIGGER trg_pulse_financial_configs_updated_at
  BEFORE UPDATE ON public.pulse_financial_configs
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_financial_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_financial_configs_deny_all_anon ON public.pulse_financial_configs;
CREATE POLICY pulse_financial_configs_deny_all_anon
  ON public.pulse_financial_configs
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_financial_configs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_financial_configs TO postgres, service_role;

NOTIFY pgrst, 'reload schema';
