-- ============================================================================
-- PULSE ECOSYSTEM — MIGRATION 0006: RPC SECURITY & CRON CLOCK HARDENING
-- ============================================================================
-- 1. Pin immutable search_path on set_pulse_tenant_context.
-- 2. Harden run_pulse_30m_clock: 20s pg_net timeout + atomic JSONB merge.
-- 3. Harden set_pulse_clock_schedule: validate 5-field cron expression.
-- 4. Lock down RPC EXECUTE privileges to postgres & service_role only.
-- ============================================================================

-- 1. Pin search_path on set_pulse_tenant_context
ALTER FUNCTION public.set_pulse_tenant_context(UUID, TEXT, TEXT)
  SET search_path = public;

-- 2. Harden run_pulse_30m_clock with 20s timeout and atomic JSONB telemetry merge
CREATE OR REPLACE FUNCTION public.run_pulse_30m_clock(p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  v_url := COALESCE(NULLIF(trim(v_cfg->>'targetUrl'), ''), 'https://app.pulsedashboard.co.uk/api/cron');
  v_secret := COALESCE(v_cfg->>'cronSecret', '');
  v_bypass := COALESCE(v_cfg->>'bypassToken', '');

  IF v_secret = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Missing cronSecret in supabase_cron_clock config. Click "Sync clock config" in PMA Settings.'
    );
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_secret,
    'x-cron-secret', v_secret
  );

  IF v_bypass <> '' THEN
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
  SET value = COALESCE(value, '{}'::jsonb) || jsonb_build_object(
        'lastTriggeredAt', v_triggered_at,
        'lastRequestId', v_req_id,
        'lastTriggerSource', CASE WHEN p_force THEN 'manual_test' ELSE 'pg_cron' END
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

-- 3. Validate 5-field cron schedule expression before unschedule/schedule
CREATE OR REPLACE FUNCTION public.set_pulse_clock_schedule(p_schedule text DEFAULT '*/10 * * * *')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean text;
  v_job_id bigint;
BEGIN
  v_clean := regexp_replace(trim(COALESCE(p_schedule, '')), '\s+', ' ', 'g');
  IF v_clean = '' OR v_clean !~ '^([0-9*,/-]+ ){4}[0-9*,/-]+$' THEN
    RAISE EXCEPTION 'Invalid 5-field cron schedule expression: %', COALESCE(p_schedule, '<null>');
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pulse-30m-wakeup-clock') THEN
    PERFORM cron.unschedule('pulse-30m-wakeup-clock');
  END IF;

  SELECT cron.schedule(
    'pulse-30m-wakeup-clock',
    v_clean,
    'SELECT public.run_pulse_30m_clock(false);'
  ) INTO v_job_id;

  RETURN jsonb_build_object(
    'success', true,
    'schedule', v_clean,
    'jobId', v_job_id
  );
END;
$$;

-- 4. Lock down EXECUTE privileges on internal control-plane & cron RPCs
REVOKE ALL ON FUNCTION public.set_pulse_tenant_context(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_pulse_tenant_context(UUID, TEXT, TEXT) TO postgres, service_role;

REVOKE ALL ON FUNCTION public.run_pulse_30m_clock(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_pulse_30m_clock(boolean) TO postgres, service_role;

REVOKE ALL ON FUNCTION public.get_pulse_30m_clock_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pulse_30m_clock_status() TO postgres, service_role;

REVOKE ALL ON FUNCTION public.set_pulse_clock_schedule(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_pulse_clock_schedule(text) TO postgres, service_role;
