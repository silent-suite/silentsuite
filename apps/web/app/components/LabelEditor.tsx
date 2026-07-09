'use client'

import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react'
import { Palette, Tag, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  getLabelColor,
  labelTextColor,
  useLabelColorStore,
} from '@/app/stores/use-label-color-store'
import { useLabelSuggestionsStore, type LabelIndexSource } from '@/app/stores/use-label-suggestions-store'

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
// LabelEditor — add / remove chips + encrypted client-side suggestions
// ---------------------------------------------------------------------------

export function LabelEditor({
  labels,
  onChange,
  disabled = false,
  placeholder,
  source,
  'aria-label': ariaLabel,
}: {
  labels: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  placeholder?: string
  source?: LabelIndexSource
  'aria-label'?: string
}) {
  const t = useTranslations('Labels')
  const [input, setInput] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0)
  const getSuggestions = useLabelSuggestionsStore((state) => state.suggestions)
  const suggestions = useMemo(
    () => (disabled ? [] : getSuggestions(input, labels, 6)),
    [disabled, getSuggestions, input, labels],
  )
  const showSuggestions = Boolean(!disabled && source && isFocused && suggestions.length > 0)

  const commit = useCallback(
    (raw: string) => {
      const next = normalizeLabels([...labels, raw])
      if (next.length !== labels.length) onChange(next)
      setInput('')
      setActiveSuggestionIndex(0)
    },
    [labels, onChange],
  )

  const remove = useCallback(
    (label: string) => {
      onChange(labels.filter((l) => l !== label))
    },
    [labels, onChange],
  )

  const chooseSuggestion = useCallback((suggestion: string) => {
    commit(suggestion)
    setIsFocused(false)
  }, [commit])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown' && showSuggestions) {
        e.preventDefault()
        setActiveSuggestionIndex((index) => (index + 1) % suggestions.length)
      } else if (e.key === 'ArrowUp' && showSuggestions) {
        e.preventDefault()
        setActiveSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length)
      } else if (e.key === 'Escape' && showSuggestions) {
        e.preventDefault()
        setIsFocused(false)
      } else if (e.key === 'Enter' && showSuggestions && suggestions[activeSuggestionIndex]) {
        e.preventDefault()
        chooseSuggestion(suggestions[activeSuggestionIndex]!)
      } else if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault()
        if (input.trim()) commit(input)
      } else if (e.key === 'Backspace' && !input && labels.length > 0) {
        // Quick-delete the last chip when the input is empty
        remove(labels[labels.length - 1]!)
      }
    },
    [activeSuggestionIndex, chooseSuggestion, input, labels, commit, remove, showSuggestions, suggestions],
  )

  return (
    <div className="flex flex-1 flex-wrap items-center gap-1.5 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-2 py-1.5 focus-within:ring-2 focus-within:ring-emerald-500">
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
            setActiveSuggestionIndex(0)
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => {
            setIsFocused(false)
            if (input.trim()) commit(input)
          }}
          placeholder={labels.length === 0 ? (placeholder ?? t('addLabelPlaceholder')) : ''}
          aria-label={ariaLabel ?? t('editorAriaLabel')}
          aria-autocomplete="list"
          className="min-w-[6rem] flex-1 bg-transparent text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none"
        />
      )}
      {showSuggestions && (
        <div className="mt-2 w-full rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-1 shadow-lg" role="listbox" aria-label="Label suggestions">
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion}
              type="button"
              role="option"
              aria-selected={index === activeSuggestionIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseSuggestion(suggestion)}
              className={`w-full rounded px-2 py-1 text-left text-sm ${index === activeSuggestionIndex ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'text-[rgb(var(--foreground))] hover:bg-[rgb(var(--muted))]/10'}`}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
