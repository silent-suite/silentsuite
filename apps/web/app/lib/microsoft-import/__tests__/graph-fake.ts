/*
 * A request-aware Microsoft Graph fake for the import tests (#48). Like Graph, it returns only
 * the fields a request selects (plus `id`), returns exceptionOccurrences only when they are both
 * selected and expanded (with the expansion's own $select), and pages the exceptions with an
 * `exceptionOccurrences@odata.nextLink`. Mapper inputs invented by a test therefore cannot hide
 * a missing projection.
 */

type Item = Record<string, unknown>

export interface GraphFakeData {
  calendars?: Item[]
  events?: Record<string, Item[]>
  /** Contacts of the default Contacts folder. */
  contacts?: Item[]
  /** Folders below the default folder; each may carry `contacts` and `childFolders`. */
  contactFolders?: Item[]
  exceptionPageSize?: number
  failContinuation?: boolean
}

export interface GraphFake {
  fetch: typeof fetch
  requests: URL[]
  headers: { authorization?: string; prefer?: string }[]
}

const BASE = 'https://graph.microsoft.com/v1.0'

function project(item: Item, select: string | null): Item {
  if (!select) return { ...item }
  const fields = new Set(select.split(',').map((f) => f.trim()))
  const out: Item = {}
  for (const [key, value] of Object.entries(item)) if (key === 'id' || fields.has(key)) out[key] = value
  return out
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export function createGraphFake(data: GraphFakeData): GraphFake {
  const requests: URL[] = []
  const headers: GraphFake['headers'] = []
  const pageSize = data.exceptionPageSize ?? 1000
  const allEvents = Object.values(data.events ?? {}).flat()
  const allFolders: Item[] = []
  const collect = (folders: Item[] | undefined) => {
    for (const folder of folders ?? []) {
      allFolders.push(folder)
      collect(folder.childFolders as Item[] | undefined)
    }
  }
  collect(data.contactFolders)
  const folderView = (folder: Item) => ({ id: folder.id, displayName: folder.displayName })

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    requests.push(url)
    const h = new Headers(init?.headers)
    headers.push({ authorization: h.get('Authorization') ?? undefined, prefer: h.get('Prefer') ?? undefined })
    if (h.get('Authorization') !== 'Bearer graph-token') return json({ error: { code: 'InvalidAuthenticationToken' } }, 401)
    const path = url.pathname.replace(/^\/v1\.0/, '')
    const select = url.searchParams.get('$select')
    let m: RegExpExecArray | null

    if (path === '/me/calendars') return json({ value: (data.calendars ?? []).map((c) => project(c, select)) })
    if ((m = /^\/me\/calendars\/([^/]+)\/events$/.exec(path))) {
      return json({ value: (data.events?.[decodeURIComponent(m[1]!)] ?? []).map((e) => project(e, select)) })
    }
    if ((m = /^\/me\/events\/([^/]+)\/exceptionOccurrences$/.exec(path))) {
      if (data.failContinuation) return json({ error: { code: 'ServiceUnavailable' } }, 503)
      const master = allEvents.find((e) => e.id === decodeURIComponent(m![1]!))
      const skip = Number(url.searchParams.get('$skip') ?? '0')
      const rest = ((master?.exceptionOccurrences as Item[] | undefined) ?? []).slice(skip)
      return json({ value: rest.map((e) => project(e, select)) })
    }
    if ((m = /^\/me\/events\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(m[1]!)
      const master = allEvents.find((e) => e.id === id)
      if (!master) return json({ error: { code: 'ErrorItemNotFound' } }, 404)
      const { exceptionOccurrences, ...rest } = master
      const body = project(rest, select)
      const expand = /^exceptionOccurrences\(\$select=([^)]*)\)$/.exec(url.searchParams.get('$expand') ?? '')
      const selected = select?.split(',').includes('exceptionOccurrences')
      if (selected && expand) {
        const all = (exceptionOccurrences as Item[] | undefined) ?? []
        body.exceptionOccurrences = all.slice(0, pageSize).map((e) => project(e, expand[1]!))
        if (all.length > pageSize) {
          const next = new URL(`${BASE}/me/events/${encodeURIComponent(id)}/exceptionOccurrences`)
          next.searchParams.set('$select', expand[1]!)
          next.searchParams.set('$skip', String(pageSize))
          body['exceptionOccurrences@odata.nextLink'] = next.toString()
        }
      }
      return json(body)
    }
    if (path === '/me/contacts') return json({ value: (data.contacts ?? []).map((c) => project(c, select)) })
    if (path === '/me/contactFolders') return json({ value: (data.contactFolders ?? []).map(folderView) })
    if ((m = /^\/me\/contactFolders\/([^/]+)\/(contacts|childFolders)$/.exec(path))) {
      const folder = allFolders.find((f) => f.id === decodeURIComponent(m![1]!))
      if (!folder) return json({ error: { code: 'ErrorItemNotFound' } }, 404)
      if (m[2] === 'contacts') return json({ value: ((folder.contacts as Item[] | undefined) ?? []).map((c) => project(c, select)) })
      return json({ value: ((folder.childFolders as Item[] | undefined) ?? []).map(folderView) })
    }
    return json({ error: { code: 'NotFound' } }, 404)
  }
  return { fetch: fetchImpl as typeof fetch, requests, headers }
}
