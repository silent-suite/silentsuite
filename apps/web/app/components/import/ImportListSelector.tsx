'use client'

import { useState } from 'react'
import { Plus, Check } from 'lucide-react'

interface ListItem {
  id: string
  name: string
  color: string
}

interface ImportListSelectorProps {
  lists: ListItem[]
  selectedId: string
  onSelect: (id: string) => void
  onCreateNew: (name: string, color: string) => void
  label: string
}

const PRESET_COLORS = [
  '#10b981', '#3b82f6', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#06b6d4', '#f97316',
]

export default function ImportListSelector({
  lists,
  selectedId,
  onSelect,
  onCreateNew,
  label,
}: ImportListSelectorProps) {
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(() => {
    const usedColors = new Set(lists.map((l) => l.color))
    return PRESET_COLORS.find((c) => !usedColors.has(c)) ?? PRESET_COLORS[0]!
  })

  const handleCreate = () => {
    const name = newName.trim()
    if (!name) return
    onCreateNew(name, newColor)
    setNewName('')
    setShowCreate(false)
  }

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-[rgb(var(--muted))]">
        Import into {label}
      </label>

      <div className="space-y-1 rounded-lg bg-[rgb(var(--surface))]/50 p-1">
        {lists.map((list) => (
          <button
            key={list.id}
            type="button"
            onClick={() => onSelect(list.id)}
            className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
              selectedId === list.id
                ? 'bg-[rgb(var(--primary))]/10 text-[rgb(var(--foreground))]'
                : 'text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))]/50'
            }`}
          >
            <span
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: list.color }}
            />
            <span className="flex-1 text-left">{list.name}</span>
            {selectedId === list.id && (
              <Check className="h-4 w-4 text-[rgb(var(--primary))]" />
            )}
          </button>
        ))}

        {!showCreate ? (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-[rgb(var(--muted))] hover:bg-[rgb(var(--surface))]/50 hover:text-[rgb(var(--foreground))]"
          >
            <Plus className="h-3 w-3" />
            <span>Create new</span>
          </button>
        ) : (
          <div className="space-y-2 rounded-md bg-[rgb(var(--surface))] p-3">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
                if (e.key === 'Escape') setShowCreate(false)
              }}
              placeholder={`New ${label.toLowerCase()} name`}
              autoFocus
              className="w-full rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-3 py-1.5 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:border-[rgb(var(--primary))] focus:outline-none"
            />
            <div className="flex items-center gap-1.5">
              {PRESET_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setNewColor(color)}
                  className={`h-5 w-5 rounded-full transition-all ${
                    newColor === color ? 'ring-2 ring-offset-1 ring-[rgb(var(--primary))]' : ''
                  }`}
                  style={{ backgroundColor: color }}
                  aria-label={`Select color ${color}`}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCreate}
                disabled={!newName.trim()}
                className="rounded-md bg-[rgb(var(--primary))] px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-[rgb(var(--primary-hover))] disabled:opacity-50"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="text-xs text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
