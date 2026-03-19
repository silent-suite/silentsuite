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

export function RecurrencePicker({ value, onChange }: RecurrencePickerProps) {
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

  const handleFreqChange = useCallback(
    (newFreq: Frequency) => {
      setFreq(newFreq)
      if (newFreq === 'NONE') {
        setShowCustom(false)
        onChange(null)
      } else {
        onChange(buildRRule(newFreq, interval, endType, count, until))
      }
    },
    [interval, endType, count, until, onChange],
  )

  const handleIntervalChange = useCallback(
    (val: number) => {
      const clamped = Math.max(1, val)
      setInterval(clamped)
      onChange(buildRRule(freq, clamped, endType, count, until))
    },
    [freq, endType, count, until, onChange],
  )

  const handleEndTypeChange = useCallback(
    (val: EndType) => {
      setEndType(val)
      onChange(buildRRule(freq, interval, val, count, until))
    },
    [freq, interval, count, until, onChange],
  )

  const handleCountChange = useCallback(
    (val: number) => {
      const clamped = Math.max(1, val)
      setCount(clamped)
      onChange(buildRRule(freq, interval, endType, clamped, until))
    },
    [freq, interval, endType, until, onChange],
  )

  const handleUntilChange = useCallback(
    (val: string) => {
      setUntil(val)
      onChange(buildRRule(freq, interval, endType, count, val))
    },
    [freq, interval, endType, count, onChange],
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <select
          value={freq}
          onChange={(e) => handleFreqChange(e.target.value as Frequency)}
          aria-label="Repeat frequency"
          className="flex-1 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-2 py-1.5 text-xs text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
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
    </div>
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
