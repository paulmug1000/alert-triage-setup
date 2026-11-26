-- ============================================================================
-- PULSE ECOSYSTEM — MIGRATION 0017: PHASE 6A + 6B NATIVE RELATIONAL COMPUTE
-- ============================================================================
-- Phase 6A: `public.pulse_client_tab_blueprints` stores compacted Client tab
--           formula blueprints + auxiliary tab structures so `client_compute_mode`
--           can run 100% natively from relational tables (`pulse_jobs`,
--           `pulse_employees`, `pulse_outgoing_items`, `pulse_contractor_entries`,
--           `pulse_nb_to_find`, `pulse_budget_items`, `pulse_cash_adjustments`,
--           `pulse_financial_*`, `pulse_recon_*`) without reading/writing `master_sheet_grids`.
-- Phase 6B: `public.pulse_master_comparisons` & expanded `public.pulse_master_sync_configs`
--           store Master comparison results (`InvAppList`, `InvDashList`, `InvComp`,
--           `JnlAppList`, `DirDashList`, `DirComp`, `CRMList`, `CRMComp`, `PLComp`,
--           `TimeComp`, `Outgoings`) and context frames (`KeyInfo`, `DataChgAlert`, `PLAdds`)
--           so `master_compute_mode` computes comparisons directly from relational tables.
--
-- Security model (AGENTS.md Rule 15):
-- 1. Row-Level Security (RLS) is enabled on all new tables with explicit
--    default-deny policies for `anon` and `authenticated`; runtime access runs
--    exclusively server-side via `service_role`.
-- 2. All tenant data is scoped by `client_id` / `client_name` with ON DELETE CASCADE.
-- ============================================================================

-- ============================================================================
-- 1. PHASE 6A + 6B CLIENT COMPUTE MODE FLAGS ON `public.clients`
-- ============================================================================
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS client_compute_mode TEXT NOT NULL DEFAULT 'grid_gas';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clients_client_compute_mode_check'
      AND conrelid = 'public.clients'::regclass
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_client_compute_mode_check
      CHECK (client_compute_mode IN ('grid_gas', 'shadow', 'native'));
  END IF;
END $$;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS master_compute_mode TEXT NOT NULL DEFAULT 'grid_gas';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clients_master_compute_mode_check'
      AND conrelid = 'public.clients'::regclass
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_master_compute_mode_check
      CHECK (master_compute_mode IN ('grid_gas', 'shadow', 'native'));
  END IF;
END $$;

-- ============================================================================
-- 2. PHASE 6A: `public.pulse_client_tab_blueprints`
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_client_tab_blueprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  tab_name TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  col_count INTEGER NOT NULL DEFAULT 0,
  base_values_grid JSONB NOT NULL DEFAULT '[]'::jsonb,
  formulas_blueprint JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pulse_client_tab_blueprints_client_tab UNIQUE (client_id, tab_name)
);

CREATE INDEX IF NOT EXISTS idx_pulse_client_tab_blueprints_client_id
  ON public.pulse_client_tab_blueprints (client_id, tab_name);

CREATE INDEX IF NOT EXISTS idx_pulse_client_tab_blueprints_client_name
  ON public.pulse_client_tab_blueprints (client_name, tab_name);

DROP TRIGGER IF EXISTS trg_pulse_client_tab_blueprints_updated_at ON public.pulse_client_tab_blueprints;
CREATE TRIGGER trg_pulse_client_tab_blueprints_updated_at
  BEFORE UPDATE ON public.pulse_client_tab_blueprints
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_client_tab_blueprints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_client_tab_blueprints_deny_all_anon ON public.pulse_client_tab_blueprints;
CREATE POLICY pulse_client_tab_blueprints_deny_all_anon
  ON public.pulse_client_tab_blueprints
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_client_tab_blueprints FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_client_tab_blueprints TO postgres, service_role;

-- ============================================================================
-- 3. PHASE 6B: MASTER CONTEXT FRAMES ON `public.pulse_master_sync_configs`
-- ============================================================================
ALTER TABLE public.pulse_master_sync_configs
  ADD COLUMN IF NOT EXISTS master_key_info_grid JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS data_chg_alert_grid JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS master_pl_adds_grid JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ============================================================================
-- 4. PHASE 6B: `public.pulse_master_comparisons`
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_master_comparisons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  comparison_type TEXT NOT NULL CHECK (
    comparison_type IN (
      'inv_app_list',
      'inv_dash_list',
      'inv_comp',
      'jnl_app_list',
      'dir_dash_list',
      'dir_comp',
      'crm_list',
      'crm_comp',
      'pl_comp',
      'time_comp',
      'master_outgoings'
    )
  ),
  mode_label TEXT NOT NULL DEFAULT '',
  discrepancy_count INTEGER NOT NULL DEFAULT 0,
  secondary_discrepancy_count INTEGER NOT NULL DEFAULT 0,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  rows_grid JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pulse_master_comparisons_client_type UNIQUE (client_id, comparison_type)
);

CREATE INDEX IF NOT EXISTS idx_pulse_master_comparisons_client_id
  ON public.pulse_master_comparisons (client_id, comparison_type);

DROP TRIGGER IF EXISTS trg_pulse_master_comparisons_updated_at ON public.pulse_master_comparisons;
CREATE TRIGGER trg_pulse_master_comparisons_updated_at
  BEFORE UPDATE ON public.pulse_master_comparisons
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_master_comparisons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_master_comparisons_deny_all_anon ON public.pulse_master_comparisons;
CREATE POLICY pulse_master_comparisons_deny_all_anon
  ON public.pulse_master_comparisons
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_master_comparisons FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_master_comparisons TO postgres, service_role;

NOTIFY pgrst, 'reload schema';
