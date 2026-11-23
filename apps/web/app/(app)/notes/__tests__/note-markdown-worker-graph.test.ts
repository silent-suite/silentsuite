// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

// A Web Worker has no `document` or `window`. This environment has neither, so a
// module in the worker's import graph that touches one while it loads fails here,
// instead of showing every note as plain text in a browser.
// It cannot show the bundler's choice of package entry (webpack takes the
// "browser" condition, Node does not); next-config-worker-plugin.test.ts pins
// the config that handles that one.

describe('the Notes preview worker graph with no DOM', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('runs in an environment with no document, window or navigator', () => {
    expect(typeof document).toBe('undefined')
    expect(typeof window).toBe('undefined')
    expect(typeof navigator === 'undefined' || (navigator as { userAgent?: string }).userAgent?.startsWith('Node.js')).toBe(true)
  })

  it('loads the probe module, react-markdown, remark-gfm and the profile, and parses', async () => {
    const probe = await import('../note-markdown-probe')

    expect(probe.probeNoteMarkdown('# Title\n\n- [x] done\n\n| a |\n|---|\n| 1 |\n&amp; **bold**').ok).toBe(true)
  }, 30000)

  it('loads the worker file with only `self` present, says ready and answers a request', async () => {
    const posted: unknown[] = []
    const scope: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (message: unknown) => void } = {
      onmessage: null,
      postMessage: (message) => posted.push(message),
    }
    vi.stubGlobal('self', scope)
    vi.resetModules()
    await import('../note-markdown-probe.worker')

    expect(posted).toEqual([{ type: 'ready' }])
    scope.onmessage?.({ data: { id: 1, content: 'A **body** with an &amp; entity' } })
    expect(posted[1]).toEqual({ type: 'result', id: 1, ok: true, elements: expect.any(Number) })
  }, 30000)
})
