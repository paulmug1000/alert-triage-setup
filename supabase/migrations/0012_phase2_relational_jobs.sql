-- ============================================================================
-- PULSE ECOSYSTEM — MIGRATION 0012: PHASE 2 RELATIONAL JOBS, RETAINERS,
--                                   INVOICES & DIRECT EXPENSES (SLICE 1)
-- ============================================================================
-- Security model (Rule 15):
-- 1. Row-Level Security (RLS) is enabled with default-deny policies for
--    `anon` and `authenticated`; all runtime access passes through Next.js API
--    routes using `service_role` behind authenticated JWT & tenant checks.
-- 2. Every child record is tenant-scoped via `client_id` + `client_name` and
--    cascades cleanly on client deletion.
-- ============================================================================

-- 1. Per-client relational jobs rollout flag (grid | relational)
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS jobs_mode TEXT NOT NULL DEFAULT 'grid';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'clients_jobs_mode_check'
      AND conrelid = 'public.clients'::regclass
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_jobs_mode_check
      CHECK (jobs_mode IN ('grid', 'relational'));
  END IF;
END $$;

-- ============================================================================
-- 2. PULSE RETAINER SERIES (Fixed & Variable Retainer parents)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_retainer_series (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  tab_type TEXT NOT NULL DEFAULT 'confirmed' CHECK (tab_type IN ('confirmed', 'pipeline')),
  series_type TEXT NOT NULL CHECK (series_type IN ('fixed', 'variable')),
  series_key TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  series_name TEXT NOT NULL DEFAULT '',
  project_code TEXT NOT NULL DEFAULT '',
  lead_source TEXT NOT NULL DEFAULT '',
  product_line TEXT NOT NULL DEFAULT '',
  vat_applicable TEXT NOT NULL DEFAULT 'Yes',
  base_revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  base_direct_costs NUMERIC(14, 2) NOT NULL DEFAULT 0,
  billing_interval_months INTEGER NOT NULL DEFAULT 1,
  invoice_send_day INTEGER NOT NULL DEFAULT 28,
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT NOT NULL DEFAULT '',
  no_end_date BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, tab_type, series_key)
);

CREATE INDEX IF NOT EXISTS idx_pulse_retainer_series_client
  ON public.pulse_retainer_series (client_id, tab_type);

DROP TRIGGER IF EXISTS trg_pulse_retainer_series_updated_at ON public.pulse_retainer_series;
CREATE TRIGGER trg_pulse_retainer_series_updated_at
  BEFORE UPDATE ON public.pulse_retainer_series
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_retainer_series ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_retainer_series_deny_all_anon ON public.pulse_retainer_series;
CREATE POLICY pulse_retainer_series_deny_all_anon
  ON public.pulse_retainer_series
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_retainer_series FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_retainer_series TO postgres, service_role;

-- ============================================================================
-- 3. PULSE JOBS (Confirmed & Pipeline canonical job records)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  tab_type TEXT NOT NULL CHECK (tab_type IN ('confirmed', 'pipeline')),
  retainer_series_id UUID REFERENCES public.pulse_retainer_series(id) ON DELETE SET NULL,
  retainer_period_ym TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  sheet_row_num INTEGER NOT NULL,
  sheet_child_row_count INTEGER NOT NULL DEFAULT 0,
  customer_name TEXT NOT NULL DEFAULT '',
  job_name TEXT NOT NULL DEFAULT '',
  project_code TEXT NOT NULL DEFAULT '',
  lead_owner TEXT NOT NULL DEFAULT '',
  date_confirmed TEXT NOT NULL DEFAULT '',
  lead_source TEXT NOT NULL DEFAULT '',
  uneven_split TEXT NOT NULL DEFAULT '',
  revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  direct_costs NUMERIC(14, 2) NOT NULL DEFAULT 0,
  recharged_expenses NUMERIC(14, 2) NOT NULL DEFAULT 0,
  vat_applicable TEXT NOT NULL DEFAULT '',
  job_type TEXT NOT NULL DEFAULT '',
  product_line TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT NOT NULL DEFAULT '',
  no_end_date BOOLEAN NOT NULL DEFAULT FALSE,
  likelihood_pct NUMERIC(10, 6),
  copied_to_confirmed TEXT NOT NULL DEFAULT '',
  is_job_costing BOOLEAN NOT NULL DEFAULT FALSE,
  jc_start_date TEXT NOT NULL DEFAULT '',
  jc_end_date TEXT NOT NULL DEFAULT '',
  jc_fixed_variable TEXT NOT NULL DEFAULT '',
  jc_job_revenue NUMERIC(14, 2),
  jc_likelihood_input NUMERIC(10, 6),
  jc_contractor_costs NUMERIC(14, 2),
  jc_external_costs NUMERIC(14, 2),
  jc_prop_succ_fee_pct NUMERIC(10, 6),
  jc_prop_succ_fee_rec TEXT NOT NULL DEFAULT '',
  jc_inv_no TEXT NOT NULL DEFAULT '',
  raw_scalars JSONB NOT NULL DEFAULT '{}'::jsonb,
  custom_formulas JSONB NOT NULL DEFAULT '{}'::jsonb,
  extra_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  cell_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pulse_jobs_client_tab_sort
  ON public.pulse_jobs (client_id, tab_type, sort_order);

CREATE INDEX IF NOT EXISTS idx_pulse_jobs_client_tab_row
  ON public.pulse_jobs (client_id, tab_type, sheet_row_num);

CREATE INDEX IF NOT EXISTS idx_pulse_jobs_series
  ON public.pulse_jobs (retainer_series_id)
  WHERE retainer_series_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_jobs_project_code
  ON public.pulse_jobs (client_id, project_code)
  WHERE project_code <> '';

DROP TRIGGER IF EXISTS trg_pulse_jobs_updated_at ON public.pulse_jobs;
CREATE TRIGGER trg_pulse_jobs_updated_at
  BEFORE UPDATE ON public.pulse_jobs
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_jobs_deny_all_anon ON public.pulse_jobs;
CREATE POLICY pulse_jobs_deny_all_anon
  ON public.pulse_jobs
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_jobs TO postgres, service_role;

-- ============================================================================
-- 4. PULSE JOB INVOICES (Zero-cap normalized invoice slots)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_job_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  job_id UUID NOT NULL REFERENCES public.pulse_jobs(id) ON DELETE CASCADE,
  accounting_invoice_id UUID REFERENCES public.accounting_invoices(id) ON DELETE SET NULL,
  slot_order INTEGER NOT NULL DEFAULT 0,
  row_offset INTEGER NOT NULL DEFAULT 0,
  slot_index INTEGER NOT NULL DEFAULT 0 CHECK (slot_index IN (0, 1, 2)),
  amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  invoice_ref TEXT NOT NULL DEFAULT '',
  send_date TEXT NOT NULL DEFAULT '',
  days_to_pay NUMERIC(10, 2),
  status TEXT NOT NULL DEFAULT '',
  of_which_recharged NUMERIC(14, 2) NOT NULL DEFAULT 0,
  cost_month TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  is_placeholder BOOLEAN NOT NULL DEFAULT FALSE,
  raw_cells JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_formulas JSONB NOT NULL DEFAULT '{}'::jsonb,
  cell_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pulse_job_invoices_job_order
  ON public.pulse_job_invoices (job_id, slot_order);

CREATE INDEX IF NOT EXISTS idx_pulse_job_invoices_client_ref
  ON public.pulse_job_invoices (client_id, invoice_ref)
  WHERE invoice_ref <> '';

CREATE INDEX IF NOT EXISTS idx_pulse_job_invoices_acc_id
  ON public.pulse_job_invoices (accounting_invoice_id)
  WHERE accounting_invoice_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_pulse_job_invoices_updated_at ON public.pulse_job_invoices;
CREATE TRIGGER trg_pulse_job_invoices_updated_at
  BEFORE UPDATE ON public.pulse_job_invoices
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_job_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_job_invoices_deny_all_anon ON public.pulse_job_invoices;
CREATE POLICY pulse_job_invoices_deny_all_anon
  ON public.pulse_job_invoices
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_job_invoices FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_job_invoices TO postgres, service_role;

-- ============================================================================
-- 5. PULSE JOB EXPENSES (Zero-cap normalized direct cost / bill slots)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_job_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  job_id UUID NOT NULL REFERENCES public.pulse_jobs(id) ON DELETE CASCADE,
  accounting_direct_cost_id UUID REFERENCES public.accounting_direct_costs(id) ON DELETE SET NULL,
  slot_order INTEGER NOT NULL DEFAULT 0,
  row_offset INTEGER NOT NULL DEFAULT 0,
  slot_index INTEGER NOT NULL DEFAULT 0 CHECK (slot_index IN (0, 1, 2)),
  description TEXT NOT NULL DEFAULT '',
  amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  vat_applicable TEXT NOT NULL DEFAULT '',
  received_date TEXT NOT NULL DEFAULT '',
  days_to_pay NUMERIC(10, 2),
  status TEXT NOT NULL DEFAULT '',
  external_app_id TEXT NOT NULL DEFAULT '',
  is_placeholder BOOLEAN NOT NULL DEFAULT FALSE,
  raw_cells JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_formulas JSONB NOT NULL DEFAULT '{}'::jsonb,
  cell_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pulse_job_expenses_job_order
  ON public.pulse_job_expenses (job_id, slot_order);

CREATE INDEX IF NOT EXISTS idx_pulse_job_expenses_client_app_id
  ON public.pulse_job_expenses (client_id, external_app_id)
  WHERE external_app_id <> '';

CREATE INDEX IF NOT EXISTS idx_pulse_job_expenses_acc_id
  ON public.pulse_job_expenses (accounting_direct_cost_id)
  WHERE accounting_direct_cost_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_pulse_job_expenses_updated_at ON public.pulse_job_expenses;
CREATE TRIGGER trg_pulse_job_expenses_updated_at
  BEFORE UPDATE ON public.pulse_job_expenses
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_job_expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_job_expenses_deny_all_anon ON public.pulse_job_expenses;
CREATE POLICY pulse_job_expenses_deny_all_anon
  ON public.pulse_job_expenses
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_job_expenses FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_job_expenses TO postgres, service_role;

-- ============================================================================
-- 6. LINK CLIENT NOTES TO CANONICAL JOB RECORDS
-- ============================================================================
ALTER TABLE public.pulse_notes
  ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES public.pulse_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_notes_job_id
  ON public.pulse_notes (job_id)
  WHERE job_id IS NOT NULL AND deleted_at IS NULL;

NOTIFY pgrst, 'reload schema';
