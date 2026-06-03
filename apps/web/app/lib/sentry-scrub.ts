export const SENTRY_REDACTED_TEXT = '[redacted private data]'

type ScrubbableObject = Record<string, unknown>

type ScrubbableSentryEvent = {
  message?: string
  exception?: {
    values?: Array<ScrubbableObject & { value?: string }>
  }
  breadcrumbs?: Array<ScrubbableObject & { message?: string; data?: unknown }>
  extra?: ScrubbableObject
  contexts?: ScrubbableObject
  request?: ScrubbableObject
  transaction?: string
  user?: ScrubbableObject
  tags?: ScrubbableObject
  fingerprint?: unknown[]
  logger?: string
  server_name?: string
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return SENTRY_REDACTED_TEXT
  if (Array.isArray(value)) return value.map(scrubValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as ScrubbableObject).map(([key, nested]) => [key, scrubValue(nested)]),
    )
  }
  return value
}

export function scrubSentryEvent<T extends object>(event: T): T {
  const source = event as ScrubbableSentryEvent
  const scrubbed: ScrubbableSentryEvent = source

  if (scrubbed.message) scrubbed.message = SENTRY_REDACTED_TEXT

  if (scrubbed.exception?.values) {
    scrubbed.exception = {
      ...scrubbed.exception,
      values: scrubbed.exception.values.map((value) => ({
        ...value,
        value: value.value ? SENTRY_REDACTED_TEXT : value.value,
      })),
    }
  }

  if (scrubbed.breadcrumbs) {
    scrubbed.breadcrumbs = scrubbed.breadcrumbs.map((breadcrumb) => ({
      ...breadcrumb,
      message: breadcrumb.message ? SENTRY_REDACTED_TEXT : breadcrumb.message,
      data: scrubValue(breadcrumb.data),
    }))
  }

  if (scrubbed.extra) scrubbed.extra = scrubValue(scrubbed.extra) as ScrubbableObject
  if (scrubbed.contexts) scrubbed.contexts = scrubValue(scrubbed.contexts) as ScrubbableObject
  if (scrubbed.transaction) scrubbed.transaction = SENTRY_REDACTED_TEXT
  if (scrubbed.user) scrubbed.user = undefined
  if (scrubbed.tags) scrubbed.tags = scrubValue(scrubbed.tags) as ScrubbableObject
  if (scrubbed.fingerprint) scrubbed.fingerprint = scrubValue(scrubbed.fingerprint) as unknown[]
  if (scrubbed.logger) scrubbed.logger = SENTRY_REDACTED_TEXT
  if (scrubbed.server_name) scrubbed.server_name = SENTRY_REDACTED_TEXT
  if (scrubbed.request) {
    scrubbed.request = {
      ...scrubbed.request,
      url: scrubbed.request.url ? SENTRY_REDACTED_TEXT : scrubbed.request.url,
      query_string: scrubbed.request.query_string ? SENTRY_REDACTED_TEXT : scrubbed.request.query_string,
      cookies: undefined,
      data: undefined,
      headers: undefined,
    }
  }

  return scrubbed as T
}
