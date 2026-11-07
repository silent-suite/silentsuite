import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const intl = vi.hoisted(() => ({ locale: 'en' }))

vi.mock('next/font/google', () => ({ Inter: () => ({ variable: 'font-inter' }) }))
vi.mock('next-themes', () => ({ ThemeProvider: ({ children }: { children: unknown }) => children }))
vi.mock('@/app/providers/auth-provider', () => ({ AuthProvider: ({ children }: { children: unknown }) => children }))
vi.mock('@/app/globals.css', () => ({}))
vi.mock('next-intl/server', () => ({
  getLocale: async () => intl.locale,
  getMessages: async () => ({}),
}))

async function renderRootHtml() {
  const { default: RootLayout } = await import('../../app/layout')
  return (await RootLayout({ children: null })) as ReactElement<{ lang: string }>
}

beforeEach(() => {
  intl.locale = 'en'
})

describe('root layout document language', () => {
  it('declares English by default', async () => {
    expect((await renderRootHtml()).props.lang).toBe('en')
  })

  it('declares Italian when the request locale is Italian', async () => {
    intl.locale = 'it'
    expect((await renderRootHtml()).props.lang).toBe('it')
  })
})
