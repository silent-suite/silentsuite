import { describe, it, expect, vi, afterEach } from 'vitest'

// jsdom's location.reload cannot be spied on, so React's useEffect is observed and the
// page's own effect runs against a browser host whose location records the reload.
const effects = vi.hoisted(() => [] as Array<{ effect: () => void | (() => void); deps?: unknown[] }>)
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => { effects.push({ effect, deps }) },
}))

import OfflinePage from '../../offline/page'

afterEach(() => {
  vi.unstubAllGlobals()
  effects.length = 0
})

describe('offline fallback recovery (#744)', () => {
  it('reloads on reconnect only while the fallback page is mounted', () => {
    const reload = vi.fn()
    const host = Object.assign(new EventTarget(), { location: { reload } })
    vi.stubGlobal('window', host)

    OfflinePage()
    expect(effects).toHaveLength(1)
    expect(effects[0]!.deps).toEqual([])
    const cleanup = effects[0]!.effect()

    host.dispatchEvent(new Event('offline'))
    expect(reload).not.toHaveBeenCalled()
    host.dispatchEvent(new Event('online'))
    expect(reload).toHaveBeenCalledTimes(1)

    expect(cleanup).toBeTypeOf('function')
    ;(cleanup as () => void)()
    host.dispatchEvent(new Event('online'))
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
