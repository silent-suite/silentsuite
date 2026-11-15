import { getMicrosoftAccessToken } from './oauth'

/*
 * Read-only Microsoft Graph calls with our own fetch(). The token goes only into the
 * Authorization header of requests to GRAPH_API; any other URL, including a foreign
 * '@odata.nextLink', is refused before a request is made. Errors carry an HTTP status and a
 * fixed message, never a URL, response body or token.
 */

export const GRAPH_API = 'https://graph.microsoft.com/v1.0'
/** Guards against a server that keeps returning next links. */
export const MAX_PAGES = 1000
const MAX_RETRIES = 3
const MIN_RETRY_MS = 1000
const MAX_RETRY_MS = 30_000
const RETRY_STATUSES = new Set([429, 503, 504])

export class GraphApiError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 ? 'Your Microsoft sign-in expired. Please start the import again.'
        : status === 403 ? 'Microsoft refused access to this data.'
          : RETRY_STATUSES.has(status) ? 'Microsoft is limiting requests right now. Please try again in a few minutes.'
            : 'Microsoft could not be reached. Please try again.',
    )
    this.name = 'GraphApiError'
  }
}

export interface GraphRequestOptions {
  signal?: AbortSignal
  fetcher?: typeof fetch
  /** Waits between throttled attempts; rejects when the signal aborts. Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal))
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** The URL normalised, only when it lies under GRAPH_API; otherwise null. */
function graphUrl(url: URL | string): string | null {
  const raw = typeof url === 'string' ? url : url.toString()
  if (!raw.startsWith(`${GRAPH_API}/`)) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  // Normalisation (dot segments, encoded characters) must not leave the v1.0 API either.
  return parsed.href.startsWith(`${GRAPH_API}/`) ? parsed.href : null
}

/** Retry-After in seconds or as an HTTP date, clamped; the exponential default when absent. */
function retryDelayMs(header: string | null, attempt: number, now = Date.now()): number {
  let ms = 2000 * 2 ** attempt
  if (header) {
    const value = header.trim()
    if (/^\d+$/.test(value)) ms = Number(value) * 1000
    else {
      const date = Date.parse(value)
      if (Number.isFinite(date)) ms = date - now
    }
  }
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, ms))
}

export async function graphGet<T>(url: URL | string, { signal, fetcher = fetch, sleep = defaultSleep }: GraphRequestOptions = {}): Promise<T> {
  const href = graphUrl(url)
  if (!href) throw new GraphApiError(0)
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError(signal)
    const token = getMicrosoftAccessToken()
    if (!token) throw new GraphApiError(401)
    let response: Response
    try {
      response = await fetcher(href, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"',
        },
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal,
      })
    } catch (err) {
      if (signal?.aborted) throw err
      throw new GraphApiError(0)
    }
    if (response.ok) {
      try {
        return await response.json() as T
      } catch (err) {
        if (signal?.aborted) throw err
        throw new GraphApiError(0)
      }
    }
    if (!RETRY_STATUSES.has(response.status) || attempt >= MAX_RETRIES) throw new GraphApiError(response.status)
    await sleep(retryDelayMs(response.headers.get('Retry-After'), attempt), signal)
  }
}

/** Every item of a paged list: follows '@odata.nextLink' (under GRAPH_API only) to the last page. */
export async function graphGetAllPages<T>(url: URL | string, options: GraphRequestOptions = {}, itemsKey = 'value'): Promise<T[]> {
  const items: T[] = []
  let next: URL | string = url
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await graphGet<Record<string, unknown>>(next, options)
    const pageItems = body?.[itemsKey]
    if (!Array.isArray(pageItems)) throw new GraphApiError(0)
    items.push(...pageItems as T[])
    const link = body['@odata.nextLink']
    if (link === undefined || link === null) return items
    if (typeof link !== 'string' || !graphUrl(link)) throw new GraphApiError(0)
    next = link
  }
  throw new GraphApiError(0)
}
