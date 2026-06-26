import { beforeEach, describe, expect, it } from 'vitest'
import { createSyncedPreferences, serializePreferences } from '@silentsuite/core'
import { usePreferencesStore } from '../use-preferences-store'

function resetPreferencesStore() {
  usePreferencesStore.getState().resetSyncedPreferences()
  usePreferencesStore.setState({ notificationSound: true })
}

describe('usePreferencesStore synced preferences', () => {
  beforeEach(() => {
    localStorage.clear()
    resetPreferencesStore()
  })

  it('defaults the visible calendar day to 07:00-23:00', () => {
    expect(usePreferencesStore.getState()).toMatchObject({
      dayStartHour: 7,
      dayEndHour: 23,
    })
  })

  it('migrates unchanged old full-day local defaults to 07:00-23:00', async () => {
    localStorage.setItem('silentsuite-preferences', JSON.stringify({
      state: {
        timeFormat: '12h',
        firstDayOfWeek: 'monday',
        defaultReminder: '15',
        defaultTimezone: 'UTC',
        dateFormat: 'system',
        dayStartHour: 0,
        dayEndHour: 24,
        syncedPreferenceUpdatedAt: {
          timeFormat: 0,
          firstDayOfWeek: 0,
          defaultReminder: 0,
          defaultTimezone: 0,
          dateFormat: 0,
          dayStartHour: 0,
          dayEndHour: 0,
        },
      },
      version: 1,
    }))

    await usePreferencesStore.persist.rehydrate()

    expect(usePreferencesStore.getState()).toMatchObject({
      dayStartHour: 7,
      dayEndHour: 23,
    })
  })

  it('does not include notificationSound in remote preferences', () => {
    usePreferencesStore.setState({ notificationSound: false })
    usePreferencesStore.getState().setTimeFormat('24h')

    const serialized = serializePreferences(usePreferencesStore.getState().toSyncedPreferences())

    expect(serialized).toContain('timeFormat')
    expect(serialized).not.toContain('notificationSound')
  })

  it('applies remote synced fields without changing notificationSound', () => {
    usePreferencesStore.setState({ notificationSound: false })
    const remote = createSyncedPreferences(
      {
        timeFormat: '24h',
        firstDayOfWeek: 'sunday',
        defaultReminder: '60',
        defaultTimezone: 'Europe/Amsterdam',
      },
      {
        timeFormat: 10,
        firstDayOfWeek: 10,
        defaultReminder: 10,
        defaultTimezone: 10,
      },
      10,
    )

    expect(usePreferencesStore.getState().applySyncedPreferences(remote)).toBe(true)
    expect(usePreferencesStore.getState()).toMatchObject({
      timeFormat: '24h',
      firstDayOfWeek: 'sunday',
      defaultReminder: '60',
      defaultTimezone: 'Europe/Amsterdam',
      notificationSound: false,
    })
  })

  it('merges remote fields by per-field timestamp', () => {
    usePreferencesStore.setState({
      timeFormat: '24h',
      firstDayOfWeek: 'monday',
      defaultReminder: '15',
      defaultTimezone: 'UTC',
      syncedPreferenceUpdatedAt: {
        timeFormat: 100,
        firstDayOfWeek: 1,
        defaultReminder: 1,
        defaultTimezone: 1,
      },
    })
    const remote = createSyncedPreferences(
      {
        timeFormat: '12h',
        firstDayOfWeek: 'sunday',
        defaultReminder: '30',
        defaultTimezone: 'Europe/Amsterdam',
      },
      {
        timeFormat: 50,
        firstDayOfWeek: 50,
        defaultReminder: 50,
        defaultTimezone: 50,
      },
      50,
    )

    usePreferencesStore.getState().applySyncedPreferences(remote)

    expect(usePreferencesStore.getState()).toMatchObject({
      timeFormat: '24h',
      firstDayOfWeek: 'sunday',
      defaultReminder: '30',
      defaultTimezone: 'Europe/Amsterdam',
    })
  })
})
