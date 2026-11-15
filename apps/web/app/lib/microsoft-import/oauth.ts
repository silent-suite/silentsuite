import { getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import { useAuthStore } from '@/app/stores/use-auth-store'

/*
 * Microsoft sign-in for the one-time import (#48), with no Microsoft script (no MSAL) on our
 * origin.
 *
 * Authorization code flow with PKCE (S256) for a single-page-application redirect URI. A popup
 * opens Microsoft's /common authorize endpoint with response_mode=fragment. Microsoft redirects
 * the popup to the static page public/oauth/microsoft-callback.html on our origin. That page
 * strips the fragment, checks `state` against the single-use value stored below, posts only
 * the code (or an OAuth error plus bare AADSTS numbers) to window.opener with our exact origin
 * as targetOrigin, and closes. The PKCE verifier never leaves this module's memory, so the code
 * the callback sees is useless on its own. The token exchange is a browser POST from here.
 *
 * Scopes are `openid` plus one Graph read scope. No offline_access, so Microsoft issues no
 * refresh token; one that arrives anyway is dropped unread. The id_token only gives the stable
 * per-app account id (`sub`, with `tid` when present) used in import source keys.
 *
 * The access token lives only in `accessToken` below: never in storage, a kept URL, our server
 * or a log. It is cleared when an import finishes, fails or is cancelled, at logout and at an
 * account switch. Clearing it does not revoke the user's consent at Microsoft.
 *
 * Run lifecycle: each sign-in is a run with its own AbortController. A new sign-in, cancel,
 * logout, account switch and the exchange deadline abort the run; the token POST and the
 * reading of its response run under that signal, and the token is published only after a
 * synchronous check that the run is still current, not aborted, and the account unchanged.
 */

export const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0'
export const MICROSOFT_CALLBACK_PATH = '/oauth/microsoft-callback.html'
/** Shared with public/oauth/microsoft-callback.js. Holds the single-use state, never a code or token. */
export const MICROSOFT_OAUTH_STATE_KEY = 'silentsuite-microsoft-import-oauth-state'
/** Shared with public/oauth/microsoft-callback.js. */
export const MICROSOFT_OAUTH_MESSAGE_TYPE = 'silentsuite-microsoft-import-oauth'
export const MICROSOFT_OAUTH_TIMEOUT_MS = 5 * 60 * 1000
export const MICROSOFT_EXCHANGE_TIMEOUT_MS = 30 * 1000
const POPUP_POLL_MS = 500
const MAX_TOKEN_LENGTH = 16 * 1024
const MAX_RESPONSE_LENGTH = 256 * 1024
const MAX_ID_PART_LENGTH = 256

export const MICROSOFT_CALENDAR_SCOPE = 'https://graph.microsoft.com/Calendars.Read'
export const MICROSOFT_CONTACTS_SCOPE = 'https://graph.microsoft.com/Contacts.Read'
const GRAPH_SCOPE_PREFIX = 'https://graph.microsoft.com/'
const ALLOWED_SCOPES = new Set([MICROSOFT_CALENDAR_SCOPE, MICROSOFT_CONTACTS_SCOPE])
/** AADSTS codes meaning the user's organization must approve the app first. */
const ADMIN_CODES = new Set(['65001', '90094', '90095'])

export type MicrosoftAuthFailure = 'blocked' | 'closed' | 'denied' | 'admin' | 'timeout' | 'invalid' | 'scope' | 'cancelled' | 'account-changed'

const FAILURE_MESSAGES: Record<MicrosoftAuthFailure, string> = {
  blocked: 'The Microsoft sign-in window was blocked. Allow pop-ups for this site and try again.',
  closed: 'The Microsoft sign-in window was closed before it finished.',
  denied: 'Microsoft access was not granted, so nothing was imported.',
  admin: 'Your organization needs an administrator to approve SilentSuite before you can import from this account.',
  timeout: 'Microsoft sign-in took too long. Please try again.',
  invalid: 'The Microsoft sign-in response could not be verified. Please try again.',
  scope: 'Microsoft did not grant read access to this data, so nothing was imported.',
  cancelled: 'Microsoft import was cancelled.',
  'account-changed': 'You signed out or switched accounts, so the Microsoft import stopped.',
}

export class MicrosoftAuthError extends Error {
  constructor(readonly reason: MicrosoftAuthFailure) {
    super(FAILURE_MESSAGES[reason])
    this.name = 'MicrosoftAuthError'
  }
}

interface TokenOwner {
  epoch: number
  userId: string | null
  expiresAt: number
  /** The sign-in that obtained the token: only its importer may release it. */
  run: object
}

interface Run {
  epoch: number
  userId: string | null
  controller: AbortController
  /** Ends the run's promise; idempotent. */
  stop: (failure: MicrosoftAuthFailure) => void
}

let accessToken: string | null = null
let tokenOwner: TokenOwner | null = null
let currentRun: Run | null = null

function currentUserId(): string | null {
  return useAuthStore.getState().user?.id ?? null
}

function abortCurrentRun(failure: MicrosoftAuthFailure): void {
  const run = currentRun
  currentRun = null
  if (!run) return
  run.controller.abort()
  run.stop(failure)
}

/** Drops the token and aborts any sign-in in progress, including a pending token exchange. */
export function clearMicrosoftAccessToken(): void {
  accessToken = null
  tokenOwner = null
  abortCurrentRun('cancelled')
}

/** The token, only while it belongs to the signed-in SilentSuite account and has not expired. */
export function getMicrosoftAccessToken(now = Date.now()): string | null {
  if (!accessToken || !tokenOwner) return null
  if (!isCurrentAccountEpoch(tokenOwner.epoch) || currentUserId() !== tokenOwner.userId || now >= tokenOwner.expiresAt) {
    clearMicrosoftAccessToken()
    return null
  }
  return accessToken
}

// Logout and account switch change the signed-in user; either one ends the token and any run at once.
useAuthStore.subscribe((state) => {
  const userId = state.user?.id ?? null
  if (currentRun && userId !== currentRun.userId) abortCurrentRun('account-changed')
  if (tokenOwner && userId !== tokenOwner.userId) clearMicrosoftAccessToken()
})

function base64Url(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomString(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** `Calendars.Read` and `https://graph.microsoft.com/calendars.read` name the same scope. */
function normaliseScope(scope: string): string {
  const lower = scope.toLowerCase()
  return lower.startsWith(GRAPH_SCOPE_PREFIX) ? lower.slice(GRAPH_SCOPE_PREFIX.length) : lower
}

export function microsoftAuthUrl(clientId: string, redirectUri: string, scope: string, state: string, codeChallenge: string): string {
  const url = new URL(`${MICROSOFT_AUTHORITY}/authorize`)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_mode', 'fragment')
  url.searchParams.set('scope', `openid ${scope}`)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

/** Maps an OAuth error and its AADSTS numbers to a failure; free text is never consulted. */
export function microsoftErrorFailure(error: unknown, codes: unknown): MicrosoftAuthFailure {
  const list = Array.isArray(codes) ? codes.map(String) : []
  if (list.some((code) => ADMIN_CODES.has(code))) return 'admin'
  if (error === 'access_denied') return 'denied'
  return 'invalid'
}

function decodeIdToken(idToken: unknown): Record<string, unknown> | null {
  if (typeof idToken !== 'string' || idToken.length > MAX_TOKEN_LENGTH) return null
  const parts = idToken.split('.')
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return null
  try {
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null
  } catch {
    return null
  }
}

function idPart(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_PART_LENGTH && /^[\x21-\x7e]+$/.test(value) ? value : null
}

/** Settles with the promise, or rejects as soon as the signal aborts. */
function underSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new MicrosoftAuthError('cancelled'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new MicrosoftAuthError('cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (err: unknown) => { signal.removeEventListener('abort', onAbort); reject(err) },
    )
  })
}

export const MICROSOFT_POPUP_NAME = 'silentsuite-microsoft-import'
export const MICROSOFT_POPUP_FEATURES = 'popup,width=520,height=680'

export interface MicrosoftSignInOptions {
  clientId: string
  /** MICROSOFT_CALENDAR_SCOPE or MICROSOFT_CONTACTS_SCOPE; `openid` is added here. */
  scope: string
  win?: Window
  /** A blank popup opened during the click, so loading this module cannot cost the user gesture. */
  popup?: Window | null
  timeoutMs?: number
  exchangeTimeoutMs?: number
  fetcher?: typeof fetch
}

/**
 * A verified sign-in: the account key part, `token` for this sign-in's token only (null once a
 * newer sign-in replaced it, or it was cleared or expired), and `release` to drop it when the
 * import ends.
 */
export interface MicrosoftSignIn {
  accountId: string
  token: () => string | null
  release: () => void
}

type Verified = { token: string; lifetimeMs: number; accountId: string }

/**
 * Opens the Microsoft popup and resolves once a verified token is held in memory, with the
 * account key part (`${tid}.${sub}`, or `sub` without tid). Must be called from a user gesture
 * (or given a popup opened in one). Rejects with MicrosoftAuthError.
 */
export function signInWithMicrosoft({
  clientId,
  scope,
  win = window,
  popup: opened,
  timeoutMs = MICROSOFT_OAUTH_TIMEOUT_MS,
  exchangeTimeoutMs = MICROSOFT_EXCHANGE_TIMEOUT_MS,
  fetcher = fetch,
}: MicrosoftSignInOptions): Promise<MicrosoftSignIn> {
  // A new sign-in aborts and replaces any old run, and drops any token.
  clearMicrosoftAccessToken()
  if (!ALLOWED_SCOPES.has(scope) || !clientId) return Promise.reject(new MicrosoftAuthError('invalid'))
  const origin = win.location.origin
  const redirectUri = `${origin}${MICROSOFT_CALLBACK_PATH}`
  const state = randomString()
  let verifier: string | null = randomString()
  const epoch = getAccountEpoch()
  const userId = currentUserId()
  try {
    win.localStorage.setItem(MICROSOFT_OAUTH_STATE_KEY, JSON.stringify({ state, expiresAt: Date.now() + timeoutMs }))
  } catch {
    return Promise.reject(new MicrosoftAuthError('invalid'))
  }

  // Opened synchronously (blank) so the user gesture holds while the PKCE challenge is computed.
  let popup: Window | null = null
  if (opened && !opened.closed) popup = opened
  else if (opened === undefined) popup = win.open('about:blank', MICROSOFT_POPUP_NAME, MICROSOFT_POPUP_FEATURES)
  if (!popup) {
    try { win.localStorage.removeItem(MICROSOFT_OAUTH_STATE_KEY) } catch { /* nothing to undo */ }
    return Promise.reject(new MicrosoftAuthError('blocked'))
  }
  const popupWin = popup

  return new Promise<MicrosoftSignIn>((resolve, reject) => {
    let settled = false
    let phase: 'waiting-popup' | 'exchanging' = 'waiting-popup'
    let poll: number | undefined
    let timer: number | undefined
    let deadline: number | undefined
    const controller = new AbortController()

    const stopWaiting = () => {
      win.removeEventListener('message', onMessage)
      if (poll !== undefined) win.clearInterval(poll)
      if (timer !== undefined) win.clearTimeout(timer)
      poll = undefined
      timer = undefined
      try { win.localStorage.removeItem(MICROSOFT_OAUTH_STATE_KEY) } catch { /* single use is also enforced by the callback */ }
      try { if (!popupWin.closed) popupWin.close() } catch { /* cross-origin popup may refuse */ }
    }

    const finish = (failure: MicrosoftAuthFailure | null, accountId?: string) => {
      if (settled) return
      settled = true
      verifier = null
      stopWaiting()
      if (deadline !== undefined) win.clearTimeout(deadline)
      if (currentRun === run) currentRun = null
      if (failure) {
        controller.abort()
        reject(new MicrosoftAuthError(failure))
      } else {
        // Drops this run's token only: a newer sign-in's token (or run) is left alone.
        const release = () => {
          if (tokenOwner?.run !== run) return
          accessToken = null
          tokenOwner = null
        }
        // A run's reads must never borrow a newer sign-in's token (another Microsoft account).
        const token = () => (tokenOwner?.run === run ? getMicrosoftAccessToken() : null)
        resolve({ accountId: accountId!, token, release })
      }
    }

    const run: Run = { epoch, userId, controller, stop: (failure) => finish(failure) }
    currentRun = run

    const accountUnchanged = () => isCurrentAccountEpoch(epoch) && currentUserId() === userId

    async function exchange(code: string, codeVerifier: string): Promise<Verified> {
      const body = new URLSearchParams({
        client_id: clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        scope: `openid ${scope}`,
      })
      let response: Response
      try {
        response = await underSignal(fetcher(`${MICROSOFT_AUTHORITY}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        }), controller.signal)
      } catch (err) {
        if (err instanceof MicrosoftAuthError) throw err
        throw new MicrosoftAuthError(controller.signal.aborted ? 'cancelled' : 'invalid')
      }
      let data: Record<string, unknown>
      try {
        const text = await underSignal(response.text(), controller.signal)
        if (text.length > MAX_RESPONSE_LENGTH) throw new MicrosoftAuthError('invalid')
        const parsed = JSON.parse(text) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MicrosoftAuthError('invalid')
        data = parsed as Record<string, unknown>
      } catch (err) {
        if (err instanceof MicrosoftAuthError) throw err
        throw new MicrosoftAuthError(controller.signal.aborted ? 'cancelled' : 'invalid')
      }
      // Never kept: no offline_access was asked for, so none should come, and one that does is dropped.
      delete data.refresh_token
      if (!response.ok) throw new MicrosoftAuthError(microsoftErrorFailure(data.error, data.error_codes))
      if (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer') throw new MicrosoftAuthError('invalid')
      const token = data.access_token
      if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) throw new MicrosoftAuthError('invalid')
      const granted = new Set(typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean).map(normaliseScope) : [])
      if (!granted.has(normaliseScope(scope))) throw new MicrosoftAuthError('scope')
      const expiresIn = Number(data.expires_in)
      if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new MicrosoftAuthError('invalid')
      const claims = decodeIdToken(data.id_token)
      if (!claims || claims.aud !== clientId) throw new MicrosoftAuthError('invalid')
      const sub = idPart(claims.sub)
      if (!sub) throw new MicrosoftAuthError('invalid')
      let accountId = sub
      if (claims.tid !== undefined) {
        const tid = idPart(claims.tid)
        if (!tid) throw new MicrosoftAuthError('invalid')
        accountId = `${tid}.${sub}`
      }
      return { token, lifetimeMs: Math.min(expiresIn, 3600) * 1000, accountId }
    }

    function startExchange(code: string) {
      phase = 'exchanging'
      // The callback closes the popup on purpose before the POST finishes: stop watching it.
      stopWaiting()
      deadline = win.setTimeout(() => finish('timeout'), exchangeTimeoutMs)
      const codeVerifier = verifier
      verifier = null
      if (!codeVerifier) return finish('invalid')
      exchange(code, codeVerifier).then(
        (verified) => {
          // Synchronous publish check: still this run, not aborted, same SilentSuite account.
          if (settled || currentRun !== run || controller.signal.aborted) return finish('cancelled')
          if (!accountUnchanged()) return finish('account-changed')
          accessToken = verified.token
          tokenOwner = { epoch, userId, expiresAt: Date.now() + verified.lifetimeMs, run }
          finish(null, verified.accountId)
        },
        (err: unknown) => {
          if (settled) return
          if (!accountUnchanged()) return finish('account-changed')
          finish(err instanceof MicrosoftAuthError ? err.reason : 'invalid')
        },
      )
    }

    function onMessage(event: MessageEvent) {
      if (settled || phase !== 'waiting-popup') return
      if (event.origin !== origin || event.source !== popupWin) return
      const data = event.data as Record<string, unknown> | null
      if (!data || typeof data !== 'object' || data.type !== MICROSOFT_OAUTH_MESSAGE_TYPE) return
      if (typeof data.state !== 'string' || !sameString(data.state, state)) return finish('invalid')
      if (!accountUnchanged()) return finish('account-changed')
      if (typeof data.error === 'string') return finish(microsoftErrorFailure(data.error, data.errorCodes))
      const code = data.code
      if (typeof code !== 'string' || code.length === 0 || code.length > MAX_TOKEN_LENGTH) return finish('invalid')
      startExchange(code)
    }

    win.addEventListener('message', onMessage)
    // A popup that posts its result closes right after; two closed polls in a row let that message land first.
    let closedPolls = 0
    poll = win.setInterval(() => {
      let closed = false
      try { closed = popupWin.closed } catch { closed = false }
      closedPolls = closed ? closedPolls + 1 : 0
      if (closedPolls >= 2) finish('closed')
    }, POPUP_POLL_MS)
    timer = win.setTimeout(() => finish('timeout'), timeoutMs)

    pkceChallenge(verifier!).then(
      (challenge) => {
        if (settled) return
        try {
          popupWin.location.replace(microsoftAuthUrl(clientId, redirectUri, scope, state, challenge))
        } catch {
          finish('blocked')
        }
      },
      () => finish('invalid'),
    )
  })
}
