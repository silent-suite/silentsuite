import { getGoogleAccessToken } from './oauth'

/*
 * Read-only Google REST calls with our own fetch(). The token goes only into the
 * Authorization header of requests to the hosts below. Errors carry an HTTP status and a
 * fixed message, never a URL, response body or token.
 */

export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3'
export const GOOGLE_PEOPLE_API = 'https://people.googleapis.com/v1'
/** Guards against a server that keeps returning page tokens. */
export const MAX_PAGES = 1000

export class GoogleApiError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 ? 'Your Google sign-in expired. Please start the import again.'
        : status === 403 ? 'Google refused access to this data.'
          : status === 429 ? 'Google is limiting requests right now. Please try again in a few minutes.'
            : 'Google could not be reached. Please try again.',
    )
    this.name = 'GoogleApiError'
  }
}

export interface GoogleRequestOptions {
  signal?: AbortSignal
  fetcher?: typeof fetch
}

export async function googleGet<T>(url: URL, { signal, fetcher = fetch }: GoogleRequestOptions = {}): Promise<T> {
  const token = getGoogleAccessToken()
  if (!token) throw new GoogleApiError(401)
  let response: Response
  try {
    response = await fetcher(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal,
    })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new GoogleApiError(0)
  }
  if (!response.ok) throw new GoogleApiError(response.status)
  return await response.json() as T
}

/** Every item of a paged list: follows nextPageToken until the last page. */
export async function googleGetAllPages<T>(
  baseUrl: URL,
  itemsKey: string,
  options: GoogleRequestOptions = {},
): Promise<T[]> {
  const items: T[] = []
  let pageToken: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(baseUrl)
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const body = await googleGet<Record<string, unknown>>(url, options)
    const pageItems = body[itemsKey]
    if (Array.isArray(pageItems)) items.push(...pageItems as T[])
    pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined
    if (!pageToken) return items
  }
  throw new GoogleApiError(0)
}
