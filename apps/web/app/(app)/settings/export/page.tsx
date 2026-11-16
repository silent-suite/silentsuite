'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@silentsuite/ui'
import { toVEvent, toVTodo, toVCard, type CalendarEvent, type Task, type Contact } from '@silentsuite/core'
import { useTaskStore } from '@/app/stores/use-task-store'
import { useContactStore } from '@/app/stores/use-contact-store'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { useTaskListStore } from '@/app/stores/use-task-list-store'
import { useContactListStore } from '@/app/stores/use-contact-list-store'
import { useNotebookStore } from '@/app/stores/use-notebook-store'
import { useSyncStore } from '@/app/stores/use-sync-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { isSnapshotApplied, useDomainSnapshotStore } from '@/app/stores/use-domain-snapshot-store'
import {
  showErrorToast,
  showWarningToast,
} from '@/app/stores/use-toast-store'
import { Download, Loader2 } from 'lucide-react'
import JSZip from 'jszip'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'
import { AccountBoundaryChangedError, getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import { isOfflineError } from '@/app/lib/offline-queue'
import {
  buildNotesArchive,
  listAllNotebookItems,
  readNotesForExport,
  type ExportableNoteItem,
} from '@/app/lib/notes-export'

/**
 * Above this combined item count we surface a "this may take a minute" warning
 * before kicking off the ZIP export.
 */
const LARGE_EXPORT_THRESHOLD = 1000

/** Sentinel value meaning "export every collection of this type". */
const ALL_COLLECTIONS = 'all'

/** Folder that holds the notebooks inside the all-data ZIP. */
const NOTES_ZIP_FOLDER = 'silentsuite-notes'

/**
 * Domains this page exports. Calendar, tasks and contacts are serialized from
 * their UI stores. Notes are listed from the server again when an export runs
 * (see addNotesToZip), and only gate an export when the account has at least
 * one notebook.
 */
type StoreDomain = 'calendar' | 'tasks' | 'contacts'
type ExportDomain = StoreDomain | 'notes'
const STORE_DOMAINS: readonly StoreDomain[] = ['calendar', 'tasks', 'contacts']
const DOMAIN_LABELS: Record<ExportDomain, string> = {
  calendar: 'Calendar',
  tasks: 'Tasks',
  contacts: 'Contacts',
  notes: 'Notes',
}

/**
 * Current load state, read at click time. 'loaded' means this session's last
 * full enumeration of the domain succeeded. For calendar, tasks and contacts
 * that snapshot must also have reached the store this page serializes: the
 * server read finishes before the decrypted items arrive there. Notes are not
 * serialized from a store (the export lists them from the server again), so no
 * store snapshot applies to them; their load state still has to be 'loaded',
 * so the counts on screen and the export start from a complete load.
 * 'unknown' or 'failed' means the items on screen may be incomplete or stale,
 * so they are not exported as if they were complete. 'loaded' is not proof of
 * every historical server item, of later remote changes, or of pending offline
 * edits.
 */
function isDomainLoaded(domain: ExportDomain): boolean {
  const loaded = useEtebaseStore.getState().domainLoadState[domain] === 'loaded'
  if (domain === 'notes') return loaded
  return loaded && isSnapshotApplied(useDomainSnapshotStore.getState().appliedEpoch, domain)
}

/** A notebook's own name from its encrypted metadata, or '' when it has none or cannot be read. */
function collectionName(collection: { getMeta?: () => { name?: unknown } }): string {
  try {
    const name = collection.getMeta?.()?.name
    return typeof name === 'string' ? name : ''
  } catch {
    return ''
  }
}

/** Whether the current account has notebooks, read at click time. */
function hasNotebooksNow(): boolean {
  return useEtebaseStore.getState().collections.notes.length > 0
}

/** Domains the all-data ZIP holds right now: Notes only when there is a notebook. */
function archiveDomainsNow(): readonly ExportDomain[] {
  return hasNotebooksNow() ? [...STORE_DOMAINS, 'notes'] : STORE_DOMAINS
}

/** Refuse an export whose domains have not finished loading, without writing a file. */
function refuseUnloaded(domains: readonly ExportDomain[]) {
  const names = domains.map((domain) => DOMAIN_LABELS[domain]).join(', ')
  showWarningToast(
    `${names} ${domains.length === 1 ? "hasn't" : "haven't"} finished loading, so nothing was exported. Sync again, then export.`,
  )
}

function downloadFile(content: string | Blob | Uint8Array, filename: string, mimeType: string) {
  const blob =
    content instanceof Blob
      ? content
      : new Blob([content as BlobPart], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function buildCalendarIcs(vcomponents: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SilentSuite//EN',
    ...vcomponents,
    'END:VCALENDAR',
  ].join('\r\n')
}

/** UTF-8 byte order mark. The serializer emits vCard 3.0, which (unlike 4.0)
 * does not imply a charset; a downloaded file has no MIME charset either, so
 * some importers guess a legacy encoding. The BOM is an in-band UTF-8 hint
 * added only to exported files — never to individual cards or synced data. */
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf])

/** Build the bytes of a multi-card .vcf file: UTF-8 BOM, then each card
 * terminated by CRLF as the vCard grammar requires. No cards → empty file. */
function buildContactsVcf(vcomponents: string[]): Uint8Array {
  if (vcomponents.length === 0) return new Uint8Array(0)
  const body = new TextEncoder().encode(vcomponents.map((card) => `${card}\r\n`).join(''))
  const bytes = new Uint8Array(UTF8_BOM.length + body.length)
  bytes.set(UTF8_BOM)
  bytes.set(body, UTF8_BOM.length)
  return bytes
}

/** Serialize each item independently and skip the ones that throw, so a single
 * malformed event doesn't take the whole export down silently. Returns the
 * successfully-serialized payload plus a count of skipped items, which we
 * surface in a warning toast.
 */
function serializeAll<T>(items: T[], serialize: (item: T) => string): { vcomponents: string[]; skipped: number } {
  const vcomponents: string[] = []
  let skipped = 0
  for (const item of items) {
    try {
      vcomponents.push(serialize(item))
    } catch (err) {
      skipped++
      console.warn('[export] Skipped item that failed to serialize', getSafeErrorDetails(err))
    }
  }
  return { vcomponents, skipped }
}

function serializeEvents(events: CalendarEvent[]) {
  return serializeAll(events, toVEvent)
}

function serializeTasks(tasks: Task[]) {
  return serializeAll(tasks, toVTodo)
}

function serializeContacts(contacts: Contact[]) {
  return serializeAll(contacts, toVCard)
}

function reportSkipped(label: string, skipped: number) {
  if (skipped > 0) {
    showWarningToast(
      `${skipped} ${label}${skipped === 1 ? '' : 's'} were skipped because they couldn't be serialized.`,
    )
  }
}

function reportError(label: string, err: unknown) {
  console.error(`[export] ${label} failed`, getSafeErrorDetails(err))
  showErrorToast(`${label} failed. Please try again.`)
}

/** Reduce an arbitrary collection name to a filename-safe slug.
 * e.g. "Work & Travel!!" -> "work-travel". Falls back to "collection" if the
 * name contains no usable characters. */
function sanitizeCollectionName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'collection'
  )
}

/** Build a download filename for a single-type export. When `collectionId` is
 * `ALL_COLLECTIONS` the legacy aggregate filename is used; otherwise the
 * sanitized collection name is appended so each exported file is
 * distinguishable. */
function buildExportFilename(
  prefix: 'calendar' | 'tasks' | 'contacts' | 'notes',
  extension: 'ics' | 'vcf' | 'zip',
  collectionId: string,
  collections: ReadonlyArray<{ id: string; name: string }>,
): string {
  if (collectionId === ALL_COLLECTIONS) {
    return `silentsuite-${prefix}.${extension}`
  }
  const collection = collections.find((c) => c.id === collectionId)
  const slug = sanitizeCollectionName(collection?.name ?? collectionId)
  return `silentsuite-${prefix}-${slug}.${extension}`
}

export default function ExportPage() {
  const t = useTranslations('SettingsExport')
  const tNotes = useTranslations('Notes')
  const tasks = useTaskStore((s) => s.tasks)
  const contacts = useContactStore((s) => s.contacts)
  const events = useCalendarStore((s) => s.events)

  const calendars = useCalendarListStore((s) => s.calendars)
  const taskLists = useTaskListStore((s) => s.lists)
  const contactLists = useContactListStore((s) => s.lists)

  // Notes are offered whenever the account has a notebook, whatever the
  // experimental Notes switch says: notes already on the account stay exportable.
  const noteCollections = useEtebaseStore((s) => s.collections.notes)
  const itemTypeMap = useEtebaseStore((s) => s.itemTypeMap)
  const itemCollectionMap = useEtebaseStore((s) => s.itemCollectionMap)
  const notebookLists = useNotebookStore((s) => s.lists)
  const queuedChanges = useSyncStore((s) => s.pendingQueueCount + s.failedQueueCount + s.heldQueueCount)

  const notebooks = useMemo(() => {
    const names = new Map(notebookLists.map((list) => [list.id, list.name]))
    return (noteCollections as { uid: string }[]).map((collection) => ({
      id: collection.uid,
      name: names.get(collection.uid) ?? '',
    }))
  }, [noteCollections, notebookLists])
  const hasNotebooks = notebooks.length > 0

  // The counts shown come from the items this device listed. The export lists
  // the server again and reports any note it had to leave out.
  const noteCounts = useMemo(() => {
    const perNotebook = new Map<string, number>()
    let total = 0
    for (const [uid, type] of itemTypeMap) {
      if (type !== 'notes') continue
      total += 1
      const notebookId = itemCollectionMap.get(uid)
      if (notebookId) perNotebook.set(notebookId, (perNotebook.get(notebookId) ?? 0) + 1)
    }
    return { total, perNotebook }
  }, [itemTypeMap, itemCollectionMap])

  const domainStatus: Record<ExportDomain, string> = {
    calendar: useEtebaseStore((s) => s.domainLoadState.calendar),
    tasks: useEtebaseStore((s) => s.domainLoadState.tasks),
    contacts: useEtebaseStore((s) => s.domainLoadState.contacts),
    notes: useEtebaseStore((s) => s.domainLoadState.notes),
  }
  // Initialization still running: an 'unknown' domain may load on its own.
  const initializing = useEtebaseStore((s) => !s.isInitialized && !s.restoreBlocked)
  const appliedEpoch = useDomainSnapshotStore((s) => s.appliedEpoch)
  // Loaded on the server but not yet in the store: still loading, not failed.
  const awaitingStore = (domain: ExportDomain) =>
    domain !== 'notes' && domainStatus[domain] === 'loaded' && !isSnapshotApplied(appliedEpoch, domain)
  const shownDomains: readonly ExportDomain[] = hasNotebooks ? [...STORE_DOMAINS, 'notes'] : STORE_DOMAINS
  const unloadedDomains = shownDomains.filter(
    (domain) => domainStatus[domain] !== 'loaded' || awaitingStore(domain),
  )

  const [selectedCalendarId, setSelectedCalendarId] = useState(ALL_COLLECTIONS)
  const [selectedTaskListId, setSelectedTaskListId] = useState(ALL_COLLECTIONS)
  const [selectedContactListId, setSelectedContactListId] = useState(ALL_COLLECTIONS)
  const [selectedNotebookId, setSelectedNotebookId] = useState(ALL_COLLECTIONS)

  const [isExportingAll, setIsExportingAll] = useState(false)
  const [isExportingNotes, setIsExportingNotes] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)

  const filteredNoteCount =
    selectedNotebookId === ALL_COLLECTIONS
      ? noteCounts.total
      : noteCounts.perNotebook.get(selectedNotebookId) ?? 0

  const filteredEvents = useMemo(
    () =>
      selectedCalendarId === ALL_COLLECTIONS
        ? events
        : events.filter((event) => (event.calendarId ?? 'default') === selectedCalendarId),
    [events, selectedCalendarId],
  )
  const filteredTasks = useMemo(
    () =>
      selectedTaskListId === ALL_COLLECTIONS
        ? tasks
        : tasks.filter((task) => (task.listId ?? 'default') === selectedTaskListId),
    [tasks, selectedTaskListId],
  )
  const filteredContacts = useMemo(
    () =>
      selectedContactListId === ALL_COLLECTIONS
        ? contacts
        : contacts.filter((contact) => (contact.listId ?? 'default') === selectedContactListId),
    [contacts, selectedContactListId],
  )

  function exportCalendar() {
    if (!isDomainLoaded('calendar')) return refuseUnloaded(['calendar'])
    try {
      const { vcomponents, skipped } = serializeEvents(filteredEvents)
      const ics = buildCalendarIcs(vcomponents)
      const filename = buildExportFilename('calendar', 'ics', selectedCalendarId, calendars)
      downloadFile(ics, filename, 'text/calendar')
      reportSkipped('event', skipped)
    } catch (err) {
      reportError('Calendar export', err)
    }
  }

  function exportTasks() {
    if (!isDomainLoaded('tasks')) return refuseUnloaded(['tasks'])
    try {
      const { vcomponents, skipped } = serializeTasks(filteredTasks)
      const ics = buildCalendarIcs(vcomponents)
      const filename = buildExportFilename('tasks', 'ics', selectedTaskListId, taskLists)
      downloadFile(ics, filename, 'text/calendar')
      reportSkipped('task', skipped)
    } catch (err) {
      reportError('Tasks export', err)
    }
  }

  function exportContacts() {
    if (!isDomainLoaded('contacts')) return refuseUnloaded(['contacts'])
    try {
      const { vcomponents, skipped } = serializeContacts(filteredContacts)
      const vcf = buildContactsVcf(vcomponents)
      const filename = buildExportFilename('contacts', 'vcf', selectedContactListId, contactLists)
      downloadFile(vcf, filename, 'text/vcard')
      reportSkipped('contact', skipped)
    } catch (err) {
      reportError('Contacts export', err)
    }
  }

  function reportUnreadableNotes(count: number) {
    if (count > 0) showWarningToast(t('notesLeftOut', { count }))
  }

  /**
   * Notes are listed from the server again, so an export with notes can fail
   * for want of a connection. The Notes button's own failure text is
   * translated; the all-data ZIP keeps the page's existing English text.
   */
  function reportNotesFailure(label: 'Notes export' | 'ZIP build', err: unknown) {
    if (isOfflineError(err)) {
      console.error(`[export] ${label} failed while offline`, getSafeErrorDetails(err))
      showErrorToast(t('notesNeedConnection'))
      return
    }
    if (label === 'ZIP build') return reportError(label, err)
    console.error(`[export] ${label} failed`, getSafeErrorDetails(err))
    showErrorToast(t('notesExportFailed'))
  }

  /**
   * Lists the notebooks, or the chosen one, and their items from the server
   * again, decrypts each note in the browser, and adds one folder per notebook
   * and one Markdown file per note to `zip` under `prefix`. The store is not
   * used for the items: a sync refresh drops a note this device cannot decrypt
   * from it, and such a note must still be counted. Throws
   * AccountBoundaryChangedError if the account changes meanwhile, and
   * NotesListingError if a listing does not finish. Returns how many notes
   * were left out.
   */
  async function addNotesToZip(zip: JSZip, prefix: string, accountEpoch: number, notebookId?: string): Promise<number> {
    const isCurrent = () => isCurrentAccountEpoch(accountEpoch)
    const { account } = useEtebaseStore.getState()
    if (!account) throw new Error('No account to export notes from')
    const core = await import('@silentsuite/core')
    if (!isCurrent()) throw new AccountBoundaryChangedError()
    // core listCollections already fails closed on a missing or repeated cursor and a page cap.
    const collections = (await core.listCollections(account, core.COLLECTION_TYPE_NOTES))
      .filter((collection) => notebookId === undefined || collection.uid === notebookId)
    if (!isCurrent()) throw new AccountBoundaryChangedError()
    if (notebookId !== undefined && collections.length === 0) throw new Error('The chosen notebook is no longer listed')

    const names = new Map(useNotebookStore.getState().lists.map((list) => [list.id, list.name]))
    const notebooksNow = collections.map((collection) => ({
      id: collection.uid,
      name: names.get(collection.uid) ?? collectionName(collection),
    }))
    const listed: { id: string; items: ExportableNoteItem[] }[] = []
    for (const collection of collections) {
      const items = await listAllNotebookItems((stoken) => core.listItems(account, collection, stoken), isCurrent)
      listed.push({ id: collection.uid, items })
    }
    const { notes, unreadable } = await readNotesForExport(listed, { isCurrent })
    const archive = buildNotesArchive(notebooksNow, notes, {
      notebook: t('notebookFallback'),
      untitled: tNotes('untitled'),
    })
    for (const folder of archive.folders) zip.folder(`${prefix}${folder}`)
    for (const file of archive.files) zip.file(`${prefix}${file.path}`, file.bytes)
    return unreadable
  }

  async function exportNotes() {
    if (isExportingNotes || isExportingAll) return
    if (!isDomainLoaded('notes')) return refuseUnloaded(['notes'])
    const accountEpoch = getAccountEpoch()
    const notebookId = selectedNotebookId === ALL_COLLECTIONS ? undefined : selectedNotebookId
    setIsExportingNotes(true)
    try {
      const zip = new JSZip()
      const unreadable = await addNotesToZip(zip, '', accountEpoch, notebookId)
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true })
      // Nothing from an account that has since signed out is downloaded.
      if (!isCurrentAccountEpoch(accountEpoch)) return
      downloadFile(blob, buildExportFilename('notes', 'zip', selectedNotebookId, notebooks), 'application/zip')
      reportUnreadableNotes(unreadable)
    } catch (err) {
      if (err instanceof AccountBoundaryChangedError || !isCurrentAccountEpoch(accountEpoch)) return
      reportNotesFailure('Notes export', err)
    } finally {
      setIsExportingNotes(false)
    }
  }

  async function exportAll() {
    if (isExportingAll || isExportingNotes) return

    // Every domain in the archive must have loaded, checked before any busy
    // state or archive work so a refused export writes nothing.
    const archiveDomains = archiveDomainsNow()
    const notLoaded = archiveDomains.filter((domain) => !isDomainLoaded(domain))
    if (notLoaded.length > 0) return refuseUnloaded(notLoaded)
    const includeNotes = archiveDomains.includes('notes')
    const accountEpoch = getAccountEpoch()

    // The ZIP is intentionally an all-data export: it always includes every
    // calendar, task list, address book and notebook regardless of the
    // per-type selections above. Per-collection exports use the individual
    // buttons.
    const totalItems = events.length + tasks.length + contacts.length + (includeNotes ? noteCounts.total : 0)

    setIsExportingAll(true)
    setExportProgress(0)

    if (totalItems > LARGE_EXPORT_THRESHOLD) {
      showWarningToast(
        `Preparing export of ${totalItems.toLocaleString()} items. This may take a minute…`,
      )
    }

    try {
      const zip = new JSZip()
      const enc = new TextEncoder()

      const eventsResult = serializeEvents(events)
      const tasksResult = serializeTasks(tasks)
      const contactsResult = serializeContacts(contacts)

      // Pre-encode payloads as UTF-8 byte arrays before handing to JSZip. JSZip's
      // string path runs the entire file through DEFLATE in a synchronous loop
      // before the async pump kicks in — for multi-megabyte ICS strings this
      // can blow the call stack ("RangeError: Maximum call stack size exceeded")
      // or stall the main thread for tens of seconds. Uint8Array input bypasses
      // the string-tokenization step. Combined with `compression: 'STORE'` (no
      // DEFLATE — text payloads are already small and the ZIP framing is the
      // value here, not the savings), this makes the build robust at scale.
      zip.file('silentsuite-calendar.ics', enc.encode(buildCalendarIcs(eventsResult.vcomponents)))
      zip.file('silentsuite-tasks.ics', enc.encode(buildCalendarIcs(tasksResult.vcomponents)))
      zip.file('silentsuite-contacts.vcf', buildContactsVcf(contactsResult.vcomponents))
      const unreadableNotes = includeNotes ? await addNotesToZip(zip, `${NOTES_ZIP_FOLDER}/`, accountEpoch) : 0

      // Throttle progress updates: only re-render when the integer percent
      // changes. JSZip can fire onUpdate hundreds of times per second.
      let lastReportedPercent = -1

      const blob = await zip.generateAsync(
        { type: 'blob', compression: 'STORE', streamFiles: true },
        (metadata) => {
          const percent = Math.floor(metadata.percent)
          if (percent !== lastReportedPercent) {
            lastReportedPercent = percent
            setExportProgress(percent)
          }
        },
      )

      // Notes are decrypted across awaits: nothing from an account that has
      // since signed out is downloaded.
      if (!isCurrentAccountEpoch(accountEpoch)) return
      downloadFile(blob, 'silentsuite-export.zip', 'application/zip')
      reportSkipped('item', eventsResult.skipped + tasksResult.skipped + contactsResult.skipped)
      reportUnreadableNotes(unreadableNotes)
    } catch (err) {
      if (err instanceof AccountBoundaryChangedError || !isCurrentAccountEpoch(accountEpoch)) return
      if (includeNotes) reportNotesFailure('ZIP build', err)
      else reportError('ZIP build', err)
    } finally {
      setIsExportingAll(false)
      setExportProgress(0)
    }
  }

  const totalItems = events.length + tasks.length + contacts.length + (hasNotebooks ? noteCounts.total : 0)
  const exportAllDisabled = totalItems === 0 || isExportingAll || isExportingNotes || unloadedDomains.length > 0

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-[rgb(var(--foreground))]">Export Data</h1>
      <p className="text-sm text-[rgb(var(--muted))]">
        Download your data in standard formats (ICS, VCF, Markdown). Your data is always yours.
      </p>

      {unloadedDomains.length > 0 && (
        <div role="status" className="space-y-1 text-sm text-amber-600 dark:text-amber-400">
          {unloadedDomains.map((domain) => (
            <p key={domain}>
              {(domainStatus[domain] === 'unknown' && initializing) || awaitingStore(domain)
                ? `${DOMAIN_LABELS[domain]} is still loading, so it can't be exported yet.`
                : `${DOMAIN_LABELS[domain]} didn't finish loading on this device, so it can't be exported. Sync again, then export.`}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-5">
        {/* Calendar */}
        <div className="flex flex-col gap-2">
          <label
            htmlFor="export-calendar-select"
            className="text-sm font-medium text-[rgb(var(--foreground))]"
          >
            Calendar
          </label>
          <select
            id="export-calendar-select"
            aria-label="Calendar collection"
            value={selectedCalendarId}
            onChange={(e) => setSelectedCalendarId(e.target.value)}
            className="w-full max-w-xs rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-2 py-1.5 text-sm text-[rgb(var(--foreground))] focus:outline-none focus:ring-1 focus:ring-emerald-500"
          >
            <option value={ALL_COLLECTIONS}>All calendars</option>
            {calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.name}
              </option>
            ))}
          </select>
          <Button
            className="w-full sm:w-auto"
            disabled={filteredEvents.length === 0 || isExportingAll || unloadedDomains.includes('calendar')}
            onClick={exportCalendar}
          >
            <Download className="mr-2 h-4 w-4" />
            Export Calendar ({filteredEvents.length} {filteredEvents.length === 1 ? 'event' : 'events'})
          </Button>
        </div>

        {/* Tasks */}
        <div className="flex flex-col gap-2">
          <label
            htmlFor="export-tasks-select"
            className="text-sm font-medium text-[rgb(var(--foreground))]"
          >
            Task list
          </label>
          <select
            id="export-tasks-select"
            aria-label="Task list collection"
            value={selectedTaskListId}
            onChange={(e) => setSelectedTaskListId(e.target.value)}
            className="w-full max-w-xs rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-2 py-1.5 text-sm text-[rgb(var(--foreground))] focus:outline-none focus:ring-1 focus:ring-emerald-500"
          >
            <option value={ALL_COLLECTIONS}>All task lists</option>
            {taskLists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
          </select>
          <Button
            className="w-full sm:w-auto"
            disabled={filteredTasks.length === 0 || isExportingAll || unloadedDomains.includes('tasks')}
            onClick={exportTasks}
          >
            <Download className="mr-2 h-4 w-4" />
            Export Tasks ({filteredTasks.length} {filteredTasks.length === 1 ? 'task' : 'tasks'})
          </Button>
        </div>

        {/* Contacts */}
        <div className="flex flex-col gap-2">
          <label
            htmlFor="export-contacts-select"
            className="text-sm font-medium text-[rgb(var(--foreground))]"
          >
            Address book
          </label>
          <select
            id="export-contacts-select"
            aria-label="Address book collection"
            value={selectedContactListId}
            onChange={(e) => setSelectedContactListId(e.target.value)}
            className="w-full max-w-xs rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-2 py-1.5 text-sm text-[rgb(var(--foreground))] focus:outline-none focus:ring-1 focus:ring-emerald-500"
          >
            <option value={ALL_COLLECTIONS}>All address books</option>
            {contactLists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
          </select>
          <Button
            className="w-full sm:w-auto"
            disabled={filteredContacts.length === 0 || isExportingAll || unloadedDomains.includes('contacts')}
            onClick={exportContacts}
          >
            <Download className="mr-2 h-4 w-4" />
            Export Contacts ({filteredContacts.length} {filteredContacts.length === 1 ? 'contact' : 'contacts'})
          </Button>
        </div>

        {/* Notes: shown whenever the account has a notebook. */}
        {hasNotebooks && (
          <div className="flex flex-col gap-2">
            <label
              htmlFor="export-notes-select"
              className="text-sm font-medium text-[rgb(var(--foreground))]"
            >
              {t('notebookLabel')}
            </label>
            <select
              id="export-notes-select"
              aria-label={t('notebookSelectLabel')}
              value={selectedNotebookId}
              onChange={(e) => setSelectedNotebookId(e.target.value)}
              className="w-full max-w-xs rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-2 py-1.5 text-sm text-[rgb(var(--foreground))] focus:outline-none focus:ring-1 focus:ring-emerald-500"
            >
              <option value={ALL_COLLECTIONS}>{t('allNotebooks')}</option>
              {notebooks.map((notebook) => (
                <option key={notebook.id} value={notebook.id}>
                  {notebook.name || t('notebookFallback')}
                </option>
              ))}
            </select>
            <Button
              className="w-full sm:w-auto"
              disabled={filteredNoteCount === 0 || isExportingAll || isExportingNotes || unloadedDomains.includes('notes')}
              onClick={exportNotes}
              aria-busy={isExportingNotes}
            >
              {isExportingNotes ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('preparingNotes')}
                </>
              ) : (
                <>
                  <Download className="mr-2 h-4 w-4" />
                  {t('exportNotes', { count: filteredNoteCount })}
                </>
              )}
            </Button>
            <p className="text-xs text-[rgb(var(--muted))]">{t('notesFormat')}</p>
            {queuedChanges > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">{t('notesWaitingToSync')}</p>
            )}
          </div>
        )}

        {/* All-data ZIP — always exports every collection, independent of the
            per-type selections above. */}
        <div className="flex flex-col gap-1 border-t border-[rgb(var(--border))] pt-5">
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            disabled={exportAllDisabled}
            onClick={exportAll}
            aria-busy={isExportingAll}
          >
            {isExportingAll ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Preparing… {exportProgress}%
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                Export All Data (.zip)
              </>
            )}
          </Button>
          <p className="text-xs text-[rgb(var(--muted))]">
            {hasNotebooks
              ? t('allDataWithNotes')
              : 'Includes every calendar, task list, and address book in a single archive.'}
          </p>
        </div>
      </div>
    </div>
  )
}
