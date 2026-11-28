import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ canWrite: true }))

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: (selector: (state: { canWrite: () => boolean }) => unknown) => selector({ canWrite: () => auth.canWrite }),
}))
vi.mock('../EventDialog', () => ({ EventDialog: () => null }))

import { FloatingAddButton } from '../FloatingAddButton'

describe('FloatingAddButton', () => {
  it('shows the + button when the account can write', () => {
    auth.canWrite = true
    render(<FloatingAddButton />)

    expect(screen.getByRole('button', { name: 'New event' })).toBeEnabled()
  })

  it('hides the + button while the account is read-only', () => {
    auth.canWrite = false
    render(<FloatingAddButton />)

    expect(screen.queryByRole('button', { name: 'New event' })).not.toBeInTheDocument()
    auth.canWrite = true
  })
})
