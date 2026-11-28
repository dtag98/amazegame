\set ON_ERROR_STOP on
-- Supply the verifier using scripts/render-db-bootstrap.mjs.
\set app_verifier ''
\getenv app_verifier APP_DB_SCRAM_VERIFIER
\set QUIET on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL password_encryption = 'scram-sha-256';

SELECT :'app_verifier' ~ '^SCRAM-SHA-256[$]4096:[A-Za-z0-9+/]{21}[AQgw]==[$][A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$' AS has_app_verifier \gset
\if :has_app_verifier
\else
DO $$
BEGIN
  RAISE EXCEPTION 'Run scripts/render-db-bootstrap.mjs with a generated application password.';
END $$;
\endif

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles AS role
    WHERE role.rolname = 'amazegame_app'
      AND (role.rolsuper OR role.rolcreaterole OR role.rolcreatedb OR role.rolreplication
        OR role.rolbypassrls OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = role.oid))
  ) THEN
    RAISE EXCEPTION 'amazegame_app already exists with elevated privileges. Use a dedicated account role.';
  END IF;
END $$;

SELECT 'CREATE ROLE amazegame_app LOGIN NOINHERIT'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'amazegame_app') \gexec
ALTER ROLE amazegame_app LOGIN PASSWORD :'app_verifier';

CREATE TABLE IF NOT EXISTS public.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(24) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

SELECT EXISTS (
  SELECT 1 FROM pg_attribute
  WHERE attrelid = 'public.accounts'::regclass AND attname = 'email' AND NOT attisdropped
) AS has_legacy_email \gset
\if :has_legacy_email
ALTER TABLE public.accounts
  ALTER COLUMN email DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS accounts_email_key;
REVOKE ALL PRIVILEGES (email) ON TABLE public.accounts FROM amazegame_app;
\endif

SELECT current_database() AS target_database \gset
GRANT CONNECT ON DATABASE :"target_database" TO amazegame_app;
GRANT USAGE ON SCHEMA public TO amazegame_app;
REVOKE ALL PRIVILEGES ON TABLE public.accounts FROM amazegame_app;
REVOKE ALL PRIVILEGES (id, username, password_hash, created_at) ON TABLE public.accounts FROM amazegame_app;
GRANT SELECT (id, username, password_hash), INSERT (username, password_hash)
  ON TABLE public.accounts TO amazegame_app;

DO $$
BEGIN
  IF has_table_privilege('amazegame_app', 'public.accounts', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    OR has_column_privilege('amazegame_app', 'public.accounts', 'created_at', 'SELECT, INSERT, UPDATE, REFERENCES')
  THEN
    RAISE EXCEPTION 'amazegame_app inherits broader access to accounts. Review existing ownership and grants.';
  END IF;
END $$;

COMMIT;
\unset app_verifier
