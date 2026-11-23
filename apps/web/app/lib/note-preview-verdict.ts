import { getAccountEpoch } from './account-epoch'

// The Notes preview parses a body in a worker before it renders (see
// app/(app)/notes/NoteMarkdownPreview.tsx). This remembers the one body whose
// parse came back in time, so opening Preview again on it shows it at once.
//
// The body is decrypted note text, so the entry belongs to the account that was
// signed in when it was made: a later account boundary (sign-out, sign-in, a
// switch) ends it, and the account reset drops it (resetNoteLifecycle). The epoch
// is the one read when the body was sent for parsing, not when the answer came
// back: an answer that arrives after a boundary is not remembered at all. Only
// the last body is kept, and only an ok verdict: a timeout is never remembered.
//
// The reader can also choose to format a body that was not cleared in time
// (Format anyway). That choice holds decrypted text too and is kept the same
// way: in memory only, for the last body chosen, under the epoch read when the
// body was sent for parsing, ended by an account boundary and dropped by the
// account reset. The last body whose forced parse then failed is kept apart, so
// the page neither parses it again nor offers the button for it again.

let lastOk: { content: string; epoch: number } | null = null
let formatAnyway: { content: string; epoch: number } | null = null
let formatAnywayFailed: { content: string; epoch: number } | null = null

/** `epoch` is `getAccountEpoch()` as read when the body was sent to be parsed. */
export function rememberNotePreviewOk(content: string, epoch: number): void {
  if (epoch !== getAccountEpoch()) return
  lastOk = { content, epoch }
}

export function notePreviewWasOk(content: string): boolean {
  if (lastOk && lastOk.epoch !== getAccountEpoch()) lastOk = null
  return lastOk !== null && lastOk.content === content
}

/** `none`: no choice for this body. `chosen`: format it on the page. `failed`: its forced parse failed. */
export type FormatAnywayChoice = 'none' | 'chosen' | 'failed'

/**
 * Records the reader's choice to format `content` although it was not cleared
 * in time. `epoch` is `getAccountEpoch()` as read when the body was sent to be
 * parsed; a choice across an account boundary is refused and returns false.
 */
export function rememberNotePreviewFormatAnyway(content: string, epoch: number): boolean {
  if (epoch !== getAccountEpoch()) return false
  formatAnyway = { content, epoch }
  return true
}

/** The page's parse of the chosen body failed. Any other body is ignored. */
export function markNotePreviewFormatAnywayFailed(content: string): void {
  if (!formatAnyway || formatAnyway.content !== content || formatAnyway.epoch !== getAccountEpoch()) return
  formatAnywayFailed = formatAnyway
  formatAnyway = null
}

export function notePreviewFormatAnyway(content: string): FormatAnywayChoice {
  const epoch = getAccountEpoch()
  if (formatAnyway && formatAnyway.epoch !== epoch) formatAnyway = null
  if (formatAnywayFailed && formatAnywayFailed.epoch !== epoch) formatAnywayFailed = null
  if (formatAnywayFailed?.content === content) return 'failed'
  return formatAnyway?.content === content ? 'chosen' : 'none'
}

export function clearNotePreviewVerdict(): void {
  lastOk = null
  formatAnyway = null
  formatAnywayFailed = null
}
