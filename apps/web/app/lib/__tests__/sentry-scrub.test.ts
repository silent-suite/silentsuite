import { describe, expect, it } from 'vitest'
import { scrubSentryEvent, SENTRY_REDACTED_TEXT } from '../sentry-scrub'

describe('scrubSentryEvent', () => {
  it('redacts private strings from high-risk Sentry fields', () => {
    const event = scrubSentryEvent({
      message: 'PRIVATE_CALENDAR_TITLE',
      exception: {
        values: [{ type: 'Error', value: 'PRIVATE_CONTACT_NAME' }],
      },
      breadcrumbs: [{ message: 'PRIVATE_TASK_TITLE', data: { note: 'PRIVATE_NOTE' } }],
      extra: { raw: 'PRIVATE_EXTRA' },
      contexts: { parser: { detail: 'PRIVATE_CONTEXT' } },
      transaction: 'PRIVATE_TRANSACTION',
      user: { email: 'PRIVATE_USER_EMAIL' },
      tags: { item: 'PRIVATE_TAG' },
      fingerprint: ['PRIVATE_FINGERPRINT'],
      logger: 'PRIVATE_LOGGER',
      server_name: 'PRIVATE_SERVER',
      request: {
        url: 'https://app.silentsuite.io/private-path',
        query_string: 'q=PRIVATE_QUERY',
        headers: { Authorization: 'Token PRIVATE_TOKEN' },
        cookies: 'PRIVATE_COOKIE',
        data: 'PRIVATE_BODY',
      },
    })

    expect(JSON.stringify(event)).not.toContain('PRIVATE_')
    expect(event.message).toBe(SENTRY_REDACTED_TEXT)
    expect(event.exception?.values?.[0]?.value).toBe(SENTRY_REDACTED_TEXT)
    expect(event.breadcrumbs?.[0]?.message).toBe(SENTRY_REDACTED_TEXT)
    expect(event.transaction).toBe(SENTRY_REDACTED_TEXT)
    expect(event.user).toBeUndefined()
    expect(event.tags?.item).toBe(SENTRY_REDACTED_TEXT)
    expect(event.fingerprint?.[0]).toBe(SENTRY_REDACTED_TEXT)
    expect(event.logger).toBe(SENTRY_REDACTED_TEXT)
    expect(event.server_name).toBe(SENTRY_REDACTED_TEXT)
    expect(event.request?.headers).toBeUndefined()
    expect(event.request?.cookies).toBeUndefined()
    expect(event.request?.data).toBeUndefined()
  })
})
