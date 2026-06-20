import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LabelEditor, LabelChips, normalizeLabels } from '../LabelEditor'

vi.mock('lucide-react', () => ({
  Tag: () => <svg data-testid="tag-icon" />,
  X: () => <svg data-testid="x-icon" />,
}))

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
})

describe('LabelEditor', () => {
  it('adds a label on Enter', () => {
    const onChange = vi.fn()
    render(<LabelEditor labels={[]} onChange={onChange} />)
    const input = screen.getByLabelText('Labels')
    fireEvent.change(input, { target: { value: 'Work' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['Work'])
  })

  it('adds a label on comma', () => {
    const onChange = vi.fn()
    render(<LabelEditor labels={[]} onChange={onChange} />)
    const input = screen.getByLabelText('Labels')
    fireEvent.change(input, { target: { value: 'Urgent' } })
    fireEvent.keyDown(input, { key: ',' })
    expect(onChange).toHaveBeenCalledWith(['Urgent'])
  })

  it('does not add a duplicate label (case-insensitive)', () => {
    const onChange = vi.fn()
    render(<LabelEditor labels={['Work']} onChange={onChange} />)
    const input = screen.getByLabelText('Labels')
    fireEvent.change(input, { target: { value: 'work' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes a label via its remove button', () => {
    const onChange = vi.fn()
    render(<LabelEditor labels={['Work', 'Home']} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Remove label Work'))
    expect(onChange).toHaveBeenCalledWith(['Home'])
  })

  it('removes the last chip on Backspace when the input is empty', () => {
    const onChange = vi.fn()
    render(<LabelEditor labels={['Work', 'Home']} onChange={onChange} />)
    const input = screen.getByLabelText('Labels')
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(onChange).toHaveBeenCalledWith(['Work'])
  })

  it('hides the input and remove buttons when disabled', () => {
    render(<LabelEditor labels={['Work']} onChange={vi.fn()} disabled />)
    expect(screen.queryByLabelText('Labels')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Remove label Work')).not.toBeInTheDocument()
    expect(screen.getByText('Work')).toBeInTheDocument()
  })
})
