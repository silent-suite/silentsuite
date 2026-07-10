const ANDROID_SIGNUP_RETURN_PROTOCOL = 'silentsuite:'
const ANDROID_SIGNUP_RETURN_HOST = 'signup-complete'

export function normalizeSignupReturnTo(value: string | null | undefined): string | null {
  if (!value) return null

  try {
    const url = new URL(value)
    if (url.protocol === ANDROID_SIGNUP_RETURN_PROTOCOL && url.host === ANDROID_SIGNUP_RETURN_HOST) {
      return url.toString()
    }
  } catch {
    return null
  }

  return null
}

export function signupSuccessUrl(origin: string, returnTo?: string | null): string {
  const url = new URL('/signup/success', origin)
  const normalizedReturnTo = normalizeSignupReturnTo(returnTo)
  if (normalizedReturnTo) {
    url.searchParams.set('return_to', normalizedReturnTo)
  }
  return url.toString()
}

export function paymentReturnUrl(origin: string, returnPath?: string, signupReturnTo?: string | null): string {
  if (!returnPath) return signupSuccessUrl(origin, signupReturnTo)

  const appOrigin = new URL(origin).origin
  const returnUrl = new URL(returnPath, appOrigin)
  if (!returnPath.startsWith('/') || returnPath.startsWith('//') || returnUrl.origin !== appOrigin) {
    throw new Error('Payment return path must stay on the SilentSuite app origin.')
  }

  return returnUrl.toString()
}
