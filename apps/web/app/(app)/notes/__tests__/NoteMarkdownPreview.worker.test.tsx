import { StrictMode } from 'react'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { bumpAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'
import {
  clearNotePreviewVerdict,
  notePreviewFormatAnyway,
  notePreviewWasOk,
  rememberNotePreviewFormatAnyway,
} from '@/app/lib/note-preview-verdict'
import { NoteMarkdownPreview } from '../NoteMarkdownPreview'
import { MAX_ELEMENTS, PARSE_BUDGET_MS, WORKER_START_LIMIT_MS } from '../note-markdown-probe'
import type { ProbeWorkerFactory } from '../note-markdown-probe-client'
import { manualWorkers, okWorkerFactory, type ManualWorker } from './probe-test-workers'

const NOTICE = 'Shown as plain text: this note is too complex to format.'
const BODY = 'A **normal** note'

function plainText(container: HTMLElement) {
  return container.querySelector('[data-note-preview="plain-text"]')
}

function pendingBox(container: HTMLElement) {
  return container.querySelector('[data-note-preview="pending"]')
}

function show(content: string, createWorker: ProbeWorkerFactory) {
  return renderWithIntl(<NoteMarkdownPreview content={content} createWorker={createWorker} />)
}

describe('NoteMarkdownPreview time budget', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearNotePreviewVerdict()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits empty and busy, sends the worker only an id and the body, and formats after an ok answer', () => {
    const { made, factory } = manualWorkers()
    const view = show(BODY, factory)

    expect(pendingBox(view.container)).toHaveAttribute('aria-busy', 'true')
    expect(pendingBox(view.container)).toBeEmptyDOMElement()
    expect(made[0].requests).toEqual([])

    act(() => made[0].ready())
    expect(made[0].requests).toEqual([{ id: expect.any(Number), content: BODY }])
    expect(pendingBox(view.container)).not.toBeNull()

    act(() => made[0].answer(made[0].requests[0]))
    expect(pendingBox(view.container)).toBeNull()
    expect(plainText(view.container)).toBeNull()
    expect(screen.getByText('normal').tagName).toBe('STRONG')
    expect(made[0].terminated).toBe(false)
  })

  it('shows plain text with the notice, and ends the worker, when no answer comes within the budget', () => {
    const { made, factory } = manualWorkers()
    const view = show(BODY, factory)
    act(() => made[0].ready())

    act(() => vi.advanceTimersByTime(PARSE_BUDGET_MS - 1))
    expect(pendingBox(view.container)).not.toBeNull()
    expect(made[0].terminated).toBe(false)

    act(() => vi.advanceTimersByTime(1))
    expect(plainText(view.container)).toHaveTextContent(BODY)
    expect(plainText(view.container)?.textContent).toBe(BODY)
    expect(view.container).toHaveTextContent(NOTICE)
    expect(made[0].terminated).toBe(true)
    expect(view.container.querySelector('strong')).toBeNull()
  })

  it('shows the body as text, never as markup, when it falls back', () => {
    const { made, factory } = manualWorkers()
    const view = show('**x** <b>y</b> [z](https://example.com)', factory)
    act(() => made[0].ready())
    act(() => vi.advanceTimersByTime(PARSE_BUDGET_MS))

    expect(plainText(view.container)?.textContent).toBe('**x** <b>y</b> [z](https://example.com)')
    expect(view.container.querySelector('b, a, strong')).toBeNull()
  })

  it('does not charge the time a new worker takes to load against the note', () => {
    const { made, factory } = manualWorkers()
    const view = show(BODY, factory)

    act(() => vi.advanceTimersByTime(WORKER_START_LIMIT_MS - 1000))
    expect(pendingBox(view.container)).not.toBeNull()
    act(() => made[0].ready())
    act(() => vi.advanceTimersByTime(PARSE_BUDGET_MS - 1))
    expect(pendingBox(view.container)).not.toBeNull()
    act(() => made[0].answer(made[0].requests[0]))
    expect(screen.getByText('normal')).toBeInTheDocument()
  })

  it('gives up on a worker that never loads', () => {
    const { made, factory } = manualWorkers()
    const view = show(BODY, factory)

    act(() => vi.advanceTimersByTime(WORKER_START_LIMIT_MS))
    expect(plainText(view.container)).toHaveTextContent(BODY)
    expect(view.container).toHaveTextContent(NOTICE)
    expect(made[0].terminated).toBe(true)
  })

  it('shows plain text when the worker reports an error', () => {
    const { made, factory } = manualWorkers()
    const view = show(BODY, factory)
    act(() => made[0].ready())

    act(() => made[0].onerror?.({}))
    expect(plainText(view.container)).toHaveTextContent(BODY)
    expect(made[0].terminated).toBe(true)
  })

  it('shows plain text when a message cannot be read', () => {
    const { made, factory } = manualWorkers()
    const view = show(BODY, factory)
    act(() => made[0].ready())

    act(() => made[0].onmessageerror?.({}))
    expect(plainText(view.container)).toHaveTextContent(BODY)
    expect(made[0].terminated).toBe(true)
  })

  it('shows plain text when the worker cannot be made, and never formats', () => {
    const view = show(BODY, () => {
      throw new Error('Workers are blocked')
    })

    expect(plainText(view.container)).toHaveTextContent(BODY)
    expect(view.container).toHaveTextContent(NOTICE)
    expect(view.container.querySelector('strong')).toBeNull()
  })

  it('shows plain text when the worker says the parse failed', () => {
    const { made, factory } = manualWorkers()
    const view = show(BODY, factory)
    act(() => made[0].ready())

    act(() => made[0].answer(made[0].requests[0], false, 0))
    expect(plainText(view.container)).toHaveTextContent(BODY)
    expect(view.container).toHaveTextContent(NOTICE)
  })

  it.each([
    [MAX_ELEMENTS, true],
    [MAX_ELEMENTS + 1, false],
  ])('formats a body of %i elements: %s', (elements, formatted) => {
    const { made, factory } = manualWorkers()
    const view = show(BODY, factory)
    act(() => made[0].ready())

    act(() => made[0].answer(made[0].requests[0], true, elements))
    expect(plainText(view.container) === null).toBe(formatted)
    expect(view.container.querySelector('strong') !== null).toBe(formatted)
  })

  it('ignores an answer for a body that was replaced, and a message it cannot read', () => {
    const { made, factory } = manualWorkers()
    const view = show('first body', factory)
    act(() => made[0].ready())
    const stale = made[0].requests[0]

    // The body changes while the worker is still busy with the first.
    view.rerender(<NoteMarkdownPreview content="second body" createWorker={factory} />)
    expect(made[0].terminated).toBe(true)
    expect(made).toHaveLength(2)

    // The old worker's handlers are gone, so even a late answer from it reaches nobody.
    act(() => made[0].answer(stale))
    expect(pendingBox(view.container)).not.toBeNull()
    act(() => made[1].ready())
    act(() => made[1].emit({ type: 'result', id: made[1].requests[0].id + 1, ok: true, elements: 1 }))
    act(() => made[1].emit({ type: 'result', id: made[1].requests[0].id, ok: 'yes', elements: 1 }))
    act(() => made[1].emit('ok'))
    act(() => made[1].emit(null))
    expect(pendingBox(view.container)).not.toBeNull()
    expect(made[1].requests).toEqual([{ id: expect.any(Number), content: 'second body' }])

    act(() => made[1].answer(made[1].requests[0]))
    expect(view.container).toHaveTextContent('second body')
    expect(pendingBox(view.container)).toBeNull()
  })

  it('keeps one worker while the body changes and no request is outstanding', () => {
    const { made, factory } = manualWorkers()
    const view = show('first body', factory)
    act(() => made[0].ready())
    act(() => made[0].answer(made[0].requests[0]))

    view.rerender(<NoteMarkdownPreview content="second body" createWorker={factory} />)
    expect(made).toHaveLength(1)
    expect(made[0].terminated).toBe(false)
    expect(made[0].requests.map((request) => request.content)).toEqual(['first body', 'second body'])
  })

  it('ends the worker when the preview closes, whether or not a request is outstanding', () => {
    const busy = manualWorkers()
    const view = show(BODY, busy.factory)
    act(() => busy.made[0].ready())
    view.unmount()
    expect(busy.made[0].terminated).toBe(true)

    clearNotePreviewVerdict()
    const idle = manualWorkers()
    const answered = show(BODY, idle.factory)
    act(() => idle.made[0].ready())
    act(() => idle.made[0].answer(idle.made[0].requests[0]))
    expect(idle.made[0].terminated).toBe(false)
    answered.unmount()
    expect(idle.made[0].terminated).toBe(true)
  })

  it('shows the same body at once the next time, without a worker, but only after an ok answer', () => {
    const first = manualWorkers()
    const view = show(BODY, first.factory)
    act(() => first.made[0].ready())
    act(() => first.made[0].answer(first.made[0].requests[0]))
    view.unmount()

    const factory = vi.fn<ProbeWorkerFactory>(() => {
      throw new Error('not needed')
    })
    const again = show(BODY, factory)
    expect(screen.getByText('normal')).toBeInTheDocument()
    expect(factory).not.toHaveBeenCalled()
    again.unmount()

    // A different body is probed again.
    const other = manualWorkers()
    const next = show('another body', other.factory)
    expect(other.made).toHaveLength(1)
    expect(pendingBox(next.container)).not.toBeNull()
  })

  it('does not remember a timeout: the next time tries again', () => {
    const first = manualWorkers()
    const view = show(BODY, first.factory)
    act(() => first.made[0].ready())
    act(() => vi.advanceTimersByTime(PARSE_BUDGET_MS))
    expect(plainText(view.container)).not.toBeNull()
    view.unmount()

    const second = manualWorkers()
    const again = show(BODY, second.factory)
    expect(second.made).toHaveLength(1)
    expect(pendingBox(again.container)).not.toBeNull()
    act(() => second.made[0].ready())
    act(() => second.made[0].answer(second.made[0].requests[0]))
    expect(screen.getByText('normal')).toBeInTheDocument()
  })

  it('does not remember an answer that was too large either', () => {
    const first = manualWorkers()
    const view = show(BODY, first.factory)
    act(() => first.made[0].ready())
    act(() => first.made[0].answer(first.made[0].requests[0], true, MAX_ELEMENTS + 1))
    expect(plainText(view.container)).not.toBeNull()
    view.unmount()

    const second = manualWorkers()
    show(BODY, second.factory)
    expect(second.made).toHaveLength(1)
  })

  it('shows a body the nesting guard refuses as plain text with the notice, without asking a worker', () => {
    const factory = vi.fn<ProbeWorkerFactory>(okWorkerFactory)
    const body = `${'- '.repeat(101)}deep`
    const view = show(body, factory)

    expect(factory).not.toHaveBeenCalled()
    expect(plainText(view.container)?.textContent).toBe(body)
    expect(view.container).toHaveTextContent(NOTICE)
  })

  it('says there is nothing to preview for an empty body, without a notice or a worker', () => {
    const factory = vi.fn<ProbeWorkerFactory>(okWorkerFactory)
    const view = show('   ', factory)

    expect(view.container).toHaveTextContent('Nothing to preview yet.')
    expect(view.container).not.toHaveTextContent(NOTICE)
    expect(factory).not.toHaveBeenCalled()
  })

  it('keeps the worker that is still loading when the body changes before it is ready, and asks it only about the new body', () => {
    const { made, factory } = manualWorkers()
    const view = show('first body', factory)

    view.rerender(<NoteMarkdownPreview content="second body" createWorker={factory} />)
    expect(made).toHaveLength(1)
    expect(made[0].terminated).toBe(false)

    act(() => made[0].ready())
    expect(made[0].requests.map((request) => request.content)).toEqual(['second body'])
    act(() => made[0].answer(made[0].requests[0]))
    expect(view.container).toHaveTextContent('second body')
    expect(pendingBox(view.container)).toBeNull()
  })

  it('closes before the worker is ready without leaving anything running', () => {
    const { made, factory } = manualWorkers()
    const view = show(BODY, factory)

    view.unmount()
    expect(made[0].terminated).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('works under StrictMode, which runs each effect twice, and leaves one live worker', () => {
    const { made, factory } = manualWorkers()
    const view = renderWithIntl(
      <StrictMode>
        <NoteMarkdownPreview content={BODY} createWorker={factory} />
      </StrictMode>,
    )

    const live = made.filter((worker) => !worker.terminated)
    expect(live).toHaveLength(1)
    act(() => live[0].ready())
    act(() => live[0].answer(live[0].requests[0]))
    expect(screen.getByText('normal')).toBeInTheDocument()
    expect(pendingBox(view.container)).toBeNull()
    view.unmount()
    expect(made.every((worker) => worker.terminated)).toBe(true)
  })

  it('does not remember an ok answer that arrives after an account boundary', () => {
    const { made, factory } = manualWorkers()
    const view = show(BODY, factory)
    act(() => made[0].ready())

    bumpAccountEpoch()
    act(() => made[0].answer(made[0].requests[0]))
    view.unmount()

    expect(notePreviewWasOk(BODY)).toBe(false)
    const again = manualWorkers()
    show(BODY, again.factory)
    expect(again.made).toHaveLength(1)
  })

  it('probes the same body again after an account boundary', () => {
    const first = manualWorkers()
    const view = show(BODY, first.factory)
    act(() => first.made[0].ready())
    act(() => first.made[0].answer(first.made[0].requests[0]))
    view.unmount()

    bumpAccountEpoch()
    const second = manualWorkers()
    const again = show(BODY, second.factory)
    expect(second.made).toHaveLength(1)
    expect(pendingBox(again.container)).not.toBeNull()
  })
})

const FORMAT_ANYWAY = 'Format anyway'
const FORMAT_ANYWAY_HINT = 'This tab may stop responding while the note is formatted.'

function formatAnywayButton() {
  return screen.queryByRole('button', { name: FORMAT_ANYWAY })
}

// A table is padded to its header's width on every row, so its cells are columns
// times rows. The budget is 10,000 cells over all tables (remarkNotesProfile).
const tableOf = (columns: number, rows: number) =>
  [`|${'a|'.repeat(columns)}`, `|${'-|'.repeat(columns)}`, ...Array.from({ length: rows - 1 }, () => `|${'x|'.repeat(columns)}`)].join('\n')

// Ends a probe the way the budget does: ready, then no answer in time.
function runOutOfTime(worker: ManualWorker) {
  act(() => worker.ready())
  act(() => vi.advanceTimersByTime(PARSE_BUDGET_MS))
}

describe('NoteMarkdownPreview Format anyway', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearNotePreviewVerdict()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // Each path where only time, size or the worker itself decided.
  const offered: Array<[string, (made: ManualWorker[]) => void]> = [
    ['the budget runs out', (made) => runOutOfTime(made[0])],
    [
      'the answer comes after the budget',
      (made) => {
        let now = 1000
        vi.spyOn(performance, 'now').mockImplementation(() => now)
        act(() => made[0].ready())
        now += PARSE_BUDGET_MS + 1
        act(() => made[0].answer(made[0].requests[0]))
      },
    ],
    [
      'the tree is over the element cap',
      (made) => {
        act(() => made[0].ready())
        act(() => made[0].answer(made[0].requests[0], true, MAX_ELEMENTS + 1))
      },
    ],
    [
      'the worker reports an error',
      (made) => {
        act(() => made[0].ready())
        act(() => made[0].onerror?.({}))
      },
    ],
    [
      'a message cannot be read',
      (made) => {
        act(() => made[0].ready())
        act(() => made[0].onmessageerror?.({}))
      },
    ],
    ['the worker never loads', () => act(() => vi.advanceTimersByTime(WORKER_START_LIMIT_MS))],
  ]

  it.each(offered)('offers the button, named and described, when %s', (_name, settle) => {
    const { made, factory } = manualWorkers()
    const view = show(BODY, factory)
    expect(pendingBox(view.container)).not.toBeNull()
    expect(formatAnywayButton()).toBeNull()

    settle(made)
    expect(plainText(view.container)?.textContent).toBe(BODY)
    expect(view.container).toHaveTextContent(NOTICE)
    const button = formatAnywayButton()
    expect(button).not.toBeNull()
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveAccessibleDescription(FORMAT_ANYWAY_HINT)
    expect(view.container.querySelector('strong')).toBeNull()
  })

  it('offers the button when the worker cannot be made', () => {
    const view = show(BODY, () => {
      throw new Error('Workers are blocked')
    })

    expect(plainText(view.container)?.textContent).toBe(BODY)
    expect(formatAnywayButton()).not.toBeNull()
  })

  it('does not offer it for a body the nesting guard refuses, even with a choice on record', () => {
    const body = `${'- '.repeat(101)}deep`
    rememberNotePreviewFormatAnyway(body, getAccountEpoch())
    const factory = vi.fn<ProbeWorkerFactory>(okWorkerFactory)
    const view = show(body, factory)

    expect(plainText(view.container)?.textContent).toBe(body)
    expect(view.container).toHaveTextContent(NOTICE)
    expect(formatAnywayButton()).toBeNull()
    expect(view.container.querySelector('ul')).toBeNull()
    expect(factory).not.toHaveBeenCalled()
  })

  it('does not offer it when the worker says the parse threw', () => {
    const { made, factory } = manualWorkers()
    const view = show(BODY, factory)
    act(() => made[0].ready())

    act(() => made[0].answer(made[0].requests[0], false, 0))
    expect(plainText(view.container)?.textContent).toBe(BODY)
    expect(formatAnywayButton()).toBeNull()
  })

  it('does not offer it when the page parse fails after an ok answer', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const body = tableOf(100, 101)
    const view = show(body, okWorkerFactory)

    expect(plainText(view.container)?.textContent).toBe(body)
    expect(view.container.querySelector('table')).toBeNull()
    expect(formatAnywayButton()).toBeNull()
  }, 30000)

  it('formats this body on the page when chosen, and moves focus to the formatted note', () => {
    const { made, factory } = manualWorkers()
    const view = show(BODY, factory)
    runOutOfTime(made[0])
    const button = formatAnywayButton()
    button?.focus()
    expect(document.activeElement).toBe(button)

    fireEvent.click(button as HTMLElement)
    expect(plainText(view.container)).toBeNull()
    expect(screen.getByText('normal').tagName).toBe('STRONG')
    expect(formatAnywayButton()).toBeNull()
    const formatted = view.container.querySelector('[data-note-preview="format-anyway"]')
    expect(formatted).not.toBeNull()
    expect(formatted).toHaveAttribute('tabindex', '-1')
    expect(document.activeElement).toBe(formatted)
    // The choice is kept for the body, but it is not an ok verdict.
    expect(notePreviewFormatAnyway(BODY)).toBe('chosen')
    expect(notePreviewWasOk(BODY)).toBe(false)
  })

  it('never formats past the table cell budget: a forced body that fails shows plain text, without the button again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const body = tableOf(100, 101)
    const { made, factory } = manualWorkers()
    const view = show(body, factory)
    runOutOfTime(made[0])

    fireEvent.click(formatAnywayButton() as HTMLElement)
    expect(view.container.querySelector('table')).toBeNull()
    expect(plainText(view.container)?.textContent).toBe(body)
    expect(view.container).toHaveTextContent(NOTICE)
    expect(formatAnywayButton()).toBeNull()
    expect(notePreviewFormatAnyway(body)).toBe('failed')
    view.unmount()

    // Opened again, the body is neither timed nor parsed, and the button stays away.
    const again = vi.fn<ProbeWorkerFactory>(okWorkerFactory)
    const reopened = show(body, again)
    expect(again).not.toHaveBeenCalled()
    expect(plainText(reopened.container)?.textContent).toBe(body)
    expect(reopened.container.querySelector('table')).toBeNull()
    expect(formatAnywayButton()).toBeNull()
  }, 30000)

  it('keeps focus in the preview after a forced parse fails, also when the preview renders again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const body = tableOf(100, 101)
    const { made, factory } = manualWorkers()
    const view = show(body, factory)
    runOutOfTime(made[0])
    const button = formatAnywayButton()
    button?.focus()
    expect(document.activeElement).toBe(button)

    fireEvent.click(button as HTMLElement)
    const box = view.container.querySelector('[data-note-preview="format-anyway"]')
    expect(box).not.toBeNull()
    expect(document.activeElement).toBe(box)
    expect(plainText(view.container)?.textContent).toBe(body)

    // The page renders the preview again with the same body (any store update does).
    view.rerender(<NoteMarkdownPreview content={body} createWorker={factory} />)
    expect(plainText(view.container)?.textContent).toBe(body)
    expect(formatAnywayButton()).toBeNull()
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement).toBe(view.container.querySelector('[data-note-preview="format-anyway"]'))
  }, 30000)

  it('holds the choice for that exact body only', () => {
    const { made, factory } = manualWorkers()
    const view = show('first **body**', factory)
    runOutOfTime(made[0])
    fireEvent.click(formatAnywayButton() as HTMLElement)
    expect(screen.getByText('body').tagName).toBe('STRONG')

    // Another body is timed again and gets its own button.
    view.rerender(<NoteMarkdownPreview content="second **body**" createWorker={factory} />)
    expect(pendingBox(view.container)).not.toBeNull()
    runOutOfTime(made[made.length - 1])
    expect(plainText(view.container)?.textContent).toBe('second **body**')
    expect(formatAnywayButton()).not.toBeNull()
    expect(view.container.querySelector('strong')).toBeNull()

    // Back on the chosen body, it formats at once and asks no worker.
    const requests = made.flatMap((worker) => worker.requests).length
    view.rerender(<NoteMarkdownPreview content="first **body**" createWorker={factory} />)
    expect(screen.getByText('body').tagName).toBe('STRONG')
    expect(made.flatMap((worker) => worker.requests)).toHaveLength(requests)
    view.unmount()

    // Opened again later, it formats without a worker and does not take focus.
    const unused = vi.fn<ProbeWorkerFactory>(okWorkerFactory)
    const reopened = show('first **body**', unused)
    expect(unused).not.toHaveBeenCalled()
    expect(screen.getByText('body').tagName).toBe('STRONG')
    expect(document.activeElement).toBe(document.body)
    reopened.unmount()
  })

  it('drops the choice at an account boundary', () => {
    const first = manualWorkers()
    const view = show(BODY, first.factory)
    runOutOfTime(first.made[0])
    fireEvent.click(formatAnywayButton() as HTMLElement)
    expect(screen.getByText('normal')).toBeInTheDocument()
    view.unmount()

    bumpAccountEpoch()
    const second = manualWorkers()
    const again = show(BODY, second.factory)
    expect(second.made).toHaveLength(1)
    expect(pendingBox(again.container)).not.toBeNull()
    runOutOfTime(second.made[0])
    expect(plainText(again.container)?.textContent).toBe(BODY)
    expect(formatAnywayButton()).not.toBeNull()
  })

  it('does not format on a choice made after an account boundary', () => {
    const { made, factory } = manualWorkers()
    const view = show(BODY, factory)
    runOutOfTime(made[0])

    bumpAccountEpoch()
    fireEvent.click(formatAnywayButton() as HTMLElement)
    expect(view.container.querySelector('strong')).toBeNull()
    expect(plainText(view.container)?.textContent).toBe(BODY)
    expect(notePreviewFormatAnyway(BODY)).toBe('none')
  })
})
