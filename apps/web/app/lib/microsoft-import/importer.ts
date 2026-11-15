import type { ProviderImportVCard } from '@/app/lib/google-import/contact-mapper'
import type { GoogleCalendarImport } from '@/app/lib/google-import/importer'
import { LIST_SELECT, MASTER_EXPAND, MASTER_SELECT, mapMicrosoftCalendarEvents, type GraphCalendar, type GraphEvent } from './calendar-mapper'
import { CONTACT_FIELDS, mapMicrosoftContacts, type FolderContact, type GraphContact, type GraphContactFolder } from './contact-mapper'
import { GRAPH_API, GraphApiError, graphGet, graphGetAllPages, type GraphRequestOptions } from './graph-api'
import { MICROSOFT_CALENDAR_SCOPE, MICROSOFT_CONTACTS_SCOPE, clearMicrosoftAccessToken, signInWithMicrosoft } from './oauth'

/*
 * Entry points of the Microsoft import (#48), loaded with a dynamic import() only when the
 * user starts it. Each run signs in, reads everything it needs from Graph, maps it, and drops
 * the token before returning or failing. Writing happens afterwards through the existing
 * import components, which encrypt each item with the Etebase client before upload.
 */

export class MicrosoftImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MicrosoftImportError'
  }
}

export interface MicrosoftImportOptions extends GraphRequestOptions {
  clientId: string
  win?: Window
  popup?: Window | null
}

/** Same shape as the Google calendar result, so the calendar import treats both alike. */
export type MicrosoftCalendarImport = GoogleCalendarImport

const COLOR = /^#[0-9a-f]{6}$/i
const PAGE_SIZE = '100'
/** Guards against a folder tree that never ends. */
export const MAX_FOLDER_DEPTH = 10

/** Drops the token and stops a sign-in still waiting for its popup or token exchange. */
export function cancelMicrosoftImport(): void {
  clearMicrosoftAccessToken()
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MicrosoftImportError('Microsoft import was cancelled.')
}

function graphUrl(path: string, params: Record<string, string>): URL {
  const url = new URL(`${GRAPH_API}${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url
}

/** A failure that ends the whole run rather than one series: expired sign-in or cancellation. */
function endsRun(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || !(err instanceof GraphApiError) || err.status === 401
}

/**
 * The series master as Graph returns it for a series-master GET, with its cancelled
 * occurrences and every exception. Null when it could not be read in full: the series is then
 * left out and tried again on the next import.
 */
async function readMaster(id: string, request: GraphRequestOptions): Promise<GraphEvent | null> {
  try {
    const url = graphUrl(`/me/events/${encodeURIComponent(id)}`, { $select: MASTER_SELECT, $expand: MASTER_EXPAND })
    const master = await graphGet<GraphEvent & Record<string, unknown>>(url, request)
    const next = master['exceptionOccurrences@odata.nextLink']
    if (next === undefined) return master
    if (typeof next !== 'string' || !Array.isArray(master.exceptionOccurrences)) return null
    const rest = await graphGetAllPages<GraphEvent>(next, request)
    return { ...master, exceptionOccurrences: [...master.exceptionOccurrences, ...rest] }
  } catch (err) {
    if (endsRun(err, request.signal)) throw err
    return null
  }
}

export async function loadMicrosoftCalendars({ clientId, win, popup, signal, fetcher, sleep }: MicrosoftImportOptions): Promise<MicrosoftCalendarImport> {
  const request: GraphRequestOptions = { signal, fetcher, sleep }
  try {
    const { accountId } = await signInWithMicrosoft({ clientId, scope: MICROSOFT_CALENDAR_SCOPE, win, popup, ...(fetcher ? { fetcher } : {}) })
    throwIfAborted(signal)
    const calendars = await graphGetAllPages<GraphCalendar>(
      graphUrl('/me/calendars', { $select: 'id,name,hexColor,isDefaultCalendar', $top: PAGE_SIZE }),
      request,
    )
    const result: MicrosoftCalendarImport = { calendars: [], unreadable: 0 }
    for (const calendar of calendars) {
      if (typeof calendar.id !== 'string' || !calendar.id) continue
      throwIfAborted(signal)
      // Lists single events and series masters only; each master is read again in full.
      const listed = await graphGetAllPages<GraphEvent>(
        graphUrl(`/me/calendars/${encodeURIComponent(calendar.id)}/events`, { $select: LIST_SELECT, $top: PAGE_SIZE }),
        request,
      )
      const events: GraphEvent[] = []
      const incomplete = new Set<string>()
      for (const event of listed) {
        if (event.type !== 'seriesMaster') {
          events.push(event)
          continue
        }
        throwIfAborted(signal)
        const master = typeof event.id === 'string' && event.id ? await readMaster(event.id, request) : null
        if (master) events.push(master)
        else {
          if (event.id) incomplete.add(event.id)
          events.push(event)
        }
      }
      const mapped = mapMicrosoftCalendarEvents(accountId, calendar, events, incomplete)
      result.unreadable += mapped.unreadable
      if (mapped.units.length === 0) continue
      const color = calendar.hexColor && COLOR.test(calendar.hexColor) ? calendar.hexColor : undefined
      result.calendars.push({
        id: calendar.id,
        name: (calendar.name || 'Outlook Calendar').trim(),
        ...(color ? { color } : {}),
        units: mapped.units,
      })
    }
    return result
  } finally {
    clearMicrosoftAccessToken()
  }
}

async function readFolderContacts(path: string, request: GraphRequestOptions, folderName?: string): Promise<FolderContact[]> {
  const contacts = await graphGetAllPages<GraphContact>(graphUrl(path, { $select: CONTACT_FIELDS, $top: PAGE_SIZE }), request)
  return contacts.map((contact) => ({ contact, ...(folderName ? { folderName } : {}) }))
}

export async function loadMicrosoftContacts({ clientId, win, popup, signal, fetcher, sleep }: MicrosoftImportOptions): Promise<ProviderImportVCard[]> {
  const request: GraphRequestOptions = { signal, fetcher, sleep }
  try {
    const { accountId } = await signInWithMicrosoft({ clientId, scope: MICROSOFT_CONTACTS_SCOPE, win, popup, ...(fetcher ? { fetcher } : {}) })
    throwIfAborted(signal)
    // The default Contacts folder; /me/contactFolders lists the folders below it.
    const read: FolderContact[] = await readFolderContacts('/me/contacts', request)
    const visited = new Set<string>()
    const walk = async (path: string, depth: number): Promise<void> => {
      if (depth > MAX_FOLDER_DEPTH) throw new MicrosoftImportError('Your Outlook contact folders are nested too deeply to import.')
      const folders = await graphGetAllPages<GraphContactFolder>(graphUrl(path, { $select: 'id,displayName', $top: PAGE_SIZE }), request)
      for (const folder of folders) {
        if (typeof folder.id !== 'string' || !folder.id || visited.has(folder.id)) continue
        visited.add(folder.id)
        throwIfAborted(signal)
        const id = encodeURIComponent(folder.id)
        read.push(...await readFolderContacts(`/me/contactFolders/${id}/contacts`, request, folder.displayName))
        await walk(`/me/contactFolders/${id}/childFolders`, depth + 1)
      }
    }
    await walk('/me/contactFolders', 1)
    return mapMicrosoftContacts(accountId, read)
  } finally {
    clearMicrosoftAccessToken()
  }
}
