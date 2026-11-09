-- ============================================================================
-- PULSE ECOSYSTEM - STAGE 4 NATIVE CLIENT SHEET ENGINE & RELATIONAL TABLES
-- ============================================================================
-- Security model:
-- 1. Row-Level Security (RLS) is enabled on 100% of tables with default-deny
--    for public/anon roles.
-- 2. All database access occurs server-side via Next.js API routes behind
--    authenticated JWT sessions and role/client permission guards.
-- 3. Multi-tenant tables enforce tenant isolation via client_id / client_name.
-- ============================================================================

-- ============================================================================
-- 1. EXTEND VIRTUAL SHEET GRIDS TO SUPPORT 'client' ROLE
-- ============================================================================
ALTER TABLE public.master_sheet_grids
  DROP CONSTRAINT IF EXISTS master_sheet_grids_sheet_role_check;

ALTER TABLE public.master_sheet_grids
  ADD CONSTRAINT master_sheet_grids_sheet_role_check
  CHECK (sheet_role IN ('master', 'recon', 'client'));

-- Automatically promote any fallback 'Client::<tab>' rows to native sheet_role = 'client'
DELETE FROM public.master_sheet_grids a
USING public.master_sheet_grids b
WHERE a.client_name = b.client_name
  AND a.sheet_role = 'client'
  AND b.sheet_role = 'master'
  AND b.tab_name = ('Client::' || a.tab_name);

UPDATE public.master_sheet_grids
SET
  sheet_role = 'client',
  tab_name = substring(tab_name FROM 9),
  updated_at = NOW()
WHERE sheet_role = 'master'
  AND tab_name LIKE 'Client::%';

-- ============================================================================
-- 2. CLIENT JOBS (Replaces Client Confirmed & Pipeline tabs)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.client_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  tab_type TEXT NOT NULL DEFAULT 'confirmed' CHECK (tab_type IN ('confirmed', 'pipeline')),
  row_index INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  parent_retainer_id UUID REFERENCES public.client_jobs(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  job_name TEXT NOT NULL DEFAULT '',
  project_code TEXT DEFAULT '',
  date_confirmed TEXT DEFAULT '',
  lead_source TEXT DEFAULT '',
  job_type TEXT DEFAULT 'Project',
  product_line TEXT DEFAULT '',
  start_date TEXT DEFAULT '',
  end_date TEXT DEFAULT '',
  likelihood_pct NUMERIC(8, 4) NOT NULL DEFAULT 1,
  total_revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_direct_costs NUMERIC(14, 2) NOT NULL DEFAULT 0,
  monthly_allocations JSONB NOT NULL DEFAULT '{}'::jsonb,
  invoice_slots JSONB NOT NULL DEFAULT '[]'::jsonb,
  contractor_slots JSONB NOT NULL DEFAULT '[]'::jsonb,
  cell_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_row JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_name, tab_type, row_index)
);

CREATE INDEX IF NOT EXISTS idx_client_jobs_lookup ON public.client_jobs (client_name, tab_type, row_index);
CREATE INDEX IF NOT EXISTS idx_client_jobs_client_id ON public.client_jobs (client_id);

DROP TRIGGER IF EXISTS trg_client_jobs_updated_at ON public.client_jobs;
CREATE TRIGGER trg_client_jobs_updated_at
  BEFORE UPDATE ON public.client_jobs
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.client_jobs ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 3. CLIENT OUTGOINGS (Replaces Client Outgoings tab Rows 13-225)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.client_outgoings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  section TEXT NOT NULL DEFAULT 'expense' CHECK (section IN ('contractor', 'cos_topup', 'expense')),
  row_index INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  vat_applicable TEXT DEFAULT 'No',
  invoice_status TEXT DEFAULT '',
  pay_status TEXT DEFAULT '',
  delivery_pct NUMERIC(8, 4) NOT NULL DEFAULT 0,
  likelihood_pct NUMERIC(8, 4) NOT NULL DEFAULT 1,
  monthly_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  cell_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_row JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_name, row_index)
);

CREATE INDEX IF NOT EXISTS idx_client_outgoings_lookup ON public.client_outgoings (client_name, section, row_index);
CREATE INDEX IF NOT EXISTS idx_client_outgoings_client_id ON public.client_outgoings (client_id);

DROP TRIGGER IF EXISTS trg_client_outgoings_updated_at ON public.client_outgoings;
CREATE TRIGGER trg_client_outgoings_updated_at
  BEFORE UPDATE ON public.client_outgoings
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.client_outgoings ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 4. CLIENT SALARIES (Replaces Client Salaries tab)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.client_salaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  employee_name TEXT NOT NULL DEFAULT '',
  role_title TEXT DEFAULT '',
  fte_salary NUMERIC(14, 2) NOT NULL DEFAULT 0,
  fte_fraction NUMERIC(8, 4) NOT NULL DEFAULT 1,
  start_date TEXT DEFAULT '',
  end_date TEXT DEFAULT '',
  delivery_pct NUMERIC(8, 4) NOT NULL DEFAULT 0,
  student_loan_plan TEXT DEFAULT 'None',
  pension_opt_in TEXT DEFAULT 'Yes',
  likelihood_pct NUMERIC(8, 4) NOT NULL DEFAULT 1,
  monthly_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_row JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_name, row_index)
);

CREATE INDEX IF NOT EXISTS idx_client_salaries_lookup ON public.client_salaries (client_name, row_index);
CREATE INDEX IF NOT EXISTS idx_client_salaries_client_id ON public.client_salaries (client_id);

DROP TRIGGER IF EXISTS trg_client_salaries_updated_at ON public.client_salaries;
CREATE TRIGGER trg_client_salaries_updated_at
  BEFORE UPDATE ON public.client_salaries
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.client_salaries ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 5. CLIENT BUDGETS & TARGETS (Replaces Client Budget & NBtoFind tabs)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.client_budgets_and_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  model_type TEXT NOT NULL DEFAULT 'budget' CHECK (model_type IN ('budget', 'nb_to_find')),
  row_index INTEGER NOT NULL,
  line_key TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  monthly_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_row JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_name, model_type, row_index)
);

CREATE INDEX IF NOT EXISTS idx_client_budgets_lookup ON public.client_budgets_and_targets (client_name, model_type, row_index);
CREATE INDEX IF NOT EXISTS idx_client_budgets_client_id ON public.client_budgets_and_targets (client_id);

DROP TRIGGER IF EXISTS trg_client_budgets_updated_at ON public.client_budgets_and_targets;
CREATE TRIGGER trg_client_budgets_updated_at
  BEFORE UPDATE ON public.client_budgets_and_targets
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.client_budgets_and_targets ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 6. CLIENT CASH BALANCES (Replaces Client Cash opening/actual balances & adjustments)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.client_cash_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  month_date TEXT NOT NULL,
  col_index INTEGER NOT NULL DEFAULT 0,
  account_balances JSONB NOT NULL DEFAULT '{}'::jsonb,
  adjustments JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_name, month_date)
);

CREATE INDEX IF NOT EXISTS idx_client_cash_balances_lookup ON public.client_cash_balances (client_name, month_date);
CREATE INDEX IF NOT EXISTS idx_client_cash_balances_client_id ON public.client_cash_balances (client_id);

DROP TRIGGER IF EXISTS trg_client_cash_balances_updated_at ON public.client_cash_balances;
CREATE TRIGGER trg_client_cash_balances_updated_at
  BEFORE UPDATE ON public.client_cash_balances
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.client_cash_balances ENABLE ROW LEVEL SECURITY;

