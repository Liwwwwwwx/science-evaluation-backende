BEGIN;
DO $$ BEGIN
  IF current_database() NOT IN ('science_admin','science_evaluation') THEN RAISE EXCEPTION 'Question standards require evaluation database'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.evaluation_question_standards (
  id uuid PRIMARY KEY, question_id text NOT NULL, dataset_version text NOT NULL,
  question text NOT NULL, content jsonb NOT NULL, model text,
  state text NOT NULL CHECK (state IN ('draft','confirmed','superseded')),
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz
);
CREATE INDEX IF NOT EXISTS evaluation_question_standards_lookup ON public.evaluation_question_standards(question_id,dataset_version,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS evaluation_question_standards_confirmed ON public.evaluation_question_standards(question_id,dataset_version) WHERE state='confirmed';
COMMIT;
