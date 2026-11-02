-- 手工审核执行，仅用于 science_admin 或 science_evaluation；应用不会自动执行迁移。
BEGIN;
DO $$ BEGIN
  IF current_database() NOT IN ('science_admin', 'science_evaluation') THEN
    RAISE EXCEPTION 'Mission daily plans require science_admin or science_evaluation';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.evaluation_mission_daily_plans (
  plan_date date PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  service_address text NOT NULL,
  items jsonb NOT NULL,
  rule_snapshot jsonb,
  state text NOT NULL CHECK (state IN ('dispatching', 'submitted', 'empty', 'skipped')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
