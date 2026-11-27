import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskDateInput } from '../TaskDateInput'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'

function field() {
  return screen.getByLabelText<HTMLInputElement>('Due date')
}

describe('TaskDateInput follows the date-format preference (WEB-21)', () => {
  afterEach(() => {
    act(() => usePreferencesStore.setState({ dateFormat: 'system' }))
  })

  it.each([
    ['DD/MM/YYYY', '20/11/2026'],
    ['MM/DD/YYYY', '11/20/2026'],
    ['DD.MM.YYYY', '20.11.2026'],
    ['YYYY/MM/DD', '2026/11/20'],
    ['system', '2026-11-20'],
  ] as const)('shows the date as text in %s', (dateFormat, shown) => {
    usePreferencesStore.setState({ dateFormat })
    render(<TaskDateInput value="2026-11-20" onChange={() => {}} aria-label="Due date" />)
    expect(field()).toHaveAttribute('type', 'text')
    expect(field()).toHaveValue(shown)
  })

  it('reports a typed date as an ISO day, an empty field as no date, and invalid text as null', () => {
    usePreferencesStore.setState({ dateFormat: 'DD.MM.YYYY' })
    const onChange = vi.fn()
    render(<TaskDateInput value="2026-11-20" onChange={onChange} aria-label="Due date" />)

    fireEvent.change(field(), { target: { value: '5.12.2026' } })
    expect(onChange).toHaveBeenLastCalledWith('2026-12-05')
    fireEvent.blur(field())
    expect(field()).toHaveValue('05.12.2026')

    fireEvent.change(field(), { target: { value: '31.02.2026' } })
    expect(onChange).toHaveBeenLastCalledWith(null)
    expect(screen.getByRole('alert')).toHaveTextContent('Use 09.06.2026 format')
    expect(field()).toHaveAttribute('aria-invalid', 'true')

    fireEvent.change(field(), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('with commitOnBlur reports only a valid, changed date when the field is left', () => {
    usePreferencesStore.setState({ dateFormat: 'MM/DD/YYYY' })
    const onChange = vi.fn()
    render(<TaskDateInput value="2026-11-20" onChange={onChange} commitOnBlur aria-label="Due date" />)

    fireEvent.change(field(), { target: { value: '11/2' } })
    fireEvent.blur(field())
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(field(), { target: { value: '11/20/2026' } })
    fireEvent.blur(field())
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(field(), { target: { value: '12/1/2026' } })
    fireEvent.keyDown(field(), { key: 'Enter' })
    fireEvent.blur(field())
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('2026-12-01')
  })

  it('reformats when the preference or the stored date changes', () => {
    usePreferencesStore.setState({ dateFormat: 'DD/MM/YYYY' })
    const { rerender } = render(<TaskDateInput value="2026-11-20" onChange={() => {}} aria-label="Due date" />)
    act(() => usePreferencesStore.setState({ dateFormat: 'YYYY/MM/DD' }))
    expect(field()).toHaveValue('2026/11/20')
    rerender(<TaskDateInput value="2026-12-24" onChange={() => {}} aria-label="Due date" />)
    expect(field()).toHaveValue('2026/12/24')
  })
})
