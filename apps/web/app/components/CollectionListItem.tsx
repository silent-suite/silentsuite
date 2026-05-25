'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MoreHorizontal, Palette, Pencil, Star, Trash2 } from 'lucide-react'

interface CollectionListItemProps {
  name: string
  color: string
  visible: boolean
  isDefault: boolean
  canDelete: boolean
  itemLabel: string
  defaultLabel: string
  deleteLabel: string
  onToggleVisibility: () => void
  onRename: (name: string) => void
  onSetDefault: () => void
  onColorChange: (color: string) => void
  onDelete: () => void
}

export function CollectionListItem({
  name,
  color,
  visible,
  isDefault,
  canDelete,
  itemLabel,
  defaultLabel,
  deleteLabel,
  onToggleVisibility,
  onRename,
  onSetDefault,
  onColorChange,
  onDelete,
}: CollectionListItemProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [draftName, setDraftName] = useState(name)
  const rowRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const colorInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isRenaming) setDraftName(name)
  }, [isRenaming, name])

  useEffect(() => {
    if (isRenaming) {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    }
  }, [isRenaming])

  useEffect(() => {
    if (!menuOpen) return

    function handlePointerDown(event: MouseEvent) {
      if (!rowRef.current?.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        menuButtonRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    const focusFirstItem = () => {
      menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    }
    const frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(focusFirstItem)
      : window.setTimeout(focusFirstItem, 0)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
      else window.clearTimeout(frame)
    }
  }, [menuOpen])

  const finishRename = useCallback(() => {
    const trimmed = draftName.trim()
    setIsRenaming(false)
    if (trimmed && trimmed !== name) {
      onRename(trimmed)
    } else {
      setDraftName(name)
    }
  }, [draftName, name, onRename])

  const cancelRename = useCallback(() => {
    setDraftName(name)
    setIsRenaming(false)
  }, [name])

  const startRename = useCallback(() => {
    setDraftName(name)
    setIsRenaming(true)
    setMenuOpen(false)
  }, [name])

  const handleMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    if (buttons.length === 0) return
    const currentIndex = buttons.findIndex((button) => button === document.activeElement)
    const nextIndex = event.key === 'ArrowDown'
      ? (currentIndex + 1) % buttons.length
      : (currentIndex - 1 + buttons.length) % buttons.length
    buttons[nextIndex]?.focus()
  }, [])

  return (
    <div
      ref={rowRef}
      className="relative flex items-center gap-2 rounded px-1 py-1 hover:bg-[rgb(var(--background))] transition-colors"
    >
      <button
        type="button"
        onClick={onToggleVisibility}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded focus:outline-none focus:ring-2 focus:ring-emerald-500"
        aria-label={`${visible ? 'Hide' : 'Show'} ${name}`}
      >
        <span
          className="h-3 w-3 rounded-sm"
          style={{
            backgroundColor: visible ? color : 'transparent',
            border: visible ? 'none' : `2px solid ${color}`,
          }}
        />
      </button>

      <div className="min-w-0 flex-1">
        {isRenaming ? (
          <input
            ref={nameInputRef}
            type="text"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={finishRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') finishRename()
              if (event.key === 'Escape') cancelRename()
            }}
            aria-label={`Rename ${name}`}
            className="w-full bg-transparent text-xs text-[rgb(var(--foreground))] outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={onToggleVisibility}
            className="block w-full min-w-0 text-left focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <span className={`block truncate text-xs ${
              visible ? 'text-[rgb(var(--foreground))]' : 'text-[rgb(var(--muted))]'
            }`}>
              {name}
            </span>
          </button>
        )}
      </div>

      <div className="flex w-10 shrink-0 items-center justify-end gap-0.5">
        {isDefault && (
          <Star
            className="h-3 w-3 fill-current text-amber-500"
            aria-label={defaultLabel}
          />
        )}
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          className="rounded p-0.5 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Open ${name} actions`}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>

      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={handleMenuKeyDown}
          className="absolute right-0 top-full z-[120] mt-1 w-44 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] py-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={startRename}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] focus:bg-[rgb(var(--surface))] focus:outline-none"
          >
            <Pencil className="h-3.5 w-3.5 text-[rgb(var(--muted))]" />
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onSetDefault()
              setMenuOpen(false)
              menuButtonRef.current?.focus()
            }}
            disabled={isDefault}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] focus:bg-[rgb(var(--surface))] focus:outline-none disabled:cursor-default disabled:text-[rgb(var(--muted))]"
          >
            <Star className={`h-3.5 w-3.5 ${isDefault ? 'fill-current text-amber-500' : 'text-[rgb(var(--muted))]'}`} />
            {isDefault ? defaultLabel : 'Set as default'}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => colorInputRef.current?.click()}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] focus:bg-[rgb(var(--surface))] focus:outline-none"
          >
            <Palette className="h-3.5 w-3.5 text-[rgb(var(--muted))]" />
            Change color
          </button>
          <input
            ref={colorInputRef}
            type="color"
            value={color}
            onChange={(event) => {
              onColorChange(event.target.value)
              setMenuOpen(false)
              menuButtonRef.current?.focus()
            }}
            className="sr-only"
            aria-label={`Change ${name} color`}
          />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              if (!canDelete) return
              setMenuOpen(false)
              onDelete()
            }}
            disabled={!canDelete}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-500 hover:bg-red-500/10 focus:bg-red-500/10 focus:outline-none disabled:cursor-not-allowed disabled:text-[rgb(var(--muted))] disabled:hover:bg-transparent"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {deleteLabel}
          </button>
          {!canDelete && (
            <p className="px-3 pt-0.5 text-[10px] text-[rgb(var(--muted))]">Create another {itemLabel} before deleting.</p>
          )}
        </div>
      )}
    </div>
  )
}
