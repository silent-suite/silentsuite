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
import { useManagedBirthdayCalendarIds } from '@/app/lib/birthday-calendar/session'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import type { ImportIncompleteError } from '@/app/lib/import-outcome'

function isImportIncomplete(err: unknown): err is ImportIncompleteError {
  return err instanceof Error && err.name === 'ImportIncompleteError'
}

/**
 * Only acknowledged events count as imported; an unconfirmed one may still exist remotely.
 * A calendar whose creation failed may also exist remotely, so it is never called absent.
 */
function incompleteImportMessage(saved: number, unsaved: number, uncertain: boolean, unconfirmedCalendar: string | null): string {
  const total = saved + unsaved
  let message: string
  if (uncertain) {
    message = `Imported ${saved} of ${total} events. The other ${unsaved} weren't confirmed as saved and are listed below. If the connection dropped, some may already be saved, so check your calendars before importing them again.`
  } else if (saved === 0) {
    message = `None of the ${total} events were saved. They're listed below so you can import them again.`
  } else {
    message = `Imported ${saved} of ${total} events. The other ${unsaved} weren't saved and are listed below so you can import them again.`
  }
  if (unconfirmedCalendar) {
    message += ` The "${unconfirmedCalendar}" calendar couldn't be confirmed as created; check your calendar list before importing again.`
  }
  return message
}

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
  /** The calendar already created for this file, reused by a retry instead of creating another. */
  calendarId?: string
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
  const listedCalendars = useCalendarListStore((s) => s.calendars)
  const managedCalendarIds = useManagedBirthdayCalendarIds()
  // A managed Birthdays calendar is generated from contacts and is never an import target.
  const calendars = useMemo(
    () => listedCalendars.filter((calendar) => !managedCalendarIds.includes(calendar.id)),
    [listedCalendars, managedCalendarIds],
  )
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
    if (calendars.length === 0) {
      // No eligible calendar: never keep a managed (or vanished) default selected.
      if (selectedCalendarId !== '') setSelectedCalendarId('')
      return
    }
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
    setError(null)
    try {
      if (importMode === 'separate') {
        // One calendar per file, even when a retry leaves a single file. Files are imported in
        // order; the first that is not fully acknowledged stops the run, and it and every later
        // file stay listed with any calendar already created for them.
        let saved = 0
        let unsaved = 0
        let uncertain = false
        let unconfirmedCalendar: string | null = null
        let genericFailure = false
        const remaining: CalendarImportGroup[] = []
        for (const group of groups) {
          if (remaining.length > 0) {
            remaining.push(group)
            unsaved += group.events.length
            continue
          }
          const calendarName = group.name.trim() || stripIcsExtension(group.fileName)
          const calendarId = group.calendarId ?? await createCollection('calendar', calendarName, group.color) ?? undefined
          if (!calendarId) {
            // Nothing of this file was sent, but the calendar itself may exist remotely.
            unconfirmedCalendar = calendarName
            remaining.push(group)
            unsaved += group.events.length
            continue
          }
          try {
            saved += await importEvents(group.events.map((event) => vEventToImportEvent(event, calendarId)))
          } catch (err) {
            if (isImportIncomplete(err)) {
              const unsavedPositions = new Set(err.unsaved)
              saved += err.saved
              unsaved += err.unsaved.length
              uncertain = uncertain || err.uncertain
              remaining.push({ ...group, calendarId, events: group.events.filter((_, position) => unsavedPositions.has(position)) })
            } else {
              genericFailure = true
              unsaved += group.events.length
              remaining.push({ ...group, calendarId })
            }
          }
        }
        if (remaining.length === 0) {
          setImportedCount(saved)
          onImportComplete(saved)
          return
        }
        setGroups(remaining)
        setError(genericFailure
          ? 'An error occurred while importing events. Please try again.'
          : incompleteImportMessage(saved, unsaved, uncertain, unconfirmedCalendar))
        return
      }

      const allEvents = groups.flatMap((group) => group.events)
      try {
        if (!selectedCalendarId) {
          setError('Choose or create a calendar to import into.')
          return
        }
        const count = await importEvents(allEvents.map((event) => vEventToImportEvent(event, selectedCalendarId)))
        setImportedCount(count)
        onImportComplete(count)
      } catch (err) {
        if (!isImportIncomplete(err)) throw err
        // Keep only the original events that were not acknowledged, in their own files.
        const unsavedPositions = new Set(err.unsaved)
        let position = 0
        const remaining = groups
          .map((group) => ({ ...group, events: group.events.filter(() => unsavedPositions.has(position++)) }))
          .filter((group) => group.events.length > 0)
        setGroups(remaining)
        setError(incompleteImportMessage(err.saved, err.unsaved.length, err.uncertain, null))
      }
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

      {/* A lone file left by a one-per-file retry keeps its own destination, so the selector stays hidden for it. */}
      {(importMode === 'single' || groups.length === 0) && (
        <ImportListSelector
          lists={calendars}
          selectedId={selectedCalendarId}
          onSelect={setSelectedCalendarId}
          onCreateNew={handleCreateCalendar}
          label="calendar"
        />
      )}

      <FileDropZone accept=".ics" onFiles={handleFiles} disabled={isImporting} />

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
