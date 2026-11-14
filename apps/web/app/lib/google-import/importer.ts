import type { ProviderImportVEvent } from '@/app/components/import/import-mappers'
import { mapGoogleCalendarEvents, isGoogleBirthdayCalendar, type GoogleCalendar, type GoogleEvent } from './calendar-mapper'
import { mapGooglePeople, type GoogleContactGroup, type GooglePerson, type ProviderImportVCard } from './contact-mapper'
import { GOOGLE_CALENDAR_API, GOOGLE_PEOPLE_API, googleGet, googleGetAllPages, type GoogleRequestOptions } from './google-api'
import { GOOGLE_CALENDAR_SCOPE, GOOGLE_CONTACTS_SCOPE, clearGoogleAccessToken, signInWithGoogle } from './oauth'

/*
 * Entry points of the Google import (#48), loaded with a dynamic import() only when the user
 * starts it. Each run signs in, reads everything it needs, maps it, and drops the token
 * before returning or failing. Writing happens afterwards through the existing import
 * components, which encrypt each item with the Etebase client before upload.
 */

export class GoogleImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoogleImportError'
  }
}

export interface GoogleImportOptions extends GoogleRequestOptions {
  clientId: string
  win?: Window
  popup?: Window | null
}

export interface GoogleCalendarSource {
  id: string
  name: string
  color?: string
  units: ProviderImportVEvent[]
}

export interface GoogleCalendarImport {
  calendars: GoogleCalendarSource[]
  unreadable: number
}

const COLOR = /^#[0-9a-f]{6}$/i

/** Drops the token and stops a sign-in still waiting for its popup. */
export function cancelGoogleImport(): void {
  clearGoogleAccessToken()
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new GoogleImportError('Google import was cancelled.')
}

export async function loadGoogleCalendars({ clientId, win, popup, signal, fetcher }: GoogleImportOptions): Promise<GoogleCalendarImport> {
  const request = { signal, fetcher }
  try {
    await signInWithGoogle({ clientId, scopes: [GOOGLE_CALENDAR_SCOPE], win, popup })
    throwIfAborted(signal)
    const listUrl = new URL(`${GOOGLE_CALENDAR_API}/users/me/calendarList`)
    listUrl.searchParams.set('maxResults', '250')
    const calendars = await googleGetAllPages<GoogleCalendar>(listUrl, 'items', request)
    // The primary calendar's id is the account's address: the account part of each source key.
    const accountId = calendars.find((calendar) => calendar.primary)?.id
    if (!accountId) throw new GoogleImportError('Could not identify the Google account. Please try again.')
    const result: GoogleCalendarImport = { calendars: [], unreadable: 0 }
    for (const calendar of calendars) {
      if (typeof calendar.id !== 'string' || isGoogleBirthdayCalendar(calendar)) continue
      throwIfAborted(signal)
      const eventsUrl = new URL(`${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendar.id)}/events`)
      // Series come as masters plus their changed and cancelled occurrences, never expanded.
      eventsUrl.searchParams.set('singleEvents', 'false')
      eventsUrl.searchParams.set('showDeleted', 'false')
      eventsUrl.searchParams.set('maxResults', '2500')
      const events = await googleGetAllPages<GoogleEvent>(eventsUrl, 'items', request)
      const mapped = mapGoogleCalendarEvents(accountId, calendar, events)
      result.unreadable += mapped.unreadable
      if (mapped.units.length === 0) continue
      const color = calendar.backgroundColor && COLOR.test(calendar.backgroundColor) ? calendar.backgroundColor : undefined
      result.calendars.push({
        id: calendar.id,
        name: (calendar.summaryOverride || calendar.summary || 'Google Calendar').trim(),
        ...(color ? { color } : {}),
        units: mapped.units,
      })
    }
    return result
  } finally {
    clearGoogleAccessToken()
  }
}

export async function loadGoogleContacts({ clientId, win, popup, signal, fetcher }: GoogleImportOptions): Promise<ProviderImportVCard[]> {
  const request = { signal, fetcher }
  try {
    await signInWithGoogle({ clientId, scopes: [GOOGLE_CONTACTS_SCOPE], win, popup })
    throwIfAborted(signal)
    // people/me names the signed-in account: the account part of each source key.
    const meUrl = new URL(`${GOOGLE_PEOPLE_API}/people/me`)
    meUrl.searchParams.set('personFields', 'metadata')
    const me = await googleGet<{ resourceName?: unknown }>(meUrl, request)
    if (typeof me.resourceName !== 'string' || !me.resourceName) {
      throw new GoogleImportError('Could not identify the Google account. Please try again.')
    }
    const groupsUrl = new URL(`${GOOGLE_PEOPLE_API}/contactGroups`)
    groupsUrl.searchParams.set('pageSize', '1000')
    groupsUrl.searchParams.set('groupFields', 'name,groupType')
    const groups = await googleGetAllPages<GoogleContactGroup>(groupsUrl, 'contactGroups', request)
    throwIfAborted(signal)
    const peopleUrl = new URL(`${GOOGLE_PEOPLE_API}/people/me/connections`)
    peopleUrl.searchParams.set('pageSize', '1000')
    peopleUrl.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers,addresses,birthdays,biographies,organizations,memberships')
    const people = await googleGetAllPages<GooglePerson>(peopleUrl, 'connections', request)
    return mapGooglePeople(me.resourceName, people, groups)
  } finally {
    clearGoogleAccessToken()
  }
}
