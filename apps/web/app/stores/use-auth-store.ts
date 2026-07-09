'use client'

import { create } from 'zustand'
import { isSelfHosted, isCustomServer } from '@/app/lib/self-hosted'
import { logger } from '@/app/lib/logger'
import { BILLING_API_URL, ETEBASE_SERVER_URL } from '@/app/lib/config'
import { COOKIE_MAX_AGE_SELF_HOSTED, COOKIE_MAX_AGE_HOSTED } from '@/app/lib/constants'
import { secureGet, secureSet, secureRemove, secureClear, migrateFromLocalStorage } from '@/app/lib/secure-storage'
import { clearAll as clearLocalDataCache } from '@/app/lib/data-cache'
import { clearAll as clearOfflineQueue } from '@/app/lib/offline-queue'
import { createLoginSessionPersistenceDiagnostics } from '@/app/lib/sync-restore-diagnostics'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'

export interface User {
  isAdmin?: boolean
  id: string
  email: string
  planId: string
  emailVerified?: boolean
  rememberDevice?: boolean
  /**
   * Legacy account metadata from the old first-run onboarding flow. The web app
   * no longer shows an onboarding window at startup, but we still hydrate the
   * field for backward compatibility with existing billing API responses.
   */
  onboardedAt?: string | null
}

interface PendingSignup {
  email: string
  etebaseAuthToken?: string
  paymentSessionToken?: string
  earlyAdopter?: boolean
  wantsProductUpdates?: boolean
  rememberDevice?: boolean
  /** Provisioned user data — stored here until the entire signup flow completes. */
  provisionedUser?: {
    id: string
    planId: string
    isAdmin: boolean
  }
  /** Subscription status determined during provisioning. */
  provisionedSubscriptionStatus?: string
}

interface SignupResult {
  clientSecret: string | null
  cryptoCheckoutUrl: string | null
  cryptoInvoiceId: string | null
  cryptoInvoiceLookupToken: string | null
  paymentSessionToken: string | null
}

/** Shape of the data persisted to sessionStorage for surviving Stripe 3DS redirects. */
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
  prepareSignupDraft: (email: string, wantsProductUpdates?: boolean, rememberDevice?: boolean) => void
  createEtebaseAccount: (email: string, password: string, serverUrl?: string) => Promise<void>
  signup: (planId: string, trialPath: string, promoCode?: string) => Promise<SignupResult>
  finalizePaidSignup: () => Promise<SignupResult>
  /** Call after the entire signup flow (including payment + vault) to finalize authentication. */
  completeSignup: () => void
  login: (email: string, password: string, serverUrl?: string, rememberDevice?: boolean) => Promise<void>
  unlockEtebaseSession: (email: string, password: string, serverUrl?: string) => Promise<void>
  logout: () => Promise<void>
  refreshSession: () => Promise<boolean>
  restoreSession: () => Promise<void>
  fetchSubscription: () => Promise<void>
  retryBillingConnection: () => Promise<boolean>
  /**
   * Mark the current user as onboarded in legacy account metadata. Kept for
   * compatibility with existing billing API state; the web app no longer uses
   * this as a startup UI gate.
   */
  markOnboarded: () => Promise<boolean>
  setUser: (user: User | null) => void
  clearError: () => void
  /**
   * Persist pendingSignup + billing interval to sessionStorage so the signup
   * flow survives a full-page Stripe 3DS redirect. sessionStorage is scoped to
   * the tab and cleared on close, which is a tighter blast radius than
   * localStorage for the etebaseAuthToken this blob carries. The data is also
   * cleared on first read and rejected if older than 2 hours.
   */
  saveSignupStateForRedirect: (selectedInterval: 'monthly' | 'annual') => void
  /**
   * Restore signup state saved before a Stripe 3DS redirect.
   * Returns the saved data and removes it from sessionStorage (one-time use).
   * Returns null if no data exists or if it is older than 2 hours.
   */
  restoreSignupStateFromRedirect: () => RedirectSignupState | null
}


const HOSTED_VALIDATION_SESSION_KEY = 'silentsuite-hosted-validation-session'
const HOSTED_VALIDATION_REMEMBERED_KEY = 'silentsuite-hosted-validation-remembered'
const HOSTED_REMEMBERED_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000
const HOSTED_ACTIVE_TABS_KEY = 'silentsuite-hosted-validation-active-tabs'
const HOSTED_TAB_ID_KEY = 'silentsuite-hosted-tab-id'
const HOSTED_VALIDATION_INITIALIZED_KEY = 'silentsuite-hosted-validation-initialized'
const HOSTED_AUTH_INVALIDATED_KEY = 'silentsuite-hosted-auth-invalidated'
const HOSTED_ACTIVE_TAB_TTL_MS = 15_000
const HOSTED_ACTIVE_TAB_HEARTBEAT_MS = 5_000
const HOSTED_ACTIVE_TAB_BROADCAST = 'silentsuite-hosted-session-tabs'
const HOSTED_ACTIVE_TAB_PING_TIMEOUT_MS = 1000

const AUTH_RATE_LIMIT_MESSAGE =
  'Too many sign-in attempts. Please wait a few minutes before trying again. Your encrypted data is safe.'
const AUTH_TEMPORARY_UNAVAILABLE_MESSAGE =
  'Sign-in is temporarily unavailable. Please wait a minute and try again. Your encrypted data is safe.'

let hostedActiveTabHeartbeat: number | null = null
let hostedActiveTabUnloadHooked = false

interface HostedValidationMarker {
  userId: string
  rememberDevice: boolean
  validatedAt: number
}

interface HostedActiveTabMarker {
  userId: string
  validatedAt: number
}

function getHostedTabId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    let tabId = sessionStorage.getItem(HOSTED_TAB_ID_KEY)
    if (!tabId) {
      tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`
      sessionStorage.setItem(HOSTED_TAB_ID_KEY, tabId)
    }
    return tabId
  } catch {
    return null
  }
}

function readHostedActiveTabs(): Record<string, HostedActiveTabMarker> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(HOSTED_ACTIVE_TABS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, HostedActiveTabMarker>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeHostedActiveTabs(tabs: Record<string, HostedActiveTabMarker>) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(HOSTED_ACTIVE_TABS_KEY, JSON.stringify(tabs))
  } catch (err) {
    logger.warn('[auth-store] Failed to write hosted active-tab marker:', err)
  }
}

function pruneHostedActiveTabs(now = Date.now()): Record<string, HostedActiveTabMarker> {
  const tabs = readHostedActiveTabs()
  let changed = false
  for (const [tabId, marker] of Object.entries(tabs)) {
    if (!marker?.userId || now - marker.validatedAt > HOSTED_ACTIVE_TAB_TTL_MS) {
      delete tabs[tabId]
      changed = true
    }
  }
  if (changed) writeHostedActiveTabs(tabs)
  return tabs
}

function markHostedActiveTab(userId: string) {
  const tabId = getHostedTabId()
  if (!tabId || !userId) return
  const tabs = pruneHostedActiveTabs()
  tabs[tabId] = { userId, validatedAt: Date.now() }
  writeHostedActiveTabs(tabs)
}

function readOtherActiveHostedSessionTab(userId?: string): HostedActiveTabMarker | null {
  const tabId = getHostedTabId()
  if (!tabId) return null
  const tabs = pruneHostedActiveTabs()
  const match = Object.entries(tabs).find(([id, marker]) => {
    return id !== tabId && (!userId || marker.userId === userId)
  })
  return match?.[1] ?? null
}

function hasOtherActiveHostedSessionTab(userId: string): boolean {
  return !!readOtherActiveHostedSessionTab(userId)
}

async function hasLiveOtherHostedSessionTab(userId: string): Promise<boolean> {
  if (typeof window === 'undefined') return false
  if (typeof window.BroadcastChannel !== 'function') return hasOtherActiveHostedSessionTab(userId)

  try {
    return await new Promise<boolean>((resolve) => {
      const channel = new window.BroadcastChannel(HOSTED_ACTIVE_TAB_BROADCAST)
      const timer = window.setTimeout(() => {
        channel.close()
        resolve(hasOtherActiveHostedSessionTab(userId))
      }, HOSTED_ACTIVE_TAB_PING_TIMEOUT_MS)
      channel.addEventListener('message', (event) => {
        if (event.data?.type !== 'pong' || event.data?.userId !== userId) return
        window.clearTimeout(timer)
        channel.close()
        resolve(true)
      })
      channel.postMessage({ type: 'ping', userId, tabId: getHostedTabId() })
    })
  } catch {
    return hasOtherActiveHostedSessionTab(userId)
  }
}

function stopHostedActiveTabHeartbeat() {
  if (hostedActiveTabHeartbeat) {
    clearInterval(hostedActiveTabHeartbeat)
    hostedActiveTabHeartbeat = null
  }
}

function startHostedActiveTabHeartbeat(userId: string) {
  if (typeof window === 'undefined' || !userId) return
  markHostedActiveTab(userId)
  stopHostedActiveTabHeartbeat()
  hostedActiveTabHeartbeat = window.setInterval(() => markHostedActiveTab(userId), HOSTED_ACTIVE_TAB_HEARTBEAT_MS)
  if (!hostedActiveTabUnloadHooked) {
    hostedActiveTabUnloadHooked = true
    window.addEventListener('pagehide', clearCurrentHostedActiveTab)
    window.addEventListener('beforeunload', clearCurrentHostedActiveTab)
    if (typeof window.BroadcastChannel === 'function') {
      try {
        const channel = new window.BroadcastChannel(HOSTED_ACTIVE_TAB_BROADCAST)
        channel.addEventListener('message', (event) => {
          const current = readHostedValidationMarker()
          if (!current || current.rememberDevice !== false) return
          if (event.data?.type !== 'ping' || event.data?.userId !== current.userId) return
          channel.postMessage({ type: 'pong', userId: current.userId, tabId: getHostedTabId() })
        })
      } catch {
        // Fall back to the local active-tab TTL marker when BroadcastChannel is unavailable.
      }
    }
  }
}

function clearCurrentHostedActiveTab() {
  const tabId = getHostedTabId()
  if (!tabId) return
  const tabs = readHostedActiveTabs()
  if (tabs[tabId]) {
    delete tabs[tabId]
    writeHostedActiveTabs(tabs)
  }
}

function clearHostedValidationMarkers() {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.removeItem(HOSTED_VALIDATION_SESSION_KEY)
    localStorage.removeItem(HOSTED_VALIDATION_REMEMBERED_KEY)
    localStorage.removeItem(HOSTED_ACTIVE_TABS_KEY)
    localStorage.removeItem(HOSTED_VALIDATION_INITIALIZED_KEY)
    stopHostedActiveTabHeartbeat()
  } catch (err) {
    logger.warn('[auth-store] Failed to clear hosted validation markers:', err)
  }
}

function authErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return 'Login failed'
  const raw = err.message.toLowerCase()
  if (raw.includes('unauthorized') || raw.includes('401')) return 'Invalid email or password. Please try again.'
  if (raw.includes('not found') || raw.includes('404')) return 'No account found with this email. Please sign up first.'
  if (raw.includes('429') || raw.includes('too many') || raw.includes('rate limit') || raw.includes('throttl')) {
    return AUTH_RATE_LIMIT_MESSAGE
  }
  if (raw.includes('fetch') || raw.includes('network') || raw.includes('timeout') || raw.includes('timed out')) {
    return AUTH_TEMPORARY_UNAVAILABLE_MESSAGE
  }
  return 'Login failed. Please try again.'
}

function markHostedValidation(userId: string, rememberDevice: boolean) {
  if (typeof window === 'undefined' || !userId) return
  const marker: HostedValidationMarker = { userId, rememberDevice, validatedAt: Date.now() }
  try {
    if (rememberDevice) {
      localStorage.removeItem(HOSTED_AUTH_INVALIDATED_KEY)
      localStorage.setItem(HOSTED_VALIDATION_REMEMBERED_KEY, JSON.stringify(marker))
      sessionStorage.removeItem(HOSTED_VALIDATION_SESSION_KEY)
      clearCurrentHostedActiveTab()
      stopHostedActiveTabHeartbeat()
    } else {
      localStorage.removeItem(HOSTED_AUTH_INVALIDATED_KEY)
      sessionStorage.setItem(HOSTED_VALIDATION_SESSION_KEY, JSON.stringify(marker))
      localStorage.removeItem(HOSTED_VALIDATION_REMEMBERED_KEY)
      startHostedActiveTabHeartbeat(userId)
    }
    localStorage.setItem(HOSTED_VALIDATION_INITIALIZED_KEY, 'true')
  } catch (err) {
    logger.warn('[auth-store] Failed to write hosted validation marker:', err)
  }
}

function readHostedValidationMarker(): HostedValidationMarker | null {
  if (typeof window === 'undefined') return null
  try {
    const sessionRaw = sessionStorage.getItem(HOSTED_VALIDATION_SESSION_KEY)
    if (sessionRaw) {
      const marker = JSON.parse(sessionRaw) as HostedValidationMarker
      if (marker.userId && marker.rememberDevice === false) return marker
    }
    const rememberedRaw = localStorage.getItem(HOSTED_VALIDATION_REMEMBERED_KEY)
    if (!rememberedRaw) return null
    const marker = JSON.parse(rememberedRaw) as HostedValidationMarker
    if (!marker.userId || marker.rememberDevice !== true) return null
    if (Date.now() - marker.validatedAt > HOSTED_REMEMBERED_MARKER_TTL_MS) {
      localStorage.removeItem(HOSTED_VALIDATION_REMEMBERED_KEY)
      return null
    }
    return marker
  } catch (err) {
    logger.warn('[auth-store] Failed to read hosted validation marker:', err)
    clearHostedValidationMarkers()
    return null
  }
}

async function clearLocalAuthMaterial(reason: 'logout' | 'invalid-hosted-auth') {
  try {
    const { useEtebaseStore } = await import('@/app/stores/use-etebase-store')
    useEtebaseStore.getState().destroy()
  } catch (err) {
    logger.warn(`[auth-store] Failed to destroy Etebase store during ${reason}:`, err)
  }

  try {
    await clearLocalDataCache()
  } catch (err) {
    logger.warn(`[auth-store] Failed to clear local data cache during ${reason}:`, err)
  }

  try {
    await clearOfflineQueue()
  } catch (err) {
    logger.warn(`[auth-store] Failed to clear offline queue during ${reason}:`, err)
  }

  if (typeof window !== 'undefined') {
    sessionStorage.removeItem('silentsuite-signup-in-progress')
    sessionStorage.removeItem('silentsuite-signup-redirect-state')
  }

  try {
    await secureClear()
  } catch (err) {
    logger.warn(`[auth-store] Failed to clear secure storage during ${reason}:`, err)
  }
  localStorage.removeItem('silentsuite-server-url')
  localStorage.removeItem('silentsuite-tasks')
  localStorage.removeItem('silentsuite-contacts')
  localStorage.removeItem('silentsuite-calendar')
  localStorage.removeItem('etebase_session')
  clearHostedValidationMarkers()
  localStorage.setItem(HOSTED_AUTH_INVALIDATED_KEY, String(Date.now()))

  try {
    const { usePreferencesStore } = await import('@/app/stores/use-preferences-store')
    usePreferencesStore.getState().resetSyncedPreferences()
  } catch (err) {
    logger.warn(`[auth-store] Failed to reset synced preferences during ${reason}:`, err)
  }
}

/** Sync the is_admin cookie so Next.js middleware can guard /admin routes server-side. */
function syncAdminCookie(isAdmin: boolean, rememberDevice = false) {
  if (typeof document === 'undefined') return
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  const isSH = typeof localStorage !== 'undefined' && !!localStorage.getItem('silentsuite-server-url')
  const maxAge = (isSelfHosted || isSH) ? COOKIE_MAX_AGE_SELF_HOSTED : (rememberDevice ? COOKIE_MAX_AGE_HOSTED : null)
  if (isAdmin) {
    const maxAgePart = maxAge == null ? '' : `; max-age=${maxAge}`
    document.cookie = `is_admin=true; path=/${maxAgePart}; SameSite=Strict${secure}`
  } else {
    document.cookie = `is_admin=; path=/; max-age=0; SameSite=Strict${secure}`
  }
}

async function deleteHostedServerSession(context: string) {
  try {
    await fetch(`${BILLING_API_URL}/auth/session`, { method: 'DELETE', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
  } catch (err) {
    logger.warn(`[auth-store] Failed to delete server session during ${context}:`, err)
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

  prepareSignupDraft: (email: string, wantsProductUpdates?: boolean, rememberDevice?: boolean) => {
    const pending = get().pendingSignup
    const reusablePending = pending?.email.toLowerCase() === email.toLowerCase() ? pending : null
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('silentsuite-signup-in-progress', 'true')
    }
    set({
      pendingSignup: {
        ...(reusablePending ?? {}),
        email,
        wantsProductUpdates,
        rememberDevice: rememberDevice === true,
      },
      error: null,
    })
  },

  createEtebaseAccount: async (email: string, password: string, serverUrl?: string) => {
    set({ isLoading: true, error: null })
    try {
      const { etebaseSignUp, etebaseLogIn } = await import('@/app/lib/etebase-auth')
      let authResult: { authToken: string; savedSession: string }
      try {
        authResult = await etebaseSignUp(email, password, serverUrl)
      } catch (signupErr) {
        const raw = signupErr instanceof Error ? signupErr.message.toLowerCase() : ''
        if (!raw.includes('conflict') && !raw.includes('409') && !raw.includes('already')) {
          throw signupErr
        }
        // Recover legacy abandoned signups where Etebase was created before payment.
        authResult = await etebaseLogIn(email, password, serverUrl)
      }
      const { authToken, savedSession } = authResult
      if (!isSelfHosted && !isCustomServer(serverUrl)) clearHostedValidationMarkers()
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

      const pending = get().pendingSignup
      const reusablePending = pending?.email.toLowerCase() === email.toLowerCase() ? pending : null
      set({
        pendingSignup: { ...(reusablePending ?? {}), email, etebaseAuthToken: authToken, earlyAdopter },
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

  signup: async (planId: string, trialPath: string, promoCode?: string) => {
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
      return { clientSecret: null, cryptoCheckoutUrl: null, cryptoInvoiceId: null, cryptoInvoiceLookupToken: null, paymentSessionToken: null }
    }

    const pending = get().pendingSignup
    if (!pending?.email) {
      throw new Error('No pending signup')
    }
    const isPaidSignupDraft = (trialPath === '30day' || trialPath === 'crypto_annual') && !pending.etebaseAuthToken
    if (isPaidSignupDraft) {
      set({ isLoading: true, error: null })
      try {
        const res = await fetch(`${BILLING_API_URL}/auth/signup/payment-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({
            email: pending.email,
            planId,
            trialPath,
            ...(promoCode?.trim() ? { promoCode: promoCode.trim() } : {}),
            wantsProductUpdates: pending.wantsProductUpdates,
            rememberDevice: pending.rememberDevice === true,
          }),
          credentials: 'include',
        })
        if (!res.ok) {
          const errData = await res.json().catch(() => null)
          throw new Error(errData?.detail ?? 'Payment setup failed')
        }
        const data = await res.json()
        const paymentSessionToken = (data.paymentSessionToken as string | null) ?? null
        if (!paymentSessionToken) throw new Error('Payment setup did not return a session token')
        set({
          pendingSignup: {
            ...pending,
            paymentSessionToken,
          },
          isLoading: false,
        })
        return {
          clientSecret: (data.clientSecret as string | null) ?? null,
          cryptoCheckoutUrl: (data.cryptoCheckoutUrl as string | null) ?? null,
          cryptoInvoiceId: (data.cryptoInvoiceId as string | null) ?? null,
          cryptoInvoiceLookupToken: (data.cryptoInvoiceLookupToken as string | null) ?? null,
          paymentSessionToken,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Payment setup failed'
        set({ error: message, isLoading: false })
        throw err
      }
    }

    if (!pending.etebaseAuthToken) {
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
          ...(promoCode?.trim() ? { promoCode: promoCode.trim() } : {}),
          wantsProductUpdates: pending.wantsProductUpdates,
          rememberDevice: pending.rememberDevice === true,
        }),
        credentials: 'include',
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => null)
        throw new Error(errData?.detail ?? 'Provisioning failed')
      }
      const data = await res.json()
      const isAdmin = data.isAdmin === true
      syncAdminCookie(isAdmin, data.rememberDevice === true)
      // Store provisioned data in pendingSignup — do NOT set isAuthenticated yet.
      // The user is still in the signup flow (payment + vault steps remain).
      set({
        pendingSignup: {
          ...pending,
          provisionedUser: { id: data.id, planId, isAdmin },
            provisionedSubscriptionStatus: data.provisioningStatus ?? 'trialing',
          rememberDevice: data.rememberDevice === true,
        },
        isLoading: false,
      })
      return {
        clientSecret: (data.clientSecret as string | null) ?? null,
        cryptoCheckoutUrl: (data.cryptoCheckoutUrl as string | null) ?? null,
        cryptoInvoiceId: (data.cryptoInvoiceId as string | null) ?? null,
        cryptoInvoiceLookupToken: (data.cryptoInvoiceLookupToken as string | null) ?? null,
        paymentSessionToken: null,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Signup failed'
      set({ error: message, isLoading: false })
      throw err
    }
  },

  finalizePaidSignup: async () => {
    const pending = get().pendingSignup
    if (!pending?.etebaseAuthToken || !pending.paymentSessionToken) {
      throw new Error('No completed payment session. Please start signup again.')
    }
    set({ isLoading: true, error: null })
    try {
      const res = await fetch(`${BILLING_API_URL}/auth/signup/finalize-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          etebaseSessionToken: pending.etebaseAuthToken,
          paymentSessionToken: pending.paymentSessionToken,
        }),
        credentials: 'include',
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => null)
        throw new Error(errData?.detail ?? 'Could not finish signup')
      }
      const data = await res.json()
      const isAdmin = data.isAdmin === true
      set({
        pendingSignup: {
          ...pending,
          provisionedUser: { id: data.id, planId: data.planId ?? 'early_annual', isAdmin },
          provisionedSubscriptionStatus: data.provisioningStatus ?? 'active',
          rememberDevice: data.rememberDevice === true,
        },
        isLoading: false,
      })
      return {
        clientSecret: null,
        cryptoCheckoutUrl: null,
        cryptoInvoiceId: null,
        cryptoInvoiceLookupToken: null,
        paymentSessionToken: null,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not finish signup'
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
    syncAdminCookie(pending.provisionedUser.isAdmin, pending.rememberDevice === true)
    if (!isSelfHosted) markHostedValidation(pending.provisionedUser.id, pending.rememberDevice === true)
    set({
      user: {
        id: pending.provisionedUser.id,
        email: pending.email,
        planId: pending.provisionedUser.planId,
        isAdmin: pending.provisionedUser.isAdmin,
        // A brand-new account has no legacy onboarding timestamp yet. The web
        // app no longer uses this field to show a startup modal.
        onboardedAt: null,
      },
      isAuthenticated: true,
      isLoading: false,
      pendingSignup: null,
      subscriptionStatus: pending.provisionedSubscriptionStatus ?? null,
    })
  },

  login: async (email: string, password: string, serverUrl?: string, rememberDevice?: boolean) => {
    set({ isLoading: true, error: null })
    try {
      const { etebaseLogIn } = await import('@/app/lib/etebase-auth')
      const { authToken, savedSession } = await etebaseLogIn(email, password, serverUrl)
      // A successful Etebase login may be an account switch in the same browser
      // profile. The offline queue can contain item UIDs/collection UIDs and,
      // in future encrypted-cache mode, mutation content. Clear it after the
      // credentials are verified but before storing a new Etebase session, so
      // failed login attempts do not destroy the current account's offline work
      // and queued work from one account cannot replay into another account.
      await clearOfflineQueue()
      if (!isSelfHosted && !isCustomServer(serverUrl)) clearHostedValidationMarkers()
      await secureSet('etebase_session', savedSession)
      try {
        const persistedSession = await secureGet('etebase_session')
        createLoginSessionPersistenceDiagnostics({
          etebaseServerUrl: serverUrl ?? ETEBASE_SERVER_URL,
          billingApiUrl: BILLING_API_URL,
          savedSession,
          rereadSession: persistedSession,
        }).persist()
      } catch (diagErr) {
        logger.warn('[auth-store] Session persistence diagnostics failed', getSafeErrorDetails(diagErr))
      }

      if (isSelfHosted || isCustomServer(serverUrl)) {
        if (serverUrl) localStorage.setItem('silentsuite-server-url', serverUrl)
        syncAdminCookie(true)
        set({
          user: { id: 'self-hosted', email, planId: 'self-hosted', isAdmin: true, onboardedAt: null },
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
        body: JSON.stringify({ etebaseSessionToken: authToken, rememberDevice: rememberDevice === true }),
        credentials: 'include',
      })

      if (res.status === 429) {
        await clearLocalAuthMaterial('invalid-hosted-auth')
        set({ isLoading: false, error: AUTH_RATE_LIMIT_MESSAGE }); return
      }
      if (res.status === 404 || res.status === 409) {
        await clearLocalAuthMaterial('invalid-hosted-auth')
        set({ isLoading: false, error: 'Account not fully set up. Please complete signup first.' }); return
      }
      if (!res.ok) {
        await clearLocalAuthMaterial('invalid-hosted-auth')
        set({ isLoading: false, error: 'Login failed. Please check your credentials.' }); return
      }

      const data = await res.json()
      const confirmedRememberDevice = data.rememberDevice === true
      const isAdmin = data.isAdmin === true
      syncAdminCookie(isAdmin, confirmedRememberDevice)
      markHostedValidation(data.id, confirmedRememberDevice)
      set({
        user: { id: data.id, email: data.email ?? email, planId: data.planId ?? 'free', isAdmin, emailVerified: data.emailVerified ?? false, rememberDevice: data.rememberDevice === true, onboardedAt: data.onboardedAt ?? null },
        isAuthenticated: true,
        isLoading: false,
      })
    } catch (err) {
      const message = authErrorMessage(err)
      set({ isLoading: false, error: message })
    }
  },

  unlockEtebaseSession: async (email: string, password: string, serverUrl?: string) => {
    set({ isLoading: true, error: null })
    const currentEmail = get().user?.email
    if (currentEmail && currentEmail.toLowerCase() !== email.toLowerCase()) {
      set({
        isLoading: false,
        error: 'Please unlock this browser with the email address already signed in on this device.',
      })
      return
    }
    try {
      const { etebaseLogIn } = await import('@/app/lib/etebase-auth')
      const { savedSession } = await etebaseLogIn(email, password, serverUrl)
      // This is same-account recovery, not an account switch. Preserve queued
      // offline work while restoring the missing encrypted session blob.
      await secureSet('etebase_session', savedSession)
      set({ isLoading: false })
    } catch (err) {
      const message = authErrorMessage(err)
      set({ isLoading: false, error: message })
    }
  },

  logout: async () => {
    if (!isSelfHosted) {
      await deleteHostedServerSession('invalid-hosted-auth')
    }

    await clearLocalAuthMaterial('logout')

    syncAdminCookie(false)
    set({ user: null, isAuthenticated: false, error: null, subscriptionStatus: null })
  },

  refreshSession: async () => {
    const storedServerUrl = typeof window !== 'undefined' ? localStorage.getItem('silentsuite-server-url') : null
    if (isSelfHosted || isCustomServer(storedServerUrl ?? undefined)) {
      const hasSession = !!(await secureGet('etebase_session'))
      if (hasSession) {
        syncAdminCookie(true)
        set({ user: { id: 'self-hosted', email: '', planId: 'self-hosted', isAdmin: true, onboardedAt: null }, isAuthenticated: true, subscriptionStatus: 'active' })
        return true
      }
      syncAdminCookie(false)
      set({ user: null, isAuthenticated: false })
      return false
    }

    if (typeof window !== 'undefined' && localStorage.getItem(HOSTED_AUTH_INVALIDATED_KEY)) {
      syncAdminCookie(false)
      set({ user: null, isAuthenticated: false, subscriptionStatus: null })
      return false
    }

    try {
      const res = await fetch(`${BILLING_API_URL}/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      // Only treat the session as invalid on explicit auth failures. A 5xx
      // response or network blip would otherwise log out e.g. an unverified
      // user when the verify-banner re-checks on tab focus (see
      // EmailVerificationBanner).
      if (res.status === 401 || res.status === 403) {
        await deleteHostedServerSession('refresh auth failure')
        await clearLocalAuthMaterial('invalid-hosted-auth')
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, subscriptionStatus: null })
        return false
      }
      if (!res.ok) {
        logger.warn('[auth-store] Session refresh got non-OK response, leaving session intact:', res.status)
        return false
      }
      const data = await res.json()
      const rememberDevice = data.rememberDevice === true
      if (!rememberDevice) {
        const marker = readHostedValidationMarker()
        if ((!marker || marker.rememberDevice !== false || marker.userId !== data.id) && !(await hasLiveOtherHostedSessionTab(data.id))) {
          await deleteHostedServerSession('invalid-hosted-auth')
          await clearLocalAuthMaterial('invalid-hosted-auth')
          syncAdminCookie(false)
          set({ user: null, isAuthenticated: false, subscriptionStatus: null })
          return false
        }
      }
      const isAdmin = data.isAdmin === true
      syncAdminCookie(isAdmin, rememberDevice)
      markHostedValidation(data.id, rememberDevice)
      set({ user: { id: data.id, email: data.email ?? '', planId: data.planId ?? 'free', isAdmin, emailVerified: data.emailVerified ?? false, rememberDevice, onboardedAt: data.onboardedAt ?? null }, isAuthenticated: true })
      return true
    } catch (err) {
      logger.warn('[auth-store] Session refresh failed (network), leaving session intact:', err)
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
        set({ user: { id: 'self-hosted', email: '', planId: 'self-hosted', isAdmin: true, onboardedAt: null }, isAuthenticated: true, isLoading: false, subscriptionStatus: 'active' })
      } else {
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, isLoading: false })
      }
      return
    }

    if (typeof window !== 'undefined' && localStorage.getItem(HOSTED_AUTH_INVALIDATED_KEY)) {
      syncAdminCookie(false)
      set({ user: null, isAuthenticated: false, isLoading: false, subscriptionStatus: null })
      return
    }

    set({ isLoading: true })
    try {
      const res = await fetch(`${BILLING_API_URL}/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      if (res.ok) {
        const data = await res.json()
        const rememberDevice = data.rememberDevice === true
        if (!rememberDevice) {
          const marker = readHostedValidationMarker()
          if ((!marker || marker.rememberDevice !== false || marker.userId !== data.id) && !(await hasLiveOtherHostedSessionTab(data.id))) {
            await deleteHostedServerSession('invalid-hosted-auth')
            await clearLocalAuthMaterial('invalid-hosted-auth')
            syncAdminCookie(false)
            set({ user: null, isAuthenticated: false, isLoading: false, subscriptionStatus: null })
            return
          }
        }
        const isAdmin = data.isAdmin === true
        syncAdminCookie(isAdmin, rememberDevice)
        markHostedValidation(data.id, rememberDevice)
        set({ user: { id: data.id, email: data.email ?? '', planId: data.planId ?? 'free', isAdmin, emailVerified: data.emailVerified ?? false, rememberDevice, onboardedAt: data.onboardedAt ?? null }, isAuthenticated: true, isLoading: false })
      } else if (res.status === 401 || res.status === 403) {
        await deleteHostedServerSession('restore auth failure')
        await clearLocalAuthMaterial('invalid-hosted-auth')
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, isLoading: false, subscriptionStatus: null })
      } else if (res.status === 429) {
        const hasEtebaseSession = !!(await secureGet('etebase_session'))
        const marker = readHostedValidationMarker()
        const activeTabMarker = hasEtebaseSession ? readOtherActiveHostedSessionTab() : null
        if (hasEtebaseSession && !marker && !activeTabMarker) await clearLocalAuthMaterial('invalid-hosted-auth')
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, isLoading: false, subscriptionStatus: null })
      } else if (res.status >= 400 && res.status < 500) {
        await deleteHostedServerSession('restore auth failure')
        await clearLocalAuthMaterial('invalid-hosted-auth')
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, isLoading: false, subscriptionStatus: null })
      } else {
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, isLoading: false })
      }
    } catch (err) {
      // Network error — billing API is unreachable.
      logger.warn('[auth-store] Session restore failed (network):', err)
      // If a valid Etebase session exists, enter degraded mode instead of kicking the user out.
      const hasEtebaseSession = !!(await secureGet('etebase_session'))
      const marker = readHostedValidationMarker()
      const activeTabMarker = hasEtebaseSession ? readOtherActiveHostedSessionTab() : null
      if (hasEtebaseSession && marker) {
        // Preserve the legacy onboardedAt metadata shape while billing is down;
        // startup UI no longer depends on this field.
        set({
          user: { id: marker.userId, email: '', planId: 'unknown', isAdmin: false, rememberDevice: marker.rememberDevice, onboardedAt: new Date().toISOString() },
          isAuthenticated: true,
          isLoading: false,
          subscriptionStatus: 'billing_unavailable',
        })
      } else if (hasEtebaseSession && activeTabMarker) {
        set({
          user: { id: activeTabMarker.userId, email: '', planId: 'unknown', isAdmin: false, rememberDevice: false, onboardedAt: new Date().toISOString() },
          isAuthenticated: true,
          isLoading: false,
          subscriptionStatus: 'billing_unavailable',
        })
      } else {
        if (hasEtebaseSession) await clearLocalAuthMaterial('invalid-hosted-auth')
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, isLoading: false, subscriptionStatus: null })
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

    if (typeof window !== 'undefined' && localStorage.getItem(HOSTED_AUTH_INVALIDATED_KEY)) return false

    try {
      // Fetch both endpoints — only apply state if BOTH succeed
      const [refreshRes, subRes] = await Promise.all([
        fetch(`${BILLING_API_URL}/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } }),
        fetch(`${BILLING_API_URL}/subscription`, { credentials: 'include' }),
      ])
      if (refreshRes.status === 401 || refreshRes.status === 403 || (refreshRes.status >= 400 && refreshRes.status < 500 && refreshRes.status !== 429)) {
        await deleteHostedServerSession('retry auth failure')
        await clearLocalAuthMaterial('invalid-hosted-auth')
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, subscriptionStatus: null })
        return false
      }
      if (!refreshRes.ok || !subRes.ok) return false
      const refreshData = await refreshRes.json()
      const subData = await subRes.json()
      const rememberDevice = refreshData.rememberDevice === true
      if (!rememberDevice) {
        const marker = readHostedValidationMarker()
        if ((!marker || marker.rememberDevice !== false || marker.userId !== refreshData.id) && !(await hasLiveOtherHostedSessionTab(refreshData.id))) {
          await deleteHostedServerSession('invalid-hosted-auth')
          await clearLocalAuthMaterial('invalid-hosted-auth')
          syncAdminCookie(false)
          set({ user: null, isAuthenticated: false, subscriptionStatus: null })
          return false
        }
      }
      const isAdmin = refreshData.isAdmin === true
      syncAdminCookie(isAdmin, rememberDevice)
      markHostedValidation(refreshData.id, rememberDevice)
      set({
        user: { id: refreshData.id, email: refreshData.email ?? '', planId: refreshData.planId ?? 'free', isAdmin, emailVerified: refreshData.emailVerified ?? false, rememberDevice, onboardedAt: refreshData.onboardedAt ?? null },
        isAuthenticated: true,
        subscriptionStatus: subData.status,
      })
      return true
    } catch (err) {
      logger.warn('[auth-store] retryBillingConnection failed:', err)
      return false
    }
  },

  markOnboarded: async () => {
    const current = get().user
    if (!current) {
      // Defensive: nothing to update against. Caller should only invoke
      // this from a path that already has an authenticated user, but a
      // race during logout could land us here.
      return false
    }

    // Already onboarded — nothing to do, treat as success for any legacy callers.
    if (current.onboardedAt) return true

    // Self-hosted has no billing API to call. Stamp locally only for legacy
    // callers that still want an onboardedAt timestamp in memory.
    const storedServerUrl = typeof window !== 'undefined' ? localStorage.getItem('silentsuite-server-url') : null
    if (isSelfHosted || isCustomServer(storedServerUrl ?? undefined) || current.id === 'self-hosted') {
      set({ user: { ...current, onboardedAt: new Date().toISOString() } })
      return true
    }

    try {
      const res = await fetch(`${BILLING_API_URL}/account/onboarded`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      })
      if (!res.ok) {
        // Don't update local legacy metadata on failure.
        logger.warn('[auth-store] markOnboarded failed:', res.status)
        return false
      }
      const data = await res.json()
      // Re-read user inside the success path — it may have changed during
      // the await (logout race). Only patch if the same user is still
      // signed in.
      const after = get().user
      if (!after || after.id !== current.id) return false
      set({ user: { ...after, onboardedAt: data.onboardedAt ?? new Date().toISOString() } })
      return true
    } catch (err) {
      logger.warn('[auth-store] markOnboarded network error:', err)
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
      sessionStorage.setItem('silentsuite-signup-redirect-state', JSON.stringify(data))
    } catch (err) {
      logger.warn('[auth-store] Failed to save signup redirect state:', err)
    }
  },

  restoreSignupStateFromRedirect: () => {
    try {
      const raw = sessionStorage.getItem('silentsuite-signup-redirect-state')
      if (!raw) return null
      // Always remove immediately — one-time use
      sessionStorage.removeItem('silentsuite-signup-redirect-state')
      const data = JSON.parse(raw) as RedirectSignupState
      // Basic shape validation — guard against corrupted or tampered storage data
      if (!data.pendingSignup?.email || (!data.pendingSignup?.etebaseAuthToken && !data.pendingSignup?.paymentSessionToken)) {
        logger.warn('[auth-store] Redirect signup state is malformed, discarding')
        return null
      }
      // Reject if older than 2 hours. Bitcoin settlement can outlive the old
      // 10-minute Stripe-only window, but this is still tab-scoped sessionStorage.
      const TWO_HOURS = 2 * 60 * 60 * 1000
      if (Date.now() - data.savedAt > TWO_HOURS) {
        logger.warn('[auth-store] Redirect signup state expired (>2h old)')
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
      sessionStorage.removeItem('silentsuite-signup-redirect-state')
      return null
    }
  },
}))
