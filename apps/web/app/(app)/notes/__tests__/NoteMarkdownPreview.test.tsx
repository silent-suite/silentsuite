import { fireEvent, screen } from '@testing-library/react'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { NoteMarkdownPreview, remarkNotesProfile } from '../NoteMarkdownPreview'

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

  it('reads each task list item with its own state, and the box itself is only a picture', () => {
    const view = renderWithIntl(<NoteMarkdownPreview content={'- [x] done\n- [ ] todo\n\n1. [ ] first'} />)

    const items = Array.from(view.container.querySelectorAll('li'))
    // A screen reader reads the state, then the item's own text.
    expect(items.map((item) => item.textContent)).toEqual(['Checked, done', 'Not checked, todo', 'Not checked, first'])
    for (const state of Array.from(view.container.querySelectorAll('.sr-only'))) {
      expect(state.textContent).toMatch(/^(Checked|Not checked),$/)
    }
    const boxes = Array.from(view.container.querySelectorAll('[data-task]'))
    expect(boxes.map((box) => box.getAttribute('data-task'))).toEqual(['checked', 'unchecked', 'unchecked'])
    for (const box of boxes) {
      expect(box).toHaveAttribute('aria-hidden', 'true')
      expect(box).not.toHaveAttribute('role')
      expect(box).not.toHaveAttribute('tabindex')
    }
    // Nothing in the preview claims to be a control, and there is no form control
    // at all, so nothing in it can be toggled or submitted.
    expect(screen.queryAllByRole('checkbox', { hidden: true })).toEqual([])
    expect(view.container.querySelector('input, button, form')).toBeNull()

    fireEvent.click(boxes[1])
    fireEvent.keyDown(boxes[1], { key: ' ' })
    expect(boxes[1]).toHaveAttribute('data-task', 'unchecked')
    expect(items[1]).toHaveTextContent('Not checked, todo')
  })

  it('renders a table with header cells that scrolls sideways inside the preview', () => {
    const view = renderWithIntl(
      <NoteMarkdownPreview content={'| Item | Count |\n|:-----|------:|\n| apples | 3 |\n| pears | 10 |'} />,
    )

    const table = screen.getByRole('table')
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Item', 'Count'])
    expect(screen.getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['apples', '3', 'pears', '10'])
    expect(table.querySelectorAll('thead th')).toHaveLength(2)
    expect(table.querySelectorAll('tbody td')).toHaveLength(4)
    // Alignment comes from a class: the profile allows no style attribute.
    expect(view.container.querySelector('[style]')).toBeNull()
    expect(screen.getByRole('columnheader', { name: 'Count' })).toHaveClass('text-right')
    expect(table.parentElement).toHaveClass('overflow-x-auto')
  })

  it('lets the keyboard reach a table that scrolls sideways, and names it', () => {
    renderWithIntl(<NoteMarkdownPreview content={'| a | b |\n|---|---|\n| 1 | 2 |'} />)

    // A scroll box with no focusable child cannot be scrolled with the keyboard
    // unless it is focusable itself. The name is one fixed string: the profile
    // forbids note text in an attribute.
    const region = screen.getByRole('region', { name: 'Table, scrolls sideways' })
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region).toContainElement(screen.getByRole('table'))
    expect(region).toHaveClass('overflow-x-auto')
    // The global focus rule draws its outline outside the box, where an
    // ancestor's scroll area can clip it, so the box draws an inset one.
    expect(region).toHaveClass('focus-visible:outline-[rgb(var(--primary))]', 'focus-visible:-outline-offset-2')
  })

  // A table is padded to its header's width on every row, so its cells are columns
  // times rows while the note grows only with their sum. The budget is 10,000 cells.
  const tableOf = (columns: number, rows: number, cell = 'x') =>
    [
      `|${'a|'.repeat(columns)}`,
      `|${'-|'.repeat(columns)}`,
      ...Array.from({ length: rows - 1 }, () => `|${`${cell}|`.repeat(columns)}`),
    ].join('\n')

  it('renders tables that hold exactly 10,000 cells and shows one cell over as plain text', () => {
    // 100 columns by 100 rows is one table of exactly 10,000 cells.
    const at = renderWithIntl(<NoteMarkdownPreview content={tableOf(100, 100)} />)
    expect(at.container.querySelector('[data-note-preview="plain-text"]')).toBeNull()
    expect(at.container.querySelectorAll('th')).toHaveLength(100)
    expect(at.container.querySelectorAll('td')).toHaveLength(9900)
    at.unmount()

    // Three tables that add up to 10,000: 9,900 + 99 + 1. A one-column table that is
    // only a header row is one cell, so a fourth one makes 10,001 and nothing else
    // about the note changes. A cap of 10,001 or more must fail this.
    const parts = [tableOf(100, 99), tableOf(11, 9), tableOf(1, 1)]
    const join = (tables: string[]) => tables.join('\n\ntext\n\n')
    const sum = renderWithIntl(<NoteMarkdownPreview content={join(parts)} />)
    expect(sum.container.querySelector('[data-note-preview="plain-text"]')).toBeNull()
    expect(sum.container.querySelectorAll('table')).toHaveLength(3)
    sum.unmount()

    const body = join([...parts, tableOf(1, 1)])
    const over = renderWithIntl(<NoteMarkdownPreview content={body} />)
    expect(over.container.querySelector('table')).toBeNull()
    expect(over.container.querySelector('[data-note-preview="plain-text"]')?.textContent).toBe(body)
  }, 30000)

  it('counts a table by the width it is padded to, not by the cells written', () => {
    // 500 columns by 21 rows is 10,500 cells, but the 20 short rows hold one cell each.
    const wide = `|${'a|'.repeat(500)}\n|${'-|'.repeat(500)}\n${'x\n'.repeat(19)}x`
    const view = renderWithIntl(<NoteMarkdownPreview content={wide} />)
    expect(view.container.querySelector('table')).toBeNull()
    expect(view.container.querySelector('[data-note-preview="plain-text"]')?.textContent).toBe(wide)
    view.unmount()

    // The same shape one row shorter is exactly 10,000 cells.
    const atBudget = `|${'a|'.repeat(500)}\n|${'-|'.repeat(500)}\n${'x\n'.repeat(18)}x`
    const fits = renderWithIntl(<NoteMarkdownPreview content={atBudget} />)
    expect(fits.container.querySelector('[data-note-preview="plain-text"]')).toBeNull()
    expect(fits.container.querySelectorAll('th')).toHaveLength(500)
    expect(fits.container.querySelectorAll('td')).toHaveLength(9500)
  }, 30000)

  it('adds up the cells of every table in the note, nested ones included', () => {
    const half = tableOf(50, 100)
    const body = `${half}\n\ntext\n\n> ${half.split('\n').join('\n> ')}\n\n- item\n\n  ${half.split('\n').join('\n  ')}`
    const view = renderWithIntl(<NoteMarkdownPreview content={body} />)
    expect(view.container.querySelector('table')).toBeNull()
    expect(view.container.querySelector('[data-note-preview="plain-text"]')?.textContent).toBe(body)
  })

  it('renders strikethrough as deleted text', () => {
    const view = renderWithIntl(<NoteMarkdownPreview content="~~old~~ and ~gone~ kept" />)

    expect(Array.from(view.container.querySelectorAll('del')).map((del) => del.textContent)).toEqual(['old', 'gone'])
    expect(view.container.textContent).toContain('kept')
  })

  it('keeps the safety rules inside table cells and task items', () => {
    const content = [
      '| link | html | image | bare |',
      '|---|---|---|---|',
      '| [run](javascript:alert(1)) | <script>window.__note_xss = true</script> | ![pixel](https://tracker.example/cell.png) | https://bare.example/x www.bare.example a@bare.example |',
      '| [ok](https://example.com/ok) | <img src=x onerror="window.__note_xss = true"> | ![](//tracker.example/cell2.png) | mailto:b@bare.example xmpp:c@bare.example |',
      '',
      '- [ ] [run](javascript:alert(1))',
      '- [x] <script>window.__note_xss = true</script>',
      '- [ ] ![pixel](https://tracker.example/task.png)',
      '- [x] see https://bare.example/y, www.bare.example and a@bare.example',
    ].join('\n')
    const view = renderWithIntl(<NoteMarkdownPreview content={content} />)
    const container = view.container

    // The hostile text really sits in table cells and task items.
    expect(container.querySelectorAll('tbody td')).toHaveLength(8)
    expect(container.querySelectorAll('[data-task]')).toHaveLength(4)

    expect(container.querySelector('script, img, svg, iframe, input')).toBeNull()
    expect(container.querySelector('[onerror], [onload], [style]')).toBeNull()
    expect(container.textContent).toContain('<script>window.__note_xss = true</script>')
    expect(container.textContent).toContain('<img src=x onerror="window.__note_xss = true">')
    expect(container.querySelectorAll('[data-note-image]')).toHaveLength(3)
    expect(container.innerHTML).not.toContain('tracker.example')
    expect(container.innerHTML).not.toContain('javascript')
    // Only the https link is live: bare addresses stay text, as the profile says.
    expect(Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com/ok',
    ])
    expect(container.textContent).toContain('https://bare.example/x www.bare.example a@bare.example')
    expect(container.textContent).toContain('mailto:b@bare.example xmpp:c@bare.example')
    expect(container.textContent).toContain('see https://bare.example/y, www.bare.example and a@bare.example')
    expect((window as { __note_xss?: boolean }).__note_xss).toBeUndefined()
  })

  it('leaves out the GFM parts the profile does not include: literal autolinks and footnotes', () => {
    const view = renderWithIntl(
      <NoteMarkdownPreview
        content={'Visit https://example.com/_a_b_ or www.example.com, mail a@example.com.\n\nA claim[^1].\n\n[^1]: https://example.com/source'}
      />,
    )
    const container = view.container

    // CommonMark reads `[^1]: ...` as a link reference definition, so `[^1]` is an ordinary link.
    expect(Array.from(container.querySelectorAll('a')).map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['^1', 'https://example.com/source'],
    ])
    expect(container.querySelector('sup, section')).toBeNull()
    expect(container.textContent).not.toContain('Footnotes')
    expect(container.innerHTML).not.toContain('user-content')
    // A bare URL is plain text that Markdown still applies to, as on every other client.
    expect(Array.from(container.querySelectorAll('em')).map((em) => em.textContent)).toEqual(['a_b'])
    expect(container.textContent).toContain('or www.example.com, mail a@example.com.')
  })

  it('leaves no from-markdown extension with a transform after the profile plugin has run', () => {
    // remark-gfm's address search is a transform of the literal-autolink extension.
    // The plugin finds that extension by its `literalAutolink` token. If an update
    // renames it, the plugin would silently stop removing the search, and the
    // backstop would hide that from the autolink tests, so this checks it directly.
    const store: { fromMarkdownExtensions?: unknown[] } = {}
    const processor = { data: () => store }
    remarkGfm.call(processor as never)
    const before = (store.fromMarkdownExtensions ?? []).flat(Infinity) as Array<{ transforms?: unknown[] }>
    expect(before.some((extension) => (extension.transforms?.length ?? 0) > 0)).toBe(true)

    remarkNotesProfile.call(processor)
    const after = (store.fromMarkdownExtensions ?? []).flat(Infinity) as Array<{ transforms?: unknown[] }>
    expect(after.length).toBe(before.length)
    expect(after.filter((extension) => (extension.transforms?.length ?? 0) > 0)).toEqual([])
  })

  it('does not stall on text full of near-miss web addresses', () => {
    // remark-gfm's search for bare addresses restarts one character after each address it
    // rejects, so its time grows with the square of such a run. The profile has no use for it.
    const body = `${'www._'.repeat(20000)}www`
    const started = performance.now()
    const view = renderWithIntl(<NoteMarkdownPreview content={body} />)
    expect(performance.now() - started).toBeLessThan(3000)
    expect(view.container.querySelector('[data-note-preview="plain-text"]')).toBeNull()
    expect(view.container.querySelector('a')).toBeNull()
    expect(view.container.textContent).toBe(body)
  })

  it('keeps list semantics on a task list whose items show no marker', () => {
    // A list with list-style none is no longer announced as a list by WebKit
    // unless it says so.
    const view = renderWithIntl(<NoteMarkdownPreview content={'- [ ] one\n- [x] two\n\n1. [ ] first\n\n- plain\n\n1. plain'} />)

    const lists = Array.from(view.container.querySelectorAll('ul, ol'))
    expect(lists.map((list) => [list.tagName, list.getAttribute('role')])).toEqual([
      ['UL', 'list'],
      ['OL', 'list'],
      ['UL', null],
      ['OL', null],
    ])
  })

  it('keeps the words that name a task state out of copied text', () => {
    const view = renderWithIntl(<NoteMarkdownPreview content="- [ ] one" />)
    expect(view.container.querySelector('.sr-only')).toHaveClass('select-none')
  })

  it('puts a link with no source position back as its text', () => {
    // The backstop for the address search remark-gfm runs after parsing. Nothing
    // else reaches it while that search is removed, so it is tested on its own.
    const transform = remarkNotesProfile.call({ data: () => ({}) }) as (tree: unknown) => void
    const text = (value: string) => ({ type: 'text', value })
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'link', url: 'https://a.example', children: [text('made')] },
            {
              type: 'link',
              url: 'https://b.example',
              position: { start: { line: 1, column: 1 }, end: { line: 1, column: 9 } },
              children: [text('written')],
            },
            { type: 'emphasis', children: [{ type: 'link', url: 'https://c.example', children: [text('nested')] }] },
          ],
        },
      ],
    }
    transform(tree)

    const paragraph = tree.children[0] as { children: Array<{ type: string; children?: Array<{ type: string }> }> }
    expect(paragraph.children.map((child) => child.type)).toEqual(['text', 'link', 'emphasis'])
    expect(paragraph.children[2].children?.map((child) => child.type)).toEqual(['text'])
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

  it('is not got around by a leading byte order mark or by whitespace after a quote marker', () => {
    // The guard, not the parser's own overflow, must catch these: parsing them takes seconds.
    const plain = (content: string) => {
      const started = performance.now()
      const view = renderWithIntl(<NoteMarkdownPreview content={content} />)
      const found = view.container.querySelector('[data-note-preview="plain-text"]') !== null
      view.unmount()
      expect(performance.now() - started).toBeLessThan(1500)
      return found
    }
    const bom = String.fromCharCode(0xfeff)
    expect(plain(`${bom}${'- '.repeat(5000)}x`)).toBe(true)
    // A list inside a quote continues on the whitespace after the `>`.
    expect(plain(`>${'\t'.repeat(60)}- a\n>${'\t'.repeat(120)}- b`)).toBe(true)
    expect(plain(`> ${' '.repeat(250)}- deep`)).toBe(true)
    // Ordinary spacing is not counted: a quote, a list and an ordered list stay Markdown.
    expect(plain(`${bom}> - 1. a\n>   - b`)).toBe(false)
    expect(plain(`${'> '.repeat(100)}x`)).toBe(false)
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
