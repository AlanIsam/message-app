-- Lets the notify Edge Function skip pushing to someone who already has the
-- exact conversation open and foregrounded — they're already seeing the
-- message live via realtime, so a push notification there is just noise
-- (and, worse, sound/vibration for a chat you're actively looking at).
-- Updated by the client (hooks/../chat/[id].tsx) on focus/AppState changes;
-- covered by the existing "users can update own profile" RLS policy since
-- it's just another column on the caller's own row.

alter table public.profiles
  add column if not exists active_conversation_id uuid references public.conversations(id) on delete set null;
