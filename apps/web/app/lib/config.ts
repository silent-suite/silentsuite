/**
 * Centralized environment configuration.
 *
 * Import from here instead of reading `process.env` directly so every
 * module shares a single source of truth (and a single fallback value).
 */

export const BILLING_API_URL =
  process.env.NEXT_PUBLIC_BILLING_API_URL ?? 'http://localhost:3736'

/**
 * A self-host build (NEXT_PUBLIC_SELF_HOSTED=true) without an explicit server URL
 * uses the origin the browser loaded the app from, so one artifact works under any
 * device name. During SSR there is no origin, so the value is empty there.
 * Explicitly configured URLs and hosted builds keep their existing values.
 */
function defaultEtebaseServerUrl(): string {
  const configured = process.env.NEXT_PUBLIC_ETEBASE_SERVER_URL
  if (process.env.NEXT_PUBLIC_SELF_HOSTED === 'true' && !configured) {
    return typeof window === 'undefined' ? '' : window.location.origin
  }
  return configured ?? 'http://localhost:3735'
}

export const ETEBASE_SERVER_URL = defaultEtebaseServerUrl()
