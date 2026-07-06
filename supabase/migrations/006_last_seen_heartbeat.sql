-- Replaces WebSocket Presence for online/offline status with a DB heartbeat.
-- See documentation.md §6.11/§6.12 — Phoenix Presence went stale after
-- extended sessions/reconnects with no reliable fix found. A last_seen_at
-- timestamp + client-side poll is less elegant but doesn't depend on any
-- single long-lived channel's internal state staying in sync with the server.

alter table public.profiles
  add column if not exists last_seen_at timestamptz not null default now();

-- No RLS changes needed: "profiles are viewable by authenticated users" (select)
-- and "users can update own profile" (update, auth.uid() = id) already cover
-- reading/writing this column.
