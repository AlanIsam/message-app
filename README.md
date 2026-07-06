# Chat App

Discord-like chat built with Expo (React Native + Web) and Supabase — realtime
messaging, presence, typing indicators, groups, and Android push notifications.
Implements all 5 phases from `requirement/` plus the corrections in
`requirement/security-hardening.md` (that doc supersedes the RLS policies drafted
in `overview.md`, `phase-4`, and `phase-5`).

## 1. Install dependencies

```bash
npm install
```

## 2. Create a Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. Open the SQL Editor and run the entire contents of [supabase/schema.sql](supabase/schema.sql).
   This creates all tables, RLS policies, the `is_member` helper, and the
   `create_group` / `create_dm` RPCs used instead of direct client inserts.
3. Database → Replication → enable `INSERT` events on the `messages` table.
4. Database → Realtime → enable Realtime Authorization, and add the
   `realtime.messages` policy shown commented at the bottom of `schema.sql` so
   typing/presence channels are membership-gated (security-hardening #6).
5. Authentication → Providers → Email: require email confirmation.
6. Authentication → Policies: turn on leaked-password protection, set minimum
   password length to 10, enable CAPTCHA (hCaptcha/Turnstile).

## 3. Configure environment variables

```bash
cp .env.example .env
```

Fill in `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
from Supabase Dashboard → Project Settings → API Keys → **Publishable and
secret API keys** tab (not the legacy "anon, service_role" tab — Supabase is
retiring those). Copy the **Publishable key** (`sb_publishable_...`). It's
public by design (ships inside the client bundle) — RLS is the actual
security boundary, not keeping this key secret.

## 4. Run the app

```bash
npx expo start        # then press `w` for web, or scan the QR code for Android
```

## 5. Replace placeholder assets

Two files were scaffolded as plain-text placeholders so the app builds without
errors — swap them for real files before shipping:
- `assets/sounds/message.mp3` — a real short (<1s) notification sound
- `assets/notification-icon.png` / `assets/icon.png` — real PNGs

## 6. Push notifications (optional, Android only)

Push requires a physical Android device, a Firebase project, and a Supabase
Edge Function — none of which can be provisioned automatically. Follow
`requirement/phase-5-sound-and-notifications.md` Part B:

1. Create a Firebase project, add an Android app matching `app.json`'s
   `android.package`, download `google-services.json` into the project root.
2. `npm install -g eas-cli && eas credentials` — upload the FCM server key.
3. `eas build --profile development --platform android` — push doesn't work
   in Expo Go, you need a dev build.
4. Deploy the notify function and set its secret:
   ```bash
   npx supabase functions deploy notify
   npx supabase secrets set WEBHOOK_SECRET=<generate-a-random-value>
   ```
   You don't need to set a service key yourself — Edge Functions auto-inject
   the project's secret key (`sb_secret_...`) as `SUPABASE_SECRET_KEYS`, which
   the function reads directly. `verify_jwt = false` is set in
   `supabase/config.toml` for this function, since the webhook authenticates
   via the `x-webhook-secret` header above rather than a Supabase JWT.
5. Database → Webhooks → create a webhook on `messages` INSERT pointing at
   the deployed function URL, with header `x-webhook-secret: <same value>`.

In-app sound (Part A) works out of the box on web and native once you swap in
a real `message.mp3` — no external services needed.

## Project structure

See `requirement/overview.md` for the full spec this was built from. Key
divergence from the spec: `conversation_members` has no client-facing INSERT
policy and groups/DMs are created via the `create_group(name, member_ids)` and
`create_dm(other_user_id)` RPCs, per `requirement/security-hardening.md` #2
(the naive insert policy in `overview.md` allows joining any conversation).

## Known limitations (out of scope by design, see requirement/*.md)

- No message pagination beyond the last 50 per conversation
- No group leave/remove-member/rename UI
- No light mode
- Web has no background push notifications (FCM/Expo push is Android-only per phase-5)
