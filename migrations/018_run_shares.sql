-- 团队内运行分享。审核后手工执行，无需改写任何运行或评分记录。
BEGIN;
DO $$ BEGIN
  IF current_database() NOT IN ('science_admin', 'science_evaluation') THEN
    RAISE EXCEPTION 'Run sharing requires science_admin or science_evaluation';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.evaluation_run_shares (
  run_id uuid PRIMARY KEY REFERENCES public.unified_evaluation_runs(id) ON DELETE CASCADE,
  share_id uuid UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL
);
COMMIT;
