'use client'

import { useState, useCallback, useRef } from 'react'
import { Plus } from 'lucide-react'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { CollectionListItem } from '@/app/components/CollectionListItem'

export function CalendarListPanel() {
  const { calendars, defaultCalendarId, toggleVisibility, setDefaultCalendar, getNextColor } = useCalendarListStore()
  const createCollection = useEtebaseStore((s) => s.createCollection)
  const deleteCollection = useEtebaseStore((s) => s.deleteCollection)
  const updateCollectionMeta = useEtebaseStore((s) => s.updateCollectionMeta)
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

  const handleColorChange = useCallback((id: string, color: string) => {
    void updateCollectionMeta('calendar', id, { color })
  }, [updateCollectionMeta])

  const handleRename = useCallback((id: string, name: string) => {
    void updateCollectionMeta('calendar', id, { name })
  }, [updateCollectionMeta])

  const handleSetDefault = useCallback((id: string) => {
    const calendar = calendars.find((cal) => cal.id === id)
    if (calendar && !calendar.visible) toggleVisibility(id)
    setDefaultCalendar(id)
  }, [calendars, setDefaultCalendar, toggleVisibility])

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
          <CollectionListItem
            key={cal.id}
            name={cal.name}
            color={cal.color}
            visible={cal.visible}
            isDefault={cal.id === defaultCalendarId}
            canDelete={calendars.length > 1}
            itemLabel="calendar"
            defaultLabel="Default calendar"
            deleteLabel="Delete calendar"
            onToggleVisibility={() => toggleVisibility(cal.id)}
            onRename={(name) => handleRename(cal.id, name)}
            onSetDefault={() => handleSetDefault(cal.id)}
            onColorChange={(color) => handleColorChange(cal.id, color)}
            onDelete={() => handleDelete(cal.id, cal.name)}
          />
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
