/**
 * Self-hosted mode detection.
 *
 * Build-time: When NEXT_PUBLIC_SELF_HOSTED is set to "true", the entire app
 * runs without the billing API — all features are unlocked and billing UI is hidden.
 *
 * Runtime: When a user enters a custom server URL on app.silentsuite.io,
 * they are a self-hoster connecting via the hosted web app. We detect this
 * and skip billing for that signup/login session.
 */
export const isSelfHosted = process.env.NEXT_PUBLIC_SELF_HOSTED === 'true'

/**
 * Check if a server URL is a custom (non-default) server.
 * This means the user is self-hosting and connecting through the hosted web app.
 */
const DEFAULT_SERVER_URL =
  process.env.NEXT_PUBLIC_ETEBASE_SERVER_URL ?? 'http://localhost:3735'

export function isCustomServer(serverUrl?: string): boolean {
  if (!serverUrl || !serverUrl.trim()) return false
  let trimmed = serverUrl.trim().replace(/\/+$/, '')
  // Normalize: add https:// if no protocol present
  if (!/^https?:\/\//i.test(trimmed)) trimmed = `https://${trimmed}`
  const defaultTrimmed = DEFAULT_SERVER_URL.replace(/\/+$/, '')
  return trimmed !== defaultTrimmed
}

/**
 * Returns true if the user should be treated as a self-hoster:
 * either the app is built in self-hosted mode, or they entered a custom server URL.
 */
export function isUserSelfHosted(serverUrl?: string): boolean {
  return isSelfHosted || isCustomServer(serverUrl)
}
