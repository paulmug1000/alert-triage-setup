-- ============================================================================
-- PULSE ECOSYSTEM — MIGRATION 0013: PHASE 3 RELATIONAL OPERATING INPUTS
-- ============================================================================
-- Zero-cap UUID tables for Salaries, Outgoings, Contractor OutgNotes blocks,
-- NB to find, Budgets, Cash adjustments, and Bank balance breakdowns, plus
-- Phase 2C/3 client mode flags and Phase 3 foreign keys on `pulse_notes`.
--
-- Security model (Rule 15):
-- 1. Row-Level Security (RLS) is enabled with default-deny policies for
--    `anon` and `authenticated`; all runtime access passes through Next.js API
--    routes using `service_role` behind authenticated JWT & tenant checks.
-- 2. Every child record is tenant-scoped via `client_id` + `client_name` and
--    cascades cleanly on client deletion.
-- ============================================================================

-- ============================================================================
-- 1. PROMOTE PHASE 2C READ FLAG & ADD PHASE 3 MODE FLAGS ON `public.clients`
-- ============================================================================
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS jobs_read_mode TEXT NOT NULL DEFAULT 'grid';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clients_jobs_read_mode_check'
      AND conrelid = 'public.clients'::regclass
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_jobs_read_mode_check
      CHECK (jobs_read_mode IN ('grid', 'relational'));
  END IF;
END $$;

UPDATE public.clients
SET jobs_read_mode = 'relational'
WHERE COALESCE(metadata->>'jobs_read_mode', '') = 'relational'
  AND jobs_read_mode IS DISTINCT FROM 'relational';

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS inputs_mode TEXT NOT NULL DEFAULT 'grid';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clients_inputs_mode_check'
      AND conrelid = 'public.clients'::regclass
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_inputs_mode_check
      CHECK (inputs_mode IN ('grid', 'relational'));
  END IF;
END $$;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS inputs_read_mode TEXT NOT NULL DEFAULT 'grid';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clients_inputs_read_mode_check'
      AND conrelid = 'public.clients'::regclass
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_inputs_read_mode_check
      CHECK (inputs_read_mode IN ('grid', 'relational'));
  END IF;
END $$;

-- ============================================================================
-- 2. PULSE EMPLOYEES (Salaries zero-cap UUID table)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  sheet_row_num INTEGER,
  employee_name TEXT NOT NULL DEFAULT '',
  role_title TEXT NOT NULL DEFAULT '',
  fte_salary NUMERIC(14, 2) NOT NULL DEFAULT 0,
  fte NUMERIC(10, 4) NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT NOT NULL DEFAULT '',
  delivery_pct NUMERIC(10, 6) NOT NULL DEFAULT 0,
  student_loan_plan TEXT NOT NULL DEFAULT '',
  pension_pct TEXT NOT NULL DEFAULT '',
  monthly_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  monthly_forecasts JSONB NOT NULL DEFAULT '{}'::jsonb,
  monthly_effective JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_scalars JSONB NOT NULL DEFAULT '{}'::jsonb,
  custom_formulas JSONB NOT NULL DEFAULT '{}'::jsonb,
  cell_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pulse_employees_client_sort
  ON public.pulse_employees (client_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_pulse_employees_client_row
  ON public.pulse_employees (client_id, sheet_row_num);

DROP TRIGGER IF EXISTS trg_pulse_employees_updated_at ON public.pulse_employees;
CREATE TRIGGER trg_pulse_employees_updated_at
  BEFORE UPDATE ON public.pulse_employees
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_employees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_employees_deny_all_anon ON public.pulse_employees;
CREATE POLICY pulse_employees_deny_all_anon
  ON public.pulse_employees
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_employees FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_employees TO postgres, service_role;

-- ============================================================================
-- 3. PULSE OUTGOING ITEMS (Contractors, Dividends, Expenses, System rows)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_outgoing_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  section TEXT NOT NULL CHECK (section IN ('contractor', 'making_up_cos', 'dividend', 'expense', 'system')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  sheet_row_num INTEGER,
  name TEXT NOT NULL DEFAULT '',
  vat_applicable TEXT NOT NULL DEFAULT 'No',
  invoice_timing TEXT NOT NULL DEFAULT 'Curr',
  payment_timing TEXT NOT NULL DEFAULT 'Curr',
  delivery_pct NUMERIC(10, 6) NOT NULL DEFAULT 0,
  is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
  is_system_row BOOLEAN NOT NULL DEFAULT FALSE,
  monthly_amounts JSONB NOT NULL DEFAULT '{}'::jsonb,
  fy_totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_scalars JSONB NOT NULL DEFAULT '{}'::jsonb,
  custom_formulas JSONB NOT NULL DEFAULT '{}'::jsonb,
  cell_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pulse_outgoing_items_client_sec_sort
  ON public.pulse_outgoing_items (client_id, section, sort_order);

CREATE INDEX IF NOT EXISTS idx_pulse_outgoing_items_client_row
  ON public.pulse_outgoing_items (client_id, sheet_row_num);

DROP TRIGGER IF EXISTS trg_pulse_outgoing_items_updated_at ON public.pulse_outgoing_items;
CREATE TRIGGER trg_pulse_outgoing_items_updated_at
  BEFORE UPDATE ON public.pulse_outgoing_items
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_outgoing_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_outgoing_items_deny_all_anon ON public.pulse_outgoing_items;
CREATE POLICY pulse_outgoing_items_deny_all_anon
  ON public.pulse_outgoing_items
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_outgoing_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_outgoing_items TO postgres, service_role;

-- ============================================================================
-- 4. PULSE CONTRACTOR ENTRIES (Normalized OutgNotes bill/placeholder/note blocks)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_contractor_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  outgoing_item_id UUID REFERENCES public.pulse_outgoing_items(id) ON DELETE CASCADE,
  accounting_direct_cost_id UUID REFERENCES public.accounting_direct_costs(id) ON DELETE SET NULL,
  entry_type TEXT NOT NULL DEFAULT 'bill' CHECK (entry_type IN ('bill', 'placeholder', 'note')),
  sheet_row_num INTEGER NOT NULL,
  sheet_col_idx INTEGER NOT NULL,
  fy_index INTEGER NOT NULL DEFAULT 1,
  month_index INTEGER NOT NULL DEFAULT 0,
  period_ym TEXT NOT NULL DEFAULT '',
  block_order INTEGER NOT NULL DEFAULT 0,
  external_app_id TEXT NOT NULL DEFAULT '',
  amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '',
  received_date TEXT NOT NULL DEFAULT '',
  payment_date TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  is_placeholder BOOLEAN NOT NULL DEFAULT FALSE,
  raw_block TEXT NOT NULL DEFAULT '',
  custom_formula TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pulse_contractor_entries_cell
  ON public.pulse_contractor_entries (client_id, sheet_row_num, sheet_col_idx, block_order);

CREATE INDEX IF NOT EXISTS idx_pulse_contractor_entries_item
  ON public.pulse_contractor_entries (outgoing_item_id)
  WHERE outgoing_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_contractor_entries_app_id
  ON public.pulse_contractor_entries (client_id, external_app_id)
  WHERE external_app_id <> '';

CREATE INDEX IF NOT EXISTS idx_pulse_contractor_entries_acc_id
  ON public.pulse_contractor_entries (accounting_direct_cost_id)
  WHERE accounting_direct_cost_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_pulse_contractor_entries_updated_at ON public.pulse_contractor_entries;
CREATE TRIGGER trg_pulse_contractor_entries_updated_at
  BEFORE UPDATE ON public.pulse_contractor_entries
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_contractor_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_contractor_entries_deny_all_anon ON public.pulse_contractor_entries;
CREATE POLICY pulse_contractor_entries_deny_all_anon
  ON public.pulse_contractor_entries
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_contractor_entries FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_contractor_entries TO postgres, service_role;

-- ============================================================================
-- 5. PULSE NB TO FIND (Per-client targets, settings & reconciled rollups)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_nb_to_find (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  use_targets TEXT NOT NULL DEFAULT 'No',
  use_budget_for_targets TEXT NOT NULL DEFAULT 'No',
  direct_costs_pct TEXT NOT NULL DEFAULT '0%',
  manual_revenue_targets JSONB NOT NULL DEFAULT '{}'::jsonb,
  manual_direct_costs JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_income_targets JSONB NOT NULL DEFAULT '{}'::jsonb,
  budget_targets JSONB NOT NULL DEFAULT '{}'::jsonb,
  dc_calc_row JSONB NOT NULL DEFAULT '{}'::jsonb,
  use_nb_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  reconciled_rollups JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_cells JSONB NOT NULL DEFAULT '{}'::jsonb,
  custom_formulas JSONB NOT NULL DEFAULT '{}'::jsonb,
  cell_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id)
);

DROP TRIGGER IF EXISTS trg_pulse_nb_to_find_updated_at ON public.pulse_nb_to_find;
CREATE TRIGGER trg_pulse_nb_to_find_updated_at
  BEFORE UPDATE ON public.pulse_nb_to_find
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_nb_to_find ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_nb_to_find_deny_all_anon ON public.pulse_nb_to_find;
CREATE POLICY pulse_nb_to_find_deny_all_anon
  ON public.pulse_nb_to_find
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_nb_to_find FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_nb_to_find TO postgres, service_role;

-- ============================================================================
-- 6. PULSE BUDGET ITEMS (Budget zero-cap UUID table)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_budget_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  section TEXT NOT NULL CHECK (section IN ('revenue', 'direct_cost', 'salary', 'dividend', 'contractor', 'making_up_cos', 'expense')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  sheet_row_num INTEGER,
  name TEXT NOT NULL DEFAULT '',
  equiv_salary NUMERIC(14, 2) NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT NOT NULL DEFAULT '',
  delivery_pct NUMERIC(10, 6) NOT NULL DEFAULT 0,
  making_up_cos_pct NUMERIC(10, 6) NOT NULL DEFAULT 0,
  monthly_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  fy_totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_scalars JSONB NOT NULL DEFAULT '{}'::jsonb,
  custom_formulas JSONB NOT NULL DEFAULT '{}'::jsonb,
  cell_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pulse_budget_items_client_sec_sort
  ON public.pulse_budget_items (client_id, section, sort_order);

CREATE INDEX IF NOT EXISTS idx_pulse_budget_items_client_row
  ON public.pulse_budget_items (client_id, sheet_row_num);

DROP TRIGGER IF EXISTS trg_pulse_budget_items_updated_at ON public.pulse_budget_items;
CREATE TRIGGER trg_pulse_budget_items_updated_at
  BEFORE UPDATE ON public.pulse_budget_items
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_budget_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_budget_items_deny_all_anon ON public.pulse_budget_items;
CREATE POLICY pulse_budget_items_deny_all_anon
  ON public.pulse_budget_items
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_budget_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_budget_items TO postgres, service_role;

-- ============================================================================
-- 7. PULSE CASH ADJUSTMENTS & BANK BALANCES (Replaces Cash overrides & system_config blob)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_cash_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  sheet_row_num INTEGER NOT NULL,
  sheet_col_idx INTEGER NOT NULL,
  period_ym TEXT NOT NULL DEFAULT '',
  line_key TEXT NOT NULL DEFAULT '',
  numeric_value NUMERIC(14, 2),
  raw_value JSONB,
  formula TEXT NOT NULL DEFAULT '',
  cell_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, sheet_row_num, sheet_col_idx)
);

CREATE INDEX IF NOT EXISTS idx_pulse_cash_adjustments_client_period
  ON public.pulse_cash_adjustments (client_id, period_ym);

DROP TRIGGER IF EXISTS trg_pulse_cash_adjustments_updated_at ON public.pulse_cash_adjustments;
CREATE TRIGGER trg_pulse_cash_adjustments_updated_at
  BEFORE UPDATE ON public.pulse_cash_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_cash_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_cash_adjustments_deny_all_anon ON public.pulse_cash_adjustments;
CREATE POLICY pulse_cash_adjustments_deny_all_anon
  ON public.pulse_cash_adjustments
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_cash_adjustments FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_cash_adjustments TO postgres, service_role;

CREATE TABLE IF NOT EXISTS public.pulse_cash_bank_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  period_ym TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  basis TEXT NOT NULL DEFAULT 'manual',
  total_balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
  accounts JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, period_ym)
);

CREATE INDEX IF NOT EXISTS idx_pulse_cash_bank_balances_client
  ON public.pulse_cash_bank_balances (client_id, period_ym);

DROP TRIGGER IF EXISTS trg_pulse_cash_bank_balances_updated_at ON public.pulse_cash_bank_balances;
CREATE TRIGGER trg_pulse_cash_bank_balances_updated_at
  BEFORE UPDATE ON public.pulse_cash_bank_balances
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_cash_bank_balances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_cash_bank_balances_deny_all_anon ON public.pulse_cash_bank_balances;
CREATE POLICY pulse_cash_bank_balances_deny_all_anon
  ON public.pulse_cash_bank_balances
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_cash_bank_balances FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_cash_bank_balances TO postgres, service_role;

-- ============================================================================
-- 8. LINK CLIENT NOTES TO PHASE 3 OPERATING INPUT RECORDS
-- ============================================================================
ALTER TABLE public.pulse_notes
  ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES public.pulse_employees(id) ON DELETE SET NULL;

ALTER TABLE public.pulse_notes
  ADD COLUMN IF NOT EXISTS outgoing_item_id UUID REFERENCES public.pulse_outgoing_items(id) ON DELETE SET NULL;

ALTER TABLE public.pulse_notes
  ADD COLUMN IF NOT EXISTS contractor_entry_id UUID REFERENCES public.pulse_contractor_entries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_notes_employee_id
  ON public.pulse_notes (employee_id)
  WHERE employee_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_notes_outgoing_item_id
  ON public.pulse_notes (outgoing_item_id)
  WHERE outgoing_item_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_notes_contractor_entry_id
  ON public.pulse_notes (contractor_entry_id)
  WHERE contractor_entry_id IS NOT NULL AND deleted_at IS NULL;

NOTIFY pgrst, 'reload schema';
