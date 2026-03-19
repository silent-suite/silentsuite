'use client'

import { useCallback, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { parseVTodo } from '@silentsuite/core/utils/ical-parser'
import type { VTodo } from '@silentsuite/core/utils/ical-parser'
import FileDropZone from './FileDropZone'
import ImportPreview from './ImportPreview'
import { useTaskStore } from '@/app/stores/use-task-store'
import type { Priority } from '@silentsuite/core'

interface TaskImportProps {
  onImportComplete: (count: number) => void
}

const PLATFORM_INSTRUCTIONS = [
  {
    name: 'Apple Reminders',
    steps:
      'Export from macOS Calendar app (File → Export) — reminders are included as tasks',
  },
  {
    name: 'Todoist',
    steps: 'Go to todoist.com → Settings → Export → Download as CSV',
  },
  {
    name: 'Google Tasks',
    steps: 'Use Google Takeout → select Tasks → download',
  },
  {
    name: 'Other',
    steps: 'Export your tasks as .ics (VTODO format)',
  },
]

/** Extract VTODO blocks from a full VCALENDAR string */
function extractVTodos(ical: string): VTodo[] {
  const todos: VTodo[] = []
  // Unfold lines first
  const unfolded = ical.replace(/\r?\n[ \t]/g, '')
  const lines = unfolded.split(/\r?\n/)
  let inTodo = false
  let todoLines: string[] = []

  for (const line of lines) {
    if (line.trim() === 'BEGIN:VTODO') {
      inTodo = true
      todoLines = ['BEGIN:VTODO']
    } else if (line.trim() === 'END:VTODO') {
      todoLines.push('END:VTODO')
      todos.push(parseVTodo(todoLines.join('\r\n')))
      inTodo = false
      todoLines = []
    } else if (inTodo) {
      todoLines.push(line)
    }
  }

  return todos
}

/** Simple Todoist CSV parser (fallback — the core csv-parser is being built separately) */
function parseTodoistCsv(csv: string): VTodo[] {
  const lines = csv.split(/\r?\n/)
  if (lines.length < 2) return []

  // Parse header
  const header = parseCSVLine(lines[0]!)
  const contentIdx = header.findIndex((h) => h.toUpperCase() === 'CONTENT')
  const descIdx = header.findIndex((h) => h.toUpperCase() === 'DESCRIPTION')
  const priorityIdx = header.findIndex((h) => h.toUpperCase() === 'PRIORITY')
  const dateIdx = header.findIndex((h) => h.toUpperCase() === 'DATE')
  const typeIdx = header.findIndex((h) => h.toUpperCase() === 'TYPE')

  if (contentIdx === -1) return []

  const todos: VTodo[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue

    const cols = parseCSVLine(line)
    const content = cols[contentIdx] ?? ''
    if (!content) continue

    // Skip section headers
    const type = typeIdx !== -1 ? cols[typeIdx]?.toLowerCase() : ''
    if (type === 'section') continue

    const todo: VTodo = {
      uid: `todoist-import-${Date.now()}-${i}`,
      summary: content,
      description: descIdx !== -1 ? (cols[descIdx] ?? '') : undefined,
      status: type === 'completed' ? 'COMPLETED' : 'NEEDS-ACTION',
    }

    if (priorityIdx !== -1 && cols[priorityIdx]) {
      const p = parseInt(cols[priorityIdx]!, 10)
      // Todoist: 1=urgent, 2=high, 3=medium, 4=none → iCal priority
      if (p === 1) todo.priority = 1
      else if (p === 2) todo.priority = 5
      else if (p === 3) todo.priority = 9
    }

    if (dateIdx !== -1 && cols[dateIdx]) {
      const d = cols[dateIdx]!.trim()
      if (d) {
        // Convert to iCal date format YYYYMMDD
        const parsed = new Date(d)
        if (!isNaN(parsed.getTime())) {
          const y = parsed.getFullYear()
          const m = String(parsed.getMonth() + 1).padStart(2, '0')
          const day = String(parsed.getDate()).padStart(2, '0')
          todo.due = `${y}${m}${day}`
        }
      }
    }

    todos.push(todo)
  }

  return todos
}

/** Parse a single CSV line with basic quote handling */
function parseCSVLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

function mapPriorityToStore(icalPriority?: number): Priority {
  if (icalPriority === undefined || icalPriority === 0) return 'medium'
  if (icalPriority <= 1) return 'urgent'
  if (icalPriority <= 4) return 'high'
  if (icalPriority <= 6) return 'medium'
  return 'low'
}

function parseICalDate(d: string): Date | null {
  if (!d) return null
  if (/^\d{8}$/.test(d)) {
    return new Date(
      parseInt(d.slice(0, 4)),
      parseInt(d.slice(4, 6)) - 1,
      parseInt(d.slice(6, 8)),
    )
  }
  if (/^\d{8}T\d{6}/.test(d)) {
    const isUtc = d.endsWith('Z')
    const y = parseInt(d.slice(0, 4))
    const mo = parseInt(d.slice(4, 6)) - 1
    const day = parseInt(d.slice(6, 8))
    const h = parseInt(d.slice(9, 11))
    const mi = parseInt(d.slice(11, 13))
    const s = parseInt(d.slice(13, 15))
    if (isUtc) return new Date(Date.UTC(y, mo, day, h, mi, s))
    return new Date(y, mo, day, h, mi, s)
  }
  const parsed = new Date(d)
  return isNaN(parsed.getTime()) ? null : parsed
}

export default function TaskImport({ onImportComplete }: TaskImportProps) {
  const [tasks, setTasks] = useState<VTodo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [importedCount, setImportedCount] = useState<number | null>(null)
  const [openAccordion, setOpenAccordion] = useState<string | null>(null)
  const createTask = useTaskStore((s) => s.createTask)

  const handleFiles = useCallback(async (files: File[]) => {
    setError(null)
    setTasks([])
    setImportedCount(null)

    try {
      const allTasks: VTodo[] = []
      for (const file of files) {
        const text = await file.text()
        if (file.name.endsWith('.csv')) {
          allTasks.push(...parseTodoistCsv(text))
        } else {
          allTasks.push(...extractVTodos(text))
        }
      }
      if (allTasks.length === 0) {
        setError('No tasks found in the selected file(s).')
        return
      }
      setTasks(allTasks)
    } catch {
      setError('Failed to parse the file. Please make sure it is a valid .ics or .csv file.')
    }
  }, [])

  const handleImport = useCallback(async () => {
    setIsImporting(true)
    try {
      for (const task of tasks) {
        await createTask({
          title: task.summary || 'Untitled Task',
          description: task.description ?? '',
          due_date: task.due ? parseICalDate(task.due) : null,
          priority: mapPriorityToStore(task.priority),
        })
      }
      setImportedCount(tasks.length)
      onImportComplete(tasks.length)
    } catch {
      setError('An error occurred while importing tasks. Please try again.')
    } finally {
      setIsImporting(false)
    }
  }, [tasks, createTask, onImportComplete])

  const handleCancel = useCallback(() => {
    setTasks([])
    setError(null)
    setImportedCount(null)
  }, [])

  return (
    <div className="space-y-4">
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

      <FileDropZone accept=".ics,.csv" onFiles={handleFiles} />

      {error && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      {tasks.length > 0 && (
        <ImportPreview
          items={tasks.map((t) => ({
            title: t.summary || 'Untitled Task',
            subtitle: t.due ? `Due: ${t.due}` : undefined,
          }))}
          type="tasks"
          onImport={handleImport}
          onCancel={handleCancel}
          isImporting={isImporting}
          importedCount={importedCount}
        />
      )}

      {tasks.length === 0 && importedCount !== null && (
        <ImportPreview
          items={[]}
          type="tasks"
          onImport={handleImport}
          onCancel={handleCancel}
          isImporting={false}
          importedCount={importedCount}
        />
      )}
    </div>
  )
}
