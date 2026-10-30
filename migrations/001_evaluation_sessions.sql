-- Apply manually only after verifying the target is the intended science_admin database.
CREATE TABLE public.evaluation_auth_sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.auth_users(id) ON DELETE CASCADE,
  token_version integer NOT NULL,
  password_fingerprint text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evaluation_auth_sessions_user_id_idx ON public.evaluation_auth_sessions(user_id);
CREATE INDEX evaluation_auth_sessions_expires_at_idx ON public.evaluation_auth_sessions(expires_at);
