import { useEffect } from 'react'
import { Slot, useRouter } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { View, ActivityIndicator } from 'react-native'
import * as Notifications from 'expo-notifications'
import { AuthContext, useAuthState } from '../hooks/useAuth'
import { colors } from '../constants/colors'

// Foreground notification display (phase-5 step 2).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
})

export default function RootLayout() {
  const auth = useAuthState()
  const router = useRouter()

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const conversationId = response.notification.request.content.data?.conversationId as
        | string
        | undefined
      if (conversationId) router.push(`/(app)/chat/${conversationId}`)
    })
    return () => sub.remove()
  }, [router])

  if (auth.initializing) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator color={colors.accentBright} size="large" />
      </View>
    )
  }

  return (
    <AuthContext.Provider value={auth}>
      <StatusBar style="light" />
      <Slot />
    </AuthContext.Provider>
  )
}
