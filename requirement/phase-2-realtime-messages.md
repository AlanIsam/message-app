# Phase 2 — Supabase Realtime for Live Messages

## Goal
Messages appear instantly for all users in a conversation without any refresh.
Sending a message in one device should show up on another device in real time.

---

## Prerequisites
Phase 1 must be complete.

Enable Realtime on the messages table in Supabase:
- Supabase Dashboard → Database → Replication → `messages` table → enable INSERT

No new packages required — `@supabase/supabase-js` already includes Realtime.

---

## What to Build / Change

### `hooks/useMessages.ts`
Extract the message fetching and subscription logic from `chat/[id].tsx` into a reusable hook.

This hook should:
1. Fetch initial messages on mount
2. Subscribe to new messages via Supabase Realtime
3. Append incoming messages to local state
4. Clean up the subscription on unmount

```ts
export function useMessages(conversationId: string) {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // 1. Fetch initial messages
    fetchMessages()

    // 2. Subscribe to new inserts
    const channel = supabase
      .channel(`messages:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const newMessage = payload.new as Message
          setMessages((prev) => [...prev, newMessage])
        }
      )
      .subscribe()

    // 3. Cleanup on unmount — CRITICAL, do not skip this
    return () => {
      supabase.removeChannel(channel)
    }
  }, [conversationId])

  return { messages, loading }
}
```

**Important gotcha:** The `payload.new` from Realtime will NOT include joined data (like `profiles`). You have two options:
- Option A: After receiving a new message, fetch the sender's profile separately and merge
- Option B: Keep a local `profilesCache` map `{ [userId]: Profile }` populated from the initial fetch, and look up the sender from that cache when a new message arrives

Option B is recommended — avoids an extra DB call per message.

---

### Update `app/(app)/chat/[id].tsx`
Replace the inline fetch + state logic with the `useMessages` hook:

```ts
const { messages, loading } = useMessages(id)
```

Remove the manual `supabase.from('messages').select(...)` fetch from this screen — it now lives in the hook.

Remove the optimistic update append you added in Phase 1. The Realtime subscription will pick up your own inserts too, so you'd get duplicates. Instead:
- On send: just call `supabase.from('messages').insert(...)` and let the subscription handle appending

**Deduplication safety net:** Realtime may occasionally fire twice. Deduplicate by message `id` when setting state:
```ts
setMessages((prev) => {
  if (prev.find((m) => m.id === newMessage.id)) return prev
  return [...prev, newMessage]
})
```

---

### Scroll Behavior
When a new message arrives via Realtime, auto-scroll to the bottom.

Use a `FlatList` ref:
```ts
const flatListRef = useRef<FlatList>(null)

// Scroll when messages array changes
useEffect(() => {
  flatListRef.current?.scrollToEnd({ animated: true })
}, [messages])
```

If using `inverted={true}` on the FlatList, use `scrollToOffset({ offset: 0 })` instead (inverted flips the direction).

---

## Out of Scope for This Phase
- Online/offline indicators (Phase 3)
- Sound on message receive (Phase 5)
- Group creation (Phase 4)
- Message read receipts
- Typing indicators

---

## Done When
- [ ] Sending a message on Device A immediately appears on Device B without refresh
- [ ] The sender sees their own message appear via the Realtime subscription (not optimistic state)
- [ ] Closing and reopening the chat screen resubscribes correctly
- [ ] No duplicate messages appear
- [ ] The list auto-scrolls to the latest message
