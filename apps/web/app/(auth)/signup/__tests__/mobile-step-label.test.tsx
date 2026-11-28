import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// SIGNUP-18: phones hide the stepper's per-step labels, so a "Step N of 4: <label>" line
// names the current step below the sm breakpoint, using the same labels as desktop.

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

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('sign-up mobile step label (SIGNUP-18)', () => {
  it('names the current step on phones only, with the desktop label', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    vi.stubEnv('NEXT_PUBLIC_ETEBASE_SERVER_URL', '')
    delete process.env.NEXT_PUBLIC_OWNER_REGISTRATION
    const { default: SignupPage } = await import('../page')
    render(<SignupPage />)

    const line = await screen.findByTestId('signup-mobile-step-label')
    expect(line.textContent).toBe('Step 1 of 4: Email')
    expect(line.className.split(' ')).toContain('sm:hidden')
  })
})
