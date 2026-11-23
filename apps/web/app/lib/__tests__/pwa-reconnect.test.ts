import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { configPath, loadNextConfig } from './load-next-config'

// #744: a refused draft lives only in memory, marked Not saved. Reconnecting must
// not reload the document, or that draft and its notice vanish without a trace.

/** The options the root Next config passes to next-pwa; only the config wrappers are stubbed. */
function loadPwaOptions(): Record<string, unknown> {
  return loadNextConfig().options
}

/** The installed next-pwa client entry, with only its external Workbox import removed. */
function loadSwEntry(): string {
  const pwaMain = createRequire(configPath).resolve('@ducanh2912/next-pwa')
  const source = readFileSync(path.join(path.dirname(pwaMain), 'sw-entry.js'), 'utf8')
  const body = source.replace(/^\s*import\s*\{\s*Workbox\s*\}\s*from\s*['"]workbox-window['"]\s*;?/, '')
  if (body === source) throw new Error('sw-entry.js no longer starts with the Workbox import')
  return body
}

describe('PWA reconnect (#744)', () => {
  it('delivers online to the app and registers the worker, without reloading the document', async () => {
    const options = loadPwaOptions()
    expect(options.disable).toBe(false)

    // next-pwa's DefinePlugin values for these options (no basePath); vendor defaults
    // when absent: register true, reloadOnOnline true, dynamicStartUrl true, the rest false.
    const defines = {
      __PWA_SW_ENTRY_WORKER__: undefined,
      __PWA_SW__: '/sw.js',
      __PWA_SCOPE__: '/',
      __PWA_ENABLE_REGISTER__: Boolean(options.register ?? true),
      __PWA_START_URL__: (options.dynamicStartUrl ?? true) ? '/' : undefined,
      __PWA_CACHE_ON_FRONT_END_NAV__: Boolean(options.cacheOnFrontEndNav ?? false),
      __PWA_AGGRFEN_CACHE__: Boolean(options.aggressiveFrontEndNavCaching ?? false),
      __PWA_RELOAD_ON_ONLINE__: Boolean(options.reloadOnOnline ?? true),
    }

    // Browser transport only: a window that delivers events, Workbox, fetch and caches.
    const reload = vi.fn()
    const location = { origin: 'https://app.example', pathname: '/', reload }
    const navigator = { onLine: true, serviceWorker: {} }
    const win = Object.assign(new EventTarget(), { location, navigator }) as EventTarget & Record<string, unknown>
    const register = vi.fn()
    const Workbox = vi.fn(function (this: { register: typeof register }) { this.register = register })
    const put = vi.fn()
    const caches = { open: vi.fn(async () => ({ put })) }
    const fetch = vi.fn(async () => ({ redirected: false }))
    const history = { pushState: vi.fn(), replaceState: vi.fn() }
    const appOnline = vi.fn()

    const scope = { ...defines, window: win, navigator, location, history, caches, fetch, Worker: vi.fn(), Workbox }
    new Function(...Object.keys(scope), loadSwEntry())(...Object.values(scope))
    win.addEventListener('online', appOnline)

    expect(Workbox).toHaveBeenCalledWith('https://app.example/sw.js', { scope: '/' })
    expect(register).toHaveBeenCalledTimes(1)

    win.dispatchEvent(new Event('online'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Ordinary online handling still runs: the app's listener and next-pwa's start-URL cache.
    expect(appOnline).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('/')
    expect(caches.open).toHaveBeenCalledWith('start-url')
    // The document stays, with its refused draft and Not saved notice.
    expect(reload).not.toHaveBeenCalled()
  })
})
