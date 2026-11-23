import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import messages from '../../../../messages/en.json'
import { clearNotePreviewVerdict } from '@/app/lib/note-preview-verdict'
import { NoteMarkdownPreview as RealNoteMarkdownPreview } from '../NoteMarkdownPreview'
import { okWorkerFactory } from './probe-test-workers'

// Every body goes through the real parser and renderer; the worker that times it
// is replaced by one that answers ok at once, since jsdom has no Worker.
function NoteMarkdownPreview(props: { content: string }) {
  return <RealNoteMarkdownPreview {...props} createWorker={okWorkerFactory} />
}

beforeEach(() => {
  clearNotePreviewVerdict()
})


// The shared vectors for the Notes Markdown profile (docs/contributing/notes-markdown.md).
// Android reads the same file; this test runs the web renderer over it.
const VECTORS_PATH = path.resolve(__dirname, '../../../../../../contracts/notes-markdown/v1-vectors.json')

interface InlineSpan {
  kind: 'em' | 'strong' | 'code' | 'del'
  text: string
}

interface Expectation {
  blocks?: string[]
  links: Array<{ text: string; href: string }>
  images: string[]
  text?: string[]
  textAbsent?: string[]
  absent?: string[]
  inline?: InlineSpan[]
  hardBreaks?: number
  tasks?: string[]
}

interface VectorCase {
  id: string
  since: 'commonmark' | 'gfm'
  markdown: string
  expect: Expectation
  note?: string
}

interface VectorFile {
  contract: string
  version: number
  cases: VectorCase[]
}

const vectors: VectorFile = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'))

// Anything that can make the browser issue a request on its own, or run script.
const FORBIDDEN_ELEMENTS =
  'script, img, picture, source, iframe, object, embed, video, audio, link, style, svg, image, track, form, input, base, meta'

const IMAGE_PLACEHOLDER_PREFIX = messages.Notes.imageBlockedWithAlt.replace('{alt}', '')

const HEADING = /^H([1-6])$/

// The visual box of a task item. It is hidden from assistive technology; the
// item's state is read from the visually hidden text next to it.
const TASK_CHECKBOX = '[data-task]'

// A task item carries its checkbox itself, or in its first paragraph when the
// list is loose; a checkbox further down belongs to a nested list.
function isTaskItem(item: Element): boolean {
  return item.querySelector(`:scope > ${TASK_CHECKBOX}, :scope > p:first-child > ${TASK_CHECKBOX}`) !== null
}

function tableKind(table: HTMLTableElement): string {
  return `table:${table.rows.length}x${table.rows[0]?.cells.length ?? 0}`
}

function blockKind(element: Element): string {
  const tag = element.tagName
  const heading = HEADING.exec(tag)
  if (heading) return `heading:${heading[1]}`
  if ((tag === 'UL' || tag === 'OL') && Array.from(element.children).some(isTaskItem)) return 'list:task'
  // A table may sit in a wrapper that scrolls it sideways on a narrow screen.
  if (tag === 'DIV' && element.children.length === 1 && element.firstElementChild instanceof HTMLTableElement) {
    return tableKind(element.firstElementChild)
  }
  switch (tag) {
    case 'P':
      return 'paragraph'
    case 'UL':
      return 'list:bullet'
    case 'OL':
      return 'list:ordered'
    case 'TABLE':
      return tableKind(element as HTMLTableElement)
    case 'PRE':
      return 'code'
    case 'BLOCKQUOTE':
      return 'quote'
    case 'HR':
      return 'rule'
    default:
      return `unknown:${tag.toLowerCase()}`
  }
}

// A note body that is plain Markdown only ever yields elements at the top
// level, so a non-blank text node there is a raw HTML block shown as text.
function topLevelBlocks(container: HTMLElement): string[] {
  const kinds: string[] = []
  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) kinds.push(blockKind(node as Element))
    else if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '') kinds.push('html')
  }
  return kinds
}

function visibleText(element: Element): string {
  const copy = element.cloneNode(true) as Element
  copy.querySelectorAll('[data-note-image]').forEach((placeholder) => placeholder.remove())
  return copy.textContent ?? ''
}

function inlineSpans(container: HTMLElement): InlineSpan[] {
  const tags: Record<string, InlineSpan['kind']> = { EM: 'em', STRONG: 'strong', CODE: 'code', DEL: 'del' }
  return Array.from(container.querySelectorAll('em, strong, code, del'))
    .filter((el) => !(el.tagName === 'CODE' && el.parentElement?.tagName === 'PRE'))
    .map((el) => ({ kind: tags[el.tagName], text: el.textContent ?? '' }))
}

function placeholderAlts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-note-image]')).map((el) => {
    const text = el.textContent ?? ''
    return text.startsWith(IMAGE_PLACEHOLDER_PREFIX) ? text.slice(IMAGE_PLACEHOLDER_PREFIX.length) : ''
  })
}

function taskStates(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(TASK_CHECKBOX)).map((box) =>
    box.getAttribute('data-task') === 'checked' ? 'checked' : 'unchecked',
  )
}

function attributeValues(container: HTMLElement): string[] {
  const values: string[] = []
  for (const element of Array.from(container.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) values.push(`${attribute.name}=${attribute.value}`)
  }
  return values
}

describe('Notes Markdown profile vectors (web)', () => {
  it('is the v1 contract file', () => {
    expect(vectors.contract).toBe('silentsuite.notes.markdown')
    expect(vectors.version).toBe(1)
    expect(vectors.cases.length).toBeGreaterThan(0)
  })

  it('has well-formed, uniquely named cases', () => {
    const ids = vectors.cases.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of vectors.cases) {
      expect(c.id, 'id').toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(['commonmark', 'gfm'], `${c.id} since`).toContain(c.since)
      expect(typeof c.markdown, `${c.id} markdown`).toBe('string')
      if (c.expect.blocks !== undefined) expect(Array.isArray(c.expect.blocks), `${c.id} blocks`).toBe(true)
      expect(Array.isArray(c.expect.links), `${c.id} links`).toBe(true)
      expect(Array.isArray(c.expect.images), `${c.id} images`).toBe(true)
    }
  })

  it('keeps the hostile cases that need exact characters', () => {
    const byId = new Map(vectors.cases.map((c) => [c.id, c.markdown]))
    expect(byId.get('nul-and-lone-surrogates')).toContain(String.fromCharCode(0))
    expect(byId.get('nul-and-lone-surrogates')).toContain(String.fromCharCode(0xd800))
    expect(byId.get('link-text-with-right-to-left-override')).toContain(String.fromCharCode(0x202e))
    expect(byId.get('link-javascript-literal-tab')).toContain(String.fromCharCode(9))
  })

  it.each(vectors.cases.map((c) => [c.id, c] as const))('%s', (_id, vectorCase) => {
    const { markdown, expect: want } = vectorCase
    const view = renderWithIntl(<NoteMarkdownPreview content={markdown} />)
    const container = view.container

    // Invariants for every note body: nothing that can request or run anything.
    expect(container.querySelector(FORBIDDEN_ELEMENTS)).toBeNull()
    const attributes = attributeValues(container)
    expect(attributes.filter((a) => /^(on|style=|src=|srcset=|poster=|data=)/i.test(a))).toEqual([])

    if (want.blocks) expect(topLevelBlocks(container)).toEqual(want.blocks)

    const anchors = Array.from(container.querySelectorAll('a'))
    expect(
      anchors.map((a) => ({ text: visibleText(a), href: a.getAttribute('href') })),
    ).toEqual(want.links)
    for (const anchor of anchors) {
      expect(anchor.getAttribute('href') ?? '').toMatch(/^(https?|mailto):/i)
      expect(anchor.getAttribute('target')).toBe('_blank')
      expect(anchor.getAttribute('rel')).toBe('noopener noreferrer')
    }

    expect(placeholderAlts(container)).toEqual(want.images)

    const text = container.textContent ?? ''
    for (const needle of want.text ?? []) expect(text).toContain(needle)
    for (const needle of want.textAbsent ?? []) expect(text).not.toContain(needle)
    for (const needle of want.absent ?? []) {
      expect(attributes.filter((a) => a.toLowerCase().includes(needle.toLowerCase()))).toEqual([])
    }
    if (want.inline) expect(inlineSpans(container)).toEqual(want.inline)
    if (want.hardBreaks !== undefined) expect(container.querySelectorAll('br')).toHaveLength(want.hardBreaks)
    if (want.tasks) expect(taskStates(container)).toEqual(want.tasks)
  })
})
