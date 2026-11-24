-- ============================================================================
-- PULSE ECOSYSTEM — MIGRATION 0011: CLIENT NOTES & MANAGER NOTIFICATIONS
-- ============================================================================
-- 1. Create `public.pulse_notes` and `public.pulse_note_replies` for client-facing
--    entity and screen notes ("just a note" or "note and notify").
-- 2. Enforce strict server-side visibility scopes (`standard` vs
--    `restricted_salary` for employee and dividend notes).
-- 3. Enable default-deny Row Level Security (RLS) for `anon` and `authenticated`
--    so all reads/writes pass strictly through authenticated Next.js API routes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.pulse_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('entity', 'screen')),
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'job',
      'invoice',
      'job_expense',
      'contractor',
      'contractor_bill',
      'outgoing',
      'dividend',
      'employee',
      'performance',
      'cash',
      'budget',
      'scenario'
    )
  ),
  entity_key TEXT NOT NULL,
  parent_entity_key TEXT NOT NULL DEFAULT '',
  entity_label TEXT NOT NULL DEFAULT '',
  context_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  visibility_scope TEXT NOT NULL DEFAULT 'standard' CHECK (
    visibility_scope IN ('standard', 'restricted_salary')
  ),
  body TEXT NOT NULL,
  notify_manager BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'note' CHECK (
    status IN ('note', 'open', 'replied', 'resolved')
  ),
  author_email TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  author_role TEXT NOT NULL DEFAULT 'ClientUser',
  notified_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
  notified_at TIMESTAMPTZ,
  resolved_by_email TEXT DEFAULT '',
  resolved_by_name TEXT DEFAULT '',
  resolved_at TIMESTAMPTZ,
  client_unread_reply BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.pulse_note_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID NOT NULL REFERENCES public.pulse_notes(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author_email TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  author_role TEXT NOT NULL DEFAULT 'ClientUser',
  is_staff_reply BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pulse_notes_client_entity
  ON public.pulse_notes (client_name, entity_key)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_notes_client_parent
  ON public.pulse_notes (client_name, parent_entity_key)
  WHERE deleted_at IS NULL AND parent_entity_key <> '';

CREATE INDEX IF NOT EXISTS idx_pulse_notes_notify_status
  ON public.pulse_notes (notify_manager, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_note_replies_note_id
  ON public.pulse_note_replies (note_id, created_at ASC);

DROP TRIGGER IF EXISTS trg_pulse_notes_updated_at ON public.pulse_notes;
CREATE TRIGGER trg_pulse_notes_updated_at
  BEFORE UPDATE ON public.pulse_notes
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

DROP TRIGGER IF EXISTS trg_pulse_note_replies_updated_at ON public.pulse_note_replies;
CREATE TRIGGER trg_pulse_note_replies_updated_at
  BEFORE UPDATE ON public.pulse_note_replies
  FOR EACH ROW EXECUTE FUNCTION public.pulse_set_updated_at();

ALTER TABLE public.pulse_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pulse_note_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_notes_deny_all_anon ON public.pulse_notes;
CREATE POLICY pulse_notes_deny_all_anon
  ON public.pulse_notes
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS pulse_note_replies_deny_all_anon ON public.pulse_note_replies;
CREATE POLICY pulse_note_replies_deny_all_anon
  ON public.pulse_note_replies
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.pulse_notes FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_notes TO postgres, service_role;

REVOKE ALL ON TABLE public.pulse_note_replies FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pulse_note_replies TO postgres, service_role;

NOTIFY pgrst, 'reload schema';
