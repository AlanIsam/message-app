import { useCallback, useEffect, useState } from 'react'
import { View, FlatList, Pressable, Text, TextInput, StyleSheet, Modal } from 'react-native'
import { useFocusEffect, useRouter, useNavigation } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import { ConversationItem } from '../../components/ConversationItem'
import { CreateGroupModal } from '../../components/CreateGroupModal'
import { colors } from '../../constants/colors'
import type { Conversation, Profile } from '../../lib/types'

export default function ConversationListScreen() {
  const { user } = useAuth()
  const router = useRouter()
  const navigation = useNavigation()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)
  const [groupModalVisible, setGroupModalVisible] = useState(false)
  const [dmModalVisible, setDmModalVisible] = useState(false)
  const [fabMenuVisible, setFabMenuVisible] = useState(false)
  const [dmSearchQuery, setDmSearchQuery] = useState('')
  const [dmSearchResults, setDmSearchResults] = useState<Profile[]>([])
  const [dmSearching, setDmSearching] = useState(false)

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable onPress={() => router.push('/(app)/settings')} hitSlop={12} style={styles.headerButton}>
          <Ionicons name="settings-outline" size={22} color={colors.text} />
        </Pressable>
      ),
    })
  }, [navigation, router])

  const loadConversations = useCallback(async () => {
    if (!user) return
    setLoading(true)
    const { data } = await supabase.rpc('get_conversations')
    setConversations((data ?? []) as Conversation[])
    setLoading(false)
  }, [user])

  useFocusEffect(
    useCallback(() => {
      loadConversations()
    }, [loadConversations])
  )

  // Live updates so the list never needs a manual refresh: any message you
  // can see (RLS already scopes this) bumps the relevant row and re-sorts;
  // being added to a brand new conversation surfaces it immediately too.
  //
  // Both channels get a unique-per-mount suffix — see documentation.md §6.13.
  // postgres_changes filtering comes from the `table`/`filter` config below,
  // not the topic name, so this is side-effect-free (unlike broadcast).
  useEffect(() => {
    if (!user) return
    const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`

    const messagesChannel = supabase
      .channel(`conversation-list-messages:${instanceId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        () => loadConversations()
      )
      .subscribe()

    const membershipChannel = supabase
      .channel(`conversation-list-membership:${instanceId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'conversation_members',
          filter: `user_id=eq.${user.id}`,
        },
        () => loadConversations()
      )
      .subscribe()

    return () => {
      supabase.removeChannel(messagesChannel)
      supabase.removeChannel(membershipChannel)
    }
  }, [user, loadConversations])

  // Search-as-you-type instead of listing every user in the system —
  // debounced so it doesn't fire a query on every keystroke.
  useEffect(() => {
    if (!dmModalVisible || !user) return
    const query = dmSearchQuery.trim()
    if (!query) {
      setDmSearchResults([])
      setDmSearching(false)
      return
    }
    setDmSearching(true)
    const timeout = setTimeout(async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, username, avatar_url')
        .ilike('username', `%${query}%`)
        .neq('id', user.id)
        .limit(20)
      setDmSearchResults(data ?? [])
      setDmSearching(false)
    }, 300)
    return () => clearTimeout(timeout)
  }, [dmSearchQuery, dmModalVisible, user])

  function closeDmModal() {
    setDmModalVisible(false)
    setDmSearchQuery('')
    setDmSearchResults([])
  }

  async function startDm(otherUserId: string) {
    const { data, error } = await supabase.rpc('create_dm', { other_user_id: otherUserId })
    closeDmModal()
    if (error) return
    router.push(`/(app)/chat/${data}`)
  }

  function handleCreated(conversationId: string) {
    setGroupModalVisible(false)
    router.push(`/(app)/chat/${conversationId}`)
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={conversations}
        keyExtractor={(item) => item.id}
        refreshing={loading}
        onRefresh={loadConversations}
        renderItem={({ item }) => (
          <ConversationItem
            name={item.is_group ? item.name ?? 'Group' : item.other_username ?? 'Direct Message'}
            avatarUrl={item.is_group ? undefined : item.other_avatar_url}
            lastMessage={item.last_message ?? undefined}
            lastMessageTime={
              item.last_message_at
                ? new Date(item.last_message_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : undefined
            }
            isGroup={item.is_group}
            otherUserId={item.other_user_id ?? undefined}
            unreadCount={item.unread_count}
            onPress={() => router.push(`/(app)/chat/${item.id}`)}
          />
        )}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No conversations yet. Tap + to start one.</Text>
            </View>
          ) : null
        }
      />

      <Pressable style={styles.fab} onPress={() => setFabMenuVisible(true)}>
        <Text style={styles.fabIcon}>+</Text>
      </Pressable>

      <Modal visible={fabMenuVisible} transparent animationType="fade" onRequestClose={() => setFabMenuVisible(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setFabMenuVisible(false)}>
          <View style={styles.menu}>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setFabMenuVisible(false)
                setDmModalVisible(true)
              }}
            >
              <Text style={styles.menuItemText}>New Direct Message</Text>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setFabMenuVisible(false)
                setGroupModalVisible(true)
              }}
            >
              <Text style={styles.menuItemText}>New Group</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      <Modal visible={dmModalVisible} animationType="slide" transparent onRequestClose={closeDmModal}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>New Direct Message</Text>
            <TextInput
              style={styles.searchInput}
              placeholder="Search by username"
              placeholderTextColor={colors.textMuted}
              value={dmSearchQuery}
              onChangeText={setDmSearchQuery}
              autoCapitalize="none"
              autoFocus
            />
            <FlatList
              data={dmSearchResults}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <Pressable style={styles.userRow} onPress={() => startDm(item.id)}>
                  <Text style={styles.userName}>{item.username}</Text>
                </Pressable>
              )}
              ListEmptyComponent={
                <Text style={styles.searchHint}>
                  {dmSearching
                    ? 'Searching…'
                    : dmSearchQuery.trim()
                      ? 'No users found.'
                      : 'Start typing a username to search.'}
                </Text>
              }
            />
            <Pressable style={styles.cancelButton} onPress={closeDmModal}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <CreateGroupModal
        visible={groupModalVisible}
        onClose={() => setGroupModalVisible(false)}
        onCreated={handleCreated}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  empty: {
    padding: 32,
    alignItems: 'center',
  },
  emptyText: {
    color: colors.textMuted,
  },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 28,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  fabIcon: {
    color: colors.white,
    fontSize: 28,
    lineHeight: 30,
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
    padding: 20,
  },
  menu: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingVertical: 8,
    marginBottom: 80,
    minWidth: 200,
  },
  menuItem: {
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  menuItemText: {
    color: colors.text,
    fontSize: 15,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    maxHeight: '70%',
  },
  sheetTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  userRow: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  userName: {
    color: colors.text,
    fontSize: 16,
  },
  searchInput: {
    backgroundColor: colors.background,
    color: colors.text,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchHint: {
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: 20,
  },
  headerButton: {
    marginRight: 4,
  },
  cancelButton: {
    marginTop: 12,
    alignSelf: 'flex-end',
  },
  cancelText: {
    color: colors.textMuted,
    fontWeight: '600',
  },
})
