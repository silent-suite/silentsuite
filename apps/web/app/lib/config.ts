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

/** Relay endpoint for user-initiated "Report a problem" sends. */
export const REPORT_RELAY_URL =
  process.env.NEXT_PUBLIC_REPORT_RELAY_URL || 'https://silentsuite.io/api/report'

/**
 * OAuth client ID for the one-time Google Calendar and Contacts import (#48). The import is
 * hidden unless a build is given one, so builds without it are unchanged.
 */
export const GOOGLE_IMPORT_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_IMPORT_CLIENT_ID ?? ''

/**
 * Application (client) ID of the Microsoft Entra app for the one-time Outlook calendar and
 * contacts import (#48). The import is hidden unless a build is given one.
 */
export const MICROSOFT_IMPORT_CLIENT_ID = process.env.NEXT_PUBLIC_MICROSOFT_IMPORT_CLIENT_ID ?? ''
