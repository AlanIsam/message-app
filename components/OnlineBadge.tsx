import { View, StyleSheet } from 'react-native'
import { colors } from '../constants/colors'

type Props = {
  online: boolean
  size?: number
}

export function OnlineBadge({ online, size = 12 }: Props) {
  return (
    <View
      style={[
        styles.dot,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: online ? colors.online : colors.offline,
        },
      ]}
    />
  )
}

const styles = StyleSheet.create({
  dot: {
    borderWidth: 2,
    borderColor: colors.background,
  },
})
