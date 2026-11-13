import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  sendSignupPageview,
  shouldSendSignupAnalytics,
} from '../signup-analytics'

describe('signup analytics transport boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // Baseline pageviews are independent of NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED, which
  // gates commercial/custom events only. The runtime gate is canonical origin + route.
  it.each([undefined, 'false', 'TRUE', 'true', ''])(
    'admits the baseline signup pageview regardless of the commercial event flag %s',
    (flag) => {
      vi.stubEnv('NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED', flag)
      expect(shouldSendSignupAnalytics(new URL('https://app.silentsuite.io/signup'))).toBe(true)
    },
  )

  it.each([
    'http://app.silentsuite.io/signup',
    'https://previewapp.silentsuite.io/signup',
    'https://app.silentsuite.io.evil.test/signup',
    'https://self-hosted.example/signup',
    'https://app.silentsuite.io/calendar',
    'https://app.silentsuite.io/signup/plan',
    'https://app.silentsuite.io/signup/customer@example.com',
    'https://app.silentsuite.io/signup/550e8400-e29b-41d4-a716-446655440000',
  ])('rejects noncanonical runtime URL %s', (url) => {
    vi.stubEnv('NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED', 'true')
    expect(shouldSendSignupAnalytics(new URL(url))).toBe(false)
  })

  it('sends only the canonicalized property-free payload through an accepting beacon', async () => {
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
    await expect((body as Blob).text()).resolves.toBe(JSON.stringify({
      domain: 'app.silentsuite.io',
      name: 'pageview',
      url: 'https://app.silentsuite.io/signup',
      referrer: 'https://github.com/',
    }))
  })

  it('falls back to a keepalive fetch with an identical body when the beacon refuses', async () => {
    const beacon = vi.fn(() => false)
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }))

    sendSignupPageview({
      pageUrl: 'https://app.silentsuite.io/signup?utm_source=github',
      referrer: 'https://github.com/silent-suite/silentsuite/issues/123?token=secret',
      beacon,
      fetcher,
    })

    const expectedBody = JSON.stringify({
      domain: 'app.silentsuite.io',
      name: 'pageview',
      url: 'https://app.silentsuite.io/signup',
      referrer: 'https://github.com/',
    })

    expect(beacon).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect((beacon.mock.calls[0][1] as Blob).text()).resolves.toBe(expectedBody)
    expect(fetcher).toHaveBeenCalledWith(
      'https://plausible.silentsuite.io/api/event',
      expect.objectContaining({
        method: 'POST',
        body: expectedBody,
        keepalive: true,
      }),
    )
  })

  it('uses the same canonical payload for the fetch fallback when no beacon exists', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }))

    sendSignupPageview({
      pageUrl: 'https://app.silentsuite.io/signup/success?token=secret',
      referrer: 'https://evil.test/reset/user@example.com',
      fetcher,
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(
      'https://plausible.silentsuite.io/api/event',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          domain: 'app.silentsuite.io',
          name: 'pageview',
          url: 'https://app.silentsuite.io/signup/success',
        }),
        keepalive: true,
      }),
    )
  })

  it.each(['/signup', '/signup/pending-payment', '/signup/success', '/signup/cancel'])(
    'admits registered signup pageview route %s with the commercial event flag unset',
    (pathname) => {
      vi.stubEnv('NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED', undefined)
      expect(shouldSendSignupAnalytics(new URL(`https://app.silentsuite.io${pathname}`))).toBe(true)
    },
  )
})
