# Randau

Discord/WhatsApp-like chat built with Expo (React Native + Web) and Supabase —
realtime messaging with paginated history, presence, typing indicators,
groups, searchable user lookup, a profile/settings screen, and Android push
notifications. Implements all 5 phases from `requirement/` plus the
corrections in `requirement/security-hardening.md` (that doc supersedes the
RLS policies drafted in `overview.md`, `phase-4`, and `phase-5`), plus several
post-launch feature requests — see `documentation.md` §1 for the full status
table.

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
4. Leave Project Settings → Realtime → "Allow public access to channels" at
   its default (**on**) — don't disable it. A prior attempt to lock this down
   with private channels was tried and reverted (see `documentation.md`
   §6.9/§6.10); the policies near the bottom of `schema.sql` are dormant,
   kept for reference only.
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

## 5. App assets

`assets/icon.png`, `assets/adaptive-icon.png`, and `assets/notification-icon.png`
are the real "Randau" app icons (custom-designed, not placeholders).
`assets/sounds/message.mp3` is a real short MP3. Nothing here needs replacing
before shipping unless you want your own branding — see `app.config.js` for
where each is referenced.

## 6. Push notifications (Android)

This is the most involved part of the setup: three separate systems —
**Firebase**, **EAS (Expo Application Services)**, and **Supabase** — all
have to be wired together correctly before a single notification arrives,
and none of it can be provisioned automatically (real accounts, a real
device, and several web dashboards are unavoidable). Getting any one piece
slightly wrong produces failures that look like they're coming from
somewhere else entirely — every one of the gotchas below was hit for real
during initial setup; see `documentation.md` §6.14 for the full blow-by-blow
if something here doesn't match what you're seeing. Follow this in order.

**What each system is actually for, before you start:**
- **Firebase** — Google requires an app-specific Firebase project purely to
  generate two credential artifacts: `google-services.json` (lets the app
  initialize Firebase locally on the device and obtain a push token) and an
  FCM V1 service account key (lets Expo's push servers actually relay
  notifications through Google's API on your behalf). You never touch
  Firebase itself beyond generating these two files.
- **EAS** — builds an installable, non-Expo-Go native app (a "development
  build" — push doesn't work in Expo Go or the web preview at all) and
  stores the platform credentials (Android keystore, FCM key) needed to
  build and sign it.
- **Supabase** — a Database Webhook fires an Edge Function on every new
  `messages` row, which looks up the recipient's push token and relays the
  notification through Expo's push API.

**Prerequisites:** a git repository (`git init` if this project doesn't
already have one — EAS Build refuses to proceed without one), a free Expo
account, a free Firebase/Google account, and a physical Android device.

### 6.1 Firebase — generate the two credential files

1. Go to [console.firebase.google.com](https://console.firebase.google.com/)
   and create a new project (any name).
2. Inside it, **add an Android app** with package name matching
   `app.config.js`'s `android.package` exactly (`com.chatapp.mobile`, unless
   you've changed it). You can skip "Add Firebase SDK" — this project uses
   Expo's push relay, not the Firebase SDK directly.
3. Download **`google-services.json`** from that Android app's settings (or
   Project Settings → General → Your apps) and save it somewhere you can
   find it — you'll upload it to EAS in step 6.3, not commit it to git (it's
   already in `.gitignore`).
4. Go to **Project Settings → Service Accounts** → **"Generate new private
   key"** → confirm. This downloads a *second*, different JSON file (the FCM
   V1 service account key) — keep it too, you'll need it in step 6.4.

### 6.2 EAS — link the project

```bash
npx eas-cli@latest login
npx eas-cli@latest init
```

`eas init` writes a `projectId` into `app.config.js`'s `extra.eas.projectId`
— if you're setting this up under your own Expo account rather than
continuing this exact project, you'll also need to update the hardcoded
`owner` field in `app.config.js` to your own Expo username/team, since that
field is currently set to the original project's account.

If `eas init` complains about a slug mismatch (the EAS project's slug
doesn't match `app.config.js`'s `slug` field), update `slug` in
`app.config.js` to match rather than force-overwriting the remote project.

### 6.3 Upload `google-services.json` — as an EAS secret, not into git

`google-services.json` is correctly gitignored, but that means **EAS Build
never receives it** if you just point `app.config.js` at a local relative
path — EAS Build only uploads git-tracked files. This project's
`app.config.js` already handles this correctly:

```js
googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './google-services.json',
```

You just need to actually create that env var, pointing at wherever you
downloaded the file in step 6.1:

```bash
npx eas-cli@latest env:create --name GOOGLE_SERVICES_JSON --type file \
  --value ./path/to/your/google-services.json \
  --visibility sensitive --environment development --scope project
```

A build-time log line ("File specified via android.googleServicesFile...
is not checked in to your repository") will still show up even with this
set up correctly — that's a local static-analysis artifact of evaluating
the config without the env var available (the same limitation applies to
the warning-generating step itself), not a sign of actual failure. Trust
the build result, not that specific line.

### 6.4 EAS credentials — assign the FCM V1 key to the right role

```bash
npx eas-cli@latest credentials
```

Walk the interactive menu: **Android** → pick your build profile
(`development`) → **"Google Service Account"** → **"Manage your Google
Service Account Key for Push Notifications (FCM V1)"** → **"Set up a Google
Service Account Key for Push Notifications (FCM V1)"** → upload the
*second* file from step 6.1 (the one from Service Accounts, not
`google-services.json`).

**This exact path matters.** There's a separate, generic "upload a key with
no role assigned" option in the same menu that looks like it should work
but doesn't — it'll show a key listed under "Google Service Account" while
`Push Notifications (FCM V1)` still shows `None assigned yet`. Everything
downstream (token registration, our own Edge Function) will appear to work
fine in that state — the only way this actually surfaces is Expo's push API
itself returning `{"status":"error","message":"...InvalidCredentials...
fault":"developer"}` for real send attempts. If push notifications register
successfully but never actually arrive, this is the first thing to check —
re-run `eas credentials` and confirm `Push Notifications (FCM V1)` shows a
real `Project ID` / `Client Email` / `Private Key ID`, not "None assigned
yet".

### 6.5 Build

```bash
npx expo install expo-dev-client
npx eas-cli@latest build --profile development --platform android
```

Takes 10–20 minutes on Expo's servers. When it finishes, open the printed
link (or scan the QR code) on your Android phone to install it — Android
will warn about installing from an unknown source, which is expected for a
development build.

Before running this, it's worth running `npx expo prebuild --platform
android --no-install` locally first — it reproduces the exact same prebuild
step EAS runs remotely (where the placeholder-icon and similar config
issues actually surface) in under a minute instead of burning a full 10–20
minute remote build cycle on something you could've caught locally. Clean
up the generated `android/` directory afterward (`eas build` regenerates it
remotely; you don't want a stale local copy checked in).

### 6.6 Supabase — deploy the function and wire the webhook

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase functions deploy notify
npx supabase secrets set WEBHOOK_SECRET=<generate-a-random-value>
```

You don't need to set a service key yourself — Edge Functions auto-inject
the project's secret key (`sb_secret_...`) as `SUPABASE_SECRET_KEYS`, which
the function reads directly. `verify_jwt = false` is set in
`supabase/config.toml` for this function, since the webhook authenticates
via the `x-webhook-secret` header above rather than a Supabase JWT.

Then, in the Supabase Dashboard → **Database → Webhooks** → **Create a new
hook** (this is a one-time bootstrap step done through the dashboard —
the underlying `supabase_functions` schema it provisions doesn't exist
until you create your first webhook this way):
- **Table**: `messages`, **Events**: `Insert` only
- **Type**: HTTP Request, **Method**: `POST`
- **URL**: `https://<your-project-ref>.supabase.co/functions/v1/notify`
- **HTTP Headers**: `x-webhook-secret` → the same random value you set above

### 6.7 Verify

Open the app on the Android device, log in, grant the notification
permission when prompted (this also registers a push token in
`user_devices` and creates the app's notification channel, which controls
sound/vibration — see `documentation.md` §6.14 if notifications arrive
silently). Background the app, then send it a message from another
account. A notification with sound and vibration should arrive within a
few seconds.

If you want to test the pipeline without a second account handy, insert a
row directly into `public.messages` via `supabase db query --linked` — the
Database Webhook fires on any INSERT regardless of source, so this
exercises the exact same path a real client-sent message would, without
needing to juggle two logged-in sessions.

## Project structure

See `requirement/overview.md` for the full spec this was built from. Key
divergence from the spec: `conversation_members` has no client-facing INSERT
policy and groups/DMs are created via the `create_group(name, member_ids)` and
`create_dm(other_user_id)` RPCs, per `requirement/security-hardening.md` #2
(the naive insert policy in `overview.md` allows joining any conversation).

## Known limitations (out of scope by design, see requirement/*.md)

- No group leave/remove-member/rename UI
- No light mode
- No iOS push notifications (needs a paid Apple Developer Program enrollment; not pursued)
- Web has no background push notifications (FCM/Expo push is Android-only per phase-5)

## Extending the app

See `API_REFERENCE.md` for a full rundown of every RPC function, Edge
Function, hook, and component you're likely to touch when adding a feature —
written for exactly this purpose.
