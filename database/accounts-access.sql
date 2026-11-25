\set ON_ERROR_STOP on
\getenv app_user APP_DB_USER

BEGIN;
SET LOCAL lock_timeout = '5s';

SELECT EXISTS (
  SELECT 1 FROM pg_attribute
  WHERE attrelid = 'public.accounts'::regclass AND attname = 'email'
    AND NOT attisdropped AND attnotnull
) AS has_required_email \gset
\if :has_required_email
ALTER TABLE public.accounts
  ALTER COLUMN email DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS accounts_email_key;
\endif

REVOKE SELECT, INSERT ON TABLE public.accounts FROM :"app_user";
GRANT SELECT (id, username, password_hash), INSERT (username, password_hash)
  ON TABLE public.accounts TO :"app_user";
COMMIT;
