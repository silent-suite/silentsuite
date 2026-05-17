'use client'

import { useState, useCallback, useRef } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useContactListStore } from '@/app/stores/use-contact-list-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'

export function ContactListPanel() {
  const { lists, toggleVisibility, getNextColor } = useContactListStore()
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
      const uid = await createCollection('contacts', name, getNextColor())
      if (uid) setIsAdding(false)
      else setNewName(name)
      isCreatingRef.current = false
    }
  }, [createCollection, getNextColor, newName])

  const handleDelete = useCallback(async (id: string, name: string) => {
    if (lists.length <= 1) return
    if (!window.confirm(`Delete address book "${name}" and all contacts in it? This cannot be undone.`)) return
    await deleteCollection('contacts', id)
  }, [deleteCollection, lists.length])

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[rgb(var(--muted))]">
          Address Books
        </span>
        <button
          onClick={() => setIsAdding(true)}
          className="rounded p-0.5 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
          aria-label="Add address book"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-0.5">
        {lists.map((list) => (
          <div
            key={list.id}
            className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-[rgb(var(--background))] transition-colors"
          >
            <button
              onClick={() => toggleVisibility(list.id)}
              className="flex items-center gap-2 flex-1 min-w-0"
            >
              <div
                className="h-3 w-3 shrink-0 rounded-sm"
                style={{
                  backgroundColor: list.visible ? list.color : 'transparent',
                  border: list.visible ? 'none' : `2px solid ${list.color}`,
                }}
              />
              <span className={`text-xs truncate ${
                list.visible ? 'text-[rgb(var(--foreground))]' : 'text-[rgb(var(--muted))]'
              }`}>
                {list.name}
              </span>
            </button>
            <div className="flex items-center gap-0.5">
              {lists.length > 1 && (
                <button
                  onClick={() => handleDelete(list.id, list.name)}
                  className="hidden group-hover:block rounded p-0.5 text-[rgb(var(--muted))] hover:text-red-500 transition-colors"
                  aria-label={`Remove ${list.name}`}
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
              placeholder="Address book name"
              className="flex-1 min-w-0 bg-transparent text-xs text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] outline-none"
            />
          </div>
        )}
      </div>
    </div>
  )
}
