-- Review and apply manually; existing questions remain unclassified.
DO $$ BEGIN
  IF current_database() <> 'science_admin' THEN
    RAISE EXCEPTION 'Question domains require science_admin';
  END IF;
END $$;
ALTER TABLE eval_questions ADD COLUMN IF NOT EXISTS domain_key text;
CREATE INDEX IF NOT EXISTS eval_questions_domain_status_idx ON eval_questions (domain_key, status);
