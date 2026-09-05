'use client'

import ReactMarkdown, { type Components } from 'react-markdown'
import { useTranslations } from 'next-intl'

/**
 * Note bodies are untrusted input. react-markdown's defaults do the heavy
 * lifting: raw HTML is never turned into DOM nodes (it is shown as text) and
 * `javascript:` / `data:` URLs are stripped from links and images. No plugins.
 */
const components: Components = {
  // Links open in a new tab so a note can never navigate the app away.
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
}

export function NoteMarkdownPreview({ content }: { content: string }) {
  const t = useTranslations('Notes')
  if (!content.trim()) {
    return <p className="text-[rgb(var(--muted))]">{t('nothingToPreview')}</p>
  }
  return <ReactMarkdown components={components}>{content}</ReactMarkdown>
}
