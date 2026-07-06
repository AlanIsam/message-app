# Security Hardening

## Threat Model Premise
The Supabase **anon key ships inside the client bundle** (all `EXPO_PUBLIC_*` vars are embedded
in the APK and the web JS — trivially extractable). There is no trusted client. Any attacker
can take the anon key and make raw authenticated requests to your Supabase project, bypassing
your UI entirely.

**Therefore: Row Level Security (RLS) is the ONLY security boundary.** UI checks are cosmetic.
Every table, every policy, every function must assume a hostile client holding a valid login.

This document ranks the high-severity vulnerabilities for this specific stack and enforces the
mitigation for each. Several of these correct policies drafted in `overview.md`, `phase-4`, and
`phase-5` — those files must be updated to match this doc. Conflicts are flagged inline.

---

## Severity Summary

| # | Vulnerability | Severity | Root cause |
|---|---|---|---|
| 1 | Missing/misconfigured RLS | Critical | Anon key is public; RLS is the only gate |
| 2 | Conversation-join IDOR (read any private chat) | Critical | Permissive `conversation_members` insert policy |
| 3 | Message sender spoofing (impersonation) | High | Insert policy doesn't bind `sender_id` to caller |
| 4 | Push-token harvesting → mass phishing push | High | `expo_push_token` world-readable on `profiles` |
| 5 | Service-role key / secret exposure | Critical | Bypasses all RLS if it ever reaches the client |
| 6 | Unauthorized Realtime broadcast/presence | High | Broadcast/Presence don't inherit table RLS |
| 7 | Insecure session-token storage | High | AsyncStorage is unencrypted plaintext |
| 8 | Unauthenticated notify Edge Function | High | Public endpoint → push spam / abuse |
| 9 | Stored XSS on the web build | Medium | User content rendered in a browser DOM |
| 10 | Auth abuse (brute force, bot signups) | Medium | No rate limit / CAPTCHA / password policy |
| 11 | Missing web security headers | Medium | Vercel serves no CSP / anti-clickjacking by default |
| 12 | Dependency supply chain | Medium | Transitive npm/Expo packages |

---

## 1. Enforce RLS on EVERY table — Critical

RLS is OFF by default when you create a table. A single table with RLS disabled = full public
read/write with the anon key.

**Enforce:**
- `alter table ... enable row level security;` on every table in `public`.
- Verify none are missed. Supabase Dashboard → Database → Tables shows an "RLS disabled"
  warning badge — there must be zero.
- Query to audit:
```sql
select tablename, rowsecurity
from pg_tables
where schemaname = 'public' and rowsecurity = false;
-- Must return zero rows.
```
- Default-deny mindset: a table with RLS on but no policy denies everything. That's the safe
  starting state. Add only the narrow policies you need.

---

## 2. Conversation-join IDOR — Critical (corrects overview.md)

**The flaw as drafted.** `overview.md` gives `conversation_members` this insert policy:
```sql
-- VULNERABLE — do not ship
create policy "Members can be added by conversation creator"
  on public.conversation_members for insert with check (auth.role() = 'authenticated');
```
Any authenticated user can insert `{ conversation_id: <any id>, user_id: <their own id> }`,
joining themselves to any conversation. The messages SELECT policy then grants them the entire
message history. This is a complete read bypass of every private conversation and DM in the app.

**Enforce: clients never insert membership directly.** Remove all client insert policies on
`conversation_members` (default-deny). Do membership changes through a `SECURITY DEFINER`
function that validates the caller.

```sql
-- Helper: membership check that does NOT recurse through RLS
-- (also fixes the "infinite recursion detected in policy" error the
--  original self-referential SELECT policy causes on Supabase)
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

-- Group + members created atomically, server-side, as the caller
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

  -- caller is always a member; dedupe defensively
  insert into public.conversation_members (conversation_id, user_id)
  select new_id, uid
  from unnest(array_append(member_ids, auth.uid())) as uid
  on conflict do nothing;

  return new_id;
end;
$$;
```

Client calls `supabase.rpc('create_group', { group_name, member_ids })` instead of the two-step
insert. **This replaces the client-side insert logic in `phase-4-groups.md` — update that file.**

Rewrite the dependent SELECT policies to use the helper (no recursion):
```sql
create policy "members read conversation"
  on public.conversations for select
  using ( public.is_member(id, auth.uid()) );

create policy "members read own membership rows"
  on public.conversation_members for select
  using ( public.is_member(conversation_id, auth.uid()) );
```

---

## 3. Message sender spoofing — High (corrects overview.md)

**The flaw as drafted.** The messages insert policy checks membership but not authorship:
```sql
-- VULNERABLE — lets a member post AS another user
with check ( exists ( select 1 from conversation_members
  where conversation_id = messages.conversation_id and user_id = auth.uid() ) )
```
A member can insert a row with `sender_id` set to any other user's id, forging messages from
them inside a shared conversation. Impersonation in a chat app is high severity.

**Enforce: bind `sender_id` to the caller.**
```sql
create policy "members send own messages"
  on public.messages for insert
  with check (
    sender_id = auth.uid()
    and public.is_member(conversation_id, auth.uid())
  );

create policy "members read messages"
  on public.messages for select
  using ( public.is_member(conversation_id, auth.uid()) );
```

Apply the same principle everywhere a row carries an owner column. For `profiles` update, add a
`with check` (not just `using`) so a user can't change their `id`:
```sql
create policy "update own profile"
  on public.profiles for update
  using ( auth.uid() = id )
  with check ( auth.uid() = id );
```

---

## 4. Push-token harvesting — High (corrects phase-5)

**The flaw as drafted.** `phase-5` adds `expo_push_token` to `profiles`, and `overview.md`
makes profiles readable by every authenticated user. So any logged-in attacker can read *every
user's* push token. Expo's push endpoint only needs the token — with the harvested list an
attacker sends phishing/spam notifications to your entire user base, appearing to come from your
app.

**Enforce: tokens live in their own table, owner-readable only.** Postgres has no column-level
RLS, so isolate the sensitive column in a separate table.
```sql
create table public.user_devices (
  user_id uuid references public.profiles(id) on delete cascade,
  expo_push_token text not null,
  updated_at timestamptz default now(),
  primary key (user_id, expo_push_token)
);
alter table public.user_devices enable row level security;

create policy "own devices only"
  on public.user_devices for all
  using ( user_id = auth.uid() )
  with check ( user_id = auth.uid() );
```
The client writes only its own token. The notify Edge Function reads recipients' tokens via the
**service role** (which bypasses RLS server-side). No user can ever read another's token.
**Update `phase-5-sound-and-notifications.md`:** drop the `alter table profiles add column
expo_push_token` step; use `user_devices` instead.

Also keep `profiles` SELECT scoped — expose only what group-creation search needs (`id`,
`username`, `avatar_url`), never tokens or emails.

---

## 5. Secret management — Critical

- **Anon key**: public by design. Fine in the client. Not a secret — don't treat leaking it as
  an incident, but don't rely on it being hidden either (see premise).
- **Service-role key**: bypasses ALL RLS. It must exist ONLY in server-side environments —
  Supabase Edge Function secrets. NEVER in the app, NEVER in an `EXPO_PUBLIC_*` var, NEVER in
  the repo. One leak = total compromise.
- **FCM server key / webhook secret**: server-side only.

**Enforce:**
- Grep the repo before every build: no `service_role`, no private keys, no `SUPABASE_SERVICE`
  outside `supabase/functions/`.
- Anything the client must not see must not carry the `EXPO_PUBLIC_` prefix — unprefixed env
  vars are not bundled.
- Add `.env*` to `.gitignore`. Rotate keys immediately if a service-role key ever lands in git
  history (rotating is the only real fix — the history persists).

---

## 6. Realtime broadcast / presence authorization — High (affects phase-2, phase-3)

`postgres_changes` subscriptions respect table RLS — a client only receives message rows it's
allowed to SELECT, so the Phase 2 message stream is covered by #2/#3 above. **But Broadcast and
Presence do NOT inherit table RLS.** By default a client can subscribe to any channel name it
guesses (`typing:<any-convo-id>`, `messages:<any-convo-id>`, `online-users`) and both read
others' presence/typing and inject fake broadcast events.

**Enforce: private channels with Realtime Authorization.** Turn on Realtime Authorization and
mark the conversation-scoped channels private, then gate them with RLS on `realtime.messages`:
```ts
const channel = supabase.channel(`typing:${conversationId}`, {
  config: { private: true },
})
```
```sql
-- Only members may send/receive on that conversation's realtime channel
create policy "members use conversation channel"
  on realtime.messages for select
  using (
    public.is_member(
      (regexp_match(realtime.topic(), '^(?:typing|messages):(.+)$'))[1]::uuid,
      auth.uid()
    )
  );
-- Mirror with an INSERT policy for broadcast send rights.
```
Adjust the topic parsing to your channel naming. The point: channel access is authorized by the
same membership check as the data, so an attacker can't snoop or spoof typing/presence for a
conversation they're not in.

---

## 7. Session-token storage — High (affects phase-1)

`phase-1` uses AsyncStorage for the Supabase session. AsyncStorage is **unencrypted** — on a
rooted/jailbroken or malware-infected device, the stored refresh token is readable in plaintext.
The refresh token is long-lived and mints fresh access tokens, so theft = durable account
takeover.

**Enforce: encrypted storage on native.** Use `expo-secure-store` (Android Keystore / iOS
Keychain) as the auth storage adapter on mobile:
```ts
import * as SecureStore from 'expo-secure-store'

const SecureAdapter = {
  getItem: (k: string) => SecureStore.getItemAsync(k),
  setItem: (k: string, v: string) => SecureStore.setItemAsync(k, v),
  removeItem: (k: string) => SecureStore.deleteItemAsync(k),
}
// createClient(..., { auth: { storage: SecureAdapter, ... } }) on native
```
**Caveat (be honest with yourself here):** SecureStore has a ~2KB per-value limit and Supabase
sessions can exceed it. Use a chunking adapter (split the value across keys) or a maintained
library like `react-native-mmkv` with encryption. Web keeps its default storage — see #11 for
the XSS side of that.

Also set a sane session lifetime in Supabase Auth (shorter access-token TTL, refresh-token
rotation ON) so a stolen token has a smaller window.

---

## 8. notify Edge Function authorization — High (affects phase-5)

The push-notification function is triggered by a DB webhook, but if deployed as a normal public
endpoint, anyone who learns the URL can POST arbitrary payloads — spamming push notifications to
users, or (if it trusts input) pushing attacker-chosen content that looks like it came from you.

**Enforce: authenticate the webhook.** Require a shared secret the webhook sends and the
function verifies:
```ts
Deno.serve(async (req) => {
  if (req.headers.get('x-webhook-secret') !== Deno.env.get('WEBHOOK_SECRET')) {
    return new Response('unauthorized', { status: 401 })
  }
  // ... trust `record` only after this check
})
```
Store `WEBHOOK_SECRET` as a Supabase function secret; set the matching header in the DB webhook
config. Additionally: never interpolate raw message text into anything executable; treat the
`record` as untrusted input; and rate-limit per-recipient so a message flood can't become a push
flood.

---

## 9. Stored XSS on the web build — Medium

React Native `<Text>` is safe (no HTML parsing). The risk appears on the **web build** if you
ever render message content as HTML/markdown, linkify URLs, or use `dangerouslySetInnerHTML`. A
message like `<img src=x onerror=...>` then executes in a victim's browser — and because web
sessions live in browser storage, XSS there can exfiltrate the session token (ties to #7/#11).

**Enforce:**
- Never use `dangerouslySetInnerHTML` for user content. Render messages as plain text.
- If you add markdown/link rendering, sanitize (e.g. DOMPurify) and allowlist URL schemes
  (`http`/`https` only — block `javascript:`, `data:`).
- Since this is a chat app people will paste links, show the raw destination; don't auto-open.
  (You investigated a Touch 'n Go phishing kit — same threat, user-to-user here.)

---

## 10. Auth abuse — Medium

Open signup + password auth invites credential stuffing, brute force, and bot account creation
(which then feed spam/harvesting in #4).

**Enforce (Supabase Auth settings):**
- Turn ON leaked-password protection (checks HaveIBeenPwned).
- Minimum password length ≥ 10; require confirmation email before the account is usable.
- Enable CAPTCHA (hCaptcha/Turnstile) on signup and sign-in to stop bots.
- Keep Supabase's built-in auth rate limits; don't raise them without reason.
- Consider app-level message rate limiting (a per-user counter or a trigger that rejects >N
  inserts/sec) so a compromised or abusive account can't flood conversations.

---

## 11. Web security headers — Medium (affects the Vercel deploy)

The web build ships with no CSP or anti-clickjacking protection by default.

**Enforce via `vercel.json`:**
```json
{
  "headers": [
    { "source": "/(.*)", "headers": [
      { "key": "X-Frame-Options", "value": "DENY" },
      { "key": "X-Content-Type-Options", "value": "nosniff" },
      { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
      { "key": "Content-Security-Policy",
        "value": "default-src 'self'; connect-src 'self' https://*.supabase.co wss://*.supabase.co; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'" }
    ]}
  ]
}
```
Tune `connect-src` to your Supabase domain. `X-Frame-Options: DENY` blocks clickjacking. A tight
CSP is the strongest single mitigation against the XSS in #9.

---

## 12. Dependency supply chain — Medium

Expo + React Native pull a large transitive dependency tree; a malicious or vulnerable package
can compromise the build.

**Enforce:**
- `npm audit` in CI; fail the build on high/critical.
- Pin versions; commit the lockfile; review lockfile diffs on dependency bumps.
- Prefer `npx expo install` (picks Expo-compatible versions) over raw `npm install` for native
  modules.
- Periodically run `npx expo-doctor`.

---

## Files To Update For Consistency
This doc supersedes weaker policies drafted earlier. Reconcile:
- `overview.md` — replace the `conversation_members` insert policy (#2), the messages insert
  policy (#3), add the `is_member` helper, add `with check` to the profiles update policy (#3).
- `phase-4-groups.md` — replace client-side group/member inserts with the `create_group` RPC (#2).
- `phase-5-sound-and-notifications.md` — move `expo_push_token` from `profiles` to `user_devices`
  (#4); authenticate the notify function (#8).
- `phase-1-auth-and-chat-ui.md` — swap AsyncStorage for SecureStore on native (#7).
- `phase-2` / `phase-3` — mark conversation channels private with Realtime Authorization (#6).

---

## Pre-Launch Security Checklist
- [ ] Zero tables with RLS disabled (audit query returns empty)
- [ ] No client can join a conversation it wasn't added to (test with raw anon-key request)
- [ ] Cannot insert a message with someone else's `sender_id`
- [ ] Cannot read another user's push token or email
- [ ] Service-role key exists only in Edge Function secrets; grep of repo is clean
- [ ] Typing/presence channels are private and membership-gated
- [ ] Session stored in SecureStore (native); refresh-token rotation on
- [ ] notify function rejects requests without the webhook secret
- [ ] Web build renders messages as plain text; CSP header present
- [ ] Leaked-password protection + CAPTCHA enabled in Supabase Auth
- [ ] `npm audit` clean; lockfile committed

---

## Note on Scope
"Doesn't need to be robust" was about *features*, not *security*. A feature gap is an
inconvenience; an authorization gap in a messaging app leaks private conversations. Items 1–8
are not optional hardening — they are the difference between a working app and one that hands
every private chat to anyone with the anon key. Ship those before anyone but you uses it.
