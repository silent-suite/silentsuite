import { describe, expect, it } from 'vitest'
import { normalizeSignupReturnTo, paymentReturnUrl, signupSuccessUrl } from '../signup-return'

describe('signup return helpers', () => {
  it('allows the Android signup completion deep link', () => {
    expect(normalizeSignupReturnTo('silentsuite://signup-complete')).toBe('silentsuite://signup-complete')
  })

  it('rejects empty, malformed, and non-Android return URLs', () => {
    expect(normalizeSignupReturnTo(null)).toBeNull()
    expect(normalizeSignupReturnTo(undefined)).toBeNull()
    expect(normalizeSignupReturnTo('')).toBeNull()
    expect(normalizeSignupReturnTo('not a url')).toBeNull()
    expect(normalizeSignupReturnTo('https://evil.example/')).toBeNull()
    expect(normalizeSignupReturnTo('silentsuite://other-flow')).toBeNull()
  })

  it('builds a signup success URL without return_to when absent or invalid', () => {
    expect(signupSuccessUrl('https://app.silentsuite.io')).toBe('https://app.silentsuite.io/signup/success')
    expect(signupSuccessUrl('https://app.silentsuite.io', 'https://evil.example/')).toBe('https://app.silentsuite.io/signup/success')
  })

  it('preserves a valid Android return URL on the signup success URL', () => {
    const url = new URL(signupSuccessUrl('https://app.silentsuite.io', 'silentsuite://signup-complete'))

    expect(url.origin).toBe('https://app.silentsuite.io')
    expect(url.pathname).toBe('/signup/success')
    expect(url.searchParams.get('return_to')).toBe('silentsuite://signup-complete')
  })

  it('uses a same-origin settings path for subscription payment redirects', () => {
    expect(paymentReturnUrl('https://app.silentsuite.io', '/settings/subscription')).toBe(
      'https://app.silentsuite.io/settings/subscription',
    )
  })

  it('keeps signup payment redirects on the signup success route by default', () => {
    expect(paymentReturnUrl('https://app.silentsuite.io', undefined, 'silentsuite://signup-complete')).toBe(
      'https://app.silentsuite.io/signup/success?return_to=silentsuite%3A%2F%2Fsignup-complete',
    )
  })

  it('rejects external and protocol-relative payment return paths', () => {
    expect(() => paymentReturnUrl('https://app.silentsuite.io', 'https://evil.example/')).toThrow(/app origin/)
    expect(() => paymentReturnUrl('https://app.silentsuite.io', '//evil.example/')).toThrow(/app origin/)
  })
})
