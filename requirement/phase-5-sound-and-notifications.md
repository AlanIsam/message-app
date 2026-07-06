# Phase 5 — Sound + Android Push Notifications

## Goal
Two separate things, often confused:
1. **In-app sound** — when the app is OPEN and a message arrives, play a sound.
2. **Push notification** — when the app is CLOSED or backgrounded, fire an Android
   notification (with sound + banner) so the user knows a message came in.

---

## Prerequisites
Phases 1–4 complete.

```bash
npx expo install expo-av expo-notifications expo-device
```

For push notifications you also need:
- A physical Android device (push does NOT work on emulators reliably, and not at all on web for FCM)
- A Firebase project with FCM enabled
- An Expo account (`npx expo login`)

---

## Part A — In-App Sound (easy, do this first)

### Add the sound asset
Place a short audio file at `assets/sounds/message.mp3` (keep it under ~1 second).

### `hooks/useMessageSound.ts`
```ts
import { useEffect, useRef } from 'react'
import { Audio } from 'expo-av'

export function useMessageSound() {
  const soundRef = useRef<Audio.Sound | null>(null)

  useEffect(() => {
    // Preload the sound once
    Audio.Sound.createAsync(require('../assets/sounds/message.mp3')).then(({ sound }) => {
      soundRef.current = sound
    })
    return () => {
      soundRef.current?.unloadAsync()
    }
  }, [])

  return async function playMessageSound() {
    try {
      await soundRef.current?.replayAsync()
    } catch (e) {
      // fail silently — sound is non-critical
    }
  }
}
```

### Wire it into the Realtime subscription
In `useMessages.ts` (Phase 2), when a NEW message arrives that was NOT sent by the current
user, call `playMessageSound()`:

```ts
(payload) => {
  const newMessage = payload.new as Message
  if (newMessage.sender_id !== currentUserId) {
    playMessageSound()
  }
  setMessages((prev) => /* dedupe + append */)
}
```

Don't play a sound for your own sent messages.

---

## Part B — Push Notifications (the tedious part)

### Step 1 — Notification permissions + token registration
`hooks/usePushToken.ts`:

```ts
import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'

export async function registerForPushNotifications(): Promise<string | null> {
  if (!Device.isDevice) return null // no push on emulators

  const { status: existing } = await Notifications.getPermissionsAsync()
  let finalStatus = existing
  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync()
    finalStatus = status
  }
  if (finalStatus !== 'granted') return null

  const token = (await Notifications.getExpoPushTokenAsync()).data
  // token looks like: ExponentPushToken[xxxxxxxx]
  return token
}
```

Call this after login. Store the token so the backend can send to it:

```sql
-- Add to schema
alter table public.profiles add column expo_push_token text;
```

```ts
const token = await registerForPushNotifications()
if (token) {
  await supabase.from('profiles').update({ expo_push_token: token }).eq('id', user.id)
}
```

### Step 2 — Configure how notifications display when app is foregrounded
At app root (`app/_layout.tsx`):
```ts
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
})
```

### Step 3 — FCM setup (the annoying console steps)
1. Create a Firebase project at console.firebase.google.com
2. Add an Android app — package name must match `app.json` `android.package` (e.g. `com.yourname.chatapp`)
3. Download `google-services.json`, place it in the project root
4. In `app.json`:
   ```json
   {
     "expo": {
       "android": {
         "package": "com.yourname.chatapp",
         "googleServicesFile": "./google-services.json"
       },
       "notification": {
         "icon": "./assets/notification-icon.png",
         "color": "#22c55e"
       }
     }
   }
   ```
5. Upload your FCM Server Key to Expo:
   - Firebase Console → Project Settings → Cloud Messaging → get the key
   - Run `eas credentials` (requires `npm install -g eas-cli`) and add the FCM key
6. You'll need a **development build** (not Expo Go) for push to work:
   ```bash
   eas build --profile development --platform android
   ```

### Step 4 — Sending the notification (backend trigger)
When a message is inserted, the recipients need to be notified. Use a **Supabase Edge
Function** triggered by a Database Webhook on `messages` INSERT.

`supabase/functions/notify/index.ts` (Deno):
```ts
// Pseudocode outline — adjust to your setup
Deno.serve(async (req) => {
  const { record } = await req.json() // the new message row

  // 1. Find all members of this conversation EXCEPT the sender
  // 2. Get their expo_push_token values from profiles
  // 3. Send a POST to Expo's push endpoint

  const tokens = [/* recipient tokens */]
  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      tokens.map((to) => ({
        to,
        sound: 'default',
        title: 'New message',
        body: record.content,
        data: { conversationId: record.conversation_id },
      }))
    ),
  })

  return new Response('ok')
})
```

Wire it up: Supabase Dashboard → Database → Webhooks → create webhook on `messages`
INSERT → point it at the Edge Function URL.

### Step 5 — Handle notification taps
At app root, listen for taps and deep-link into the conversation:
```ts
Notifications.addNotificationResponseReceivedListener((response) => {
  const conversationId = response.notification.request.content.data.conversationId
  router.push(`/(app)/chat/${conversationId}`)
})
```

---

## Web Note
Push notifications via FCM/Expo do NOT work on web. For web, background push would require a
Service Worker + Web Push API — out of scope (we agreed to skip web background push). In-app
sound (Part A) works fine on web through `expo-av`.

---

## Ordering Advice
Do **Part A entirely first** and confirm it works — it's quick and satisfying. Only then
tackle Part B, which involves external consoles and a real device build. Part B is where most
of the time and frustration lives, so isolate it.

---

## Out of Scope
- Per-conversation mute settings
- Notification grouping / channels customization beyond defaults
- Badge counts on the app icon
- Rich notifications (images, actions)

---

## Done When
**Part A:**
- [ ] A sound plays when a message arrives while the app is open
- [ ] No sound plays for the user's own sent messages

**Part B:**
- [ ] App requests notification permission after login
- [ ] Expo push token is saved to the user's profile
- [ ] Sending a message to a user whose app is closed fires an Android notification
- [ ] The notification shows the message content
- [ ] Tapping the notification opens the correct conversation
