// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { birthdayMarkerContent } from '@silentsuite/core'
import {
  NO_BIRTHDAY_CALENDARS,
  projectBirthdayMarkers,
  resetBirthdayMarkers,
  selectManagedBirthdayCalendarIds,
  publishBirthdayQualifying,
  selectQualifyingBirthdayCalendarIds,
  useBirthdayMarkerStore,
  type MarkedCollection,
  type QualifyingInventory,
} from '../markers'

const marked = (uid: string, content: string | Error): MarkedCollection => ({
  uid,
  getContent: async () => {
    if (content instanceof Error) throw content
    return content
  },
})
const scope = (epoch: number, fingerprint: string, current = () => true) => ({ epoch, fingerprint, isCurrent: current })

describe('Birthdays marker projection (#738)', () => {
  beforeEach(() => useBirthdayMarkerStore.setState({ snapshot: null }))

  it('projects only calendars whose content marker is active, never by name', async () => {
    await projectBirthdayMarkers(scope(1, 'fp-a'), [
      marked('cal-z', birthdayMarkerContent('active')),
      marked('cal-retired', birthdayMarkerContent('retired')),
      marked('Birthdays', ''),
      { uid: 'cal-no-content' },
      marked('cal-a', birthdayMarkerContent('active')),
    ])
    expect(useBirthdayMarkerStore.getState().snapshot).toMatchObject({ epoch: 1, fingerprint: 'fp-a', activeIds: ['cal-a', 'cal-z'] })
    expect(selectManagedBirthdayCalendarIds(useBirthdayMarkerStore.getState().snapshot, 1, 'fp-a')).toEqual(['cal-a', 'cal-z'])
  })

  describe('qualifying consent (verified single-member Admin), separate from managed read-only identity', () => {
    const ACTIVE = birthdayMarkerContent('active')
    const listed = (uid: string, overrides: Partial<QualifyingInventory['collections'][number]> = {}) => ({
      uid, kind: 'calendar' as const, accessLevel: 'admin' as const, content: ACTIVE, members: ['alice'], membersComplete: true, ...overrides,
    })
    const qualifying = () => selectQualifyingBirthdayCalendarIds(useBirthdayMarkerStore.getState().snapshot, 1, 'fp-a')

    it('counts only an active Admin calendar whose complete member list is exactly this user', async () => {
      await projectBirthdayMarkers(scope(1, 'fp-a'), [marked('cal-own', ACTIVE), marked('cal-shared-admin', ACTIVE), marked('cal-partial', ACTIVE), marked('cal-ro', ACTIVE)])
      publishBirthdayQualifying(scope(1, 'fp-a'), 'alice', { complete: true, collections: [
        listed('cal-own'),
        listed('cal-shared-admin', { members: ['alice', 'bob'] }),
        listed('cal-partial', { members: ['alice'], membersComplete: false }),
        listed('cal-ro', { accessLevel: 'readOnly' }),
        listed('cal-retired', { content: birthdayMarkerContent('retired') }),
        listed('book-1', { kind: 'address-book' }),
      ] })
      expect(qualifying()).toEqual(['cal-own'])
      expect(selectManagedBirthdayCalendarIds(useBirthdayMarkerStore.getState().snapshot, 1, 'fp-a'))
        .toEqual(['cal-own', 'cal-partial', 'cal-ro', 'cal-shared-admin'])
    })

    it('a shared Admin calendar with an incomplete member list is not consent', async () => {
      publishBirthdayQualifying(scope(1, 'fp-a'), 'alice', { complete: true, collections: [
        listed('cal-shared-admin', { members: ['alice'], membersComplete: false }),
      ] })
      expect(qualifying()).toEqual([])
    })

    it('keeps the previous consent when the inventory or one calendar could not be read', async () => {
      publishBirthdayQualifying(scope(1, 'fp-a'), 'alice', { complete: true, collections: [listed('cal-own')] })
      publishBirthdayQualifying(scope(1, 'fp-a'), 'alice', null)
      publishBirthdayQualifying(scope(1, 'fp-a'), 'alice', { complete: false, collections: [] })
      expect(qualifying()).toEqual(['cal-own'])
      publishBirthdayQualifying(scope(1, 'fp-a'), 'alice', { complete: true, collections: [listed('cal-own', { content: null }), listed('cal-new', { content: null })] })
      expect(qualifying()).toEqual(['cal-own'])
      publishBirthdayQualifying(scope(1, 'fp-a'), 'alice', { complete: true, collections: [listed('cal-own', { membersComplete: false, members: [] })] })
      expect(qualifying()).toEqual(['cal-own'])
    })

    it('is scoped to the account and survives a marker re-projection', async () => {
      publishBirthdayQualifying(scope(1, 'fp-a', () => false), 'alice', { complete: true, collections: [listed('cal-own')] })
      expect(qualifying()).toEqual([])
      publishBirthdayQualifying(scope(1, 'fp-a'), 'alice', { complete: true, collections: [listed('cal-own')] })
      await projectBirthdayMarkers(scope(1, 'fp-a'), [marked('cal-own', ACTIVE), marked('cal-other', ACTIVE)])
      expect(qualifying()).toEqual(['cal-own'])
      expect(selectQualifyingBirthdayCalendarIds(useBirthdayMarkerStore.getState().snapshot, 1, 'fp-b')).toEqual([])
    })
  })

  it('keeps the same snapshot object when nothing changed', async () => {
    const calendars = [marked('cal-a', birthdayMarkerContent('active'))]
    await projectBirthdayMarkers(scope(1, 'fp-a'), calendars)
    const first = useBirthdayMarkerStore.getState().snapshot
    await projectBirthdayMarkers(scope(1, 'fp-a'), calendars)
    expect(useBirthdayMarkerStore.getState().snapshot).toBe(first)
  })

  it('keeps an unreadable calendar protected only if this account already knew it was active', async () => {
    await projectBirthdayMarkers(scope(1, 'fp-a'), [marked('cal-a', birthdayMarkerContent('active'))])
    await projectBirthdayMarkers(scope(1, 'fp-a'), [marked('cal-a', new Error('locked')), marked('cal-new', new Error('locked'))])
    expect(useBirthdayMarkerStore.getState().snapshot?.activeIds).toEqual(['cal-a'])

    await projectBirthdayMarkers(scope(2, 'fp-b'), [marked('cal-a', new Error('locked'))])
    expect(useBirthdayMarkerStore.getState().snapshot).toMatchObject({ epoch: 2, fingerprint: 'fp-b', activeIds: [] })
  })

  it('publishes nothing when the account changed before the read finished', async () => {
    await projectBirthdayMarkers(scope(1, 'fp-a', () => false), [marked('cal-a', birthdayMarkerContent('active'))])
    expect(useBirthdayMarkerStore.getState().snapshot).toBeNull()
  })

  it('shows another account nothing and resets only the leaving account', async () => {
    await projectBirthdayMarkers(scope(2, 'fp-b'), [marked('cal-b', birthdayMarkerContent('active'))])
    const snapshot = useBirthdayMarkerStore.getState().snapshot
    expect(selectManagedBirthdayCalendarIds(snapshot, 1, 'fp-a')).toBe(NO_BIRTHDAY_CALENDARS)
    expect(selectManagedBirthdayCalendarIds(snapshot, 2, 'fp-a')).toBe(NO_BIRTHDAY_CALENDARS)
    resetBirthdayMarkers(1)
    expect(useBirthdayMarkerStore.getState().snapshot).toBe(snapshot)
    resetBirthdayMarkers(2)
    expect(useBirthdayMarkerStore.getState().snapshot).toBeNull()
  })
})
