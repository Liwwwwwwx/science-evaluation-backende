-- 仅在用户授权的 science_admin 或 science_evaluation 数据库手工执行；应用不自动运行迁移。
BEGIN;
DO $$ BEGIN IF current_database() NOT IN ('science_admin', 'science_evaluation') THEN RAISE EXCEPTION 'requires science_admin or science_evaluation'; END IF; END $$;
CREATE TABLE IF NOT EXISTS public.evaluation_scoring_rules (
  id uuid PRIMARY KEY,
  version_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  revision integer NOT NULL DEFAULT 1,
  name varchar(100) NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  config jsonb NOT NULL CHECK (jsonb_typeof(config)='object'),
  change_note varchar(1000) NOT NULL DEFAULT '',
  created_by text NOT NULL, updated_by text NOT NULL, published_by text,
  creation_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.evaluation_scoring_rule_state (
  id integer PRIMARY KEY CHECK (id=1),
  active_rule_id uuid REFERENCES public.evaluation_scoring_rules(id),
  revision integer NOT NULL DEFAULT 0, updated_by text, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.evaluation_scoring_rule_state(id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.evaluation_scoring_rule_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id uuid NOT NULL REFERENCES public.evaluation_scoring_rules(id),
  action text NOT NULL, actor text NOT NULL, revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
