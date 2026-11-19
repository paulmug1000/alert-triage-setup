-- ============================================================================
-- PULSE ECOSYSTEM — MIGRATION 0010: SECURITY AUDIT HARDENING
-- ============================================================================
-- 1. Isolate cron/bypass secrets inside non-API schema `pulse_private.cron_secrets`.
-- 2. Migrate any legacy plaintext secrets from `public.system_config`
--    (`key = 'supabase_cron_clock'`) into `pulse_private.cron_secrets` and strip them
--    from `public.system_config.value`.
-- 3. Add `public.sync_pulse_clock_secrets` SECURITY DEFINER RPC for server-side
--    rotation/storage with canonical Pulse URL validation.
-- 4. Update `public.run_pulse_30m_clock` to read secrets from `pulse_private.cron_secrets`
--    and validate `v_url` against canonical Pulse hosts.
-- 5. Pin `SET search_path = pg_catalog, public` and lock down EXECUTE grants.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS pulse_private;
REVOKE ALL ON SCHEMA pulse_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA pulse_private TO postgres, service_role;

CREATE TABLE IF NOT EXISTS pulse_private.cron_secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE pulse_private.cron_secrets FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE pulse_private.cron_secrets TO postgres, service_role;

-- Migrate existing plaintext cronSecret / bypassToken out of public.system_config
DO $$
DECLARE
  v_cfg jsonb;
  v_cron text;
  v_bypass text;
BEGIN
  SELECT value INTO v_cfg
  FROM public.system_config
  WHERE key = 'supabase_cron_clock';

  IF v_cfg IS NOT NULL THEN
    v_cron := NULLIF(trim(COALESCE(v_cfg->>'cronSecret', '')), '');
    v_bypass := NULLIF(trim(COALESCE(v_cfg->>'bypassToken', '')), '');

    IF v_cron IS NOT NULL THEN
      INSERT INTO pulse_private.cron_secrets (key, value, updated_at)
      VALUES ('cron_secret', v_cron, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
    END IF;

    IF v_bypass IS NOT NULL THEN
      INSERT INTO pulse_private.cron_secrets (key, value, updated_at)
      VALUES ('bypass_token', v_bypass, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
    END IF;

    UPDATE public.system_config
    SET value = (COALESCE(value, '{}'::jsonb) - 'cronSecret' - 'bypassToken')
                || jsonb_build_object('hasSecretConfigured', true),
        updated_at = now()
    WHERE key = 'supabase_cron_clock';
  END IF;
END;
$$;

-- Server-only RPC to store/rotate cron & Vercel bypass secrets into pulse_private
CREATE OR REPLACE FUNCTION public.sync_pulse_clock_secrets(
  p_target_url TEXT DEFAULT 'https://app.pulsedashboard.co.uk/api/cron',
  p_cron_secret TEXT DEFAULT '',
  p_bypass_token TEXT DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_url text;
  v_cron text;
  v_bypass text;
  v_cfg jsonb;
BEGIN
  v_url := COALESCE(NULLIF(trim(COALESCE(p_target_url, '')), ''), 'https://app.pulsedashboard.co.uk/api/cron');
  IF v_url !~ '^https://(app\.|pma\.)?pulsedashboard\.co\.uk/api/cron$' THEN
    RAISE EXCEPTION 'Blocked invalid clock targetUrl: %', v_url;
  END IF;

  v_cron := trim(COALESCE(p_cron_secret, ''));
  v_bypass := trim(COALESCE(p_bypass_token, ''));

  IF v_cron <> '' THEN
    INSERT INTO pulse_private.cron_secrets (key, value, updated_at)
    VALUES ('cron_secret', v_cron, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END IF;

  IF v_bypass <> '' THEN
    INSERT INTO pulse_private.cron_secrets (key, value, updated_at)
    VALUES ('bypass_token', v_bypass, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END IF;

  SELECT value INTO v_cfg
  FROM public.system_config
  WHERE key = 'supabase_cron_clock';

  INSERT INTO public.system_config (key, value, description, updated_by, updated_at)
  VALUES (
    'supabase_cron_clock',
    ((COALESCE(v_cfg, '{}'::jsonb) - 'cronSecret' - 'bypassToken')
      || jsonb_build_object(
        'enabled', COALESCE((v_cfg->>'enabled')::boolean, true),
        'targetUrl', v_url,
        'hasSecretConfigured', (v_cron <> '' OR EXISTS (SELECT 1 FROM pulse_private.cron_secrets WHERE key = 'cron_secret')),
        'updatedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )),
    'Supabase pg_cron 30-minute wake-up clock configuration and telemetry',
    'System (Clock Sync)',
    now()
  )
  ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_by = EXCLUDED.updated_by,
      updated_at = EXCLUDED.updated_at;

  RETURN jsonb_build_object(
    'success', true,
    'targetUrl', v_url
  );
END;
$$;

-- Hardened cron clock dispatcher reading secrets exclusively from pulse_private.cron_secrets
CREATE OR REPLACE FUNCTION public.run_pulse_30m_clock(p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_cfg jsonb;
  v_enabled boolean;
  v_url text;
  v_secret text;
  v_bypass text;
  v_headers jsonb;
  v_body jsonb;
  v_req_id bigint;
  v_triggered_at text;
BEGIN
  SELECT value INTO v_cfg
  FROM public.system_config
  WHERE key = 'supabase_cron_clock';

  IF v_cfg IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Clock configuration not found in public.system_config (key = supabase_cron_clock). Click "Sync clock config" in PMA Settings.'
    );
  END IF;

  v_enabled := COALESCE((v_cfg->>'enabled')::boolean, true);
  IF NOT v_enabled AND NOT COALESCE(p_force, false) THEN
    RETURN jsonb_build_object(
      'success', true,
      'skipped', true,
      'reason', 'Clock is currently paused in system_config.'
    );
  END IF;

  v_url := COALESCE(NULLIF(trim(COALESCE(v_cfg->>'targetUrl', '')), ''), 'https://app.pulsedashboard.co.uk/api/cron');
  IF v_url !~ '^https://(app\.|pma\.)?pulsedashboard\.co\.uk/api/cron$' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Blocked invalid targetUrl in supabase_cron_clock configuration.'
    );
  END IF;

  SELECT value INTO v_secret FROM pulse_private.cron_secrets WHERE key = 'cron_secret';
  SELECT value INTO v_bypass FROM pulse_private.cron_secrets WHERE key = 'bypass_token';

  -- Legacy compatibility fallback only if secret not yet migrated
  IF COALESCE(v_secret, '') = '' THEN
    v_secret := COALESCE(v_cfg->>'cronSecret', '');
  END IF;
  IF COALESCE(v_bypass, '') = '' THEN
    v_bypass := COALESCE(v_cfg->>'bypassToken', '');
  END IF;

  IF COALESCE(v_secret, '') = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Missing cron_secret in pulse_private.cron_secrets. Click "Sync clock config" in PMA Settings.'
    );
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_secret,
    'x-cron-secret', v_secret
  );

  IF COALESCE(v_bypass, '') <> '' THEN
    v_headers := v_headers || jsonb_build_object('x-vercel-protection-bypass', v_bypass);
  END IF;

  v_body := jsonb_build_object(
    'secret', v_secret,
    'source', CASE WHEN p_force THEN 'supabase_manual_test' ELSE 'supabase_pg_cron' END,
    'forceProactive', false,
    'forceAll', false
  );

  SELECT net.http_post(
    url := v_url,
    headers := v_headers,
    body := v_body,
    timeout_milliseconds := 20000
  ) INTO v_req_id;

  v_triggered_at := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  UPDATE public.system_config
  SET value = (COALESCE(value, '{}'::jsonb) - 'cronSecret' - 'bypassToken') || jsonb_build_object(
        'lastTriggeredAt', v_triggered_at,
        'lastRequestId', v_req_id,
        'lastTriggerSource', CASE WHEN p_force THEN 'manual_test' ELSE 'pg_cron' END,
        'hasSecretConfigured', true
      ),
      updated_at = now()
  WHERE key = 'supabase_cron_clock';

  RETURN jsonb_build_object(
    'success', true,
    'triggered', true,
    'requestId', v_req_id,
    'targetUrl', v_url,
    'triggeredAt', v_triggered_at
  );
END;
$$;

-- Pin pg_catalog, public search_path across privileged RPCs & trigger helper
ALTER FUNCTION public.set_pulse_tenant_context(UUID, TEXT, TEXT)
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.get_pulse_30m_clock_status()
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.set_pulse_clock_schedule(text)
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.pulse_set_updated_at()
  SET search_path = pg_catalog, public;

-- Lock down EXECUTE grants to postgres and service_role only
REVOKE ALL ON FUNCTION public.sync_pulse_clock_secrets(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_pulse_clock_secrets(TEXT, TEXT, TEXT) TO postgres, service_role;

REVOKE ALL ON FUNCTION public.set_pulse_tenant_context(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_pulse_tenant_context(UUID, TEXT, TEXT) TO postgres, service_role;

REVOKE ALL ON FUNCTION public.run_pulse_30m_clock(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_pulse_30m_clock(boolean) TO postgres, service_role;

REVOKE ALL ON FUNCTION public.get_pulse_30m_clock_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pulse_30m_clock_status() TO postgres, service_role;

REVOKE ALL ON FUNCTION public.set_pulse_clock_schedule(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_pulse_clock_schedule(text) TO postgres, service_role;
