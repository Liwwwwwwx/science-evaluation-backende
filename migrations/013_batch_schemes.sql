-- 仅供审核后手动执行；不会启动测评或改写历史批次。
BEGIN;
DO $$ BEGIN
  IF current_database() NOT IN ('science_admin', 'science_evaluation') THEN
    RAISE EXCEPTION 'Batch schemes require an evaluation database';
  END IF;
END $$;
ALTER TABLE public.evaluation_trial_batch_plans ADD COLUMN IF NOT EXISTS config_snapshot jsonb;
CREATE TABLE IF NOT EXISTS public.evaluation_batch_schemes (
  id uuid PRIMARY KEY, name text NOT NULL, config jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
  is_nightly boolean NOT NULL DEFAULT false, updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS evaluation_batch_schemes_one_nightly ON public.evaluation_batch_schemes(is_nightly) WHERE is_nightly;
CREATE TABLE IF NOT EXISTS public.evaluation_batch_scheme_history (
  scheme_id uuid NOT NULL, version integer NOT NULL, name text NOT NULL, config jsonb NOT NULL, is_nightly boolean NOT NULL,
  updated_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (scheme_id, version)
);
CREATE TABLE IF NOT EXISTS public.evaluation_manual_batch_plans (
  id uuid PRIMARY KEY, plan_date date NOT NULL, state text NOT NULL CHECK (state IN ('generating','dispatching','submitted','failed')),
  items jsonb, service_addresses jsonb NOT NULL, rule_snapshot jsonb, config_snapshot jsonb NOT NULL,
  created_by text NOT NULL, request_key text NOT NULL, request_hash text NOT NULL, error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (created_by, request_key)
);
CREATE INDEX IF NOT EXISTS evaluation_manual_batch_plans_pending ON public.evaluation_manual_batch_plans(state, created_at);
COMMIT;
