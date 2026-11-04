import { cookies } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'
import { LOCALE_COOKIE, resolveLocale } from './locale'
import { getMessagesForLocale } from './messages'

export default getRequestConfig(async () => {
  // Explicit per-browser opt-in only; Accept-Language is intentionally ignored.
  const locale = resolveLocale((await cookies()).get(LOCALE_COOKIE)?.value)

  return {
    locale,
    messages: getMessagesForLocale(locale),
  }
})
