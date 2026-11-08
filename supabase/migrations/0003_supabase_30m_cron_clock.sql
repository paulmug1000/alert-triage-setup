-- ============================================================================
-- PULSE ECOSYSTEM — STAGE 2B: SUPABASE 30-MINUTE WAKE-UP CLOCK (pg_cron + pg_net)
-- ============================================================================
-- Moves the 30-minute background wake-up clock out of Google Apps Script
-- (FlagSweepTrigger.gs, BuildOptionsTrigger.gs, StorePrecomputeTrigger.gs,
-- ActivityFeedTrigger.gs) into Supabase PostgreSQL using pg_cron + pg_net.
--
-- Every 30 minutes (*/30 * * * *), pg_cron executes public.run_pulse_30m_clock(),
-- which sends an authenticated HTTP POST to /api/cron on Vercel Pro.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

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
    timeout_milliseconds := 5000
  ) INTO v_req_id;

  UPDATE public.system_config
  SET value = v_cfg || jsonb_build_object(
    'lastTriggeredAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
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
    'triggeredAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_pulse_30m_clock_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_has_cron boolean := false;
  v_has_net boolean := false;
  v_job_record record;
  v_job_exists boolean := false;
  v_schedule text := null;
  v_active boolean := false;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') INTO v_has_cron;
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') INTO v_has_net;

  IF v_has_cron THEN
    BEGIN
      SELECT jobid, schedule, active
      INTO v_job_record
      FROM cron.job
      WHERE jobname = 'pulse-30m-wakeup-clock'
      LIMIT 1;

      IF FOUND THEN
        v_job_exists := true;
        v_schedule := v_job_record.schedule;
        v_active := v_job_record.active;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_job_exists := false;
    END;
  END IF;

  RETURN jsonb_build_object(
    'pgCronInstalled', v_has_cron,
    'pgNetInstalled', v_has_net,
    'jobScheduled', v_job_exists,
    'jobActive', v_active,
    'schedule', COALESCE(v_schedule, '*/30 * * * *')
  );
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pulse-30m-wakeup-clock') THEN
    PERFORM cron.unschedule('pulse-30m-wakeup-clock');
  END IF;

  PERFORM cron.schedule(
    'pulse-30m-wakeup-clock',
    '*/30 * * * *',
    'SELECT public.run_pulse_30m_clock(false);'
  );
END;
$$;

