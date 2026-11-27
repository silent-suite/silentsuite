import { describe, expect, it, vi } from 'vitest'

const redirect = vi.fn()
vi.mock('next/navigation', () => ({ redirect: (path: string) => redirect(path) }))

import SignupCancelPage from '../cancel/page'

describe('/signup/cancel', () => {
  it('sends old checkout-cancel links back to sign-up', () => {
    SignupCancelPage()
    expect(redirect).toHaveBeenCalledWith('/signup')
  })
})
