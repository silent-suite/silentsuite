'use client'

import { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { useTranslations } from 'next-intl'

/**
 * Note bodies are untrusted input. react-markdown's defaults do the heavy
 * lifting: raw HTML is never turned into DOM nodes (it is shown as text) and
 * `javascript:` / `data:` URLs are stripped from links and images. No plugins.
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
      a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
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
  return <ReactMarkdown components={components}>{content}</ReactMarkdown>
}
