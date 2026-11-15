import { describe, it, expect, vi, afterEach } from 'vitest'
import { AccountBoundaryChangedError } from '@/app/lib/account-epoch'
import {
  MAX_NAME_BYTES,
  MAX_NOTEBOOK_ITEM_PAGES,
  NotesListingError,
  buildNotesArchive,
  listAllNotebookItems,
  noteFileBytes,
  noteFrontmatter,
  readNotesForExport,
  safeName,
  uniqueNames,
  yamlQuote,
  type ExportableNoteItem,
  type ExportedNote,
  type ItemListPage,
} from '@/app/lib/notes-export'

const ch = (...codes: number[]) => String.fromCharCode(...codes)
const utf8 = (value: string) => new TextEncoder().encode(value)
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const byteLength = (value: string) => utf8(value).length

describe('safeName', () => {
  it('replaces path separators, so a name is always one path component', () => {
    expect(safeName('Work/Home' + ch(0x5c) + 'Notes', 'Untitled')).toBe('Work_Home_Notes')
    const traversal = safeName('../../etc/passwd', 'Untitled')
    expect(traversal).not.toMatch(/[/\\]/)
    expect(traversal).toBe('_.._etc_passwd')
  })

  it.each(['.', '..', '...', ' . . '])('gives %j the fallback', (name) => {
    expect(safeName(name, 'Untitled')).toBe('Untitled')
  })

  it('turns tabs and line breaks into single spaces and other control characters into underscores', () => {
    expect(safeName('Line one' + ch(10, 13, 10) + 'Line two' + ch(9) + 'end', 'x')).toBe('Line one Line two end')
    expect(safeName('a' + ch(0) + 'b' + ch(0x1f) + 'c' + ch(0x7f) + 'd' + ch(0x9b) + 'e', 'x')).toBe('a_b_c_d_e')
    expect(safeName('a' + ch(0x2028) + 'b' + ch(0x85) + 'c', 'x')).toBe('a b c')
  })

  it('replaces the characters Windows refuses in names', () => {
    expect(safeName('a<b>c:d"e|f?g*h', 'x')).toBe('a_b_c_d_e_f_g_h')
  })

  it('replaces bidirectional overrides and marks, so a name cannot display as something else', () => {
    expect(safeName('evil' + ch(0x202e) + 'dm.exe', 'x')).toBe('evil_dm.exe')
    expect(safeName('a' + ch(0x2066) + 'b' + ch(0x200f), 'x')).toBe('a_b_')
    expect(safeName('a' + ch(0x61c) + 'b', 'x')).toBe('a_b')
  })

  it('folds fullwidth dots, slashes and backslashes before filtering, so they cannot become a traversal', () => {
    const fullwidthDot = ch(0xff0e)
    const fullwidthBackslash = ch(0xff3c)
    const name = safeName(fullwidthDot + fullwidthDot + fullwidthBackslash + fullwidthDot + fullwidthDot + fullwidthBackslash + 'README', 'x')
    expect(name).toBe('_.._README')
    expect(safeName('a' + ch(0xff0f) + 'b' + ch(0xff1a) + 'c', 'x')).toBe('a_b_c')
  })

  it('removes invisible characters, and gives a name made only of them the fallback', () => {
    expect(safeName(ch(0x200b, 0x2063, 0xad), 'Untitled')).toBe('Untitled')
    expect(safeName(ch(0x200b) + 'a', 'Untitled')).toBe('a')
    // Two titles that look the same on screen get the same file name.
    expect(safeName('a' + ch(0x200b) + 'b', 'x')).toBe(safeName('ab', 'x'))
  })

  it.each([
    ['yen sign', 0xa5],
    ['won sign', 0x20a9],
    ['fraction slash', 0x2044],
    ['division slash', 0x2215],
    ['set minus', 0x2216],
    ['reverse solidus operator', 0x29f5],
    ['big solidus', 0x29f8],
    ['big reverse solidus', 0x29f9],
  ])('replaces the %s, which some code pages turn into a separator', (_name, code) => {
    const separator = ch(code)
    expect(safeName('a' + separator + '..' + separator + '..' + separator + 'evil', 'x')).toBe('a_.._.._evil')
  })

  it.each([
    ['CON', '_CON'],
    ['con', '_con'],
    ['Nul', '_Nul'],
    ['aux ', '_aux'],
    ['COM1', '_COM1'],
    ['lpt9', '_lpt9'],
    ['COM' + ch(0xb9), '_COM1'],
    ['CONIN$', '_CONIN$'],
    ['CON.txt', '_CON.txt'],
    ['prn.backup.old', '_prn.backup.old'],
  ])('prefixes the Windows device name %j', (name, expected) => {
    expect(safeName(name, 'x')).toBe(expected)
  })

  it.each(['CONSOLE', 'COM10', 'Concert', 'Auxiliary', 'nullable'])('leaves %j alone', (name) => {
    expect(safeName(name, 'x')).toBe(name)
  })

  it('removes leading and trailing dots and spaces', () => {
    expect(safeName('Draft. . .', 'x')).toBe('Draft')
    expect(safeName('   Notes   ', 'x')).toBe('Notes')
    expect(safeName('.hidden', 'x')).toBe('hidden')
    expect(safeName('a  lot   of    spaces', 'x')).toBe('a lot of spaces')
  })

  it('cuts very long names to MAX_NAME_BYTES without splitting a character', () => {
    expect(safeName('a'.repeat(300), 'x')).toBe('a'.repeat(MAX_NAME_BYTES))
    const accented = safeName(ch(0xe9).repeat(80), 'x')
    expect(accented).toBe(ch(0xe9).repeat(MAX_NAME_BYTES / 2))
    const emoji = String.fromCodePoint(0x1f600)
    const emojiName = safeName(emoji.repeat(30), 'x')
    expect(emojiName).toBe(emoji.repeat(MAX_NAME_BYTES / 4))
    expect(byteLength(emojiName)).toBeLessThanOrEqual(MAX_NAME_BYTES)
    // A cut that ends in a space or dot is trimmed again.
    expect(safeName('a'.repeat(MAX_NAME_BYTES - 1) + ' tail', 'x')).toBe('a'.repeat(MAX_NAME_BYTES - 1))
  })

  it('gives empty and blank names the fallback', () => {
    expect(safeName('', 'Untitled')).toBe('Untitled')
    expect(safeName('   ', 'Untitled')).toBe('Untitled')
    expect(safeName(ch(10, 9), 'Untitled')).toBe('Untitled')
  })

  it('keeps letters from any script, composed (NFC)', () => {
    const japanese = ch(0x65e5, 0x672c, 0x8a9e)
    expect(safeName('Caf' + ch(0xe9) + ' ' + japanese, 'x')).toBe('Caf' + ch(0xe9) + ' ' + japanese)
    expect(safeName('Cafe' + ch(0x301), 'x')).toBe('Caf' + ch(0xe9))
  })

  it('replaces a lone surrogate', () => {
    expect(safeName('a' + ch(0xd800) + 'b', 'x')).toBe('a_b')
  })
})

describe('uniqueNames', () => {
  it('suffixes duplicates by id order, whatever order they arrive in', () => {
    const entries = [
      { id: 'c', base: 'Ideas' },
      { id: 'a', base: 'Ideas' },
      { id: 'b', base: 'Ideas' },
    ]
    const expected = new Map([['a', 'Ideas.md'], ['b', 'Ideas (2).md'], ['c', 'Ideas (3).md']])
    expect(uniqueNames(entries, '.md')).toEqual(expected)
    expect(uniqueNames([...entries].reverse(), '.md')).toEqual(expected)
  })

  it('treats names that differ only in case as duplicates', () => {
    const names = uniqueNames([{ id: 'a', base: 'Ideas' }, { id: 'b', base: 'ideas' }], '.md')
    expect(names.get('a')).toBe('Ideas.md')
    expect(names.get('b')).toBe('ideas (2).md')
  })

  it.each([
    ['final and medial sigma', ch(0x3c3), ch(0x3c2)],
    ['long s and s', 'secret', ch(0x17f) + 'ecret'],
    ['micro sign and mu', ch(0xb5), ch(0x3bc)],
    ['dotless i and i', 'i', ch(0x131)],
    ['fullwidth and plain letters', 'A', ch(0xff21)],
  ])('treats %s as duplicates, as case-insensitive file systems may', (_pair, first, second) => {
    const names = uniqueNames([{ id: 'a', base: first }, { id: 'b', base: second }], '.md')
    expect(names.get('a')).toBe(`${first}.md`)
    expect(names.get('b')).toBe(`${second} (2).md`)
  })

  it('never hands out a name another entry really has', () => {
    const names = uniqueNames([
      { id: 'a', base: 'Ideas' },
      { id: 'b', base: 'Ideas' },
      { id: 'c', base: 'Ideas (2)' },
    ], '.md')
    expect(names).toEqual(new Map([['a', 'Ideas.md'], ['c', 'Ideas (2).md'], ['b', 'Ideas (3).md']]))
  })

  it('leaves distinct names alone and works without an extension', () => {
    expect(uniqueNames([{ id: 'a', base: 'Work' }, { id: 'b', base: 'Home' }])).toEqual(
      new Map([['a', 'Work'], ['b', 'Home']]),
    )
  })
})

describe('yamlQuote and noteFrontmatter', () => {
  const tricky = [
    'Plain title',
    'He said "hi"',
    'C:' + ch(0x5c) + 'path' + ch(0x5c),
    'key: value # not a comment',
    '- starts like a list',
    'null',
    'true',
    '---',
    'Line one' + ch(10) + 'Line two',
    'tab' + ch(9) + 'and CR' + ch(13),
    'separators ' + ch(0x2028) + ch(0x2029) + ch(0x85),
    'controls ' + ch(0, 7, 0x1b, 0x7f, 0x9f),
    ch(0xfeff) + 'BOM first',
    'emoji ' + String.fromCodePoint(0x1f600) + ' and ' + ch(0xe9),
  ]

  it.each(tricky)('quotes %j so it reads back exactly', (title) => {
    const quoted = yamlQuote(title)
    // Every escape used is valid in both JSON and YAML double-quoted scalars.
    expect(JSON.parse(quoted)).toBe(title)
    expect(quoted.startsWith('"') && quoted.endsWith('"')).toBe(true)
    // Nothing YAML treats as a line break or forbids unescaped is left raw.
    expect(quoted).not.toMatch(new RegExp('[' + ch(0) + '-' + ch(0x1f) + ch(0x7f) + '-' + ch(0x9f) + ch(0x2028, 0x2029, 0xfeff) + ']'))
  })

  it('writes a lone surrogate, which no synced title holds, as U+FFFD', () => {
    expect(JSON.parse(yamlQuote('a' + ch(0xd800)))).toBe('a' + ch(0xfffd))
  })

  it('writes the title and the modification time the metadata has', () => {
    expect(noteFrontmatter({ title: 'Plan: Q1', mtime: Date.UTC(2026, 10, 15, 9, 30) })).toBe(
      '---\ntitle: "Plan: Q1"\nmodified: 2026-11-15T09:30:00.000Z\n---\n',
    )
    expect(noteFrontmatter({ title: 'Epoch', mtime: 0 })).toContain('modified: 1970-01-01T00:00:00.000Z\n')
  })

  it('leaves out a missing title or modification time instead of guessing', () => {
    expect(noteFrontmatter({ title: null, mtime: null })).toBe('---\n---\n')
    expect(noteFrontmatter({ title: null, mtime: 1000 })).toBe('---\nmodified: 1970-01-01T00:00:01.000Z\n---\n')
  })
})

describe('noteFileBytes', () => {
  const note = (content: Uint8Array): ExportedNote => ({ id: 'n1', notebookId: 'nb', title: 'T', mtime: null, content })

  it('writes the body byte for byte after the frontmatter', () => {
    const body = utf8('---\ntitle: inner\n---\r\n# Heading\r\n\r\nText with CRLF and ' + ch(0xe9))
    const bytes = noteFileBytes(note(body))
    const head = utf8('---\ntitle: "T"\n---\n')
    expect(Array.from(bytes.slice(0, head.length))).toEqual(Array.from(head))
    expect(Array.from(bytes.slice(head.length))).toEqual(Array.from(body))
  })

  it('keeps bytes that are not valid UTF-8 unchanged', () => {
    const body = new Uint8Array([0x41, 0xff, 0xfe, 0xc3, 0x28, 0x42])
    const bytes = noteFileBytes(note(body))
    expect(Array.from(bytes.slice(bytes.length - body.length))).toEqual(Array.from(body))
  })

  it('ends after the frontmatter for an empty note', () => {
    expect(text(noteFileBytes(note(new Uint8Array(0))))).toBe('---\ntitle: "T"\n---\n')
  })
})

type FakeItem = ExportableNoteItem & { getContent: ReturnType<typeof vi.fn> }

function item(uid: string, content: string | Uint8Array | Error, meta: unknown, extra: { isDeleted?: boolean } = {}): FakeItem {
  return {
    uid,
    ...extra,
    getMeta: () => {
      if (meta instanceof Error) throw meta
      return meta
    },
    getContent: vi.fn(async () => {
      if (content instanceof Error) throw content
      return content
    }),
  }
}

const inNotebook = (id: string, ...items: FakeItem[]) => ({ id, items })

describe('readNotesForExport', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const always = () => true

  it('reads each note with its notebook, title, modification time and exact body', async () => {
    const { notes, unreadable } = await readNotesForExport(
      [inNotebook('nb1', item('n1', utf8('Body'), { name: 'Plan', mtime: 1_700_000_000_000 }))],
      { isCurrent: always },
    )
    expect(unreadable).toBe(0)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ id: 'n1', notebookId: 'nb1', title: 'Plan', mtime: 1_700_000_000_000 })
    expect(text(notes[0]!.content)).toBe('Body')
  })

  it('accepts a body handed over as a string', async () => {
    const { notes } = await readNotesForExport([inNotebook('nb1', item('n1', 'As text', {}))], { isCurrent: always })
    expect(text(notes[0]!.content)).toBe('As text')
  })

  it('keeps a blank or non-string title and an unusable mtime out', async () => {
    const { notes } = await readNotesForExport([inNotebook(
      'nb1',
      item('a', '', { name: '   ', mtime: Number.NaN }),
      item('b', '', { name: 42, mtime: '2026-01-01' }),
      item('c', '', { mtime: 1e20 }),
      item('d', '', null),
    )], { isCurrent: always })
    expect(notes.map((note) => [note.title, note.mtime])).toEqual([[null, null], [null, null], [null, null], [null, null]])
  })

  it('skips deleted items and typed items as core does, without counting them', async () => {
    const deleted = item('n1', 'gone', { name: 'Deleted' }, { isDeleted: true })
    const attachment = item('n2', 'binary', { name: 'photo.jpg', type: 'attachment' })
    const { notes, unreadable } = await readNotesForExport([inNotebook(
      'nb1',
      deleted,
      attachment,
      item('n3', 'kept', { name: 'Kept', type: '' }),
    )], { isCurrent: always })
    expect(notes.map((note) => note.id)).toEqual(['n3'])
    expect(unreadable).toBe(0)
    expect(deleted.getContent).not.toHaveBeenCalled()
    expect(attachment.getContent).not.toHaveBeenCalled()
  })

  it('counts notes whose body or metadata cannot be read, and still reads the others', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { notes, unreadable } = await readNotesForExport([
      inNotebook(
        'nb1',
        item('bad-body', new Error('decryption failed'), { name: 'Secret title' }),
        item('bad-meta', 'Secret body', new Error('bad meta')),
      ),
      inNotebook('nb2', item('good', 'Fine', { name: 'Fine' })),
    ], { isCurrent: always })
    expect(notes.map((note) => note.id)).toEqual(['good'])
    expect(unreadable).toBe(2)
  })

  it('logs only error names, never a title or body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await readNotesForExport([inNotebook(
      'nb1',
      item('bad-body', new Error('Secret title Secret body'), { name: 'Secret title' }),
      item('bad-meta', 'Secret body', new Error('Secret title')),
    )], { isCurrent: always })
    expect(warn).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Secret/)
  })

  it('stops with AccountBoundaryChangedError when the account changes while a note is decrypted', async () => {
    let current = true
    const switching = item('a', 'A', {})
    switching.getContent.mockImplementation(async () => {
      current = false
      return utf8('A')
    })
    const later = item('b', 'B', {})
    await expect(readNotesForExport([inNotebook('nb1', switching, later)], { isCurrent: () => current }))
      .rejects.toBeInstanceOf(AccountBoundaryChangedError)
    expect(later.getContent).not.toHaveBeenCalled()
  })

  it('does not count a decryption failure caused by an account change as unreadable', async () => {
    let current = true
    const failing = item('a', 'A', {})
    failing.getContent.mockImplementation(async () => {
      current = false
      throw new Error('account gone')
    })
    await expect(readNotesForExport([inNotebook('nb1', failing)], { isCurrent: () => current }))
      .rejects.toBeInstanceOf(AccountBoundaryChangedError)
  })
})

describe('listAllNotebookItems', () => {
  const always = () => true
  const page = (uids: string[], stoken: string | null, done: boolean): ItemListPage<{ uid: string; v?: number }> => ({
    items: uids.map((uid) => ({ uid })),
    stoken,
    done,
  })

  it('follows the cursor to the last page, starting without one', async () => {
    const listPage = vi.fn()
      .mockResolvedValueOnce(page(['a', 'b'], 's1', false))
      .mockResolvedValueOnce(page(['c'], 's2', false))
      .mockResolvedValueOnce(page(['d'], 's3', true))
    const items = await listAllNotebookItems(listPage, always)
    expect(items.map((entry) => entry.uid)).toEqual(['a', 'b', 'c', 'd'])
    expect(listPage.mock.calls.map((call) => call[0])).toEqual([null, 's1', 's2'])
  })

  it('keeps the later copy of an item listed twice', async () => {
    const listPage = vi.fn()
      .mockResolvedValueOnce({ items: [{ uid: 'a', v: 1 }], stoken: 's1', done: false })
      .mockResolvedValueOnce({ items: [{ uid: 'a', v: 2 }], stoken: 's2', done: true })
    expect(await listAllNotebookItems(listPage, always)).toEqual([{ uid: 'a', v: 2 }])
  })

  it('throws when a page that is not the last has no cursor', async () => {
    const listPage = vi.fn().mockResolvedValueOnce(page(['a'], null, false))
    await expect(listAllNotebookItems(listPage, always)).rejects.toThrow(
      new NotesListingError('Note listing is not done but returned no stoken'),
    )
    expect(listPage).toHaveBeenCalledTimes(1)
  })

  it('throws when the server repeats the cursor it just gave', async () => {
    const listPage = vi.fn().mockResolvedValue(page(['a'], 's1', false))
    await expect(listAllNotebookItems(listPage, always)).rejects.toThrow(
      new NotesListingError('Note listing returned a repeated stoken'),
    )
    expect(listPage).toHaveBeenCalledTimes(2)
  })

  it('throws when an earlier cursor comes back', async () => {
    const listPage = vi.fn()
      .mockResolvedValueOnce(page(['a'], 's1', false))
      .mockResolvedValueOnce(page(['b'], 's2', false))
      .mockResolvedValueOnce(page(['c'], 's1', false))
    await expect(listAllNotebookItems(listPage, always)).rejects.toThrow(
      new NotesListingError('Note listing returned a repeated stoken'),
    )
    expect(listPage).toHaveBeenCalledTimes(3)
  })

  it('throws at the page cap instead of reading on', async () => {
    let next = 0
    const listPage = vi.fn(async () => page([`i${next}`], `s${++next}`, false))
    await expect(listAllNotebookItems(listPage, always, 5)).rejects.toThrow(
      new NotesListingError('Note listing exceeded 5 pages'),
    )
    expect(listPage).toHaveBeenCalledTimes(5)
  })

  it('returns a last page that arrives exactly at the cap', async () => {
    let next = 0
    const listPage = vi.fn(async () => (++next < 5 ? page([`i${next}`], `s${next}`, false) : page(['last'], null, true)))
    expect(await listAllNotebookItems(listPage, always, 5)).toHaveLength(5)
  })

  it('caps a real listing at MAX_NOTEBOOK_ITEM_PAGES by default', async () => {
    let next = 0
    const listPage = vi.fn(async () => page([], `s${++next}`, false))
    await expect(listAllNotebookItems(listPage, always)).rejects.toThrow(
      new NotesListingError(`Note listing exceeded ${MAX_NOTEBOOK_ITEM_PAGES} pages`),
    )
    expect(listPage).toHaveBeenCalledTimes(MAX_NOTEBOOK_ITEM_PAGES)
  })

  it('passes on a failed later page instead of returning the earlier ones', async () => {
    const listPage = vi.fn()
      .mockResolvedValueOnce(page(['a'], 's1', false))
      .mockRejectedValueOnce(new Error('network'))
    await expect(listAllNotebookItems(listPage, always)).rejects.toThrow('network')
  })

  it('stops with AccountBoundaryChangedError when the account changes during a page', async () => {
    let current = true
    const listPage = vi.fn(async () => {
      current = false
      return page(['a'], 's1', false)
    })
    await expect(listAllNotebookItems(listPage, () => current)).rejects.toBeInstanceOf(AccountBoundaryChangedError)
    expect(listPage).toHaveBeenCalledTimes(1)
  })
})

describe('buildNotesArchive', () => {
  const fallbacks = { notebook: 'Notebook', untitled: 'Untitled' }
  const note = (id: string, notebookId: string, title: string | null, body = id): ExportedNote => ({
    id,
    notebookId,
    title,
    mtime: null,
    content: utf8(body),
  })

  it('lays notes out as one folder per notebook and one Markdown file per note', () => {
    const archive = buildNotesArchive(
      [{ id: 'nb1', name: 'Work' }, { id: 'nb2', name: 'Home' }],
      [note('n1', 'nb1', 'Plan', 'Body'), note('n2', 'nb1', 'Ideas')],
      fallbacks,
    )
    expect(archive.folders).toEqual(['Home', 'Work'])
    expect(archive.files.map((file) => file.path)).toEqual(['Work/Ideas.md', 'Work/Plan.md'])
    expect(text(archive.files[1]!.bytes)).toBe('---\ntitle: "Plan"\n---\nBody')
  })

  it('makes duplicate notebook names unique without regard to case', () => {
    const archive = buildNotesArchive(
      [{ id: 'b', name: 'work' }, { id: 'a', name: 'Work' }],
      [note('n1', 'a', 'One'), note('n2', 'b', 'Two')],
      fallbacks,
    )
    expect(archive.folders).toEqual(['Work', 'work (2)'])
    expect(archive.files.map((file) => file.path)).toEqual(['Work/One.md', 'work (2)/Two.md'])
  })

  it('makes duplicate titles unique within a notebook, but not across notebooks', () => {
    const archive = buildNotesArchive(
      [{ id: 'nb1', name: 'Work' }, { id: 'nb2', name: 'Home' }],
      [note('n2', 'nb1', 'Ideas'), note('n1', 'nb1', 'Ideas'), note('n3', 'nb2', 'Ideas')],
      fallbacks,
    )
    expect(archive.files.map((file) => file.path)).toEqual(['Home/Ideas.md', 'Work/Ideas (2).md', 'Work/Ideas.md'])
    // n1 sorts first by id, so it keeps the plain name.
    expect(text(archive.files[2]!.bytes)).toMatch(/n1$/)
  })

  it('names untitled notes and unnamed notebooks with the fallbacks, made unique', () => {
    const archive = buildNotesArchive(
      [{ id: 'nb1', name: '' }, { id: 'nb2', name: '..' }],
      [note('n1', 'nb1', null), note('n2', 'nb1', null), note('n3', 'nb1', '???')],
      fallbacks,
    )
    expect(archive.folders).toEqual(['Notebook', 'Notebook (2)'])
    expect(archive.files.map((file) => file.path)).toEqual([
      'Notebook/Untitled (2).md',
      'Notebook/Untitled.md',
      'Notebook/___.md',
    ])
    expect(text(archive.files[1]!.bytes)).toBe('---\n---\nn1')
  })

  it('still gives a note whose notebook is not listed a folder', () => {
    const archive = buildNotesArchive([], [note('n1', 'gone', 'Kept')], fallbacks)
    expect(archive.folders).toEqual(['Notebook'])
    expect(archive.files.map((file) => file.path)).toEqual(['Notebook/Kept.md'])
  })

  it('never produces a path with a traversal or an extra separator', () => {
    const archive = buildNotesArchive(
      [{ id: 'nb1', name: '../..' }],
      [note('n1', 'nb1', '../../../x'), note('n2', 'nb1', 'a' + ch(0x5c) + '..' + ch(0x5c) + 'b')],
      fallbacks,
    )
    for (const path of [...archive.folders, ...archive.files.map((file) => file.path)]) {
      const parts = path.split('/')
      expect(parts.length).toBeLessThanOrEqual(2)
      for (const part of parts) {
        expect(part).not.toBe('..')
        expect(part).not.toBe('.')
        expect(part).not.toContain(ch(0x5c))
        expect(part.length).toBeGreaterThan(0)
      }
    }
  })
})
