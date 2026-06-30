'use client'

import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react'
import { Palette, Tag, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { getLabelSuggestions } from '@silentsuite/core'
import {
  getLabelColor,
  labelTextColor,
  useLabelColorStore,
} from '@/app/stores/use-label-color-store'
import { useLabelSuggestionsStore } from '@/app/stores/use-label-suggestions-store'

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
      {labels.map((label, index) => (
        <LabelChip
          key={`${label}-${index}`}
          label={label}
        />
      ))}
    </div>
  )
}

function LabelChip({
  label,
  disabled = false,
  onRemove,
  changeColorLabel,
  removeLabel,
}: {
  label: string
  disabled?: boolean
  onRemove?: () => void
  changeColorLabel?: string
  removeLabel?: string
}) {
  const colors = useLabelColorStore((state) => state.colors)
  const setLabelColor = useLabelColorStore((state) => state.setLabelColor)
  const colorInputRef = useRef<HTMLInputElement>(null)
  const color = getLabelColor(label, colors)
  const handleColorInput = useCallback((event: FormEvent<HTMLInputElement>) => {
    setLabelColor(label, event.currentTarget.value)
  }, [label, setLabelColor])

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium shadow-sm ring-1 ring-black/5"
      style={{ backgroundColor: color, color: labelTextColor(color) }}
    >
      <Tag className="h-3 w-3" />
      {label}
      {onRemove && !disabled && (
        <>
          <button
            type="button"
            onClick={() => colorInputRef.current?.click()}
            className="rounded-full p-1 transition-colors hover:bg-black/10 focus:outline-none focus:ring-1 focus:ring-white/80 max-md:min-h-[44px] max-md:min-w-[44px] max-md:flex max-md:items-center max-md:justify-center max-md:-my-2 max-md:-mx-1.5"
            aria-label={changeColorLabel}
          >
            <Palette className="h-3 w-3" />
          </button>
          <input
            ref={colorInputRef}
            type="color"
            value={color}
            onInput={handleColorInput}
            onChange={handleColorInput}
            className="sr-only"
            aria-label={changeColorLabel}
          />
          <button
            type="button"
            onClick={onRemove}
            className="rounded-full p-1 transition-colors hover:bg-black/10 focus:outline-none focus:ring-1 focus:ring-white/80 max-md:min-h-[44px] max-md:min-w-[44px] max-md:flex max-md:items-center max-md:justify-center max-md:-my-2 max-md:-mx-1.5"
            aria-label={removeLabel}
          >
            <X className="h-3 w-3" />
          </button>
        </>
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// LabelEditor — add / remove chips
// ---------------------------------------------------------------------------

export function LabelEditor({
  labels,
  onChange,
  disabled = false,
  placeholder,
  'aria-label': ariaLabel,
}: {
  labels: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  placeholder?: string
  'aria-label'?: string
}) {
  const t = useTranslations('Labels')
  const [input, setInput] = useState('')
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const labelIndex = useLabelSuggestionsStore((state) => state.index)
  const suggestions = useMemo(
    () => getLabelSuggestions(labelIndex, input, 6, labels),
    [labelIndex, input, labels],
  )

  const commit = useCallback(
    (raw: string) => {
      const next = normalizeLabels([...labels, raw])
      if (next.length !== labels.length) onChange(next)
      setInput('')
      setActiveSuggestion(0)
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
        if (suggestions.length > 0 && (e.key === 'Enter' || !input.trim())) {
          commit(suggestions[activeSuggestion] ?? suggestions[0]!)
        } else if (input.trim()) commit(input)
      } else if (e.key === 'ArrowDown' && suggestions.length > 0) {
        e.preventDefault()
        setActiveSuggestion((current) => (current + 1) % suggestions.length)
      } else if (e.key === 'ArrowUp' && suggestions.length > 0) {
        e.preventDefault()
        setActiveSuggestion((current) => (current - 1 + suggestions.length) % suggestions.length)
      } else if (e.key === 'Escape') {
        setInput('')
        setActiveSuggestion(0)
      } else if (e.key === 'Backspace' && !input && labels.length > 0) {
        // Quick-delete the last chip when the input is empty
        remove(labels[labels.length - 1]!)
      }
    },
    [input, labels, commit, remove, suggestions, activeSuggestion],
  )

  return (
    <div className="relative flex flex-1 flex-wrap items-center gap-1.5 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-2 py-1.5 focus-within:ring-2 focus-within:ring-emerald-500">
      {labels.map((label, index) => (
        <LabelChip
          key={`${label}-${index}`}
          label={label}
          disabled={disabled}
          onRemove={() => remove(label)}
          changeColorLabel={t('changeLabelColor', { label })}
          removeLabel={t('removeLabel', { label })}
        />
      ))}
      {!disabled && (
        <input
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setActiveSuggestion(0)
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => input.trim() && commit(input)}
          placeholder={labels.length === 0 ? (placeholder ?? t('addLabelPlaceholder')) : ''}
          aria-label={ariaLabel ?? t('editorAriaLabel')}
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          className="min-w-[6rem] flex-1 bg-transparent text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none"
        />
      )}
      {!disabled && suggestions.length > 0 && (
        <div
          role="listbox"
          aria-label={t('suggestionsAriaLabel')}
          className="absolute left-2 right-2 top-[calc(100%+0.25rem)] z-50 max-h-48 overflow-auto rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] py-1 text-sm shadow-lg"
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion}
              type="button"
              role="option"
              aria-selected={index === activeSuggestion}
              onMouseDown={(event) => {
                event.preventDefault()
                commit(suggestion)
              }}
              onMouseEnter={() => setActiveSuggestion(index)}
              className={`block w-full px-3 py-1.5 text-left ${index === activeSuggestion ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'text-[rgb(var(--foreground))]'}`}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
