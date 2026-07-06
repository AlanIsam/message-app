import { useEffect, useRef } from 'react'
import { Audio } from 'expo-av'

export function useMessageSound() {
  const soundRef = useRef<Audio.Sound | null>(null)

  useEffect(() => {
    let mounted = true
    Audio.Sound.createAsync(require('../assets/sounds/message.mp3'))
      .then(({ sound }) => {
        if (mounted) soundRef.current = sound
        else sound.unloadAsync()
      })
      .catch(() => {
        // Preload failure is non-critical — playMessageSound() below just no-ops.
      })
    return () => {
      mounted = false
      soundRef.current?.unloadAsync()
    }
  }, [])

  return async function playMessageSound() {
    try {
      await soundRef.current?.replayAsync()
    } catch {
      // Sound is non-critical — fail silently.
    }
  }
}
