-- Closes the gap flagged in requirement/security-hardening.md #6 and
-- documentation.md §3/§7: Broadcast (typing) and Presence (online-users)
-- don't inherit table RLS the way postgres_changes does, so until now anyone
-- holding the publishable key could snoop or spoof typing/presence for any
-- conversation. This adds the missing realtime.messages policies.
--
-- After running this file, you MUST also disable "Allow public access" in
-- Supabase Dashboard → Project Settings → Realtime (or Database → Realtime,
-- depending on your dashboard version) — that setting is what actually
-- enforces private channels project-wide. It does NOT affect the
-- `messages:<id>` postgres_changes channel, which stays public and is
-- unaffected by this toggle (postgres_changes is governed purely by the
-- underlying table's RLS regardless of this setting).

-- --- typing:<conversationId> — broadcast, membership-gated ------------------

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

-- --- online-users — presence, global (any authenticated user) ---------------
-- This channel is intentionally app-wide, not per-conversation (Phase 3 does
-- global online presence only — see requirement/phase-3-presence.md), so the
-- policy just checks the topic name and that the caller is logged in.

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
