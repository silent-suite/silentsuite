// True only in the static copy bundled into the Android app (see
// android-bundle/README.md). That copy carries the login and calendar pages
// only, so links to every other page are left out.
export const isAndroidBundle = process.env.NEXT_PUBLIC_ANDROID_BUNDLE === 'true'

const BOUND_ACCOUNT_KEY = 'silentsuite-android-account'
const BOUND_ACCOUNT_HASH = '#android-account='

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * The Android account this view was opened for. The app passes it once in the
 * start URL's fragment and erases the view's storage whenever the account
 * changes, so a remembered value always names the current account.
 */
export function androidBoundAccount(): string | null {
  if (!isAndroidBundle || typeof window === 'undefined') return null
  try {
    const hash = window.location.hash
    if (hash.startsWith(BOUND_ACCOUNT_HASH)) {
      const fromApp = normalize(decodeURIComponent(hash.slice(BOUND_ACCOUNT_HASH.length)))
      if (fromApp) window.localStorage.setItem(BOUND_ACCOUNT_KEY, fromApp)
    }
    return window.localStorage.getItem(BOUND_ACCOUNT_KEY) || null
  } catch {
    return null
  }
}

/** Whether a login for `email` may proceed. Always true outside the Android bundle. */
export function isLoginAllowedForAndroidAccount(email: string, boundAccount: string | null): boolean {
  if (!isAndroidBundle) return true
  return boundAccount !== null && normalize(email) === boundAccount
}
