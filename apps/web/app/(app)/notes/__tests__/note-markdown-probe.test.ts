import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { countElements, MAX_ELEMENTS, PARSE_BUDGET_MS, parseNoteMarkdown, probeNoteMarkdown } from '../note-markdown-probe'
import { createProbeClient, type ProbeVerdict } from '../note-markdown-probe-client'
import { manualWorkers } from './probe-test-workers'

describe('probeNoteMarkdown', () => {
  it('parses a body as the page does and counts its elements', () => {
    const result = probeNoteMarkdown('# Title\n\n- [ ] one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')

    expect(result.ok).toBe(true)
    expect(result.elements).toBeGreaterThan(10)
    expect(result.elements).toBeLessThan(40)
  })

  it('counts a flat list item by item, and stops one past the limit', () => {
    expect(probeNoteMarkdown('- item\n'.repeat(3000)).elements).toBe(3002)
    const elements = Array.from({ length: 10 }, () => ({ props: {} }))
    expect(countElements(elements as never, 5)).toBe(6)
    expect(countElements(elements as never, 50)).toBe(10)
    // Nesting far deeper than the stack is counted without recursion.
    let deep: unknown = 'x'
    for (let level = 0; level < 100000; level += 1) deep = { props: { children: deep } }
    expect(countElements(deep as never, 1e9)).toBe(100000)
  })

  it('answers not ok, with no message, for a body that overflows the stack', () => {
    const result = probeNoteMarkdown(`${'>'.repeat(4000)}x`)

    expect(result).toEqual({ ok: false, elements: 0 })
  })

  it('applies the link rule of the page, so a refused target has no address in the tree', () => {
    const tree = parseNoteMarkdown('[a](javascript:alert(1)) [b](https://example.com) [c](//example.com/x) [d](mailto:x@example.com)')
    const hrefs: string[] = []
    const pending: unknown[] = [tree]
    while (pending.length > 0) {
      const item = pending.pop()
      if (Array.isArray(item)) pending.push(...item)
      else if (typeof item === 'object' && item !== null && 'props' in item) {
        const element = item as ReactElement<{ href?: string; children?: unknown }>
        if (element.type === 'a') hrefs.push(element.props.href ?? '')
        pending.push(element.props.children)
      }
    }

    expect(hrefs.sort()).toEqual(['', '', 'https://example.com', 'mailto:x@example.com'])
  })
})

describe('the worker file', () => {
  const posted: unknown[] = []
  const scope: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (message: unknown) => void } = {
    onmessage: null,
    postMessage: (message) => posted.push(message),
  }

  beforeEach(async () => {
    posted.length = 0
    scope.onmessage = null
    vi.stubGlobal('self', scope)
    vi.resetModules()
    await import('../note-markdown-probe.worker')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('says it is ready, then answers a request with a verdict and a count and nothing else', () => {
    expect(posted).toEqual([{ type: 'ready' }])

    scope.onmessage?.({ data: { id: 7, content: 'A **secret** body' } })

    expect(posted[1]).toEqual({ type: 'result', id: 7, ok: true, elements: expect.any(Number) })
    expect(JSON.stringify(posted)).not.toContain('secret')
  })

  it('answers an unparseable body with ok false and no error text', () => {
    scope.onmessage?.({ data: { id: 8, content: `${'>'.repeat(4000)}secret` } })

    expect(posted[1]).toEqual({ type: 'result', id: 8, ok: false, elements: 0 })
  })

  it('ignores a message that is not a request', () => {
    scope.onmessage?.({ data: null })
    scope.onmessage?.({ data: 'text' })
    scope.onmessage?.({ data: { id: '1', content: 'x' } })
    scope.onmessage?.({ data: { id: 1, content: 5 } })

    expect(posted).toEqual([{ type: 'ready' }])
  })
})

describe('the probe client', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts the budget when the worker is asked, not when it is made', () => {
    const { made, factory } = manualWorkers()
    const client = createProbeClient(factory)
    const verdicts: ProbeVerdict[] = []
    client.probe('body', (verdict) => verdicts.push(verdict))

    vi.advanceTimersByTime(PARSE_BUDGET_MS * 4)
    expect(verdicts).toEqual([])
    made[0].ready()
    vi.advanceTimersByTime(PARSE_BUDGET_MS - 1)
    expect(verdicts).toEqual([])
    vi.advanceTimersByTime(1)
    expect(verdicts).toEqual(['plain'])
  })

  it('refuses an ok answer that came after the budget, even when the timer has not fired yet', () => {
    // A hidden tab aligns timers to about a second, and a busy main thread runs them
    // late, so an answer can arrive after the budget but before the timer. The clock
    // moves here with no timer running.
    let now = 5000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { made, factory } = manualWorkers()
    const client = createProbeClient(factory)
    const verdicts: ProbeVerdict[] = []
    client.probe('slow', (verdict) => verdicts.push(verdict))
    made[0].ready()

    now += PARSE_BUDGET_MS + 1
    made[0].answer(made[0].requests[0])
    expect(verdicts).toEqual(['plain'])

    // At exactly the budget the answer still counts.
    const onTime: ProbeVerdict[] = []
    client.probe('on time', (verdict) => onTime.push(verdict))
    const request = made[0].requests[made[0].requests.length - 1]
    now += PARSE_BUDGET_MS
    made[0].answer(request)
    expect(onTime).toEqual(['ok'])
    vi.restoreAllMocks()
  })

  it('takes only the first verdict for a request, and none after it is withdrawn', () => {
    const { made, factory } = manualWorkers()
    const client = createProbeClient(factory)
    const verdicts: ProbeVerdict[] = []
    const withdraw = client.probe('body', (verdict) => verdicts.push(verdict))
    made[0].ready()
    const request = made[0].requests[0]

    made[0].answer(request)
    made[0].answer(request, false)
    expect(verdicts).toEqual(['ok'])

    const withdrawn: ProbeVerdict[] = []
    const cancel = client.probe('next', (verdict) => withdrawn.push(verdict))
    cancel()
    made[0].answer(made[0].requests[1])
    withdraw()
    expect(withdrawn).toEqual([])
  })

  it('ends a worker whose request was withdrawn, but keeps one that was never asked', () => {
    const { made, factory } = manualWorkers()
    const client = createProbeClient(factory)
    const cancelUnsent = client.probe('one', () => {})
    cancelUnsent()
    expect(made[0].terminated).toBe(false)

    made[0].ready()
    const cancelSent = client.probe('two', () => {})
    expect(made[0].requests).toHaveLength(1)
    cancelSent()
    expect(made[0].terminated).toBe(true)

    client.probe('three', () => {})
    expect(made).toHaveLength(2)
  })

  it('settles a request as plain text when the worker errors, and cancels the event so the page does not report it', () => {
    const { made, factory } = manualWorkers()
    const client = createProbeClient(factory)
    const verdicts: ProbeVerdict[] = []
    client.probe('body', (verdict) => verdicts.push(verdict))
    made[0].ready()

    const event = { preventDefault: vi.fn() }
    made[0].onerror?.(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(verdicts).toEqual(['plain'])
    expect(made[0].terminated).toBe(true)
  })

  it('settles a request as plain text when the body cannot be sent to the worker', () => {
    const { made, factory } = manualWorkers()
    const client = createProbeClient(factory)
    const verdicts: ProbeVerdict[] = []
    client.probe('body', (verdict) => verdicts.push(verdict))
    made[0].postMessage = () => {
      throw new Error('could not be cloned')
    }

    made[0].ready()
    expect(verdicts).toEqual(['plain'])
    expect(made[0].terminated).toBe(true)
  })

  it('settles as unparsable, not plain, when the worker says the parse threw, in time or late', () => {
    // A parse that throws (the table cell budget, a stack overflow) throws on the
    // page too, so it is told apart from a body that was only slow or large.
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { made, factory } = manualWorkers()
    const client = createProbeClient(factory)
    const verdicts: ProbeVerdict[] = []
    client.probe('in time', (verdict) => verdicts.push(verdict))
    made[0].ready()
    made[0].answer(made[0].requests[0], false, 0)

    client.probe('late', (verdict) => verdicts.push(verdict))
    now += PARSE_BUDGET_MS + 1
    made[0].answer(made[0].requests[1], false, 0)

    // A slow or large body that did parse stays plain.
    client.probe('large', (verdict) => verdicts.push(verdict))
    made[0].answer(made[0].requests[2], true, MAX_ELEMENTS + 1)
    expect(verdicts).toEqual(['unparsable', 'unparsable', 'plain'])
    vi.restoreAllMocks()
  })

  it('ends the worker and the budget timer on dispose, and never answers a request that was open', () => {
    const { made, factory } = manualWorkers()
    const client = createProbeClient(factory)
    const verdicts: ProbeVerdict[] = []
    client.probe('body', (verdict) => verdicts.push(verdict))
    made[0].ready()
    expect(vi.getTimerCount()).toBe(1)

    client.dispose()
    expect(made[0].terminated).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(PARSE_BUDGET_MS * 40)
    expect(verdicts).toEqual([])
  })
})
