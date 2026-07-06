-- Adds an atomic "open conversation" RPC: reads the previous last_read_at
-- (needed client-side to know where to draw the "Unread messages" divider)
-- and advances it to now() in the same statement, so there's no race between
-- a separate read and mark_conversation_read's write landing out of order.
-- Safe to run once in the Supabase SQL editor.

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
