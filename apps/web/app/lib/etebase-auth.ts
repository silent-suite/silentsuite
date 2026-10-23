import { ETEBASE_SERVER_URL } from '@/app/lib/config'

interface EtebaseAuthResult {
  authToken: string
  savedSession: string
}

/** Mint immediately before a Billing request. The proof is never persisted. */
export async function issueBillingLinkProof(savedSession: string, serverUrl?: string): Promise<string> {
  const { restoreSession } = await import('@silentsuite/core')
  const account = await restoreSession(serverUrl || ETEBASE_SERVER_URL, savedSession)
  const authToken = (account as any).authToken as string
  const endpoint = `${(serverUrl || ETEBASE_SERVER_URL).replace(/\/$/, '')}/api/v1/billing/link-proof/`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST', headers: { Authorization: 'Token ' + authToken },
      })
    } catch {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        continue
      }
      throw new Error('Could not establish billing identity')
    }
    if (response.status === 429 && attempt === 0) {
      const requestedDelay = Number.parseInt(response.headers.get('Retry-After') ?? '1', 10)
      const retrySeconds = Number.isFinite(requestedDelay) ? Math.min(Math.max(requestedDelay, 1), 2) : 1
      await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1_000))
      continue
    }
    if (!response.ok) throw new Error('Could not establish billing identity')
    const value = await response.json() as { etebaseLinkProof?: unknown }
    if (typeof value.etebaseLinkProof !== 'string') throw new Error('Could not establish billing identity')
    return value.etebaseLinkProof
  }
  throw new Error('Could not establish billing identity')
}

/** Operation-only installation-owner credentials. Never stored. */
export interface OwnerSignupOptions {
  ownerPassword: string
  signal: AbortSignal
}

const OWNER_AUTH_MESSAGES = {
  rejected: 'The installation password was not accepted.',
  unavailable: 'Installation sign-in is unavailable. Try again.',
  unsupported: 'Installation password sign-up only works on this device\'s own SilentSuite address.',
} as const

/** Installation-owner authorization failure. Fixed messages; never echoes input or server text. */
export class OwnerAuthError extends Error {
  constructor(reason: keyof typeof OWNER_AUTH_MESSAGES) {
    super(OWNER_AUTH_MESSAGES[reason])
    this.name = 'OwnerAuthError'
  }
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
const MAX_GRANT_LENGTH = 512

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Signup was cancelled.', 'AbortError')
}

/** The browser's own origin, when it may carry owner credentials (HTTPS or exact http loopback). */
function ownerOrigin(): string {
  if (typeof window === 'undefined') throw new OwnerAuthError('unsupported')
  const { protocol, hostname, origin } = window.location
  if (protocol === 'https:' || (protocol === 'http:' && LOOPBACK_HOSTNAMES.has(hostname))) return origin
  throw new OwnerAuthError('unsupported')
}

/** The effective Etebase endpoint must be the root of the same origin, with no extra URL parts. */
function assertSameOriginRoot(serverUrl: string, origin: string) {
  let url: URL
  try {
    url = new URL(serverUrl)
  } catch {
    throw new OwnerAuthError('unsupported')
  }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new OwnerAuthError('unsupported')
  }
}

async function requestOwnerGrant(origin: string, username: string, owner: OwnerSignupOptions): Promise<string> {
  let response: Response
  try {
    response = await fetch(`${origin}/api/v1/owner/login/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password: owner.ownerPassword, username }),
      redirect: 'error',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: owner.signal,
    })
  } catch (err) {
    throwIfAborted(owner.signal)
    throw err instanceof OwnerAuthError ? err : new OwnerAuthError('unavailable')
  }
  if (response.status === 403) throw new OwnerAuthError('rejected')
  if (!response.ok) throw new OwnerAuthError('unavailable')
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new OwnerAuthError('unavailable')
  }
  const grant = (value as { registration_token?: unknown } | null)?.registration_token
  const expiresIn = (value as { expires_in?: unknown } | null)?.expires_in
  const validGrant = typeof grant === 'string' && grant.length <= MAX_GRANT_LENGTH && /^[\x21-\x7E]+$/.test(grant)
  const validExpiry = typeof expiresIn === 'number' && Number.isInteger(expiresIn) && expiresIn > 0 && expiresIn <= 120
  if (typeof grant !== 'string' || !validGrant || !validExpiry) throw new OwnerAuthError('unavailable')
  return grant
}

export async function etebaseSignUp(
  email: string,
  password: string,
  serverUrl?: string,
  owner?: OwnerSignupOptions,
): Promise<EtebaseAuthResult> {
  const endpoint = serverUrl || ETEBASE_SERVER_URL
  let registrationToken: string | undefined
  if (owner) {
    throwIfAborted(owner.signal)
    const origin = ownerOrigin()
    assertSameOriginRoot(endpoint, origin)
    registrationToken = await requestOwnerGrant(origin, email, owner)
    throwIfAborted(owner.signal)
  }
  await new Promise((r) => setTimeout(r, 50))
  const { signUp, saveSession } = await import('@silentsuite/core')
  // Cancellation during the delay or import must not start encrypted account creation.
  if (owner) throwIfAborted(owner.signal)
  const account = registrationToken === undefined
    ? await signUp(endpoint, email, password)
    : await signUp(endpoint, email, password, { registrationToken })
  registrationToken = undefined
  if (owner) throwIfAborted(owner.signal)
  const authToken = (account as any).authToken as string
  const savedSession = await saveSession(account)
  return { authToken, savedSession }
}

export async function etebaseLogIn(
  email: string,
  password: string,
  serverUrl?: string,
): Promise<EtebaseAuthResult> {
  await new Promise((r) => setTimeout(r, 50))
  const { logIn, saveSession } = await import('@silentsuite/core')
  const account = await logIn(serverUrl || ETEBASE_SERVER_URL, email, password)
  const authToken = (account as any).authToken as string
  const savedSession = await saveSession(account)
  return { authToken, savedSession }
}
