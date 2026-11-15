import { isMarkdownNoteItem } from '@silentsuite/core'
import { AccountBoundaryChangedError } from '@/app/lib/account-epoch'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'

/**
 * Notes export: one folder per notebook and one Markdown file per note, with
 * YAML frontmatter holding the title and modification time. The caller lists
 * the encrypted items from the server again (so a note this device could not
 * decrypt during an earlier sync is still seen and counted), and everything
 * here decrypts and lays them out in the browser. Nothing decrypted is sent
 * anywhere, and logs carry only error names, never a title, body, notebook
 * name or id.
 */

/**
 * Longest folder or file name kept before a duplicate suffix and the
 * extension, in UTF-8 bytes. Small enough that a notebook folder and a note
 * file under a typical Downloads folder stay within the 260-character Windows
 * path limit that some extractors still apply.
 */
export const MAX_NAME_BYTES = 60

/** Names Windows reserves as devices, whatever the extension (checked on the part before the first dot). */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i

/** Tabs and line breaks become spaces. */
const WHITESPACE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g
/**
 * Control characters, bidirectional overrides (which can make a name display
 * differently from what it is), path separators and the characters Windows
 * refuses in names.
 */
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g
/**
 * Slash and backslash look-alikes that NFKC leaves alone but some code pages
 * turn into a real separator when an extractor writes through an ANSI file
 * API: yen and won signs (backslash in code pages 932 and 949), and the
 * division, fraction and mathematical slashes and backslashes.
 */
const SEPARATOR_LOOKALIKES = /[\u00a5\u20a9\u2044\u2215\u2216\u29f5\u29f8\u29f9]/g
/** Leading and trailing dots and whitespace: Windows drops the trailing ones, and a leading dot hides a file. */
const EDGE_DOTS_AND_SPACES = /^[\s.]+|[\s.]+$/g
/**
 * Characters that render as nothing, such as zero-width spaces and joiners.
 * They are removed, so two names that look the same are the same name.
 */
const INVISIBLE_CHARS = /\p{Default_Ignorable_Code_Point}/gu

function isSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdfff
}

/** Replaces each UTF-16 surrogate that is not part of a pair (iteration yields pairs as one code point). */
function replaceLoneSurrogates(value: string): string {
  let out = ''
  for (const char of value) out += isSurrogate(char.codePointAt(0)!) ? '_' : char
  return out
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint < 0x10000) return 3
  return 4
}

/** Cuts `value` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0
  let end = 0
  for (const char of value) {
    bytes += utf8Length(char.codePointAt(0)!)
    if (bytes > maxBytes) break
    end += char.length
  }
  return value.slice(0, end)
}

function isWindowsReservedName(name: string): boolean {
  return WINDOWS_RESERVED_NAME.test(name.split('.')[0]!.trimEnd())
}

/**
 * Turns a note title or notebook name into one safe path component: no path
 * separators, `.` or `..`, control or reserved characters, Windows device
 * names, leading or trailing dots and spaces, and at most MAX_NAME_BYTES.
 * NFKC first turns compatibility forms such as fullwidth dots and slashes into
 * the plain characters, so they are caught too (some extractors would map
 * them to the plain ones), and separator look-alikes NFKC keeps become `_`.
 * Invisible characters are removed. Returns `fallback` when nothing is left.
 */
export function safeName(raw: string, fallback: string): string {
  let name = replaceLoneSurrogates(raw.normalize('NFKC'))
    .replace(WHITESPACE_BREAKS, ' ')
    .replace(UNSAFE_NAME_CHARS, '_')
    .replace(SEPARATOR_LOOKALIKES, '_')
    .replace(INVISIBLE_CHARS, '')
    .replace(/ {2,}/g, ' ')
    .replace(EDGE_DOTS_AND_SPACES, '')
  name = truncateUtf8(name, MAX_NAME_BYTES).replace(EDGE_DOTS_AND_SPACES, '')
  if (!name) return fallback
  return isWindowsReservedName(name) ? `_${name}` : name
}

/**
 * The form two names share when a file system that ignores case would treat
 * them as the same: compatibility forms folded, then upper- and lowercased so
 * pairs such as final and medial sigma, or long s and s, also match.
 */
function nameKey(name: string): string {
  return name.normalize('NFKC').toUpperCase().toLowerCase()
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Gives every entry a name that is unique without regard to case (Windows and
 * macOS file systems ignore case; see nameKey). Entries are ordered by that
 * key and then by id, so the result never depends on listing order. The
 * first entry with a base name keeps it; the others get " (2)", " (3)" and so
 * on, skipping any name another entry already holds. Returns id to full name.
 */
export function uniqueNames(
  entries: readonly { id: string; base: string }[],
  extension = '',
): Map<string, string> {
  const key = nameKey
  const sorted = [...entries].sort((a, b) => compareCodeUnits(key(a.base), key(b.base)) || compareCodeUnits(a.id, b.id))
  const taken = new Set<string>()
  const names = new Map<string, string>()
  for (const entry of sorted) {
    const name = `${entry.base}${extension}`
    if (taken.has(key(name))) continue
    taken.add(key(name))
    names.set(entry.id, name)
  }
  for (const entry of sorted) {
    if (names.has(entry.id)) continue
    // Each step either finds a free name or passes one that is taken, so this
    // ends within entries.length + 1 steps.
    let suffix = 2
    while (taken.has(key(`${entry.base} (${suffix})${extension}`))) suffix += 1
    const name = `${entry.base} (${suffix})${extension}`
    taken.add(key(name))
    names.set(entry.id, name)
  }
  return names
}

/**
 * A YAML double-quoted scalar. Quotes, backslashes, control characters, line
 * separators and other characters YAML does not allow unescaped are escaped,
 * so any title reads back exactly (a lone surrogate, which no synced title can
 * hold, becomes U+FFFD).
 */
export function yamlQuote(value: string): string {
  let out = '"'
  for (const char of value) {
    const codePoint = char.codePointAt(0)!
    if (char === '"') out += '\\"'
    else if (char === '\\') out += '\\\\'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    else if (isSurrogate(codePoint)) out += '\\ufffd'
    else if (
      codePoint < 0x20
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x2028
      || codePoint === 0x2029
      || codePoint === 0xfeff
      || codePoint === 0xfffe
      || codePoint === 0xffff
    ) {
      out += `\\u${codePoint.toString(16).padStart(4, '0')}`
    } else {
      out += char
    }
  }
  return `${out}"`
}

/** 0000-01-01T00:00:00.000Z and 9999-12-31T23:59:59.999Z: the range a plain ISO 8601 timestamp covers. */
const MIN_ISO_MS = -62_167_219_200_000
const MAX_ISO_MS = 253_402_300_799_999

/** A note as read for export. `title` and `mtime` are null when the metadata has none usable. */
export interface ExportedNote {
  id: string
  notebookId: string
  title: string | null
  /** Modification time in milliseconds since the epoch, from the item metadata. */
  mtime: number | null
  /** The decrypted body exactly as stored. */
  content: Uint8Array
}

/**
 * The frontmatter block written before the body. Etebase note metadata holds
 * a title (`name`) and a modification time (`mtime`) only, so those are the
 * fields written; a missing or unusable value is left out rather than guessed.
 */
export function noteFrontmatter(note: Pick<ExportedNote, 'title' | 'mtime'>): string {
  const lines = ['---']
  if (note.title !== null) lines.push(`title: ${yamlQuote(note.title)}`)
  if (note.mtime !== null) lines.push(`modified: ${new Date(note.mtime).toISOString()}`)
  lines.push('---', '')
  return lines.join('\n')
}

/** The bytes of one note's file: UTF-8 frontmatter, then the body unchanged. */
export function noteFileBytes(note: ExportedNote): Uint8Array {
  const head = new TextEncoder().encode(noteFrontmatter(note))
  const bytes = new Uint8Array(head.length + note.content.length)
  bytes.set(head)
  bytes.set(note.content, head.length)
  return bytes
}

/** The parts of an Etebase SDK item the export reads. */
export interface ExportableNoteItem {
  uid: string
  isDeleted?: boolean
  getMeta: () => unknown
  getContent: () => Promise<Uint8Array | string>
}

/** One page of an item listing, as core `listItems` returns it. */
export interface ItemListPage<T> {
  items: T[]
  stoken: string | null
  done: boolean
}

/** Most item pages read from one notebook before the export gives up (the Android listing guard uses the same cap). */
export const MAX_NOTEBOOK_ITEM_PAGES = 20_000

/** The server's item listing for a notebook did not finish; nothing is exported. */
export class NotesListingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotesListingError'
  }
}

/**
 * Reads every page of one notebook's item listing from the start. Fails
 * closed instead of returning part of a notebook: throws NotesListingError
 * when a page that is not the last carries no cursor, when a cursor comes back
 * that was already used, and when the listing passes MAX_NOTEBOOK_ITEM_PAGES.
 * Throws AccountBoundaryChangedError when `isCurrent` turns false. An item
 * listed twice keeps its later copy.
 */
export async function listAllNotebookItems<T extends { uid: string }>(
  listPage: (stoken: string | null) => Promise<ItemListPage<T>>,
  isCurrent: () => boolean,
  maxPages = MAX_NOTEBOOK_ITEM_PAGES,
): Promise<T[]> {
  const byUid = new Map<string, T>()
  const seenStokens = new Set<string>()
  let stoken: string | null = null
  for (let page = 1; ; page += 1) {
    const response = await listPage(stoken)
    if (!isCurrent()) throw new AccountBoundaryChangedError()
    for (const item of response.items) byUid.set(item.uid, item)
    if (response.done) return [...byUid.values()]
    if (page >= maxPages) throw new NotesListingError(`Note listing exceeded ${maxPages} pages`)
    if (!response.stoken) throw new NotesListingError('Note listing is not done but returned no stoken')
    if (seenStokens.has(response.stoken)) throw new NotesListingError('Note listing returned a repeated stoken')
    seenStokens.add(response.stoken)
    stoken = response.stoken
  }
}

export interface ReadNotesResult {
  notes: ExportedNote[]
  /** Notes left out because they could not be decrypted or their metadata could not be read. */
  unreadable: number
}

function titleOf(meta: Record<string, unknown> | null): string | null {
  const name = meta?.name
  return typeof name === 'string' && name.trim() ? name : null
}

function mtimeOf(meta: Record<string, unknown> | null): number | null {
  const mtime = meta?.mtime
  return typeof mtime === 'number' && Number.isFinite(mtime) && mtime >= MIN_ISO_MS && mtime <= MAX_ISO_MS
    ? mtime
    : null
}

/**
 * Decrypts every listed note on its own. Deleted items and items with a type
 * are skipped as core does (`isMarkdownNoteItem`); a note whose metadata or
 * body cannot be read is counted in `unreadable` and never fails the rest.
 * Throws AccountBoundaryChangedError when `isCurrent` turns false, so nothing
 * from a previous account is ever written.
 */
export async function readNotesForExport(
  notebooks: readonly { id: string; items: readonly ExportableNoteItem[] }[],
  options: { isCurrent: () => boolean },
): Promise<ReadNotesResult> {
  const notes: ExportedNote[] = []
  let unreadable = 0
  const encoder = new TextEncoder()

  const listed = notebooks.flatMap((notebook) => notebook.items.map((item) => ({ notebookId: notebook.id, item })))
  for (const { notebookId, item } of listed) {
    const id = item.uid
    if (item.isDeleted) continue

    let meta: unknown
    try {
      meta = item.getMeta()
    } catch (err) {
      unreadable += 1
      console.warn('[export] Left out a note whose metadata could not be read', getSafeErrorDetails(err))
      continue
    }
    const record = meta && typeof meta === 'object' ? meta as Record<string, unknown> : null
    if (!isMarkdownNoteItem(record as { type?: string | null } | null)) continue

    let content: Uint8Array
    try {
      const raw = await item.getContent()
      if (!options.isCurrent()) throw new AccountBoundaryChangedError()
      content = typeof raw === 'string' ? encoder.encode(raw) : raw
    } catch (err) {
      if (err instanceof AccountBoundaryChangedError || !options.isCurrent()) throw new AccountBoundaryChangedError()
      unreadable += 1
      console.warn('[export] Left out a note that could not be decrypted', getSafeErrorDetails(err))
      continue
    }

    notes.push({ id, notebookId, title: titleOf(record), mtime: mtimeOf(record), content })
  }

  if (!options.isCurrent()) throw new AccountBoundaryChangedError()
  return { notes, unreadable }
}

export interface NotesArchive {
  /** One folder path per notebook, including notebooks with no notes. */
  folders: string[]
  /** One Markdown file per note, under its notebook's folder. */
  files: { path: string; bytes: Uint8Array }[]
}

/**
 * Lays the notes out as `<notebook>/<title>.md`. Notebook folders and note
 * files get safe, case-insensitively unique names; a notebook or title with no
 * usable name gets the matching fallback. A note whose notebook is not in
 * `notebooks` still gets a folder, named `fallbacks.notebook`.
 */
export function buildNotesArchive(
  notebooks: readonly { id: string; name: string }[],
  notes: readonly ExportedNote[],
  fallbacks: { notebook: string; untitled: string },
): NotesArchive {
  const notebookNames = new Map(notebooks.map((notebook) => [notebook.id, notebook.name]))
  for (const note of notes) {
    if (!notebookNames.has(note.notebookId)) notebookNames.set(note.notebookId, fallbacks.notebook)
  }

  const folderNames = uniqueNames(
    [...notebookNames].map(([id, name]) => ({ id, base: safeName(name, fallbacks.notebook) })),
  )

  const notesByNotebook = new Map<string, ExportedNote[]>()
  for (const note of notes) {
    const list = notesByNotebook.get(note.notebookId) ?? []
    list.push(note)
    notesByNotebook.set(note.notebookId, list)
  }

  const folders = [...folderNames.values()].sort(compareCodeUnits)
  const files: NotesArchive['files'] = []
  for (const [notebookId, notebookNotes] of notesByNotebook) {
    const folder = folderNames.get(notebookId)!
    const fileNames = uniqueNames(
      notebookNotes.map((note) => ({ id: note.id, base: safeName(note.title ?? '', fallbacks.untitled) })),
      '.md',
    )
    for (const note of notebookNotes) {
      files.push({ path: `${folder}/${fileNames.get(note.id)!}`, bytes: noteFileBytes(note) })
    }
  }
  files.sort((a, b) => compareCodeUnits(a.path, b.path))
  return { folders, files }
}
