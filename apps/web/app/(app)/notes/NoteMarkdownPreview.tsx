'use client'

import { Component, useMemo, type CSSProperties, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslations } from 'next-intl'

// The Notes Markdown profile (docs/contributing/notes-markdown.md) allows
// links to http://, https:// and mailto: only. The check is on the target as
// the parser hands it over (entities already decoded, and percent-encoded where
// a character cannot appear in a URL), without decoding percent escapes:
// `https%3A//x` is a relative URL to the browser, so it stays dead. An http or
// https target needs the `//`: a browser resolves `https:/x` and `https:x`
// against the page's own address, a link back into the app.
const ALLOWED_LINK_TARGET = /^(?:https?:\/\/|mailto:)/i

function allowedLinkTarget(url: string): string {
  return ALLOWED_LINK_TARGET.test(url) ? url : ''
}

// The profile takes three GFM extensions: tables, task list items and
// strikethrough. remark-gfm also turns on literal autolinks (a bare
// `https://...`, `www.` or email address becomes a link) and footnotes, which
// the profile leaves out. Their parser constructs are turned off by name, so the
// text parses as plain CommonMark would, as on every other client.
//
// remark-gfm also searches all text again after parsing and makes links of the
// bare addresses it finds. That search restarts one character after each address
// it rejects, so `www._www._...` takes time that grows with the square of its
// length (4.8 to 7.5 s for 100 KB in the Notes tests), and nothing throws to show
// plain text instead. Its transform is therefore removed. As a backstop, a link
// with no source position (only that search makes them; every link written in
// Markdown has one) is put back as its text.
const CONSTRUCTS_OUTSIDE_PROFILE = [
  'wwwAutolink',
  'protocolAutolink',
  'emailAutolink',
  'gfmFootnoteDefinition',
  'gfmFootnoteCall',
  'gfmPotentialFootnoteCall',
]

// The renderer pads every row of a table to the width of its delimiter row, and in
// GFM every line after that row, up to a blank line or another block, is a row. A
// table's cells are therefore columns times rows, while the note grows only with
// their sum: `|a` repeated 500 times, a delimiter row and 2,000 short lines (about
// 6 KB) make about 1,000,000 cells and 5.7 to 5.9 s, and nothing throws. Past this many cells
// over all tables, the parse result is refused and the body is shown as plain text,
// as for a body that nests too deep. The count is made on the parsed tree from the
// widths and row counts, before any cell is built. 10,000 cells is 100 rows of 100
// columns or 500 rows of 20, more than a note holds in practice. Tables at the
// budget render in 0.17 to 0.58 s (server render, Node 22, five runs for each of
// eight shapes; one column of 10,000 rows is the slowest); one over it is refused
// in 0.19 to 0.27 s.
const MAX_TABLE_CELLS = 10000

class TooManyTableCells extends RangeError {
  constructor() {
    // The message names no note text: React may log it.
    super('Tables in the note hold too many cells')
  }
}

interface MarkdownNode {
  type: string
  position?: unknown
  children?: MarkdownNode[]
  align?: unknown[]
}

interface FromMarkdownExtension {
  enter?: object
  transforms?: unknown[]
}

// The literal-autolink extension is the one that handles `literalAutolink` tokens.
function withoutAddressSearch(extension: unknown): unknown {
  const candidate = extension as FromMarkdownExtension | null
  return typeof candidate === 'object' && candidate !== null && candidate.enter && 'literalAutolink' in candidate.enter
    ? { ...candidate, transforms: [] }
    : extension
}

export function remarkNotesProfile(this: { data(): object }) {
  const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] }
  data.micromarkExtensions = [...(data.micromarkExtensions ?? []), { disable: { null: CONSTRUCTS_OUTSIDE_PROFILE } }]
  data.fromMarkdownExtensions = (data.fromMarkdownExtensions ?? []).flat(Infinity).map(withoutAddressSearch)
  return (tree: MarkdownNode) => {
    const pending = [tree]
    let tableCells = 0
    for (let node = pending.pop(); node; node = pending.pop()) {
      if (!node.children) continue
      if (node.type === 'table') {
        // The width mdast-util-to-hast pads each row to: the delimiter row's, or
        // the row's own cells when there is none.
        for (const row of node.children) tableCells += node.align ? node.align.length : (row.children?.length ?? 0)
        if (tableCells > MAX_TABLE_CELLS) throw new TooManyTableCells()
      }
      node.children = node.children.flatMap((child) =>
        child.type === 'link' && !child.position ? (child.children ?? []) : [child],
      )
      for (const child of node.children) pending.push(child)
    }
  }
}

const REMARK_PLUGINS: Options['remarkPlugins'] = [remarkGfm, remarkNotesProfile]

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
export function NoteMarkdownPreview({ content }: { content: string }) {
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
  return (
    <PlainTextOnFailure content={content}>
      <ReactMarkdown components={components} remarkPlugins={REMARK_PLUGINS} urlTransform={allowedLinkTarget}>
        {content}
      </ReactMarkdown>
    </PlainTextOnFailure>
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
 * the plugin, before any cell is built.
 */
class PlainTextOnFailure extends Component<
  { content: string; children: ReactNode },
  { content: string; failed: boolean }
> {
  state = { content: this.props.content, failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: { content: string }, state: { content: string }) {
    return props.content === state.content ? null : { content: props.content, failed: false }
  }

  render() {
    return this.state.failed ? <PlainText content={this.props.content} /> : this.props.children
  }
}

// A React text child: nothing in the body is parsed or turned into markup.
function PlainText({ content }: { content: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words" data-note-preview="plain-text">
      {content}
    </pre>
  )
}
