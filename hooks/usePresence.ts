import { useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { supabase } from '../lib/supabase'

// DB heartbeat + poll, not Phoenix Presence (see documentation.md §6.11/§6.12).
// Presence's online-users channel went stale after extended sessions/socket
// reconnects — both sides would get stuck seeing each other as offline, with
// no reliable fix found. A last_seen_at column that we periodically write
// (heartbeat) and periodically read (poll) can't get stuck in a "zombie
// channel" state the way a long-lived WebSocket subscription can: every poll
// re-derives status from scratch instead of trusting cached channel state.
const HEARTBEAT_MS = 10_000
const ONLINE_THRESHOLD_MS = 25_000 // ~2.5x heartbeat interval, tolerates one missed beat

export function usePresence(currentUserId: string | undefined) {
  const [lastSeenById, setLastSeenById] = useState<Map<string, number>>(new Map())

  useEffect(() => {
    if (!currentUserId) return

    async function heartbeat() {
      await supabase
        .from('profiles')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', currentUserId)
    }

    async function poll() {
      const { data } = await supabase.from('profiles').select('id, last_seen_at')
      if (!data) return
      const next = new Map<string, number>()
      data.forEach((row) => {
        if (row.last_seen_at) next.set(row.id, new Date(row.last_seen_at).getTime())
      })
      setLastSeenById(next)
    }

    heartbeat()
    poll()

    const heartbeatInterval = setInterval(() => {
      if (AppState.currentState === 'active') heartbeat()
    }, HEARTBEAT_MS)
    const pollInterval = setInterval(poll, HEARTBEAT_MS)

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        heartbeat()
        poll()
      }
    })

    return () => {
      clearInterval(heartbeatInterval)
      clearInterval(pollInterval)
      appStateSub.remove()
    }
  }, [currentUserId])

  function isOnline(id: string) {
    const seenAt = lastSeenById.get(id)
    if (!seenAt) return false
    return Date.now() - seenAt < ONLINE_THRESHOLD_MS
  }

  return { isOnline }
}
