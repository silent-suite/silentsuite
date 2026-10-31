import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { birthdayEventContent, birthdayMarkerContent } from '@silentsuite/core'

const transportMock = vi.hoisted(() => ({ createEtebaseBirthdayTransport: vi.fn() }))
const orchestrateMock = vi.hoisted(() => ({ runBirthdayCalendar: vi.fn(), resetBirthdayCalendarRuns: vi.fn() }))
const lifecycleMock = vi.hoisted(() => ({ enableBirthdayCalendar: vi.fn(), disableBirthdayCalendar: vi.fn() }))
vi.mock('../etebase-transport', () => transportMock)
vi.mock('../orchestrate', () => orchestrateMock)
vi.mock('../lifecycle', () => lifecycleMock)

import { bumpAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useSyncStore } from '@/app/stores/use-sync-store'
import { selectQualifyingBirthdayCalendarIds, useBirthdayMarkerStore } from '../markers'
import {
  enableBirthdayCalendarFromSession,
  managedBirthdayCalendarIds,
  resetBirthdayProjection,
  scheduleBirthdayReconcile,
} from '../session'

const GENERATED = birthdayEventContent({ uid: 'ss-bday1-c8970a5b3457981540f4ee428f84a1f4', name: 'Alex Example', month: 3, day: 15 })
const markedCollection = (uid: string) => ({ uid, isDeleted: false, getMeta: () => ({ name: 'Birthdays' }), getContent: async () => birthdayMarkerContent('active') })

function signIn(username: string, fingerprint: string, calendars: unknown[] = []) {
  const account = { user: { username } }
  const created = markedCollection('bday-1')
  const reconcileCollections = vi.fn(async () => {
    const state = useEtebaseStore.getState()
    useEtebaseStore.setState({ collections: { ...state.collections, calendar: [...state.collections.calendar, created] } } as never)
  })
  const refreshCollection = vi.fn(async () => [])
  const fetchAllItems = vi.fn(async () => [{ uid: 'gen-1', content: GENERATED, collectionUid: 'bday-1', revision: 'r1' }])
  useEtebaseStore.setState({
    account,
    accountFingerprint: fingerprint,
    collections: { ...useEtebaseStore.getInitialState().collections, calendar: calendars },
    reconcileCollections,
    refreshCollection,
    fetchAllItems,
  } as never)
  return { account, reconcileCollections, refreshCollection, fetchAllItems }
}

const fakeTransport = () => ({
  listInventory: vi.fn(),
  listItems: vi.fn(),
  applyChanges: vi.fn(async () => 'saved'),
  createBirthdayCalendar: vi.fn(async () => ({ kind: 'created', collectionUid: 'bday-1', rootRevision: 'root-1', root: {} })),
})

describe('Birthdays session refresh and account scoping (#738)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useCalendarStore.setState({ events: [] })
    useBirthdayMarkerStore.setState({ snapshot: null })
    useAuthStore.setState({ canWrite: () => true } as never)
    useSyncStore.setState({ isOnline: true } as never)
    transportMock.createEtebaseBirthdayTransport.mockReset().mockImplementation(() => fakeTransport())
    orchestrateMock.runBirthdayCalendar.mockReset()
    lifecycleMock.enableBirthdayCalendar.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('after enabling, publishes the new calendar as managed and its generated events through the store refresh', async () => {
    const live = signIn('alice', 'fp-a')
    lifecycleMock.enableBirthdayCalendar.mockImplementation(async ({ transport }) => {
      await transport.createBirthdayCalendar({ name: 'Birthdays', content: birthdayMarkerContent('active') })
      return { status: 'done', sourceTokens: null }
    })

    await expect(enableBirthdayCalendarFromSession()).resolves.toEqual({ status: 'done' })

    expect(live.reconcileCollections).toHaveBeenCalledTimes(1)
    expect(live.refreshCollection).toHaveBeenCalledWith('calendar')
    expect(managedBirthdayCalendarIds()).toEqual(['bday-1'])
    expect(useCalendarStore.getState().events.map((event) => [event.id, event.calendarId])).toEqual([['gen-1', 'bday-1']])
  })

  it('one malformed calendar item does not stop the refresh from publishing the others', async () => {
    const live = signIn('alice', 'fp-a', [markedCollection('bday-1')])
    live.fetchAllItems.mockResolvedValue([
      { uid: 'broken', content: 'not a calendar', collectionUid: 'cal-1', revision: 'r0' },
      { uid: 'gen-1', content: GENERATED, collectionUid: 'bday-1', revision: 'r1' },
    ])
    orchestrateMock.runBirthdayCalendar.mockImplementation(async ({ transport }) => {
      await transport.applyChanges({ changes: [] })
      return { status: 'done', sourceTokens: null }
    })

    scheduleBirthdayReconcile()
    await vi.advanceTimersByTimeAsync(5000)

    expect(useCalendarStore.getState().events.map((event) => event.id)).toEqual(['gen-1'])
  })

  it('after a run, publishes qualifying consent from the fresh adapter inventory, not from Admin access alone', async () => {
    signIn('alice', 'fp-a', [markedCollection('bday-1'), markedCollection('bday-shared')])
    const active = birthdayMarkerContent('active')
    transportMock.createEtebaseBirthdayTransport.mockImplementation(() => ({
      ...fakeTransport(),
      listInventory: vi.fn(async () => ({ complete: true, inventoryToken: 't', collections: [
        { uid: 'bday-1', kind: 'calendar', accessLevel: 'admin', content: active, members: ['alice'], membersComplete: true, rootRevision: 'r', root: {} },
        { uid: 'bday-shared', kind: 'calendar', accessLevel: 'admin', content: active, members: ['alice', 'bob'], membersComplete: true, rootRevision: 'r', root: {} },
      ] })),
    }))
    orchestrateMock.runBirthdayCalendar.mockResolvedValue({ status: 'done', sourceTokens: null })

    scheduleBirthdayReconcile()
    await vi.advanceTimersByTimeAsync(5000)

    const snapshot = useBirthdayMarkerStore.getState().snapshot
    expect(selectQualifyingBirthdayCalendarIds(snapshot, getAccountEpoch(), 'fp-a')).toEqual(['bday-1'])
    expect(managedBirthdayCalendarIds()).toEqual(['bday-1', 'bday-shared'])
  })

  it('a passive run that wrote nothing refreshes nothing (no hydrate→schedule→run loop)', async () => {
    const live = signIn('alice', 'fp-a', [markedCollection('bday-1')])
    orchestrateMock.runBirthdayCalendar.mockResolvedValue({ status: 'done', sourceTokens: null })

    scheduleBirthdayReconcile()
    await vi.advanceTimersByTimeAsync(5000)

    expect(orchestrateMock.runBirthdayCalendar).toHaveBeenCalledTimes(1)
    expect(live.reconcileCollections).not.toHaveBeenCalled()
    expect(live.refreshCollection).not.toHaveBeenCalled()
    expect(managedBirthdayCalendarIds()).toEqual(['bday-1'])
  })

  it('a passive run that wrote refreshes the calendar collections and events once', async () => {
    const live = signIn('alice', 'fp-a', [markedCollection('bday-1')])
    orchestrateMock.runBirthdayCalendar.mockImplementation(async ({ transport }) => {
      await transport.applyChanges({ changes: [] })
      return { status: 'done', sourceTokens: null }
    })

    scheduleBirthdayReconcile()
    await vi.advanceTimersByTimeAsync(5000)

    expect(live.reconcileCollections).toHaveBeenCalledTimes(1)
    expect(useCalendarStore.getState().events.map((event) => event.id)).toEqual(['gen-1'])
  })

  it('publishes nothing when the account changed during the run', async () => {
    const live = signIn('alice', 'fp-a', [markedCollection('bday-1')])
    orchestrateMock.runBirthdayCalendar.mockImplementation(async ({ transport }) => {
      await transport.applyChanges({ changes: [] })
      bumpAccountEpoch()
      useEtebaseStore.setState({ account: { user: { username: 'bob' } }, accountFingerprint: 'fp-b' } as never)
      return { status: 'done', sourceTokens: null }
    })

    scheduleBirthdayReconcile()
    await vi.advanceTimersByTimeAsync(5000)

    expect(live.reconcileCollections).not.toHaveBeenCalled()
    expect(useBirthdayMarkerStore.getState().snapshot).toBeNull()
    expect(useCalendarStore.getState().events).toEqual([])
  })

  it('resetting the leaving account cancels its pending run but keeps the next account’s run and projection', async () => {
    signIn('alice', 'fp-a')
    const leaving = getAccountEpoch()
    orchestrateMock.runBirthdayCalendar.mockResolvedValue({ status: 'done', sourceTokens: null })
    scheduleBirthdayReconcile()
    resetBirthdayProjection(leaving)
    await vi.advanceTimersByTimeAsync(5000)
    expect(orchestrateMock.runBirthdayCalendar).not.toHaveBeenCalled()

    signIn('alice', 'fp-a')
    const old = getAccountEpoch()
    scheduleBirthdayReconcile()
    bumpAccountEpoch()
    signIn('bob', 'fp-b', [markedCollection('bday-b')])
    scheduleBirthdayReconcile()
    resetBirthdayProjection(old)
    await vi.advanceTimersByTimeAsync(5000)

    expect(orchestrateMock.runBirthdayCalendar).toHaveBeenCalledTimes(1)
    expect(orchestrateMock.runBirthdayCalendar.mock.calls[0]![0].accountKey).toBe('fp-b')
    expect(managedBirthdayCalendarIds()).toEqual(['bday-b'])
    resetBirthdayProjection(old)
    expect(managedBirthdayCalendarIds()).toEqual(['bday-b'])
  })
})
