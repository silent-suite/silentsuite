/**
 * Hosted login email change (experimental) and the session's server identity.
 *
 * The login name lives on the Etebase server; Billing only keeps a contact
 * address. Re-authentication always uses the saved session's own username,
 * never the Billing contact email, and the session learns a new name only from
 * the server's `whoami`, called with that session's own token.
 */
import { BILLING_API_URL, ETEBASE_SERVER_URL } from '@/app/lib/config'
import { isCustomServer, isSelfHosted } from '@/app/lib/self-hosted'
import { getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import { secureGetSessionWithIdentity, secureRemoveIfEqual, secureSet } from '@/app/lib/secure-storage'
import { isSessionIdentity, type SessionIdentity } from '@/app/lib/session-scope'
import { useAuthStore, type User } from '@/app/stores/use-auth-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'

/** Same canonical form as the rest of the web app's email handling. */
export function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase()
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function storedServerUrl(): string | null | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage.getItem('silentsuite-server-url')
  } catch {
    return undefined
  }
}

/** A signed-in account on the hosted SilentSuite server (never self-hosted or a custom server). */
export function isHostedAccount(user: User | null | undefined): user is User {
  if (isSelfHosted || !user || user.id === 'self-hosted') return false
  const stored = storedServerUrl()
  return stored !== undefined && !isCustomServer(stored ?? undefined)
}

function serverBase(serverUrl: string | null | undefined): string {
  return (serverUrl || ETEBASE_SERVER_URL).replace(/\/+$/, '')
}

/** The server's current identity for `token`, or null (older server, dead token, network). */
async function fetchWhoami(serverUrl: string, token: string): Promise<SessionIdentity | null> {
  try {
    const res = await fetch(`${serverBase(serverUrl)}/api/v1/authentication/whoami/`, {
      headers: { Authorization: 'Token ' + token },
    })
    if (!res.ok) return null
    const body: unknown = await res.json()
    return isSessionIdentity(body) ? { id: body.id, loginVersion: body.loginVersion, username: body.username } : null
  } catch {
    return null
  }
}

/**
 * Which `whoami` answer may be stored for a saved session: the first answer
 * (bootstrap), then only answers for the same account id with a higher login
 * version. Anything else (another id, same or older version) changes nothing.
 */
export function nextSessionIdentity(saved: SessionIdentity | null, answer: SessionIdentity): SessionIdentity | null {
  if (!saved) return answer
  if (answer.id !== saved.id || answer.loginVersion <= saved.loginVersion) return null
  return answer
}

let identitySync: Promise<void> | null = null

/**
 * Ask the server who the saved session belongs to and, when allowed by
 * nextSessionIdentity, store that identity beside the session and patch the
 * session's username. The session is re-saved in the same place with the same
 * owner, and only while it is still the session that was read. One at a time.
 */
export function syncLoginIdentity(): Promise<void> {
  if (!identitySync) {
    identitySync = runIdentitySync().catch(() => undefined).finally(() => { identitySync = null })
  }
  return identitySync
}

async function runIdentitySync(): Promise<void> {
  const user = useAuthStore.getState().user
  if (!isHostedAccount(user)) return
  const epoch = getAccountEpoch()
  const current = () => isCurrentAccountEpoch(epoch) && useAuthStore.getState().user?.id === user.id

  const saved = await secureGetSessionWithIdentity()
  if (!saved || !current()) return
  const core = await import('@silentsuite/core')
  const account = await core.restoreSession(ETEBASE_SERVER_URL, saved.session)
  const token = account.authToken
  if (!token) return
  const answer = await fetchWhoami(account.serverUrl, token)
  if (!answer || !current()) return
  const next = nextSessionIdentity(saved.identity, answer)
  if (!next) return

  account.user.username = next.username
  const updated = await core.saveSession(account)
  // Write only over the exact session that was read; anything newer wins.
  const again = await secureGetSessionWithIdentity()
  if (!again || again.session !== saved.session || !current()) return
  await secureSet('etebase_session', updated, { persist: user.rememberDevice === true, owner: user.id, identity: next })
  if (!current()) {
    await secureRemoveIfEqual('etebase_session', updated)
    return
  }
  const live = useEtebaseStore.getState().account as { authToken?: string | null; user?: { username?: string } } | null
  if (live?.user && live.authToken === token) live.user.username = next.username
}

/** The login name of the saved session (the name the server knows), or null. */
export async function readSavedSessionUsername(): Promise<string | null> {
  const saved = await secureGetSessionWithIdentity()
  if (!saved) return null
  const core = await import('@silentsuite/core')
  const account = await core.restoreSession(ETEBASE_SERVER_URL, saved.session)
  const username = account.user?.username
  return typeof username === 'string' && username ? username : null
}

export type LoginEmailRequestResult =
  | 'sent' | 'rejected' | 'unknown'
  | 'unavailable' | 'invalid-email' | 'same-email' | 'wrong-password'
  | 'rate-limited' | 'account-changed' | 'failed'

function problemCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const { code, type } = body as { code?: unknown; type?: unknown }
  if (typeof code === 'string') return code
  if (typeof type === 'string') return type.split('/').pop() ?? null
  return null
}

/**
 * Request a login email change: a fresh sign-in with the saved session's
 * username and the current password, a server-signed handoff, then Billing
 * sends the confirmation link to the new address. The fresh session is always
 * logged out again.
 */
export async function requestLoginEmailChange(newEmail: string, password: string): Promise<LoginEmailRequestResult> {
  const user = useAuthStore.getState().user
  if (!isHostedAccount(user)) return 'failed'
  const epoch = getAccountEpoch()
  const current = () => isCurrentAccountEpoch(epoch) && useAuthStore.getState().user?.id === user.id
  const email = normalizeLoginEmail(newEmail)
  if (!EMAIL_PATTERN.test(email)) return 'invalid-email'

  const username = await readSavedSessionUsername().catch(() => null)
  if (!username || !current()) return 'failed'
  if (normalizeLoginEmail(username) === email) return 'same-email'

  const core = await import('@silentsuite/core')
  let fresh: Awaited<ReturnType<typeof core.logIn>> | null = null
  try {
    try {
      fresh = await core.logIn(ETEBASE_SERVER_URL, username, password)
    } catch (err) {
      const message = err instanceof Error ? err.message.toLowerCase() : ''
      return message.includes('401') || message.includes('unauthorized') || message.includes('wrong') || message.includes('password')
        ? 'wrong-password'
        : 'failed'
    }
    if (!current()) return 'account-changed'
    const signed = await core.signLoginEmailChange(fresh, email)
    const serverRes = await fetch(`${serverBase(fresh.serverUrl)}/api/v1/billing/login-email/request/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/msgpack', Authorization: 'Token ' + fresh.authToken },
      body: core.encodeLoginEmailChangeRequest(signed) as BodyInit,
    })
    const serverBody: unknown = await serverRes.json().catch(() => null)
    if (!serverRes.ok) {
      const code = problemCode(serverBody)
      if (serverRes.status === 429) return 'rate-limited'
      if (code === 'same_destination') return 'same-email'
      if (code === 'invalid_destination') return 'invalid-email'
      return 'failed'
    }
    const handoff = (serverBody as { handoff?: unknown } | null)?.handoff
    if (typeof handoff !== 'string' || !handoff) return 'failed'
    if (!current()) return 'account-changed'

    const billingRes = await fetch(`${BILLING_API_URL}/account/login-email/request`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ email, handoff }),
    })
    const billingBody: unknown = await billingRes.json().catch(() => null)
    if (billingRes.ok) {
      const status = (billingBody as { status?: unknown } | null)?.status
      return status === 'sent' || status === 'rejected' || status === 'unknown' ? status : 'unknown'
    }
    if (billingRes.status === 429) return 'rate-limited'
    const code = problemCode(billingBody)
    if (code === 'email-change-unavailable') return 'unavailable'
    if (code === 'invalid-email') return 'invalid-email'
    return 'failed'
  } catch {
    return 'failed'
  } finally {
    if (fresh) {
      try {
        await core.logout(fresh)
      } catch {
        // The fresh session is short-lived; a failed logout must not change the outcome.
      }
    }
  }
}

export type LoginEmailConfirmResult =
  | { kind: 'done'; newLogin: string; contactState: string }
  | { kind: 'expired' }
  | { kind: 'refused'; reason: string | null }
  | { kind: 'try-again' }
  | { kind: 'failed' }

/** Confirm with the token from the mailed link. A done result refreshes this tab's session name. */
export async function confirmLoginEmailChange(token: string): Promise<LoginEmailConfirmResult> {
  let res: Response
  try {
    res = await fetch(`${BILLING_API_URL}/account/login-email/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ token }),
    })
  } catch {
    return { kind: 'try-again' }
  }
  const body: unknown = await res.json().catch(() => null)
  if (res.ok) {
    const data = body as { status?: unknown; newLogin?: unknown; contactState?: unknown } | null
    if ((data?.status === 'completed' || data?.status === 'committed') && typeof data.newLogin === 'string') {
      void syncLoginIdentity()
      return { kind: 'done', newLogin: data.newLogin, contactState: typeof data.contactState === 'string' ? data.contactState : 'pending' }
    }
    return { kind: 'failed' }
  }
  if (res.status === 410) return { kind: 'expired' }
  if (res.status === 503) return { kind: 'try-again' }
  if (res.status === 409) {
    const reason = (body as { reason?: unknown } | null)?.reason
    return { kind: 'refused', reason: typeof reason === 'string' ? reason : null }
  }
  return { kind: 'failed' }
}
