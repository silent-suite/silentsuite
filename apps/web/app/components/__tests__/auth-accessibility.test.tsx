import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import AuthLayout from '../../(auth)/layout'
import { Button } from '../../../../../packages/ui/src/components/button'

const themeState = vi.hoisted(() => ({
  resolvedTheme: 'light' as 'light' | 'dark',
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/login',
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({
    theme: themeState.resolvedTheme,
    resolvedTheme: themeState.resolvedTheme,
    setTheme: vi.fn(),
  }),
}))

afterEach(cleanup)

function AuthFixture() {
  return (
    <AuthLayout>
      <form aria-label='auth form'>
        <Button type='submit'>Submit</Button>
        <Button type='button' variant='destructive'>Delete</Button>
        <Button type='button' variant='outline'>Cancel</Button>
        <Button type='button' variant='secondary'>Back</Button>
        <Button type='button' variant='ghost'>Ghost</Button>
        <Button type='button' variant='link'>Link</Button>
      </form>
    </AuthLayout>
  )
}

it.each(['light', 'dark'] as const)(
  'renders one main around the auth form in %s mode',
  async (theme) => {
    themeState.resolvedTheme = theme
    const { container } = render(<AuthFixture />)
    const main = screen.getByRole('main')
    expect(container.querySelectorAll('main')).toHaveLength(1)
    expect(main).toContainElement(screen.getByRole('form', { name: 'auth form' }))
    await waitFor(() =>
      expect(main).toHaveClass(theme === 'dark' ? 'from-navy-950' : 'from-gray-50')
    )
  }
)

it('uses accessible default button colors and leaves other variants unchanged', () => {
  themeState.resolvedTheme = 'light'
  render(<AuthFixture />)
  const submit = screen.getByRole('button', { name: 'Submit' })
  expect(submit).toHaveClass('bg-teal-700', 'hover:bg-teal-800')
  expect(submit.className).not.toMatch(/bg-teal-500|hover:bg-teal-600/)
  expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('bg-red-500', 'hover:bg-red-600')
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('border', 'border-navy-300')
  expect(screen.getByRole('button', { name: 'Back' })).toHaveClass('bg-navy-200', 'hover:bg-navy-300')
  expect(screen.getByRole('button', { name: 'Ghost' })).toHaveClass('hover:bg-navy-100')
  expect(screen.getByRole('button', { name: 'Link' })).toHaveClass('text-teal-500')
})