import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { useContactStore, resetContactLifecycle, _resetUncertainFileImportsForTests, ImportAlreadyRunningError } from '../use-contact-store'
import { useEtebaseStore, FILE_IMPORT_TIMEOUT_MS } from '../use-etebase-store'
import { useContactListStore } from '../use-contact-list-store'
import { useAuthStore } from '../use-auth-store'
import { bumpAccountEpoch, AccountBoundaryChangedError } from '@/app/lib/account-epoch'
import { ImportIncompleteError } from '@/app/lib/import-outcome'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import ContactImport from '@/app/components/import/ContactImport'

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn(), showToast: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', async (importOriginal) => ({ ...(await importOriginal<object>()), ...toastMock }))
const queueMock = vi.hoisted(() => ({ enqueue: vi.fn(async () => 'never') }))
vi.mock('@/app/lib/offline-queue', async (importOriginal) => ({ ...(await importOriginal<object>()), ...queueMock }))
vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: { getState: () => ({ recordUsage: vi.fn(async () => {}) }) },
}))

type Behavior = 'ok' | 'hang' | 'park' | 'lost' | 'network' | { status: number }

interface FakeItem { uid: string; rev: string; content: string; isDeleted: boolean; getContent: () => Promise<string> }

/** A server that, like collection.py:433, treats a resend of an item's current revision as saved. */
class FakeServer {
  readonly stored = new Map<string, Map<string, { rev: string; content: string; unreadable?: boolean }>>()
  readonly attempts: { collection: string; uids: string[] }[] = []
  plan: Behavior[] = []
  readonly held: (() => void)[] = []
  /** Settles a 'park' attempt by hand: true commits and acknowledges, false refuses with 413. */
  parked: ((ok: boolean) => void) | null = null
  listBehavior: 'ok' | 'hang' | 'fail' = 'ok'
  private next = 0

  collection(uid: string) {
    if (!this.stored.has(uid)) this.stored.set(uid, new Map())
    return this.stored.get(uid)!
  }

  seed(collection: string, content: string, unreadable = false) {
    this.collection(collection).set(`seed-${this.next++}`, { rev: 'seed', content, unreadable })
  }

  items(collection: string) {
    return [...this.collection(collection).values()].map((entry) => entry.content)
  }

  account() {
    const itemManager = (collection: string) => ({
      create: async (_meta: unknown, content: string): Promise<FakeItem> => {
        const n = this.next++
        return { uid: `item-${n}`, rev: `rev-${n}`, content, isDeleted: false, getContent: async () => content }
      },
      batch: (items: FakeItem[]) => {
        this.attempts.push({ collection, uids: items.map((item) => item.uid) })
        const commit = () => {
          for (const item of items) this.collection(collection).set(item.uid, { rev: item.rev, content: item.content })
        }
        const behavior = this.plan.shift() ?? 'ok'
        if (behavior === 'ok') { commit(); return Promise.resolve() }
        if (behavior === 'hang') { this.held.push(commit); return new Promise<void>(() => {}) }
        if (behavior === 'park') {
          return new Promise<void>((resolve, reject) => {
            this.parked = (ok) => {
              if (ok) { commit(); resolve() } else reject(Object.assign(new Error('413'), { name: 'HTTPError', status: 413 }))
            }
          })
        }
        if (behavior === 'lost') { commit(); return Promise.reject(Object.assign(new Error('Failed to fetch'), { name: 'NetworkError' })) }
        if (behavior === 'network') return Promise.reject(Object.assign(new Error('Failed to fetch'), { name: 'NetworkError' }))
        return Promise.reject(Object.assign(new Error(`${behavior.status}`), { name: 'HTTPError', status: behavior.status }))
      },
      list: async ({ stoken }: { stoken?: string }) => {
        if (this.listBehavior === 'hang') return new Promise(() => {})
        if (this.listBehavior === 'fail') throw new Error('refused')
        const all = [...this.collection(collection).entries()]
        const start = stoken ? Number(stoken) : 0
        const page = all.slice(start, start + 50).map(([uid, entry]) => ({
          uid,
          isDeleted: false,
          getContent: async () => {
            if (entry.unreadable) throw new Error('unreadable')
            return entry.content
          },
        }))
        return { data: page, stoken: String(start + page.length), done: start + 50 >= all.length }
      },
    })
    return {
      getCollectionManager: () => ({
        fetch: async (uid: string) => ({ uid }),
        getItemManager: (collection: { uid: string }) => itemManager(collection.uid),
      }),
    }
  }
}

let server: FakeServer

function card(name: string, uid?: string) {
  return { uid, displayName: name, name: { given: name, family: '' }, notes: `note for ${name}`, listId: 'col-1' }
}

function vcardUid(content: string) {
  return /\r?\nUID:([^\r\n]*)/.exec(content)?.[1]
}

function setup(collections = ['col-1', 'col-2']) {
  server = new FakeServer()
  for (const uid of collections) server.collection(uid)
  useEtebaseStore.setState({
    account: server.account() as any,
    accountFingerprint: 'fingerprint',
    collections: { calendar: [], tasks: [], contacts: collections.map((uid) => ({ uid })) as any[], notes: [], preferences: [] },
    itemCache: new Map(),
    itemTypeMap: new Map(),
    itemCollectionMap: new Map(),
    syncEngine: null,
  } as any)
}

async function importFile(contacts: ReturnType<typeof card>[], options: { onProgress?: (s: number, t: number) => void; onSkipped?: (n: number) => void } = {}) {
  return useContactStore.getState().importContacts(contacts, { fileImport: options })
}

async function outcomeOf(promise: Promise<number>): Promise<ImportIncompleteError> {
  const err = await promise.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(ImportIncompleteError)
  return err as ImportIncompleteError
}

beforeEach(() => {
  resetContactLifecycle()
  _resetUncertainFileImportsForTests()
  useContactStore.setState({ contacts: [], syncStatus: 'synced', searchQuery: '', contactSaveStates: {}, fileImport: null })
  useContactListStore.setState({ lists: [{ id: 'col-1', name: 'A', color: '#fff', visible: true, accessLevel: 2 }, { id: 'col-2', name: 'B', color: '#fff', visible: true, accessLevel: 2 }], activeListId: 'col-1' } as any)
  useAuthStore.setState({ canWrite: () => true } as any)
  toastMock.showErrorToast.mockReset()
  queueMock.enqueue.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  setup()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('file contact import: network policy', () => {
  it('retries a timed-out batch and saves everything, without the offline queue', async () => {
    vi.useFakeTimers()
    server.plan = ['hang', 'ok']
    const promise = importFile([card('Ada', 'a'), card('Bea', 'b')])
    await vi.advanceTimersByTimeAsync(FILE_IMPORT_TIMEOUT_MS + 1000)
    await expect(promise).resolves.toBe(2)
    expect(server.attempts).toHaveLength(2)
    expect(server.items('col-1')).toHaveLength(2)
    expect(queueMock.enqueue).not.toHaveBeenCalled()
  })

  it('marks a batch whose every attempt timed out uncertain and later batches not sent', async () => {
    vi.useFakeTimers()
    server.plan = ['ok', 'hang', 'hang', 'hang', 'hang']
    const promise = outcomeOf(importFile(Array.from({ length: 45 }, (_, i) => card(`P${i}`, `u${i}`))))
    await vi.advanceTimersByTimeAsync(5 * FILE_IMPORT_TIMEOUT_MS)
    const err = await promise
    expect(server.attempts).toHaveLength(5)
    expect(err.outcomes!.slice(0, 20).every((o) => o === 'saved')).toBe(true)
    expect(err.outcomes!.slice(20, 40).every((o) => o === 'uncertain')).toBe(true)
    expect(err.outcomes!.slice(40).every((o) => o === 'notSent')).toBe(true)
    expect(err.unsaved).toEqual(Array.from({ length: 25 }, (_, i) => 20 + i))
    expect(err.uncertain).toBe(true)
  })

  it('stops at a 413 after one attempt, with no backoff, as refused', async () => {
    server.plan = [{ status: 413 }]
    const err = await outcomeOf(importFile([card('Ada', 'a')]))
    expect(server.attempts).toHaveLength(1)
    expect(err.outcomes).toEqual(['refused'])
    expect(err.uncertain).toBe(false)
  })

  it('keeps a position uncertain when a 5xx came before a 413', async () => {
    vi.useFakeTimers()
    server.plan = [{ status: 502 }, { status: 413 }]
    const promise = outcomeOf(importFile([card('Ada', 'a')]))
    await vi.advanceTimersByTimeAsync(2000)
    expect((await promise).outcomes).toEqual(['uncertain'])
  })

  it('reports never-sent, refused and response-lost positions apart', async () => {
    vi.useFakeTimers()
    server.plan = ['ok', 'lost', { status: 413 }]
    const contacts = Array.from({ length: 41 }, (_, i) => card(`P${i}`, `u${i}`))
    const promise = outcomeOf(importFile(contacts))
    await vi.advanceTimersByTimeAsync(2000)
    const err = await promise
    // The lost response's batch committed, then its retry was refused: still uncertain.
    expect(err.outcomes!.slice(20, 40).every((o) => o === 'uncertain')).toBe(true)
    expect(err.outcomes![40]).toBe('notSent')
    server.plan = [{ status: 413 }]
    expect((await outcomeOf(importFile([card('Solo', 'solo')]))).outcomes).toEqual(['refused'])
  })
})

describe('file contact import: same-page retries never double-create', () => {
  it('final timeout, manual retry, then the late first commit: one item', async () => {
    vi.useFakeTimers()
    server.plan = ['hang', 'hang', 'hang', 'hang']
    const first = outcomeOf(importFile([card('Ada', 'a')]))
    await vi.advanceTimersByTimeAsync(5 * FILE_IMPORT_TIMEOUT_MS)
    expect((await first).outcomes).toEqual(['uncertain'])
    vi.useRealTimers()
    await expect(importFile([card('Ada', 'a')])).resolves.toBe(1)
    server.held.forEach((commit) => commit())
    expect(server.items('col-1')).toHaveLength(1)
  })

  it('a lost acknowledgement, then a retry: one item', async () => {
    vi.useFakeTimers()
    server.plan = ['lost', 'ok']
    const promise = importFile([card('Ada', 'a')])
    await vi.advanceTimersByTimeAsync(2000)
    await expect(promise).resolves.toBe(1)
    expect(server.items('col-1')).toHaveLength(1)
  })

  it('registry 1: after a 413, corrected content with the same UID uploads as a new item', async () => {
    server.plan = [{ status: 413 }]
    await outcomeOf(importFile([card('Too big', 'a')]))
    await expect(importFile([card('Corrected', 'a')])).resolves.toBe(1)
    const [content] = server.items('col-1')
    expect(content).toContain('FN:Corrected')
    expect(server.attempts[1]!.uids[0]).not.toBe(server.attempts[0]!.uids[0])
  })

  it('registry 2: a 413 on a manual retry keeps the entry while the first request can still commit', async () => {
    vi.useFakeTimers()
    server.plan = ['hang', 'hang', 'hang', 'hang']
    const first = outcomeOf(importFile([card('Ada', 'a')]))
    await vi.advanceTimersByTimeAsync(5 * FILE_IMPORT_TIMEOUT_MS)
    await first
    vi.useRealTimers()
    server.plan = [{ status: 413 }]
    expect((await outcomeOf(importFile([card('Ada', 'a')]))).outcomes).toEqual(['uncertain'])
    server.held[0]!()
    expect(server.items('col-1')).toHaveLength(1)
    // The next preflight finds the UID on the server: skipped, entry retired, nothing uploaded.
    const skipped = vi.fn()
    const attempts = server.attempts.length
    await expect(importFile([card('Ada', 'a')], { onSkipped: skipped })).resolves.toBe(0)
    expect(skipped).toHaveBeenCalledWith(1)
    expect(server.attempts).toHaveLength(attempts)
    expect(server.items('col-1')).toHaveLength(1)
  })

  it('registry 3: a different payload for an uncertain UID is not uploaded; the original is replayed', async () => {
    vi.useFakeTimers()
    server.plan = ['hang', 'hang', 'hang', 'hang']
    const first = outcomeOf(importFile([card('Original', 'a')]))
    await vi.advanceTimersByTimeAsync(5 * FILE_IMPORT_TIMEOUT_MS)
    await first
    vi.useRealTimers()
    await expect(importFile([card('Changed', 'a')])).resolves.toBe(1)
    expect(server.attempts.at(-1)!.uids).toEqual(server.attempts[0]!.uids)
    const contents = server.items('col-1')
    expect(contents).toHaveLength(1)
    expect(contents[0]).toContain('FN:Original')
    expect(useContactStore.getState().contacts.map((c) => c.displayName)).toEqual(['Original'])
  })
})

describe('file contact import: preflight and UIDs', () => {
  it('keeps the file UID in the uploaded content', async () => {
    await importFile([card('Ada', 'source-uid-1')])
    expect(vcardUid(server.items('col-1')[0]!)).toBe('source-uid-1')
  })

  it('skips UIDs already on the target list and reports original positions', async () => {
    server.seed('col-1', 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:a\r\nFN:A\r\nEND:VCARD')
    server.plan = [{ status: 413 }]
    const skipped = vi.fn()
    const err = await outcomeOf(importFile([card('A', 'a'), card('B', 'b')], { onSkipped: skipped }))
    expect(skipped).toHaveBeenCalledWith(1)
    expect(err.outcomes).toEqual(['skipped', 'refused'])
    expect(err.unsaved).toEqual([1])
  })

  it('re-import with A on the server sends only B', async () => {
    server.seed('col-1', 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:a\r\nFN:A\r\nEND:VCARD')
    await expect(importFile([card('A', 'a'), card('B', 'b')])).resolves.toBe(1)
    expect(server.attempts[0]!.uids).toHaveLength(1)
  })

  it("reads and writes the concrete first collection for the 'default' alias", async () => {
    server.seed('col-1', 'BEGIN:VCARD\r\nUID:a\r\nFN:A\r\nEND:VCARD')
    const result = await importFile([{ ...card('A', 'a'), listId: 'default' }, { ...card('B', 'b'), listId: 'default' }])
    expect(result).toBe(1)
    expect(server.attempts[0]!.collection).toBe('col-1')
  })

  it('does not skip a UID that exists only in another list', async () => {
    server.seed('col-2', 'BEGIN:VCARD\r\nUID:a\r\nFN:A\r\nEND:VCARD')
    await expect(importFile([card('A', 'a')])).resolves.toBe(1)
  })

  it('an unreadable item blocks only when it is in the target list', async () => {
    server.seed('col-2', 'x', true)
    await expect(importFile([card('A', 'a')])).resolves.toBe(1)
    server.seed('col-1', 'x', true)
    await expect(importFile([card('B', 'b')])).rejects.toMatchObject({ name: 'ImportReconcileFailedError' })
  })

  it('a held read times out and nothing is written', async () => {
    vi.useFakeTimers()
    server.listBehavior = 'hang'
    const promise = importFile([card('A', 'a')]).then(() => null, (e: unknown) => e)
    await vi.advanceTimersByTimeAsync(FILE_IMPORT_TIMEOUT_MS + 1)
    expect(await promise).toMatchObject({ name: 'ImportReconcileFailedError' })
    expect(server.attempts).toHaveLength(0)
  })

  it('sends nothing to a missing target', async () => {
    const err = await outcomeOf(importFile([{ ...card('A', 'a'), listId: 'gone' }]))
    expect(err.outcomes).toEqual(['notSent'])
    expect(err.uncertain).toBe(false)
    expect(server.attempts).toHaveLength(0)
  })

  it('stops when the account changes between the read and the write', async () => {
    const read = useEtebaseStore.getState().readCollectionVCardUids
    useEtebaseStore.setState({ readCollectionVCardUids: async (...args: Parameters<typeof read>) => { const result = await read(...args); bumpAccountEpoch(); return result } } as any)
    try {
      await expect(importFile([card('A', 'a')])).rejects.toBeInstanceOf(AccountBoundaryChangedError)
      expect(server.attempts).toHaveLength(0)
    } finally {
      useEtebaseStore.setState({ readCollectionVCardUids: read } as any)
    }
  })
})

describe('file contact import: progress and leave guard (real stores)', () => {
  const vcf = (count: number) => new File(
    [Array.from({ length: count }, (_, i) => `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:p${i}\r\nFN:Person ${i}\r\nEND:VCARD`).join('\r\n')],
    'contacts.vcf',
    { type: 'text/vcard' },
  )

  it('shows "Importing X of N…" and keeps the unload prompt after the page unmounts, until the import settles', async () => {
    for (const ending of ['success', 'failure'] as const) {
      setup()
      server.plan = ['ok', 'park']
      const view = renderWithIntl(<ContactImport onImportComplete={vi.fn()} />)
      fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [vcf(41)] } })
      fireEvent.click(await screen.findByRole('button', { name: 'Import 41 contacts' }))
      expect(await screen.findByRole('button', { name: 'Importing 20 of 41…' }, { timeout: 5000 })).toBeInTheDocument()
      view.unmount()

      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)

      await act(async () => { server.parked!(ending === 'success') })
      await waitFor(() => {
        const after = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(after)
        expect(after.defaultPrevented).toBe(false)
      })
    }
  })
})

describe('file contact import: account boundary and single flight', () => {
  it('resetContactLifecycle retires uncertain uploads, so nothing is replayed into the next session', async () => {
    vi.useFakeTimers()
    server.plan = ['hang', 'hang', 'hang', 'hang']
    const first = outcomeOf(importFile([card('Ada', 'a')]))
    await vi.advanceTimersByTimeAsync(5 * FILE_IMPORT_TIMEOUT_MS)
    expect((await first).outcomes).toEqual(['uncertain'])
    vi.useRealTimers()
    resetContactLifecycle()
    await expect(importFile([card('Ada', 'a')])).resolves.toBe(1)
    // A fresh item, not the earlier SDK item: the retry payload was dropped at the boundary.
    expect(server.attempts.at(-1)!.uids).not.toEqual(server.attempts[0]!.uids)
  })

  it('a remounted page shows the running import and a second import into the list is refused', async () => {
    const vcf = new File(
      [Array.from({ length: 41 }, (_, i) => `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:p${i}\r\nFN:Person ${i}\r\nEND:VCARD`).join('\r\n')],
      'contacts.vcf',
      { type: 'text/vcard' },
    )
    server.plan = ['ok', 'park']
    const first = renderWithIntl(<ContactImport onImportComplete={vi.fn()} />)
    fireEvent.change(first.container.querySelector('input[type="file"]')!, { target: { files: [vcf] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Import 41 contacts' }))
    expect(await screen.findByRole('button', { name: 'Importing 20 of 41…' }, { timeout: 5000 })).toBeInTheDocument()
    first.unmount()

    const again = renderWithIntl(<ContactImport onImportComplete={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Importing 20 of 41…' })).toBeDisabled()
    expect(again.container.querySelector('input[type="file"]')).toBeDisabled()
    const attempts = server.attempts.length
    await expect(importFile([card('Person 40', 'p40')])).rejects.toBeInstanceOf(ImportAlreadyRunningError)
    expect(server.attempts).toHaveLength(attempts)

    await act(async () => { server.parked!(true) })
    await waitFor(() => expect(screen.queryByRole('button', { name: /Importing/ })).toBeNull())
    expect(again.container.querySelector('input[type="file"]')).not.toBeDisabled()
    expect(server.items('col-1')).toHaveLength(41)
    again.unmount()
  })
})

describe('file contact import: account switch', () => {
  it('a new session is not busy and shows no count while the old preflight is still pending', async () => {
    server.listBehavior = 'hang'
    const pending = importFile(Array.from({ length: 41 }, (_, i) => card(`P${i}`, `u${i}`))).catch(() => undefined)
    await waitFor(() => expect(useContactStore.getState().fileImport).toEqual({ saved: 0, total: 41 }))
    bumpAccountEpoch()
    resetContactLifecycle()
    expect(useContactStore.getState().fileImport).toBeNull()
    const view = renderWithIntl(<ContactImport onImportComplete={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Importing/ })).toBeNull()
    expect(view.container.querySelector('input[type="file"]')).not.toBeDisabled()
    view.unmount()
    void pending
  })
})
