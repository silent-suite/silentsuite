'use client'

import { useMemo, useState } from 'react'
import { Button } from '@silentsuite/ui'
import { toVEvent, toVTodo, toVCard, type CalendarEvent, type Task, type Contact } from '@silentsuite/core'
import { useTaskStore } from '@/app/stores/use-task-store'
import { useContactStore } from '@/app/stores/use-contact-store'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { useTaskListStore } from '@/app/stores/use-task-list-store'
import { useContactListStore } from '@/app/stores/use-contact-list-store'
import {
  showErrorToast,
  showWarningToast,
} from '@/app/stores/use-toast-store'
import { Download, Loader2 } from 'lucide-react'
import JSZip from 'jszip'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'

/**
 * Above this combined item count we surface a "this may take a minute" warning
 * before kicking off the ZIP export.
 */
const LARGE_EXPORT_THRESHOLD = 1000

/** Sentinel value meaning "export every collection of this type". */
const ALL_COLLECTIONS = 'all'

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
  prefix: 'calendar' | 'tasks' | 'contacts',
  extension: 'ics' | 'vcf',
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
  const tasks = useTaskStore((s) => s.tasks)
  const contacts = useContactStore((s) => s.contacts)
  const events = useCalendarStore((s) => s.events)

  const calendars = useCalendarListStore((s) => s.calendars)
  const taskLists = useTaskListStore((s) => s.lists)
  const contactLists = useContactListStore((s) => s.lists)

  const [selectedCalendarId, setSelectedCalendarId] = useState(ALL_COLLECTIONS)
  const [selectedTaskListId, setSelectedTaskListId] = useState(ALL_COLLECTIONS)
  const [selectedContactListId, setSelectedContactListId] = useState(ALL_COLLECTIONS)

  const [isExportingAll, setIsExportingAll] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)

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
    try {
      const { vcomponents, skipped } = serializeContacts(filteredContacts)
      const vcf = vcomponents.join('\n')
      const filename = buildExportFilename('contacts', 'vcf', selectedContactListId, contactLists)
      downloadFile(vcf, filename, 'text/vcard')
      reportSkipped('contact', skipped)
    } catch (err) {
      reportError('Contacts export', err)
    }
  }

  async function exportAll() {
    if (isExportingAll) return

    // The ZIP is intentionally an all-data export: it always includes every
    // calendar, task list, and address book regardless of the per-type
    // selections above. Per-collection exports use the individual buttons.
    const totalItems = events.length + tasks.length + contacts.length

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
      zip.file('silentsuite-contacts.vcf', enc.encode(contactsResult.vcomponents.join('\n')))

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

      downloadFile(blob, 'silentsuite-export.zip', 'application/zip')
      reportSkipped('item', eventsResult.skipped + tasksResult.skipped + contactsResult.skipped)
    } catch (err) {
      reportError('ZIP build', err)
    } finally {
      setIsExportingAll(false)
      setExportProgress(0)
    }
  }

  const totalItems = events.length + tasks.length + contacts.length
  const exportAllDisabled = totalItems === 0 || isExportingAll

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-[rgb(var(--foreground))]">Export Data</h1>
      <p className="text-sm text-[rgb(var(--muted))]">
        Download your data in standard formats (ICS, VCF). Your data is always yours.
      </p>

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
            disabled={filteredEvents.length === 0 || isExportingAll}
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
            disabled={filteredTasks.length === 0 || isExportingAll}
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
            disabled={filteredContacts.length === 0 || isExportingAll}
            onClick={exportContacts}
          >
            <Download className="mr-2 h-4 w-4" />
            Export Contacts ({filteredContacts.length} {filteredContacts.length === 1 ? 'contact' : 'contacts'})
          </Button>
        </div>

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
            Includes every calendar, task list, and address book in a single archive.
          </p>
        </div>
      </div>
    </div>
  )
}
