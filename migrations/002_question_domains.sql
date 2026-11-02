-- Review and apply manually; existing questions remain unclassified.
DO $$ BEGIN
  IF current_database() NOT IN ('science_admin', 'science_evaluation') THEN
    RAISE EXCEPTION 'Question domains require science_admin or science_evaluation';
  END IF;
END $$;
ALTER TABLE eval_questions ADD COLUMN IF NOT EXISTS domain_key text;
CREATE INDEX IF NOT EXISTS eval_questions_domain_status_idx ON eval_questions (domain_key, status);
