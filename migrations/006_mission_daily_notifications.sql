-- 手工审核执行，仅用于 science_admin 或 science_evaluation；应用不会自动执行迁移。
BEGIN;
DO $$ BEGIN
  IF current_database() NOT IN ('science_admin', 'science_evaluation') THEN
    RAISE EXCEPTION 'Mission daily notifications require science_admin or science_evaluation';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.evaluation_mission_daily_notifications (
  plan_id uuid PRIMARY KEY REFERENCES public.evaluation_mission_daily_plans(id),
  state text NOT NULL CHECK (state IN ('sending', 'sent', 'failed', 'unknown')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
