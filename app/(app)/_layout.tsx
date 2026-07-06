import { useEffect } from 'react'
import { Redirect, Stack } from 'expo-router'
import { useAuth } from '../../hooks/useAuth'
import { PresenceProvider } from '../../hooks/usePresenceContext'
import { registerForPushNotifications, savePushToken } from '../../hooks/usePushToken'
import { colors } from '../../constants/colors'

export default function AppLayout() {
  const { session, user } = useAuth()

  useEffect(() => {
    if (!user) return
    registerForPushNotifications()
      .then((token) => {
        if (token) savePushToken(user.id, token)
      })
      .catch((error) => {
        console.warn('Push notification registration failed', error)
      })
  }, [user?.id])

  if (!session) return <Redirect href="/(auth)/login" />

  return (
    <PresenceProvider>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.deepest },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Chats' }} />
        <Stack.Screen name="chat/[id]" options={{ title: '' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
    </PresenceProvider>
  )
}
