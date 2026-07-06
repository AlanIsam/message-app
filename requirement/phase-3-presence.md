# Phase 3 — Presence (Online Detection)

## Goal
Show which users are currently online. A green badge on avatars, an "online" label in chat,
and the conversation list reflecting who's active right now.

---

## Prerequisites
Phases 1 and 2 must be complete.

No new packages — Supabase Realtime includes Presence built in.

---

## How Supabase Presence Works
Presence is an in-memory, ephemeral feature of a Realtime channel. Each connected client
"tracks" itself on a shared channel. All clients on that channel get synced state of who's
present. When a client disconnects (closes app, loses network), they drop off automatically
after a short timeout — no manual cleanup needed in the DB.

Presence state lives only while clients are connected. It is NOT stored in the database.

---

## What to Build

### `hooks/usePresence.ts`
A hook that joins a global presence channel, tracks the current user, and returns the set
of currently-online user IDs.

```ts
export function usePresence(currentUserId: string) {
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!currentUserId) return

    const channel = supabase.channel('online-users', {
      config: { presence: { key: currentUserId } },
    })

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState()
        // state is { [key]: [{ ...meta }] } — keys are user IDs
        setOnlineUserIds(new Set(Object.keys(state)))
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          // Announce that this user is online
          await channel.track({ online_at: new Date().toISOString() })
        }
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [currentUserId])

  return { onlineUserIds, isOnline: (id: string) => onlineUserIds.has(id) }
}
```

**App lifecycle gotcha:** On mobile, when the app goes to background, you may want to
untrack the user so they show as offline. Use React Native's `AppState`:

```ts
import { AppState } from 'react-native'

// inside the hook
useEffect(() => {
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') channel.track({ online_at: new Date().toISOString() })
    else channel.untrack()
  })
  return () => sub.remove()
}, [])
```

Keep this simple — for a non-robust app, even just tracking on subscribe is fine. The
background untrack is a nice-to-have.

---

### `components/OnlineBadge.tsx`
A small green dot positioned over an avatar (or standalone).

```ts
type Props = {
  online: boolean
  size?: number      // default 12
}
```

Render a colored circle: green (`#22c55e`) when online, grey (`#9ca3af`) when offline.
Use absolute positioning if overlaying an avatar (bottom-right corner is conventional).

---

### Where to Wire Presence In

**Provide presence at the app root** so it's shared everywhere. Add it to a context
provider in `app/(app)/_layout.tsx`:

```ts
const PresenceContext = createContext<{ isOnline: (id: string) => boolean }>(...)

export function PresenceProvider({ children }) {
  const { user } = useAuth()
  const { isOnline } = usePresence(user?.id)
  return <PresenceContext.Provider value={{ isOnline }}>{children}</PresenceContext.Provider>
}
```

Then consume it in:
- `ConversationItem` — show `OnlineBadge` next to DM avatars
- `chat/[id].tsx` header — show "online" / "last seen" text for DMs
- A future members list for groups

---

### Update `components/ConversationItem.tsx`
Add an optional prop:
```ts
otherUserId?: string   // for DMs, the other participant
```
Use the presence context to render an `OnlineBadge` next to the avatar when this user is online.

---

## Design Notes
- For **group conversations**, "online" is ambiguous — skip the badge on the group row itself,
  or show a count like "3 online" if you want. Keep it simple: skip for groups in this phase.
- Presence is best-effort. Don't build critical logic on top of it. It's a visual nicety.

---

## Typing Indicators

Typing indicators do NOT use the database and do NOT use Presence. They use Supabase Realtime
**Broadcast** — ephemeral client-to-client messages that never touch Postgres. Do not write
"typing" state to the `messages` table; that would spam writes for data nobody needs to keep.

### `hooks/useTyping.ts`
A per-conversation hook that both broadcasts the current user's typing and reports who else
is typing.

```ts
export function useTyping(conversationId: string, currentUser: Profile) {
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map())
  const channelRef = useRef<RealtimeChannel | null>(null)
  const lastSentRef = useRef<number>(0)
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const channel = supabase.channel(`typing:${conversationId}`)

    channel
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        if (payload.userId === currentUser.id) return // ignore own echo

        // Add/refresh this user in the typing map
        setTypingUsers((prev) => new Map(prev).set(payload.userId, payload.username))

        // Reset their removal timer (see "knowing when they stop" below)
        const existing = timeoutsRef.current.get(payload.userId)
        if (existing) clearTimeout(existing)
        const t = setTimeout(() => {
          setTypingUsers((prev) => {
            const next = new Map(prev)
            next.delete(payload.userId)
            return next
          })
          timeoutsRef.current.delete(payload.userId)
        }, 2500)
        timeoutsRef.current.set(payload.userId, t)
      })
      .subscribe()

    channelRef.current = channel
    return () => {
      timeoutsRef.current.forEach((t) => clearTimeout(t))
      timeoutsRef.current.clear()
      supabase.removeChannel(channel)
    }
  }, [conversationId, currentUser.id])

  // Call this on every text input change
  function notifyTyping() {
    const now = Date.now()
    if (now - lastSentRef.current < 1000) return // throttle: max once per second
    lastSentRef.current = now
    channelRef.current?.send({
      type: 'broadcast',
      event: 'typing',
      payload: { userId: currentUser.id, username: currentUser.username },
    })
  }

  return { typingUsers: Array.from(typingUsers.values()), notifyTyping }
}
```

### Two things that trip people up

**1. Knowing when someone STOPS typing.** There is no reliable "stopped typing" signal —
people quit mid-thought, lock their phone, lose signal. Do NOT try to detect stopping.
Instead, each incoming `typing` event resets a ~2.5s timer per user; when the timer fires
with no new event, that user is removed from the typing list. This is the timeout pattern in
the hook above.

**2. Don't broadcast on every keystroke.** That's dozens of events per message. Throttle to
at most one broadcast per second while actively typing (the `lastSentRef` guard above). One
event/second is plenty to keep the indicator alive on the receiving end, since the removal
timeout is 2.5s.

### Wiring it into the chat screen
In `chat/[id].tsx`:

```ts
const { typingUsers, notifyTyping } = useTyping(id, currentUser)

// In MessageInput's onChangeText handler:
onChangeText={(text) => {
  setInputValue(text)
  notifyTyping()
}}
```

Render the indicator just above the input:
- 1 user: `"Alan is typing…"`
- 2 users: `"Alan and Sarah are typing…"`
- 3+: `"Several people are typing…"`

For v1, even a plain `"typing…"` with no name is acceptable. Works identically for DMs and
groups since it's keyed by `conversationId`.

---

## Out of Scope for This Phase
- "Last seen at" timestamps stored in DB (presence is ephemeral only)
- Per-conversation presence (this phase does global online presence only)
- Animated typing dots (a static "typing…" label is fine for v1)

---

## Done When
- [ ] When User A opens the app, User B sees A's badge turn green
- [ ] When User A closes the app, A's badge turns grey within a few seconds
- [ ] The badge appears correctly in the conversation list for DMs
- [ ] The chat screen header shows online status for the other user in a DM
- [ ] No memory leaks — presence channel is removed on unmount
- [ ] When User A types, User B sees a "typing…" indicator within ~1 second
- [ ] The indicator disappears within ~2.5s after User A stops typing
- [ ] Typing broadcasts are throttled (not one per keystroke)
- [ ] Typing works in both DMs and groups
