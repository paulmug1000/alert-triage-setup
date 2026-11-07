-- ============================================================================
-- PULSE ECOSYSTEM - STAGE 1 CONTROL PLANE & OPERATIONAL STATE SCHEMA
-- ============================================================================
-- Security model:
-- 1. Row-Level Security (RLS) is enabled on 100% of tables with default-deny
--    for public/anon roles.
-- 2. All database access occurs server-side via Next.js API routes behind
--    authenticated JWT sessions and role/client permission guards.
-- 3. Multi-tenant tables enforce tenant isolation via app.current_client_id.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Helper function to automatically maintain updated_at timestamps
CREATE OR REPLACE FUNCTION public.pulse_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Helper function to set tenant context inside a transaction
CREATE OR REPLACE FUNCTION public.set_pulse_tenant_context(p_client_id UUID, p_user_email TEXT DEFAULT '', p_user_role TEXT DEFAULT '')
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM set_config('app.current_client_id', COALESCE(p_client_id::TEXT, ''), true);
  PERFORM set_config('app.current_user_email', COALESCE(p_user_email, ''), true);
  PERFORM set_config('app.current_user_role', COALESCE(p_user_role, ''), true);
END;
$$;

-- ============================================================================
-- 1. CLIENTS REGISTRY (Replaces Clients Version Tracker & AutoUpdates rows)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name TEXT NOT NULL UNIQUE,
  normalized_key TEXT NOT NULL UNIQUE,
  short_code TEXT,
  service_type TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('setup', 'live', 'paused', 'archived')),
  master_mode TEXT NOT NULL DEFAULT 'sheet' CHECK (master_mode IN ('sheet', 'supabase', 'shadow')),
  client_mode TEXT NOT NULL DEFAULT 'sheet' CHECK (client_mode IN ('sheet', 'supabase', 'shadow')),
  client_sheet_id TEXT DEFAULT '',
  master_sheet_id TEXT DEFAULT '',
  recon_sheet_id TEXT DEFAULT '',
  client_sheet_url TEXT DEFAULT '',
  master_sheet_url TEXT DEFAULT '',
  recon_sheet_url TEXT DEFAULT '',
  web_app_url TEXT DEFAULT '',
  master_deployment_url TEXT DEFAULT '',
  backup_sheet_url TEXT DEFAULT '',
  client_script_id TEXT DEFAULT '',
  master_script_id TEXT DEFAULT '',
  recon_script_id TEXT DEFAULT '',
  drive_folder_id TEXT DEFAULT '',
  reports_folder_id TEXT DEFAULT '',
  version_in_use TEXT DEFAULT '',
  webapp_version TEXT DEFAULT '',
  tracker_row_index INTEGER,
  auto_updates_row_index INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clients_normalized_key ON public.clients (normalized_key);
CREATE INDEX IF NOT EXISTS idx_clients_client_sheet_id ON public.clients (client_sheet_id) WHERE client_sheet_id <> '';
CREATE INDEX IF NOT EXISTS idx_clients_master_sheet_id ON public.clients (master_sheet_id) WHERE master_sheet_id <> '';

DROP TRIGGER IF EXISTS trg_clients_updated_at ON public.clients;
CREATE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 2. USERS & PERMISSIONS (Replaces Automation Commander Users tab)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'ClientUser' CHECK (role IN ('Admin', 'Senior (Restricted)', 'ClientManager', 'ClientUser')),
  assigned_clients JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Suspended')),
  daily_alerts_email TEXT NOT NULL DEFAULT 'Yes' CHECK (daily_alerts_email IN ('Yes', 'No')),
  sheet_row_index INTEGER,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON public.users (email);
CREATE INDEX IF NOT EXISTS idx_users_role ON public.users (role);

DROP TRIGGER IF EXISTS trg_users_updated_at ON public.users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 3. TENANT INTEGRATIONS VAULT (Replaces Redis pulse:vault:* keys)
--    Stores AES-256-GCM ciphertext encrypted with Vercel VAULT_ENCRYPTION_KEY
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.tenant_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_key TEXT NOT NULL,
  tool TEXT NOT NULL,
  master_sheet_id TEXT DEFAULT '',
  encrypted_payload TEXT NOT NULL,
  account_label TEXT DEFAULT '',
  tenant_org_id TEXT DEFAULT '',
  tenant_org_name TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'connected',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_key, tool)
);

CREATE INDEX IF NOT EXISTS idx_tenant_integrations_client_key ON public.tenant_integrations (client_key, tool);
CREATE INDEX IF NOT EXISTS idx_tenant_integrations_master_sheet ON public.tenant_integrations (master_sheet_id, tool) WHERE master_sheet_id <> '';

DROP TRIGGER IF EXISTS trg_tenant_integrations_updated_at ON public.tenant_integrations;
CREATE TRIGGER trg_tenant_integrations_updated_at
  BEFORE UPDATE ON public.tenant_integrations
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.tenant_integrations ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 4. SYNC SCHEDULES (Replaces AutoUpdates schedule columns & SweepSchedule)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.sync_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL UNIQUE,
  automation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  inv_freq TEXT DEFAULT '',
  last_inv_run TIMESTAMPTZ,
  inv_status TEXT DEFAULT '',
  crm_freq TEXT DEFAULT '',
  last_crm_run TIMESTAMPTZ,
  crm_status TEXT DEFAULT '',
  exp_freq TEXT DEFAULT '',
  last_exp_run TIMESTAMPTZ,
  exp_status TEXT DEFAULT '',
  flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_schedules_client_name ON public.sync_schedules (client_name);

DROP TRIGGER IF EXISTS trg_sync_schedules_updated_at ON public.sync_schedules;
CREATE TRIGGER trg_sync_schedules_updated_at
  BEFORE UPDATE ON public.sync_schedules
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.sync_schedules ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 5. ALERT MEMORY (Replaces Automation Commander AlertMemory tab)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.alert_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint_hash TEXT NOT NULL,
  alert_type TEXT NOT NULL DEFAULT '',
  client_name TEXT NOT NULL DEFAULT '',
  alert_summary TEXT NOT NULL DEFAULT '',
  cached_options_json TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'cached',
  ignore_reason TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL DEFAULT '',
  last_seen TEXT NOT NULL DEFAULT '',
  last_rechecked TEXT NOT NULL DEFAULT '',
  data_snapshot TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'discrepancy',
  sheet_row_index INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_memory_fp_unique ON public.alert_memory (fingerprint_hash);
CREATE INDEX IF NOT EXISTS idx_alert_memory_client_name ON public.alert_memory (client_name);
CREATE INDEX IF NOT EXISTS idx_alert_memory_status ON public.alert_memory (status);
CREATE INDEX IF NOT EXISTS idx_alert_memory_handled ON public.alert_memory (fingerprint_hash, status)
  WHERE status NOT IN ('cached', 'pending_automation');

DROP TRIGGER IF EXISTS trg_alert_memory_updated_at ON public.alert_memory;
CREATE TRIGGER trg_alert_memory_updated_at
  BEFORE UPDATE ON public.alert_memory
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.alert_memory ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 6. ACTIVITY LOGS (Replaces PulseActivityLog & PmaActivityLog tabs)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id BIGSERIAL PRIMARY KEY,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'PULSE' CHECK (source IN ('PULSE', 'PMA', 'SYNC', 'SYSTEM')),
  client_name TEXT NOT NULL DEFAULT 'System',
  category TEXT NOT NULL DEFAULT 'PULSE',
  action TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  user_email TEXT NOT NULL DEFAULT 'System',
  fingerprint_hash TEXT DEFAULT '',
  alert_key TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_logged_at ON public.activity_logs (logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_client_name ON public.activity_logs (client_name, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_source_cat ON public.activity_logs (source, category, logged_at DESC);

ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 7. PMA TASKS (Dedicated view/table for triaged alert tasks & standalone tasks)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pma_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint_hash TEXT UNIQUE,
  task_key TEXT,
  client_name TEXT NOT NULL DEFAULT '',
  alert_type TEXT NOT NULL DEFAULT '',
  alert_summary TEXT NOT NULL DEFAULT '',
  task_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'task',
  snoozed_until TEXT DEFAULT '',
  created_by_email TEXT DEFAULT '',
  created_by_name TEXT DEFAULT '',
  is_admin_only BOOLEAN NOT NULL DEFAULT FALSE,
  data_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pma_tasks_client_name ON public.pma_tasks (client_name);
CREATE INDEX IF NOT EXISTS idx_pma_tasks_status ON public.pma_tasks (status);

DROP TRIGGER IF EXISTS trg_pma_tasks_updated_at ON public.pma_tasks;
CREATE TRIGGER trg_pma_tasks_updated_at
  BEFORE UPDATE ON public.pma_tasks
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pma_tasks ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 8. CLIENT SETUP STATE (Replaces ClientSetupOverview & ClientSetupTasks tabs)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.client_setup_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL UNIQUE,
  normalized_key TEXT NOT NULL UNIQUE,
  setup_status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  accounting_tool TEXT DEFAULT 'None',
  crm_tool TEXT DEFAULT 'None',
  crm_drives TEXT DEFAULT 'NA',
  overview_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  tasks_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_setup_state_norm_key ON public.client_setup_state (normalized_key);

DROP TRIGGER IF EXISTS trg_client_setup_state_updated_at ON public.client_setup_state;
CREATE TRIGGER trg_client_setup_state_updated_at
  BEFORE UPDATE ON public.client_setup_state
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.client_setup_state ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 9. EOM CYCLES, TASKS & NARRATIVES (Replaces EOM tabs & eomNarrativeService)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.eom_cycles_and_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_month_key TEXT NOT NULL,
  client_name TEXT NOT NULL,
  record_type TEXT NOT NULL DEFAULT 'client_tasks' CHECK (record_type IN ('template', 'client_tasks', 'narrative', 'report_log')),
  tasks_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  narrative_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  report_url TEXT DEFAULT '',
  updated_by TEXT DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (work_month_key, client_name, record_type)
);

CREATE INDEX IF NOT EXISTS idx_eom_cycles_month_client ON public.eom_cycles_and_tasks (work_month_key, client_name);

DROP TRIGGER IF EXISTS trg_eom_cycles_updated_at ON public.eom_cycles_and_tasks;
CREATE TRIGGER trg_eom_cycles_updated_at
  BEFORE UPDATE ON public.eom_cycles_and_tasks
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.eom_cycles_and_tasks ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 10. SYSTEM CONFIG (Replaces SweepSchedule, ClaudeUsage config & global flags)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.system_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  description TEXT DEFAULT '',
  updated_by TEXT DEFAULT 'System',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_system_config_updated_at ON public.system_config;
CREATE TRIGGER trg_system_config_updated_at
  BEFORE UPDATE ON public.system_config
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;
