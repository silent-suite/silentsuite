import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StepCreatePaidAccount } from '../components/step-create-paid-account'

describe.each(['verified-no-card', 'payment-confirmed'] as const)('password visibility toggle (%s)', (continuation) => {
  it('starts masked with a closed eye, reveals and hides without submitting or losing the value', async () => {
    const onNext = vi.fn().mockResolvedValue(undefined)
    const { container } = render(<StepCreatePaidAccount email="user@example.com" onNext={onNext} continuation={continuation} />)

    const input = screen.getByLabelText(/^Password$/) as HTMLInputElement
    const toggle = screen.getByRole('button', { name: 'Show password' })
    expect(input.type).toBe('password')
    expect(toggle.getAttribute('type')).toBe('button')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(toggle.querySelector('.lucide-eye-off')).not.toBeNull()
    expect(screen.queryByText('Show password')).toBeNull()

    fireEvent.change(input, { target: { value: 'StrongPass1' } })
    if (continuation !== 'verified-no-card') {
      fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'StrongPass1' } })
    }

    toggle.focus()
    expect(document.activeElement).toBe(toggle)

    await act(async () => { fireEvent.click(toggle) })
    const hide = screen.getByRole('button', { name: 'Hide password' })
    expect(input.type).toBe('text')
    expect(input.value).toBe('StrongPass1')
    expect(hide.getAttribute('aria-pressed')).toBe('true')
    expect(hide.querySelector('.lucide-eye')).not.toBeNull()
    expect(hide.querySelector('.lucide-eye-off')).toBeNull()

    await act(async () => { fireEvent.click(hide) })
    expect(input.type).toBe('password')
    expect(input.value).toBe('StrongPass1')
    expect(screen.getByRole('button', { name: 'Show password' }).getAttribute('aria-pressed')).toBe('false')

    expect(onNext).not.toHaveBeenCalled()
    if (continuation !== 'verified-no-card') {
      expect((screen.getByLabelText('Confirm password') as HTMLInputElement).type).toBe('password')
    }
    expect(container.querySelectorAll('input[type="text"]')).toHaveLength(0)
  })

  it('warns under the password field that a lost password cannot be recovered', () => {
    render(<StepCreatePaidAccount email="user@example.com" onNext={vi.fn()} continuation={continuation} />)

    const hint = screen.getByText(
      "We can't reset this password. If you lose it, your data can't be recovered. Store it in a password manager.",
    )
    expect(hint.id).toBe('paid-signup-password-hint')
    expect(screen.getByLabelText(/^Password$/).getAttribute('aria-describedby')).toBe('paid-signup-password-hint')
  })
})
