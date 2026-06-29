-- ═══════════════════════════════════════════════════════════════════════════════
-- RUN ON: Database 1 only (control database; never data shards 2, 3, or 4)
--
-- This migration is intentionally not applied automatically by the corrective
-- pass. It refuses to remove a misplaced report table if that table contains
-- any rows.
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  has_report_rows boolean := false;
BEGIN
  IF to_regclass('public.deep_research_reports') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.deep_research_reports LIMIT 1)'
      INTO has_report_rows;
    IF has_report_rows THEN
      RAISE EXCEPTION 'Refusing to remove non-empty deep_research_reports from the control database';
    END IF;
  END IF;
END;
$$;

DROP TABLE IF EXISTS public.deep_research_reports;
DROP FUNCTION IF EXISTS public.touch_deep_research_reports_updated_at();

ALTER TABLE public.usage_events DROP CONSTRAINT IF EXISTS usage_events_feature_check;
ALTER TABLE public.usage_events ADD CONSTRAINT usage_events_feature_check CHECK (feature IN (
  'premium_text', 'lite_text', 'image_generation', 'advanced_reasoning',
  'file_analysis', 'web_search', 'generated_file', 'deep_research'
));

ALTER TABLE public.quota_reservations DROP CONSTRAINT IF EXISTS quota_reservations_feature_check;
ALTER TABLE public.quota_reservations ADD CONSTRAINT quota_reservations_feature_check CHECK (feature IN (
  'premium_text', 'lite_text', 'image_generation', 'advanced_reasoning',
  'file_analysis', 'web_search', 'generated_file', 'deep_research'
));

UPDATE public.billing_plans
SET entitlements = jsonb_set(
  entitlements,
  '{quotas,deep_research}',
  '{"limit": 7, "window_seconds": 2592000, "label": "Deep Researches"}'
)
WHERE code = 'free';

UPDATE public.billing_plans
SET entitlements = jsonb_set(
  entitlements,
  '{quotas,deep_research}',
  '{"limit": 15, "window_seconds": 2592000, "label": "Deep Researches"}'
)
WHERE code = 'student_core';

UPDATE public.billing_plans
SET entitlements = jsonb_set(
  entitlements,
  '{quotas,deep_research}',
  '{"limit": 30, "window_seconds": 2592000, "label": "Deep Researches"}'
)
WHERE code = 'premium';

UPDATE public.billing_plans
SET entitlements = jsonb_set(
  entitlements,
  '{quotas,deep_research}',
  '{"limit": 50, "window_seconds": 2592000, "label": "Deep Researches"}'
)
WHERE code = 'pro';
