'use client'

import { useCallback, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { parseVCalendar } from '@silentsuite/core/utils/ical-parser'
import type { VEvent } from '@silentsuite/core/utils/ical-parser'
import FileDropZone from './FileDropZone'
import ImportPreview from './ImportPreview'
import { useCalendarStore } from '@/app/stores/use-calendar-store'

interface CalendarImportProps {
  onImportComplete: (count: number) => void
}

const PLATFORM_INSTRUCTIONS = [
  {
    name: 'Google Calendar',
    steps: 'Go to calendar.google.com → Settings → Import & Export → Export',
  },
  {
    name: 'Apple Calendar',
    steps: 'Open Calendar app → File → Export',
  },
  {
    name: 'Outlook',
    steps: 'Open Outlook → Calendar → Share → Export to .ics',
  },
  {
    name: 'Other',
    steps: 'Export your calendar as .ics from any app',
  },
]

function formatICalDate(dtstart: string): string {
  if (!dtstart) return ''
  // Handle YYYYMMDD format
  if (/^\d{8}$/.test(dtstart)) {
    const y = dtstart.slice(0, 4)
    const m = dtstart.slice(4, 6)
    const d = dtstart.slice(6, 8)
    return `${y}-${m}-${d}`
  }
  // Handle YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ
  if (/^\d{8}T\d{6}/.test(dtstart)) {
    const y = dtstart.slice(0, 4)
    const m = dtstart.slice(4, 6)
    const d = dtstart.slice(6, 8)
    const hh = dtstart.slice(9, 11)
    const mm = dtstart.slice(11, 13)
    return `${y}-${m}-${d} ${hh}:${mm}`
  }
  return dtstart
}

function parseICalDateTime(dtstart: string): Date {
  if (/^\d{8}$/.test(dtstart)) {
    return new Date(
      parseInt(dtstart.slice(0, 4)),
      parseInt(dtstart.slice(4, 6)) - 1,
      parseInt(dtstart.slice(6, 8)),
    )
  }
  if (/^\d{8}T\d{6}/.test(dtstart)) {
    const isUtc = dtstart.endsWith('Z')
    const y = parseInt(dtstart.slice(0, 4))
    const mo = parseInt(dtstart.slice(4, 6)) - 1
    const d = parseInt(dtstart.slice(6, 8))
    const h = parseInt(dtstart.slice(9, 11))
    const mi = parseInt(dtstart.slice(11, 13))
    const s = parseInt(dtstart.slice(13, 15))
    if (isUtc) return new Date(Date.UTC(y, mo, d, h, mi, s))
    return new Date(y, mo, d, h, mi, s)
  }
  return new Date(dtstart)
}

export default function CalendarImport({ onImportComplete }: CalendarImportProps) {
  const [events, setEvents] = useState<VEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [importedCount, setImportedCount] = useState<number | null>(null)
  const [openAccordion, setOpenAccordion] = useState<string | null>(null)
  const createEvent = useCalendarStore((s) => s.createEvent)

  const handleFiles = useCallback(async (files: File[]) => {
    setError(null)
    setEvents([])
    setImportedCount(null)

    try {
      const allEvents: VEvent[] = []
      for (const file of files) {
        const text = await file.text()
        const parsed = parseVCalendar(text)
        allEvents.push(...parsed)
      }
      if (allEvents.length === 0) {
        setError('No calendar events found in the selected file(s).')
        return
      }
      setEvents(allEvents)
    } catch {
      setError('Failed to parse the file. Please make sure it is a valid .ics file.')
    }
  }, [])

  const handleImport = useCallback(async () => {
    setIsImporting(true)
    try {
      for (const event of events) {
        const start = parseICalDateTime(event.dtstart)
        const end = event.dtend
          ? parseICalDateTime(event.dtend)
          : new Date(start.getTime() + 60 * 60 * 1000)
        const isAllDay = /^\d{8}$/.test(event.dtstart)

        await createEvent({
          title: event.summary || 'Untitled Event',
          description: event.description ?? '',
          location: event.location ?? '',
          startDate: start,
          endDate: end,
          allDay: isAllDay,
          recurrenceRule: event.rrule ?? null,
          alarms: event.valarms ?? [],
        })
      }
      setImportedCount(events.length)
      onImportComplete(events.length)
    } catch {
      setError('An error occurred while importing events. Please try again.')
    } finally {
      setIsImporting(false)
    }
  }, [events, createEvent, onImportComplete])

  const handleCancel = useCallback(() => {
    setEvents([])
    setError(null)
    setImportedCount(null)
  }, [])

  return (
    <div className="space-y-4">
      {/* Platform instructions */}
      <div className="space-y-1 rounded-lg bg-[rgb(var(--surface))]/50 p-1">
        {PLATFORM_INSTRUCTIONS.map((platform) => (
          <div key={platform.name}>
            <button
              type="button"
              onClick={() =>
                setOpenAccordion(openAccordion === platform.name ? null : platform.name)
              }
              className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))]/50"
            >
              <span>{platform.name}</span>
              <ChevronDown
                className={`h-4 w-4 text-[rgb(var(--muted))] transition-transform ${
                  openAccordion === platform.name ? 'rotate-180' : ''
                }`}
              />
            </button>
            {openAccordion === platform.name && (
              <p className="px-3 pb-2 text-xs text-[rgb(var(--muted))]">{platform.steps}</p>
            )}
          </div>
        ))}
      </div>

      <FileDropZone accept=".ics" onFiles={handleFiles} />

      {error && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      {events.length > 0 && (
        <ImportPreview
          items={events.map((e) => ({
            title: e.summary || 'Untitled Event',
            subtitle: formatICalDate(e.dtstart),
          }))}
          type="events"
          onImport={handleImport}
          onCancel={handleCancel}
          isImporting={isImporting}
          importedCount={importedCount}
        />
      )}

      {events.length === 0 && importedCount !== null && (
        <ImportPreview
          items={[]}
          type="events"
          onImport={handleImport}
          onCancel={handleCancel}
          isImporting={false}
          importedCount={importedCount}
        />
      )}
    </div>
  )
}
