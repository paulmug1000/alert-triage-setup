-- ============================================================================
-- PULSE ECOSYSTEM — MIGRATION 0015: PHASE 4C BANK RECONCILIATION
-- ============================================================================
-- Upgrades bank_recon_periods, bank_recon_items, and bank_recon_learning_map
-- for idempotent upserts + 100% lossless YYMM reconstruction, adds
-- pulse_recon_configs (PLAdds, Data, KeyInfo, Template, tab_list), and adds
-- recon_mode / recon_read_mode feature flags on public.clients.
--
-- Security model (AGENTS.md Rule 15):
-- 1. Row-Level Security (RLS) is enabled on all tables with explicit
--    default-deny policies for `anon` and `authenticated`; runtime access runs
--    exclusively server-side via `service_role`.
-- 2. All tenant data is scoped by `client_id` / `client_name` with ON DELETE CASCADE.
-- ============================================================================

-- ============================================================================
-- 1. PHASE 4C CLIENT MODE FLAGS ON `public.clients`
-- ============================================================================
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS recon_mode TEXT NOT NULL DEFAULT 'grid';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clients_recon_mode_check'
      AND conrelid = 'public.clients'::regclass
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_recon_mode_check
      CHECK (recon_mode IN ('grid', 'relational'));
  END IF;
END $$;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS recon_read_mode TEXT NOT NULL DEFAULT 'grid';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clients_recon_read_mode_check'
      AND conrelid = 'public.clients'::regclass
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_recon_read_mode_check
      CHECK (recon_read_mode IN ('grid', 'relational'));
  END IF;
END $$;

-- ============================================================================
-- 2. UPGRADE `public.bank_recon_periods` (Monthly YYMM periods & frame metadata)
-- ============================================================================
DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.bank_recon_periods'::regclass
      AND contype = 'u'
      AND conname <> 'uq_bank_recon_periods_client_month'
  LOOP
    EXECUTE format('ALTER TABLE public.bank_recon_periods DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE public.bank_recon_periods
  ADD COLUMN IF NOT EXISTS row_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS col_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS raw_da1 TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS raw_cr2 JSONB NOT NULL DEFAULT 'null'::jsonb,
  ADD COLUMN IF NOT EXISTS period_frame JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS notes_grid JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_bank_recon_periods_client_month'
      AND conrelid = 'public.bank_recon_periods'::regclass
  ) THEN
    ALTER TABLE public.bank_recon_periods
      ADD CONSTRAINT uq_bank_recon_periods_client_month
      UNIQUE (client_id, month_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bank_recon_periods_client_id_month
  ON public.bank_recon_periods (client_id, month_key);

ALTER TABLE public.bank_recon_periods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bank_recon_periods_deny_all_anon ON public.bank_recon_periods;
CREATE POLICY bank_recon_periods_deny_all_anon
  ON public.bank_recon_periods
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.bank_recon_periods FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.bank_recon_periods TO postgres, service_role;

-- ============================================================================
-- 3. UPGRADE `public.bank_recon_items` (Reconciled bank txns + Unreconciled pool)
-- ============================================================================
DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.bank_recon_items'::regclass
      AND contype = 'u'
      AND conname <> 'uq_bank_recon_items_client_month_type_row'
  LOOP
    EXECUTE format('ALTER TABLE public.bank_recon_items DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE public.bank_recon_items
  ADD COLUMN IF NOT EXISTS period_id UUID REFERENCES public.bank_recon_periods(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS raw_row JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS raw_cp JSONB NOT NULL DEFAULT 'null'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_bank_recon_items_client_month_type_row'
      AND conrelid = 'public.bank_recon_items'::regclass
  ) THEN
    ALTER TABLE public.bank_recon_items
      ADD CONSTRAINT uq_bank_recon_items_client_month_type_row
      UNIQUE (client_id, month_key, item_type, row_index);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bank_recon_items_client_id_month
  ON public.bank_recon_items (client_id, month_key, item_type, row_index);

CREATE INDEX IF NOT EXISTS idx_bank_recon_items_period_id
  ON public.bank_recon_items (period_id)
  WHERE period_id IS NOT NULL;

ALTER TABLE public.bank_recon_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bank_recon_items_deny_all_anon ON public.bank_recon_items;
CREATE POLICY bank_recon_items_deny_all_anon
  ON public.bank_recon_items
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.bank_recon_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.bank_recon_items TO postgres, service_role;

-- ============================================================================
-- 4. UPGRADE `public.bank_recon_learning_map` (TF-IDF historical category rules)
-- ============================================================================
DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.bank_recon_learning_map'::regclass
      AND contype = 'u'
      AND conname <> 'uq_bank_recon_learning_client_id_pattern'
  LOOP
    EXECUTE format('ALTER TABLE public.bank_recon_learning_map DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE public.bank_recon_learning_map
  ADD COLUMN IF NOT EXISTS total_occurrences INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS probability NUMERIC(6, 4) NOT NULL DEFAULT 1.0000;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_bank_recon_learning_client_id_pattern'
      AND conrelid = 'public.bank_recon_learning_map'::regclass
  ) THEN
    ALTER TABLE public.bank_recon_learning_map
      ADD CONSTRAINT uq_bank_recon_learning_client_id_pattern
      UNIQUE (client_id, match_pattern);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bank_recon_learning_client_id
  ON public.bank_recon_learning_map (client_id);

ALTER TABLE public.bank_recon_learning_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bank_recon_learning_map_deny_all_anon ON public.bank_recon_learning_map;
CREATE POLICY bank_recon_learning_map_deny_all_anon
  ON public.bank_recon_learning_map
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.bank_recon_learning_map FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.bank_recon_learning_map TO postgres, service_role;

-- ============================================================================
-- 5. CREATE `public.pulse_recon_configs` (PLAdds, Data, KeyInfo, Template, tabs)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pulse_recon_configs (
  client_id UUID PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL UNIQUE,
  pl_adds_grid JSONB NOT NULL DEFAULT '[]'::jsonb,
  data_grid JSONB NOT NULL DEFAULT '[]'::jsonb,
  key_info_grid JSONB NOT NULL DEFAULT '[]'::jsonb,
  template_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  tab_list JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_pulse_recon_configs_updated_at ON public.pulse_recon_configs;
CREATE TRIGGER trg_pulse_recon_configs_updated_at
  BEFORE UPDATE ON public.pulse_recon_configs
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_recon_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_recon_configs_deny_all_anon ON public.pulse_recon_configs;
CREATE POLICY pulse_recon_configs_deny_all_anon
  ON public.pulse_recon_configs
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_recon_configs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_recon_configs TO postgres, service_role;

NOTIFY pgrst, 'reload schema';
