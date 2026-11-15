// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'

// Next loads this page in the Node server, and at start it preloads every page. Etebase's
// React Native shim sets global.document = {} there when it loads, so a module that trusts
// `typeof document` at load time throws, and a throw during that preload can stop the server.
describe('notes page in the Node server', () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document
  })

  it('loads while the Etebase placeholder document is set', async () => {
    ;(globalThis as { document?: unknown }).document = {}
    await expect(import('../page')).resolves.toHaveProperty('default')
  })
})
