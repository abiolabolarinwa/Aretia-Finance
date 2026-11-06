#!/bin/sh
# Runs once, the first time the Postgres data directory is empty (docker-entrypoint-initdb.d).
# Creates the roles Supabase provides and the migrations expect, so website/supabase/migrations/*.sql apply unchanged:
#   anon, authenticated   no login, no access to anything unless a migration grants it (they grant nothing today)
#   service_role          no login, bypasses row-level security, used by the site's server code through a signed JWT
#   authenticator         the one login PostgREST uses; it switches to the role named in the request's JWT
set -eu

: "${AUTHENTICATOR_PASSWORD:?AUTHENTICATOR_PASSWORD is not set}"

# The password goes in as a psql variable on stdin, never on a command line, so it does not show in `ps`.
psql -v ON_ERROR_STOP=1 -v pw="$AUTHENTICATOR_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
create role anon          nologin noinherit;
create role authenticated nologin noinherit;
create role service_role  nologin noinherit bypassrls;
create role authenticator login noinherit nosuperuser nocreatedb nocreaterole password :'pw';
grant anon, authenticated, service_role to authenticator;

-- What Supabase's `public` schema gives out, narrowed: only service_role gets new tables, sequences and functions by default.
-- (Supabase also gives anon/authenticated everything and relies on row-level security; here they get nothing at all.)
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables    to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
alter default privileges for role postgres in schema public grant all on functions to service_role;

-- Extensions the migrations may ask for are in the stock image (pgcrypto, etc.). pg_cron and pg_net are deliberately not used: see server/README.md.
create extension if not exists pgcrypto;
SQL
echo "aretia: roles created"
