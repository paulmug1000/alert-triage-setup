-- ============================================================================
-- PULSE ECOSYSTEM — MIGRATION 0005: UPDATE CRON FREQUENCY TO 10 MINUTES
-- ============================================================================
-- Reschedules pulse-30m-wakeup-clock to run every 10 minutes (*/10 * * * *)
-- and installs set_pulse_clock_schedule() RPC for future remote tuning.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_pulse_clock_schedule(p_schedule text DEFAULT '*/10 * * * *')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pulse-30m-wakeup-clock') THEN
    PERFORM cron.unschedule('pulse-30m-wakeup-clock');
  END IF;

  SELECT cron.schedule(
    'pulse-30m-wakeup-clock',
    p_schedule,
    'SELECT public.run_pulse_30m_clock(false);'
  ) INTO v_job_id;

  RETURN jsonb_build_object(
    'success', true,
    'schedule', p_schedule,
    'jobId', v_job_id
  );
END;
$$;

-- Reschedule existing job to 10 minutes immediately:
SELECT public.set_pulse_clock_schedule('*/10 * * * *');

-- Update system_config description to reflect 10-minute cadence
UPDATE public.system_config
SET description = 'Supabase pg_cron 10-minute wake-up clock configuration and telemetry',
    updated_at = now()
WHERE key = 'supabase_cron_clock';

