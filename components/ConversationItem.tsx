import { View, Text, Image, Pressable, StyleSheet } from 'react-native'
import { colors } from '../constants/colors'
import { OnlineBadge } from './OnlineBadge'
import { usePresenceContext } from '../hooks/usePresenceContext'

type Props = {
  name: string
  avatarUrl?: string | null
  lastMessage?: string
  lastMessageTime?: string
  isGroup: boolean
  otherUserId?: string
  unreadCount?: number
  onPress: () => void
}

export function ConversationItem({
  name,
  avatarUrl,
  lastMessage,
  lastMessageTime,
  isGroup,
  otherUserId,
  unreadCount = 0,
  onPress,
}: Props) {
  const { isOnline } = usePresenceContext()
  const online = !isGroup && otherUserId ? isOnline(otherUserId) : false
  const unread = unreadCount > 0

  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.avatarWrap}>
        {avatarUrl ? (
          <Image source={{ uri: avatarUrl }} style={styles.avatar} />
        ) : (
          <View style={styles.avatar}>
            <Text style={styles.avatarInitial}>{name.charAt(0).toUpperCase()}</Text>
          </View>
        )}
        {!isGroup && otherUserId && (
          <View style={styles.badgeWrap}>
            <OnlineBadge online={online} />
          </View>
        )}
      </View>
      <View style={styles.textWrap}>
        <Text style={[styles.name, unread && styles.nameUnread]} numberOfLines={1}>
          {name}
        </Text>
        {lastMessage ? (
          <Text style={[styles.preview, unread && styles.previewUnread]} numberOfLines={1}>
            {lastMessage}
          </Text>
        ) : null}
      </View>
      <View style={styles.trailing}>
        {lastMessageTime ? (
          <Text style={[styles.time, unread && styles.timeUnread]}>{lastMessageTime}</Text>
        ) : null}
        {unread && (
          <View style={styles.unreadBadge}>
            <Text style={styles.unreadBadgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
          </View>
        )}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.background,
  },
  avatarWrap: {
    marginRight: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    color: colors.text,
    fontWeight: '700',
    fontSize: 18,
  },
  badgeWrap: {
    position: 'absolute',
    bottom: -1,
    right: -1,
  },
  textWrap: {
    flex: 1,
  },
  name: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  nameUnread: {
    fontWeight: '800',
  },
  preview: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  previewUnread: {
    color: colors.text,
    fontWeight: '600',
  },
  trailing: {
    alignItems: 'flex-end',
    marginLeft: 8,
    gap: 6,
  },
  time: {
    color: colors.textMuted,
    fontSize: 12,
  },
  timeUnread: {
    color: colors.accentBright,
    fontWeight: '600',
  },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadBadgeText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: '700',
  },
})
