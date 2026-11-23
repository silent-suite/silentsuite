import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { expandEventRecurrence, type CalendarEvent } from '@silentsuite/core'
import { RecurrencePicker } from '../RecurrencePicker'

/** The picker as EventDialog uses it: controlled, the rule fed back as `value`. No zone = floating. */
function Controlled({ initial, onChange, allDay = false, timeZone }: {
  initial: string | null
  onChange: (rrule: string | null) => void
  allDay?: boolean
  timeZone?: string
}) {
  const [value, setValue] = useState(initial)
  return (
    <RecurrencePicker
      value={value}
      onChange={(next) => { setValue(next); onChange(next) }}
      allDay={allDay}
      timeZone={timeZone}
    />
  )
}

function openCustom(value: string, series: { allDay?: boolean; timeZone?: string } = { timeZone: 'UTC' }) {
  const onChange = vi.fn()
  const view = render(<Controlled initial={value} onChange={onChange} {...series} />)
  fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
  const [intervalInput, countInput] = screen.getAllByRole('spinbutton')
  const [never, after, on] = screen.getAllByRole('radio')
  const dateInput = view.container.querySelector('input[type="date"]') as HTMLInputElement
  return { ...view, onChange, intervalInput, countInput, never, after, on, dateInput }
}

describe('RecurrencePicker keeps the parts of a rule it does not edit', () => {
  it('keeps BYDAY when the interval changes', () => {
    const { onChange, intervalInput } = openCustom('FREQ=WEEKLY;BYDAY=MO,WE,FR')
    fireEvent.change(intervalInput, { target: { value: '2' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=2')
  })

  it('keeps BYDAY, BYSETPOS and WKST when the end changes, editing COUNT in place', () => {
    const { onChange, countInput, never, on, dateInput } = openCustom('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;WKST=SU;COUNT=5')
    fireEvent.change(countInput, { target: { value: '6' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;WKST=SU;COUNT=6')
    fireEvent.click(never)
    expect(onChange).toHaveBeenLastCalledWith('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;WKST=SU')
    fireEvent.click(on)
    fireEvent.change(dateInput, { target: { value: '2026-06-29' } })
    expect(onChange.mock.lastCall?.[0]).toMatch(/^FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;WKST=SU;UNTIL=20260629/)
  })

  it('keeps BYMONTHDAY and an existing UNTIL when only the interval changes', () => {
    const { onChange, intervalInput } = openCustom('FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20261231T095959Z')
    fireEvent.change(intervalInput, { target: { value: '3' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20261231T095959Z;INTERVAL=3')
  })

  it('drops the old frequency\'s BY* parts on a frequency change and keeps interval, end and WKST', () => {
    const onChange = vi.fn()
    render(<Controlled initial="FREQ=WEEKLY;BYDAY=MO,WE,FR;WKST=SU;INTERVAL=2;COUNT=4" onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat frequency' }), { target: { value: 'MONTHLY' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=MONTHLY;WKST=SU;INTERVAL=2;COUNT=4')
  })

  it('still builds a fresh rule when a non-repeating event starts repeating', () => {
    const onChange = vi.fn()
    render(<Controlled initial={null} onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat frequency' }), { target: { value: 'WEEKLY' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=WEEKLY')
  })
})

describe('RecurrencePicker "Ends on" keeps the chosen last day', () => {
  function endOn(value: string, date: string, series: { allDay?: boolean; timeZone?: string }) {
    const picker = openCustom(value, series)
    fireEvent.click(picker.on)
    fireEvent.change(picker.dateInput, { target: { value: date } })
    picker.unmount()
    return picker.onChange.mock.lastCall?.[0] as string
  }

  it('writes the end of the chosen day in the series zone as a UTC date-time for a zoned series', () => {
    expect(endOn('FREQ=WEEKLY', '2026-06-29', { timeZone: 'America/New_York' })).toBe('FREQ=WEEKLY;UNTIL=20260630T035959Z')
    expect(endOn('FREQ=WEEKLY', '2026-06-29', { timeZone: 'UTC' })).toBe('FREQ=WEEKLY;UNTIL=20260629T235959Z')
  })

  it('writes a floating date-time for a floating series and a date for an all-day series', () => {
    expect(endOn('FREQ=WEEKLY', '2026-06-29', { timeZone: undefined })).toBe('FREQ=WEEKLY;UNTIL=20260629T235959')
    expect(endOn('FREQ=WEEKLY', '2026-06-29', { allDay: true })).toBe('FREQ=WEEKLY;UNTIL=20260629')
  })

  it('keeps the occurrence on the chosen last day of a timed series', () => {
    // Weekly on Monday 10:00 New York, ended on Monday 2026-06-29.
    const rule = endOn('FREQ=WEEKLY', '2026-06-29', { timeZone: 'America/New_York' })
    const event = {
      startDate: new Date('2026-06-15T14:00:00Z'),
      endDate: new Date('2026-06-15T15:00:00Z'),
      allDay: false,
      timezone: 'America/New_York',
      recurrenceRule: rule,
    } as CalendarEvent
    const occurrences = expandEventRecurrence(event, { start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-08-01T00:00:00Z') })
    expect(occurrences.map((d) => d.toISOString())).toEqual([
      '2026-06-15T14:00:00.000Z',
      '2026-06-22T14:00:00.000Z',
      '2026-06-29T14:00:00.000Z',
    ])
  })

  it('shows a UTC date-time UNTIL as its date in the series zone', () => {
    const { dateInput } = openCustom('FREQ=WEEKLY;UNTIL=20260630T035959Z', { timeZone: 'America/New_York' })
    expect(dateInput.value).toBe('2026-06-29')
  })

  it('rewrites the chosen end day when the series zone or all-day flag changes, and not on open', () => {
    const onChange = vi.fn()
    const view = render(<Controlled initial="FREQ=DAILY;UNTIL=20260629" onChange={onChange} allDay />)
    expect(onChange).not.toHaveBeenCalled()
    view.rerender(<Controlled initial="FREQ=DAILY;UNTIL=20260629" onChange={onChange} timeZone="Asia/Tokyo" />)
    expect(onChange).toHaveBeenLastCalledWith('FREQ=DAILY;UNTIL=20260629T145959Z')
    view.rerender(<Controlled initial="FREQ=DAILY;UNTIL=20260629" onChange={onChange} timeZone="America/New_York" />)
    expect(onChange).toHaveBeenLastCalledWith('FREQ=DAILY;UNTIL=20260630T035959Z')
  })
})
