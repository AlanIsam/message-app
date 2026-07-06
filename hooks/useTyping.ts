import { useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { Profile } from '../lib/types'

const TYPING_TIMEOUT_MS = 2500
const THROTTLE_MS = 1000

export function useTyping(conversationId: string, currentUser: Profile | null) {
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map())
  const channelRef = useRef<RealtimeChannel | null>(null)
  const lastSentRef = useRef<number>(0)
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    if (!currentUser) return

    // Public, on purpose (see documentation.md §6.10 for why this was
    // reverted from private: true). Same tradeoff as the presence channel —
    // low severity per security-hardening.md's own assessment, and Realtime
    // Authorization proved unreliable in practice for this project (see
    // §6.9/§6.10) rather than worth the ongoing operational risk.
    //
    // NOT given a unique-per-mount suffix like useMessages.ts's channel
    // (§6.13) — broadcast is peer-to-peer WITHIN a topic, so every
    // participant must join the exact same topic name to see each other's
    // events. Randomizing it here would silently break typing indicators
    // entirely instead of fixing a rare mount race.
    const channel = supabase.channel(`typing:${conversationId}`)

    channel
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        if (payload.userId === currentUser.id) return

        setTypingUsers((prev) => new Map(prev).set(payload.userId, payload.username))

        const existing = timeoutsRef.current.get(payload.userId)
        if (existing) clearTimeout(existing)
        const t = setTimeout(() => {
          setTypingUsers((prev) => {
            const next = new Map(prev)
            next.delete(payload.userId)
            return next
          })
          timeoutsRef.current.delete(payload.userId)
        }, TYPING_TIMEOUT_MS)
        timeoutsRef.current.set(payload.userId, t)
      })
      .subscribe()

    channelRef.current = channel

    return () => {
      timeoutsRef.current.forEach((t) => clearTimeout(t))
      timeoutsRef.current.clear()
      supabase.removeChannel(channel)
    }
  }, [conversationId, currentUser?.id])

  function notifyTyping() {
    if (!currentUser) return
    const now = Date.now()
    if (now - lastSentRef.current < THROTTLE_MS) return
    lastSentRef.current = now
    channelRef.current?.send({
      type: 'broadcast',
      event: 'typing',
      payload: { userId: currentUser.id, username: currentUser.username },
    })
  }

  return { typingUsers: Array.from(typingUsers.values()), notifyTyping }
}

export function formatTypingLabel(users: string[]): string {
  if (users.length === 0) return ''
  if (users.length === 1) return `${users[0]} is typing…`
  if (users.length === 2) return `${users[0]} and ${users[1]} are typing…`
  return 'Several people are typing…'
}
