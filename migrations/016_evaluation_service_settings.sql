BEGIN;

DO $$ BEGIN
  IF current_database() NOT IN ('science_admin', 'science_evaluation') THEN
    RAISE EXCEPTION 'Unexpected evaluation database';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.evaluation_service_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  overrides jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(overrides) = 'object'),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.evaluation_service_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

COMMIT;
