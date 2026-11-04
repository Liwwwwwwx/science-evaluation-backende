-- 手工审核后执行；不删除方案或历史执行记录。
BEGIN;
DO $$ BEGIN
  IF current_database() NOT IN ('science_admin', 'science_evaluation') THEN
    RAISE EXCEPTION 'Batch schemes require an evaluation database';
  END IF;
END $$;
ALTER TABLE public.evaluation_batch_schemes ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE public.evaluation_batch_schemes ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
-- 最早的方案版本是可核验的创建人；缺少历史的旧方案保留未知归属，不猜测。
UPDATE public.evaluation_batch_schemes s SET created_by = (
  SELECT h.updated_by FROM public.evaluation_batch_scheme_history h
  WHERE h.scheme_id=s.id AND h.version=1 LIMIT 1
) WHERE s.created_by IS NULL;
CREATE INDEX IF NOT EXISTS evaluation_batch_schemes_owner_active ON public.evaluation_batch_schemes(created_by, updated_at DESC) WHERE deleted_at IS NULL;
COMMIT;
