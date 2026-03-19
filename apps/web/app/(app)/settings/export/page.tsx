'use client'

import { Button } from '@silentsuite/ui'
import { toVEvent, toVTodo, toVCard } from '@silentsuite/core'
import { useTaskStore } from '@/app/stores/use-task-store'
import { useContactStore } from '@/app/stores/use-contact-store'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { Download } from 'lucide-react'
import JSZip from 'jszip'

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
    const zip = new JSZip()

    const vevents = events.map((e) => toVEvent(e))
    zip.file('silentsuite-calendar.ics', buildCalendarIcs(vevents))

    const vtodos = tasks.map((t) => toVTodo(t))
    zip.file('silentsuite-tasks.ics', buildCalendarIcs(vtodos))

    const vcards = contacts.map((c) => toVCard(c))
    zip.file('silentsuite-contacts.vcf', vcards.join('\n'))

    const blob = await zip.generateAsync({ type: 'blob' })
    downloadFile(blob, 'silentsuite-export.zip', 'application/zip')
  }

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-[rgb(var(--foreground))]">Export Data</h1>
      <p className="text-sm text-[rgb(var(--muted))]">
        Download your data in standard formats (ICS, VCF). Your data is always yours.
      </p>

      <div className="flex flex-col gap-3">
        <Button
          className="w-full sm:w-auto"
          disabled={events.length === 0}
          onClick={exportCalendar}
        >
          <Download className="mr-2 h-4 w-4" />
          Export Calendar ({events.length} {events.length === 1 ? 'event' : 'events'})
        </Button>
        <Button
          className="w-full sm:w-auto"
          disabled={tasks.length === 0}
          onClick={exportTasks}
        >
          <Download className="mr-2 h-4 w-4" />
          Export Tasks ({tasks.length} {tasks.length === 1 ? 'task' : 'tasks'})
        </Button>
        <Button
          className="w-full sm:w-auto"
          disabled={contacts.length === 0}
          onClick={exportContacts}
        >
          <Download className="mr-2 h-4 w-4" />
          Export Contacts ({contacts.length} {contacts.length === 1 ? 'contact' : 'contacts'})
        </Button>
        <Button
          variant="outline"
          className="w-full sm:w-auto"
          disabled={events.length === 0 && tasks.length === 0 && contacts.length === 0}
          onClick={exportAll}
        >
          <Download className="mr-2 h-4 w-4" />
          Export All Data (.zip)
        </Button>
      </div>
    </div>
  )
}
