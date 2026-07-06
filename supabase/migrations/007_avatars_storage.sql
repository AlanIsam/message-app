-- Avatar photos, uploaded from the Settings screen. Public bucket (avatars
-- are meant to be visible to anyone, same as usernames) but writes are
-- scoped to a user's own folder via RLS on storage.objects — files are
-- stored at "<user id>/<filename>", and storage.foldername(name)[1] is that
-- first path segment.

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
