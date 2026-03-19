'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { Plus, ChevronDown, Trash2, Check } from 'lucide-react'

interface ListItem {
  id: string
  name: string
  color: string
}

interface ListSwitcherProps {
  lists: ListItem[]
  activeListId: string
  onSelectList: (id: string) => void
  onAddList: (name: string) => void
  onRemoveList: (id: string) => void
  label?: string
}

export function ListSwitcher({
  lists,
  activeListId,
  onSelectList,
  onAddList,
  onRemoveList,
  label = 'Lists',
}: ListSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false)
        setIsAdding(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const handleAdd = useCallback(() => {
    if (newName.trim()) {
      onAddList(newName.trim())
      setNewName('')
      setIsAdding(false)
    }
  }, [newName, onAddList])

  const activeList = lists.find((l) => l.id === activeListId) || lists[0]

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-1.5 text-sm font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--border))]/30 transition-colors"
      >
        <div
          className="h-3 w-3 shrink-0 rounded-sm"
          style={{ backgroundColor: activeList?.color }}
        />
        <span className="truncate max-w-[120px]">{activeList?.name}</span>
        <ChevronDown className={`h-3.5 w-3.5 text-[rgb(var(--muted))] transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full z-[100] mt-1 w-56 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] py-1 shadow-lg">
          <div className="px-3 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[rgb(var(--muted))]">
              {label}
            </span>
          </div>

          {lists.map((list) => (
            <div
              key={list.id}
              className="group flex items-center gap-2 px-3 py-1.5 hover:bg-[rgb(var(--surface))] transition-colors"
            >
              <button
                onClick={() => {
                  onSelectList(list.id)
                  setIsOpen(false)
                }}
                className="flex flex-1 items-center gap-2 min-w-0"
              >
                <div
                  className="h-3 w-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: list.color }}
                />
                <span className="text-sm truncate text-[rgb(var(--foreground))]">
                  {list.name}
                </span>
                {list.id === activeListId && (
                  <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-[rgb(var(--primary))]" />
                )}
              </button>
              {list.id !== 'default' && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemoveList(list.id)
                  }}
                  className="hidden group-hover:block rounded p-0.5 text-[rgb(var(--muted))] hover:text-red-500 transition-colors"
                  aria-label={`Remove ${list.name}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}

          <div className="border-t border-[rgb(var(--border))] mt-1 pt-1">
            {isAdding ? (
              <div className="flex items-center gap-2 px-3 py-1.5">
                <input
                  autoFocus
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAdd()
                    if (e.key === 'Escape') {
                      setIsAdding(false)
                      setNewName('')
                    }
                  }}
                  onBlur={() => {
                    if (newName.trim()) handleAdd()
                    else setIsAdding(false)
                  }}
                  placeholder="List name"
                  className="flex-1 min-w-0 bg-transparent text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] outline-none"
                />
              </div>
            ) : (
              <button
                onClick={() => setIsAdding(true)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                Add new list
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
