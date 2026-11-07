import { beforeEach, describe, expect, it, vi } from 'vitest'
import en from '../../messages/en.json'
import it_ from '../../messages/it.json'

const cookieState = vi.hoisted(() => ({ value: undefined as string | undefined, names: [] as string[] }))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      cookieState.names.push(name)
      return cookieState.value === undefined ? undefined : { name, value: cookieState.value }
    },
  }),
}))

vi.mock('next-intl/server', () => ({
  getRequestConfig: <T>(create: T) => create,
}))

type RequestConfigFn = (params: { requestLocale: Promise<string | undefined> }) => Promise<{
  locale: string
  messages: Record<string, Record<string, unknown>>
}>

async function resolveConfig() {
  const mod = await import('../request')
  return (mod.default as unknown as RequestConfigFn)({ requestLocale: Promise.resolve(undefined) })
}

beforeEach(() => {
  cookieState.value = undefined
  cookieState.names = []
})

describe('i18n request config locale cookie', () => {
  it('defaults to English when no language cookie is present', async () => {
    const config = await resolveConfig()
    expect(config.locale).toBe('en')
    expect(config.messages.Navigation.calendar).toBe(en.Navigation.calendar)
    expect(cookieState.names).toEqual(['silentsuite-locale'])
  })

  it('uses Italian messages when the cookie selects it', async () => {
    cookieState.value = 'it'
    const config = await resolveConfig()
    expect(config.locale).toBe('it')
    expect(config.messages.Navigation.calendar).toBe(it_.Navigation.calendar)
    expect(config.messages.Notes.deleteNotebookMessage).toBe(it_.Notes.deleteNotebookMessage)
  })

  it.each([
    ['unknown locale', 'fr'],
    ['wrong case', 'IT'],
    ['region variant', 'it-IT'],
    ['path traversal', '../en'],
    ['padded value', ' it '],
    ['empty value', ''],
    ['encoded garbage', '%E0%A4%A'],
  ])('falls back to English for a %s cookie', async (_label, value) => {
    cookieState.value = value
    const config = await resolveConfig()
    expect(config.locale).toBe('en')
    expect(config.messages.Navigation.calendar).toBe(en.Navigation.calendar)
  })
})
