-- 手工审核后执行；不修改运行记录。生产迁移须事先获得确认。
BEGIN;
DO $$ BEGIN
  IF current_database() NOT IN ('science_admin', 'science_evaluation') THEN
    RAISE EXCEPTION 'Run history requires science_admin or science_evaluation';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.evaluation_user_run_history (
  user_id text NOT NULL REFERENCES public.auth_users(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.unified_evaluation_runs(id) ON DELETE CASCADE,
  title text,
  hidden boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, run_id),
  CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 100)
);
COMMIT;
