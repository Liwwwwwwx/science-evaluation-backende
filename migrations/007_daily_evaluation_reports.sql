-- 手工审核后在授权的测评数据库执行；应用不会自动建表。
BEGIN;
DO $$ BEGIN
  IF current_database() NOT IN ('science_admin','science_evaluation') THEN
    RAISE EXCEPTION 'daily reports require science_admin or science_evaluation';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.evaluation_daily_reports (
  report_date date PRIMARY KEY,
  source_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('generating','ready','failed')),
  claim_token uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  snapshot jsonb NOT NULL,
  analysis jsonb,
  analysis_state text NOT NULL DEFAULT 'pending' CHECK (analysis_state IN ('pending','ready','unavailable','failed')),
  provider text,
  model text,
  markdown text,
  error text,
  notification_state text CHECK (notification_state IN ('sending','sent','failed','unknown')),
  notification_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
