-- 仅供审核后手动执行，应用不会自动迁移。
BEGIN;
DO $$ BEGIN
  IF current_database() NOT IN ('science_admin', 'science_evaluation') THEN
    RAISE EXCEPTION 'Trial batch plans require an evaluation database';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.evaluation_trial_batch_plans (
  plan_date date PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('generating','dispatching','submitted','failed')),
  items jsonb,
  service_addresses jsonb NOT NULL,
  rule_snapshot jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
