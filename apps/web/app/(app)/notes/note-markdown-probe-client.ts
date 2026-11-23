import { MAX_ELEMENTS, PARSE_BUDGET_MS, WORKER_START_LIMIT_MS, type ProbeRequest } from './note-markdown-probe'

/** The part of a Worker the client uses, so a test can stand in for one. */
export interface ProbeWorker {
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onmessageerror: ((event: unknown) => void) | null
  postMessage(message: ProbeRequest): void
  terminate(): void
}

export type ProbeWorkerFactory = () => ProbeWorker

/**
 * `ok` means the body parsed in time to a tree of bounded size. `unparsable`
 * means the worker's parse threw (the table cell budget, or a stack overflow),
 * which the page's own parse would do too. Everything else is `plain`: too slow,
 * too large, or no working worker.
 */
export type ProbeVerdict = 'ok' | 'plain' | 'unparsable'

export interface ProbeClient {
  /** Asks for a verdict on `content`. Returns a function that withdraws the request. */
  probe(content: string, done: (verdict: ProbeVerdict) => void): () => void
  dispose(): void
}

interface Pending {
  id: number
  content: string
  done: (verdict: ProbeVerdict) => void
  sent: boolean
  /** `performance.now()` when the request was posted; an answer is checked against it. */
  sentAt: number
  timer: ReturnType<typeof setTimeout> | undefined
}

function isReady(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'ready'
}

function isResult(data: unknown): data is { id: number; ok: boolean; elements: number } {
  const message = data as { type?: unknown; id?: unknown; ok?: unknown; elements?: unknown } | null
  return (
    typeof message === 'object' &&
    message !== null &&
    message.type === 'result' &&
    typeof message.id === 'number' &&
    typeof message.ok === 'boolean' &&
    typeof message.elements === 'number'
  )
}

/**
 * Runs the worker protocol for one preview. The worker is created on the first
 * request and kept until it fails, times out or is disposed; the next request
 * after that makes a fresh one. The time budget starts when the worker is asked,
 * after it has said it is ready, so loading its code does not count against a
 * note (that has its own, longer limit). Nothing here ever returns formatted
 * without an `ok` answer for the same request. Every failure is `plain`, except
 * a parse the worker reports as thrown, which is `unparsable`.
 * The client never logs or reports a body.
 */
export function createProbeClient(
  createWorker: ProbeWorkerFactory,
  budgetMs = PARSE_BUDGET_MS,
  startLimitMs = WORKER_START_LIMIT_MS,
  maxElements = MAX_ELEMENTS,
): ProbeClient {
  let worker: ProbeWorker | null = null
  let ready = false
  let startTimer: ReturnType<typeof setTimeout> | undefined
  let pending: Pending | null = null
  let nextId = 0

  function dropWorker() {
    clearTimeout(startTimer)
    const old = worker
    worker = null
    ready = false
    if (old) {
      old.onmessage = null
      old.onerror = null
      old.onmessageerror = null
      old.terminate()
    }
  }

  function settle(verdict: ProbeVerdict) {
    const current = pending
    if (!current) return
    pending = null
    clearTimeout(current.timer)
    current.done(verdict)
  }

  // Any failure ends the worker too: it may still be busy with the body.
  function fail() {
    dropWorker()
    settle('plain')
  }

  function send() {
    const current = pending
    if (!current || !worker || current.sent) return
    current.sent = true
    current.sentAt = performance.now()
    current.timer = setTimeout(fail, budgetMs)
    try {
      worker.postMessage({ id: current.id, content: current.content })
    } catch {
      // A body that cannot be copied to the worker is shown as plain text.
      fail()
    }
  }

  function handleMessage(event: { data: unknown }) {
    const data = event.data
    if (isReady(data)) {
      ready = true
      clearTimeout(startTimer)
      send()
      return
    }
    // An answer for a request that was withdrawn or replaced is dropped.
    if (!isResult(data) || !pending || data.id !== pending.id) return
    // The timer alone does not hold the budget: in a hidden tab, or while the
    // main thread is busy, it can fire late, and an answer may arrive between
    // the end of the budget and the timer. The elapsed time is checked here too.
    const inTime = performance.now() - pending.sentAt <= budgetMs
    // A parse that threw is not a question of time or size: the page's parse throws on it too.
    settle(!data.ok ? 'unparsable' : inTime && data.elements <= maxElements ? 'ok' : 'plain')
  }

  function start(): boolean {
    try {
      worker = createWorker()
    } catch {
      // No Worker in this browser, a policy that blocks it, or a failed load.
      worker = null
      return false
    }
    startTimer = setTimeout(fail, startLimitMs)
    // An error event that nobody cancels is raised again on the page, where the
    // page's error reporting would see a worker that merely failed to load.
    worker.onerror = (event) => {
      ;(event as { preventDefault?: () => void } | null)?.preventDefault?.()
      fail()
    }
    worker.onmessageerror = fail
    worker.onmessage = handleMessage
    return true
  }

  function withdraw(current: Pending) {
    if (pending !== current) return
    pending = null
    clearTimeout(current.timer)
    // A sent request may still be running a body that never ends.
    if (current.sent) dropWorker()
  }

  return {
    probe(content, done) {
      if (pending) withdraw(pending)
      const current: Pending = { id: (nextId += 1), content, done, sent: false, sentAt: 0, timer: undefined }
      pending = current
      if (!worker && !start()) {
        settle('plain')
      } else if (ready) {
        send()
      }
      return () => withdraw(current)
    },
    dispose() {
      if (pending) clearTimeout(pending.timer)
      pending = null
      dropWorker()
    },
  }
}
