import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearScheduledAlarms } from '../notification-alarms'

it('does not create the reminder database when none exists', async () => {
  await clearScheduledAlarms()
  const names = (await indexedDB.databases()).map(db => db.name)
  expect(names).not.toContain('silentsuite-alarms')
})

describe('page-side cache cleanup', () => {
  let names: Set<string>
  let remove: ReturnType<typeof vi.fn>
  beforeEach(() => {
    names = new Set(['cross-origin', 'cross-origin-other', 'workbox-precache', 'images'])
    remove = vi.fn(async (name: string) => names.delete(name))
    vi.stubGlobal('caches', { delete: remove })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('deletes only the exact legacy cache without a worker or IndexedDB, repeatedly', async () => {
    vi.stubGlobal('indexedDB', undefined)
    await clearScheduledAlarms()
    await clearScheduledAlarms()
    expect([...names]).toEqual(['cross-origin-other', 'workbox-precache', 'images'])
    expect(remove.mock.calls).toEqual([['cross-origin'], ['cross-origin']])
  })

  it('still deletes the cache if opening the reminder database throws', async () => {
    vi.stubGlobal('indexedDB', { open: () => { throw new Error('synthetic database failure') } })
    await expect(clearScheduledAlarms()).rejects.toThrow('synthetic database failure')
    expect(names.has('cross-origin')).toBe(false)
  })

  it('still clears reminders when deleting the cache rejects', async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('silentsuite-alarms', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('alarms', { keyPath: 'id' })
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve) => {
      const tx = db.transaction('alarms', 'readwrite')
      tx.objectStore('alarms').put({ id: 'synthetic-reminder' })
      tx.oncomplete = () => resolve()
    })
    remove.mockRejectedValue(new Error('synthetic cache failure'))
    await expect(clearScheduledAlarms()).rejects.toThrow('synthetic cache failure')
    const records = await new Promise<unknown[]>((resolve) => {
      const request = db.transaction('alarms').objectStore('alarms').getAll()
      request.onsuccess = () => resolve(request.result)
    })
    db.close()
    expect(records).toEqual([])
  })
})
