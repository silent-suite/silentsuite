'use client'

import { create } from 'zustand'
import { isSelfHosted, isCustomServer } from '@/app/lib/self-hosted'

export interface User {
  isAdmin?: boolean
  id: string
  email: string
  planId: string
}

interface PendingSignup {
  email: string
  etebaseAuthToken: string
  earlyAdopter?: boolean
}

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
  pendingSignup: PendingSignup | null
  subscriptionStatus: string | null
  isReadOnly: () => boolean
  canWrite: () => boolean
  createEtebaseAccount: (email: string, password: string, serverUrl?: string) => Promise<void>
  signup: (planId: string, trialPath: string) => Promise<string | null>
  login: (email: string, password: string, serverUrl?: string) => Promise<void>
  logout: () => Promise<void>
  refreshSession: () => Promise<boolean>
  restoreSession: () => Promise<void>
  fetchSubscription: () => Promise<void>
  setUser: (user: User | null) => void
  clearError: () => void
}

const BILLING_API_URL =
  process.env.NEXT_PUBLIC_BILLING_API_URL ?? 'http://localhost:3736'

/** Sync the is_admin cookie so Next.js middleware can guard /admin routes server-side. */
function syncAdminCookie(isAdmin: boolean) {
  if (typeof document === 'undefined') return
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  if (isAdmin) {
    document.cookie = `is_admin=true; path=/; max-age=${15 * 60}; SameSite=Strict${secure}`
  } else {
    document.cookie = `is_admin=; path=/; max-age=0; SameSite=Strict${secure}`
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,
  pendingSignup: null,
  subscriptionStatus: null,

  isReadOnly: () => {
    if (isSelfHosted) return false
    if (get().user?.isAdmin) return false
    const status = get().subscriptionStatus
    return status === 'cancelled' || status === 'expired' || status === 'none'
  },
  canWrite: () => !get().isReadOnly(),

  createEtebaseAccount: async (email: string, password: string, serverUrl?: string) => {
    set({ isLoading: true, error: null })
    try {
      const { etebaseSignUp } = await import('@/app/lib/etebase-auth')
      const { authToken, savedSession } = await etebaseSignUp(email, password, serverUrl)
      // SECURITY: Etebase session in localStorage is XSS-vulnerable. Move to encrypted IndexedDB storage.
      localStorage.setItem('etebase_session', savedSession)

      let earlyAdopter = false
      if (!isSelfHosted && !isCustomServer(serverUrl)) {
        try {
          const res = await fetch(
            `${BILLING_API_URL}/auth/check-eligibility?email=${encodeURIComponent(email)}`,
          )
          if (res.ok) {
            const data = await res.json()
            earlyAdopter = data.earlyAdopter === true
          }
        } catch {}
      }

      set({
        pendingSignup: { email, etebaseAuthToken: authToken, earlyAdopter },
        isLoading: false,
      })
    } catch (err) {
      let message = 'Failed to create account'
      if (err instanceof Error) {
        const raw = err.message.toLowerCase()
        if (raw.includes('conflict') || raw.includes('409') || raw.includes('already')) {
          message = 'An account with this email already exists. Please log in instead.'
        } else if (raw.includes('fetch') || raw.includes('network')) {
          message = 'Unable to reach the server. Please check your connection and try again.'
        } else {
          message = err.message
        }
      }
      set({ error: message, isLoading: false })
      throw new Error(message)
    }
  },

  signup: async (planId: string, trialPath: string) => {
    if (isSelfHosted || planId === 'self-hosted') {
      const pending = get().pendingSignup
      if (!pending) throw new Error('No pending signup')
      set({
        user: { id: 'self-hosted', email: pending.email, planId: 'self-hosted', isAdmin: true },
        isAuthenticated: true,
        isLoading: false,
        pendingSignup: null,
        subscriptionStatus: 'active',
      })
      return null
    }

    const pending = get().pendingSignup
    if (!pending?.etebaseAuthToken) {
      throw new Error('No Etebase session. Please start signup again.')
    }
    set({ isLoading: true, error: null })

    try {
      const res = await fetch(`${BILLING_API_URL}/auth/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ etebaseSessionToken: pending.etebaseAuthToken, planId, trialPath }),
        credentials: 'include',
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => null)
        throw new Error(errData?.detail ?? 'Provisioning failed')
      }
      const data = await res.json()
      const isAdmin = data.isAdmin === true
      syncAdminCookie(isAdmin)
      set({
        user: { id: data.id, email: pending.email, planId, isAdmin },
        isAuthenticated: true,
        isLoading: false,
        pendingSignup: null,
        subscriptionStatus: trialPath === '7day' ? 'trialing' : 'none',
      })
      return (data.clientSecret as string) ?? null
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Signup failed'
      set({ error: message, isLoading: false })
      throw err
    }
  },

  login: async (email: string, password: string, serverUrl?: string) => {
    set({ isLoading: true, error: null })
    try {
      const { etebaseLogIn } = await import('@/app/lib/etebase-auth')
      const { authToken, savedSession } = await etebaseLogIn(email, password, serverUrl)
      localStorage.setItem('etebase_session', savedSession)

      if (isSelfHosted || isCustomServer(serverUrl)) {
        if (serverUrl) localStorage.setItem('silentsuite-server-url', serverUrl)
        set({
          user: { id: 'self-hosted', email, planId: 'self-hosted', isAdmin: true },
          isAuthenticated: true,
          isLoading: false,
          subscriptionStatus: 'active',
        })
        return
      }

      const res = await fetch(`${BILLING_API_URL}/auth/token-exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ etebaseSessionToken: authToken }),
        credentials: 'include',
      })

      if (res.status === 429) {
        set({ isLoading: false, error: 'Too many attempts. Please try again later.' }); return
      }
      if (res.status === 404) {
        set({ isLoading: false, error: 'Account not fully set up. Please complete signup first.' }); return
      }
      if (!res.ok) {
        set({ isLoading: false, error: 'Login failed. Please check your credentials.' }); return
      }

      const data = await res.json()
      const isAdmin = data.isAdmin === true
      syncAdminCookie(isAdmin)
      set({
        user: { id: data.id, email: data.email ?? email, planId: data.planId ?? 'free', isAdmin },
        isAuthenticated: true,
        isLoading: false,
      })
    } catch (err) {
      let message = 'Login failed'
      if (err instanceof Error) {
        const raw = err.message.toLowerCase()
        if (raw.includes('unauthorized') || raw.includes('401')) {
          message = 'Invalid email or password. Please try again.'
        } else if (raw.includes('not found') || raw.includes('404')) {
          message = 'No account found with this email. Please sign up first.'
        } else if (raw.includes('fetch') || raw.includes('network')) {
          message = 'Unable to reach the server. Please check your connection and try again.'
        } else {
          message = err.message
        }
      }
      set({ isLoading: false, error: message })
    }
  },

  logout: async () => {
    if (!isSelfHosted) {
      try {
        await fetch(`${BILLING_API_URL}/auth/session`, { method: 'DELETE', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      } catch {}
    }

    // Destroy Etebase store (stops SyncEngine, clears SDK objects)
    try {
      const { useEtebaseStore } = await import('@/app/stores/use-etebase-store')
      useEtebaseStore.getState().destroy()
    } catch {}

    // Clear persisted data stores so next login starts fresh
    localStorage.removeItem('etebase_session')
    localStorage.removeItem('silentsuite-server-url')
    localStorage.removeItem('silentsuite-tasks')
    localStorage.removeItem('silentsuite-contacts')
    localStorage.removeItem('silentsuite-calendar')

    syncAdminCookie(false)
    set({ user: null, isAuthenticated: false, error: null, subscriptionStatus: null })
  },

  refreshSession: async () => {
    const storedServerUrl = typeof window !== 'undefined' ? localStorage.getItem('silentsuite-server-url') : null
    if (isSelfHosted || isCustomServer(storedServerUrl ?? undefined)) {
      const hasSession = !!localStorage.getItem('etebase_session')
      if (hasSession) {
        set({ user: { id: 'self-hosted', email: '', planId: 'self-hosted', isAdmin: true }, isAuthenticated: true, subscriptionStatus: 'active' })
        return true
      }
      set({ user: null, isAuthenticated: false })
      return false
    }

    try {
      const res = await fetch(`${BILLING_API_URL}/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      if (!res.ok) { syncAdminCookie(false); set({ user: null, isAuthenticated: false }); return false }
      const data = await res.json()
      const isAdmin = data.isAdmin === true
      syncAdminCookie(isAdmin)
      set({ user: { id: data.id, email: data.email ?? '', planId: data.planId ?? 'free', isAdmin }, isAuthenticated: true })
      return true
    } catch { syncAdminCookie(false); set({ user: null, isAuthenticated: false }); return false }
  },

  restoreSession: async () => {
    const storedServerUrl = typeof window !== 'undefined' ? localStorage.getItem('silentsuite-server-url') : null
    if (isSelfHosted || isCustomServer(storedServerUrl ?? undefined)) {
      const hasSession = !!localStorage.getItem('etebase_session')
      if (hasSession) {
        set({ user: { id: 'self-hosted', email: '', planId: 'self-hosted', isAdmin: true }, isAuthenticated: true, isLoading: false, subscriptionStatus: 'active' })
      } else {
        set({ user: null, isAuthenticated: false, isLoading: false })
      }
      return
    }

    set({ isLoading: true })
    try {
      const res = await fetch(`${BILLING_API_URL}/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      if (res.ok) {
        const data = await res.json()
        const isAdmin = data.isAdmin === true
        syncAdminCookie(isAdmin)
        set({ user: { id: data.id, email: data.email ?? '', planId: data.planId ?? 'free', isAdmin }, isAuthenticated: true, isLoading: false })
      } else {
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, isLoading: false })
      }
    } catch { syncAdminCookie(false); set({ user: null, isAuthenticated: false, isLoading: false }) }
  },

  fetchSubscription: async () => {
    const storedServerUrl = typeof window !== 'undefined' ? localStorage.getItem('silentsuite-server-url') : null
    if (isSelfHosted || isCustomServer(storedServerUrl ?? undefined)) { set({ subscriptionStatus: 'active' }); return }

    try {
      const res = await fetch(`${BILLING_API_URL}/subscription`, { credentials: 'include' })
      if (res.ok) { const data = await res.json(); set({ subscriptionStatus: data.status }) }
    } catch {}
  },

  setUser: (user: User | null) => set({ user, isAuthenticated: user !== null }),
  clearError: () => set({ error: null }),
}))
