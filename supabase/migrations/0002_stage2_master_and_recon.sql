-- ============================================================================
-- PULSE ECOSYSTEM - STAGE 2 MASTER SHEET & RECON SHEET REPLACEMENT SCHEMA
-- ============================================================================
-- Security model:
-- 1. Row-Level Security (RLS) is enabled on 100% of tables with default-deny
--    for public/anon roles.
-- 2. All database access occurs server-side via Next.js API routes behind
--    authenticated JWT sessions and role/client permission guards.
-- 3. Multi-tenant tables enforce tenant isolation via client_id / client_name.
-- ============================================================================

-- ============================================================================
-- 1. TENANT KEY INFO & CONFIGURATION (Replaces Master KeyInfo & DataChgAlert)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.tenant_key_info (
  client_id UUID PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL UNIQUE,
  normalized_key TEXT NOT NULL UNIQUE,
  fy_start_date TEXT DEFAULT '',
  revenue_or_income_mode TEXT DEFAULT 'Revenue',
  direct_costs_mode TEXT DEFAULT 'Contractors',
  accounting_tool TEXT DEFAULT 'None',
  crm_tool TEXT DEFAULT 'None',
  crm_drives TEXT DEFAULT 'NA',
  primary_currency TEXT DEFAULT 'GBP',
  currency_symbol TEXT DEFAULT '£',
  invoice_method TEXT DEFAULT 'Whole',
  contractor_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  passthrough_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  tracked_bank_accounts JSONB NOT NULL DEFAULT '[]'::jsonb,
  tracked_non_cash_accounts JSONB NOT NULL DEFAULT '[]'::jsonb,
  overhead_mappings JSONB NOT NULL DEFAULT '[]'::jsonb,
  product_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  lead_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  crm_field_mappings JSONB NOT NULL DEFAULT '{}'::jsonb,
  kpi_colour_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  tolerance_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  portal_feature_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_importrange_backup JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_materialized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_key_info_norm_key ON public.tenant_key_info (normalized_key);

DROP TRIGGER IF EXISTS trg_tenant_key_info_updated_at ON public.tenant_key_info;
CREATE TRIGGER trg_tenant_key_info_updated_at
  BEFORE UPDATE ON public.tenant_key_info
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.tenant_key_info ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 2. MASTER & RECON VIRTUAL SHEET GRIDS (Coordinate-accurate storage & Inspector)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.master_sheet_grids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  sheet_role TEXT NOT NULL DEFAULT 'master' CHECK (sheet_role IN ('master', 'recon')),
  tab_name TEXT NOT NULL,
  values_grid JSONB NOT NULL DEFAULT '[]'::jsonb,
  formulas_grid JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes_grid JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count INTEGER NOT NULL DEFAULT 0,
  col_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_name, sheet_role, tab_name)
);

CREATE INDEX IF NOT EXISTS idx_master_sheet_grids_lookup ON public.master_sheet_grids (client_name, sheet_role, tab_name);
CREATE INDEX IF NOT EXISTS idx_master_sheet_grids_client_id ON public.master_sheet_grids (client_id);

DROP TRIGGER IF EXISTS trg_master_sheet_grids_updated_at ON public.master_sheet_grids;
CREATE TRIGGER trg_master_sheet_grids_updated_at
  BEFORE UPDATE ON public.master_sheet_grids
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.master_sheet_grids ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 3. ACCOUNTING INVOICES (Replaces InvFromApp & powers InvComp)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.accounting_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  external_id TEXT NOT NULL DEFAULT '',
  invoice_number TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  account_code TEXT DEFAULT '',
  tax_type TEXT DEFAULT '',
  tracking_category TEXT DEFAULT '',
  issue_date TEXT DEFAULT '',
  due_date TEXT DEFAULT '',
  fully_paid_date TEXT DEFAULT '',
  status TEXT DEFAULT '',
  invoice_type TEXT DEFAULT 'ACCREC',
  sub_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total NUMERIC(14, 2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(14, 2) NOT NULL DEFAULT 0,
  amount_due NUMERIC(14, 2) NOT NULL DEFAULT 0,
  currency_code TEXT DEFAULT 'GBP',
  currency_rate NUMERIC(14, 6) DEFAULT 1,
  line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_row JSONB NOT NULL DEFAULT '[]'::jsonb,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounting_invoices_client ON public.accounting_invoices (client_name);
CREATE INDEX IF NOT EXISTS idx_accounting_invoices_inv_no ON public.accounting_invoices (client_name, invoice_number);
CREATE INDEX IF NOT EXISTS idx_accounting_invoices_ext_id ON public.accounting_invoices (client_name, external_id);

DROP TRIGGER IF EXISTS trg_accounting_invoices_updated_at ON public.accounting_invoices;
CREATE TRIGGER trg_accounting_invoices_updated_at
  BEFORE UPDATE ON public.accounting_invoices
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.accounting_invoices ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 4. ACCOUNTING DIRECT COSTS & BILLS (Replaces JnlsFromApp & powers DirComp)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.accounting_direct_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  external_id TEXT NOT NULL DEFAULT '',
  cost_type TEXT NOT NULL DEFAULT 'contractor' CHECK (cost_type IN ('contractor', 'pass_through', 'overhead')),
  supplier_name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  account_code TEXT DEFAULT '',
  account_name TEXT DEFAULT '',
  txn_date TEXT DEFAULT '',
  due_date TEXT DEFAULT '',
  paid_date TEXT DEFAULT '',
  net_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  vat_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  gross_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(14, 2) NOT NULL DEFAULT 0,
  amount_due NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status TEXT DEFAULT '',
  reference TEXT DEFAULT '',
  currency_code TEXT DEFAULT 'GBP',
  currency_rate NUMERIC(14, 6) DEFAULT 1,
  raw_row JSONB NOT NULL DEFAULT '[]'::jsonb,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounting_direct_costs_client ON public.accounting_direct_costs (client_name);
CREATE INDEX IF NOT EXISTS idx_accounting_direct_costs_ext_id ON public.accounting_direct_costs (client_name, external_id);

DROP TRIGGER IF EXISTS trg_accounting_direct_costs_updated_at ON public.accounting_direct_costs;
CREATE TRIGGER trg_accounting_direct_costs_updated_at
  BEFORE UPDATE ON public.accounting_direct_costs
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.accounting_direct_costs ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 5. ACCOUNTING P&L LINES (Replaces PLFromApp & powers PLComp + Row 300)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.accounting_pl_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  month_date TEXT NOT NULL,
  section TEXT NOT NULL DEFAULT 'overheads',
  account_name TEXT NOT NULL,
  basis TEXT NOT NULL DEFAULT 'accrual' CHECK (basis IN ('accrual', 'cash')),
  net_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  vat_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  transactions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_name, month_date, account_name, basis)
);

CREATE INDEX IF NOT EXISTS idx_accounting_pl_lines_client_month ON public.accounting_pl_lines (client_name, month_date);

DROP TRIGGER IF EXISTS trg_accounting_pl_lines_updated_at ON public.accounting_pl_lines;
CREATE TRIGGER trg_accounting_pl_lines_updated_at
  BEFORE UPDATE ON public.accounting_pl_lines
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.accounting_pl_lines ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 6. CRM DEALS RAW (Replaces DataFromCRM & powers CRMList / CRMComp)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.crm_deals_raw (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  external_id TEXT NOT NULL,
  deal_name TEXT NOT NULL DEFAULT '',
  company_name TEXT NOT NULL DEFAULT '',
  project_code TEXT DEFAULT '',
  revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  direct_costs NUMERIC(14, 2) NOT NULL DEFAULT 0,
  start_date TEXT DEFAULT '',
  end_date TEXT DEFAULT '',
  date_confirmed TEXT DEFAULT '',
  likelihood TEXT DEFAULT '',
  status TEXT DEFAULT '',
  deal_type TEXT DEFAULT 'Project',
  product_line TEXT DEFAULT '',
  lead_source TEXT DEFAULT '',
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_name, external_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_deals_raw_client ON public.crm_deals_raw (client_name);

DROP TRIGGER IF EXISTS trg_crm_deals_raw_updated_at ON public.crm_deals_raw;
CREATE TRIGGER trg_crm_deals_raw_updated_at
  BEFORE UPDATE ON public.crm_deals_raw
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.crm_deals_raw ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 7. TIME ENTRIES RAW (Replaces TimeComp)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.time_entries_raw (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  month_date TEXT NOT NULL,
  staff_name TEXT NOT NULL,
  client_label TEXT NOT NULL DEFAULT '',
  job_label TEXT NOT NULL DEFAULT '',
  hours_logged NUMERIC(10, 2) NOT NULL DEFAULT 0,
  billable_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  cost_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_name, month_date, staff_name, job_label)
);

CREATE INDEX IF NOT EXISTS idx_time_entries_raw_client ON public.time_entries_raw (client_name, month_date);

DROP TRIGGER IF EXISTS trg_time_entries_raw_updated_at ON public.time_entries_raw;
CREATE TRIGGER trg_time_entries_raw_updated_at
  BEFORE UPDATE ON public.time_entries_raw
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.time_entries_raw ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 8. BANK RECON PERIODS (Replaces Recon Sheet YYMM period metadata & summaries)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.bank_recon_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  month_key TEXT NOT NULL,
  iso_month TEXT NOT NULL DEFAULT '',
  accounting_platform TEXT NOT NULL DEFAULT 'Xero',
  is_complete BOOLEAN NOT NULL DEFAULT FALSE,
  actuals_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  comparisons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  breakdowns_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  pl_adds_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_name, month_key)
);

CREATE INDEX IF NOT EXISTS idx_bank_recon_periods_client ON public.bank_recon_periods (client_name, month_key);

DROP TRIGGER IF EXISTS trg_bank_recon_periods_updated_at ON public.bank_recon_periods;
CREATE TRIGGER trg_bank_recon_periods_updated_at
  BEFORE UPDATE ON public.bank_recon_periods
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.bank_recon_periods ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 9. BANK RECON ITEMS (Replaces Recon Sheet YYMM transactions & unreconciled rows)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.bank_recon_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  month_key TEXT NOT NULL,
  item_type TEXT NOT NULL DEFAULT 'reconciled' CHECK (item_type IN ('reconciled', 'unreconciled', 'non_cash', 'pl_add')),
  row_index INTEGER NOT NULL DEFAULT 0,
  is_reconciled BOOLEAN NOT NULL DEFAULT TRUE,
  txn_date TEXT DEFAULT '',
  account_name TEXT DEFAULT '',
  payee TEXT DEFAULT '',
  particulars TEXT DEFAULT '',
  reference TEXT DEFAULT '',
  out_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  in_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  net_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  vat_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  category TEXT DEFAULT '',
  vat_applies TEXT DEFAULT 'No',
  is_new BOOLEAN NOT NULL DEFAULT FALSE,
  is_excluded BOOLEAN NOT NULL DEFAULT FALSE,
  matched_cell_coord TEXT DEFAULT '',
  is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_recon_items_client_month ON public.bank_recon_items (client_name, month_key, item_type);

DROP TRIGGER IF EXISTS trg_bank_recon_items_updated_at ON public.bank_recon_items;
CREATE TRIGGER trg_bank_recon_items_updated_at
  BEFORE UPDATE ON public.bank_recon_items
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.bank_recon_items ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 10. BANK RECON LEARNING MAP (Replaces Recon Sheet historical category training)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.bank_recon_learning_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  match_pattern TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_name, match_pattern)
);

CREATE INDEX IF NOT EXISTS idx_bank_recon_learning_client ON public.bank_recon_learning_map (client_name);

DROP TRIGGER IF EXISTS trg_bank_recon_learning_updated_at ON public.bank_recon_learning_map;
CREATE TRIGGER trg_bank_recon_learning_updated_at
  BEFORE UPDATE ON public.bank_recon_learning_map
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.bank_recon_learning_map ENABLE ROW LEVEL SECURITY;

