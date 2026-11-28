import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// SIGNUP-17: the account form shows a field error only once the user leaves the field,
// then keeps it current while they type. Continue and the typo hint still follow each keystroke.

vi.mock('../../../../../../packages/core/node_modules/etebase', () => ({
  Account: { signup: vi.fn(), login: vi.fn(), restore: vi.fn() },
  getPrettyFingerprint: vi.fn(() => 'synthetic fingerprint'),
}))
vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(async () => null),
  secureSet: vi.fn(async () => {}),
  secureRemove: vi.fn(), secureClear: vi.fn(), migrateFromLocalStorage: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('@/app/components/stripe-payment-form', () => ({ default: () => null }))

async function renderSignup() {
  vi.resetModules()
  // Self-host build: the full form (email, confirm email, password, confirm password).
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
  vi.stubEnv('NEXT_PUBLIC_ETEBASE_SERVER_URL', '')
  delete process.env.NEXT_PUBLIC_OWNER_REGISTRATION
  const { default: SignupPage } = await import('../page')
  render(<SignupPage />)
}

const emailError = () => document.getElementById('signup-email-error')
const continueButton = () => screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('sign-up email validation timing (SIGNUP-17)', () => {
  it('waits for blur before showing the email error, then updates it live', async () => {
    await renderSignup()
    const email = screen.getByLabelText('Email')

    fireEvent.change(email, { target: { value: 'p' } })
    await waitFor(() => expect(continueButton().disabled).toBe(true))
    expect(emailError()).toBeNull()
    expect(email.getAttribute('aria-invalid')).toBe('false')

    fireEvent.blur(email)
    await waitFor(() => expect(emailError()?.textContent).toBe('Enter a valid email address.'))
    expect(email.getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(email, { target: { value: 'person@example.test' } })
    await waitFor(() => expect(emailError()).toBeNull())

    fireEvent.change(email, { target: { value: 'person@' } })
    await waitFor(() => expect(emailError()?.textContent).toBe('Enter a valid email address.'))
  })

  it('enables Continue as soon as every field is valid, without leaving a field', async () => {
    await renderSignup()
    expect(continueButton().disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.test' } })
    fireEvent.change(screen.getByLabelText('Confirm email'), { target: { value: 'person@example.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Synthetic-Pass1' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'Synthetic-Pass1' } })

    await waitFor(() => expect(continueButton().disabled).toBe(false))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('still suggests a common domain fix while typing', async () => {
    await renderSignup()
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@gmial.com' } })

    await waitFor(() => expect(screen.getByText('Did you mean gmail.com?')).toBeTruthy())
    expect(emailError()).toBeNull()
  })
})
