'use client'

import { Component, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { useTranslations } from 'next-intl'
import { createProbeClient, type ProbeClient, type ProbeVerdict, type ProbeWorker, type ProbeWorkerFactory } from './note-markdown-probe-client'
import { allowedLinkTarget, REMARK_PLUGINS } from './note-markdown-profile'
import { getAccountEpoch } from '@/app/lib/account-epoch'
import {
  markNotePreviewFormatAnywayFailed,
  notePreviewFormatAnyway,
  notePreviewWasOk,
  rememberNotePreviewFormatAnyway,
  rememberNotePreviewOk,
} from '@/app/lib/note-preview-verdict'

// GFM table alignment arrives as an inline style; the profile allows no style
// attribute, so it becomes a class.
function cellClass(style: CSSProperties | undefined, header = false): string {
  const base = header
    ? 'border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-2 py-1 align-top font-semibold'
    : 'border border-[rgb(var(--border))] px-2 py-1 align-top'
  switch (style?.textAlign) {
    case 'center':
      return `${base} text-center`
    case 'right':
      return `${base} text-right`
    default:
      return `${base} text-left`
  }
}

function taskListRole(className: string | undefined): 'list' | undefined {
  return className?.split(' ').includes('contains-task-list') ? 'list' : undefined
}

const TABLE_SCROLL_CLASS =
  'mb-2 max-w-full overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[rgb(var(--primary))]'

const FORMAT_ANYWAY_CLASS =
  'touch-target rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-3 text-sm text-[rgb(var(--foreground))] transition-colors hover:bg-[rgb(var(--surface))] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500'

const TASK_BOX ='relative mr-1.5 inline-block h-3.5 w-3.5 rounded-sm border align-[-0.125em]'
const TASK_BOX_CLASS = `${TASK_BOX} border-[rgb(var(--muted))]`
const TASK_BOX_CHECKED_CLASS = `${TASK_BOX} border-emerald-600 bg-emerald-600 after:absolute after:left-[4px] after:top-[1px] after:h-2 after:w-1 after:rotate-45 after:border-b-2 after:border-r-2 after:border-white after:content-['']`

// The Markdown parser takes time quadratic in how deeply a body nests lists and
// quotes: measured in Node 22, 15 s for 10,000 `- ` markers on one line (20 KB)
// and 92 s for 20,000 (40 KB), and the same again for a body that nests by
// indentation over many lines. It overflows the stack at a few thousand levels.
// A body with a line that looks deeper than 100 levels is therefore shown as
// plain text instead of being parsed. A line's level is its container markers
// (`>`, or a bullet or number followed by a space or tab) plus half the
// whitespace that is not a marker's single separator, since a nested item sits
// at least two columns inside its parent. A tab counts as four columns, and a
// leading U+FEFF is skipped because the parser skips it.
const MAX_NESTING_LEVELS = 100
const LINE_END = /\r\n|\r|\n/g
const isBlank = (code: number) => code === 32 || code === 9
const isDigit = (code: number) => code >= 48 && code <= 57

function nestsTooDeep(content: string): boolean {
  const length = content.length
  let index = content.charCodeAt(0) === 0xfeff ? 1 : 0
  while (index <= length) {
    let levels = 0
    let extraColumns = 0
    let afterMarker = false
    for (;;) {
      let run = 0
      while (index < length && isBlank(content.charCodeAt(index))) {
        run += content.charCodeAt(index) === 9 ? 4 : 1
        index += 1
      }
      extraColumns += afterMarker ? Math.max(0, run - 1) : run
      const code = index < length ? content.charCodeAt(index) : -1
      let markerEnd = -1
      if (code === 62) {
        markerEnd = index + 1
      } else if (code === 45 || code === 42 || code === 43) {
        if (index + 1 < length && isBlank(content.charCodeAt(index + 1))) markerEnd = index + 1
      } else if (isDigit(code)) {
        let digitsEnd = index
        while (digitsEnd < length && digitsEnd - index < 9 && isDigit(content.charCodeAt(digitsEnd))) digitsEnd += 1
        const delimiter = digitsEnd < length ? content.charCodeAt(digitsEnd) : -1
        if ((delimiter === 46 || delimiter === 41) && digitsEnd + 1 < length && isBlank(content.charCodeAt(digitsEnd + 1))) {
          markerEnd = digitsEnd + 1
        }
      }
      if (markerEnd < 0) break
      levels += 1
      index = markerEnd
      afterMarker = true
      if (levels + (extraColumns >> 1) > MAX_NESTING_LEVELS) return true
    }
    if (levels + (extraColumns >> 1) > MAX_NESTING_LEVELS) return true
    LINE_END.lastIndex = index
    const found = LINE_END.exec(content)
    if (!found) return false
    index = found.index + found[0].length
  }
  return false
}

/**
 * Note bodies are untrusted input. Raw HTML is never turned into DOM nodes
 * (react-markdown shows it as text), and `urlTransform` below drops every link
 * target except http://, https:// and mailto:, where react-markdown's own default would
 * also keep irc, ircs, xmpp and every relative URL. A link left with no target
 * renders as its text, so no `href=""` link back into the app remains. The only
 * plugins are remark-gfm and `remarkNotesProfile`, which narrows it to the profile.
 *
 * A task list checkbox is a picture (a `span`, hidden from assistive technology)
 * plus visually hidden state text, not an `<input>`: the preview holds no form
 * control, so nothing in it can toggle or write the note.
 *
 * Images are never rendered as elements. A note body is private, so an
 * `![](https://tracker/pixel.png)` in one must not tell a remote host that the
 * note was opened — no `<img>` reaches the DOM at all, in hosted and
 * self-hosted builds alike, and there is no click-to-load path around it.
 */
export function NoteMarkdownPreview({
  content,
  createWorker = createNoteMarkdownWorker,
}: {
  content: string
  /** Makes the time-budget worker; tests pass a stand-in, since jsdom has no Worker. */
  createWorker?: ProbeWorkerFactory
}) {
  const t = useTranslations('Notes')
  const components = useMemo<Components>(
    () => ({
      // Links open in a new tab so a note can never navigate the app away.
      a: ({ node: _node, href, children, ...props }) =>
        href ? (
          <a {...props} href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ) : (
          <>{children}</>
        ),
      // The alt text is placed as a React text child, so any markup inside it
      // stays inert escaped text; the URL is dropped rather than shown.
      img: ({ node: _node, alt }) => {
        const label = (alt ?? '').trim()
        return (
          <span className="italic text-[rgb(var(--muted))]" data-note-image="blocked">
            {label ? t('imageBlockedWithAlt', { alt: label }) : t('imageBlocked')}
          </span>
        )
      },
      // Only a task list item produces an input: raw HTML never becomes an element.
      // The box is a picture. Its state is visually hidden text read just before
      // the item's own text ("Not checked, buy milk"), so each item is told apart
      // without putting note text into an attribute.
      input: ({ checked }) => (
        <>
          <span
            aria-hidden="true"
            data-task={checked === true ? 'checked' : 'unchecked'}
            className={checked === true ? TASK_BOX_CHECKED_CLASS : TASK_BOX_CLASS}
          />
          <span className="sr-only select-none">{`${checked === true ? t('taskChecked') : t('taskNotChecked')},`}</span>
        </>
      ),
      // A list whose items show no marker is not announced as a list by WebKit
      // unless it says so, so a task list says it.
      ul: ({ node: _node, className, children }) => <ul className={className} role={taskListRole(className)}>{children}</ul>,
      ol: ({ node: _node, className, children, start }) => (
        <ol className={className} role={taskListRole(className)} start={start}>
          {children}
        </ol>
      ),
      li: ({ className, children }) => (
        <li className={className?.split(' ').includes('task-list-item') ? 'list-none' : undefined}>{children}</li>
      ),
      // A wide table scrolls sideways in its own box instead of widening the preview.
      // The box is focusable and named so the keyboard can scroll it: a scroll box
      // with nothing focusable inside cannot be reached otherwise in every browser.
      // The name is one fixed string, since the profile allows no note text in an
      // attribute. The focus outline is drawn inside the box, because the global
      // one sits outside it and an ancestor's scroll area can clip that.
      table: ({ children }) => (
        <div
          role="region"
          aria-label={t('tableScroll')}
          tabIndex={0}
          className={TABLE_SCROLL_CLASS}
        >
          <table className="border-collapse">{children}</table>
        </div>
      ),
      th: ({ style, children }) => (
        <th scope="col" className={cellClass(style, true)}>
          {children}
        </th>
      ),
      td: ({ style, children }) => <td className={cellClass(style)}>{children}</td>,
    }),
    [t],
  )
  if (!content.trim()) {
    return <p className="text-[rgb(var(--muted))]">{t('nothingToPreview')}</p>
  }
  if (nestsTooDeep(content)) return <PlainText content={content} />
  return <TimedMarkdown content={content} components={components} createWorker={createWorker} />
}

// The page's one Web Worker. It runs the same parse as the page (see
// note-markdown-probe.ts); the constructor call is spelled out here because the
// bundler finds the worker file from this exact form. It throws where Workers
// are missing or blocked, and the client then shows plain text.
function createNoteMarkdownWorker(): ProbeWorker {
  // Typed as the few members the client uses, which a Worker has with wider event types.
  return new Worker(new URL('./note-markdown-probe.worker.ts', import.meta.url)) as unknown as ProbeWorker
}

interface ProbeState {
  verdict: ProbeVerdict | 'pending'
  /** `getAccountEpoch()` as read when the body was sent; null when no answer is held for it. */
  epoch: number | null
}

// `skip`: the reader already chose Format anyway for this body (or its forced
// parse failed), so it is not timed again.
function useProbeVerdict(content: string, createWorker: ProbeWorkerFactory, skip: boolean): ProbeState {
  const [result, setResult] = useState<{ content: string; verdict: ProbeVerdict; epoch: number } | null>(null)
  const client = useRef<ProbeClient | null>(null)
  useEffect(
    () => () => {
      client.current?.dispose()
      client.current = null
    },
    [],
  )
  useEffect(() => {
    if (skip || notePreviewWasOk(content)) return undefined
    client.current ??= createProbeClient(createWorker)
    // Read before the body is sent: an answer after an account boundary is not kept.
    const epoch = getAccountEpoch()
    // The client drops an answer for any body but the latest, and withdrawing
    // here ends a worker still busy with a body that was replaced.
    return client.current.probe(content, (verdict) => {
      if (verdict === 'ok') rememberNotePreviewOk(content, epoch)
      setResult({ content, verdict, epoch })
    })
  }, [content, createWorker, skip])
  // The last body that parsed in time shows at once; see note-preview-verdict.ts.
  if (notePreviewWasOk(content)) return { verdict: 'ok', epoch: null }
  return result?.content === content ? result : { verdict: 'pending', epoch: null }
}

// Formatted only after the worker answered ok for exactly this body. While it
// waits (at most the time budget once the worker has loaded) the box is empty
// and marked busy, so a normal note does not flash as plain text first.
//
// When only time, size or the worker itself stood in the way (`plain`), the
// plain text offers Format anyway, which parses this body on the page with the
// same guards as the ok path: the nesting guard runs before this component, the
// cell budget runs in the plugin, and PlainTextOnFailure catches a parse that
// throws. A body the worker could not parse (`unparsable`) gets no button. The
// choice holds for this exact body (note-preview-verdict.ts).
function TimedMarkdown({
  content,
  components,
  createWorker,
}: {
  content: string
  components: Components
  createWorker: ProbeWorkerFactory
}) {
  // The choice lives outside React, so choosing re-renders through this counter.
  const [, setChoices] = useState(0)
  // The body whose Format anyway was just chosen, so its formatted box takes focus once.
  const focusOnFormat = useRef<string | null>(null)
  const choice = notePreviewFormatAnyway(content)
  const { verdict, epoch } = useProbeVerdict(content, createWorker, choice !== 'none')
  if (choice !== 'none') {
    return (
      <FormattedAnyway
        content={content}
        components={components}
        failed={choice === 'failed'}
        focusOnFormat={focusOnFormat}
      />
    )
  }
  if (verdict === 'pending') return <div aria-busy="true" data-note-preview="pending" />
  if (verdict === 'unparsable') return <PlainText content={content} />
  if (verdict === 'plain') {
    const formatAnyway = () => {
      if (epoch === null || !rememberNotePreviewFormatAnyway(content, epoch)) return
      focusOnFormat.current = content
      setChoices((count) => count + 1)
    }
    return <PlainText content={content} onFormatAnyway={formatAnyway} />
  }
  return (
    <PlainTextOnFailure content={content}>
      <ReactMarkdown components={components} remarkPlugins={REMARK_PLUGINS} urlTransform={allowedLinkTarget}>
        {content}
      </ReactMarkdown>
    </PlainTextOnFailure>
  )
}

// The body the reader chose to format anyway. The box takes focus when it was
// just chosen, since the button that had focus is gone; shown again later, it
// leaves focus where it is. A failed parse is recorded, so the body is not
// parsed again and the button is not offered for it again. The recorded
// failure renders as plain text inside the same box, so a later render of the
// preview keeps the box, and the focus in it.
function FormattedAnyway({
  content,
  components,
  failed,
  focusOnFormat,
}: {
  content: string
  components: Components
  failed: boolean
  focusOnFormat: { current: string | null }
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focusOnFormat.current !== content) return
    focusOnFormat.current = null
    box.current?.focus()
  }, [content, focusOnFormat])
  return (
    <div ref={box} tabIndex={-1} className="outline-none" data-note-preview="format-anyway">
      {failed ? (
        <PlainText content={content} />
      ) : (
        <PlainTextOnFailure content={content} onFailure={markNotePreviewFormatAnywayFailed}>
          <ReactMarkdown components={components} remarkPlugins={REMARK_PLUGINS} urlTransform={allowedLinkTarget}>
            {content}
          </ReactMarkdown>
        </PlainTextOnFailure>
      )}
    </div>
  )
}

/**
 * The Markdown parser walks nested lists recursively, so a body nested a few
 * thousand levels deep overflows the stack while rendering. Without this
 * boundary that error would replace the whole Notes page with the app error
 * screen, for every member of a shared notebook who opens the note. The body is
 * shown as plain text instead (a React text child, so nothing in it is parsed),
 * and this code reports nothing, since an error report must never carry note
 * text. React itself may log or report the RangeError, which names no note text.
 * A later body gets a fresh try. The table cell budget fails the same way, from
 * the plugin, before any cell is built. `onFailure` gets the body, never the error.
 */
class PlainTextOnFailure extends Component<
  { content: string; children: ReactNode; onFailure?: (content: string) => void },
  { content: string; failed: boolean }
> {
  state = { content: this.props.content, failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: { content: string }, state: { content: string }) {
    return props.content === state.content ? null : { content: props.content, failed: false }
  }

  componentDidCatch() {
    this.props.onFailure?.(this.props.content)
  }

  render() {
    return this.state.failed ? <PlainText content={this.props.content} /> : this.props.children
  }
}

// A React text child: nothing in the body is parsed or turned into markup. One
// line above it says why the note is not formatted, whatever the reason: nested
// too deep, too slow or too large to format, a parse error, or no worker. Only
// for too slow, too large or no worker is `onFormatAnyway` given, with a button
// and a line that says the tab may stop responding.
function PlainText({ content, onFormatAnyway }: { content: string; onFormatAnyway?: () => void }) {
  const t = useTranslations('Notes')
  const hintId = useId()
  return (
    <>
      <p className="mb-2 text-sm text-[rgb(var(--muted))]">{t('plainTextNotice')}</p>
      {onFormatAnyway && (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <button type="button" onClick={onFormatAnyway} aria-describedby={hintId} className={FORMAT_ANYWAY_CLASS}>
            {t('formatAnyway')}
          </button>
          <span id={hintId} className="text-xs text-[rgb(var(--muted))]">
            {t('formatAnywayHint')}
          </span>
        </div>
      )}
      <pre className="whitespace-pre-wrap break-words" data-note-preview="plain-text">
        {content}
      </pre>
    </>
  )
}
