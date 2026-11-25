import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const confirm = vi.hoisted(() => vi.fn())
vi.mock('@/app/lib/login-email-change', () => ({ confirmLoginEmailChange: confirm }))

import ConfirmLoginEmailPage from '../page'

beforeEach(() => {
  confirm.mockReset()
  window.history.replaceState(null, '', '/confirm-login-email?src=mail#token=secret-token-value')
})

describe('confirm login email page', () => {
  it('clears the fragment before any request and confirms only on the button', async () => {
    const replace = vi.spyOn(window.history, 'replaceState')
    render(<ConfirmLoginEmailPage />)
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain('secret-token-value')
    expect(window.location.search).toBe('?src=mail')
    expect(replace).toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()

    confirm.mockResolvedValueOnce({ kind: 'done', newLogin: 'new@example.test', contactState: 'applied' })
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm change' }))
    expect(await screen.findByText('new@example.test')).toBeInTheDocument()
    expect(confirm).toHaveBeenCalledWith('secret-token-value')
    expect(screen.getByText('Billing emails now go to this address too.')).toBeInTheDocument()
    expect(screen.getByText(/They keep showing your old email\. Before you sign out on a device to use the new email there, open it and make sure everything has synced: signing out of the Android app removes its local copy of your calendars, contacts and tasks, and the desktop Bridge keeps unsynced changes only under the old account\./)).toBeInTheDocument()
  })

  it.each([
    [{ kind: 'done', newLogin: 'n@example.test', contactState: 'pending' }, /once your current payment has finished/],
    [{ kind: 'done', newLogin: 'n@example.test', contactState: 'conflict' }, /keep going to your previous contact address/],
    [{ kind: 'expired' }, /expired or was already used/],
    [{ kind: 'refused', reason: 'taken' }, /already used by another account/],
    [{ kind: 'refused', reason: 'stale' }, /changed again after this link was sent/],
  ])('shows the outcome %#', async (outcome, text) => {
    confirm.mockResolvedValueOnce(outcome)
    render(<ConfirmLoginEmailPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm change' }))
    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  it('keeps the button for try again and retries with the same token', async () => {
    confirm.mockResolvedValueOnce({ kind: 'try-again' }).mockResolvedValueOnce({ kind: 'done', newLogin: 'n@example.test', contactState: 'applied' })
    render(<ConfirmLoginEmailPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm change' }))
    expect(await screen.findByText(/could not finish the change yet/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }))
    expect(await screen.findByText('n@example.test')).toBeInTheDocument()
    expect(confirm.mock.calls).toEqual([['secret-token-value'], ['secret-token-value']])
  })

  it('says the link is incomplete without a token and sends nothing', async () => {
    window.history.replaceState(null, '', '/confirm-login-email')
    render(<ConfirmLoginEmailPage />)
    expect(await screen.findByText(/This link is incomplete/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm change' })).not.toBeInTheDocument()
    expect(confirm).not.toHaveBeenCalled()
  })
})
