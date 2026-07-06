# Phase 1 — Auth + Basic Chat UI

## Goal
A working app where users can register, log in, see their conversations, and send/read messages.
No realtime yet — messages load on mount and require a manual refresh to see new ones.

---

## Prerequisites
Run these before starting:

```bash
npx create-expo-app chat-app --template blank-typescript
cd chat-app
npx expo install expo-router expo-constants expo-linking expo-status-bar react-native-safe-area-context react-native-screens
npm install @supabase/supabase-js
npx expo install @react-native-async-storage/async-storage
```

Update `package.json` to set the entry point:
```json
"main": "expo-router/entry"
```

Update `app.json`:
```json
{
  "expo": {
    "scheme": "chatapp",
    "web": { "bundler": "metro" }
  }
}
```

---

## What to Build

### `lib/supabase.ts`
Supabase client singleton. Use AsyncStorage as the session storage so auth persists across app restarts.

Key pattern:
```ts
import { createClient } from '@supabase/supabase-js'
import AsyncStorage from '@react-native-async-storage/async-storage'

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false, // important for React Native
    },
  }
)
```

---

### `hooks/useAuth.ts`
Custom hook that:
- Returns the current `session` and `user`
- Exposes `signIn(email, password)`, `signUp(email, password, username)`, `signOut()`
- Listens to `supabase.auth.onAuthStateChange` and keeps state in sync

Key pattern:
```ts
useEffect(() => {
  supabase.auth.getSession().then(({ data: { session } }) => setSession(session))
  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
    setSession(session)
  })
  return () => subscription.unsubscribe()
}, [])
```

---

### `app/_layout.tsx`
Root layout. Reads auth state and redirects:
- If no session → redirect to `/(auth)/login`
- If session exists → redirect to `/(app)/`

Use `expo-router`'s `Redirect` component or `router.replace()`.
Wrap the app in a `SessionContext` provider if sharing auth state via context.

---

### `app/(auth)/login.tsx`
Screen with:
- Email input (`TextInput`)
- Password input (`TextInput` with `secureTextEntry`)
- Login button → calls `signIn()`
- Link to register screen

On success: `router.replace('/(app)/')` — expo-router navigation.
On error: show error message below the form.

**React Native note:** Use `KeyboardAvoidingView` wrapping the form so the keyboard doesn't cover inputs on small screens.

---

### `app/(auth)/register.tsx`
Screen with:
- Username input
- Email input
- Password input
- Register button → calls `signUp(email, password, username)`

Pass `username` in `options.data` on `supabase.auth.signUp()` so the trigger picks it up:
```ts
await supabase.auth.signUp({
  email,
  password,
  options: { data: { username } }
})
```

---

### `app/(app)/index.tsx` — Conversation List
On mount: fetch all conversations where the current user is a member.

Query pattern:
```ts
const { data } = await supabase
  .from('conversation_members')
  .select(`
    conversation_id,
    conversations (
      id,
      name,
      is_group,
      messages ( content, created_at, sender_id )
    )
  `)
  .eq('user_id', user.id)
  .order('created_at', { referencedTable: 'messages', ascending: false })
```

Render a `FlatList` of `ConversationItem` components.
Tapping one navigates to `/(app)/chat/[id]`.

**Floating action button:** Add a `+` button in the corner for starting a new DM (for now). This will be extended in Phase 4 for groups.

---

### `app/(app)/chat/[id].tsx` — Chat Screen
Route param: `id` = conversation ID.

On mount:
1. Fetch conversation details (name, members)
2. Fetch last 50 messages ordered by `created_at` ascending

```ts
const { data: messages } = await supabase
  .from('messages')
  .select('*, profiles(username, avatar_url)')
  .eq('conversation_id', id)
  .order('created_at', { ascending: true })
  .limit(50)
```

Render a `FlatList` with `inverted` prop for bottom-up message layout (like iMessage).
Add `MessageInput` at the bottom.

On send:
```ts
await supabase.from('messages').insert({
  conversation_id: id,
  sender_id: user.id,
  content: text,
})
```

After insert, append the message to local state immediately for snappy UX (optimistic update).

---

### `components/MessageBubble.tsx`
Props:
```ts
type Props = {
  content: string
  senderUsername: string
  createdAt: string
  isOwn: boolean       // true if sent by current user
}
```

Render differently based on `isOwn`:
- Own messages: right-aligned, colored background
- Others: left-aligned, grey background, show sender username above

---

### `components/MessageInput.tsx`
Props:
```ts
type Props = {
  onSend: (text: string) => void
  disabled?: boolean
}
```

Contains:
- `TextInput` (multiline)
- Send button
- Clears input on send
- Disable send button if input is empty

---

### `components/ConversationItem.tsx`
Props:
```ts
type Props = {
  name: string           // group name or other user's username
  lastMessage?: string
  lastMessageTime?: string
  isGroup: boolean
  onPress: () => void
}
```

---

## Out of Scope for This Phase
- Realtime updates (messages won't appear without refresh)
- Online/offline indicators
- Group creation UI
- Sound or notifications
- Message pagination beyond the last 50

---

## Done When
- [ ] User can register with username + email + password
- [ ] User can log in and session persists after app restart
- [ ] Conversation list shows the user's conversations
- [ ] Tapping a conversation opens the chat screen
- [ ] User can send a message and see it appear immediately (optimistic)
- [ ] User can see messages from others after a fresh load
- [ ] Navigating back from chat returns to conversation list
