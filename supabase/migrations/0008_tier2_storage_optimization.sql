-- ============================================================================
-- PULSE ECOSYSTEM — MIGRATION 0008: TIER 2 STORAGE OPTIMIZATION
-- ============================================================================
-- DEPLOYMENT ORDER: Run this migration in the Supabase SQL Editor ONLY AFTER
-- deploying v2.166 (which reads/writes `formulas_grid` natively and falls back
-- cleanly to `notes_grid.__formulas_grid`) to Vercel production.
--
-- What this migration does (idempotent):
-- 1. Backfills `master_sheet_grids.formulas_grid` from legacy
--    `notes_grid.__formulas_grid` on all client rows and removes the embedded
--    `__formulas_grid` key from `notes_grid`.
-- 2. Applies the same migration to `system_config` `template_snapshot::client::*`
--    rows so future client provisioning reads clean `formulas_grid` + `notes_grid`.
-- 3. Trims trailing all-zero / blank filler rows past `lastActive + 11`
--    (preserving at least 130 rows) on `master_sheet_grids` (`Master::ConfCalcs`,
--    `Master::PipeCalcs`) and their `system_config` Master template snapshots.
-- ============================================================================

-- 1. Move Client `notes_grid.__formulas_grid` -> `master_sheet_grids.formulas_grid`
UPDATE public.master_sheet_grids
SET
  formulas_grid = CASE
    WHEN jsonb_typeof(notes_grid -> '__formulas_grid') = 'array' THEN notes_grid -> '__formulas_grid'
    ELSE formulas_grid
  END,
  notes_grid = notes_grid - '__formulas_grid'
WHERE (sheet_role = 'client' OR (sheet_role = 'master' AND tab_name LIKE 'Client::%'))
  AND notes_grid ? '__formulas_grid';

-- 2. Move Client template snapshot `notes_grid.__formulas_grid` -> `value.formulas_grid`
UPDATE public.system_config
SET value = jsonb_set(
  value #- '{notes_grid,__formulas_grid}',
  '{formulas_grid}',
  value #> '{notes_grid,__formulas_grid}',
  true
)
WHERE key LIKE 'template_snapshot::client::%'
  AND (value -> 'notes_grid') ? '__formulas_grid'
  AND jsonb_typeof(value #> '{notes_grid,__formulas_grid}') = 'array';

-- 3. Trim trailing inactive filler rows on Master::ConfCalcs & Master::PipeCalcs
DO $$
DECLARE
  v_check_cols CONSTANT INTEGER[] := ARRAY[0, 1, 17, 32, 35, 37, 41, 48, 55, 76, 83, 90];
  rec RECORD;
  v_len INTEGER;
  v_last_active INTEGER;
  v_found BOOLEAN;
  v_keep INTEGER;
  v_row JSONB;
  v_cell JSONB;
  v_ctype TEXT;
  v_txt TEXT;
  col_idx INTEGER;
  r INTEGER;
  v_trimmed JSONB;
  v_trimmed_forms JSONB;
  v_next_val JSONB;
  v_forms_len INTEGER;
BEGIN
  -- 3A. Live Master::ConfCalcs and Master::PipeCalcs rows in master_sheet_grids
  FOR rec IN
    SELECT id, values_grid
    FROM public.master_sheet_grids
    WHERE sheet_role = 'master'
      AND tab_name IN ('ConfCalcs', 'PipeCalcs')
      AND jsonb_typeof(values_grid) = 'array'
      AND jsonb_array_length(values_grid) > 130
  LOOP
    v_len := jsonb_array_length(rec.values_grid);
    v_last_active := 119;
    v_found := FALSE;

    FOR r IN REVERSE (v_len - 1) .. 120 LOOP
      v_row := rec.values_grid -> r;
      IF jsonb_typeof(v_row) = 'array' THEN
        FOREACH col_idx IN ARRAY v_check_cols LOOP
          v_cell := v_row -> col_idx;
          IF v_cell IS NOT NULL THEN
            v_ctype := jsonb_typeof(v_cell);
            IF v_ctype = 'string' THEN
              v_txt := v_cell #>> '{}';
              IF v_txt <> '' AND v_txt <> '0' THEN
                v_last_active := r;
                v_found := TRUE;
                EXIT;
              END IF;
            ELSIF v_ctype = 'number' THEN
              IF (v_cell #>> '{}')::numeric <> 0 THEN
                v_last_active := r;
                v_found := TRUE;
                EXIT;
              END IF;
            ELSIF v_ctype = 'boolean' THEN
              IF v_cell = 'true'::jsonb THEN
                v_last_active := r;
                v_found := TRUE;
                EXIT;
              END IF;
            ELSIF v_ctype <> 'null' THEN
              v_last_active := r;
              v_found := TRUE;
              EXIT;
            END IF;
          END IF;
        END LOOP;
      END IF;
      IF v_found THEN
        EXIT;
      END IF;
    END LOOP;

    v_keep := LEAST(v_len, v_last_active + 11);
    IF v_keep < v_len THEN
      SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
      INTO v_trimmed
      FROM jsonb_array_elements(rec.values_grid) WITH ORDINALITY AS t(elem, ord)
      WHERE ord <= v_keep;

      UPDATE public.master_sheet_grids
      SET
        values_grid = v_trimmed,
        row_count = jsonb_array_length(v_trimmed),
        updated_at = NOW()
      WHERE id = rec.id;
    END IF;
  END LOOP;

  -- 3B. Master template snapshots for ConfCalcs and PipeCalcs in system_config
  FOR rec IN
    SELECT key, value
    FROM public.system_config
    WHERE key IN ('template_snapshot::master::ConfCalcs', 'template_snapshot::master::PipeCalcs')
      AND jsonb_typeof(value -> 'values_grid') = 'array'
      AND jsonb_array_length(value -> 'values_grid') > 130
  LOOP
    v_len := jsonb_array_length(rec.value -> 'values_grid');
    v_last_active := 119;
    v_found := FALSE;

    FOR r IN REVERSE (v_len - 1) .. 120 LOOP
      v_row := (rec.value -> 'values_grid') -> r;
      IF jsonb_typeof(v_row) = 'array' THEN
        FOREACH col_idx IN ARRAY v_check_cols LOOP
          v_cell := v_row -> col_idx;
          IF v_cell IS NOT NULL THEN
            v_ctype := jsonb_typeof(v_cell);
            IF v_ctype = 'string' THEN
              v_txt := v_cell #>> '{}';
              IF v_txt <> '' AND v_txt <> '0' THEN
                v_last_active := r;
                v_found := TRUE;
                EXIT;
              END IF;
            ELSIF v_ctype = 'number' THEN
              IF (v_cell #>> '{}')::numeric <> 0 THEN
                v_last_active := r;
                v_found := TRUE;
                EXIT;
              END IF;
            ELSIF v_ctype = 'boolean' THEN
              IF v_cell = 'true'::jsonb THEN
                v_last_active := r;
                v_found := TRUE;
                EXIT;
              END IF;
            ELSIF v_ctype <> 'null' THEN
              v_last_active := r;
              v_found := TRUE;
              EXIT;
            END IF;
          END IF;
        END LOOP;
      END IF;
      IF v_found THEN
        EXIT;
      END IF;
    END LOOP;

    v_keep := LEAST(v_len, v_last_active + 11);
    IF v_keep < v_len THEN
      SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
      INTO v_trimmed
      FROM jsonb_array_elements(rec.value -> 'values_grid') WITH ORDINALITY AS t(elem, ord)
      WHERE ord <= v_keep;

      v_next_val := jsonb_set(rec.value, '{values_grid}', v_trimmed, true);

      IF (rec.value ? 'compact_formulas') AND jsonb_typeof(rec.value -> 'compact_formulas') = 'array' THEN
        v_forms_len := jsonb_array_length(rec.value -> 'compact_formulas');
        IF v_forms_len > v_keep THEN
          SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
          INTO v_trimmed_forms
          FROM jsonb_array_elements(rec.value -> 'compact_formulas') WITH ORDINALITY AS t(elem, ord)
          WHERE ord <= v_keep;
          v_next_val := jsonb_set(v_next_val, '{compact_formulas}', v_trimmed_forms, true);
        END IF;
      END IF;

      UPDATE public.system_config
      SET value = v_next_val
      WHERE key = rec.key;
    END IF;
  END LOOP;
END $$;
