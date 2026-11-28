'use client'

import { useEffect, useRef, useState } from 'react'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'
import { dateFormatExample, formatEventDateInput, parseEventDateInput } from '@/app/lib/date'

/**
 * A task date typed as text in the user's date-format preference, like the event dialog's date
 * fields. `value` is an ISO day (YYYY-MM-DD), '' for no date, or null while the typed text is
 * not a valid date. By default every keystroke reports the parsed value (null while invalid);
 * with `commitOnBlur` only a valid, changed value is reported, on blur or Enter.
 */
export function TaskDateInput({
  value,
  onChange,
  commitOnBlur = false,
  className,
  containerClassName = '',
  ...inputProps
}: {
  value: string | null
  onChange: (isoDate: string | null) => void
  commitOnBlur?: boolean
  className?: string
  containerClassName?: string
  'aria-label': string
  readOnly?: boolean
  title?: string
}) {
  const dateFormat = usePreferencesStore((s) => s.dateFormat)
  const [text, setText] = useState(() => formatEventDateInput(value ?? '', dateFormat))
  const [error, setError] = useState<string | null>(null)
  // A new `value` from outside (another device, a reset) replaces the text; the field's own
  // reports coming back as `value` do not, so typing is never reformatted mid-entry.
  const reported = useRef(value)
  const lastValue = useRef(value)
  const shownFormat = useRef(dateFormat)

  useEffect(() => {
    const formatChanged = shownFormat.current !== dateFormat
    shownFormat.current = dateFormat
    const valueChanged = value !== lastValue.current
    lastValue.current = value
    if (valueChanged && value !== reported.current) {
      reported.current = value
      if (value !== null) {
        setText(formatEventDateInput(value, dateFormat))
        setError(null)
      }
    } else if (formatChanged && !error && value !== null) {
      setText(formatEventDateInput(value, dateFormat))
    }
  }, [value, dateFormat, error])

  const parse = (input: string): string | null => (input.trim() === '' ? '' : parseEventDateInput(input, dateFormat))

  const handleChange = (input: string) => {
    setText(input)
    const parsed = parse(input)
    setError(parsed === null ? `Use ${dateFormatExample(dateFormat)} format` : null)
    if (!commitOnBlur) {
      reported.current = parsed
      onChange(parsed)
    }
  }

  const handleBlur = () => {
    const parsed = parse(text)
    if (parsed === null) return
    setText(formatEventDateInput(parsed, dateFormat))
    if (commitOnBlur && parsed !== value) {
      reported.current = parsed
      onChange(parsed)
    }
  }

  return (
    <span className={`flex min-w-0 flex-col ${containerClassName}`}>
      <input
        type="text"
        // Every accepted format needs a separator, which a digits-only keypad can't type.
        inputMode="text"
        placeholder={dateFormatExample(dateFormat)}
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={(e) => {
          if (commitOnBlur && e.key === 'Enter') e.currentTarget.blur()
        }}
        aria-invalid={error ? 'true' : undefined}
        className={className}
        {...inputProps}
      />
      {error && (
        <span className="mt-1 text-xs text-red-500" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}
