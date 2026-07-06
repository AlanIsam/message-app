-- Chat app schema — security-hardened version.
-- This supersedes the policies drafted in requirement/overview.md, phase-4, and phase-5;
-- see requirement/security-hardening.md for the rationale behind each policy below.
-- Run this whole file in the Supabase SQL editor on a fresh project.

-- ============================================================================
-- Tables
-- ============================================================================

create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  username text unique not null,
  avatar_url text,
  created_at timestamptz default now(),
  -- Online/offline status is derived from this via a client heartbeat + poll
  -- (hooks/usePresence.ts), not Phoenix Presence — see documentation.md §6.12
  -- for why Presence was replaced.
  last_seen_at timestamptz not null default now()
);

create table public.conversations (
  id uuid default gen_random_uuid() primary key,
  name text,                  -- null for DMs, set for groups
  is_group boolean default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz default now()
);

-- Added after both tables exist (forward reference) — lets the notify Edge
-- Function skip pushing to someone who already has this exact conversation
-- open and foregrounded. See migrations/008_active_conversation_tracking.sql.
alter table public.profiles
  add column if not exists active_conversation_id uuid references public.conversations(id) on delete set null;

create table public.conversation_members (
  conversation_id uuid references public.conversations(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  joined_at timestamptz default now(),
  -- Drives unread-message badges on the conversation list. Defaults to now()
  -- so joining a conversation doesn't retroactively mark old history unread.
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table public.messages (
  id uuid default gen_random_uuid() primary key,
  conversation_id uuid references public.conversations(id) on delete cascade,
  sender_id uuid references public.profiles(id),
  content text not null,
  created_at timestamptz default now()
);

-- Push tokens live in their own table, never on profiles (security-hardening #4) —
-- profiles is world-readable to authenticated users, so tokens must not live there.
create table public.user_devices (
  user_id uuid references public.profiles(id) on delete cascade,
  expo_push_token text not null,
  updated_at timestamptz default now(),
  primary key (user_id, expo_push_token)
);

-- ============================================================================
-- Auto-create profile on signup
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username)
  values (new.id, new.raw_user_meta_data->>'username');
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================================
-- Helper: membership check that does NOT recurse through RLS
-- (also avoids "infinite recursion detected in policy" on self-referential
--  conversation_members policies)
-- ============================================================================

create or replace function public.is_member(convo uuid, uid uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from public.conversation_members
    where conversation_id = convo and user_id = uid
  );
$$;

-- ============================================================================
-- Group + members created atomically, server-side, as the caller
-- (security-hardening #2 — replaces client-side two-step insert from phase-4)
-- ============================================================================

create or replace function public.create_group(group_name text, member_ids uuid[])
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  insert into public.conversations (name, is_group, created_by)
  values (group_name, true, auth.uid())
  returning id into new_id;

  insert into public.conversation_members (conversation_id, user_id)
  select new_id, uid
  from unnest(array_append(member_ids, auth.uid())) as uid
  on conflict do nothing;

  return new_id;
end;
$$;

-- Same pattern for 1:1 DMs — a DM is just a 2-member, is_group=false conversation.
-- Reuses the same server-side-membership pattern so clients never insert
-- conversation_members directly.
create or replace function public.create_dm(other_user_id uuid)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  new_id uuid;
  existing_id uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if other_user_id = auth.uid() then raise exception 'cannot DM yourself'; end if;

  -- Reuse an existing DM between these two users if one already exists.
  select c.id into existing_id
  from public.conversations c
  where c.is_group = false
    and public.is_member(c.id, auth.uid())
    and public.is_member(c.id, other_user_id)
  limit 1;

  if existing_id is not null then
    return existing_id;
  end if;

  insert into public.conversations (name, is_group, created_by)
  values (null, false, auth.uid())
  returning id into new_id;

  insert into public.conversation_members (conversation_id, user_id)
  values (new_id, auth.uid()), (new_id, other_user_id)
  on conflict do nothing;

  return new_id;
end;
$$;

-- ============================================================================
-- Unread tracking — powers the conversation list's bold/badge state.
-- No client UPDATE policy on conversation_members (keeps the same
-- default-deny posture as #2) — reads/writes go through these two functions.
-- ============================================================================

create or replace function public.mark_conversation_read(convo_id uuid)
returns void
language sql security definer
set search_path = public
as $$
  update public.conversation_members
  set last_read_at = now()
  where conversation_id = convo_id and user_id = auth.uid();
$$;

-- Atomic read-then-advance: returns the previous last_read_at (so the client
-- can render an "Unread messages" divider above the first message newer than
-- that cutoff) while advancing it to now() in the same statement — avoids a
-- race between a separate SELECT and mark_conversation_read's UPDATE.
create or replace function public.open_conversation(convo_id uuid)
returns timestamptz
language plpgsql security definer
set search_path = public
as $$
declare
  prev_read_at timestamptz;
begin
  select last_read_at into prev_read_at
  from public.conversation_members
  where conversation_id = convo_id and user_id = auth.uid();

  update public.conversation_members
  set last_read_at = now()
  where conversation_id = convo_id and user_id = auth.uid();

  return prev_read_at;
end;
$$;

-- Single round trip for the conversation list: name/DM-partner resolution,
-- last message preview, and unread count all computed server-side instead of
-- the three separate client-side queries + merge this replaces.
create or replace function public.get_conversations()
returns table (
  id uuid,
  name text,
  is_group boolean,
  last_message text,
  last_message_at timestamptz,
  other_user_id uuid,
  other_username text,
  other_avatar_url text,
  unread_count bigint
)
language sql security definer stable
set search_path = public
as $$
  select
    c.id,
    c.name,
    c.is_group,
    lm.content as last_message,
    lm.created_at as last_message_at,
    ou.id as other_user_id,
    ou.username as other_username,
    ou.avatar_url as other_avatar_url,
    coalesce(uc.unread_count, 0) as unread_count
  from public.conversation_members cm
  join public.conversations c on c.id = cm.conversation_id
  left join lateral (
    select m.content, m.created_at
    from public.messages m
    where m.conversation_id = c.id
    order by m.created_at desc
    limit 1
  ) lm on true
  left join lateral (
    select p.id, p.username, p.avatar_url
    from public.conversation_members cm2
    join public.profiles p on p.id = cm2.user_id
    where cm2.conversation_id = c.id
      and cm2.user_id != auth.uid()
      and c.is_group = false
    limit 1
  ) ou on true
  left join lateral (
    select count(*) as unread_count
    from public.messages m
    where m.conversation_id = c.id
      and m.created_at > cm.last_read_at
      and m.sender_id != auth.uid()
  ) uc on true
  where cm.user_id = auth.uid()
  order by coalesce(lm.created_at, c.created_at) desc;
$$;

-- ============================================================================
-- Row Level Security — enable on every table (security-hardening #1)
-- ============================================================================

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.user_devices enable row level security;

-- --- profiles ---------------------------------------------------------------
-- Only expose what group-creation search needs: id, username, avatar_url.
-- Never expose email or push tokens through this table.
create policy "profiles are viewable by authenticated users"
  on public.profiles for select using (auth.role() = 'authenticated');

create policy "users can update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- --- conversations -----------------------------------------------------------
create policy "members read conversation"
  on public.conversations for select
  using (public.is_member(id, auth.uid()));

-- No direct client INSERT policy — conversations are only created via the
-- create_group / create_dm SECURITY DEFINER functions above (default-deny).

-- --- conversation_members ----------------------------------------------------
create policy "members read own membership rows"
  on public.conversation_members for select
  using (public.is_member(conversation_id, auth.uid()));

-- No client INSERT/UPDATE/DELETE policy — membership changes only happen
-- through create_group / create_dm (security-hardening #2, the IDOR fix).

-- --- messages ------------------------------------------------------------
create policy "members read messages"
  on public.messages for select
  using (public.is_member(conversation_id, auth.uid()));

create policy "members send own messages"
  on public.messages for insert
  with check (
    sender_id = auth.uid()
    and public.is_member(conversation_id, auth.uid())
  );

-- --- user_devices ----------------------------------------------------------
create policy "own devices only"
  on public.user_devices for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ============================================================================
-- Realtime
-- ============================================================================
-- After running this file:
-- 1. Supabase Dashboard → Database → Replication → enable the `messages` table
--    for INSERT events.
-- 2. Leave Project Settings → Realtime → "Allow public access to channels"
--    at its default (ON). A prior attempt to lock this down (disable public
--    access + require private channels + the policies below) was tried and
--    reverted — see documentation.md §6.9/§6.10 for the full story of why.
--    None of the three channels this app actually joins (see
--    hooks/useMessages.ts, useTyping.ts) pass `private: true`, so disabling
--    public access here would reject all of them outright with
--    "CHANNEL_ERROR PrivateOnly: This project only allows private channels".
--    The policies below are kept for reference only and are NOT required for
--    a fresh install to work — postgres_changes re-checks the `messages`
--    table's own RLS per event regardless of channel privacy, and
--    typing/presence are public on purpose (security-hardening.md rates
--    unauthorized access to them as low-severity, "a visual nicety").

-- messages:<conversationId> (postgres_changes) — DORMANT (see note above).
-- Authorizes the channel join for any authenticated user. NOT scoped by
-- conversation membership per topic on purpose: per-row filtering is
-- separately and already enforced by the `messages` table's own RLS
-- ("members read messages" above), which postgres_changes re-checks per
-- event regardless of channel privacy. Scoping this policy by topic too
-- would be redundant, not more secure.
create policy "authenticated can use postgres_changes"
on "realtime"."messages"
for select
to authenticated
using (
  realtime.messages.extension = 'postgres_changes'
);

-- typing:<conversationId> (broadcast) — DORMANT (see note above). Would be
-- membership-gated if private channels were ever re-enabled, since Broadcast
-- does NOT inherit table RLS the way postgres_changes does.
create policy "members receive typing broadcast"
on "realtime"."messages"
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and public.is_member(
    (regexp_match(realtime.topic(), '^typing:(.+)$'))[1]::uuid,
    auth.uid()
  )
);

create policy "members send typing broadcast"
on "realtime"."messages"
for insert
to authenticated
with check (
  realtime.messages.extension = 'broadcast'
  and public.is_member(
    (regexp_match(realtime.topic(), '^typing:(.+)$'))[1]::uuid,
    auth.uid()
  )
);

-- online-users (presence) — DORMANT, kept for reference only. usePresence.ts
-- no longer joins this channel; online/offline is now a last_seen_at
-- heartbeat + poll on public.profiles (see documentation.md §6.12) because
-- Presence's live-channel state went stale after extended sessions/reconnects
-- with no reliable fix found (§6.11). Safe to drop these two policies
-- entirely once nothing else needs Presence for this project.
create policy "authenticated receive presence"
on "realtime"."messages"
for select
to authenticated
using (
  realtime.messages.extension = 'presence'
  and realtime.topic() = 'online-users'
);

create policy "authenticated send presence"
on "realtime"."messages"
for insert
to authenticated
with check (
  realtime.messages.extension = 'presence'
  and realtime.topic() = 'online-users'
);

-- ============================================================================
-- Avatar storage — see migrations/007_avatars_storage.sql for the full
-- rationale. Public bucket (avatars are as visible as usernames already
-- are), writes scoped per-user via the folder-name RLS pattern below.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatar images are publicly accessible"
on storage.objects for select
using (bucket_id = 'avatars');

create policy "users can upload their own avatar"
on storage.objects for insert
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "users can update their own avatar"
on storage.objects for update
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "users can delete their own avatar"
on storage.objects for delete
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ============================================================================
-- Recommended Auth settings (configure in Supabase Dashboard → Authentication)
-- ============================================================================
-- - Enable leaked-password protection (HaveIBeenPwned check)
-- - Minimum password length >= 10
-- - Require email confirmation before the account is usable
-- - Enable CAPTCHA (hCaptcha/Turnstile) on signup and sign-in
-- - Keep refresh-token rotation ON, use a short access-token TTL
