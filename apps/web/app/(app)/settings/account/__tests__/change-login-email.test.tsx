import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ enabled: true, user: null as any, request: vi.fn() }))
vi.mock('@/app/hooks/use-login-email-change-enabled', () => ({ useLoginEmailChangeEnabled: () => mocks.enabled }))
vi.mock('@/app/stores/use-auth-store', () => ({ useAuthStore: (selector: (s: any) => unknown) => selector({ user: mocks.user }) }))
vi.mock('@/app/lib/login-email-change', async () => {
  const actual = await vi.importActual<any>('@/app/lib/login-email-change')
  return { isHostedAccount: actual.isHostedAccount, requestLoginEmailChange: mocks.request }
})
vi.mock('@/app/lib/self-hosted', () => ({ isSelfHosted: false, isCustomServer: (url?: string) => !!url }))
vi.mock('@/app/stores/use-etebase-store', () => ({ useEtebaseStore: { getState: () => ({ account: null }) } }))

import { ChangeLoginEmail } from '../change-login-email'

beforeEach(() => {
  localStorage.clear()
  mocks.enabled = true
  mocks.user = { id: 'billing-1', email: 'contact@example.test', planId: 'annual' }
  mocks.request.mockReset()
})

describe('Change email button', () => {
  it('appears only with the experiment on for a hosted account', () => {
    const { rerender } = render(<ChangeLoginEmail />)
    expect(screen.getByRole('button', { name: 'Change email' })).toBeInTheDocument()
    mocks.enabled = false
    rerender(<ChangeLoginEmail />)
    expect(screen.queryByRole('button', { name: 'Change email' })).not.toBeInTheDocument()
    mocks.enabled = true
    localStorage.setItem('silentsuite-server-url', 'https://own.example.test')
    rerender(<ChangeLoginEmail />)
    expect(screen.queryByRole('button', { name: 'Change email' })).not.toBeInTheDocument()
    localStorage.clear()
    mocks.user = { id: 'self-hosted', email: '', planId: 'self-hosted' }
    rerender(<ChangeLoginEmail />)
    expect(screen.queryByRole('button', { name: 'Change email' })).not.toBeInTheDocument()
  })

  it.each([
    ['sent', /Check your new inbox/],
    ['unavailable', /This account needs support to change its email/],
    ['wrong-password', /Current password is incorrect/],
    ['rejected', /could not deliver email to that address/],
  ])('sends the new email and password and shows %s', async (result, text) => {
    mocks.request.mockResolvedValueOnce(result)
    render(<ChangeLoginEmail />)
    fireEvent.click(screen.getByRole('button', { name: 'Change email' }))
    expect(screen.getByText(/Phones and the desktop Bridge that are signed in keep syncing\. They keep showing your old email\. Before you sign out on a device to use the new email there, open it and make sure everything has synced: signing out of the Android app removes its local copy of your calendars, contacts and tasks, and the desktop Bridge keeps unsynced changes only under the old account\./)).toBeInTheDocument()
    expect(screen.getByText(/Card receipts/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'new@example.test' } })
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send confirmation link' }))
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(mocks.request).toHaveBeenCalledWith('new@example.test', 'pw')
  })
})
