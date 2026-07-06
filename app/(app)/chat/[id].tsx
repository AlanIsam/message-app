import { useEffect, useMemo, useRef, useState } from 'react'
import { View, FlatList, Text, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native'
import { useLocalSearchParams, useNavigation } from 'expo-router'
import { useIsFocused } from '@react-navigation/native'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../hooks/useAuth'
import { useMessages } from '../../../hooks/useMessages'
import { useTyping, formatTypingLabel } from '../../../hooks/useTyping'
import { useMessageSound } from '../../../hooks/useMessageSound'
import { usePresenceContext } from '../../../hooks/usePresenceContext'
import { MessageBubble } from '../../../components/MessageBubble'
import { MessageInput } from '../../../components/MessageInput'
import { OnlineBadge } from '../../../components/OnlineBadge'
import { colors } from '../../../constants/colors'
import type { Profile } from '../../../lib/types'

type ConversationDetails = {
  id: string
  name: string | null
  is_group: boolean
  otherUser?: Profile
}

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { user } = useAuth()
  const navigation = useNavigation()
  const isFocused = useIsFocused()
  const { isOnline } = usePresenceContext()
  const playMessageSound = useMessageSound()
  const flatListRef = useRef<FlatList>(null)

  const [details, setDetails] = useState<ConversationDetails | null>(null)
  const currentProfile = useRef<Profile | null>(null)
  const [profileReady, setProfileReady] = useState(false)
  const [unreadCutoff, setUnreadCutoff] = useState<string | null>(null)
  const openedForId = useRef<string | null>(null)

  const { messages, loading, sendMessage } = useMessages(id, user?.id, () => {
    playMessageSound()
  })
  const { typingUsers, notifyTyping } = useTyping(id, currentProfile.current)

  useEffect(() => {
    if (!user) return
    supabase
      .from('profiles')
      .select('id, username, avatar_url')
      .eq('id', user.id)
      .single()
      .then(({ data }) => {
        currentProfile.current = data
        setProfileReady(true)
      })
  }, [user?.id])

  useEffect(() => {
    async function loadDetails() {
      const { data: convo } = await supabase
        .from('conversations')
        .select('id, name, is_group')
        .eq('id', id)
        .single()

      if (!convo) return

      let otherUser: Profile | undefined
      if (!convo.is_group && user) {
        const { data: memberRow } = await supabase
          .from('conversation_members')
          .select('user_id, profiles(id, username, avatar_url)')
          .eq('conversation_id', id)
          .neq('user_id', user.id)
          .maybeSingle()
        otherUser = (memberRow as any)?.profiles
      }

      setDetails({ id: convo.id, name: convo.name, is_group: convo.is_group, otherUser })
    }
    loadDetails()
  }, [id, user?.id])

  useEffect(() => {
    if (!details) return
    const online = details.otherUser ? isOnline(details.otherUser.id) : false
    navigation.setOptions({
      title: details.is_group ? details.name ?? 'Group' : details.otherUser?.username ?? '',
      headerRight: !details.is_group
        ? () => (
            <View style={styles.headerStatus}>
              <OnlineBadge online={online} size={8} />
              <Text style={styles.headerStatusText}>{online ? 'online' : 'offline'}</Text>
            </View>
          )
        : undefined,
    })
  }, [details, navigation, isOnline])

  useEffect(() => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true })
  }, [messages.length])

  // First focus on a given conversation: atomically grab the previous
  // last_read_at (to draw the "Unread messages" divider below) and advance
  // it to now() in the same call — avoids racing a separate read against
  // mark_conversation_read's write landing in the wrong order.
  useEffect(() => {
    if (!id || !user || !isFocused) return
    if (openedForId.current === id) return
    openedForId.current = id
    setUnreadCutoff(null)
    supabase.rpc('open_conversation', { convo_id: id }).then(({ data }) => {
      setUnreadCutoff(data ?? null)
    })
  }, [id, user?.id, isFocused])

  // Keeps the conversation list's unread badge at zero while a new message
  // lands and this screen is already open — doesn't move the divider above,
  // since that position is only captured once per visit (above).
  useEffect(() => {
    if (!id || !user || !isFocused || openedForId.current !== id) return
    supabase.rpc('mark_conversation_read', { convo_id: id })
  }, [id, user?.id, messages.length, isFocused])

  async function handleSend(text: string) {
    await sendMessage(text)
  }

  const typingLabel = formatTypingLabel(typingUsers)

  // First message (in time order) that arrived after the cutoff and wasn't
  // sent by me — matches the same definition used for the list's unread
  // count, so the divider lines up with what earned the badge.
  const firstUnreadMessageId = useMemo(() => {
    if (!unreadCutoff || !user) return null
    const cutoffTime = new Date(unreadCutoff).getTime()
    const firstUnread = messages.find(
      (m) => m.sender_id !== user.id && new Date(m.created_at).getTime() > cutoffTime
    )
    return firstUnread?.id ?? null
  }, [messages, unreadCutoff, user?.id])

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <FlatList
        ref={flatListRef}
        data={[...messages].reverse()}
        keyExtractor={(item) => item.id}
        inverted
        contentContainerStyle={styles.list}
        renderItem={({ item, index }) => {
          const isOwn = item.sender_id === user?.id
          const next = messages[messages.length - 1 - index - 1]
          const showSender = details?.is_group === true && (!next || next.sender_id !== item.sender_id)
          return (
            <>
              {/* Order looks backwards on purpose: `inverted` flips each
                  cell's internal layout too, not just cell order, so this
                  renders divider-above-bubble visually. */}
              <MessageBubble
                content={item.content}
                senderUsername={item.profiles?.username ?? 'Unknown'}
                createdAt={item.created_at}
                isOwn={isOwn}
                showSender={showSender}
              />
              {item.id === firstUnreadMessageId && (
                <View style={styles.unreadDivider}>
                  <View style={styles.unreadDividerLine} />
                  <Text style={styles.unreadDividerText}>Unread messages</Text>
                  <View style={styles.unreadDividerLine} />
                </View>
              )}
            </>
          )
        }}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No messages yet. Say hello!</Text>
            </View>
          ) : null
        }
      />

      {typingLabel ? (
        <View style={styles.typingWrap}>
          <Text style={styles.typingText}>{typingLabel}</Text>
        </View>
      ) : null}

      <MessageInput
        onSend={handleSend}
        onChangeText={notifyTyping}
        disabled={!profileReady}
      />
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  list: {
    paddingVertical: 8,
  },
  empty: {
    padding: 32,
    alignItems: 'center',
    transform: [{ scaleY: -1 }],
  },
  emptyText: {
    color: colors.textMuted,
  },
  unreadDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginVertical: 8,
  },
  unreadDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.danger,
  },
  unreadDividerText: {
    color: colors.danger,
    fontSize: 11,
    fontWeight: '700',
    marginHorizontal: 8,
  },
  typingWrap: {
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  typingText: {
    color: colors.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
  },
  headerStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 12,
    gap: 6,
  },
  headerStatusText: {
    color: colors.textMuted,
    fontSize: 12,
  },
})
