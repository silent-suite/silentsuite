'use client'

import { useState } from 'react'
import { Button } from '@silentsuite/ui'
import { toVEvent, toVTodo, toVCard } from '@silentsuite/core'
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
 * before kicking off the ZIP export. The previous in-memory implementation was
 * known to silently fail at ~2000 events; 1000 is a conservative early warning.
 */
const LARGE_EXPORT_THRESHOLD = 1000

function downloadFile(content: string | Blob, filename: string, mimeType: string) {
  const blob =
    content instanceof Blob ? content : new Blob([content], { type: mimeType })
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

export default function ExportPage() {
  const tasks = useTaskStore((s) => s.tasks)
  const contacts = useContactStore((s) => s.contacts)
  const events = useCalendarStore((s) => s.events)

  const [isExportingAll, setIsExportingAll] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)

  function exportCalendar() {
    const vevents = events.map((e) => toVEvent(e))
    const ics = buildCalendarIcs(vevents)
    downloadFile(ics, 'silentsuite-calendar.ics', 'text/calendar')
  }

  function exportTasks() {
    const vtodos = tasks.map((t) => toVTodo(t))
    const ics = buildCalendarIcs(vtodos)
    downloadFile(ics, 'silentsuite-tasks.ics', 'text/calendar')
  }

  function exportContacts() {
    const vcards = contacts.map((c) => toVCard(c))
    const vcf = vcards.join('\n')
    downloadFile(vcf, 'silentsuite-contacts.vcf', 'text/vcard')
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

      const vevents = events.map((e) => toVEvent(e))
      zip.file('silentsuite-calendar.ics', buildCalendarIcs(vevents))

      const vtodos = tasks.map((t) => toVTodo(t))
      zip.file('silentsuite-tasks.ics', buildCalendarIcs(vtodos))

      const vcards = contacts.map((c) => toVCard(c))
      zip.file('silentsuite-contacts.vcf', vcards.join('\n'))

      // Throttle progress updates: only re-render when the integer percent
      // changes. JSZip can fire onUpdate hundreds of times per second on
      // large archives, which would otherwise spam React renders.
      let lastReportedPercent = -1

      const blob = await zip.generateAsync(
        { type: 'blob', streamFiles: true },
        (metadata) => {
          const percent = Math.floor(metadata.percent)
          if (percent !== lastReportedPercent) {
            lastReportedPercent = percent
            setExportProgress(percent)
          }
        },
      )

      downloadFile(blob, 'silentsuite-export.zip', 'application/zip')
    } catch (err) {
      // Log enough detail for a useful bug report. The original bug was that
      // generateAsync rejected silently with no console output at all.
      console.error('[export] Failed to build ZIP archive:', err)
      showErrorToast(
        'Failed to build ZIP. Try exporting calendar, tasks, and contacts separately.',
      )
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
