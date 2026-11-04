import en from '../messages/en.json'
import it from '../messages/it.json'
import { DEFAULT_LOCALE, type AppLocale } from './locale'

type Messages = Record<string, unknown>

// Explicit catalogue map: the locale never becomes part of an import path.
const catalogues: Record<AppLocale, Messages> = { en, it }

function isPlainObject(value: unknown): value is Messages {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Returns a new tree: English underneath, translated values on top, per nested
// key. Defensive only; pnpm i18n:check still requires full catalogue parity.
function withFallback(fallback: Messages, primary: Messages): Messages {
  const merged: Messages = { ...fallback }
  for (const [key, value] of Object.entries(primary)) {
    const base = fallback[key]
    if (isPlainObject(base) && isPlainObject(value)) merged[key] = withFallback(base, value)
    else if (typeof value === 'string' && typeof base !== 'object') merged[key] = value
  }
  return merged
}

export function getMessagesForLocale(locale: AppLocale): Messages {
  const source = catalogues[DEFAULT_LOCALE]
  return locale === DEFAULT_LOCALE ? source : withFallback(source, catalogues[locale])
}
