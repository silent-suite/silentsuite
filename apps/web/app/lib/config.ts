/**
 * Centralized environment configuration.
 *
 * Import from here instead of reading `process.env` directly so every
 * module shares a single source of truth (and a single fallback value).
 */

export const BILLING_API_URL =
  process.env.NEXT_PUBLIC_BILLING_API_URL ?? 'http://localhost:3736'

export const ETEBASE_SERVER_URL =
  process.env.NEXT_PUBLIC_ETEBASE_SERVER_URL ?? 'http://localhost:3735'
