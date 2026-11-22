'use client'

import { useCallback, useState } from 'react'

type Frequency = 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

const FREQUENCY_LABELS: Record<Frequency, string> = {
  NONE: 'Does not repeat',
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
  YEARLY: 'Yearly',
}

interface RecurrencePickerProps {
  /** Current RRULE string or null */
  value: string | null
  /** Called with the new RRULE string, or null for no recurrence */
  onChange: (rrule: string | null) => void
  /** Read-only: every control is disabled, as for the dialog's other fields. */
  disabled?: boolean
}

function parseFrequency(rrule: string | null): Frequency {
  if (!rrule) return 'NONE'
  const match = rrule.match(/FREQ=(\w+)/)
  return (match?.[1] as Frequency) ?? 'NONE'
}

function parseInterval(rrule: string | null): number {
  if (!rrule) return 1
  const match = rrule.match(/INTERVAL=(\d+)/)
  return match ? parseInt(match[1], 10) : 1
}

function parseCount(rrule: string | null): number | undefined {
  if (!rrule) return undefined
  const match = rrule.match(/COUNT=(\d+)/)
  return match ? parseInt(match[1], 10) : undefined
}

function parseUntil(rrule: string | null): string | undefined {
  if (!rrule) return undefined
  const match = rrule.match(/UNTIL=(\d{8})/)
  if (!match) return undefined
  const v = match[1]
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`
}

type EndType = 'never' | 'count' | 'until'

function buildRRule(
  freq: Frequency,
  interval: number,
  endType: EndType,
  count: number,
  until: string,
): string | null {
  if (freq === 'NONE') return null
  const parts = [`FREQ=${freq}`]
  if (interval > 1) parts.push(`INTERVAL=${interval}`)
  if (endType === 'count' && count > 0) parts.push(`COUNT=${count}`)
  if (endType === 'until' && until) {
    parts.push(`UNTIL=${until.replace(/-/g, '')}`)
  }
  return parts.join(';')
}

const partKey = (part: string): string => part.split('=', 1)[0]!.toUpperCase()

/**
 * `rrule` with each named part set in place (appended when absent) or removed when undefined.
 * Every other part (BYDAY, BYMONTHDAY, BYSETPOS, WKST, ...) is kept as written, so editing the
 * interval or end of an imported rule does not change which days it falls on.
 */
function withParts(rrule: string, changes: Record<string, string | undefined>): string {
  const parts = rrule.split(';').filter((part) => part !== '')
  for (const [key, value] of Object.entries(changes)) {
    const index = parts.findIndex((part) => partKey(part) === key)
    if (value === undefined) {
      if (index !== -1) parts.splice(index, 1)
    } else if (index !== -1) {
      parts[index] = `${key}=${value}`
    } else {
      parts.push(`${key}=${value}`)
    }
  }
  return parts.join(';')
}

/** The end parts for an end condition: at most one of COUNT and UNTIL. */
function endParts(endType: EndType, count: number, until: string): Record<string, string | undefined> {
  return {
    COUNT: endType === 'count' && count > 0 ? String(count) : undefined,
    UNTIL: endType === 'until' && until ? until.replace(/-/g, '') : undefined,
  }
}

export function RecurrencePicker({ value, onChange, disabled = false }: RecurrencePickerProps) {
  const [showCustom, setShowCustom] = useState(false)
  const [freq, setFreq] = useState<Frequency>(() => parseFrequency(value))
  const [interval, setInterval] = useState(() => parseInterval(value))
  const [endType, setEndType] = useState<EndType>(() => {
    if (parseCount(value)) return 'count'
    if (parseUntil(value)) return 'until'
    return 'never'
  })
  const [count, setCount] = useState(() => parseCount(value) ?? 10)
  const [until, setUntil] = useState(() => parseUntil(value) ?? '')

  // Edits change only the part the user touched; the rest of the current rule is kept.
  const edit = useCallback(
    (changes: Record<string, string | undefined>) => onChange(withParts(value ?? `FREQ=${freq}`, changes)),
    [value, freq, onChange],
  )

  const handleFreqChange = useCallback(
    (newFreq: Frequency) => {
      setFreq(newFreq)
      if (newFreq === 'NONE') {
        setShowCustom(false)
        onChange(null)
      } else if (!value) {
        onChange(buildRRule(newFreq, interval, endType, count, until))
      } else {
        // BY* parts select days within the old frequency's period (BYDAY=MO,WE,FR of a week,
        // BYMONTHDAY=15 of a month) and change meaning or become invalid under another one, so a
        // new frequency drops them. Interval, end, WKST and any other parts are kept.
        const kept = value.split(';').filter((part) => part !== '' && !partKey(part).startsWith('BY'))
        onChange(withParts(kept.join(';'), { FREQ: newFreq }))
      }
    },
    [value, interval, endType, count, until, onChange],
  )

  const handleIntervalChange = useCallback(
    (val: number) => {
      const clamped = Math.max(1, val)
      setInterval(clamped)
      edit({ INTERVAL: clamped > 1 ? String(clamped) : undefined })
    },
    [edit],
  )

  const handleEndTypeChange = useCallback(
    (val: EndType) => {
      setEndType(val)
      edit(endParts(val, count, until))
    },
    [edit, count, until],
  )

  const handleCountChange = useCallback(
    (val: number) => {
      const clamped = Math.max(1, val)
      setCount(clamped)
      edit(endParts(endType, clamped, until))
    },
    [edit, endType, until],
  )

  const handleUntilChange = useCallback(
    (val: string) => {
      setUntil(val)
      edit(endParts(endType, count, val))
    },
    [edit, endType, count],
  )

  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <select
          value={freq}
          onChange={(e) => handleFreqChange(e.target.value as Frequency)}
          aria-label="Repeat frequency"
          className="flex-1 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-2 py-1.5 text-xs text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {(Object.keys(FREQUENCY_LABELS) as Frequency[]).map((f) => (
            <option key={f} value={f}>
              {FREQUENCY_LABELS[f]}
            </option>
          ))}
        </select>
        {freq !== 'NONE' && (
          <button
            type="button"
            onClick={() => setShowCustom((v) => !v)}
            className="text-xs text-[rgb(var(--primary))] hover:underline"
          >
            {showCustom ? 'Simple' : 'Custom'}
          </button>
        )}
      </div>

      {freq !== 'NONE' && showCustom && (
        <div className="ml-6 flex flex-col gap-2 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-2">
          {/* Interval */}
          <label className="flex items-center gap-2 text-xs text-[rgb(var(--foreground))]">
            Every
            <input
              type="number"
              min={1}
              max={99}
              value={interval}
              onChange={(e) => handleIntervalChange(parseInt(e.target.value, 10) || 1)}
              className="w-14 rounded border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-1.5 py-1 text-xs text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            {freq === 'DAILY' && (interval === 1 ? 'day' : 'days')}
            {freq === 'WEEKLY' && (interval === 1 ? 'week' : 'weeks')}
            {freq === 'MONTHLY' && (interval === 1 ? 'month' : 'months')}
            {freq === 'YEARLY' && (interval === 1 ? 'year' : 'years')}
          </label>

          {/* End condition */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-[rgb(var(--muted))]">Ends</span>
            <label className="flex items-center gap-2 text-xs text-[rgb(var(--foreground))]">
              <input
                type="radio"
                name="recurrence-end"
                checked={endType === 'never'}
                onChange={() => handleEndTypeChange('never')}
                className="accent-emerald-500"
              />
              Never
            </label>
            <label className="flex items-center gap-2 text-xs text-[rgb(var(--foreground))]">
              <input
                type="radio"
                name="recurrence-end"
                checked={endType === 'count'}
                onChange={() => handleEndTypeChange('count')}
                className="accent-emerald-500"
              />
              After
              <input
                type="number"
                min={1}
                max={999}
                value={count}
                onChange={(e) => handleCountChange(parseInt(e.target.value, 10) || 1)}
                disabled={endType !== 'count'}
                className="w-14 rounded border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-1.5 py-1 text-xs text-[rgb(var(--foreground))] disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              occurrences
            </label>
            <label className="flex items-center gap-2 text-xs text-[rgb(var(--foreground))]">
              <input
                type="radio"
                name="recurrence-end"
                checked={endType === 'until'}
                onChange={() => handleEndTypeChange('until')}
                className="accent-emerald-500"
              />
              On
              <input
                type="date"
                value={until}
                onChange={(e) => handleUntilChange(e.target.value)}
                disabled={endType !== 'until'}
                className="rounded border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-1.5 py-1 text-xs text-[rgb(var(--foreground))] disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </label>
          </div>
        </div>
      )}
    </fieldset>
  )
}

/** Human-readable label for a recurrence rule */
export function recurrenceLabel(rrule: string | null): string | null {
  if (!rrule) return null
  const freq = parseFrequency(rrule)
  if (freq === 'NONE') return null
  const interval = parseInterval(rrule)
  const prefix = interval > 1 ? `Every ${interval} ` : ''
  const unit =
    freq === 'DAILY'
      ? interval > 1 ? 'days' : 'day'
      : freq === 'WEEKLY'
        ? interval > 1 ? 'weeks' : 'week'
        : freq === 'MONTHLY'
          ? interval > 1 ? 'months' : 'month'
          : interval > 1 ? 'years' : 'year'
  const label = interval > 1 ? `${prefix}${unit}` : `${FREQUENCY_LABELS[freq]}`
  return `Repeats ${label.toLowerCase()}`
}
