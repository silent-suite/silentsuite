import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { RecurrencePicker } from '../RecurrencePicker'

/** The picker as EventDialog uses it: controlled, the rule fed back as `value`. */
function Controlled({ initial, onChange }: { initial: string | null; onChange: (rrule: string | null) => void }) {
  const [value, setValue] = useState(initial)
  return <RecurrencePicker value={value} onChange={(next) => { setValue(next); onChange(next) }} />
}

function openCustom(value: string) {
  const onChange = vi.fn()
  const view = render(<Controlled initial={value} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
  const [intervalInput, countInput] = screen.getAllByRole('spinbutton')
  const [never, after, on] = screen.getAllByRole('radio')
  const dateInput = view.container.querySelector('input[type="date"]') as HTMLInputElement
  return { onChange, intervalInput, countInput, never, after, on, dateInput }
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
