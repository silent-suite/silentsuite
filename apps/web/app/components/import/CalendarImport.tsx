'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, ChevronDown, ExternalLink, Loader2 } from 'lucide-react'
import { parseVCalendar, parseICalDateValue } from '@silentsuite/core'
import type { VEvent } from '@silentsuite/core/utils/ical-parser'
import FileDropZone from './FileDropZone'
import ImportListSelector from './ImportListSelector'
import { vEventToImportEvent } from './import-mappers'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { DEFAULT_CALENDAR_COLORS, useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'

interface CalendarImportProps {
  onImportComplete: (count: number) => void
  heading?: string
}

interface CalendarImportGroup {
  id: string
  fileName: string
  name: string
  color: string
  events: VEvent[]
}

type ImportMode = 'single' | 'separate'

const PLATFORM_INSTRUCTIONS = [
  {
    name: 'Google Calendar',
    steps: 'Go to Settings -> Import & Export -> Export',
    link: 'https://calendar.google.com/calendar/u/0/r/settings/export?pli=1',
  },
  {
    name: 'Apple Calendar',
    steps: 'Open Calendar app -> File -> Export',
    link: undefined,
  },
  {
    name: 'Outlook',
    steps: 'Open Outlook -> Calendar -> Share -> Export to .ics',
    link: undefined,
  },
  {
    name: 'Other',
    steps: 'Export your calendar as .ics from any app',
    link: undefined,
  },
]

function formatEventPreviewDate(dtstart: string, tzid?: string): string {
  if (!dtstart) return ''
  // All-day: YYYYMMDD
  if (/^\d{8}$/.test(dtstart)) {
    const y = dtstart.slice(0, 4)
    const m = dtstart.slice(4, 6)
    const d = dtstart.slice(6, 8)
    return `${y}-${m}-${d}`
  }
  // Timed: convert via parseICalDateValue so TZID is honoured
  try {
    const { date } = parseICalDateValue(dtstart, tzid)
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return dtstart
  }
}

function stripIcsExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Imported Calendar'
}

function unescapeICalText(value: string): string {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim()
}

function inferCalendarName(fileName: string, text: string): string {
  const unfolded = text.replace(/\r?\n[ \t]/g, '')
  const match = unfolded.match(/^X-WR-CALNAME(?:;[^:]*)?:(.+)$/im)
  const name = match?.[1] ? unescapeICalText(match[1]) : stripIcsExtension(fileName)
  return name || stripIcsExtension(fileName)
}

export default function CalendarImport({ onImportComplete, heading }: CalendarImportProps) {
  const [groups, setGroups] = useState<CalendarImportGroup[]>([])
  const [importMode, setImportMode] = useState<ImportMode>('single')
  const [error, setError] = useState<string | null>(null)
  const [todoWarning, setTodoWarning] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [importedCount, setImportedCount] = useState<number | null>(null)
  const [openAccordion, setOpenAccordion] = useState<string | null>(null)
  const importEvents = useCalendarStore((s) => s.importEvents)
  const calendars = useCalendarListStore((s) => s.calendars)
  const defaultCalendarId = useCalendarListStore((s) => s.defaultCalendarId)
  const [selectedCalendarId, setSelectedCalendarId] = useState(defaultCalendarId)
  const createCollection = useEtebaseStore((s) => s.createCollection)

  const totalEvents = useMemo(
    () => groups.reduce((sum, group) => sum + group.events.length, 0),
    [groups],
  )
  const previewEvents = useMemo(
    () => groups.flatMap((group) => group.events.map((event) => ({ event, group }))),
    [groups],
  )

  useEffect(() => {
    if (calendars.length === 0) return
    const fallbackId = calendars.some((cal) => cal.id === defaultCalendarId)
      ? defaultCalendarId
      : calendars[0]!.id
    if (!calendars.some((cal) => cal.id === selectedCalendarId)) {
      setSelectedCalendarId(fallbackId)
    }
  }, [calendars, defaultCalendarId, selectedCalendarId])

  const handleFiles = useCallback(async (files: File[]) => {
    setError(null)
    setGroups([])
    setImportedCount(null)
    setTodoWarning(null)

    try {
      const parsedGroups: CalendarImportGroup[] = []
      const usedColors = new Set(calendars.map((calendar) => calendar.color))
      let todoCount = 0

      for (const [index, file] of files.entries()) {
        if (file.size > 10 * 1024 * 1024) {
          setError('File is too large. Maximum size is 10 MB.')
          return
        }
        const text = await file.text()
        const parsed = parseVCalendar(text)
        const todoMatches = text.match(/BEGIN:VTODO/gi)
        if (todoMatches) todoCount += todoMatches.length
        if (parsed.length === 0) continue

        const color = DEFAULT_CALENDAR_COLORS.find((candidate) => !usedColors.has(candidate))
          ?? DEFAULT_CALENDAR_COLORS[(calendars.length + index) % DEFAULT_CALENDAR_COLORS.length]
          ?? '#10b981'
        usedColors.add(color)
        parsedGroups.push({
          id: `${file.name}-${file.lastModified}-${index}`,
          fileName: file.name,
          name: inferCalendarName(file.name, text),
          color,
          events: parsed,
        })
      }

      if (todoCount > 0) {
        setTodoWarning(
          `This file contains ${todoCount} task${todoCount !== 1 ? 's' : ''} (VTODO). ` +
          `Use the Tasks import step to import them.`,
        )
      }
      if (parsedGroups.length === 0 && todoCount === 0) {
        setError('No calendar events found in the selected file(s).')
        return
      }
      setImportMode(parsedGroups.length > 1 ? 'separate' : 'single')
      setGroups(parsedGroups)
    } catch {
      setError('Failed to parse the file. Please make sure it is a valid .ics file.')
    }
  }, [calendars])

  const updateGroup = useCallback((id: string, updates: Partial<Pick<CalendarImportGroup, 'name' | 'color'>>) => {
    setGroups((current) => current.map((group) => group.id === id ? { ...group, ...updates } : group))
  }, [])

  const handleImport = useCallback(async () => {
    if (totalEvents === 0) return
    setIsImporting(true)
    try {
      let count = 0
      if (importMode === 'separate' && groups.length > 1) {
        for (const group of groups) {
          const calendarName = group.name.trim() || stripIcsExtension(group.fileName)
          const calendarId = await createCollection('calendar', calendarName, group.color)
          if (!calendarId) throw new Error('Failed to create calendar')
          count += await importEvents(group.events.map((event) => vEventToImportEvent(event, calendarId)))
        }
      } else {
        const allEvents = groups.flatMap((group) => group.events)
        count = await importEvents(allEvents.map((event) => vEventToImportEvent(event, selectedCalendarId)))
      }
      setImportedCount(count)
      onImportComplete(count)
    } catch {
      setError('An error occurred while importing events. Please try again.')
    } finally {
      setIsImporting(false)
    }
  }, [createCollection, groups, importEvents, importMode, onImportComplete, selectedCalendarId, totalEvents])

  const handleCreateCalendar = useCallback(async (name: string, color: string) => {
    const uid = await createCollection('calendar', name, color)
    if (uid) setSelectedCalendarId(uid)
  }, [createCollection])

  const handleCancel = useCallback(() => {
    setGroups([])
    setError(null)
    setImportedCount(null)
  }, [])

  return (
    <div className="space-y-4">
      {heading && (
        <h2 className="text-lg font-semibold leading-tight text-[rgb(var(--foreground))]">
          {heading}
        </h2>
      )}
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
              <div className="px-3 pb-2">
                <p className="text-xs text-[rgb(var(--muted))]">{platform.steps}</p>
                {platform.link && (
                  <a
                    href={platform.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-xs text-emerald-500 hover:text-emerald-400 transition-colors"
                  >
                    Open export page
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {(groups.length <= 1 || importMode === 'single') && (
        <ImportListSelector
          lists={calendars}
          selectedId={selectedCalendarId}
          onSelect={setSelectedCalendarId}
          onCreateNew={handleCreateCalendar}
          label="calendar"
        />
      )}

      <FileDropZone accept=".ics" onFiles={handleFiles} />

      {error && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      {todoWarning && (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-400">{todoWarning}</p>
      )}

      {importedCount !== null && (
        <div className="flex flex-col items-center gap-3 rounded-lg bg-[rgb(var(--primary))]/10 p-6">
          <CheckCircle2 className="h-10 w-10 text-[rgb(var(--primary))]" />
          <p className="text-sm font-medium text-[rgb(var(--primary))]">
            {importedCount} events imported
          </p>
        </div>
      )}

      {totalEvents > 0 && importedCount === null && (
        <div className="space-y-4">
          <div className="space-y-3 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))]/50 p-3">
            <div>
              <p className="text-sm font-medium text-[rgb(var(--foreground))]">
                {totalEvents} events found in {groups.length} file{groups.length !== 1 ? 's' : ''}
              </p>
              <p className="mt-1 text-xs text-[rgb(var(--muted))]">
                Review the destination before importing. You can delete or clear calendars later from this page.
              </p>
            </div>

            {groups.length > 1 && (
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setImportMode('separate')}
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    importMode === 'separate'
                      ? 'border-emerald-500 bg-emerald-600/10 text-[rgb(var(--foreground))]'
                      : 'border-[rgb(var(--border))] text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]'
                  }`}
                >
                  <span className="block font-medium">Create one calendar per file</span>
                  <span className="mt-0.5 block text-xs opacity-80">Best when exports came from separate calendars.</span>
                </button>
                <button
                  type="button"
                  onClick={() => setImportMode('single')}
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    importMode === 'single'
                      ? 'border-emerald-500 bg-emerald-600/10 text-[rgb(var(--foreground))]'
                      : 'border-[rgb(var(--border))] text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]'
                  }`}
                >
                  <span className="block font-medium">Import all into one calendar</span>
                  <span className="mt-0.5 block text-xs opacity-80">Use this for split files from the same calendar.</span>
                </button>
              </div>
            )}

            {importMode === 'separate' && groups.length > 1 ? (
              <div className="space-y-2">
                {groups.map((group) => (
                  <div key={group.id} className="rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] p-3">
                    <div className="flex items-start gap-3">
                      <input
                        type="color"
                        value={group.color}
                        onChange={(event) => updateGroup(group.id, { color: event.target.value })}
                        aria-label={`Color for ${group.name}`}
                        className="mt-1 h-8 w-8 shrink-0 rounded border border-[rgb(var(--border))] bg-transparent p-0"
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <input
                          type="text"
                          value={group.name}
                          onChange={(event) => updateGroup(group.id, { name: event.target.value })}
                          aria-label={`Calendar name for ${group.fileName}`}
                          className="w-full rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-1.5 text-sm text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                        <p className="truncate text-xs text-[rgb(var(--muted))]">
                          {group.fileName} {'->'} {group.events.length} event{group.events.length !== 1 ? 's' : ''}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="max-h-60 space-y-1 overflow-y-auto rounded-lg bg-[rgb(var(--background))]/70 p-2">
                {previewEvents.slice(0, 10).map(({ event, group }, i) => (
                  <div key={`${group.id}-${i}`} className="rounded-md px-3 py-2 text-sm hover:bg-[rgb(var(--surface))]">
                    <p className="text-[rgb(var(--foreground))]">{event.summary || 'Untitled Event'}</p>
                    <p className="text-xs text-[rgb(var(--muted))]">
                      {formatEventPreviewDate(event.dtstart, event.dtstartParams?.['TZID'])}
                      {groups.length > 1 ? ` - ${group.fileName}` : ''}
                    </p>
                  </div>
                ))}
                {totalEvents > 10 && (
                  <p className="px-3 py-2 text-xs text-[rgb(var(--muted))]">
                    ...and {totalEvents - 10} more
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleImport}
              disabled={isImporting}
              className="inline-flex items-center gap-2 rounded-lg bg-[rgb(var(--primary))] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[rgb(var(--primary-hover))] disabled:opacity-50"
            >
              {isImporting && <Loader2 className="h-4 w-4 animate-spin" />}
              {isImporting
                ? 'Importing...'
                : importMode === 'separate' && groups.length > 1
                  ? `Import into ${groups.length} calendars`
                  : `Import ${totalEvents} events`}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={isImporting}
              className="text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
