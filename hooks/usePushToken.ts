import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import Constants from 'expo-constants'
import { Platform } from 'react-native'
import { supabase } from '../lib/supabase'

export async function registerForPushNotifications(): Promise<string | null> {
  if (Platform.OS === 'web') return null
  if (!Device.isDevice) return null // no push on emulators

  if (Platform.OS === 'android') {
    // Android 8+ (API 26+) routes sound/vibration/importance through
    // notification channels — the push payload's "sound" field alone isn't
    // enough. Without an explicit channel, notifications land in an
    // auto-created default one with no sound and no vibration (observed on
    // a real device: notification displayed silently). The edge function
    // must reference this same channel id ("messages") in its payload.
    // Deliberately NOT named "default" — Android forbids apps from changing
    // a channel's importance after first creation (by design, so apps can't
    // silently re-enable sound a user turned off), so reusing "default"
    // risks inheriting a low-importance channel auto-created earlier by the
    // OS/FCM before this code ever ran.
    await Notifications.setNotificationChannelAsync('messages', {
      name: 'Messages',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      sound: 'default',
      lightColor: '#22c55e',
    })
  }

  // Required since SDK 49 — getExpoPushTokenAsync() no longer infers this
  // implicitly. Set by `eas init` (writes extra.eas.projectId to app.json).
  const projectId = Constants.expoConfig?.extra?.eas?.projectId
  if (!projectId) {
    console.warn(
      'No EAS projectId configured (extra.eas.projectId in app.json) — ' +
        'run `eas init` first. Push notifications are disabled until then.'
    )
    return null
  }

  const { status: existing } = await Notifications.getPermissionsAsync()
  let finalStatus = existing
  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync()
    finalStatus = status
  }
  if (finalStatus !== 'granted') return null

  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data
  return token
}

// Tokens live in user_devices (owner-readable only), never on profiles —
// profiles is readable by every authenticated user, which would let anyone
// harvest push tokens for phishing/spam (security-hardening #4).
export async function savePushToken(userId: string, token: string) {
  await supabase
    .from('user_devices')
    .upsert({ user_id: userId, expo_push_token: token, updated_at: new Date().toISOString() })
}
