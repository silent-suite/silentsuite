import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ConfirmDialog } from '../confirm-dialog'

describe('ConfirmDialog', () => {
  it('is exposed to assistive technology as a modal dialog named by its title', () => {
    render(<ConfirmDialog title="Delete note?" message="Gone for good." onConfirm={() => {}} onCancel={() => {}} />)

    // Found without the hidden option: neither the dialog nor its backdrop is aria-hidden.
    const dialog = screen.getByRole('dialog', { name: 'Delete note?' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleDescription('Gone for good.')
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('confirms, cancels, and closes on backdrop click and Escape', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const { container } = render(
      <ConfirmDialog title="Delete note?" message="Gone for good." confirmLabel="Delete note" onConfirm={onConfirm} onCancel={onCancel} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(container.firstElementChild!)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(3)
  })
})
