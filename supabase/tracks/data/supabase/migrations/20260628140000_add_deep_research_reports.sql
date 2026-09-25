-- ═══════════════════════════════════════════════════════════════════════════════
-- RUN ON: Database 2, 3, 4 only (data shards; never Database 1)
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Create deep_research_reports table
CREATE TABLE IF NOT EXISTS public.deep_research_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES public.conversations (id) ON DELETE CASCADE,
    message_id UUID REFERENCES public.messages (id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    content TEXT,
    sources JSONB DEFAULT '[]'::jsonb,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
    request_metadata JSONB DEFAULT '{}'::jsonb,
    search_count INTEGER DEFAULT 0,
    citation_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS deep_research_reports_conversation_idx ON public.deep_research_reports (conversation_id);
CREATE INDEX IF NOT EXISTS deep_research_reports_user_idx ON public.deep_research_reports (user_id);
CREATE INDEX IF NOT EXISTS deep_research_reports_message_id_idx ON public.deep_research_reports (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deep_research_reports_updated_at_idx ON public.deep_research_reports (updated_at desc);

-- Enable RLS and define user ownership select/update policies
ALTER TABLE public.deep_research_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deep_research_reports_select_own" ON public.deep_research_reports;
CREATE POLICY "deep_research_reports_select_own" ON public.deep_research_reports
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "deep_research_reports_insert_own" ON public.deep_research_reports;
CREATE POLICY "deep_research_reports_insert_own" ON public.deep_research_reports
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "deep_research_reports_update_own" ON public.deep_research_reports;
CREATE POLICY "deep_research_reports_update_own" ON public.deep_research_reports
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "deep_research_reports_delete_own" ON public.deep_research_reports;
CREATE POLICY "deep_research_reports_delete_own" ON public.deep_research_reports
  FOR DELETE USING (user_id = auth.uid());

-- Revoke all permissions from public/anon and grant selective ones to authenticated and service_role
REVOKE ALL ON TABLE public.deep_research_reports FROM public;
REVOKE ALL ON TABLE public.deep_research_reports FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.deep_research_reports TO authenticated;
GRANT ALL ON TABLE public.deep_research_reports TO service_role;

-- Define a trigger to auto-update the updated_at column
CREATE OR REPLACE FUNCTION public.touch_deep_research_reports_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS deep_research_reports_touch_updated_at ON public.deep_research_reports;
CREATE TRIGGER deep_research_reports_touch_updated_at
  BEFORE UPDATE ON public.deep_research_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_deep_research_reports_updated_at();
