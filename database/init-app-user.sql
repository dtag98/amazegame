\set ON_ERROR_STOP on
\getenv app_user APP_DB_USER
\getenv app_password APP_DB_PASSWORD
\getenv db_name POSTGRES_DB

BEGIN;
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE :"db_name" TO :"app_user";
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(24) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
GRANT USAGE ON SCHEMA public TO :"app_user";
GRANT SELECT (id, username, password_hash), INSERT (username, password_hash)
  ON TABLE public.accounts TO :"app_user";
COMMIT;
