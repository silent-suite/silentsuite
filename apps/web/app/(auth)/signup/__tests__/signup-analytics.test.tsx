import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  sendSignupPageview,
  shouldSendSignupAnalytics,
} from '../signup-analytics'

describe('signup analytics transport boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is disabled unless the build flag is exactly true', () => {
    expect(shouldSendSignupAnalytics(new URL('https://app.silentsuite.io/signup'), undefined)).toBe(false)
    expect(shouldSendSignupAnalytics(new URL('https://app.silentsuite.io/signup'), 'false')).toBe(false)
    expect(shouldSendSignupAnalytics(new URL('https://app.silentsuite.io/signup'), 'TRUE')).toBe(false)
    expect(shouldSendSignupAnalytics(new URL('https://app.silentsuite.io/signup'), 'true')).toBe(true)
  })

  it.each([
    'http://app.silentsuite.io/signup',
    'https://previewapp.silentsuite.io/signup',
    'https://app.silentsuite.io.evil.test/signup',
    'https://self-hosted.example/signup',
    'https://app.silentsuite.io/calendar',
  ])('rejects noncanonical runtime URL %s even when enabled', (url) => {
    expect(shouldSendSignupAnalytics(new URL(url), 'true')).toBe(false)
  })

  it('sends only the canonicalized payload through beacon', () => {
    const beacon = vi.fn(() => true)
    const fetcher = vi.fn()

    sendSignupPageview({
      pageUrl: 'https://app.silentsuite.io/signup?utm_source=github&utm_content=user@example.com&returnTo=/calendar',
      referrer: 'https://github.com/silent-suite/silentsuite/issues/123?token=secret',
      beacon,
      fetcher,
    })

    expect(beacon).toHaveBeenCalledTimes(1)
    expect(fetcher).not.toHaveBeenCalled()
    const [endpoint, body] = beacon.mock.calls[0]
    expect(endpoint).toBe('https://plausible.silentsuite.io/api/event')
    expect(body).toBeInstanceOf(Blob)
  })

  it('uses the same canonical payload for the fetch fallback', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }))

    sendSignupPageview({
      pageUrl: 'https://app.silentsuite.io/signup/success?token=secret',
      referrer: 'https://evil.test/reset/user@example.com',
      fetcher,
    })

    expect(fetcher).toHaveBeenCalledWith(
      'https://plausible.silentsuite.io/api/event',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          domain: 'app.silentsuite.io',
          name: 'pageview',
          url: 'https://app.silentsuite.io/signup/success',
          props: { referrer_category: 'other' },
        }),
      }),
    )
  })
})
