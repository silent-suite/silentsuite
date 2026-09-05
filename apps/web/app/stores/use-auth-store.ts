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
import { bumpAccountEpoch } from '@/app/lib/account-epoch'
import { BillingResponseError, startSignupAnnualPayment } from '@/app/lib/billing-v2'

export interface User {
  isAdmin?: boolean
  id: string
  email: string
  planId: string | null
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
  serverUrl?: string
  paymentSessionToken?: string
  /** Non-secret request lineage retained only for payment-session recovery. */
  paymentSessionRequestKey?: string
  paymentMethod?: 'stripe' | 'btcpay'
  earlyAdopter?: boolean
  wantsProductUpdates?: boolean
  rememberDevice?: boolean
  paidSignupAttemptId?: string
  noCardProvisionAttemptId?: string
  /** v1 remains readable only for a persisted historical redirect/retry. */
  billingContractVersion?: 1 | 2
  /** Provisioned user data — stored here until the entire signup flow completes. */
  provisionedUser?: {
    id: string
    planId: string | null
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

/**
 * Full-navigation continuation data. Deliberately allowlisted: redirect
 * storage must never become a second persistence channel for credentials or
 * provider secrets.
 */
type RedirectPendingSignup = Pick<PendingSignup,
  | 'email'
  | 'serverUrl'
  | 'paymentSessionToken'
  | 'paymentSessionRequestKey'
  | 'paymentMethod'
  | 'earlyAdopter'
  | 'wantsProductUpdates'
  | 'rememberDevice'
  | 'billingContractVersion'
  | 'provisionedUser'
  | 'provisionedSubscriptionStatus'
>

/** Shape of the data persisted to sessionStorage for surviving full-page redirects. */
export interface RedirectSignupState {
  pendingSignup: RedirectPendingSignup
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
  /** Historical signature retained for callers; fresh hosted v1 creation rejects. */
  signup: (planId: string, trialPath: string) => Promise<SignupResult>
  provisionAnnualNoCard: (checkoutIntentToken: string) => Promise<void>
  startAnnualSignupPayment: (checkoutIntentToken: string, provider: 'stripe' | 'btcpay', returnUrl: string) => Promise<SignupResult>
  /** Clear only this exact authority after Billing proved it terminal/cancelled. */
  clearPendingSignupPaymentRecovery: (identity: PaidSignupRecoveryRelease) => void
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
   * localStorage. The data is also
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UTC_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/
const REDIRECT_SIGNUP_STATE_KEY = 'silentsuite-signup-redirect-state'
const REDIRECT_SIGNUP_STATE_TTL_MS = 2 * 60 * 60 * 1000

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Keep exactly one authoritative payment-session capability in the redirect
 * snapshot. In particular, never spread `pendingSignup`: future runtime-only
 * fields must not silently become persisted data.
 */
function makeRedirectPendingSignup(pending: PendingSignup): RedirectPendingSignup {
  const redirect: RedirectPendingSignup = { email: pending.email }
  if (typeof pending.serverUrl === 'string') redirect.serverUrl = pending.serverUrl
  if (isNonEmptyString(pending.paymentSessionToken)) redirect.paymentSessionToken = pending.paymentSessionToken
  if (isNonEmptyString(pending.paymentSessionRequestKey)) redirect.paymentSessionRequestKey = pending.paymentSessionRequestKey
  if (pending.paymentMethod === 'stripe' || pending.paymentMethod === 'btcpay') redirect.paymentMethod = pending.paymentMethod
  if (typeof pending.earlyAdopter === 'boolean') redirect.earlyAdopter = pending.earlyAdopter
  if (typeof pending.wantsProductUpdates === 'boolean') redirect.wantsProductUpdates = pending.wantsProductUpdates
  if (typeof pending.rememberDevice === 'boolean') redirect.rememberDevice = pending.rememberDevice
  if (pending.billingContractVersion === 1 || pending.billingContractVersion === 2) redirect.billingContractVersion = pending.billingContractVersion
  const user = pending.provisionedUser
  if (user && isNonEmptyString(user.id) && (typeof user.planId === 'string' || user.planId === null) && typeof user.isAdmin === 'boolean') {
    redirect.provisionedUser = { id: user.id, planId: user.planId, isAdmin: user.isAdmin }
  }
  if (typeof pending.provisionedSubscriptionStatus === 'string') redirect.provisionedSubscriptionStatus = pending.provisionedSubscriptionStatus
  return redirect
}

function parseRedirectPendingSignup(value: unknown): RedirectPendingSignup | null {
  if (!isRecord(value) || !isNonEmptyString(value.email) || !isNonEmptyString(value.paymentSessionToken)) return null
  const redirect: RedirectPendingSignup = { email: value.email, paymentSessionToken: value.paymentSessionToken }
  if (typeof value.serverUrl === 'string') redirect.serverUrl = value.serverUrl
  if (isNonEmptyString(value.paymentSessionRequestKey)) redirect.paymentSessionRequestKey = value.paymentSessionRequestKey
  if (value.paymentMethod === 'stripe' || value.paymentMethod === 'btcpay') redirect.paymentMethod = value.paymentMethod
  if (typeof value.earlyAdopter === 'boolean') redirect.earlyAdopter = value.earlyAdopter
  if (typeof value.wantsProductUpdates === 'boolean') redirect.wantsProductUpdates = value.wantsProductUpdates
  if (typeof value.rememberDevice === 'boolean') redirect.rememberDevice = value.rememberDevice
  if (value.billingContractVersion === 1 || value.billingContractVersion === 2) redirect.billingContractVersion = value.billingContractVersion
  const user = value.provisionedUser
  if (isRecord(user) && isNonEmptyString(user.id) && (typeof user.planId === 'string' || user.planId === null) && typeof user.isAdmin === 'boolean') {
    redirect.provisionedUser = { id: user.id, planId: user.planId, isAdmin: user.isAdmin }
  }
  if (typeof value.provisionedSubscriptionStatus === 'string') redirect.provisionedSubscriptionStatus = value.provisionedSubscriptionStatus
  return redirect
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && UTC_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value))
}

function isExactNoCardProvision(value: unknown, email: string): value is {
  contractVersion: 2
  id: string
  email: string
  provisioningStatus: 'trialing_no_card'
  emailVerified: true
  earlyAdopter: boolean
  rememberDevice: boolean
  clientSecret: null
  cryptoCheckoutUrl: null
  cryptoInvoiceId: null
  cryptoInvoiceLookupToken: null
  createdAt: string
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const data = value as Record<string, unknown>
  const expected = ['clientSecret', 'contractVersion', 'createdAt', 'cryptoCheckoutUrl', 'cryptoInvoiceId', 'cryptoInvoiceLookupToken', 'earlyAdopter', 'email', 'emailVerified', 'id', 'provisioningStatus', 'rememberDevice']
  const keys = Object.keys(data).sort()
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && data.contractVersion === 2
    && typeof data.id === 'string' && UUID.test(data.id)
    && data.email === email
    && data.provisioningStatus === 'trialing_no_card'
    && data.emailVerified === true
    && typeof data.earlyAdopter === 'boolean'
    && typeof data.rememberDevice === 'boolean'
    && data.clientSecret === null
    && data.cryptoCheckoutUrl === null
    && data.cryptoInvoiceId === null
    && data.cryptoInvoiceLookupToken === null
    && isUtcTimestamp(data.createdAt)
}

function isExactV2PaidFinalization(value: unknown, email: string): value is {
  contractVersion: 2
  id: string
  email: string
  planId: 'early_annual' | 'standard_annual'
  provisioningStatus: string
  emailVerified: true
  isAdmin: boolean
  earlyAdopter: boolean
  rememberDevice: boolean
  createdAt: string
  clientSecret: null
  cryptoCheckoutUrl: null
  cryptoInvoiceId: null
  cryptoInvoiceLookupToken: null
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const data = value as Record<string, unknown>
  const expected = ['clientSecret', 'contractVersion', 'createdAt', 'cryptoCheckoutUrl', 'cryptoInvoiceId', 'cryptoInvoiceLookupToken', 'earlyAdopter', 'email', 'emailVerified', 'id', 'isAdmin', 'planId', 'provisioningStatus', 'rememberDevice']
  const keys = Object.keys(data).sort()
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && data.contractVersion === 2
    && typeof data.id === 'string' && UUID.test(data.id)
    && data.email === email
    && (data.planId === 'early_annual' || data.planId === 'standard_annual')
    && typeof data.provisioningStatus === 'string'
    && data.emailVerified === true
    && typeof data.isAdmin === 'boolean'
    && typeof data.earlyAdopter === 'boolean'
    && typeof data.rememberDevice === 'boolean'
    && isUtcTimestamp(data.createdAt)
    && data.clientSecret === null
    && data.cryptoCheckoutUrl === null
    && data.cryptoInvoiceId === null
    && data.cryptoInvoiceLookupToken === null
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

const PAID_SIGNUP_RECOVERY_KEY = 'silentsuite-paid-signup-recovery'
const RECOVERY_SECRET_BYTES = 32

interface PaidSignupRecoveryIdentity {
  scope: string
  requestKey: string
  recoverySecret: string
}

/**
 * A closed anonymous recovery response is proof for exactly one capability.
 * Carry all of its bindings into the store so a stale tab can never erase a
 * same-email replacement that has since been created.
 */
interface PaidSignupRecoveryRelease {
  email: string
  requestKey: string
  recoverySecret: string
  wantsProductUpdates?: boolean
  rememberDevice?: boolean
}

interface PaidSignupRecoveryRegistry {
  version: 1
  identities: Record<string, PaidSignupRecoveryIdentity>
}

let inMemoryPaidSignupRecoveryRegistry: PaidSignupRecoveryRegistry = { version: 1, identities: {} }
let paidSignupStorageWriteUnavailable = false

function paidSignupRecoveryScope(
  email: string,
  wantsProductUpdates?: boolean,
  rememberDevice?: boolean,
): string {
  return JSON.stringify({
    email: email.trim().toLowerCase(),
    contractVersion: 2,
    wantsProductUpdates: wantsProductUpdates !== false,
    rememberDevice: rememberDevice === true,
  })
}

function isPaidSignupRecoveryIdentity(
  value: unknown,
  scope: string,
): value is PaidSignupRecoveryIdentity {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PaidSignupRecoveryIdentity>
  return candidate.scope === scope
    && typeof candidate.requestKey === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.requestKey)
    && typeof candidate.recoverySecret === 'string'
    && /^[A-Za-z0-9_-]{43}$/.test(candidate.recoverySecret)
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function readPaidSignupRecoveryRegistry(): PaidSignupRecoveryRegistry {
  if (typeof window === 'undefined') return inMemoryPaidSignupRecoveryRegistry
  try {
    const raw = sessionStorage.getItem(PAID_SIGNUP_RECOVERY_KEY)
    if (!raw) {
      if (paidSignupStorageWriteUnavailable) return inMemoryPaidSignupRecoveryRegistry
      inMemoryPaidSignupRecoveryRegistry = { version: 1, identities: {} }
      return inMemoryPaidSignupRecoveryRegistry
    }
    // A failed write means persisted data may be stale in either direction:
    // it may lack a newly created capability or retain one that was cleared.
    // The complete desired in-memory registry is authoritative until a later
    // write succeeds.
    if (paidSignupStorageWriteUnavailable) return inMemoryPaidSignupRecoveryRegistry
    const parsed = JSON.parse(raw) as Partial<PaidSignupRecoveryRegistry>
    if (parsed.version !== 1 || !parsed.identities || typeof parsed.identities !== 'object') {
      sessionStorage.removeItem(PAID_SIGNUP_RECOVERY_KEY)
      return { version: 1, identities: {} }
    }
    const persistedIdentities = Object.fromEntries(
      Object.entries(parsed.identities).filter(([scope, identity]) => isPaidSignupRecoveryIdentity(identity, scope)),
    )
    const identities = persistedIdentities
    return { version: 1, identities }
  } catch {
    return inMemoryPaidSignupRecoveryRegistry
  }
}

function writePaidSignupRecoveryRegistry(registry: PaidSignupRecoveryRegistry) {
  inMemoryPaidSignupRecoveryRegistry = registry
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(registry.identities).length === 0) {
      sessionStorage.removeItem(PAID_SIGNUP_RECOVERY_KEY)
    } else {
      sessionStorage.setItem(PAID_SIGNUP_RECOVERY_KEY, JSON.stringify(registry))
    }
    paidSignupStorageWriteUnavailable = false
  } catch {
    paidSignupStorageWriteUnavailable = true
    // The in-memory registry still coordinates retries during this page load.
  }
}

function getOrCreatePaidSignupRecoveryIdentity(scope: string): PaidSignupRecoveryIdentity {
  const registry = readPaidSignupRecoveryRegistry()
  const stored = registry.identities[scope]
  if (isPaidSignupRecoveryIdentity(stored, scope)) return stored

  const randomBytes = new Uint8Array(RECOVERY_SECRET_BYTES)
  crypto.getRandomValues(randomBytes)
  const identity: PaidSignupRecoveryIdentity = {
    scope,
    requestKey: crypto.randomUUID(),
    recoverySecret: encodeBase64Url(randomBytes),
  }
  registry.identities[scope] = identity
  // Capabilities survive same-tab reloads and scope changes after response
  // loss, but never receive localStorage's cross-tab or long-lived persistence.
  writePaidSignupRecoveryRegistry(registry)
  return identity
}

function releaseExactPaidSignupRecoveryIdentity(release: PaidSignupRecoveryRelease): boolean {
  const scope = paidSignupRecoveryScope(release.email, release.wantsProductUpdates, release.rememberDevice)
  if (!isPaidSignupRecoveryIdentity({ scope, requestKey: release.requestKey, recoverySecret: release.recoverySecret }, scope)) {
    return false
  }
  const registry = readPaidSignupRecoveryRegistry()
  const stored = registry.identities[scope]
  // Absence is safe to release: the caller still holds the same visible
  // capability. A different valid identity means a newer checkout has won.
  if (stored && (stored.requestKey !== release.requestKey || stored.recoverySecret !== release.recoverySecret)) return false
  if (stored) {
    delete registry.identities[scope]
    writePaidSignupRecoveryRegistry(registry)
  }
  return true
}

function clearPaidSignupRecoveryIdentity(expectedRequestKey?: string) {
  if (!expectedRequestKey) {
    writePaidSignupRecoveryRegistry({ version: 1, identities: {} })
    return
  }
  const registry = readPaidSignupRecoveryRegistry()
  for (const [scope, identity] of Object.entries(registry.identities)) {
    if (identity.requestKey === expectedRequestKey) delete registry.identities[scope]
  }
  writePaidSignupRecoveryRegistry(registry)
}

const DEFINITIVE_PAID_SIGNUP_CONFLICTS = new Set([
  'account-exists',
  'payment-intent-conflict',
  'payment-already-confirmed',
])

function paidSignupProblemCode(problem: unknown): string | null {
  if (!problem || typeof problem !== 'object') return null
  const candidate = problem as { code?: unknown, type?: unknown }
  if (typeof candidate.code === 'string') return candidate.code
  if (typeof candidate.type !== 'string') return null
  return candidate.type.split('/').filter(Boolean).at(-1) ?? null
}

function isDefinitivePaidSignupFailure(status: number, problem: unknown): boolean {
  if (status === 408 || status === 429 || status >= 500) return false
  if (status === 409) {
    const code = paidSignupProblemCode(problem)
    return code !== null && DEFINITIVE_PAID_SIGNUP_CONFLICTS.has(code)
  }
  return status >= 400 && status < 500
}

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

async function resetInMemoryAccountState(reason: 'login' | 'logout' | 'invalid-hosted-auth') {
  // Invalidate every account-scoped async publisher before clearing snapshots.
  bumpAccountEpoch()
  try {
    const [
      { useCalendarStore },
      { useTaskStore },
      { useContactStore },
      { useCalendarListStore },
      { useTaskListStore },
      { useContactListStore },
      { useNoteStore },
      { useNotebookStore },
      { useLabelSuggestionsStore },
      { useLabelColorStore },
      { usePreferencesStore },
      { usePreferencesSyncStore },
      { useEtebaseStore },
    ] = await Promise.all([
      import('@/app/stores/use-calendar-store'),
      import('@/app/stores/use-task-store'),
      import('@/app/stores/use-contact-store'),
      import('@/app/stores/use-calendar-list-store'),
      import('@/app/stores/use-task-list-store'),
      import('@/app/stores/use-contact-list-store'),
      import('@/app/stores/use-note-store'),
      import('@/app/stores/use-notebook-store'),
      import('@/app/stores/use-label-suggestions-store'),
      import('@/app/stores/use-label-color-store'),
      import('@/app/stores/use-preferences-store'),
      import('@/app/stores/use-preferences-sync-store'),
      import('@/app/stores/use-etebase-store'),
    ])

    useEtebaseStore.getState().destroy()
    useCalendarStore.setState({
      events: [],
      isLoading: false,
      syncStatus: 'synced',
      selectedEventId: null,
      searchQuery: '',
    })
    useTaskStore.setState({ tasks: [], isLoading: false, syncStatus: 'synced' })
    useContactStore.setState({ contacts: [], isLoading: false, syncStatus: 'synced', searchQuery: '' })
    useNoteStore.setState({ notes: [], isLoading: false, syncStatus: 'synced' })
    useCalendarListStore.setState({
      calendars: [{ id: 'default', name: 'Personal', color: '#10b981', visible: true }],
      defaultCalendarId: 'default',
    })
    useTaskListStore.setState({
      lists: [{ id: 'default', name: 'My Tasks', color: '#3b82f6', visible: true }],
      activeListId: 'all',
    })
    useContactListStore.setState({
      lists: [{ id: 'default', name: 'My Contacts', color: '#8b5cf6', visible: true }],
      activeListId: 'all',
    })
    useNotebookStore.setState({
      lists: [{ id: 'default', name: 'Personal Notes', color: '#f59e0b', visible: true }],
      activeListId: 'all',
    })
    useLabelSuggestionsStore.getState().reset()
    useLabelColorStore.setState({ colors: {} })
    usePreferencesSyncStore.getState().destroy()
    usePreferencesStore.getState().resetSyncedPreferences()
  } catch (err) {
    logger.error(`[auth-store] Failed to reset decrypted account state during ${reason}:`, err)
    throw err
  }
}

async function clearLocalAuthMaterial(reason: 'logout' | 'invalid-hosted-auth') {
  // Clear decrypted account-scoped state before persistent cleanup. This is
  // required even when the next account's restore is only partially successful.
  // Continue clearing persistent credentials if a store module fails to load;
  // callers keep the protected UI unauthenticated in that failure mode.
  try {
    await resetInMemoryAccountState(reason)
  } catch {
    // resetInMemoryAccountState already emitted a reason-scoped error.
  }

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

  clearPaidSignupRecoveryIdentity()
  if (typeof window !== 'undefined') {
    for (const key of ['silentsuite-signup-in-progress', 'silentsuite-signup-redirect-state']) {
      try {
        sessionStorage.removeItem(key)
      } catch {
        // Recovery capability clearing above remains authoritative in memory.
      }
    }
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
  localStorage.removeItem('silentsuite-calendar-lists')
  localStorage.removeItem('silentsuite-task-lists')
  localStorage.removeItem('silentsuite-contact-lists')
  localStorage.removeItem('silentsuite-label-colors')
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
        billingContractVersion: undefined,
        paymentSessionToken: undefined,
        paymentMethod: undefined,
        paidSignupAttemptId: undefined,
        provisionedUser: undefined,
        provisionedSubscriptionStatus: undefined,
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
      const { savedSession } = authResult
      if (!isSelfHosted && !isCustomServer(serverUrl)) clearHostedValidationMarkers()
      await secureSet('etebase_session', savedSession)
      if (isCustomServer(serverUrl) && serverUrl) {
        localStorage.setItem('silentsuite-server-url', serverUrl)
      }

      // Mark signup as in progress so restoreSession won't authenticate mid-flow
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('silentsuite-signup-in-progress', 'true')
      }

      const pending = get().pendingSignup
      const reusablePending = pending?.email.toLowerCase() === email.toLowerCase() ? pending : null
      set({
        // Hosted annual-v2 eligibility is server-authoritative and is returned only
        // by the closed provision/finalization responses. Do not infer it locally.
        pendingSignup: { ...(reusablePending ?? {}), email, serverUrl },
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

  provisionAnnualNoCard: async (checkoutIntentToken: string) => {
    const pending = get().pendingSignup
    if (!pending || isSelfHosted || isCustomServer(pending.serverUrl)) throw new Error('No hosted annual signup is ready to provision.')
    const savedEtebaseSession = await secureGet('etebase_session')
    if (!savedEtebaseSession) throw new Error('Create your account before starting the no-card trial.')
    const attemptId = crypto.randomUUID()
    set({ pendingSignup: { ...pending, noCardProvisionAttemptId: attemptId }, isLoading: true, error: null })
    try {
      const { issueBillingLinkProof } = await import('@/app/lib/etebase-auth')
      const etebaseLinkProof = await issueBillingLinkProof(savedEtebaseSession)
      const response = await fetch(`${BILLING_API_URL}/auth/provision/v2`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ contractVersion: 2, checkoutIntentToken, etebaseLinkProof, wantsProductUpdates: pending.wantsProductUpdates !== false, rememberDevice: pending.rememberDevice === true }) })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new BillingResponseError(
        typeof (data as { detail?: unknown } | null)?.detail === 'string' ? (data as { detail: string }).detail : 'Billing did not confirm the no-card annual trial.',
        response.status,
        typeof (data as { type?: unknown } | null)?.type === 'string' ? (data as { type: string }).type : null,
      )
      if (!isExactNoCardProvision(data, pending.email)) throw new Error('Billing did not confirm the no-card annual trial.')
      const current = get().pendingSignup
      if (!current || current.noCardProvisionAttemptId !== attemptId || current.email.trim().toLowerCase() !== pending.email.trim().toLowerCase()) throw new Error('Signup was superseded.')
      syncAdminCookie(false, data.rememberDevice)
      set({ pendingSignup: { ...current, noCardProvisionAttemptId: undefined, billingContractVersion: 2, earlyAdopter: data.earlyAdopter, provisionedUser: { id: data.id, planId: null, isAdmin: false }, provisionedSubscriptionStatus: data.provisioningStatus, rememberDevice: data.rememberDevice }, isLoading: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not start the no-card annual trial.'
      if (get().pendingSignup?.noCardProvisionAttemptId === attemptId) set({ error: message, isLoading: false }); throw err
    }
  },

  startAnnualSignupPayment: async (checkoutIntentToken: string, provider: 'stripe' | 'btcpay', returnUrl: string) => {
    const pending = get().pendingSignup
    if (!pending || isSelfHosted || isCustomServer(pending.serverUrl)) throw new Error('No hosted annual checkout is ready.')
    const recoveryScope = paidSignupRecoveryScope(pending.email, pending.wantsProductUpdates, pending.rememberDevice)
    const recovery = getOrCreatePaidSignupRecoveryIdentity(recoveryScope)
    const attemptId = crypto.randomUUID()
    set({ pendingSignup: { ...pending, paidSignupAttemptId: attemptId }, isLoading: true, error: null })
    try {
      const parsedReturnUrl = new URL(returnUrl, window.location.origin)
      if (parsedReturnUrl.origin !== window.location.origin) throw new Error('Annual signup return URL must stay on this origin.')
      const absoluteReturnUrl = parsedReturnUrl.toString()
      const payment = await startSignupAnnualPayment({ fetcher: fetch, billingApiUrl: BILLING_API_URL, checkoutIntentToken, email: pending.email, requestKey: recovery.requestKey, recoverySecret: recovery.recoverySecret, wantsProductUpdates: pending.wantsProductUpdates !== false, rememberDevice: pending.rememberDevice === true, returnUrl: absoluteReturnUrl })
      if (payment.kind !== provider) throw new Error('Billing returned the wrong payment provider.')
      const current = get().pendingSignup
      if (!current || current.paidSignupAttemptId !== attemptId || paidSignupRecoveryScope(current.email, current.wantsProductUpdates, current.rememberDevice) !== recoveryScope) throw new Error('Signup was superseded.')
      set({
        pendingSignup: {
          ...current,
          billingContractVersion: 2,
          paymentSessionToken: payment.paymentSessionToken,
          paymentSessionRequestKey: recovery.requestKey,
          paymentMethod: payment.kind,
          paidSignupAttemptId: undefined,
        },
        isLoading: false,
      })
      return { clientSecret: payment.kind === 'stripe' ? payment.clientSecret : null, cryptoCheckoutUrl: payment.kind === 'btcpay' ? payment.cryptoCheckoutUrl : null, cryptoInvoiceId: payment.kind === 'btcpay' ? payment.cryptoInvoiceId : null, cryptoInvoiceLookupToken: payment.kind === 'btcpay' ? payment.cryptoInvoiceLookupToken : null, paymentSessionToken: payment.paymentSessionToken }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not start annual payment.'
      if (get().pendingSignup?.paidSignupAttemptId === attemptId) set({ error: message, isLoading: false }); throw err
    }
  },

  clearPendingSignupPaymentRecovery: (release) => {
    const pending = get().pendingSignup
    if (!pending) return
    // A terminal response must be bound to the currently visible recovery
    // capability before either storage or UI state is released. This compare
    // guards stale/reloaded tabs and async recovery races from deleting a
    // replacement invoice for the same email scope.
    if (pending.email.trim().toLowerCase() !== release.email.trim().toLowerCase()
      || pending.paymentSessionRequestKey !== release.requestKey
      || pending.paymentSessionToken !== release.recoverySecret) return
    const exactRelease: PaidSignupRecoveryRelease = {
      ...release,
      wantsProductUpdates: release.wantsProductUpdates ?? pending.wantsProductUpdates,
      rememberDevice: release.rememberDevice ?? pending.rememberDevice,
    }
    if (!releaseExactPaidSignupRecoveryIdentity(exactRelease)) return
    set({
      pendingSignup: {
        ...pending,
        paymentSessionToken: undefined,
        paymentSessionRequestKey: undefined,
        paymentMethod: undefined,
        paidSignupAttemptId: undefined,
      },
    })
  },

  signup: async (planId: string, trialPath: string) => {
    const pending = get().pendingSignup
    if (!pending) throw new Error('No pending signup')
    const isLocalServerSignup = isSelfHosted || isCustomServer(pending.serverUrl) || planId === 'self-hosted'
    if (isLocalServerSignup) {

      // Self-hosted: if user opted in, subscribe to newsletter on the SilentSuite API
      if (isSelfHosted && pending.wantsProductUpdates) {
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

    throw new Error('Hosted signup requires a fresh annual offer and checkout authority.')
  },

  finalizePaidSignup: async () => {
    const pending = get().pendingSignup
    if (isCustomServer(pending?.serverUrl)) {
      throw new Error('Paid signup is not available for custom servers.')
    }
    const savedEtebaseSession = await secureGet('etebase_session')
    if (!pending || !savedEtebaseSession || !pending.paymentSessionToken) {
      throw new Error('No completed payment session. Please start signup again.')
    }
    const expectedPaymentSessionToken = pending.paymentSessionToken
    const expectedRequestKey = pending.paymentSessionRequestKey
    const attemptId = crypto.randomUUID()
    set({ pendingSignup: { ...pending, paidSignupAttemptId: attemptId }, isLoading: true, error: null })
    try {
      const { issueBillingLinkProof } = await import('@/app/lib/etebase-auth')
      const etebaseLinkProof = await issueBillingLinkProof(savedEtebaseSession)
      const v2 = pending.billingContractVersion === 2
      const res = await fetch(`${BILLING_API_URL}${v2 ? '/auth/signup/finalize-payment/v2' : '/auth/signup/finalize-payment'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(v2 ? { contractVersion: 2, etebaseLinkProof, paymentSessionToken: pending.paymentSessionToken } : { etebaseLinkProof, paymentSessionToken: pending.paymentSessionToken }),
        credentials: 'include',
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => null)
        throw new Error(errData?.detail ?? 'Could not finish signup')
      }
      const data: unknown = await res.json().catch(() => null)
      if (v2 && !isExactV2PaidFinalization(data, pending.email)) throw new Error('Billing did not confirm an annual signup.')
      if (!data || typeof data !== 'object') throw new Error('Billing did not return signup completion.')
      const completion = data as {
        id?: unknown
        planId?: unknown
        isAdmin?: unknown
        earlyAdopter?: unknown
        provisioningStatus?: unknown
        rememberDevice?: unknown
      }
      const isAdmin = completion.isAdmin === true
      const current = get().pendingSignup
      if (!current || current.paidSignupAttemptId !== attemptId || current.paymentSessionToken !== expectedPaymentSessionToken || current.paymentSessionRequestKey !== expectedRequestKey) throw new Error('Signup was superseded.')
      set({
        pendingSignup: {
          ...current,
          paidSignupAttemptId: undefined,
          provisionedUser: { id: typeof completion.id === 'string' ? completion.id : '', planId: typeof completion.planId === 'string' ? completion.planId : null, isAdmin },
          provisionedSubscriptionStatus: typeof completion.provisioningStatus === 'string' ? completion.provisioningStatus : 'active',
          earlyAdopter: completion.earlyAdopter === true,
          rememberDevice: completion.rememberDevice === true,
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
      if (get().pendingSignup?.paidSignupAttemptId === attemptId) set({ error: message, isLoading: false })
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
    clearPaidSignupRecoveryIdentity()
    if (typeof window !== 'undefined') {
      try {
        sessionStorage.removeItem('silentsuite-signup-in-progress')
      } catch {
        // Signup completion must not be interrupted by unavailable tab storage.
      }
    }
    // Sync admin cookie so middleware allows /admin access
    syncAdminCookie(pending.provisionedUser.isAdmin, pending.rememberDevice === true)
    if (!isSelfHosted && !isCustomServer(pending.serverUrl)) {
      markHostedValidation(pending.provisionedUser.id, pending.rememberDevice === true)
    }
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
      const { savedSession } = await etebaseLogIn(email, password, serverUrl)
      // A successful Etebase login may be an account switch in the same browser
      // profile. The offline queue can contain item UIDs/collection UIDs and,
      // in future encrypted-cache mode, mutation content. Clear it after the
      // credentials are verified but before storing a new Etebase session, so
      // failed login attempts do not destroy the current account's offline work
      // and queued work from one account cannot replay into another account.
      // Reset all decrypted account-scoped stores at the same verified account
      // boundary so a partial restore cannot retain the prior account's data.
      await resetInMemoryAccountState('login')
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

      const { issueBillingLinkProof } = await import('@/app/lib/etebase-auth')
      const etebaseLinkProof = await issueBillingLinkProof(savedSession, serverUrl)
      const res = await fetch(`${BILLING_API_URL}/auth/token-exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ etebaseLinkProof, rememberDevice: rememberDevice === true }),
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
    // Stop rendering protected account data before any network request or
    // asynchronous storage cleanup can yield.
    syncAdminCookie(false)
    set({ user: null, isAuthenticated: false, error: null, subscriptionStatus: null })

    if (!isSelfHosted) {
      await deleteHostedServerSession('invalid-hosted-auth')
    }

    await clearLocalAuthMaterial('logout')
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
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, subscriptionStatus: null })
        await deleteHostedServerSession('refresh auth failure')
        await clearLocalAuthMaterial('invalid-hosted-auth')
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
          syncAdminCookie(false)
          set({ user: null, isAuthenticated: false, subscriptionStatus: null })
          await deleteHostedServerSession('invalid-hosted-auth')
          await clearLocalAuthMaterial('invalid-hosted-auth')
          return false
        }
      }
      const isAdmin = data.isAdmin === true
      if (get().user?.id !== data.id) await resetInMemoryAccountState('login')
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
            syncAdminCookie(false)
            set({ user: null, isAuthenticated: false, isLoading: false, subscriptionStatus: null })
            await deleteHostedServerSession('invalid-hosted-auth')
            await clearLocalAuthMaterial('invalid-hosted-auth')
            return
          }
        }
        const isAdmin = data.isAdmin === true
        if (get().user?.id !== data.id) await resetInMemoryAccountState('login')
        syncAdminCookie(isAdmin, rememberDevice)
        markHostedValidation(data.id, rememberDevice)
        set({ user: { id: data.id, email: data.email ?? '', planId: data.planId ?? 'free', isAdmin, emailVerified: data.emailVerified ?? false, rememberDevice, onboardedAt: data.onboardedAt ?? null }, isAuthenticated: true, isLoading: false })
      } else if (res.status === 401 || res.status === 403) {
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, isLoading: false, subscriptionStatus: null })
        await deleteHostedServerSession('restore auth failure')
        await clearLocalAuthMaterial('invalid-hosted-auth')
      } else if (res.status === 429) {
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, isLoading: false, subscriptionStatus: null })
        const hasEtebaseSession = !!(await secureGet('etebase_session'))
        const marker = readHostedValidationMarker()
        const activeTabMarker = hasEtebaseSession ? readOtherActiveHostedSessionTab() : null
        if (hasEtebaseSession && !marker && !activeTabMarker) await clearLocalAuthMaterial('invalid-hosted-auth')
      } else if (res.status >= 400 && res.status < 500) {
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, isLoading: false, subscriptionStatus: null })
        await deleteHostedServerSession('restore auth failure')
        await clearLocalAuthMaterial('invalid-hosted-auth')
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
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, isLoading: false, subscriptionStatus: null })
        if (hasEtebaseSession) await clearLocalAuthMaterial('invalid-hosted-auth')
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
        syncAdminCookie(false)
        set({ user: null, isAuthenticated: false, subscriptionStatus: null })
        await deleteHostedServerSession('retry auth failure')
        await clearLocalAuthMaterial('invalid-hosted-auth')
        return false
      }
      if (!refreshRes.ok || !subRes.ok) return false
      const refreshData = await refreshRes.json()
      const subData = await subRes.json()
      const rememberDevice = refreshData.rememberDevice === true
      if (!rememberDevice) {
        const marker = readHostedValidationMarker()
        if ((!marker || marker.rememberDevice !== false || marker.userId !== refreshData.id) && !(await hasLiveOtherHostedSessionTab(refreshData.id))) {
          syncAdminCookie(false)
          set({ user: null, isAuthenticated: false, subscriptionStatus: null })
          await deleteHostedServerSession('invalid-hosted-auth')
          await clearLocalAuthMaterial('invalid-hosted-auth')
          return false
        }
      }
      const isAdmin = refreshData.isAdmin === true
      if (get().user?.id !== refreshData.id) await resetInMemoryAccountState('login')
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
      pendingSignup: makeRedirectPendingSignup(pending),
      selectedInterval,
      savedAt: Date.now(),
    }
    try {
      sessionStorage.setItem(REDIRECT_SIGNUP_STATE_KEY, JSON.stringify(data))
    } catch (err) {
      logger.warn('[auth-store] Failed to save signup redirect state:', err)
    }
  },

  restoreSignupStateFromRedirect: () => {
    try {
      const raw = sessionStorage.getItem(REDIRECT_SIGNUP_STATE_KEY)
      if (!raw) return null
      // Always remove immediately — one-time use
      sessionStorage.removeItem(REDIRECT_SIGNUP_STATE_KEY)
      const value = JSON.parse(raw) as unknown
      if (!isRecord(value) || (value.selectedInterval !== 'monthly' && value.selectedInterval !== 'annual') || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) {
        logger.warn('[auth-store] Redirect signup state is malformed, discarding')
        return null
      }
      const pendingSignup = parseRedirectPendingSignup(value.pendingSignup)
      if (!pendingSignup) {
        logger.warn('[auth-store] Redirect signup state is malformed, discarding')
        return null
      }
      // Reject if older than 2 hours. Bitcoin settlement can outlive the old
      // 10-minute Stripe-only window, but this is still tab-scoped sessionStorage.
      if (Date.now() - value.savedAt >= REDIRECT_SIGNUP_STATE_TTL_MS) {
        logger.warn('[auth-store] Redirect signup state expired (>2h old)')
        return null
      }
      const data: RedirectSignupState = {
        pendingSignup,
        selectedInterval: value.selectedInterval,
        savedAt: value.savedAt,
      }
      // Restore pendingSignup into the Zustand store and re-set the signup-in-progress
      // flag so restoreSession() doesn't run concurrently and clobber the restored state.
      set({ pendingSignup })
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('silentsuite-signup-in-progress', 'true')
      }
      return data
    } catch (err) {
      logger.warn('[auth-store] Failed to restore signup redirect state:', err)
      sessionStorage.removeItem(REDIRECT_SIGNUP_STATE_KEY)
      return null
    }
  },
}))
