'use client'

import { useCallback, useState } from 'react'
import { Tag, X } from 'lucide-react'

// ---------------------------------------------------------------------------
// Shared label / category chip components (#291)
//
// Labels round-trip through ICS/vCard CATEGORIES in the core layer. These
// components provide a consistent add/remove/display affordance across the
// calendar, tasks, and contacts UIs.
// ---------------------------------------------------------------------------

/** Normalize a raw label list: trim, drop empties, de-dupe case-insensitively
 *  while preserving the first-seen casing and order. */
export function normalizeLabels(labels: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of labels) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(trimmed)
  }
  return result
}

// ---------------------------------------------------------------------------
// LabelChips — read-only display
// ---------------------------------------------------------------------------

export function LabelChips({
  labels,
  className = '',
}: {
  labels: string[] | undefined
  className?: string
}) {
  if (!labels || labels.length === 0) return null
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {labels.map((label) => (
        <span
          key={label}
          className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300"
        >
          <Tag className="h-3 w-3" />
          {label}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// LabelEditor — add / remove chips
// ---------------------------------------------------------------------------

export function LabelEditor({
  labels,
  onChange,
  disabled = false,
  placeholder = 'Add label…',
  'aria-label': ariaLabel = 'Labels',
}: {
  labels: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  placeholder?: string
  'aria-label'?: string
}) {
  const [input, setInput] = useState('')

  const commit = useCallback(
    (raw: string) => {
      const next = normalizeLabels([...labels, raw])
      if (next.length !== labels.length) onChange(next)
      setInput('')
    },
    [labels, onChange],
  )

  const remove = useCallback(
    (label: string) => {
      onChange(labels.filter((l) => l !== label))
    },
    [labels, onChange],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault()
        if (input.trim()) commit(input)
      } else if (e.key === 'Backspace' && !input && labels.length > 0) {
        // Quick-delete the last chip when the input is empty
        remove(labels[labels.length - 1]!)
      }
    },
    [input, labels, commit, remove],
  )

  return (
    <div className="flex flex-1 flex-wrap items-center gap-1.5 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-2 py-1.5 focus-within:ring-2 focus-within:ring-emerald-500">
      {labels.map((label) => (
        <span
          key={label}
          className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300"
        >
          <Tag className="h-3 w-3" />
          {label}
          {!disabled && (
            <button
              type="button"
              onClick={() => remove(label)}
              className="rounded-full p-0.5 hover:text-red-500 transition-colors"
              aria-label={`Remove label ${label}`}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => input.trim() && commit(input)}
          placeholder={labels.length === 0 ? placeholder : ''}
          aria-label={ariaLabel}
          className="min-w-[6rem] flex-1 bg-transparent text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none"
        />
      )}
    </div>
  )
}
