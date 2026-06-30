import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LabelEditor, LabelChips, normalizeLabels } from '../LabelEditor'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { getLabelColor, labelTextColor, useLabelColorStore } from '@/app/stores/use-label-color-store'
import { useLabelSuggestionsStore } from '@/app/stores/use-label-suggestions-store'
import { createLabelIndex } from '@silentsuite/core'

vi.mock('lucide-react', () => ({
  Palette: () => <svg data-testid="palette-icon" />,
  Tag: () => <svg data-testid="tag-icon" />,
  X: () => <svg data-testid="x-icon" />,
}))

beforeEach(() => {
  useLabelColorStore.setState({ colors: {} })
  useLabelSuggestionsStore.getState().destroy()
  localStorage.clear()
})

describe('normalizeLabels', () => {
  it('trims, drops empties, and de-dupes case-insensitively preserving first casing', () => {
    expect(normalizeLabels([' Work ', 'work', '', 'Home', 'WORK'])).toEqual(['Work', 'Home'])
  })

  it('returns an empty array when given only blank entries', () => {
    expect(normalizeLabels(['', '   '])).toEqual([])
  })
})

describe('LabelChips', () => {
  it('renders nothing when there are no labels', () => {
    const { container } = render(<LabelChips labels={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when labels is undefined', () => {
    const { container } = render(<LabelChips labels={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders one chip per label', () => {
    render(<LabelChips labels={['Work', 'Personal']} />)
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.getByText('Personal')).toBeInTheDocument()
  })

  it('uses deterministic colors for labels without stored metadata', () => {
    render(<LabelChips labels={['Work']} />)
    const color = getLabelColor('Work')

    expect(screen.getByText('Work').closest('span')).toHaveStyle({
      backgroundColor: color,
      color: labelTextColor(color),
    })
  })

  it('uses user-selected colors from the label color store', () => {
    useLabelColorStore.getState().setLabelColor('Work', '#ef4444')
    render(<LabelChips labels={['Work']} />)

    expect(screen.getByText('Work').closest('span')).toHaveStyle({
      backgroundColor: '#ef4444',
      color: '#ffffff',
    })
  })
})

describe('LabelEditor', () => {
  it('adds a label on Enter', () => {
    const onChange = vi.fn()
    renderWithIntl(<LabelEditor labels={[]} onChange={onChange} />)
    const input = screen.getByLabelText('Labels')
    fireEvent.change(input, { target: { value: 'Work' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['Work'])
  })

  it('adds a label on comma', () => {
    const onChange = vi.fn()
    renderWithIntl(<LabelEditor labels={[]} onChange={onChange} />)
    const input = screen.getByLabelText('Labels')
    fireEvent.change(input, { target: { value: 'Urgent' } })
    fireEvent.keyDown(input, { key: ',' })
    expect(onChange).toHaveBeenCalledWith(['Urgent'])
  })

  it('adds a label on blur', () => {
    const onChange = vi.fn()
    renderWithIntl(<LabelEditor labels={[]} onChange={onChange} />)
    const input = screen.getByLabelText('Labels')
    fireEvent.change(input, { target: { value: 'Work' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith(['Work'])
  })

  it('does not add a duplicate label (case-insensitive)', () => {
    const onChange = vi.fn()
    renderWithIntl(<LabelEditor labels={['Work']} onChange={onChange} />)
    const input = screen.getByLabelText('Labels')
    fireEvent.change(input, { target: { value: 'work' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes a label via its remove button', () => {
    const onChange = vi.fn()
    renderWithIntl(<LabelEditor labels={['Work', 'Home']} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Remove label Work'))
    expect(onChange).toHaveBeenCalledWith(['Home'])
  })

  it('lets users choose and persist a label color without changing label names', () => {
    const onChange = vi.fn()
    renderWithIntl(<LabelEditor labels={['Work']} onChange={onChange} />)
    const colorInput = screen.getAllByLabelText('Change label Work color')
      .find((element): element is HTMLInputElement => element instanceof HTMLInputElement)!

    fireEvent.input(colorInput, { target: { value: '#3b82f6' } })

    expect(useLabelColorStore.getState().colors.work).toBe('#3b82f6')
    expect(screen.getByText('Work').closest('span')).toHaveStyle({
      backgroundColor: '#3b82f6',
      color: '#ffffff',
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes the last chip on Backspace when the input is empty', () => {
    const onChange = vi.fn()
    renderWithIntl(<LabelEditor labels={['Work', 'Home']} onChange={onChange} />)
    const input = screen.getByLabelText('Labels')
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(onChange).toHaveBeenCalledWith(['Work'])
  })

  it('hides the input and remove buttons when disabled', () => {
    renderWithIntl(<LabelEditor labels={['Work']} onChange={vi.fn()} disabled />)
    expect(screen.queryByLabelText('Labels')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Remove label Work')).not.toBeInTheDocument()
    expect(screen.getByText('Work')).toBeInTheDocument()
  })

  it('shows synced suggestions and selects one with keyboard', () => {
    useLabelSuggestionsStore.setState({
      index: createLabelIndex([
        { label: 'Work', count: 5, lastUsedAt: 10 },
        { label: 'Workout', count: 3, lastUsedAt: 9 },
      ], 10),
    })
    const onChange = vi.fn()
    renderWithIntl(<LabelEditor labels={[]} onChange={onChange} />)
    const input = screen.getByLabelText('Labels')

    fireEvent.change(input, { target: { value: 'wor' } })
    expect(screen.getByRole('option', { name: 'Work' })).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith(['Workout'])
  })

  it('does not suggest labels that are already selected', () => {
    useLabelSuggestionsStore.setState({
      index: createLabelIndex([
        { label: 'Work', count: 5, lastUsedAt: 10 },
        { label: 'Home', count: 3, lastUsedAt: 9 },
      ], 10),
    })

    renderWithIntl(<LabelEditor labels={['Work']} onChange={vi.fn()} />)
    expect(screen.queryByRole('option', { name: 'Work' })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Home' })).toBeInTheDocument()
  })
})
