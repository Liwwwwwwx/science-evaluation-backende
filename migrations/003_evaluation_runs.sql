-- 与原管理端 041/042 的运行记录表兼容；手工审核执行，不在服务启动时迁移。
BEGIN;
DO $$ BEGIN
  IF current_database() NOT IN ('science_admin', 'science_evaluation') THEN
    RAISE EXCEPTION 'Evaluation runs require science_admin or science_evaluation';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.unified_evaluation_runs (
  id uuid PRIMARY KEY, service_key text NOT NULL, origin text NOT NULL CHECK (origin IN ('manual','automation','legacy')),
  native_run_id text, question text NOT NULL, question_id text, dataset_version text, question_source_type text,
  batch_id text, status text NOT NULL, answer text NOT NULL DEFAULT '', answer_truncated boolean NOT NULL DEFAULT false,
  run jsonb, scores jsonb, score_error text, error text, started_at timestamptz NOT NULL,
  finished_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.unified_evaluation_runs ADD COLUMN IF NOT EXISTS idempotency_scope text;
ALTER TABLE public.unified_evaluation_runs ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.unified_evaluation_runs ADD COLUMN IF NOT EXISTS idempotency_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS unified_evaluation_idempotency_unique ON public.unified_evaluation_runs(idempotency_scope,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS unified_evaluation_runs_origin_started_at_index ON public.unified_evaluation_runs(origin,started_at);
COMMIT;
