'use client'

import { useState, useCallback } from 'react'
import { Calendar, CheckSquare, Trash2, Users } from 'lucide-react'
import CalendarImport from '@/app/components/import/CalendarImport'
import TaskImport from '@/app/components/import/TaskImport'
import ContactImport from '@/app/components/import/ContactImport'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useTaskListStore } from '@/app/stores/use-task-list-store'
import { useTaskStore } from '@/app/stores/use-task-store'
import { useContactListStore } from '@/app/stores/use-contact-list-store'
import { useContactStore } from '@/app/stores/use-contact-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'

interface Toast {
  id: number
  message: string
}

type CollectionTypeKey = 'calendar' | 'tasks' | 'contacts'

interface DataCollectionRow {
  id: string
  name: string
  color: string
  count: number
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural
}

function ManageImportedDataSection({ showToast }: { showToast: (message: string) => void }) {
  const calendars = useCalendarListStore((s) => s.calendars)
  const events = useCalendarStore((s) => s.events)
  const taskLists = useTaskListStore((s) => s.lists)
  const tasks = useTaskStore((s) => s.tasks)
  const contactLists = useContactListStore((s) => s.lists)
  const contacts = useContactStore((s) => s.contacts)
  const deleteCollection = useEtebaseStore((s) => s.deleteCollection)
  const deleteItemsInCollection = useEtebaseStore((s) => s.deleteItemsInCollection)

  const calendarRows: DataCollectionRow[] = calendars.map((calendar) => ({
    id: calendar.id,
    name: calendar.name,
    color: calendar.color,
    count: events.filter((event) => (event.calendarId ?? 'default') === calendar.id).length,
  }))
  const taskRows: DataCollectionRow[] = taskLists.map((list) => ({
    id: list.id,
    name: list.name,
    color: list.color,
    count: tasks.filter((task) => (task.listId ?? 'default') === list.id).length,
  }))
  const contactRows: DataCollectionRow[] = contactLists.map((list) => ({
    id: list.id,
    name: list.name,
    color: list.color,
    count: contacts.filter((contact) => (contact.listId ?? 'default') === list.id).length,
  }))

  const handleClear = useCallback(async (
    type: CollectionTypeKey,
    row: DataCollectionRow,
    itemSingular: string,
    itemPlural: string,
  ) => {
    if (row.count === 0) return
    const itemLabel = pluralize(row.count, itemSingular, itemPlural)
    if (!window.confirm(`Delete all ${row.count} ${itemLabel} from "${row.name}"? This syncs to all devices and cannot be undone.`)) return
    const deleted = await deleteItemsInCollection(type, row.id)
    if (deleted > 0) {
      showToast(`Deleted ${deleted} ${pluralize(deleted, itemSingular, itemPlural)} from ${row.name}`)
    }
  }, [deleteItemsInCollection, showToast])

  const handleDelete = useCallback(async (
    type: CollectionTypeKey,
    row: DataCollectionRow,
    collectionLabel: string,
    itemSingular: string,
    itemPlural: string,
  ) => {
    const itemLabel = pluralize(row.count, itemSingular, itemPlural)
    if (!window.confirm(`Delete ${collectionLabel} "${row.name}" and all ${row.count} ${itemLabel} in it? This syncs to all devices and cannot be undone.`)) return
    const deleted = await deleteCollection(type, row.id)
    if (deleted) {
      showToast(`Deleted ${collectionLabel} ${row.name}`)
    }
  }, [deleteCollection, showToast])

  const sections = [
    {
      type: 'calendar' as const,
      title: 'Calendars',
      collectionLabel: 'calendar',
      itemSingular: 'event',
      itemPlural: 'events',
      rows: calendarRows,
    },
    {
      type: 'tasks' as const,
      title: 'Task lists',
      collectionLabel: 'task list',
      itemSingular: 'task',
      itemPlural: 'tasks',
      rows: taskRows,
    },
    {
      type: 'contacts' as const,
      title: 'Address books',
      collectionLabel: 'address book',
      itemSingular: 'contact',
      itemPlural: 'contacts',
      rows: contactRows,
    },
  ]

  return (
    <section className="space-y-3 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))]/40 p-4">
      <div>
        <h3 className="text-sm font-medium text-[rgb(var(--foreground))]">Manage imported data</h3>
        <p className="mt-1 text-xs text-[rgb(var(--muted))]">
          Clear the contents of a calendar/list/address book, or delete extra collections and everything inside them.
        </p>
      </div>

      <div className="space-y-4">
        {sections.map((section) => (
          <div key={section.type} className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-[rgb(var(--muted))]">
              {section.title}
            </p>
            <div className="space-y-1">
              {section.rows.map((row) => {
                const itemLabel = pluralize(row.count, section.itemSingular, section.itemPlural)
                const canDeleteCollection = section.rows.length > 1
                return (
                  <div key={row.id} className="flex flex-col gap-2 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-3 py-2 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: row.color }} />
                        <span className="truncate text-sm font-medium text-[rgb(var(--foreground))]">{row.name}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-[rgb(var(--muted))]">
                        {row.count} {itemLabel}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleClear(section.type, row, section.itemSingular, section.itemPlural)}
                        disabled={row.count === 0}
                        className="rounded-md border border-[rgb(var(--border))] px-3 py-1.5 text-xs font-medium text-[rgb(var(--foreground))] transition-colors hover:bg-[rgb(var(--surface))] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Clear {section.itemPlural}
                      </button>
                      {canDeleteCollection && (
                        <button
                          type="button"
                          onClick={() => handleDelete(section.type, row, section.collectionLabel, section.itemSingular, section.itemPlural)}
                          className="inline-flex items-center gap-1 rounded-md border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10"
                        >
                          <Trash2 className="h-3 w-3" />
                          Delete {section.collectionLabel}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

export default function ImportPage() {
  const [toasts, setToasts] = useState<Toast[]>([])

  const showToast = useCallback((message: string) => {
    const id = Date.now()
    setToasts((prev) => [...prev, { id, message }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 4000)
  }, [])

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-base font-semibold text-[rgb(var(--foreground))]">Import Data</h2>
        <p className="mt-1 text-sm text-[rgb(var(--muted))]">
          Import your existing calendar events, tasks, and contacts from other apps.
          All parsing happens locally in your browser — no data leaves your device.
        </p>
      </div>

      <ManageImportedDataSection showToast={showToast} />

      {/* Calendar Import */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-emerald-400" />
          <h3 className="text-sm font-medium text-[rgb(var(--foreground))]">Calendar Events</h3>
        </div>
        <CalendarImport
          onImportComplete={(count) => showToast(`Successfully imported ${count} calendar events`)}
        />
      </section>

      <hr className="border-[rgb(var(--border))]" />

      {/* Task Import */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <CheckSquare className="h-5 w-5 text-emerald-400" />
          <h3 className="text-sm font-medium text-[rgb(var(--foreground))]">Tasks</h3>
        </div>
        <TaskImport
          onImportComplete={(count) => showToast(`Successfully imported ${count} tasks`)}
        />
      </section>

      <hr className="border-[rgb(var(--border))]" />

      {/* Contact Import */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-emerald-400" />
          <h3 className="text-sm font-medium text-[rgb(var(--foreground))]">Contacts</h3>
        </div>
        <ContactImport
          onImportComplete={(count) => showToast(`Successfully imported ${count} contacts`)}
        />
      </section>

      {/* Toast notifications */}
      <div className="fixed bottom-4 right-4 z-50 space-y-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="animate-in slide-in-from-bottom-2 rounded-lg bg-emerald-600 px-4 py-3 text-sm font-medium text-white shadow-lg"
          >
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  )
}
