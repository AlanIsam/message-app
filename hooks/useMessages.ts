import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Message, Profile } from '../lib/types'

type MessageWithSender = Message & { profiles: Profile | null }

// Page size for both the initial load and each "load more on scroll up"
// batch. Small on purpose — a chat screen only needs enough to fill the
// viewport at first paint; older history loads on demand via loadMoreMessages.
const PAGE_SIZE = 20

export function useMessages(
  conversationId: string,
  currentUserId: string | undefined,
  onIncomingMessage?: (message: Message) => void
) {
  const [messages, setMessages] = useState<MessageWithSender[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  // Keyed by user id — avoids an extra DB round trip per realtime insert,
  // since payload.new never includes joined `profiles` data (phase-2 gotcha).
  const profilesCache = useRef<Map<string, Profile>>(new Map())

  useEffect(() => {
    let cancelled = false
    setHasMore(true)

    async function fetchMessages() {
      setLoading(true)
      // Fetch the most recent page (descending), then reverse into
      // chronological order — fetching ascending+limit would grab the
      // OLDEST rows instead, silently dropping new messages once a
      // conversation passes one page of total messages.
      const { data } = await supabase
        .from('messages')
        .select('*, profiles(id, username, avatar_url)')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE)

      if (cancelled) return

      const rows = ((data ?? []) as MessageWithSender[]).reverse()
      rows.forEach((row) => {
        if (row.profiles) profilesCache.current.set(row.sender_id, row.profiles)
      })
      setMessages(rows)
      setHasMore(rows.length === PAGE_SIZE)
      setLoading(false)
    }

    fetchMessages()

    // Public, on purpose (see documentation.md §6.9 for the full saga this
    // comment is downstream of). postgres_changes doesn't appear to properly
    // support private-channel authorization at all — marking it private
    // produced a permanent "Unauthorized" error even with a matching
    // realtime.messages policy in place. The fix was to re-enable "Allow
    // public access to channels" project-wide (not disable it), which lets
    // this channel stay public — safe, because postgres_changes re-checks
    // the `messages` table's own RLS per event regardless of channel
    // privacy — while typing:<id>/online-users independently still enforce
    // their own private: true + policy, since requesting privacy on a
    // specific channel is authorized independently of the project default.
    //
    // Unique suffix per mount (see documentation.md §6.13): supabase-js
    // reuses an existing channel object if one with the same topic is still
    // registered, and removeChannel() is async (awaits the server's
    // unsubscribe ack before deregistering). A remount that races that
    // teardown — reliably triggered by expo-router's Suspense-wrapped lazy
    // route loading on the first visit to any chat — would otherwise get
    // back an already-subscribed channel and crash calling .on() on it. The
    // suffix only affects client-side multiplexing, not which rows postgres_changes
    // delivers (that's the `filter` below), so it's side-effect-free.
    const channel = supabase
      .channel(`messages:${conversationId}:${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
          const sender = profilesCache.current.get(newMessage.sender_id) ?? null

          if (newMessage.sender_id !== currentUserId) {
            onIncomingMessage?.(newMessage)
          }

          setMessages((prev) => {
            if (prev.find((m) => m.id === newMessage.id)) return prev
            return [...prev, { ...newMessage, profiles: sender }]
          })
        }
      )
      .subscribe((status, error) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          console.warn(`messages:${conversationId} realtime subscription ${status}`, error)
        }
      })

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [conversationId, currentUserId])

  async function sendMessage(content: string) {
    if (!currentUserId) return
    const { error } = await supabase
      .from('messages')
      .insert({ conversation_id: conversationId, sender_id: currentUserId, content })
    if (error) throw error
    // No optimistic append here — the Realtime subscription above delivers
    // our own insert back, and appending twice would duplicate it (phase-2).
  }

  // Cursor-based, not offset-based: paging by `created_at < oldest loaded
  // message` stays correct even if new messages arrive via realtime while
  // the user has scrolled up, unlike an offset/page-number scheme which
  // would shift under a concurrent insert and produce duplicates or gaps.
  async function loadMoreMessages() {
    if (loadingMore || !hasMore || messages.length === 0) return
    setLoadingMore(true)
    try {
      const oldest = messages[0].created_at
      const { data } = await supabase
        .from('messages')
        .select('*, profiles(id, username, avatar_url)')
        .eq('conversation_id', conversationId)
        .lt('created_at', oldest)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE)

      const rows = ((data ?? []) as MessageWithSender[]).reverse()
      rows.forEach((row) => {
        if (row.profiles) profilesCache.current.set(row.sender_id, row.profiles)
      })
      setHasMore(rows.length === PAGE_SIZE)
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id))
        return [...rows.filter((r) => !existingIds.has(r.id)), ...prev]
      })
    } finally {
      setLoadingMore(false)
    }
  }

  return { messages, loading, loadingMore, hasMore, sendMessage, loadMoreMessages }
}
