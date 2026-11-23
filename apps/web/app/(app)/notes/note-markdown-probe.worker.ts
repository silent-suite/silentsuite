// A dedicated worker (webpack bundles it as a classic script): it holds no state and reads nothing but the request it is
// sent. It never logs, and never sends anything but a verdict and a count.
import { probeNoteMarkdown, type ProbeMessage } from './note-markdown-probe'

// The DOM library's types for `self` are the window's, so the few members used
// here are typed by hand.
const scope = self as unknown as {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: ProbeMessage): void
}

scope.onmessage = (event) => {
  const request = event.data as { id?: unknown; content?: unknown } | null
  if (typeof request?.id !== 'number' || typeof request.content !== 'string') return
  const { ok, elements } = probeNoteMarkdown(request.content)
  scope.postMessage({ type: 'result', id: request.id, ok, elements })
}

scope.postMessage({ type: 'ready' })
