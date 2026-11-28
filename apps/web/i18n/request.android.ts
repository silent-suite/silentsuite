import { getRequestConfig } from 'next-intl/server'
import { DEFAULT_LOCALE } from './locale'
import { getMessagesForLocale } from './messages'

// The Android bundle is exported without a server, so there is no request
// cookie to read: it always renders the default language.
export default getRequestConfig(async () => ({
  locale: DEFAULT_LOCALE,
  messages: getMessagesForLocale(DEFAULT_LOCALE),
}))
