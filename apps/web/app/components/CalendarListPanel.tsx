'use client'

import { useState, useCallback, useRef } from 'react'
import { Plus, Trash2, Star } from 'lucide-react'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'

export function CalendarListPanel() {
  const { calendars, defaultCalendarId, toggleVisibility, setDefaultCalendar, getNextColor } = useCalendarListStore()
  const createCollection = useEtebaseStore((s) => s.createCollection)
  const deleteCollection = useEtebaseStore((s) => s.deleteCollection)
  const [isAdding, setIsAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const isCreatingRef = useRef(false)

  const handleAdd = useCallback(async () => {
    if (isCreatingRef.current) return
    const name = newName.trim()
    if (name) {
      isCreatingRef.current = true
      setNewName('')
      const uid = await createCollection('calendar', name, getNextColor())
      if (uid) setIsAdding(false)
      else setNewName(name)
      isCreatingRef.current = false
    }
  }, [createCollection, getNextColor, newName])

  const handleDelete = useCallback(async (id: string, name: string) => {
    if (calendars.length <= 1) return
    if (!window.confirm(`Delete calendar "${name}" and all events in it? This cannot be undone.`)) return
    await deleteCollection('calendar', id)
  }, [calendars.length, deleteCollection])

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[rgb(var(--muted))]">
          Calendars
        </span>
        <button
          onClick={() => setIsAdding(true)}
          className="rounded p-0.5 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
          aria-label="Add calendar"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-0.5">
        {calendars.map((cal) => (
          <div
            key={cal.id}
            className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-[rgb(var(--background))] transition-colors"
          >
            <button
              onClick={() => toggleVisibility(cal.id)}
              className="flex items-center gap-2 flex-1 min-w-0"
            >
              <div
                className="h-3 w-3 shrink-0 rounded-sm"
                style={{
                  backgroundColor: cal.visible ? cal.color : 'transparent',
                  border: cal.visible ? 'none' : `2px solid ${cal.color}`,
                }}
              />
              <span className={`text-xs truncate ${
                cal.visible ? 'text-[rgb(var(--foreground))]' : 'text-[rgb(var(--muted))]'
              }`}>
                {cal.name}
              </span>
            </button>
            <div className="flex items-center gap-0.5">
              {/* Default indicator / set as default */}
              <button
                onClick={() => setDefaultCalendar(cal.id)}
                className={`rounded p-0.5 transition-colors ${
                  cal.id === defaultCalendarId
                    ? 'text-amber-500'
                    : 'hidden group-hover:block text-[rgb(var(--muted))] hover:text-amber-500'
                }`}
                aria-label={cal.id === defaultCalendarId ? 'Default calendar' : `Set ${cal.name} as default`}
                title={cal.id === defaultCalendarId ? 'Default calendar' : 'Set as default'}
              >
                <Star className={`h-3 w-3 ${cal.id === defaultCalendarId ? 'fill-current' : ''}`} />
              </button>
              {calendars.length > 1 && (
                <button
                  onClick={() => handleDelete(cal.id, cal.name)}
                  className="hidden group-hover:block rounded p-0.5 text-[rgb(var(--muted))] hover:text-red-500 transition-colors"
                  aria-label={`Remove ${cal.name}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        ))}

        {isAdding && (
          <div className="flex items-center gap-1 px-1">
            <div
              className="h-3 w-3 shrink-0 rounded-sm"
              style={{ backgroundColor: getNextColor() }}
            />
            <input
              autoFocus
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd()
                if (e.key === 'Escape') setIsAdding(false)
              }}
              onBlur={() => {
                if (newName.trim()) handleAdd()
                else setIsAdding(false)
              }}
              placeholder="Calendar name"
              className="flex-1 min-w-0 bg-transparent text-xs text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] outline-none"
            />
          </div>
        )}
      </div>
    </div>
  )
}
