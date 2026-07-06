# API Reference — extending Randau

This is the reference for anyone adding a feature to this app: every database
table, RPC function, realtime channel, Edge Function, React hook, and
component, with signatures, parameters, and the non-obvious rules each one
follows. `documentation.md` covers *why* things ended up this way (bugs hit,
approaches abandoned); this doc covers *what's actually callable* so you don't
have to read every source file to find out.

**Before adding anything, read §6 (conventions) — it's short, and it's the
part most likely to save you from re-hitting a bug already fixed once.**

---

## 1. Database schema

All tables are `public.*`, defined in `supabase/schema.sql` (fresh installs)
and incrementally in `supabase/migrations/*.sql` (existing projects — see §6.1
for the rule on which one to edit).

### `profiles`
One row per `auth.users` row, auto-created by the `handle_new_user()` trigger
on signup (reads `username` out of `raw_user_meta_data`, set by `signUp()`).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | `= auth.users.id`, cascades on delete |
| `username` | `text` | unique, not null |
| `avatar_url` | `text` | nullable; public Supabase Storage URL, cache-busted with `?t=<timestamp>` on every upload |
| `created_at` | `timestamptz` | |
| `last_seen_at` | `timestamptz` | heartbeat-written by `usePresence.ts`, drives online/offline — not realtime |
| `active_conversation_id` | `uuid` → `conversations.id`, `on delete set null` | set/cleared by `chat/[id].tsx`; read by the `notify` Edge Function to suppress pushes — see §4 |

RLS: any authenticated user can `select` any profile (needed for username
search); a user can only `update` their own row. **No email, password, or
push token is ever exposed through this table** — that's the whole reason
`user_devices` exists as a separate table.

### `conversations`
| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `name` | `text` | `null` for DMs, set for groups |
| `is_group` | `boolean` | |
| `created_by` | `uuid` → `profiles.id` | |
| `created_at` | `timestamptz` | |

RLS: `select` only if `is_member(id, auth.uid())`. **No client-facing insert
policy at all** — rows are only ever created via `create_group`/`create_dm`
(§2). Don't add one; see §6.2.

### `conversation_members`
| Column | Type | Notes |
|---|---|---|
| `conversation_id` | `uuid` → `conversations.id`, cascade | part of composite PK |
| `user_id` | `uuid` → `profiles.id`, cascade | part of composite PK |
| `joined_at` | `timestamptz` | |
| `last_read_at` | `timestamptz` | defaults to `now()` on join, so old history isn't retroactively unread; drives unread badges |

RLS: `select` only own membership rows. **No insert/update/delete policy at
all** — membership only changes via `create_group`/`create_dm` (create) and
`mark_conversation_read`/`open_conversation` (update `last_read_at`). See §6.2
before adding a client-facing write path here.

### `messages`
| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (PK) | |
| `conversation_id` | `uuid` → `conversations.id`, cascade | |
| `sender_id` | `uuid` → `profiles.id` | |
| `content` | `text` not null | rendered as plain `<Text>`, never parsed as HTML — see security-hardening #9 |
| `created_at` | `timestamptz` | |

RLS: members can `select`; `insert` requires `sender_id = auth.uid()` **and**
membership — this is the only table clients insert into directly (everything
else goes through an RPC), because there's no cross-user side effect to an
insert here that RLS can't fully express on its own.

### `user_devices`
| Column | Type | Notes |
|---|---|---|
| `user_id` | `uuid` → `profiles.id`, cascade | part of composite PK |
| `expo_push_token` | `text` not null | part of composite PK |
| `updated_at` | `timestamptz` | |

RLS: `for all using/with check (user_id = auth.uid())` — a user can only ever
touch their own rows. Written by `savePushToken()` (§5), read by the `notify`
Edge Function (§4).

### Storage: `avatars` bucket
Public bucket (read: anyone; write: only into your own `{user_id}/` folder,
enforced via `storage.foldername(name)[1] = auth.uid()::text`). See
`migrations/007_avatars_storage.sql`.

---

## 2. RPC functions (`SECURITY DEFINER`)

Every mutation that touches more than one user's data goes through one of
these instead of a raw client insert/update — see §6.2 for why that's a hard
rule here, not a style preference.

### `create_group(group_name text, member_ids uuid[]) returns uuid`
Creates a group conversation and inserts membership rows for `member_ids`
plus the caller, atomically. `member_ids` should **not** include the caller —
it's added automatically. Returns the new conversation's `id`.
```ts
const { data, error } = await supabase.rpc('create_group', {
  group_name: 'Team chat',
  member_ids: [otherUserId1, otherUserId2],
})
```

### `create_dm(other_user_id uuid) returns uuid`
Returns the existing DM's `id` if one already exists between the caller and
`other_user_id`; otherwise creates a new 2-member, `is_group = false`
conversation. Raises if `other_user_id = auth.uid()`.
```ts
const { data, error } = await supabase.rpc('create_dm', { other_user_id: someUserId })
```

### `get_conversations() returns table (...)`
The conversation list's single round trip. No parameters — implicitly scoped
to `auth.uid()`. Columns:

| Column | Notes |
|---|---|
| `id`, `name`, `is_group` | from `conversations` |
| `last_message`, `last_message_at` | most recent message in the conversation, or both `null` if empty |
| `other_user_id`, `other_username`, `other_avatar_url` | the DM partner's profile; all `null` for groups |
| `unread_count` | `count(messages where created_at > my last_read_at and sender_id != me)` |

Ordered by `coalesce(last_message_at, created_at) desc`. If you add a new
per-conversation field the list needs to display (e.g. a group avatar), add
it here rather than fetching it client-side per row — see §6.4.

### `mark_conversation_read(convo_id uuid) returns void`
Sets `conversation_members.last_read_at = now()` for the caller. Called on
every `messages.length` change while a chat is focused, to keep the list's
unread badge at zero while new messages arrive live.

### `open_conversation(convo_id uuid) returns timestamptz`
Atomically reads the **previous** `last_read_at` (used client-side to
position the "Unread messages" divider) and advances it to `now()` in the
same statement. Called once per chat visit. **Don't split this into a
separate select + `mark_conversation_read` call** — see `documentation.md`
§6.3 for the race that creates.

### `is_member(convo uuid, uid uuid) returns boolean`
Internal helper used inside RLS policies (`security definer`, bypasses RLS
itself to avoid "infinite recursion detected in policy" on
`conversation_members`'s own self-referential checks). Callable from the
client too if you need a cheap membership check, but it's not currently used
that way anywhere.

**Pattern for adding your own RPC:** `language plpgsql security definer set
search_path = public`, `if auth.uid() is null then raise exception
'not authenticated'; end if` as the first line of anything that mutates data,
and never accept a caller-supplied user id for "who is this action performed
as" — always use `auth.uid()`.

---

## 3. Realtime channels

All three are **public** channels (no `private: true`) — see
`documentation.md` §3/§6.9/§6.10 before changing this; a prior attempt to
lock them down with Realtime Authorization was tried and reverted.

| Channel topic | Type | Joined in | Purpose |
|---|---|---|---|
| `` `messages:${conversationId}:${uniqueSuffix}` `` | `postgres_changes` (INSERT on `messages`) | `useMessages.ts` | live message delivery; the `uniqueSuffix` is mount-instance-only, doesn't affect row filtering (that's the `filter` param) |
| `typing:${conversationId}` | `broadcast`, event `typing` | `useTyping.ts` | ephemeral typing indicator; **no unique suffix** — broadcast is peer-to-peer within a topic, all participants must share the exact topic name |
| — (none; presence channel removed) | — | `usePresence.ts` | online/offline is a `last_seen_at` DB heartbeat + poll now, not a Presence channel — see `documentation.md` §6.11/§6.12 before reintroducing one |

Broadcast payload shape for `typing`:
```ts
{ userId: string, username: string }
```

If you add a new realtime feature, prefer `postgres_changes` on an RLS-backed
table over `broadcast` where possible — it gets per-row authorization "for
free" from the table's own RLS, whereas `broadcast` needs its own
`realtime.messages` policy (or, as this project settled on, has to accept
being public).

---

## 4. Edge Function: `notify` (`supabase/functions/notify/index.ts`)

Deno function, triggered by a Database Webhook on `messages` INSERT (not
called directly by the client). Auth is a shared secret header
(`x-webhook-secret`), not a Supabase JWT — `verify_jwt = false` in
`supabase/config.toml` for this function specifically.

**Flow:**
1. Look up all `conversation_members` for `record.conversation_id` except the
   sender.
2. Filter out anyone whose `profiles.active_conversation_id` already equals
   this conversation (they have it open — see `documentation.md` §6.15).
3. Look up `user_devices.expo_push_token` for the remaining recipients.
4. Look up the sender's `username` (used as the push title).
5. POST to `https://exp.host/--/api/v2/push/send` with `sound: 'default'`,
   `channelId: 'messages'` (must match the client-side channel created in
   `usePushToken.ts` — see §5), `title: senderUsername`, `body:
   record.content`, `data: { conversationId }`.
6. Logs (doesn't throw) if Expo's response reports a per-message error.

**To extend:** if you add a new notifiable event (e.g. someone added you to a
group), you'd add a new Database Webhook (or branch inside this same
function on a payload shape check) rather than repurposing the `messages`
one — keep the webhook secret and `verify_jwt = false` pattern.

Deploy: `npx supabase functions deploy notify`. Secrets:
`npx supabase secrets set WEBHOOK_SECRET=<value>` (`SUPABASE_URL` and
`SUPABASE_SECRET_KEYS` are auto-injected).

---

## 5. Hooks (`hooks/*.ts`)

### `useAuth()` / `useAuthState()` (`useAuth.ts`)
`useAuthState()` owns the actual `supabase.auth` subscription and is called
once, at the root (`app/_layout.tsx`), feeding `AuthContext`. Everywhere else,
call `useAuth()` to read from that context.
```ts
type AuthContextValue = {
  session: Session | null
  user: User | null
  initializing: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, username: string) => Promise<void>
  signOut: () => Promise<void>
}
```
`signUp` passes `username` via `options.data`, which `handle_new_user()`
picks up server-side to create the `profiles` row — there's no separate
"create profile" client call.

### `useMessages(conversationId, currentUserId, onIncomingMessage?)` (`useMessages.ts`)
```ts
const { messages, loading, loadingMore, hasMore, sendMessage, loadMoreMessages } =
  useMessages(conversationId, user?.id, () => playMessageSound())
```
- `messages`: chronological (oldest first) array of `Message & { profiles: Profile | null }`.
- `loading`: true during the initial page fetch.
- `loadingMore` / `hasMore`: state for the pagination UI (§1 in `documentation.md`, §5.1 there for the design).
- `sendMessage(content)`: inserts a row; **does not optimistically append** —
  the realtime subscription delivers your own insert back. Don't add
  optimistic appending without also deduping against that (see the `prev.find`
  guard in the subscription callback).
- `loadMoreMessages()`: cursor-based (`created_at < oldest loaded`), fetches
  the next 20 older messages, prepends, dedupes by `id`. No-ops if already
  loading or `hasMore` is false.
- `onIncomingMessage` fires only for messages **not** sent by
  `currentUserId` — used to play the receive sound without also playing it
  for your own sent messages.

### `usePresence(currentUserId)` / `usePresenceContext()` (`usePresence.ts`, `usePresenceContext.tsx`)
```ts
const { isOnline } = usePresenceContext() // anywhere under <PresenceProvider>
isOnline(someUserId) // boolean
```
DB heartbeat (writes `last_seen_at` every 10s while `AppState` is `active`)
+ poll (reads every profile's `last_seen_at` every 10s). A user counts as
online if seen within the last 25s (~2.5x the heartbeat interval, tolerates
one missed beat). **`poll()` currently reads the entire `profiles` table** —
fine at small scale, first thing to scope down (e.g. to users sharing a
conversation with you) if this needs to grow.

### `useTyping(conversationId, currentUser)` (`useTyping.ts`)
```ts
const { typingUsers, notifyTyping } = useTyping(conversationId, currentProfile)
const label = formatTypingLabel(typingUsers) // "X is typing…" / "X and Y are typing…" / "Several people are typing…"
```
`notifyTyping()` is throttled to once per second and should be called from
the message input's `onChangeText`. Each received broadcast auto-clears
after 2.5s of silence (per-user timeout, reset on every new event from that
user).

### `useMessageSound()` (`useMessageSound.ts`)
```ts
const playMessageSound = useMessageSound()
playMessageSound() // async, fails silently if the sound didn't preload
```
Preloads `assets/sounds/message.mp3` once per mount via `expo-av`.

### `usePushToken.ts` — `registerForPushNotifications()`, `savePushToken(userId, token)`
```ts
const token = await registerForPushNotifications() // null on web, emulators, or denied permission
if (token) await savePushToken(user.id, token)
```
On Android, also creates the `messages` notification channel (`MAX`
importance, vibration pattern, default sound) as a side effect — required
for sound/vibration to work at all on API 26+. **If you ever need to change
channel properties** (sound, vibration pattern, importance), you must bump
the channel id (e.g. `messages-v2`) rather than edit `'messages'` in place —
Android forbids changing an existing channel's importance, and existing
installs won't pick up other property changes either.

---

## 6. Conventions for extending this app

### 6.1 Schema changes: migrations, not `schema.sql`
`schema.sql` has no `IF NOT EXISTS` guards on purpose — it's meant to fail
loudly on a fresh project if something's wrong, not silently half-apply.
Never re-run it against a project that already has tables. Add a new
numbered file under `supabase/migrations/` instead, written to be safely
re-runnable (`add column if not exists`, `create or replace function`). Then
mirror the change into `schema.sql` too, so a brand-new install still ends up
in the same final state as an incrementally-migrated one.

### 6.2 Cross-user mutations go through an RPC, never a raw insert/update
If a client-side insert/update policy would let User A affect data that
"belongs" to User B (join a conversation they weren't invited to, mark
someone else's messages read, etc.), don't write that policy — write a
`SECURITY DEFINER` RPC that checks `auth.uid()` and does the write
server-side instead. This is the fix for the IDOR described in
`requirement/security-hardening.md` #2, and `conversation_members` /
`conversations` are deliberately locked to zero client-facing write policies
as a result. Extending group membership (add/remove member, rename, leave —
currently unimplemented, see `documentation.md` §7) should follow this same
pattern: a new RPC, not a new table policy.

### 6.3 New realtime needs: prefer `postgres_changes` over `broadcast`
`postgres_changes` re-checks the underlying table's RLS per event, so it's
"secure by default" the same way a normal query is. `broadcast` (used here
only for typing) doesn't inherit RLS at all — it needs its own
`realtime.messages` policy, which this project tried and found unreliable in
practice (`documentation.md` §6.10). If what you're building can be expressed
as "notify me when this table changes," reach for `postgres_changes` first.

### 6.4 Conversation-list fields belong in `get_conversations()`, not a per-row client fetch
The list is already one round trip for every conversation; adding a client-side
`.select()` per row to fetch one more field (e.g. a group's member count)
reintroduces the N-query pattern `get_conversations()` was written to
replace. Extend the SQL function's return columns instead (remember: this
requires `drop function if exists public.get_conversations();` before
`create or replace function`, since adding an OUT column changes the row
type — Postgres won't let `create or replace` do that in place. See
`migrations/009_conversation_list_avatar.sql` for a worked example).

### 6.5 Colors, never hardcoded hex
Import from `constants/colors.ts` (`colors.accent`, `colors.textMuted`, etc.)
in every component. There's no light-mode variant yet — if you add one,
this is the one file that would need a second palette + a way to switch
between them.

### 6.6 Channel/topic naming for anything using `.channel()`
- If the channel carries **row-level Postgres data** (`postgres_changes`),
  give it a unique-per-mount suffix (`${Date.now()}-${Math.random()...}`) —
  see `documentation.md` §6.13 for the exact remount race this avoids. Safe
  because filtering comes from the `filter` config, not the topic string.
- If the channel is **peer-to-peer** (`broadcast`, `presence`), do **not**
  randomize the topic — every participant must join the identical topic name
  to see each other's events at all.

### 6.7 Rendering user-generated content
Message content and usernames are rendered as plain React Native `<Text>`,
never through `dangerouslySetInnerHTML` or any HTML-parsing path — this is
what prevents stored XSS on the web build (security-hardening #9). Keep
that invariant for any new field that displays user input.
