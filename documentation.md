# Developer Documentation

This is the deep-dive doc for anyone picking up this codebase after the initial
build. `README.md` covers *setup*; this file covers *architecture, decisions,
known bugs already fixed (and why), and how to troubleshoot new ones*.

Built from the spec in `requirement/*.md`, with `requirement/security-hardening.md`
overriding the weaker policies drafted in `overview.md` / `phase-4` / `phase-5`.

---

## 1. Current status

All 5 phases + security hardening + one post-launch feature request are implemented
and manually verified against a live Supabase project with two real accounts
(`alansam` and `Atmin`) talking to each other:

| Feature | Status |
|---|---|
| Auth (register/login, session persistence) | ✅ verified |
| Realtime 1:1 messaging | ✅ verified |
| Presence (online badges) | ✅ verified |
| Typing indicators | ✅ verified |
| Groups (create, message, member list) | ✅ verified |
| In-app sound on message receive | ⚠️ wired up, untested (placeholder audio file — see §6) |
| Android push notifications | ✅ verified end-to-end on a real device (webhook → Edge Function → Expo push → device, with vibration) — see §6.14 |
| Live-updating conversation list (no manual refresh) | ✅ verified |
| Unread bold text + count badge | ✅ verified |
| "Unread messages" divider inside a chat | ✅ verified |

---

## 2. Architecture

```
app/
├── _layout.tsx              Root: AuthContext provider, notification handler/listener
├── (auth)/                  Login/register stack, redirects to (app) if session exists
└── (app)/
    ├── _layout.tsx          Redirects to login if no session; wraps PresenceProvider;
    │                        registers push token on login
    ├── index.tsx            Conversation list — see §4 for its realtime design
    └── chat/[id].tsx         Chat screen — see §5 for the unread-tracking design

hooks/
├── useAuth.ts               Session state + signIn/signUp/signOut
├── useMessages.ts           Per-conversation message fetch + realtime subscription
├── usePresence.ts           Global online-users presence channel
├── usePresenceContext.tsx   React context wrapper around usePresence
├── useTyping.ts             Per-conversation typing broadcast channel
├── useMessageSound.ts       Preloads + plays assets/sounds/message.mp3
└── usePushToken.ts          Expo push token registration + storage in user_devices

lib/
├── supabase.ts              Client singleton — SecureStore on native, AsyncStorage on web
└── types.ts                 Shared Profile / Message / Conversation types

supabase/
├── schema.sql                Full schema for a FRESH project (run once, top to bottom)
├── migrations/                Incremental changes for a project that already ran schema.sql
│   ├── 002_unread_tracking.sql          last_read_at column, mark_conversation_read(), get_conversations()
│   ├── 003_unread_divider.sql           open_conversation() — atomic read-then-advance
│   ├── 004_realtime_authorization.sql   realtime.messages policies for typing + presence
│   └── 005_postgres_changes_private.sql realtime.messages policy for postgres_changes — see §6.9
└── functions/notify/index.ts  Push notification Edge Function (Phase 5 Part B)
```

**Rule of thumb for future schema changes:** never re-run `schema.sql` against
a project that already has the tables — it has no `IF NOT EXISTS` guards on
purpose (so a fresh install fails loudly on typos instead of silently
half-applying). Add a new numbered file under `supabase/migrations/` instead,
written to be safely re-runnable (`add column if not exists`,
`create or replace function`).

---

## 3. Security model (read `requirement/security-hardening.md` first)

The short version: **the anon/publishable key is public, so RLS is the only
real boundary.** Every client-facing mutation that touches more than one
user's data goes through a `SECURITY DEFINER` RPC instead of a raw
insert/update, so the server — not the client — decides what's allowed:

| RPC | Replaces | Why not a raw insert/update |
|---|---|---|
| `create_group(name, member_ids)` | client inserting into `conversation_members` | a permissive insert policy would let anyone join any conversation (IDOR) |
| `create_dm(other_user_id)` | same, for 1:1s | same reason, plus dedupes existing DMs |
| `mark_conversation_read(convo_id)` | client `update`ing `conversation_members.last_read_at` | keeps `conversation_members` fully default-deny for direct client writes |
| `open_conversation(convo_id)` | a separate select + the update above | atomicity — see §5 |
| `get_conversations()` | 3 separate client-side queries + JS merge | one round trip, and keeps the unread-count math server-side |

`conversation_members` and `conversations` have **no client-facing
INSERT/UPDATE policy at all.** If you're tempted to add one to "simplify"
something, don't — write another narrow RPC instead. That's the whole point
of the IDOR fix in security-hardening.md #2.

**Realtime channels — all three are public (final state, after a lot of
churn — read §6.9/§6.10 before "fixing" this again):**

`messages:<id>`, `typing:<id>`, and `online-users` are all plain public
channels, no `private: true` anywhere, and "Allow public access to channels"
is **on** in Supabase Realtime settings. This is a deliberate reversal of an
attempt to lock down `typing`/`presence` with Realtime Authorization — see
§6.9 and §6.10 for the full story of why that was abandoned. Short version:
- `messages:<conversationId>` (postgres_changes) was always meant to be
  public — it re-checks the `messages` table's own RLS per event regardless
  of channel privacy, so this is fully protected already. Marking it private
  actively breaks it (§6.9).
- `typing:<conversationId>` (broadcast) and `online-users` (presence) *can*
  theoretically be locked down with matching `realtime.messages` policies
  (still present in `migrations/004_realtime_authorization.sql`, currently
  unused/dormant), but Realtime Authorization proved unreliable in practice
  for this project — a policy confirmed correct in `pg_policies` still got
  rejected with "Unauthorized" at runtime (§6.10). Given
  security-hardening.md itself rates unauthorized presence/typing access as
  low-severity ("best-effort... a visual nicety"), we reverted to public
  rather than keep chasing it.

If a future need justifies revisiting this (e.g. compliance requirement, not
just general hardening appetite), start from §6.10's exact repro steps rather
than assuming the migration 004 policies just need re-enabling — they were
confirmed correct once already and still didn't work.

---

## 4. Conversation list realtime design (`app/(app)/index.tsx`)

The list calls `get_conversations()` on mount/focus (`useFocusEffect`) and
also holds two long-lived subscriptions for the lifetime of the mounted
screen:

```ts
supabase.channel('conversation-list-messages')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => loadConversations())

supabase.channel('conversation-list-membership')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversation_members', filter: `user_id=eq.${user.id}` }, () => loadConversations())
```

The messages subscription has **no filter** — it listens for every INSERT on
the whole table and just refetches. That's intentional and safe: RLS means
you only ever actually *receive* rows for conversations you're a member of,
and a full `get_conversations()` refetch is cheap enough at this app's scale
that a debounce wasn't worth the complexity. If this ever needs to scale to
users with hundreds of conversations, that refetch-on-every-message approach
is the first thing to revisit (e.g., patch the single affected row locally
instead of refetching everything).

---

## 5. Unread tracking design (`app/(app)/chat/[id].tsx`)

Two RPCs, called from two separate effects, on purpose:

1. **`open_conversation(convo_id)`** — fires once per chat visit, gated by a
   `openedForId` ref so it doesn't refire on every render. Atomically reads
   the *previous* `last_read_at` (used to compute where the "Unread
   messages" divider goes) and advances it to `now()` in the same
   transaction. This has to be one atomic RPC, not a separate SELECT then
   UPDATE — see §6.3 for what happens if you split it.
2. **`mark_conversation_read(convo_id)`** — fires again on every subsequent
   `messages.length` change *while the screen stays focused*, so the list's
   badge doesn't creep back up while you're actively reading new messages
   that arrive mid-conversation. It deliberately does **not** touch the
   divider position — that's captured once, by #1, per visit.

Both effects are gated on `useIsFocused()` from `@react-navigation/native`.
This gate is load-bearing, not decorative — see §6.2.

The divider position is computed client-side:
```ts
const firstUnreadMessageId = messages.find(
  (m) => m.sender_id !== user.id && new Date(m.created_at).getTime() > cutoffTime
)?.id
```
This mirrors `get_conversations()`'s SQL exactly (`sender_id != auth.uid()`
and `created_at > last_read_at`) so the divider and the badge count that led
you here always agree.

---

## 6. Bugs already found and fixed (read before you "fix" something similar)

### 6.1 — Don't mark `postgres_changes` channels private (superseded — see §6.9)

**⚠️ This conclusion turned out to be conditional, not absolute — read §6.9
before acting on it.** Keeping this entry for the original symptom/diagnosis,
since the underlying mechanics explained here are still accurate.

**Symptom:** messages you send never appear for you via realtime; only a
manual refresh shows them. Console shows `Realtime send() is automatically
falling back to REST API`.

**Cause:** `hooks/useMessages.ts` had
`supabase.channel(`messages:${id}`, { config: { private: true } })` while
"Allow public access to channels" was still **on** for the project. Private
channels require a `realtime.messages` RLS policy to authorize the
WebSocket join; without one, the join silently fails and nothing streams.

**Fix at the time:** removed `private: true` from that channel, since
`postgres_changes` already re-checks table RLS per event regardless of
channel privacy (still true — see security-hardening.md #6). This was
correct advice for as long as "Allow public access" stayed on.

**What changed:** §6.9 disabled "Allow public access" project-wide to close
the Broadcast/Presence gap. That setting turns out to reject *any*
non-private channel, `postgres_changes` included — so `messages:<id>` had to
go back to `private: true` after all, this time paired with a
`realtime.messages` policy that authorizes the join (not membership-scoped;
see §6.9). The lesson isn't "never make postgres_changes private" — it's
"whether it needs to be private depends on the project's public-access
setting, and if you disable that setting, every channel needs a matching
policy or it breaks completely."

### 6.2 — Screens stay mounted in the background on web; gate side effects on focus

**Symptom:** a conversation you weren't looking at silently gets marked
"read," so its unread badge never appears even though you never opened it.

**Cause:** unlike native stack navigators (which usually unmount
non-visible screens), expo-router on web keeps previously-visited screens
mounted for back-transition animations. An effect with no focus check that
runs "whenever a new message arrives" keeps running for a screen sitting
invisibly in the background.

**Fix:** gate any "mark as read" (or similarly focus-sensitive) effect on
`useIsFocused()` from `@react-navigation/native`, and include it in the
effect's dependency array so it re-evaluates on focus change, not just on
data change.

### 6.3 — Read-then-write on the same row needs one atomic RPC, not two calls

**Symptom (hypothetical — designed around before it could happen):** the
"Unread messages" divider position is wrong or missing, because by the time
you read the "previous" `last_read_at` to compute where unread starts,
something else already advanced it.

**Fix:** `open_conversation(convo_id)` does the SELECT and the UPDATE inside
one `plpgsql` function, so there's no window for another call (or another
mounted screen — see §6.2) to interleave. If you ever need a third
"check-then-act" pattern on `conversation_members`, follow this pattern
rather than doing it as two separate client round trips.

### 6.4 — Inverted `FlatList` flips each cell's internal layout, not just cell order

**Symptom:** the unread divider rendered *below* the message it was supposed
to sit above.

**Cause:** `inverted` on `FlatList` doesn't just reverse which cell renders
near the top vs. bottom — on web at least, it applies a vertical flip that
also flips the internal JSX order *within* a single `renderItem` return. So
`<Divider /><Bubble />` in source order rendered visually as
`Bubble, then Divider`.

**Fix:** write the JSX in the "wrong" order on purpose —
`<Bubble /><Divider />` in source renders divider-above-bubble on screen.
If you add more inline decorations to message cells (date separators, etc.),
remember this and test the actual rendered order, not just what looks
right in the source.

### 6.5 — New Supabase API key system (publishable/secret, not anon/service_role)

Supabase is retiring the legacy anon/service_role key naming. This app uses
the new names throughout:
- Client: `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_...`), not
  `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
- Edge Function: reads `Deno.env.get('SUPABASE_SECRET_KEYS')` (a JSON map,
  `{"default": "sb_secret_..."}`) rather than the legacy
  `SUPABASE_SERVICE_ROLE_KEY`. Both are still auto-injected by Supabase during
  the migration window, but don't add new code that depends on the legacy
  names.
- `supabase/config.toml` sets `verify_jwt = false` for the `notify` function,
  since it authenticates via a custom `x-webhook-secret` header rather than a
  Supabase-issued JWT — the new key format makes the gateway stricter about
  rejecting non-JWT `Authorization` headers, so this was already implicitly
  required and is now explicit.

### 6.6 — Web bundling needs two extra packages not in the original phase-1 install list

`npx expo install react-native-web react-dom` — without these, `expo start
--web` fails immediately with a clear error, so this is easy to diagnose,
but easy to forget since phase-1's prerequisite list doesn't mention it.

Separately, `@supabase/supabase-js` (2.x, recent versions) references
`@opentelemetry/api` for optional tracing. Metro can't resolve it if it's not
installed, and fails with `Unable to resolve "@opentelemetry/api"`. Fix:
`npm install @opentelemetry/api`. Not in `package.json`'s original dependency
list for the same reason — it wasn't needed until a newer supabase-js patch
version pulled it in.

### 6.7 — Realtime goes silently dead after the app/tab sits idle, even for public channels

**Symptom:** leave the app open and idle for even a few minutes (well under
the ~1hr token expiry from #6.8 below — a separate issue), then send a
message: it doesn't appear on either the sender's or receiver's side until a
manual reload. Affects the public `messages:<id>` channel too, not just the
private ones.

**Cause:** this is a well-documented upstream behavior, not something
specific to this app — see [Supabase's own troubleshooting
guide](https://supabase.com/docs/guides/troubleshooting/realtime-handling-silent-disconnections-in-backgrounded-applications-592794).
Browsers throttle JS timers in backgrounded/inactive tabs. The realtime
socket's heartbeat is one of those timers — when it's starved for long
enough, the server assumes the client is gone and closes the connection.
Every subscription on that socket (messages, presence, typing — public or
private, doesn't matter) goes dead at once, silently, with no error thrown
client-side.

**Fix:** in `lib/supabase.ts`, `createClient`'s `realtime` option now sets:
- `worker: Platform.OS === 'web'` — runs the heartbeat in a Web Worker,
  off the throttled main thread, so it's far less likely to get starved in
  the first place. (Workers don't exist in React Native, hence the
  platform check.)
- `heartbeatCallback` — force-reconnects (`supabase.realtime.connect()`) the
  moment a `'timeout'` or `'disconnected'` heartbeat status is reported,
  instead of leaving the socket dead until something else notices.
- A `visibilitychange` listener (web only) that checks
  `supabase.realtime.isConnected()` as soon as the tab becomes visible again
  and reconnects if needed — catches the gap between "tab backgrounded" and
  the next heartbeat cycle.

If you still see this after all three are in place, the next thing to check
is whether the *channels* actually resubscribe after `connect()` re-opens the
socket — reconnecting the transport doesn't necessarily guarantee every
channel rejoins automatically on all client versions. Test by forcing a
reconnect (e.g. toggle devtools' network throttling to offline/online) and
confirming a `postgres_changes` event still lands afterward, not just that
the socket shows connected.

### 6.8 — Related but distinct: private channels also need the JWT refreshed

Don't confuse this with #6.7. Presence/typing channels are `private: true`
and are authorized using the JWT that was current when they joined; that
authorization holds only until the JWT expires (~1hr default), and Supabase
Auth refreshing the session token in the background does **not**
automatically inform the Realtime connection of the new token. `lib/
supabase.ts` handles this via `supabase.auth.onAuthStateChange` calling
`supabase.realtime.setAuth(session.access_token)` on every auth event
(including silent refreshes). This is a slower-to-reproduce issue (~1hr)
than #6.7 (~minutes), so don't assume fixing one fixed the other — verify
both independently.

### 6.9 — Disabling "Allow public access" breaks postgres_changes too, contrary to docs

**Symptom:** immediately after disabling "Allow public access to channels" in
Supabase Dashboard → Project Settings → Realtime (done as part of §3/§6.8's
fix for Broadcast/Presence), realtime messaging broke completely — not an
idle/backgrounding issue like §6.7, reproduced instantly on a fresh page
load. Sending a message succeeded (`POST .../rest/v1/messages → 201`) but
never streamed back to append locally, on the sender's own screen or the
receiver's. Console showed:
```
messages:<id> realtime subscription CHANNEL_ERROR Error: PrivateOnly: This project only allows private channels
```

**Cause:** both Supabase's public docs and this project's own earlier
research (§3, §6.1 as originally written) said "Allow public access" only
affects Broadcast/Presence, and that `postgres_changes` is governed purely by
table RLS regardless of this setting. That does not match this project's
actual runtime behavior: disabling the toggle rejects **any** non-private
channel outright, `postgres_changes` included. Whether this is a
docs/implementation mismatch or version-specific behavior wasn't confirmed —
what matters is it's reproducible, so trust the runtime error over the docs
here.

**Fix:**
1. `hooks/useMessages.ts` — `messages:<conversationId>` is `private: true`
   again (reversing §6.1's original fix).
2. `migrations/005_postgres_changes_private.sql` — adds a `realtime.messages`
   SELECT policy for `extension = 'postgres_changes'`, scoped to
   `to authenticated` with **no topic/membership filtering**. This is
   intentional, not a shortcut: the policy only needs to let an authenticated
   user's channel *join* succeed. Which rows they actually receive is still
   independently enforced by the `messages` table's own RLS (`is_member()`),
   which postgres_changes re-checks per event regardless of channel privacy.
   Adding membership scoping to this policy too would be redundant.

**Takeaway for next time:** don't trust general Supabase documentation about
which realtime extension types are exempt from privacy requirements — verify
empirically. (Superseded by §6.10: this project ultimately reverted
`private: true` on every channel it was tried on, including the ones this
section is about — see there before re-attempting Realtime Authorization.)

### 6.10 — A seemingly-correct realtime.messages policy still got rejected; Realtime Authorization abandoned

**Symptom:** after fixing §6.9 (postgres_changes) by reverting `messages:<id>`
to public and re-enabling "Allow public access," the `online-users` presence
channel started failing with the same class of error:
```
CHANNEL_ERROR Error: Unauthorized: You do not have permissions to read from this Channel topic: online-users
```
This is a *different* symptom from §6.9's "PrivateOnly" — this time the
channel is correctly attempting a private join and being evaluated against a
policy, not rejected outright.

**Investigated and ruled out:**
- Confirmed via `select * from pg_policies where schemaname='realtime' and
  tablename='messages'` that the policy existed exactly as written:
  `(extension = 'presence') AND (realtime.topic() = 'online-users')` for
  SELECT, matching `with_check` for INSERT. Not a typo, not a migration that
  silently failed to apply.
- The equivalent broadcast policy for `typing:<id>` was written the same way
  (topic-matching via `realtime.topic()`) and had tested successfully
  earlier in the project's life, before the postgres_changes detour — so the
  general pattern isn't inherently broken, but something about this specific
  combination (possibly re-enabling "Allow public access" after having had
  it off, possibly something about the global presence channel not being
  scoped to a single conversation id the way typing is) put it in a state
  where the previously-working authorization no longer succeeded.

**Decision: stopped debugging, reverted instead.** Root-caused far enough to
rule out the obvious mistakes (typo, unapplied migration), but not far enough
to find the actual mechanism — and `security-hardening.md` itself frames
unauthorized presence/typing access as low-severity ("best-effort... a
visual nicety," no data exposure). Given that risk ceiling, further time
debugging an inconsistent, poorly-documented authorization pathway wasn't
justified. `usePresence.ts` and `useTyping.ts` are back to plain public
channels; `migrations/004_realtime_authorization.sql` and
`005_postgres_changes_private.sql` are left in place (harmless — unused
policies don't do anything when no channel requests `private: true`) in case
a future attempt wants a starting point, but don't assume they "just work"
if re-enabled — re-verify from scratch.

### 6.11 — Presence goes stale after extended use; a "self-healing" fix attempt crashed the app instead

**Symptom, reproduced cleanly by two different people independently:** after
a long testing session (many reloads, tab-switching to check dashboard
settings, etc.), the global `online-users` presence channel would go
stale/stuck — both parties would show each other as offline despite both
being actively connected and sending messages successfully. A page reload on
one side sometimes "fixed" it (fresh connection, fresh sync), sometimes made
it worse (both sides go offline immediately after). Waiting up to ~30s
without touching anything did not self-heal it.

**Working theory, not fully confirmed:** `online-users` is a single
long-lived channel subscribed once at app root (`usePresenceContext.tsx`)
and never naturally re-subscribed — unlike `messages:<id>`, which gets torn
down and recreated every time you navigate between chats, incidentally
"self-healing" on a schedule presence never gets. §6.7 already established
that this app's realtime socket can silently reconnect after a missed
heartbeat (background tab throttling). The hypothesis: transport-level
reconnects don't guarantee that a long-lived, never-remounted channel
subscription like this one gets rejoined to the new connection — it can be
left referencing a dead connection indefinitely, with no error thrown, just
silently stale state.

**What was tried and explicitly did NOT work / made things worse:** rewrote
`usePresence.ts` to detect `CHANNEL_ERROR`/`TIMED_OUT`/`CLOSED` on the
channel's subscribe callback and rebuild it from scratch (`removeChannel` +
recreate on a timeout). This caused an immediate `Maximum call stack size
exceeded` crash on load — almost certainly because `removeChannel` was called
synchronously from inside that same channel's own status callback, and
channel teardown appears to re-trigger the status callback reentrantly,
recursing until the stack overflowed. **Reverted in full** — the hook is
back to the plain version with no retry logic (see current file; git blame /
diff this section if you want the exact broken version that crashed, but
don't reintroduce the same pattern).

**Status: unresolved, accepted.** Given security-hardening.md's own framing
of presence as best-effort/cosmetic, and that the one concrete fix attempt
made things categorically worse (a crash beats a stale UI indicator for
"how bad can this get"), further debugging was stopped here rather than risk
another regression. If you pick this back up:
- Don't call `removeChannel` synchronously inside a channel's own status
  callback — defer it (e.g. `setTimeout(() => supabase.removeChannel(ch), 0)`
  at minimum) before creating a replacement.
- Consider whether presence needs to resubscribe on `AppState` returning to
  `active` (it currently only calls `track()` again, which does nothing if
  the underlying channel is already dead) rather than only on mount.
- Check whether `supabase.realtime.channels` (the client's internal list)
  ever ends up with duplicate/orphaned entries for `online-users` during a
  long session — that would confirm the zombie-channel theory directly
  instead of leaving it as a hypothesis.

---

### 6.12 — Presence staleness fixed by replacing Phoenix Presence with a DB heartbeat + poll

**Following on from §6.11:** rather than keep chasing the zombie-channel
theory inside a stateful WebSocket subscription, `usePresence.ts` no longer
uses Supabase Presence at all. Instead:

- `public.profiles` gained a `last_seen_at timestamptz` column
  (`migrations/006_last_seen_heartbeat.sql`).
- While the app is foregrounded (`AppState.currentState === 'active'`), the
  client writes its own `last_seen_at = now()` every 10s (`heartbeat()`), plus
  once immediately on mount and once whenever `AppState` transitions back to
  `active`.
- Independently, every 10s the client reads `last_seen_at` for all profiles
  (`poll()`) and treats a user as online if their timestamp is within the
  last 25s (2.5x the heartbeat interval, to tolerate one missed beat/network
  hiccup without flickering offline).
- No RLS changes were needed — `last_seen_at` is covered by the existing
  "profiles are viewable by authenticated users" (select) and "users can
  update own profile" (update, `auth.uid() = id`) policies.

**Why this actually fixes the class of bug in §6.11, not just papers over it:**
the old design's failure mode was a single long-lived channel silently
referencing a dead connection with no error and no self-correction. Polling
has no equivalent failure mode — every 10s it re-derives status from a fresh
`select`, so even if one poll fails (network blip, tab throttled in the
background), the next one corrects it independently. There's no cached
subscription state that can go stale and stay stale; "staleness" now maxes
out at one missed poll cycle (~10-20s), not "until you reload the page."

**Trade-offs, deliberately accepted:**
- Status changes lag by up to ~10-25s instead of being instant (Presence's
  `sync`/`join`/`leave` events fire immediately on the server). Acceptable
  for a "green dot" indicator; not acceptable if this were driving something
  latency-sensitive.
- `poll()` currently does `select id, last_seen_at from profiles` (no
  filtering) — fine at this app's scale (a handful of test users), but on a
  real userbase this should be scoped to users the current user actually
  shares a conversation with (e.g. a join against `conversation_members`)
  instead of the whole table.
- Slightly more DB load than a push-based channel (one write + one read per
  active client per 10s), but Postgres easily absorbs this at any realistic
  scale for a project this size.

The dormant `online-users` presence RLS policies in `schema.sql` were left in
place (commented as dormant) rather than deleted, in case Presence is
revisited later — see §6.11 for the open questions that would need answering
before doing that.

**Status: resolved**, in the sense that this replaces a fundamentally flaky
mechanism with one that has no equivalent stale-forever failure mode, not in
the sense that the root cause of §6.11's zombie-channel behavior was ever
confirmed. If Presence's live/instant updates are wanted later, that root
cause would need to be nailed down first.

---

### 6.13 — "cannot add `postgres_changes` callbacks ... after `subscribe()`" crash on first chat open

**Symptom:** opening *any* conversation for the first time after a fresh page
load (web) reliably threw `Uncaught Error: cannot add \`postgres_changes\`
callbacks for realtime:messages:<id> after \`subscribe()\`.`, thrown from
inside `hooks/useMessages.ts`'s effect. Sometimes React's error-recovery
silently remounted the tree and the screen kept working; other times it did
not — the chat screen never rendered at all (no `<textarea>` in the DOM,
stuck on the dev error overlay) until a manual reload. Initially assumed to
be a harmless dev-only cosmetic issue (LogBox never ships in production) and
left as a documented follow-up — that assumption turned out to be wrong once
the inconsistent-recovery case was found, so it was fixed properly instead.

**Root cause, confirmed by reading `@supabase/realtime-js` source directly:**
- `RealtimeClient.channel(topic)` reuses an existing channel object if one
  with the same topic is already registered, instead of always creating a
  new one (`realtime-js/src/RealtimeClient.ts` — see the `channel()` method).
- `SupabaseClient.removeChannel()` is `async`: it `await`s
  `channel.unsubscribe()` (a round trip to the server) and only calls
  `channel.teardown()` — which actually deregisters it — once that resolves.
- `useMessages.ts`'s effect cleanup calls `supabase.removeChannel(channel)`
  without (and can't, since effect cleanups aren't awaited) waiting for it.
- expo-router wraps every route in `<Suspense>` for lazy-loading (visible in
  the crash's own component stack: `ChatScreen → Suspense → Route → ...`).
  The *first* time any `/chat/[id]` route is visited after a page load, that
  Suspense boundary reliably produces an extra mount/unmount pass while the
  route module resolves.
- Put together: the first mount creates a channel and calls `.subscribe()`
  on it; the extra Suspense-driven remount's cleanup calls `removeChannel()`
  but its `unsubscribe()` hasn't resolved yet by the time the *next* mount
  calls `supabase.channel(\`messages:${id}\`)` — so it gets back the exact
  same, already-`subscribed` channel object. Calling `.on('postgres_changes',
  ...)` on it to attach the new mount's callback then throws, because
  realtime-js flatly disallows adding listeners after `subscribe()`.

**Why "just reuse the existing channel instead of erroring" doesn't work:**
the whole point of re-running the effect is to attach a callback closure over
*this* mount's `setMessages`/`onIncomingMessage`. Skipping `.on()` because a
channel already exists leaves the live listener permanently pointed at the
previous (about-to-unmount) instance's stale state setters — the visible
screen would silently stop receiving realtime inserts until the next
remount. That's a worse, quieter bug than the crash.

**The fix:** give every mount its own unique channel topic instead of a
name derived purely from `conversationId`, e.g.
`` `messages:${conversationId}:${Date.now()}-${Math.random().toString(36).slice(2)}` ``
in `hooks/useMessages.ts`, and the same pattern for the two conversation-list
channels in `app/(app)/index.tsx`. This is safe specifically for
`postgres_changes`: which rows get delivered is controlled entirely by the
`table`/`filter` config passed to `.on()`, not by the topic string — the
topic is just a client-side multiplexing label. Since every mount now gets a
channel no other mount can ever collide with, the reuse-a-stale-channel path
can't happen regardless of how slowly the old one's `unsubscribe()` resolves.

**This fix was deliberately NOT applied to `useTyping.ts`'s `typing:<id>`
channel.** Broadcast is peer-to-peer *within* a topic — every participant
must join the exact same topic name to see each other's events at all.
Randomizing it per mount would silently break typing indicators entirely
(each client would end up alone on its own topic) instead of fixing a rare
mount race. If this same crash is ever observed for the typing channel, it
needs a different fix — e.g. deferring the stale channel's removal, or
tracking in-flight teardowns — not a topic suffix.

**Status: fixed and verified** — reproduced cleanly before the fix (crashed
on first visit to two different conversations, one of which didn't recover
without a manual reload) and confirmed clean (no error, on two fresh
page-load-then-first-visit cycles) after adding the suffix.

---

### 6.14 — Android push notifications: full setup saga (EAS, Firebase, notification channels)

Push notifications were fully wired up in code (Phase 5) but never actually
tested end-to-end until this pass, since it requires real accounts and a
real device — the web preview and Expo Go can't exercise any of this. Four
separate, unrelated problems had to be fixed before a real notification
with sound/vibration made it to a physical Android device. In order
encountered:

**1. `assets/notification-icon.png` (and `assets/icon.png`) were literal
placeholder text files, not images.** `npx expo prebuild --platform android`
failed with `Could not find MIME for Buffer <null>` inside
`expo-notifications`' Android icon-resizing plugin step. Confirmed via
`Read` on the file, which reported non-image bytes decoding to
`PLACEHOLDER`. Fixed by generating a real PNG (a plain white circle on a
transparent background — Android notification icons must be a white
silhouette; the OS masks out any color) via .NET's `System.Drawing` in
PowerShell. `icon.png` turned out not to be referenced anywhere in the
config at all, so it wasn't actually blocking anything — only
`notification-icon.png` (referenced by the `expo-notifications` plugin) was.
**Lesson: run `npx expo prebuild --platform android --no-install` locally
before burning an EAS Build cycle on config problems — it reproduces the
exact same prebuild step EAS runs remotely, in under a minute instead of
10+.**

**2. `eas build` requires a git repository; there wasn't one.** This whole
project had never been put under version control. `eas build` refused to
proceed non-interactively without one. Fixed with a plain `git init` +
initial commit — safe since `.gitignore` already correctly excluded
`node_modules/`, `.env`, `google-services.json`, and key/cert files before
this commit ever happened.

**3. `google-services.json` is gitignored (correctly — it's a real
credential), but EAS Build only uploads git-tracked files.** Setting
`android.googleServicesFile: "./google-services.json"` in a static
`app.json` produced a build-time warning ("is not checked in to your
repository and won't be uploaded to the builder") and the file was silently
missing from every build. Fixed properly, not by tracking the secret in
git:
- Converted `app.json` → `app.config.js` (a static JSON file can't read
  environment variables; a dynamic JS config can).
- Uploaded the file as an EAS **file environment variable**:
  `eas env:create --name GOOGLE_SERVICES_JSON --type file --value
  ./google-services.json --visibility sensitive --environment development`.
- `app.config.js` now resolves `android.googleServicesFile` as
  `process.env.GOOGLE_SERVICES_JSON ?? './google-services.json'` — the env
  var (a filesystem path to the decrypted file, injected by EAS at build
  time) wins on EAS's servers; the literal relative path is just a fallback
  for anyone running `expo prebuild` locally with the real file present.
- A build-time log line still claims the file "is not checked in to your
  repository" even with this fix in place — that warning is a local static
  analysis artifact of evaluating the config without the env var set (it
  doesn't have access to EAS's env vars either), not a sign of actual
  failure. Verified as harmless by confirming the file genuinely landed in
  `android/app/google-services.json` after a local
  `expo prebuild --platform android` with `GOOGLE_SERVICES_JSON` unset
  (falls back to the local relative path, which is what a developer with
  the real file in their working tree would hit) and, more importantly, by
  the actual remote build succeeding.

**4. The FCM V1 service-account key has to be explicitly assigned to the
"Push Notifications (FCM V1)" role — uploading it isn't enough.**
`eas credentials` → Android has *three separate* Google Service Account
"roles" that can each hold their own key: Push Notifications (FCM V1), Play
Store Submissions, and a plain uploaded key with no role at all. The first
upload attempt went through the generic "Google Service Account" → "Upload
a new key" path without assigning it to any specific role, so
`eas credentials`'s summary screen kept showing
`Push Notifications (FCM V1): ... None assigned yet` even though a key
existed. Symptom: `eas credentials` looked fine at a glance (a key was
listed under plain "Google Service Account"), the app registered a push
token successfully, our own `notify` Edge Function returned `200 ok` for
every call — but calling Expo's push API (`https://exp.host/--/api/v2/push/send`)
directly with the real token returned
`{"status":"error","message":"Unable to retrieve the FCM server key for the
recipient's app...","details":{"error":"InvalidCredentials","fault":"developer"}}`.
**The `notify` function doesn't check Expo's push API response at all — it
fires the request and returns `'ok'` regardless of what Expo's servers say
about it.** This means a `200` from our own function proves nothing about
whether the push actually got delivered; the only way to see this class of
failure is to call Expo's push endpoint directly and read `data[].status`/
`data[].message` from the response body. Fixed via `eas credentials` →
Android → Google Service Account → **"Manage your Google Service Account
Key for Push Notifications (FCM V1)"** specifically (not the generic
"Google Service Account" entry point) → selected the already-uploaded key
rather than re-uploading. Confirmed fixed by re-calling Expo's push API
directly and seeing `{"status":"ok", "id": "..."}` instead of the
`InvalidCredentials` error.

**5. No Android notification channel was ever configured, so pushes arrived
silently — no sound, no vibration.** Since Android 8 (API 26), sound,
vibration, and importance are entirely controlled by the notification
*channel* a notification is posted to, not by the `sound` field in the push
payload. Neither the client nor the push payload referenced any channel, so
notifications landed in whatever channel Android/FCM auto-created by
default — which had no vibration and, per the actual device test, no sound
either (independently of the phone being on silent, which is expected/
correct — silent mode should mute sound; it's not this bug). Fixed with two
matching halves:
- `hooks/usePushToken.ts` now calls
  `Notifications.setNotificationChannelAsync('messages', { importance:
  MAX, vibrationPattern: [...], sound: 'default', lightColor: ... })`
  once, as part of `registerForPushNotifications()`.
- `supabase/functions/notify/index.ts`'s push payload now includes
  `channelId: 'messages'` so Android routes the notification through that
  channel instead of an auto-created one.
- Deliberately named the channel `messages`, **not** `default`. Android
  forbids apps from changing a channel's importance after its first
  creation (by design — otherwise an app could silently re-enable sound a
  user had turned off), so reusing an id like `default` risks permanently
  inheriting whatever low-importance channel the OS/FCM auto-created before
  this code ever ran. A fresh, never-before-used channel id sidesteps that
  entirely. If sound/vibration ever need to change again, bump the channel
  id (e.g. `messages-v2`) rather than editing `messages` in place — existing
  installs won't pick up channel property changes otherwise.
- This is a **client-side JS change**, not a native one — on the
  development build (connected to Metro), it took effect after a plain app
  reload, no new `eas build` required. It would need one on a standalone
  production build, since there'd be no Metro to hot-reload from.

**How this was actually verified**, since none of it is testable in this
project's usual browser-preview loop: inserted rows directly into
`public.messages` via `supabase db query --linked` (the Database Webhook
trigger fires on any INSERT regardless of source, so this exercises the
exact same path a real client-sent message would) and confirmed a real
notification — title, body, and vibration — arrived on a physical Android
device with the app backgrounded, both via a direct Expo push API call
(isolating the channel fix from the rest of the pipeline) and via a genuine
end-to-end insert through the real webhook → Edge Function → Expo → device
chain.

**Status: verified working end-to-end on Android.** iOS was out of scope
for this pass (see the account/cost tradeoffs discussed with the user —
Apple Developer Program is a paid, separate setup not pursued here).

---

## 7. Known gaps / next things to look at

- **Realtime Authorization for typing/presence** — attempted and abandoned;
  see §6.9/§6.10. `typing:<id>` and `online-users` are public channels, an
  accepted low-severity gap (no data exposure, per security-hardening.md's
  own risk rating) rather than an oversight. Revisit only if a concrete
  requirement (not general hardening appetite) justifies the debugging time.
- **Presence staleness** — see §6.11/§6.12. Resolved by replacing Phoenix
  Presence with a `last_seen_at` DB heartbeat + poll (10s interval, 25s
  online threshold), which has no equivalent "stuck forever" failure mode.
  Root cause of the original zombie-channel behavior was never confirmed —
  only worked around — so don't reintroduce a long-lived Presence channel for
  this without re-reading §6.11 first. `poll()` currently reads the whole
  `profiles` table on every cycle; scope it to shared-conversation users
  before this app has more than a handful of accounts.
- **Message pagination** — chat screen loads the last 50 messages and never
  paginates further back. Fine per the original spec's scope, but a real
  "load more on scroll" would need `.range()` on the messages query plus
  some care around how it interacts with the realtime subscription's local
  state.
- **In-app sound** — `assets/sounds/message.mp3` turned out to already be a
  real file (valid ID3 header, ~46KB), not the plain-text placeholder this
  entry previously assumed — corrected after actually checking the bytes
  while writing up §6.14's push notification setup. The `useMessageSound`
  hook's error handling was still written defensively either way (wraps
  both `createAsync` and `replayAsync` in try/catch) so a bad file would
  fail silently rather than crash, but nobody has explicitly confirmed
  hearing it play during a real test — worth a quick listen-through rather
  than assuming it's broken or assuming it's fine.
- **Push notifications (Phase 5 Part B)** — verified working end-to-end on
  Android; see §6.14 for the full setup saga (five separate fixes were
  needed: placeholder icon files, missing git repo, gitignored
  `google-services.json` not reaching EAS Build, an FCM V1 key uploaded but
  never assigned to the push-notification role, and a missing Android
  notification channel for sound/vibration). iOS was not attempted — it
  needs a paid Apple Developer Program enrollment, which wasn't pursued in
  this pass. The `notify` Edge Function still doesn't check Expo's push API
  response (`data[].status`/`message`) — it returns `200 ok` regardless of
  whether Expo/FCM actually accepted the notification, which is exactly
  what made the FCM-credential bug in §6.14 hard to see at first. Worth
  adding real error handling there before relying on this in anything more
  than a side project.
- **Conversation list refetch-on-every-message** — see §4's last paragraph.
  Fine now, first thing to optimize if this ever needs to scale.
- **Group leave/remove-member/rename** — out of scope per
  `requirement/phase-4-groups.md`, not started.

---

## 8. Troubleshooting quick reference

| Symptom | Likely cause | Fix |
|---|---|---|
| `POST .../rpc/get_conversations → 404` (or any RPC 404) | migration not run yet, or Supabase's PostgREST schema cache hasn't refreshed | run the relevant file in `supabase/migrations/`; a few seconds' delay after running is normal before it resolves |
| Sent messages don't appear without a manual refresh | a `postgres_changes` channel got marked `private: true` somewhere | see §6.1 — don't do that |
| Someone's unread badge won't clear, or clears when it shouldn't | stale bundle in that browser tab (each tab needs its own hard refresh to pick up code changes — Metro doesn't push to already-loaded tabs reliably), or a focus-gating regression | hard refresh; if it persists, check the effect in `chat/[id].tsx` is still gated on `isFocused` (§6.2) |
| A divider/overlay in an inverted `FlatList` renders on the wrong side | inverted-cell-flip (§6.4) | swap the JSX order and re-check visually, don't assume normal top-down reasoning applies |
| `expo start --web` fails to bundle at all | missing `react-native-web`/`react-dom`, or `@opentelemetry/api` (§6.6) | `npx expo install react-native-web react-dom && npm install @opentelemetry/api` |
| Can't find the "Confirm email" toggle in Supabase Auth settings | dashboard UI has moved this around across versions | don't hunt for it — just register a test account and manually confirm it from Authentication → Users → (user) → confirm action if needed |
| New signups can't log in immediately after registering | email confirmation is ON for the project (Supabase default) | either confirm via the emailed link, or disable email confirmation for local testing (see README) |
