'use client'

import { useState, useCallback } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useTaskListStore } from '@/app/stores/use-task-list-store'

export function TaskListPanel() {
  const { lists, activeListId, addList, removeList, toggleVisibility, setActiveList, getNextColor } = useTaskListStore()
  const [isAdding, setIsAdding] = useState(false)
  const [newName, setNewName] = useState('')

  const handleAdd = useCallback(() => {
    if (newName.trim()) {
      addList(newName.trim())
      setNewName('')
      setIsAdding(false)
    }
  }, [newName, addList])

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[rgb(var(--muted))]">
          Task Lists
        </span>
        <button
          onClick={() => setIsAdding(true)}
          className="rounded p-0.5 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
          aria-label="Add task list"
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
              onClick={() => {
                toggleVisibility(list.id)
                setActiveList(list.id)
              }}
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
                list.id === activeListId
                  ? 'text-[rgb(var(--foreground))] font-medium'
                  : list.visible ? 'text-[rgb(var(--foreground))]' : 'text-[rgb(var(--muted))]'
              }`}>
                {list.name}
              </span>
            </button>
            <div className="flex items-center gap-0.5">
              {list.id !== 'default' && (
                <button
                  onClick={() => removeList(list.id)}
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
              placeholder="List name"
              className="flex-1 min-w-0 bg-transparent text-xs text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] outline-none"
            />
          </div>
        )}
      </div>
    </div>
  )
}
