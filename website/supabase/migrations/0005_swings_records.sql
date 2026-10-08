-- Optional recovery copies of Swings executions and plans. Opt-in: the page sends a record only if the user turns
-- "keep a recovery copy" on. A record holds public information (states, quotes, transaction hashes, the two wallet
-- addresses of the move) and never a key or a secret. Access is by the record's long random id, which only the user
-- holds; there is no listing. Written and read only by /api/swings-records with the service role (row-level security is
-- on and no policy exists, so no other role can touch it).
create table if not exists public.swings_records (
  id          text   primary key check (id ~ '^[a-z0-9_]{24,72}$'),
  kind        text   not null check (kind in ('settlement','plan')),
  version     int    not null check (version >= 1),
  state       text   not null,
  body        jsonb  not null,
  created_at  bigint not null,   -- ms, server clock
  updated_at  bigint not null
);
create index if not exists swings_records_updated on public.swings_records (updated_at desc);
alter table public.swings_records enable row level security;
