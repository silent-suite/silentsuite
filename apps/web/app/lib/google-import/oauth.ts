import { getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import { useAuthStore } from '@/app/stores/use-auth-store'

/*
 * Google sign-in for the one-time import (#48), with no Google script on our origin.
 *
 * A popup opens Google's authorization endpoint for the browser token flow
 * (response_type=token; Google issues no refresh token in it). Google redirects the popup
 * to the static page public/oauth/google-callback.html on our origin. That page strips the
 * fragment from its URL, checks `state` against the single-use value stored below, posts the
 * result to window.opener with our exact origin as targetOrigin, and closes. Here a message
 * counts only when it comes from our own origin and from that popup window, and carries the
 * same state.
 *
 * The access token lives only in `accessToken` below: never in storage, a kept URL, our
 * server or a log. It is cleared when an import finishes, fails or is cancelled, at logout
 * and at an account switch. Clearing it does not revoke the user's consent at Google.
 */

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_CALLBACK_PATH = '/oauth/google-callback.html'
/** Shared with public/oauth/google-callback.js. Holds the single-use state, never a token. */
export const OAUTH_STATE_KEY = 'silentsuite-google-import-oauth-state'
/** Shared with public/oauth/google-callback.js. */
export const OAUTH_MESSAGE_TYPE = 'silentsuite-google-import-oauth'
export const OAUTH_TIMEOUT_MS = 5 * 60 * 1000
const POPUP_POLL_MS = 500

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
export const GOOGLE_CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly'

export type GoogleAuthFailure = 'blocked' | 'closed' | 'denied' | 'timeout' | 'invalid' | 'scope' | 'cancelled' | 'account-changed'

const FAILURE_MESSAGES: Record<GoogleAuthFailure, string> = {
  blocked: 'The Google sign-in window was blocked. Allow pop-ups for this site and try again.',
  closed: 'The Google sign-in window was closed before it finished.',
  denied: 'Google access was not granted, so nothing was imported.',
  timeout: 'Google sign-in took too long. Please try again.',
  invalid: 'The Google sign-in response could not be verified. Please try again.',
  scope: 'Google did not grant read access to this data, so nothing was imported.',
  cancelled: 'Google import was cancelled.',
  'account-changed': 'You signed out or switched accounts, so the Google import stopped.',
}

export class GoogleAuthError extends Error {
  constructor(readonly reason: GoogleAuthFailure) {
    super(FAILURE_MESSAGES[reason])
    this.name = 'GoogleAuthError'
  }
}

interface TokenOwner {
  epoch: number
  userId: string | null
  expiresAt: number
}

let accessToken: string | null = null
let tokenOwner: TokenOwner | null = null
let cancelPending: (() => void) | null = null

function currentUserId(): string | null {
  return useAuthStore.getState().user?.id ?? null
}

/** Drops the token and stops any sign-in still waiting for its popup. */
export function clearGoogleAccessToken(): void {
  accessToken = null
  tokenOwner = null
  const cancel = cancelPending
  cancelPending = null
  cancel?.()
}

/** The token, only while it belongs to the signed-in SilentSuite account and has not expired. */
export function getGoogleAccessToken(now = Date.now()): string | null {
  if (!accessToken || !tokenOwner) return null
  if (!isCurrentAccountEpoch(tokenOwner.epoch) || currentUserId() !== tokenOwner.userId || now >= tokenOwner.expiresAt) {
    clearGoogleAccessToken()
    return null
  }
  return accessToken
}

// Logout and account switch change the signed-in user; either one ends the token at once.
useAuthStore.subscribe((state) => {
  if (tokenOwner && (state.user?.id ?? null) !== tokenOwner.userId) clearGoogleAccessToken()
})

function randomState(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function googleAuthUrl(clientId: string, redirectUri: string, scopes: readonly string[], state: string): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'token')
  url.searchParams.set('scope', scopes.join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('include_granted_scopes', 'false')
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

export const GOOGLE_POPUP_NAME = 'silentsuite-google-import'
export const GOOGLE_POPUP_FEATURES = 'popup,width=520,height=680'

export interface GoogleSignInOptions {
  clientId: string
  scopes: readonly string[]
  win?: Window
  /** A blank popup opened during the click, so loading this module cannot cost the user gesture. */
  popup?: Window | null
  timeoutMs?: number
}

/**
 * Opens the Google popup and resolves once a verified token is held in memory. Must be called
 * from a user gesture so the popup is not blocked. Rejects with GoogleAuthError.
 */
export function signInWithGoogle({ clientId, scopes, win = window, popup: opened, timeoutMs = OAUTH_TIMEOUT_MS }: GoogleSignInOptions): Promise<void> {
  clearGoogleAccessToken()
  const origin = win.location.origin
  const state = randomState()
  const epoch = getAccountEpoch()
  const userId = currentUserId()
  try {
    win.localStorage.setItem(OAUTH_STATE_KEY, JSON.stringify({ state, expiresAt: Date.now() + timeoutMs }))
  } catch {
    return Promise.reject(new GoogleAuthError('invalid'))
  }

  const url = googleAuthUrl(clientId, `${origin}${GOOGLE_CALLBACK_PATH}`, scopes, state)
  let popup: Window | null = null
  if (opened && !opened.closed) {
    try {
      opened.location.replace(url)
      popup = opened
    } catch {
      popup = null
    }
  } else if (opened === undefined) {
    popup = win.open(url, GOOGLE_POPUP_NAME, GOOGLE_POPUP_FEATURES)
  }
  if (!popup) {
    try { win.localStorage.removeItem(OAUTH_STATE_KEY) } catch { /* nothing to undo */ }
    return Promise.reject(new GoogleAuthError('blocked'))
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (failure: GoogleAuthFailure | null) => {
      if (settled) return
      settled = true
      win.removeEventListener('message', onMessage)
      win.clearInterval(poll)
      win.clearTimeout(timer)
      if (cancelPending === cancel) cancelPending = null
      try { win.localStorage.removeItem(OAUTH_STATE_KEY) } catch { /* single use is also enforced by the callback */ }
      try { if (!popup.closed) popup.close() } catch { /* cross-origin popup may refuse */ }
      if (failure) reject(new GoogleAuthError(failure))
      else resolve()
    }

    function onMessage(event: MessageEvent) {
      if (event.origin !== origin || event.source !== popup) return
      const data = event.data as Record<string, unknown> | null
      if (!data || typeof data !== 'object' || data.type !== OAUTH_MESSAGE_TYPE) return
      if (typeof data.state !== 'string' || !sameString(data.state, state)) return finish('invalid')
      if (!isCurrentAccountEpoch(epoch) || currentUserId() !== userId) return finish('account-changed')
      if (typeof data.error === 'string') return finish(data.error === 'access_denied' ? 'denied' : 'invalid')
      const token = data.accessToken
      if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return finish('invalid')
      const granted = new Set(typeof data.scope === 'string' ? data.scope.split(' ') : [])
      if (!scopes.every((scope) => granted.has(scope))) return finish('scope')
      const expiresIn = Number(data.expiresIn)
      const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, 3600) * 1000 : 3600 * 1000
      accessToken = token
      tokenOwner = { epoch, userId, expiresAt: Date.now() + lifetimeMs }
      finish(null)
    }

    const cancel = () => finish('cancelled')
    cancelPending = cancel
    win.addEventListener('message', onMessage)
    // A popup that posts its result closes right after; two closed polls in a row let that message land first.
    let closedPolls = 0
    const poll = win.setInterval(() => {
      let closed = false
      try { closed = popup.closed } catch { closed = false }
      closedPolls = closed ? closedPolls + 1 : 0
      if (closedPolls >= 2) finish('closed')
    }, POPUP_POLL_MS)
    const timer = win.setTimeout(() => finish('timeout'), timeoutMs)
  })
}
