-- ============================================================================
-- MIGRATION 0022: Phase 6F — Dedicated Sheet Bridge Baselines Table
-- ============================================================================
-- Isolates multi-MB Google Sheet Bridge 3-way merge baselines out of
-- `pulse_master_sync_configs.sheet_bridge_baseline` into a dedicated
-- `public.pulse_sheet_bridge_baselines` table so sync config queries and
-- triggers never touch multi-MB baseline payloads, and backfills existing rows.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.pulse_sheet_bridge_baselines (
  client_id UUID PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL UNIQUE,
  drive_version TEXT NOT NULL DEFAULT '',
  note_bounds_version INTEGER NOT NULL DEFAULT 2,
  tabs JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_pulse_sheet_bridge_baselines_updated_at
  ON public.pulse_sheet_bridge_baselines;
CREATE TRIGGER trg_pulse_sheet_bridge_baselines_updated_at
  BEFORE UPDATE ON public.pulse_sheet_bridge_baselines
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_sheet_bridge_baselines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_sheet_bridge_baselines_deny_public_access
  ON public.pulse_sheet_bridge_baselines;
CREATE POLICY pulse_sheet_bridge_baselines_deny_public_access
  ON public.pulse_sheet_bridge_baselines
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_sheet_bridge_baselines FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_sheet_bridge_baselines TO postgres, service_role;

INSERT INTO public.pulse_sheet_bridge_baselines (
  client_id,
  client_name,
  drive_version,
  note_bounds_version,
  tabs,
  updated_at
)
SELECT
  client_id,
  client_name,
  COALESCE(sheet_bridge_baseline->>'driveVersion', ''),
  COALESCE(NULLIF(sheet_bridge_baseline->>'noteBoundsVersion', '')::integer, 2),
  COALESCE(sheet_bridge_baseline->'tabs', '{}'::jsonb),
  COALESCE(NULLIF(sheet_bridge_baseline->>'updatedAt', '')::timestamptz, updated_at, NOW())
FROM public.pulse_master_sync_configs
WHERE sheet_bridge_baseline IS NOT NULL
  AND jsonb_typeof(sheet_bridge_baseline->'tabs') = 'object'
ON CONFLICT (client_id) DO UPDATE SET
  client_name = EXCLUDED.client_name,
  drive_version = EXCLUDED.drive_version,
  note_bounds_version = EXCLUDED.note_bounds_version,
  tabs = EXCLUDED.tabs,
  updated_at = EXCLUDED.updated_at;

UPDATE public.pulse_master_sync_configs
SET sheet_bridge_baseline = NULL
WHERE sheet_bridge_baseline IS NOT NULL;

NOTIFY pgrst, 'reload schema';
