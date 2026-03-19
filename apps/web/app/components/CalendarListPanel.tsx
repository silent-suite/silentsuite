'use client'

import { useState, useCallback } from 'react'
import { Plus, Trash2, Star } from 'lucide-react'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'

export function CalendarListPanel() {
  const { calendars, defaultCalendarId, addCalendar, removeCalendar, toggleVisibility, setDefaultCalendar, getNextColor } = useCalendarListStore()
  const [isAdding, setIsAdding] = useState(false)
  const [newName, setNewName] = useState('')

  const handleAdd = useCallback(() => {
    if (newName.trim()) {
      addCalendar(newName.trim())
      setNewName('')
      setIsAdding(false)
    }
  }, [newName, addCalendar])

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
              {cal.id !== 'default' && (
                <button
                  onClick={() => removeCalendar(cal.id)}
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
