import { useState } from 'react'
import { View, TextInput, Pressable, Text, StyleSheet } from 'react-native'
import { colors } from '../constants/colors'

type Props = {
  onSend: (text: string) => void
  onChangeText?: (text: string) => void
  disabled?: boolean
}

export function MessageInput({ onSend, onChangeText, disabled }: Props) {
  const [text, setText] = useState('')

  function handleChange(value: string) {
    setText(value)
    onChangeText?.(value)
  }

  function handleSend() {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
  }

  // Enter sends (matches Discord/Slack); Shift+Enter still inserts a newline.
  // react-native-web forwards the raw DOM KeyboardEvent as `e` here, so
  // e.preventDefault() stops the textarea's own newline insertion.
  function handleKeyPress(e: any) {
    const native = e.nativeEvent ?? e
    if (native.key === 'Enter' && !native.shiftKey) {
      e.preventDefault?.()
      handleSend()
    }
  }

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        placeholder="Message"
        placeholderTextColor={colors.textMuted}
        value={text}
        onChangeText={handleChange}
        onKeyPress={handleKeyPress}
        multiline
        editable={!disabled}
      />
      <Pressable
        style={[styles.sendButton, (!text.trim() || disabled) && styles.sendButtonDisabled]}
        onPress={handleSend}
        disabled={!text.trim() || disabled}
      >
        <Text style={styles.sendText}>Send</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 8,
    backgroundColor: colors.deepest,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    color: colors.text,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    maxHeight: 120,
    marginRight: 8,
  },
  sendButton: {
    backgroundColor: colors.accent,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
  sendText: {
    color: colors.white,
    fontWeight: '600',
  },
})
