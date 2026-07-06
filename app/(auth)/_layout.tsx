import { Redirect, Stack } from 'expo-router'
import { useAuth } from '../../hooks/useAuth'
import { colors } from '../../constants/colors'

export default function AuthLayout() {
  const { session } = useAuth()

  if (session) return <Redirect href="/(app)" />

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="login" />
      <Stack.Screen name="register" />
    </Stack>
  )
}
