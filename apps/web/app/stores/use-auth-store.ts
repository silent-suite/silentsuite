'use client'

import { create } from 'zustand'
import { isSelfHosted, isCustomServer } from '@/app/lib/self-hosted'
import { logger } from '@/app/lib/logger'
import { BILLING_API_URL } from '@/app/lib/config'
import { COOKIE_MAX_AGE_SELF_HOSTED, COOKIE_MAX_AGE_HOSTED } from '@/app/lib/constants'
import { secureGet, secureSet, secureRemove, secureClear, migrateFromLocalStorage } from '@/app/lib/secure-storage'

export interface User {
  isAdmin?: boolean
  id: string
  email: string
  planId: string
  emailVerified?: boolean
}

interface PendingSignup {
  email: string
  etebaseAuthToken: string
  earlyAdopter?: boolean
  wantsProductUpdates?: boolean
  /** Provisioned user data — stored here until the entire signup flow completes. */
  provisionedUser?: {
    id: string
    planId: string
    isAdmin: boolean
  }
  /** Subscription status determined during provisioning. */
  provisionedSubscriptionStatus?: string
}

/** Shape of the data persisted to localStorage for surviving Stripe 3DS redirects. */
export interface RedirectSignupState {
  pendingSignup: PendingSignup
  selectedInterval: 'monthly' | 'annual'
  savedAt: number
}

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
  pendingSignup: PendingSignup | null
  subscriptionStatus: string | null
  isDegraded: () => boolean
  isReadOnly: () => boolean
  canWrite: () => boolean
  createEtebaseAccount: (email: string, password: string, serverUrl?: string) => Promise<void>
  signup: (planId: string, trialPath: string) => Promise<string | null>
  /** Call after the entire signup flow (including payment + vault) to finalize authentication. */
  completeSignup: () => void
  login: (email: string, password: string, serverUrl?: string) => Promise<void>
  logout: () => Promise<void>
  refreshSession: () => Promise<boolean>
  restoreSession: () => Promise<void>
  fetchSubscription: () => Promise<void>
  retryBillingConnection: () => Promise<boolean>
  setUser: (user: User | null) => void
  clearError: () => void
  /**
   * Persist pendingSignup + billing interval to localStorage so the signup flow
   * survives a full-page Stripe 3DS redirect.
   *
   * SECURITY: The etebaseAuthToken is stored in localStorage. This is the same
   * XSS risk surface as the existing `etebase_session` key — acceptable given
   * the current security posture. The data is cleared on first read.
   */
  saveSignupStateForRedirect: (selectedInterval: 'monthly' | 'annual') => void
  /**
   * Restore signup state saved before a Stripe 3DS redirect.
   * Returns the saved data and removes it from localStorage (one-time use).
   * Returns null if no data exists or if it is older than 10 minutes.
   */
  restoreSignupStateFromRedirect: () => RedirectSignupState | null
}



/** Sync the is_admin cookie so Next.js middleware can guard /admin routes server-side. */
function syncAdminCookie(isAdmin: boolean) {
  if (typeof document === 'undefined') return
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  // Self-hosted users are always admin — use a longer cookie lifetime (7 days).
  // SaaS users get 15 min and rely on session refresh to renew.
  const isSH = typeof localStorage !== 'undefined' && !!localStorage.getItem('silentsuite-server-url')
  const maxAge = (isSelfHosted || isSH) ? COOKIE_MAX_AGE_SELF_HOSTED : COOKIE_MAX_AGE_HOSTED
  if (isAdmin) {
    document.cookie = `is_admin=true; path=/; max-age=${maxAge}; SameSite=Strict${secure}`
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

  isDegraded: () => get().subscriptionStatus === 'billing_unavailable',

  isReadOnly: () => {
    if (isSelfHosted) return false
    if (get().user?.isAdmin) return false
    const status = get().subscriptionStatus
    // billing_unavailable = degraded mode → full access (our infra problem, not theirs)
    if (status === 'billing_unavailable') return false
    return status === 'cancelled' || status === 'expired' || status === 'none'
  },
  canWrite: () => !get().isReadOnly(),

  createEtebaseAccount: async (email: string, password: string, serverUrl?: string) => {
    set({ isLoading: true, error: null })
    try {
      const { etebaseSignUp } = await import('@/app/lib/etebase-auth')
      const { authToken, savedSession } = await etebaseSignUp(email, password, serverUrl)
      await secureSet('etebase_session', savedSession)

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
        } catch (err) {
          logger.warn('[auth-store] Failed to check early adopter eligibility:', err)
        }
      }

      // Mark signup as in progress so restoreSession won't authenticate mid-flow
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('silentsuite-signup-in-progress', 'true')
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

      // Self-hosted: if user opted in, subscribe to newsletter on the SilentSuite API
      if (pending.wantsProductUpdates) {
        try {
          const res = await fetch(`${BILLING_API_URL}/newsletter/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: pending.email, source: 'self_hosted' }),
          })
          if (!res.ok) logger.warn('Newsletter subscribe failed:', res.status)
        } catch (err) {
          logger.warn('Newsletter subscribe failed:', err)
        }
      }

      // Self-hosted: store provisioned data but do NOT authenticate yet.
      // completeSignup() will finalize after vault creation.
      set({
        pendingSignup: {
          ...pending,
          provisionedUser: { id: 'self-hosted', planId: 'self-hosted', isAdmin: true },
          provisionedSubscriptionStatus: 'active',
        },
        isLoading: false,
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
        body: JSON.stringify({
          etebaseSessionToken: pending.etebaseAuthToken,
          planId,
          trialPath,
          wantsProductUpdates: pending.wantsProductUpdates,
        }),
        credentials: 'include',
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => null)
        throw new Error(errData?.detail ?? 'Provisioning failed')
      }
      const data = await res.json()
      const isAdmin = data.isAdmin === true
      syncAdminCookie(isAdmin)
      // Store provisioned data in pendingSignup — do NOT set isAuthenticated yet.
      // The user is still in the signup flow (payment + vault steps remain).
      set({
        pendingSignup: {
          ...pending,
          provisionedUser: { id: data.id, planId, isAdmin },
          provisionedSubscriptionStatus: 'trialing',
        },
        isLoading: false,
      })
      return (data.clientSecret as string) ?? null
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Signup failed'
      set({ error: message, isLoading: false })
      throw err
    }
  },

  completeSignup: () => {
    const pending = get().pendingSignup
    if (!pending?.provisionedUser) {
      logger.warn('completeSignup called without provisioned data')
      return
    }
    // Clear the signup-in-progress flag so restoreSession works normally
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem('silentsuite-signup-in-progress')
    }
    // Sync admin cookie so middleware allows /admin access
    syncAdminCookie(pending.provisionedUser.isAdmin)
    set({
      user: {
        id: pending.provisionedUser.id,
        email: pending.email,
        planId: pending.provisionedUser.planId,
        isAdmin: pending.provisionedUser.isAdmin,
      },
      isAuthenticated: true,
      isLoading: false,
      pendingSignup: null,
      subscriptionStatus: pending.provisionedSubscriptionStatus ?? null,
    })
  },

  login: async (email: string, password: string, serverUrl?: string) => {
    set({ isLoading: true, error: null })
    try {
      const { etebaseLogIn } = await import('@/app/lib/etebase-auth')
      const { authToken, savedSession } = await etebaseLogIn(email, password, serverUrl)
      await secureSet('etebase_session', savedSession)

      if (isSelfHosted || isCustomServer(serverUrl)) {
        if (serverUrl) localStorage.setItem('silentsuite-server-url', serverUrl)
        syncAdminCookie(true)
        set({
          user: { id: 'self-hosted', email, planId: 'self-hosted', isAdmin: true },
          isAuthenticated: true,
          isLoading: false,
          subscriptionStatus: 'active',
        })
        return
      }

      // Logging in to the default server — clear any stale self-hosted URL
      localStorage.removeItem('silentsuite-server-url')

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
        user: { id: data.id, email: data.email ?? email, planId: data.planId ?? 'free', isAdmin, emailVerified: data.emailVerified ?? false },
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
      } catch (err) {
        logger.warn('[auth-store] Failed to delete server session during logout:', err)
      }
    }

    // Destroy Etebase store (stops SyncEngine, clears SDK objects)
    try {
      const { useEtebaseStore } = await import('@/app/stores/use-etebase-store')
      useEtebaseStore.getState().destroy()
    } catch (err) {
      logger.warn('[auth-store] Failed to destroy Etebase store during logout:', err)
    }

    // Clear signup-in-progress flag
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem('silentsuite-signup-in-progress')
    }

    // Clear persisted data stores so next login starts fresh
    await secureClear()
    localStorage.removeItem('silentsuite-server-url')
    // Legacy localStorage keys (no longer written, but clear in case of stale data)
    localStorage.removeItem('silentsuite-tasks')
    localStorage.removeItem('silentsuite-contacts')
    localStorage.removeItem('silentsuite-calendar')
    localStorage.removeItem('etebase_session')

    syncAdminCookie(false)
    set({ user: null, isAuthenticated: false, error: null, subscriptionStatus: null })
  },

  refreshSession: async () => {
    const storedServerUrl = typeof window !== 'undefined' ? localStorage.getItem('silentsuite-server-url') : null
    if (isSelfHosted || isCustomServer(storedServerUrl ?? undefined)) {
      const hasSession = !!(await secureGet('etebase_session'))
      if (hasSession) {
        syncAdminCookie(true)
        set({ user: { id: 'self-hosted', email: '', planId: 'self-hosted', isAdmin: true }, isAuthenticated: true, subscriptionStatus: 'active' })
        return true
      }
      syncAdminCookie(false)
      set({ user: null, isAuthenticated: false })
      return false
    }

    try {
      const res = await fetch(`${BILLING_API_URL}/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      if (!res.ok) { syncAdminCookie(false); set({ user: null, isAuthenticated: false }); return false }
      const data = await res.json()
      const isAdmin = data.isAdmin === true
      syncAdminCookie(isAdmin)
      set({ user: { id: data.id, email: data.email ?? '', planId: data.planId ?? 'free', isAdmin, emailVerified: data.emailVerified ?? false }, isAuthenticated: true })
      return true
    } catch (err) {
      logger.warn('[auth-store] Session refresh failed:', err)
      syncAdminCookie(false)
      set({ user: null, isAuthenticated: false })
      return false
    }
  },

  restoreSession: async () => {
    // Run one-time migration from localStorage to IndexedDB
    await migrateFromLocalStorage()

    // If a signup is in progress (pendingSignup exists or flag in sessionStorage),
    // do NOT restore the session — the user must complete the signup flow first.
    const signupInProgress = typeof window !== 'undefined' && sessionStorage.getItem('silentsuite-signup-in-progress')
    if (signupInProgress) {
      set({ user: null, isAuthenticated: false, isLoading: false })
      return
    }

    const storedServerUrl = typeof window !== 'undefined' ? localStorage.getItem('silentsuite-server-url') : null
    if (isSelfHosted || isCustomServer(storedServerUrl ?? undefined)) {
      const hasSession = !!(await secureGet('etebase_session'))
      if (hasSession) {
        syncAdminCookie(true)
        set({ user: { id: 'self-hosted', email: '', planId: 'self-hosted', isAdmin: true }, isAuthenticated: true, isLoading: false, subscriptionStatus: 'active' })
      } else {
        syncAdminCookie(false)
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
        set({ user: { id: data.id, email: data.email ?? '', planId: data.planId ?? 'free', isAdmin, emailVerified: data.emailVerified ?? false }, isAuthenticated: true, isLoading: false })
      } else {
        // HTTP error (401/403 etc.) — billing responded, auth is invalid
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, isLoading: false })
      }
    } catch (err) {
      // Network error — billing API is unreachable.
      logger.warn('[auth-store] Session restore failed (network):', err)
      // If a valid Etebase session exists, enter degraded mode instead of kicking the user out.
      const hasEtebaseSession = !!(await secureGet('etebase_session'))
      if (hasEtebaseSession) {
        set({
          user: { id: 'degraded', email: '', planId: 'unknown', isAdmin: false },
          isAuthenticated: true,
          isLoading: false,
          subscriptionStatus: 'billing_unavailable',
        })
      } else {
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, isLoading: false })
      }
    }
  },

  fetchSubscription: async () => {
    const storedServerUrl = typeof window !== 'undefined' ? localStorage.getItem('silentsuite-server-url') : null
    if (isSelfHosted || isCustomServer(storedServerUrl ?? undefined)) { set({ subscriptionStatus: 'active' }); return }

    try {
      const res = await fetch(`${BILLING_API_URL}/subscription`, { credentials: 'include' })
      if (res.ok) { const data = await res.json(); set({ subscriptionStatus: data.status }) }
    } catch (err) {
      // Network error — only enter degraded mode if there's no existing good status
      logger.warn('[auth-store] fetchSubscription failed (network):', err)
      const current = get().subscriptionStatus
      if (!current) {
        set({ subscriptionStatus: 'billing_unavailable' })
      }
    }
  },

  retryBillingConnection: async () => {
    const storedServerUrl = typeof window !== 'undefined' ? localStorage.getItem('silentsuite-server-url') : null
    if (isSelfHosted || isCustomServer(storedServerUrl ?? undefined)) return true

    try {
      // Fetch both endpoints — only apply state if BOTH succeed
      const [refreshRes, subRes] = await Promise.all([
        fetch(`${BILLING_API_URL}/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } }),
        fetch(`${BILLING_API_URL}/subscription`, { credentials: 'include' }),
      ])
      if (!refreshRes.ok || !subRes.ok) return false
      const refreshData = await refreshRes.json()
      const subData = await subRes.json()
      const isAdmin = refreshData.isAdmin === true
      syncAdminCookie(isAdmin)
      set({
        user: { id: refreshData.id, email: refreshData.email ?? '', planId: refreshData.planId ?? 'free', isAdmin, emailVerified: refreshData.emailVerified ?? false },
        isAuthenticated: true,
        subscriptionStatus: subData.status,
      })
      return true
    } catch (err) {
      logger.warn('[auth-store] retryBillingConnection failed:', err)
      return false
    }
  },

  setUser: (user: User | null) => set({ user, isAuthenticated: user !== null }),
  clearError: () => set({ error: null }),

  saveSignupStateForRedirect: (selectedInterval) => {
    const pending = get().pendingSignup
    if (!pending) {
      logger.warn('[auth-store] saveSignupStateForRedirect: no pendingSignup to save')
      return
    }
    const data: RedirectSignupState = {
      pendingSignup: pending,
      selectedInterval,
      savedAt: Date.now(),
    }
    try {
      localStorage.setItem('silentsuite-signup-redirect-state', JSON.stringify(data))
    } catch (err) {
      logger.warn('[auth-store] Failed to save signup redirect state:', err)
    }
  },

  restoreSignupStateFromRedirect: () => {
    try {
      const raw = localStorage.getItem('silentsuite-signup-redirect-state')
      if (!raw) return null
      // Always remove immediately — one-time use
      localStorage.removeItem('silentsuite-signup-redirect-state')
      const data = JSON.parse(raw) as RedirectSignupState
      // Basic shape validation — guard against corrupted or tampered localStorage data
      if (!data.pendingSignup?.email || !data.pendingSignup?.etebaseAuthToken) {
        logger.warn('[auth-store] Redirect signup state is malformed, discarding')
        return null
      }
      // Reject if older than 10 minutes
      const TEN_MINUTES = 10 * 60 * 1000
      if (Date.now() - data.savedAt > TEN_MINUTES) {
        logger.warn('[auth-store] Redirect signup state expired (>10 min old)')
        return null
      }
      // Restore pendingSignup into the Zustand store and re-set the signup-in-progress
      // flag so restoreSession() doesn't run concurrently and clobber the restored state.
      set({ pendingSignup: data.pendingSignup })
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('silentsuite-signup-in-progress', 'true')
      }
      return data
    } catch (err) {
      logger.warn('[auth-store] Failed to restore signup redirect state:', err)
      localStorage.removeItem('silentsuite-signup-redirect-state')
      return null
    }
  },
}))
