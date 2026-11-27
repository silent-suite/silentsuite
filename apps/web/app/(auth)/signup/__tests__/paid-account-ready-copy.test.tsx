import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { StepCreatePaidAccount } from '../components/step-create-paid-account'

it.each(['payment-confirmed', 'payment-return'] as const)('asks for a new password while the %s account is not created yet', (continuation) => {
  render(<StepCreatePaidAccount email="a@example.test" continuation={continuation} onNext={vi.fn()} />)
  expect(screen.getByRole('heading', { name: 'Create your account' })).toBeVisible()
  expect(screen.getByLabelText(/^password$/i)).toHaveAttribute('autocomplete', 'new-password')
  expect(screen.getByLabelText('Confirm password')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Create account and continue' })).toBeInTheDocument()
})

it.each(['payment-confirmed', 'payment-return'] as const)('asks for the existing password once the %s account is ready', (continuation) => {
  render(<StepCreatePaidAccount email="a@example.test" continuation={continuation} accountReady onNext={vi.fn()} />)
  expect(screen.getByRole('heading', { name: 'Enter your password' })).toBeVisible()
  expect(screen.getByText(/Enter the password you chose for/)).toBeVisible()
  expect(screen.getByLabelText(/^password$/i)).toHaveAttribute('autocomplete', 'current-password')
  expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Sign in and continue' })).toBeInTheDocument()
})
