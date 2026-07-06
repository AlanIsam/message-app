import { useEffect, useState } from 'react'
import { Modal, View, Text, TextInput, FlatList, Pressable, StyleSheet } from 'react-native'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { colors } from '../constants/colors'
import type { Profile } from '../lib/types'

type Props = {
  visible: boolean
  onClose: () => void
  onCreated: (conversationId: string) => void
}

export function CreateGroupModal({ visible, onClose, onCreated }: Props) {
  const { user } = useAuth()
  const [groupName, setGroupName] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Profile[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedUsers, setSelectedUsers] = useState<Profile[]>([])
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Search-as-you-type instead of listing every user in the system —
  // debounced so it doesn't fire a query on every keystroke. Excludes
  // already-selected users so the same result can't be added twice.
  useEffect(() => {
    if (!visible || !user) return
    const query = searchQuery.trim()
    if (!query) {
      setSearchResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    const timeout = setTimeout(async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, username, avatar_url')
        .ilike('username', `%${query}%`)
        .neq('id', user.id)
        .limit(20)
      const selectedIds = new Set(selectedUsers.map((u) => u.id))
      setSearchResults((data ?? []).filter((p) => !selectedIds.has(p.id)))
      setSearching(false)
    }, 300)
    return () => clearTimeout(timeout)
  }, [searchQuery, visible, user, selectedUsers])

  function addUser(profile: Profile) {
    setSelectedUsers((prev) => [...prev, profile])
    setSearchResults((prev) => prev.filter((p) => p.id !== profile.id))
    setSearchQuery('')
  }

  function removeUser(id: string) {
    setSelectedUsers((prev) => prev.filter((p) => p.id !== id))
  }

  async function handleCreate() {
    setError(null)
    setCreating(true)
    try {
      // Group + membership rows are created atomically via a SECURITY DEFINER
      // RPC — clients never insert conversation_members directly, which is
      // what allowed the join-any-conversation IDOR (security-hardening #2).
      const { data, error } = await supabase.rpc('create_group', {
        group_name: groupName.trim(),
        member_ids: selectedUsers.map((u) => u.id),
      })
      if (error) throw error
      reset()
      onCreated(data as string)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create group')
    } finally {
      setCreating(false)
    }
  }

  function reset() {
    setGroupName('')
    setSearchQuery('')
    setSearchResults([])
    setSelectedUsers([])
    setError(null)
  }

  function handleClose() {
    reset()
    onClose()
  }

  const canCreate = groupName.trim().length > 0 && selectedUsers.length > 0 && !creating

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>New Group</Text>

          <TextInput
            style={styles.input}
            placeholder="Group name"
            placeholderTextColor={colors.textMuted}
            value={groupName}
            onChangeText={setGroupName}
          />

          {error && <Text style={styles.error}>{error}</Text>}

          {selectedUsers.length > 0 && (
            <View style={styles.chipRow}>
              {selectedUsers.map((u) => (
                <Pressable key={u.id} style={styles.chip} onPress={() => removeUser(u.id)}>
                  <Text style={styles.chipText}>{u.username}</Text>
                  <Text style={styles.chipRemove}>×</Text>
                </Pressable>
              ))}
            </View>
          )}

          <TextInput
            style={styles.input}
            placeholder="Search by username"
            placeholderTextColor={colors.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
          />

          <FlatList
            data={searchResults}
            keyExtractor={(item) => item.id}
            style={styles.list}
            renderItem={({ item }) => (
              <Pressable style={styles.userRow} onPress={() => addUser(item)}>
                <Text style={styles.userName}>{item.username}</Text>
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={styles.searchHint}>
                {searching
                  ? 'Searching…'
                  : searchQuery.trim()
                    ? 'No users found.'
                    : 'Search for people to add.'}
              </Text>
            }
          />

          <View style={styles.actions}>
            <Pressable style={styles.cancelButton} onPress={handleClose}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.createButton, !canCreate && styles.createButtonDisabled]}
              onPress={handleCreate}
              disabled={!canCreate}
            >
              <Text style={styles.createText}>{creating ? 'Creating…' : 'Create'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
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
    maxHeight: '80%',
  },
  title: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 16,
  },
  input: {
    backgroundColor: colors.background,
    color: colors.text,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  error: {
    color: colors.danger,
    marginBottom: 8,
  },
  list: {
    marginBottom: 12,
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  userName: {
    color: colors.text,
    fontSize: 16,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
    gap: 6,
  },
  chipText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
  chipRemove: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 16,
  },
  searchHint: {
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: 16,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  cancelButton: {
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  cancelText: {
    color: colors.textMuted,
    fontWeight: '600',
  },
  createButton: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  createButtonDisabled: {
    opacity: 0.4,
  },
  createText: {
    color: colors.white,
    fontWeight: '600',
  },
})
