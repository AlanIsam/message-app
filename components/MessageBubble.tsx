import { View, Text, StyleSheet } from 'react-native'
import { colors } from '../constants/colors'

type Props = {
  content: string
  senderUsername: string
  createdAt: string
  isOwn: boolean
  showSender: boolean
}

export function MessageBubble({ content, senderUsername, createdAt, isOwn, showSender }: Props) {
  const time = new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <View style={[styles.row, isOwn ? styles.rowOwn : styles.rowOther]}>
      <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther]}>
        {!isOwn && showSender && <Text style={styles.sender}>{senderUsername}</Text>}
        {/* Rendered as plain RN <Text> — no HTML parsing, no dangerouslySetInnerHTML
            (security-hardening #9: avoids stored XSS on the web build). */}
        <Text style={isOwn ? styles.contentOwn : styles.content}>{content}</Text>
        <Text style={styles.time}>{time}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    marginVertical: 4,
    paddingHorizontal: 12,
  },
  rowOwn: {
    alignItems: 'flex-end',
  },
  rowOther: {
    alignItems: 'flex-start',
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleOwn: {
    backgroundColor: colors.accent,
    borderBottomRightRadius: 4,
  },
  bubbleOther: {
    backgroundColor: colors.surface,
    borderBottomLeftRadius: 4,
  },
  sender: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: 2,
    fontWeight: '600',
  },
  content: {
    color: colors.text,
    fontSize: 15,
  },
  contentOwn: {
    color: colors.white,
    fontSize: 15,
  },
  time: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 4,
    alignSelf: 'flex-end',
  },
})
