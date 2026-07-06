-- Incremental migration for projects that already ran the base schema.sql.
-- Adds unread-message tracking for the conversation list (bold text + count
-- badge) and a realtime-friendly single-RPC fetch for the list itself.
-- Safe to run once in the Supabase SQL editor.

alter table public.conversation_members
  add column if not exists last_read_at timestamptz not null default now();

create or replace function public.mark_conversation_read(convo_id uuid)
returns void
language sql security definer
set search_path = public
as $$
  update public.conversation_members
  set last_read_at = now()
  where conversation_id = convo_id and user_id = auth.uid();
$$;

create or replace function public.get_conversations()
returns table (
  id uuid,
  name text,
  is_group boolean,
  last_message text,
  last_message_at timestamptz,
  other_user_id uuid,
  other_username text,
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
    select p.id, p.username
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
