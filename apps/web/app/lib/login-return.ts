export function safeReturnTo(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(raw)) return '/calendar'

  try {
    const origin = window.location.origin
    const url = new URL(raw, origin)
    if (url.origin !== origin) return '/calendar'

    // A normalized path starting with // would become a host on the next navigation.
    if (url.pathname.startsWith('//')) return '/calendar'

    // Never bounce back into login after a successful unlock.
    if (url.pathname === '/login' || url.pathname.startsWith('/login/')) return '/calendar'

    return url.pathname + url.search + url.hash
  } catch {
    return '/calendar'
  }
}
