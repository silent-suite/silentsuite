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

// Anything that can make the browser issue a request on its own.
const REQUEST_CAPABLE = 'img, picture, source, iframe, object, embed, video, audio, link, svg, image, track'

const IMAGE_URLS = [
  ['https', 'https://tracker.example/pixel.png'],
  ['http', 'http://tracker.example/pixel.png'],
  ['protocol-relative', '//tracker.example/pixel.png'],
  ['root-relative', '/tracker.example/pixel.png'],
  ['relative', 'tracker.example/pixel.png'],
]

describe('NoteMarkdownPreview', () => {
  it.each(IMAGE_URLS)('never fetches a %s image in a note', (_kind, url) => {
    const view = renderWithIntl(<NoteMarkdownPreview content={`![beacon](${url})`} />)

    expect(view.container.querySelector(REQUEST_CAPABLE)).toBeNull()
    expect(view.container.innerHTML).not.toContain('tracker.example')
    expect(view.container.textContent).toContain('beacon')
  })

  it('blocks reference-style and title-carrying images too', () => {
    const view = renderWithIntl(
      <NoteMarkdownPreview
        content={'![ref image][beacon]\n\n![titled](https://tracker.example/b.png "hover")\n\n[beacon]: https://tracker.example/ref.png'}
      />,
    )

    expect(view.container.querySelector(REQUEST_CAPABLE)).toBeNull()
    expect(view.container.innerHTML).not.toContain('tracker.example')
  })

  it('shows blocked-image alt text as escaped text, never as markup', () => {
    const view = renderWithIntl(
      <NoteMarkdownPreview content={'![<img src=x onerror="window.__note_xss = true">](https://tracker.example/c.png)'} />,
    )

    expect(view.container.querySelector(REQUEST_CAPABLE)).toBeNull()
    expect(view.container.querySelector('[onerror], [onload]')).toBeNull()
    expect(view.container.textContent).toContain('onerror="window.__note_xss = true"')
    expect((window as { __note_xss?: boolean }).__note_xss).toBeUndefined()
  })

  it('uses a localized placeholder for an image with no alt text', () => {
    const view = renderWithIntl(<NoteMarkdownPreview content="![](https://tracker.example/d.png)" />)

    expect(view.container.querySelector(REQUEST_CAPABLE)).toBeNull()
    expect(screen.getByText('Image not shown')).toBeInTheDocument()
  })

  it('never turns raw HTML into DOM nodes and strips dangerous URL schemes', () => {
    const view = renderWithIntl(<NoteMarkdownPreview content={HOSTILE_NOTE} />)

    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument()
    for (const tag of ['script', 'svg', 'iframe']) {
      expect(view.container.querySelector(tag)).toBeNull()
    }
    expect(view.container.querySelector('[onerror], [onload]')).toBeNull()
    // Markdown images never become elements at all, so no source can be fetched.
    expect(view.container.querySelector('img')).toBeNull()
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

  it('parses a line that opens 100 containers and shows 101 as plain text', () => {
    const ok = renderWithIntl(<NoteMarkdownPreview content={`${'- '.repeat(100)}deep`} />)
    expect(ok.container.querySelector('ul ul')).not.toBeNull()
    expect(ok.container.querySelector('[data-note-preview="plain-text"]')).toBeNull()
    ok.unmount()

    const over = renderWithIntl(<NoteMarkdownPreview content={`${'> '.repeat(101)}deep`} />)
    expect(over.container.querySelector('blockquote')).toBeNull()
    expect(over.container.querySelector('[data-note-preview="plain-text"]')).toHaveTextContent(`${'> '.repeat(101)}deep`)
  })

  it('counts nesting by indentation over many lines too', () => {
    const nested = (depth: number, eol = '\n') =>
      Array.from({ length: depth }, (_, i) => `${' '.repeat(2 * i)}- item ${i}`).join(eol)

    const ok = renderWithIntl(<NoteMarkdownPreview content={nested(100)} />)
    expect(ok.container.querySelector('[data-note-preview="plain-text"]')).toBeNull()
    expect(ok.container.querySelectorAll('li')).toHaveLength(100)
    ok.unmount()

    for (const eol of ['\n', '\r\n', '\r']) {
      const started = performance.now()
      const over = renderWithIntl(<NoteMarkdownPreview content={nested(300, eol)} />)
      expect(over.container.querySelector('[data-note-preview="plain-text"]')).not.toBeNull()
      expect(over.container.querySelector('li')).toBeNull()
      expect(performance.now() - started).toBeLessThan(2000)
      over.unmount()
    }

    const tabs = renderWithIntl(<NoteMarkdownPreview content={`${'\t'.repeat(60)}- tabbed`} />)
    expect(tabs.container.querySelector('[data-note-preview="plain-text"]')).not.toBeNull()
  })

  it('counts list markers only when a space follows, so a long rule is still a rule', () => {
    const view = renderWithIntl(<NoteMarkdownPreview content={`${'-'.repeat(300)}\n\n${'+'.repeat(300)} not a list`} />)
    expect(view.container.querySelector('[data-note-preview="plain-text"]')).toBeNull()
    expect(view.container.querySelector('hr')).not.toBeNull()
  })

  it('shows a localized empty-preview message', () => {
    renderWithIntl(<NoteMarkdownPreview content="   " />)
    expect(screen.getByText('Nothing to preview yet.')).toBeInTheDocument()
  })
})
