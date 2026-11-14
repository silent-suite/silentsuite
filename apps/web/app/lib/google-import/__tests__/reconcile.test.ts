import { beforeEach, describe, expect, it, vi } from 'vitest'

const etebase = vi.hoisted(() => ({
  state: {
    account: {} as unknown,
    collections: { calendar: [{ uid: 'c1' }], contacts: [] as unknown[] },
    domainLoadState: { calendar: 'loaded', contacts: 'loaded' } as Record<string, string>,
    refreshCollection: vi.fn(),
  },
}))
vi.mock('@/app/stores/use-etebase-store', () => ({ useEtebaseStore: { getState: () => etebase.state } }))

import { serverImportSourceKeys } from '../reconcile'

// A long key folds across lines in stored iCalendar text.
const longKey = `google/me%40example.com/${'team'.repeat(20)}%40group.calendar.google.com/standup%40google.com`
const folded = (line: string) => line.match(/.{1,74}/g)!.join('\r\n ')

describe('serverImportSourceKeys', () => {
  beforeEach(() => {
    etebase.state.account = {}
    etebase.state.domainLoadState = { calendar: 'loaded', contacts: 'loaded' }
    etebase.state.refreshCollection.mockReset()
  })

  it('reads source keys from every server item, folded lines included', async () => {
    etebase.state.refreshCollection.mockResolvedValue([
      { content: `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\n${folded(`X-SILENTSUITE-IMPORT-SOURCE:${longKey}`)}\r\nEND:VEVENT\r\nEND:VCALENDAR` },
      { content: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:b\r\nEND:VEVENT\r\nEND:VCALENDAR' },
    ])
    expect(await serverImportSourceKeys('calendar')).toEqual(new Set([longKey]))
    expect(etebase.state.refreshCollection).toHaveBeenCalledWith('calendar')
  })

  it('returns null when the server could not be read in full', async () => {
    etebase.state.refreshCollection.mockImplementation(async () => { etebase.state.domainLoadState.calendar = 'failed'; return [] })
    expect(await serverImportSourceKeys('calendar')).toBeNull()
    etebase.state.refreshCollection.mockRejectedValue(new Error('boundary'))
    expect(await serverImportSourceKeys('calendar')).toBeNull()
    etebase.state.account = null
    expect(await serverImportSourceKeys('calendar')).toBeNull()
  })

  it('has nothing to read without collections of that type', async () => {
    expect(await serverImportSourceKeys('contacts')).toEqual(new Set())
    expect(etebase.state.refreshCollection).not.toHaveBeenCalled()
  })
})
