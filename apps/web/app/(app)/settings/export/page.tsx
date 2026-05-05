'use client'

import { useState } from 'react'
import { Button } from '@silentsuite/ui'
import { toVEvent, toVTodo, toVCard, type CalendarEvent, type Task, type Contact } from '@silentsuite/core'
import { useTaskStore } from '@/app/stores/use-task-store'
import { useContactStore } from '@/app/stores/use-contact-store'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import {
  showErrorToast,
  showWarningToast,
} from '@/app/stores/use-toast-store'
import { Download, Loader2 } from 'lucide-react'
import JSZip from 'jszip'

/**
 * Above this combined item count we surface a "this may take a minute" warning
 * before kicking off the ZIP export.
 */
const LARGE_EXPORT_THRESHOLD = 1000

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
      console.warn('[export] Skipped item that failed to serialize:', err, item)
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
      `${skipped} ${label}${skipped === 1 ? '' : 's'} were skipped because they couldn't be serialized — see browser console for details.`,
    )
  }
}

function reportError(label: string, err: unknown) {
  console.error(`[export] ${label} failed:`, err)
  const detail = err instanceof Error ? `: ${err.message}` : ''
  showErrorToast(`${label} failed${detail}. See browser console for details.`)
}

export default function ExportPage() {
  const tasks = useTaskStore((s) => s.tasks)
  const contacts = useContactStore((s) => s.contacts)
  const events = useCalendarStore((s) => s.events)

  const [isExportingAll, setIsExportingAll] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)

  function exportCalendar() {
    try {
      const { vcomponents, skipped } = serializeEvents(events)
      const ics = buildCalendarIcs(vcomponents)
      downloadFile(ics, 'silentsuite-calendar.ics', 'text/calendar')
      reportSkipped('event', skipped)
    } catch (err) {
      reportError('Calendar export', err)
    }
  }

  function exportTasks() {
    try {
      const { vcomponents, skipped } = serializeTasks(tasks)
      const ics = buildCalendarIcs(vcomponents)
      downloadFile(ics, 'silentsuite-tasks.ics', 'text/calendar')
      reportSkipped('task', skipped)
    } catch (err) {
      reportError('Tasks export', err)
    }
  }

  function exportContacts() {
    try {
      const { vcomponents, skipped } = serializeContacts(contacts)
      const vcf = vcomponents.join('\n')
      downloadFile(vcf, 'silentsuite-contacts.vcf', 'text/vcard')
      reportSkipped('contact', skipped)
    } catch (err) {
      reportError('Contacts export', err)
    }
  }

  async function exportAll() {
    if (isExportingAll) return

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

      <div className="flex flex-col gap-3">
        <Button
          className="w-full sm:w-auto"
          disabled={events.length === 0 || isExportingAll}
          onClick={exportCalendar}
        >
          <Download className="mr-2 h-4 w-4" />
          Export Calendar ({events.length} {events.length === 1 ? 'event' : 'events'})
        </Button>
        <Button
          className="w-full sm:w-auto"
          disabled={tasks.length === 0 || isExportingAll}
          onClick={exportTasks}
        >
          <Download className="mr-2 h-4 w-4" />
          Export Tasks ({tasks.length} {tasks.length === 1 ? 'task' : 'tasks'})
        </Button>
        <Button
          className="w-full sm:w-auto"
          disabled={contacts.length === 0 || isExportingAll}
          onClick={exportContacts}
        >
          <Download className="mr-2 h-4 w-4" />
          Export Contacts ({contacts.length} {contacts.length === 1 ? 'contact' : 'contacts'})
        </Button>
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
      </div>
    </div>
  )
}
