-- Corrects a mistake made in 004_realtime_authorization.sql / documentation.md
-- §3: disabling "Allow public access" in Realtime Settings does NOT exempt
-- postgres_changes channels the way the Supabase docs (and our own earlier
-- research) suggested. In practice it rejects ANY non-private channel
-- outright — including `messages:<conversationId>`, which was deliberately
-- left public — with "CHANNEL_ERROR PrivateOnly: This project only allows
-- private channels". That broke realtime messaging entirely (sends
-- succeeded via REST, but never streamed back to any client, sender or
-- receiver, until a manual reload).
--
-- Fix has two parts:
-- 1. This policy — authorizes the CHANNEL JOIN for any authenticated user.
--    It is deliberately NOT scoped by conversation membership per-topic; the
--    actual row-level filtering (only your own conversations' messages) is
--    still enforced separately by the `messages` table's own RLS policy
--    ("members read messages", using is_member()), which postgres_changes
--    re-checks per event regardless of channel privacy. Scoping this policy
--    by topic too would be redundant, not more secure.
-- 2. hooks/useMessages.ts now marks the channel `{ config: { private: true } }`.

create policy "authenticated can use postgres_changes"
on "realtime"."messages"
for select
to authenticated
using (
  realtime.messages.extension = 'postgres_changes'
);
