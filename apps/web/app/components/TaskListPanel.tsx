'use client'

import { useState, useCallback, useRef } from 'react'
import { Plus } from 'lucide-react'
import { useTaskListStore } from '@/app/stores/use-task-list-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { CollectionListItem } from '@/app/components/CollectionListItem'

export function TaskListPanel() {
  const { lists, activeListId, toggleVisibility, setActiveList, getNextColor } = useTaskListStore()
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

  const handleRename = useCallback((id: string, name: string) => {
    void updateCollectionMeta('tasks', id, { name })
  }, [updateCollectionMeta])

  const handleSetDefault = useCallback((id: string) => {
    const list = lists.find((item) => item.id === id)
    if (list && !list.visible) toggleVisibility(id)
    setActiveList(id)
  }, [lists, setActiveList, toggleVisibility])

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
          <CollectionListItem
            key={list.id}
            name={list.name}
            color={list.color}
            visible={list.visible}
            isDefault={list.id === activeListId}
            canDelete={lists.length > 1}
            itemLabel="task list"
            defaultLabel="Default task list"
            deleteLabel="Delete task list"
            onToggleVisibility={() => toggleVisibility(list.id)}
            onRename={(name) => handleRename(list.id, name)}
            onSetDefault={() => handleSetDefault(list.id)}
            onColorChange={(color) => handleColorChange(list.id, color)}
            onDelete={() => handleDelete(list.id, list.name)}
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
              placeholder="List name"
              className="flex-1 min-w-0 bg-transparent text-xs text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] outline-none"
            />
          </div>
        )}
      </div>
    </div>
  )
}
