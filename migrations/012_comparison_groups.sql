-- 手工迁移：对比组只新增一个可空列和索引，不改写已有运行；生产执行另行确认。
BEGIN;
DO $$ BEGIN
  IF current_database() NOT IN ('science_admin', 'science_evaluation') THEN
    RAISE EXCEPTION 'Comparison groups require an evaluation database';
  END IF;
END $$;
ALTER TABLE public.unified_evaluation_runs ADD COLUMN IF NOT EXISTS comparison_group_id text;
CREATE INDEX IF NOT EXISTS unified_evaluation_runs_comparison_group_index
  ON public.unified_evaluation_runs(comparison_group_id, started_at)
  WHERE comparison_group_id IS NOT NULL;
COMMIT;
