import type { ProbeRequest, ProbeMessage } from '../note-markdown-probe'
import type { ProbeWorker, ProbeWorkerFactory } from '../note-markdown-probe-client'

// Stand-ins for the time-budget worker (jsdom has no Worker).

/** A worker that is ready as soon as the page listens and answers ok at once. */
export class OkWorker implements ProbeWorker {
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
    this.handler?.({ data: { type: 'result', id: request.id, ok: true, elements: 1 } satisfies ProbeMessage })
  }

  terminate() {
    this.terminated = true
  }
}

export const okWorkerFactory: ProbeWorkerFactory = () => new OkWorker()

/** A worker the test drives by hand. */
export class ManualWorker implements ProbeWorker {
  onmessage: ProbeWorker['onmessage'] = null
  onerror: ProbeWorker['onerror'] = null
  onmessageerror: ProbeWorker['onmessageerror'] = null
  requests: ProbeRequest[] = []
  terminated = false

  postMessage(request: ProbeRequest) {
    this.requests.push(request)
  }

  terminate() {
    this.terminated = true
  }

  /** Delivers a message the way the browser does, to whoever is listening now. */
  emit(data: unknown) {
    this.onmessage?.({ data })
  }

  ready() {
    this.emit({ type: 'ready' } satisfies ProbeMessage)
  }

  answer(request: ProbeRequest | undefined, ok = true, elements = 10) {
    this.emit({ type: 'result', id: request?.id ?? -1, ok, elements } satisfies ProbeMessage)
  }
}

/** A factory that hands out ManualWorkers and remembers each one. */
export function manualWorkers() {
  const made: ManualWorker[] = []
  const factory: ProbeWorkerFactory = () => {
    const worker = new ManualWorker()
    made.push(worker)
    return worker
  }
  return { made, factory }
}
