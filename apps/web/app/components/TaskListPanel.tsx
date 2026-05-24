'use client'

import { useState, useCallback, useRef } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useTaskListStore } from '@/app/stores/use-task-list-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'

export function TaskListPanel() {
  const { lists, toggleVisibility, getNextColor } = useTaskListStore()
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
      const uid = await createCollection('tasks', name, getNextColor())
      if (uid) setIsAdding(false)
      else setNewName(name)
      isCreatingRef.current = false
    }
  }, [createCollection, getNextColor, newName])

  const handleDelete = useCallback(async (id: string, name: string) => {
    if (lists.length <= 1) return
    if (!window.confirm(`Delete task list "${name}" and all tasks in it? This cannot be undone.`)) return
    await deleteCollection('tasks', id)
  }, [deleteCollection, lists.length])

  const handleColorChange = useCallback((id: string, color: string) => {
    void updateCollectionMeta('tasks', id, { color })
  }, [updateCollectionMeta])

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
              <input
                type="color"
                value={list.color}
                onChange={(e) => handleColorChange(list.id, e.target.value)}
                className="h-4 w-4 cursor-pointer rounded border border-[rgb(var(--border))] bg-transparent p-0"
                aria-label={`Change ${list.name} color`}
                title="Change color"
              />
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
              placeholder="List name"
              className="flex-1 min-w-0 bg-transparent text-xs text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] outline-none"
            />
          </div>
        )}
      </div>
    </div>
  )
}
