import { useEffect, useState } from 'react'
import { View, Text, TextInput, Pressable, Image, StyleSheet, ActivityIndicator, Alert, Platform } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import * as FileSystem from 'expo-file-system'
import { decode } from 'base64-arraybuffer'
import { useAuth } from '../../hooks/useAuth'
import { supabase } from '../../lib/supabase'
import { colors } from '../../constants/colors'

// fetch(uri).blob() is unreliable for local file:// URIs on Android (a
// well-documented Expo/Supabase Storage gotcha — reports show it silently
// producing empty/corrupt blobs, or the fetch itself throwing "Network
// request failed"). Reading the file as base64 via expo-file-system and
// decoding to an ArrayBuffer is the approach Supabase's own docs recommend
// for native. The web file input's blob: URI doesn't have this problem, so
// it keeps using the simpler fetch().blob() path.
async function readImageForUpload(uri: string): Promise<ArrayBuffer | Blob> {
  if (Platform.OS === 'web') {
    const response = await fetch(uri)
    return await response.blob()
  }
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })
  return decode(base64)
}

export default function SettingsScreen() {
  const { user, signOut } = useAuth()
  const [username, setUsername] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingUsername, setSavingUsername] = useState(false)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [usernameError, setUsernameError] = useState<string | null>(null)
  const [usernameSaved, setUsernameSaved] = useState(false)

  useEffect(() => {
    if (!user) return
    supabase
      .from('profiles')
      .select('username, avatar_url')
      .eq('id', user.id)
      .single()
      .then(({ data }) => {
        if (data) {
          setUsername(data.username)
          setAvatarUrl(data.avatar_url)
        }
        setLoading(false)
      })
  }, [user?.id])

  async function handleSaveUsername() {
    if (!user) return
    const trimmed = username.trim()
    if (!trimmed) return
    setUsernameError(null)
    setUsernameSaved(false)
    setSavingUsername(true)
    try {
      const { error } = await supabase.from('profiles').update({ username: trimmed }).eq('id', user.id)
      if (error) {
        // Postgres unique_violation — profiles.username has a unique constraint.
        setUsernameError(error.code === '23505' ? 'That username is already taken.' : error.message)
        return
      }
      setUsernameSaved(true)
    } finally {
      setSavingUsername(false)
    }
  }

  async function handlePickPhoto() {
    if (!user) return
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!permission.granted) return

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    })
    if (result.canceled || !result.assets?.[0]) return

    setUploadingPhoto(true)
    try {
      const asset = result.assets[0]
      const fileData = await readImageForUpload(asset.uri)
      const ext = asset.uri.split('.').pop()?.split('?')[0] || 'jpg'
      const contentType = asset.mimeType || `image/${ext}`
      // Same path every time (upsert: true) — avoids leaving old photos
      // behind in storage under a per-upload unique name.
      const path = `${user.id}/avatar.${ext}`

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, fileData, { upsert: true, contentType })
      if (uploadError) throw uploadError

      const { data: publicUrlData } = supabase.storage.from('avatars').getPublicUrl(path)
      // Cache-bust so the new photo displays immediately instead of a
      // browser/CDN-cached image at the same URL.
      const bustedUrl = `${publicUrlData.publicUrl}?t=${Date.now()}`

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ avatar_url: bustedUrl })
        .eq('id', user.id)
      if (updateError) throw updateError

      setAvatarUrl(bustedUrl)
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setUploadingPhoto(false)
    }
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accentBright} size="large" />
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <Pressable onPress={handlePickPhoto} style={styles.avatarWrap} disabled={uploadingPhoto}>
        {avatarUrl ? (
          <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
        ) : (
          <View style={styles.avatarPlaceholder}>
            <Text style={styles.avatarInitial}>{username.charAt(0).toUpperCase()}</Text>
          </View>
        )}
        <View style={styles.avatarOverlay}>
          {uploadingPhoto ? (
            <ActivityIndicator color={colors.white} size="small" />
          ) : (
            <Text style={styles.avatarOverlayText}>Change photo</Text>
          )}
        </View>
      </Pressable>

      <Text style={styles.label}>Username</Text>
      <TextInput
        style={styles.input}
        value={username}
        onChangeText={(t) => {
          setUsername(t)
          setUsernameError(null)
          setUsernameSaved(false)
        }}
        placeholder="Username"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
      />
      {usernameError ? <Text style={styles.error}>{usernameError}</Text> : null}
      {usernameSaved ? <Text style={styles.success}>Username updated.</Text> : null}
      <Pressable
        style={[styles.saveButton, savingUsername && styles.saveButtonDisabled]}
        onPress={handleSaveUsername}
        disabled={savingUsername}
      >
        <Text style={styles.saveButtonText}>{savingUsername ? 'Saving…' : 'Save username'}</Text>
      </Pressable>

      <Pressable style={styles.logoutButton} onPress={signOut}>
        <Text style={styles.logoutText}>Log Out</Text>
      </Pressable>
    </View>
  )
}

const AVATAR_SIZE = 96

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: 24,
    alignItems: 'center',
  },
  centered: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarWrap: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    marginTop: 12,
    marginBottom: 32,
    overflow: 'hidden',
  },
  avatarImage: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
  },
  avatarPlaceholder: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    color: colors.text,
    fontSize: 36,
    fontWeight: '700',
  },
  avatarOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
  },
  avatarOverlayText: {
    color: colors.white,
    fontSize: 10,
    fontWeight: '600',
  },
  label: {
    alignSelf: 'flex-start',
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  input: {
    width: '100%',
    backgroundColor: colors.surface,
    color: colors.text,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  error: {
    alignSelf: 'flex-start',
    color: colors.danger,
    marginTop: 8,
  },
  success: {
    alignSelf: 'flex-start',
    color: colors.accentBright,
    marginTop: 8,
  },
  saveButton: {
    width: '100%',
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveButtonText: {
    color: colors.white,
    fontWeight: '600',
    fontSize: 15,
  },
  logoutButton: {
    width: '100%',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 40,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  logoutText: {
    color: colors.danger,
    fontWeight: '600',
    fontSize: 15,
  },
})
