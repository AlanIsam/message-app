import 'react-native-get-random-values'
import 'react-native-url-polyfill/auto'
import { createClient } from '@supabase/supabase-js'
import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'

// AsyncStorage is unencrypted plaintext, so a stolen refresh token from a
// rooted/compromised device is a durable account takeover (security-hardening
// #7). Use the OS keystore/keychain via SecureStore on native; SecureStore has
// a ~2KB per-value limit, so long session blobs are chunked across keys below.
const SECURE_STORE_CHUNK_SIZE = 1800

const chunkKey = (key: string, index: number) => `${key}_chunk_${index}`
const chunkCountKey = (key: string) => `${key}_chunk_count`

const SecureStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    const countStr = await SecureStore.getItemAsync(chunkCountKey(key))
    if (!countStr) return SecureStore.getItemAsync(key) // legacy unchunked value
    const count = parseInt(countStr, 10)
    const parts: string[] = []
    for (let i = 0; i < count; i++) {
      const part = await SecureStore.getItemAsync(chunkKey(key, i))
      if (part === null) return null
      parts.push(part)
    }
    return parts.join('')
  },
  async setItem(key: string, value: string): Promise<void> {
    const chunks: string[] = []
    for (let i = 0; i < value.length; i += SECURE_STORE_CHUNK_SIZE) {
      chunks.push(value.slice(i, i + SECURE_STORE_CHUNK_SIZE))
    }
    await Promise.all(chunks.map((chunk, i) => SecureStore.setItemAsync(chunkKey(key, i), chunk)))
    await SecureStore.setItemAsync(chunkCountKey(key), String(chunks.length))
    await SecureStore.deleteItemAsync(key).catch(() => {})
  },
  async removeItem(key: string): Promise<void> {
    const countStr = await SecureStore.getItemAsync(chunkCountKey(key))
    const count = countStr ? parseInt(countStr, 10) : 0
    await Promise.all(
      Array.from({ length: count }, (_, i) => SecureStore.deleteItemAsync(chunkKey(key, i)))
    )
    await SecureStore.deleteItemAsync(chunkCountKey(key))
    await SecureStore.deleteItemAsync(key).catch(() => {})
  },
}

// Web has no OS keystore; it keeps the default AsyncStorage-backed adapter
// (see security-hardening #11 — mitigate via CSP/XSS defenses instead).
const authStorage = Platform.OS === 'web' ? AsyncStorage : SecureStorageAdapter

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!
// The publishable key (sb_publishable_...) replaces the legacy anon key —
// same low-privilege role, RLS behaves identically. It's safe to embed in
// the client bundle (see requirement/security-hardening.md's threat model).
const supabasePublishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    storage: authStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
  realtime: {
    // Browsers throttle JS timers in backgrounded tabs, which can starve the
    // heartbeat the realtime socket relies on to stay alive — the server
    // eventually drops the connection, and every subscription (messages,
    // presence, typing) goes silently dead until a manual reload. A Web
    // Worker heartbeat runs off the throttled main thread, so it's far less
    // likely to miss its beat in the first place. Workers don't exist in
    // React Native, so this only applies on web.
    worker: Platform.OS === 'web',
    // Second line of defense for whatever the worker doesn't catch (mobile,
    // or a drop from something other than tab-throttling, e.g. a real
    // network blip): force a reconnect as soon as a missed heartbeat is
    // detected, instead of waiting for the user to notice and reload.
    heartbeatCallback: (status) => {
      if (status === 'timeout' || status === 'disconnected') {
        supabase.realtime.connect()
      }
    },
  },
})

// Private realtime channels (presence, typing — see migrations/
// 004_realtime_authorization.sql) authorize using the JWT that was current
// when the channel joined, and that authorization isn't automatically
// refreshed when Supabase Auth silently rotates the access token in the
// background. Without this, a long-lived session's presence/typing channels
// go stale and disconnect once the original token expires (~1hr default),
// even though the app is still open and the user is still logged in.
supabase.auth.onAuthStateChange((_event, session) => {
  if (session) supabase.realtime.setAuth(session.access_token)
})

// Extra safety net specifically for the tab-backgrounding case: as soon as
// the tab becomes visible again, proactively check the connection instead of
// waiting for the next heartbeat cycle to notice it's dead.
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && supabase.realtime.isConnected() === false) {
      supabase.realtime.connect()
    }
  })
}
