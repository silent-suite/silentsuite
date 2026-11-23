import type { ReactNode } from 'react'
import Markdown from 'react-markdown'
import { allowedLinkTarget, REMARK_PLUGINS } from './note-markdown-profile'

// The preview parses a note body on the page's main thread, and one parse call
// cannot be interrupted. So a worker runs the same parse first (this function,
// with the same plugins and link rule the page uses) and the page renders
// Markdown only when the worker answered in time with a tree of bounded size.

/** The longest the parse may take, from the moment the worker is asked. */
export const PARSE_BUDGET_MS = 250

/** The most React elements a note may produce and still be formatted. */
export const MAX_ELEMENTS = 20000

/** How long a new worker may take to load before the body is shown as plain text. */
export const WORKER_START_LIMIT_MS = 5000

export interface ProbeRequest {
  id: number
  content: string
}

export type ProbeMessage = { type: 'ready' } | { type: 'result'; id: number; ok: boolean; elements: number }

export interface ProbeResult {
  ok: boolean
  elements: number
}

/**
 * Counts the React elements under `root` without recursion (the tree can be
 * deeper than the stack), and stops one past `limit`.
 */
export function countElements(root: ReactNode, limit: number): number {
  let count = 0
  const pending: unknown[] = [root]
  // An element with no children pushes undefined, so the loop runs on length, not on the value.
  while (pending.length > 0) {
    const item = pending.pop()
    if (Array.isArray(item)) {
      for (const child of item) pending.push(child)
    } else if (typeof item === 'object' && item !== null && 'props' in item) {
      count += 1
      if (count > limit) return count
      pending.push((item as { props: { children?: unknown } }).props.children)
    }
  }
  return count
}

/** The React tree for a body as the page would build it, with the page's plugins and link rule. */
export function parseNoteMarkdown(content: string): ReactNode {
  return Markdown({ children: content, remarkPlugins: REMARK_PLUGINS, urlTransform: allowedLinkTarget })
}

/**
 * Parses and builds the React tree for a body exactly as the page would (the
 * `Markdown` function of react-markdown has no hooks) and counts its elements.
 * A throw (a stack overflow on a deeply nested body) answers `ok: false`. The
 * error is dropped without being read: its message could quote note text, and
 * nothing here logs or reports a body.
 */
export function probeNoteMarkdown(content: string): ProbeResult {
  try {
    return { ok: true, elements: countElements(parseNoteMarkdown(content), MAX_ELEMENTS) }
  } catch {
    return { ok: false, elements: 0 }
  }
}
