import { act } from '@testing-library/react'
import remarkGfm from 'remark-gfm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { clearNotePreviewVerdict } from '@/app/lib/note-preview-verdict'
import type { ProbeMessage, ProbeRequest } from '../note-markdown-probe'
import type { ProbeWorker, ProbeWorkerFactory } from '../note-markdown-probe-client'

// react-markdown is wrapped so every call, from the page's component and from the
// worker's plain-function parse, is recorded with the props it was given.
const calls = vi.hoisted(() => ({ props: [] as Array<{ remarkPlugins?: unknown; urlTransform?: unknown }> }))
vi.mock('react-markdown', async (importOriginal) => {
  const original = await importOriginal<typeof import('react-markdown')>()
  const recording = (props: { remarkPlugins?: unknown; urlTransform?: unknown }) => {
    calls.props.push(props)
    return original.default(props as never)
  }
  return { ...original, default: recording }
})

const { NoteMarkdownPreview } = await import('../NoteMarkdownPreview')
const { parseNoteMarkdown, probeNoteMarkdown } = await import('../note-markdown-probe')
const { allowedLinkTarget, remarkNotesProfile, REMARK_PLUGINS } = await import('../note-markdown-profile')
const { PARSE_BUDGET_MS } = await import('../note-markdown-probe')

// A worker that does what the real worker file does (note-markdown-probe.worker.ts
// calls probeNoteMarkdown on each request), in this thread, so the page's own
// client, protocol and fallback run against the real parse. jsdom has no Worker.
class LoopbackWorker implements ProbeWorker {
  onerror: ProbeWorker['onerror'] = null
  onmessageerror: ProbeWorker['onmessageerror'] = null
  terminated = false
  private handler: ProbeWorker['onmessage'] = null

  get onmessage() {
    return this.handler
  }

  set onmessage(next: ProbeWorker['onmessage']) {
    this.handler = next
    next?.({ data: { type: 'ready' } satisfies ProbeMessage })
  }

  postMessage(request: ProbeRequest) {
    const { ok, elements } = probeNoteMarkdown(request.content)
    this.handler?.({ data: { type: 'result', id: request.id, ok, elements } satisfies ProbeMessage })
  }

  terminate() {
    this.terminated = true
  }
}

const loopbackFactory: ProbeWorkerFactory = () => new LoopbackWorker()

const NOTICE = 'Shown as plain text: this note is too complex to format.'

// A table is padded to its header's width on every row, so its cells are columns
// times rows. The budget is 10,000 cells over all tables (remarkNotesProfile).
const tableOf = (columns: number, rows: number) =>
  [`|${'a|'.repeat(columns)}`, `|${'-|'.repeat(columns)}`, ...Array.from({ length: rows - 1 }, () => `|${'x|'.repeat(columns)}`)].join('\n')

function show(content: string) {
  return renderWithIntl(<NoteMarkdownPreview content={content} createWorker={loopbackFactory} />)
}

describe('the time-budget worker applies the page pipeline', () => {
  beforeEach(() => {
    clearNotePreviewVerdict()
    calls.props.length = 0
    // The loopback worker parses inside postMessage, so a slow machine would run past
    // the time budget. The clock stands still; the budget has its own tests.
    vi.spyOn(performance, 'now').mockReturnValue(1000)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('answers ok: false for a body over the table cell budget and ok for one at it', () => {
    expect(probeNoteMarkdown(tableOf(100, 100)).ok).toBe(true)
    expect(probeNoteMarkdown(tableOf(100, 101))).toEqual({ ok: false, elements: 0 })
    // The padded width counts, not the cells written: 500 columns by 21 rows is 10,500.
    const wide = `|${'a|'.repeat(500)}\n|${'-|'.repeat(500)}\n${'x\n'.repeat(19)}x`
    expect(probeNoteMarkdown(wide)).toEqual({ ok: false, elements: 0 })
  }, 30000)

  it('shows a body over the cell budget as plain text with the notice, and leaves the wait empty of tables', () => {
    const body = tableOf(100, 101)
    const view = show(body)

    expect(view.container.querySelector('table')).toBeNull()
    expect(view.container.querySelector('[data-note-preview="pending"]')).toBeNull()
    expect(view.container.querySelector('[data-note-preview="plain-text"]')?.textContent).toBe(body)
    expect(view.container).toHaveTextContent(NOTICE)
  }, 30000)

  it('formats a body at the cell budget through the same worker path', () => {
    const view = show(tableOf(100, 100))

    expect(view.container.querySelector('[data-note-preview="plain-text"]')).toBeNull()
    expect(view.container.querySelectorAll('th')).toHaveLength(100)
    expect(view.container.querySelectorAll('td')).toHaveLength(9900)
  }, 30000)

  it('shows the body as plain text when the main thread alone would refuse it, whichever side decides', () => {
    // The worker is silent (it never answers ok): the time budget decides.
    vi.useFakeTimers()
    try {
      const silent: ProbeWorkerFactory = () => ({
        onmessage: null,
        onerror: null,
        onmessageerror: null,
        postMessage: () => undefined,
        terminate: () => undefined,
      })
      const body = tableOf(100, 101)
      const view = renderWithIntl(<NoteMarkdownPreview content={body} createWorker={silent} />)
      act(() => vi.advanceTimersByTime(PARSE_BUDGET_MS))
      expect(view.container.querySelector('table')).toBeNull()
    } finally {
      vi.useRealTimers()
    }

    // The worker says ok for a body over the budget (a drifted worker): the page's own
    // parse still refuses it, through the failure boundary.
    const lying: ProbeWorkerFactory = () => {
      const worker = new LoopbackWorker()
      worker.postMessage = (request) =>
        worker.onmessage?.({ data: { type: 'result', id: request.id, ok: true, elements: 1 } satisfies ProbeMessage })
      return worker
    }
    const body = tableOf(100, 101)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const view = renderWithIntl(<NoteMarkdownPreview content={body} createWorker={lying} />)
      expect(view.container.querySelector('table')).toBeNull()
      expect(view.container.querySelector('[data-note-preview="plain-text"]')?.textContent).toBe(body)
    } finally {
      spy.mockRestore()
    }
  }, 30000)

  it('gives the page and the worker the same plugin list and link rule, from one module', () => {
    // Rendered by the page (the worker answers ok through the real parse, then the
    // page formats), and parsed by the worker's function. Both reach react-markdown.
    show('A **note** with [a link](https://example.com)')
    const pageCalls = calls.props.length
    expect(pageCalls).toBeGreaterThanOrEqual(2)

    calls.props.length = 0
    parseNoteMarkdown('A **note**')
    expect(calls.props).toHaveLength(1)
    const workerSide = calls.props[0]

    calls.props.length = 0
    show('A **note** with [a link](https://example.com)')
    // The call the page makes for the body is the one that carries its components.
    const pageSide = calls.props.filter((props) => 'components' in props)
    expect(pageSide).toHaveLength(1)

    expect(workerSide.remarkPlugins).toBe(REMARK_PLUGINS)
    expect(pageSide[0].remarkPlugins).toBe(workerSide.remarkPlugins)
    expect(pageSide[0].urlTransform).toBe(allowedLinkTarget)
    expect(workerSide.urlTransform).toBe(pageSide[0].urlTransform)
    // And the list is the profile: GFM, then the plugin that narrows it and holds the cell budget.
    expect(REMARK_PLUGINS).toEqual([remarkGfm, remarkNotesProfile])
  })
})
