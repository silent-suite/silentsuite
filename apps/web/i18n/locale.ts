// Web UI languages a browser may opt into. English is the default and the
// source catalogue; Italian is a partial, experimental opt-in.
export const SUPPORTED_LOCALES = ['en', 'it'] as const
export type AppLocale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: AppLocale = 'en'

// Non-sensitive, first-party preference cookie read by i18n/request.ts.
export const LOCALE_COOKIE = 'silentsuite-locale'
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

// Secure only on HTTPS so plain-HTTP self-hosted deployments keep working.
export function buildLocaleCookie(locale: AppLocale, secure: boolean): string {
  return `${LOCALE_COOKIE}=${resolveLocale(locale)}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure ? '; Secure' : ''}`
}

// Only exact allowlisted values are accepted; everything else is English.
export function resolveLocale(value: unknown): AppLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
    ? (value as AppLocale)
    : DEFAULT_LOCALE
}
