'use client'

import { Component, useMemo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { useTranslations } from 'next-intl'

// The Notes Markdown profile (docs/contributing/notes-markdown.md) allows
// links to http, https and mailto only. The check is on the target as the
// parser hands it over (entities already decoded), without decoding percent
// escapes: `https%3A//x` is a relative URL to the browser, so it stays dead.
const ALLOWED_LINK_TARGET = /^(?:https?|mailto):/i

function allowedLinkTarget(url: string): string {
  return ALLOWED_LINK_TARGET.test(url) ? url : ''
}

// The Markdown parser takes time quadratic in the number of containers one
// line opens (`- - - - ...`): measured in Node 22, 15 s for 10,000 of them (20 KB)
// and 92 s for 20,000 (40 KB). A line that opens more than 100 list or quote
// containers is shown as plain text instead of being parsed. The
// pattern matches a line that starts with 101 container markers: `>`, or a
// bullet or number followed by a space or tab.
const OVER_NESTED_LINE = /^[ \t]*(?:(?:>|(?:[-*+]|\d{1,9}[.)])[ \t])[ \t]*){101}/m

/**
 * Note bodies are untrusted input. Raw HTML is never turned into DOM nodes
 * (react-markdown shows it as text), and `urlTransform` below drops every link
 * target except http, https and mailto, where react-markdown's own default would
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
  if (OVER_NESTED_LINE.test(content)) return <PlainText content={content} />
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
 * and nothing is reported, since an error report must never carry note text.
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
