// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest'
import NotesPage from '../page'

// Next loads this page in the Node server, and at start it preloads every page. Etebase's
// React Native shim sets global.document = {} there when it loads, so a module that trusts
// `typeof document` at load time throws, and a throw during that preload can stop the server.
// vi.hoisted runs before the imports above, so the page loads with that placeholder already
// set. The import stays at file load, where no test timeout applies on a slow runner; if the
// page throws, this file fails to load.
vi.hoisted(() => {
  ;(globalThis as { document?: unknown }).document = {}
})

afterAll(() => {
  delete (globalThis as { document?: unknown }).document
})

describe('notes page in the Node server', () => {
  it('loads while the Etebase placeholder document is set', () => {
    expect(typeof NotesPage).toBe('function')
  })
})
