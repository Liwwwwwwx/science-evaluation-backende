-- 手工执行。只记录启用后的评分调用，历史评分没有供应商用量可回填。
BEGIN;
DO $$ BEGIN
  IF current_database() NOT IN ('science_admin', 'science_evaluation') THEN
    RAISE EXCEPTION 'Scoring usage requires an evaluation database';
  END IF;
END $$;
CREATE TABLE public.evaluation_scoring_calls (
  id uuid PRIMARY KEY,
  -- 普通评分沿用运行 ID；直接评分使用同一请求内共享的独立 ID。
  evaluation_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  actor text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('initial','rescore','direct')),
  stage text NOT NULL CHECK (stage IN ('rubric','judge')),
  provider text NOT NULL,
  model text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  cached_tokens bigint CHECK (cached_tokens BETWEEN 0 AND input_tokens),
  total_tokens bigint CHECK (total_tokens >= 0),
  rate_snapshot jsonb,
  estimated_cny numeric(24,10) CHECK (estimated_cny >= 0)
);
CREATE INDEX evaluation_scoring_calls_actor_date ON public.evaluation_scoring_calls(actor, started_at);
CREATE INDEX evaluation_scoring_calls_date ON public.evaluation_scoring_calls(started_at);
CREATE INDEX evaluation_scoring_calls_run ON public.evaluation_scoring_calls(evaluation_id);
COMMIT;
