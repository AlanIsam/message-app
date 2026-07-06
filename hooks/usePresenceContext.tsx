import { createContext, useContext, ReactNode } from 'react'
import { usePresence } from './usePresence'
import { useAuth } from './useAuth'

type PresenceContextValue = {
  isOnline: (id: string) => boolean
}

const PresenceContext = createContext<PresenceContextValue>({ isOnline: () => false })

export function PresenceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const { isOnline } = usePresence(user?.id)
  return <PresenceContext.Provider value={{ isOnline }}>{children}</PresenceContext.Provider>
}

export function usePresenceContext() {
  return useContext(PresenceContext)
}
