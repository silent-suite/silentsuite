'use client'

import { Component, useMemo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
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
 * renders as its text, so no `href=""` link back into the app remains. No plugins.
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
    }),
    [t],
  )
  if (!content.trim()) {
    return <p className="text-[rgb(var(--muted))]">{t('nothingToPreview')}</p>
  }
  if (nestsTooDeep(content)) return <PlainText content={content} />
  return (
    <PlainTextOnFailure content={content}>
      <ReactMarkdown components={components} urlTransform={allowedLinkTarget}>
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
 * A later body gets a fresh try.
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
