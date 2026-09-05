import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { NoteMarkdownPreview } from '../NoteMarkdownPreview'

const HOSTILE_NOTE = [
  '# Heading',
  '',
  '<script>window.__note_xss = true</script>',
  '',
  '<img src=x onerror="window.__note_xss = true">',
  '',
  '<svg onload="window.__note_xss = true"></svg>',
  '',
  '<iframe src="javascript:window.__note_xss = true"></iframe>',
  '',
  '<a href="javascript:window.__note_xss = true">raw anchor</a>',
  '',
  '[click me](javascript:alert%281%29)',
  '',
  '[data link](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '',
  '![evil image](javascript:alert(1))',
  '',
  '[VBScript](vbscript:msgbox)',
  '',
  '[safe](https://example.com/page)',
].join('\n')

describe('NoteMarkdownPreview', () => {
  it('never turns raw HTML into DOM nodes and strips dangerous URL schemes', () => {
    const view = renderWithIntl(<NoteMarkdownPreview content={HOSTILE_NOTE} />)

    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument()
    for (const tag of ['script', 'svg', 'iframe']) {
      expect(view.container.querySelector(tag)).toBeNull()
    }
    expect(view.container.querySelector('[onerror], [onload]')).toBeNull()
    // The Markdown image survives as an element, but its javascript: source is gone.
    for (const image of Array.from(view.container.querySelectorAll('img'))) {
      expect(image.getAttribute('src') ?? '').toBe('')
    }
    // Raw HTML is displayed as escaped text instead.
    expect(view.container.textContent).toContain('<script>window.__note_xss = true</script>')
    expect(view.container.textContent).toContain('<img src=x onerror="window.__note_xss = true">')

    for (const anchor of Array.from(view.container.querySelectorAll('a'))) {
      const href = anchor.getAttribute('href') ?? ''
      expect(href).not.toMatch(/^(javascript|data|vbscript):/i)
    }
    expect((window as { __note_xss?: boolean }).__note_xss).toBeUndefined()
  })

  it('opens safe links in a new tab without a window opener', () => {
    renderWithIntl(<NoteMarkdownPreview content="[docs](https://example.com/docs)" />)
    const link = screen.getByRole('link', { name: 'docs' })
    expect(link).toHaveAttribute('href', 'https://example.com/docs')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders basic Markdown: emphasis, lists, code blocks, quotes, and plain text', () => {
    const view = renderWithIntl(
      <NoteMarkdownPreview content={'Some **bold** and `code`\n\n- one\n- two\n\n1. first\n\n```js\nconst x = 1\n```\n\n> quoted\n\nPlain paragraph.'} />,
    )
    expect(view.container.querySelector('strong')).toHaveTextContent('bold')
    expect(view.container.querySelectorAll('ul > li')).toHaveLength(2)
    expect(view.container.querySelectorAll('ol > li')).toHaveLength(1)
    expect(view.container.querySelector('pre > code')).toHaveTextContent('const x = 1')
    expect(view.container.querySelector('blockquote')).toHaveTextContent('quoted')
    expect(screen.getByText('Plain paragraph.')).toBeInTheDocument()
  })

  it('tolerates malformed Markdown', () => {
    const view = renderWithIntl(<NoteMarkdownPreview content={'**unclosed\n\n[link](\n\n#\n\n```\nno closing fence'} />)
    expect(view.container.textContent).toContain('**unclosed')
    expect(view.container.textContent).toContain('no closing fence')
  })

  it('shows a localized empty-preview message', () => {
    renderWithIntl(<NoteMarkdownPreview content="   " />)
    expect(screen.getByText('Nothing to preview yet.')).toBeInTheDocument()
  })
})
