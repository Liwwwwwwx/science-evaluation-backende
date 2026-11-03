-- 手工迁移：须先停止旧版本写入并核对备份；生产执行另行确认。
-- 一次性将迁移前的人工和旧运行归属用户名为 admin 的账号；自动化运行保持团队共享。
BEGIN;
DO $$
DECLARE admin_id text;
BEGIN
  IF current_database() NOT IN ('science_admin', 'science_evaluation') THEN
    RAISE EXCEPTION 'Run ownership requires an evaluation database';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
             AND table_name='unified_evaluation_runs' AND column_name='owner_user_id') THEN
    RAISE EXCEPTION 'Run ownership migration has already been applied';
  END IF;
  SELECT id INTO admin_id FROM public.auth_users WHERE username='admin';
  IF admin_id IS NULL THEN RAISE EXCEPTION 'The admin account was not found'; END IF;
  ALTER TABLE public.unified_evaluation_runs ADD COLUMN owner_user_id text REFERENCES public.auth_users(id);
  UPDATE public.unified_evaluation_runs SET owner_user_id=admin_id WHERE origin IN ('manual','legacy');
  ALTER TABLE public.unified_evaluation_runs ADD CONSTRAINT unified_evaluation_runs_owner_required
    CHECK ((origin='automation' AND owner_user_id IS NULL) OR (origin IN ('manual','legacy') AND owner_user_id IS NOT NULL));
END $$;
CREATE INDEX unified_evaluation_runs_owner_started_index ON public.unified_evaluation_runs(owner_user_id, started_at DESC);
COMMIT;
