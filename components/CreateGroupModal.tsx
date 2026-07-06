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
  const [allUsers, setAllUsers] = useState<Profile[]>([])
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!visible || !user) return
    supabase
      .from('profiles')
      .select('id, username, avatar_url')
      .neq('id', user.id)
      .then(({ data }) => setAllUsers(data ?? []))
  }, [visible, user])

  function toggleUser(id: string) {
    setSelectedUserIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
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
        member_ids: Array.from(selectedUserIds),
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
    setSelectedUserIds(new Set())
    setError(null)
  }

  function handleClose() {
    reset()
    onClose()
  }

  const canCreate = groupName.trim().length > 0 && selectedUserIds.size > 0 && !creating

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

          <FlatList
            data={allUsers}
            keyExtractor={(item) => item.id}
            style={styles.list}
            renderItem={({ item }) => {
              const selected = selectedUserIds.has(item.id)
              return (
                <Pressable style={styles.userRow} onPress={() => toggleUser(item.id)}>
                  <Text style={styles.userName}>{item.username}</Text>
                  <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
                    {selected && <Text style={styles.checkmark}>✓</Text>}
                  </View>
                </Pressable>
              )
            }}
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
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: {
    borderColor: colors.accentBright,
    backgroundColor: colors.accentBright,
  },
  checkmark: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '700',
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
