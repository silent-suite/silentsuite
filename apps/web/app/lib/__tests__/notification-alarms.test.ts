import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { clearScheduledAlarms } from '../notification-alarms'

it('does not create the reminder database when none exists', async () => {
  await clearScheduledAlarms()
  const names = (await indexedDB.databases()).map(db => db.name)
  expect(names).not.toContain('silentsuite-alarms')
})
