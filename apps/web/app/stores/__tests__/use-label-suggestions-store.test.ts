import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLabelSuggestionsStore } from '../use-label-suggestions-store'

vi.mock('@/app/lib/logger', () => ({
  logger: { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const etebaseState = vi.hoisted(() => ({
  account: null as any,
  syncEngine: { trackCollection: vi.fn() },
}))

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: {
    getState: () => etebaseState,
  },
}))

vi.mock('@/app/stores/use-calendar-store', () => ({
  useCalendarStore: { getState: () => ({ events: [{ categories: ['Work'] }] }) },
}))
vi.mock('@/app/stores/use-task-store', () => ({
  useTaskStore: { getState: () => ({ tasks: [{ categories: ['Urgent'] }] }) },
}))
vi.mock('@/app/stores/use-contact-store', () => ({
  useContactStore: { getState: () => ({ contacts: [{ categories: ['VIP'] }] }) },
}))

describe('useLabelSuggestionsStore', () => {
  beforeEach(() => {
    etebaseState.account = null
    etebaseState.syncEngine.trackCollection.mockClear()
    useLabelSuggestionsStore.getState().reset()
  })

  it('seeds in-memory suggestions from decrypted visible items without an account write', () => {
    useLabelSuggestionsStore.getState().seedFromVisibleItems()

    expect(useLabelSuggestionsStore.getState().suggestions('', [], 5)).toEqual(['Urgent', 'VIP', 'Work'])
    expect(etebaseState.syncEngine.trackCollection).not.toHaveBeenCalled()
  })

  it('initializes as loaded without creating a remote label-index collection when no account exists', async () => {
    await useLabelSuggestionsStore.getState().initialize()

    expect(useLabelSuggestionsStore.getState().isLoaded).toBe(true)
    expect(useLabelSuggestionsStore.getState().remoteCollection).toBeNull()
  })

  it('records usage locally even when remote persistence is unavailable', async () => {
    await useLabelSuggestionsStore.getState().recordUsage('calendar', ['Project'])

    expect(useLabelSuggestionsStore.getState().suggestions('', [], 5)).toEqual(['Project'])
    expect(useLabelSuggestionsStore.getState().lastError).toBeNull()
  })
})
