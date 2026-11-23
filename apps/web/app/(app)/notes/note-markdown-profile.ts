import type { Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// What the page and the time-budget worker (note-markdown-probe.ts) share: the
// link rule and the plugin list. One module, so the timed parse cannot differ
// from the rendered one.

// The Notes Markdown profile (docs/contributing/notes-markdown.md) allows
// links to http://, https:// and mailto: only. The check is on the target as
// the parser hands it over (entities already decoded, and percent-encoded where
// a character cannot appear in a URL), without decoding percent escapes:
// `https%3A//x` is a relative URL to the browser, so it stays dead. An http or
// https target needs the `//`: a browser resolves `https:/x` and `https:x`
// against the page's own address, a link back into the app.
const ALLOWED_LINK_TARGET = /^(?:https?:\/\/|mailto:)/i

export function allowedLinkTarget(url: string): string {
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

export const REMARK_PLUGINS: Options['remarkPlugins'] = [remarkGfm, remarkNotesProfile]
