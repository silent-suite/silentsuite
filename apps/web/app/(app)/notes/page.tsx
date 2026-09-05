'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { ArrowLeft, Eye, Folder, Plus, Search, StickyNote, Trash2, WifiOff } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import type { DateFormat, Note, TimeFormat } from '@silentsuite/core'
import { useNoteStore } from '@/app/stores/use-note-store'
import { canWriteNotebook, newNoteNotebook, useNotebookStore, type Notebook } from '@/app/stores/use-notebook-store'
import { useSyncStore } from '@/app/stores/use-sync-store'
import { useSidebarStore } from '@/app/stores/use-sidebar-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'
import { formatDate } from '@/app/lib/date'
import { PullToRefresh } from '@/app/components/PullToRefresh'
import { MobileCollectionSheet } from '@/app/components/MobileCollectionSheet'
import { NotesEmptyState } from '@/app/components/empty-state'
import { ConfirmDialog } from '@/app/components/confirm-dialog'
import { MarkdownEditor } from './MarkdownEditor'

// The Markdown renderer is only needed once someone opens a preview.
const NoteMarkdownPreview = dynamic(
  () => import('./NoteMarkdownPreview').then((mod) => mod.NoteMarkdownPreview),
)

// Each save is a new encrypted revision on the server, so wait for a real pause.
const SAVE_DEBOUNCE_MS = 1500

const PREVIEW_CLASS = [
  'h-full overflow-y-auto rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-3 text-[0.9375rem] text-[rgb(var(--foreground))]',
  '[&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold',
  '[&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold',
  '[&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:text-base [&_h3]:font-semibold',
  '[&_p]:mb-2 [&_p]:leading-relaxed',
  '[&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5',
  '[&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:mb-0.5',
  '[&_a]:text-emerald-600 [&_a]:underline dark:[&_a]:text-emerald-400',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-[rgb(var(--border))] [&_blockquote]:pl-3 [&_blockquote]:text-[rgb(var(--muted))]',
  '[&_code]:rounded [&_code]:bg-[rgb(var(--background))] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]',
  '[&_pre]:mb-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-[rgb(var(--background))] [&_pre]:p-3',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_hr]:my-3 [&_hr]:border-[rgb(var(--border))]',
].join(' ')

type Draft = { title: string; content: string }

/** Autosave progress shown next to the editor. 'clean' renders nothing. */
type SaveState = 'clean' | 'pending' | 'saving' | 'saved' | 'failed'

const SAVE_STATE_KEY = {
  pending: 'saveStatePending',
  saving: 'saveStateSaving',
  saved: 'saveStateSaved',
  failed: 'saveStateFailed',
} as const

/**
 * Breakpoint at which the list and the editor sit side by side. A 320 px list
 * next to the open 240 px sidebar leaves a tablet no room for the editor, so
 * while the sidebar is open the split waits for lg and md keeps one pane.
 * Class names are spelled out so Tailwind can see them.
 */
const LAYOUT = {
  md: {
    list: 'md:w-80 md:border-r md:border-[rgb(var(--border))] md:pr-4',
    listWhileOpen: 'hidden md:flex',
    detailWhileClosed: 'hidden md:flex',
    backButton: 'md:hidden',
    placeholder: 'md:flex',
  },
  lg: {
    list: 'lg:w-80 lg:border-r lg:border-[rgb(var(--border))] lg:pr-4',
    listWhileOpen: 'hidden lg:flex',
    detailWhileClosed: 'hidden lg:flex',
    backButton: 'lg:hidden',
    placeholder: 'lg:flex',
  },
} as const

/**
 * Last-edit label for the list: the time for notes edited today, otherwise the
 * date in the user's preferred format (short month and day when following the
 * system format, with the year once it differs).
 */
function formatNoteDate(date: Date, dateFormat: DateFormat, timeFormat: TimeFormat, locale: string, now = new Date()): string {
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', hour12: timeFormat !== '24h' })
  }
  const sameYear = date.getFullYear() === now.getFullYear()
  return formatDate(date, dateFormat, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }, locale)
}

function NotebookChip({ label, color, selected, onClick }: {
  label: string
  /** Absent for the "All" chip. */
  color?: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
        selected
          ? 'border-transparent text-white'
          : 'border-[rgb(var(--border))] bg-[rgb(var(--surface))] text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]'
      }`}
      style={selected ? { backgroundColor: color ?? '#059669' } : undefined}
    >
      {color && (
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: selected ? 'rgba(255, 255, 255, 0.85)' : color }}
          aria-hidden="true"
        />
      )}
      {label}
    </button>
  )
}

function NoteRow({ note, notebook, selected, dateLabel, onSelect }: {
  note: Note
  /** Named on the row while the list spans several notebooks. */
  notebook?: Notebook
  selected: boolean
  dateLabel: string
  onSelect: () => void
}) {
  const t = useTranslations('Notes')
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        selected
          ? 'border-emerald-500/40 bg-emerald-500/10'
          : 'border-[rgb(var(--border))] bg-[rgb(var(--surface))] hover:border-[rgb(var(--muted))]/30'
      }`}
    >
      <div className="flex items-start gap-2">
        <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-[rgb(var(--muted))]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-[rgb(var(--foreground))]">
              {note.title.trim() || t('untitled')}
            </span>
            <time dateTime={note.updated_at.toISOString()} className="shrink-0 text-[11px] text-[rgb(var(--muted))]">
              {dateLabel}
            </time>
          </div>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-[rgb(var(--muted))]">
            {notebook && (
              <>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: notebook.color }} aria-hidden="true" />
                <span className="max-w-[45%] shrink-0 truncate">{notebook.name}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span className="min-w-0 truncate">{note.content.trim() || t('emptyNote')}</span>
          </span>
        </div>
      </div>
    </button>
  )
}

/**
 * Title input, a toolbar (notebook picker, save state, Preview toggle,
 * Delete) and a CodeMirror Markdown editor. Edits autosave after a short pause, on tab hide, and when
 * the editor unmounts (note switch or navigation). Mount with `key={note.id}`
 * so each note gets its own draft.
 */
function NoteEditor({ note, canWrite, notebooks, autoFocusTitle = false, onDelete, onMove }: {
  note: Note
  canWrite: boolean
  /** Choices for the notebook picker: the note's own plus every shown, writable notebook. */
  notebooks: Notebook[]
  /** Focus the title on mount, for a note the user has just created. */
  autoFocusTitle?: boolean
  /** Shows the Delete action when provided; the caller owns the confirmation. */
  onDelete?: () => void
  /** Moves the note to another notebook; resolves false when nothing moved. */
  onMove: (notebookId: string) => Promise<boolean>
}) {
  const t = useTranslations('Notes')
  const updateNote = useNoteStore((s) => s.updateNote)
  const titleRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(note.title)
  const [content, setContent] = useState(note.content)
  const [preview, setPreview] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('clean')
  const [moving, setMoving] = useState(false)
  const [moveFailed, setMoveFailed] = useState(false)
  // Latest typed values, and the last values the store accepted. While they
  // differ the draft is unsaved and a refresh of this note must not clobber it.
  const draftRef = useRef<Draft>({ title: note.title, content: note.content })
  const savedRef = useRef<Draft>({ title: note.title, content: note.content })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const inFlightRef = useRef(0)

  const isDirty = () => (
    draftRef.current.title !== savedRef.current.title || draftRef.current.content !== savedRef.current.content
  )

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const draft = draftRef.current
    if (draft.title === savedRef.current.title && draft.content === savedRef.current.content) return
    inFlightRef.current += 1
    setSaveState('saving')
    const settle = (saved: boolean) => {
      inFlightRef.current -= 1
      if (inFlightRef.current > 0) return
      setSaveState(!saved ? 'failed' : isDirty() ? 'pending' : 'saved')
    }
    // Serialize saves so two flushes never race on the same Etebase item.
    saveChainRef.current = saveChainRef.current
      .then(() => updateNote(note.id, draft))
      .then((saved) => {
        if (saved) savedRef.current = draft
        settle(saved)
      })
      .catch(() => settle(false))
  }, [note.id, updateNote])

  const schedule = useCallback((patch: Partial<Draft>) => {
    draftRef.current = { ...draftRef.current, ...patch }
    setMoveFailed(false)
    if (inFlightRef.current === 0) setSaveState('pending')
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS)
  }, [flush])

  // Adopt refreshed store values (sync from another device) unless a draft is unsaved.
  useEffect(() => {
    const draft = draftRef.current
    if (draft.title !== savedRef.current.title || draft.content !== savedRef.current.content) return
    setTitle(note.title)
    setContent(note.content)
    draftRef.current = { title: note.title, content: note.content }
    savedRef.current = draftRef.current
  }, [note.title, note.content])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      flush()
    }
  }, [flush])

  // A new note arrives with a default title; select it so typing replaces it.
  useEffect(() => {
    if (!autoFocusTitle) return
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [autoFocusTitle])

  // A move recreates the note as a new item in the target notebook, so any
  // pending draft is saved under the current item first.
  const handleMove = async (notebookId: string) => {
    if (notebookId === note.notebookId) return
    setMoving(true)
    setMoveFailed(false)
    try {
      flush()
      await saveChainRef.current
      if (!(await onMove(notebookId))) setMoveFailed(true)
    } finally {
      setMoving(false)
    }
  }

  const currentNotebook = notebooks.find((notebook) => notebook.id === note.notebookId)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <input
        ref={titleRef}
        type="text"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value)
          schedule({ title: e.target.value })
        }}
        placeholder={t('titlePlaceholder')}
        aria-label={t('titleLabel')}
        readOnly={!canWrite}
        // Browser spellcheck and writing suggestions can send text to third-party
        // services; the body editor disables them too.
        spellCheck={false}
        autoComplete="off"
        data-gramm="false"
        className={`w-full border-b border-[rgb(var(--border))] bg-transparent pb-2 text-lg font-semibold text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none ${!canWrite ? 'opacity-60' : ''}`}
      />
      {/* Wraps when the column is narrow, so the buttons drop below the picker instead of overlapping it. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="flex min-w-0 flex-1 basis-56 items-center gap-2">
          {/* The picker doubles as the indicator of where the note lives. */}
          <label className="flex min-w-0 items-center gap-1.5">
            <span className="sr-only">{t('notebookLabel')}</span>
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: currentNotebook?.color ?? 'rgb(var(--muted))' }}
              aria-hidden="true"
            />
            <select
              value={note.notebookId ?? ''}
              onChange={(e) => void handleMove(e.target.value)}
              disabled={!canWrite || moving || notebooks.length < 2}
              className="min-w-0 max-w-[11rem] rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] py-1 pl-2 pr-6 text-xs text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-60"
            >
              {notebooks.map((notebook) => (
                <option key={notebook.id} value={notebook.id}>{notebook.name}</option>
              ))}
            </select>
          </label>
          <span
            role="status"
            aria-live="polite"
            className={`min-w-0 truncate text-xs ${moveFailed || saveState === 'failed' ? 'text-amber-500' : 'text-[rgb(var(--muted))]'}`}
          >
            {moveFailed ? t('moveFailed') : saveState === 'clean' ? '' : t(SAVE_STATE_KEY[saveState])}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* A toggle keeps its label; aria-pressed and the pressed style carry the state. */}
          <button
            type="button"
            onClick={() => setPreview((value) => !value)}
            aria-pressed={preview}
            aria-label={t('preview')}
            className={`touch-target gap-1.5 rounded-lg border px-3 text-sm text-[rgb(var(--foreground))] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
              preview
                ? 'border-emerald-500/40 bg-emerald-500/10'
                : 'border-[rgb(var(--border))] hover:bg-[rgb(var(--surface))]'
            }`}
          >
            <Eye className="h-4 w-4" />
            <span className="hidden sm:inline">{t('preview')}</span>
          </button>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              aria-label={t('deleteNote')}
              className="touch-target gap-1.5 rounded-lg px-3 text-sm text-[rgb(var(--muted))] transition-colors hover:bg-[rgb(var(--surface))] hover:text-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              <Trash2 className="h-4 w-4" />
              <span className="hidden sm:inline">{t('delete')}</span>
            </button>
          )}
        </div>
      </div>
      {preview && (
        <div className={PREVIEW_CLASS} data-testid="note-preview">
          <NoteMarkdownPreview content={content} />
        </div>
      )}
      {/* Hidden rather than unmounted while previewing, so undo history and cursor survive the toggle. */}
      <MarkdownEditor
        value={content}
        onChange={(next) => {
          setContent(next)
          schedule({ content: next })
        }}
        placeholder={t('bodyPlaceholder')}
        ariaLabel={t('bodyLabel')}
        readOnly={!canWrite}
        className={preview
          ? 'hidden'
          : `min-h-[16rem] flex-1 overflow-hidden rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] focus-within:ring-2 focus-within:ring-emerald-500 ${!canWrite ? 'opacity-60' : ''}`}
      />
    </div>
  )
}

export default function NotesPage() {
  const t = useTranslations('Notes')
  const collectionsT = useTranslations('Collections')
  const canWrite = useAuthStore((s) => s.canWrite())
  const notes = useNoteStore((s) => s.notes)
  const isLoading = useNoteStore((s) => s.isLoading)
  const createNote = useNoteStore((s) => s.createNote)
  const deleteNote = useNoteStore((s) => s.deleteNote)
  const canWriteNote = useNoteStore((s) => s.canWriteNote)
  const isOnline = useSyncStore((s) => s.isOnline)
  const notebooks = useNotebookStore((s) => s.lists)
  const activeListId = useNotebookStore((s) => s.activeListId)
  const moveNote = useNoteStore((s) => s.moveNote)
  const isSidebarExpanded = useSidebarStore((s) => s.isExpanded)
  const setSidebarExpanded = useSidebarStore((s) => s.setExpanded)
  const layout = LAYOUT[isSidebarExpanded ? 'lg' : 'md']
  const dateFormat = usePreferencesStore((s) => s.dateFormat)
  const timeFormat = usePreferencesStore((s) => s.timeFormat)
  const locale = useLocale()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // The note just created here; its title gets focus so typing can start at once.
  const [newNoteId, setNewNoteId] = useState<string | null>(null)
  const [collectionSheetOpen, setCollectionSheetOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [query, setQuery] = useState('')
  // 'all', or the id of the one notebook the list is narrowed to.
  const [notebookFilter, setNotebookFilter] = useState('all')

  // Hidden notebooks filter the list, newest edits first.
  const visibleNotes = useMemo(() => {
    const hidden = new Set(notebooks.filter((notebook) => !notebook.visible).map((notebook) => notebook.id))
    return notes
      .filter((note) => !note.notebookId || !hidden.has(note.notebookId))
      .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
  }, [notes, notebooks])

  const visibleNotebooks = useMemo(() => notebooks.filter((notebook) => notebook.visible), [notebooks])
  const notebookById = useMemo(() => new Map(notebooks.map((notebook) => [notebook.id, notebook])), [notebooks])
  const filteredNotebook = notebookFilter === 'all' ? null : notebookById.get(notebookFilter) ?? null
  // Rows name their notebook only while the list mixes several.
  const showNotebookOnRows = filteredNotebook === null && visibleNotebooks.length > 1

  // The notebook filter narrows first; search then runs over already-decrypted
  // notes, so nothing about the query leaves the browser.
  const listedNotes = useMemo(() => {
    const inNotebook = filteredNotebook
      ? visibleNotes.filter((note) => note.notebookId === filteredNotebook.id)
      : visibleNotes
    const needle = query.trim().toLowerCase()
    if (!needle) return inNotebook
    return inNotebook.filter((note) => (
      note.title.toLowerCase().includes(needle) || note.content.toLowerCase().includes(needle)
    ))
  }, [visibleNotes, filteredNotebook, query])

  const selectedNote = visibleNotes.find((note) => note.id === selectedId) ?? null
  const canEditSelected = selectedNote !== null && canWriteNote(selectedNote)
  // Where New note puts a note: the filtered notebook, the starred default,
  // the open note's notebook, or the first shown writable notebook by name.
  const newNoteTarget = useMemo(
    () => newNoteNotebook(notebooks, activeListId, { filterId: filteredNotebook?.id, openNotebookId: selectedNote?.notebookId }),
    [notebooks, activeListId, filteredNotebook?.id, selectedNote?.notebookId],
  )
  const canCreateNote = canWrite && !isLoading && newNoteTarget !== undefined
  // The picker offers every shown writable notebook, plus the note's own so it always shows.
  const pickerNotebooks = useMemo(() => {
    const targets = notebooks.filter((notebook) => notebook.visible && canWriteNotebook(notebook))
    const own = selectedNote?.notebookId ? notebookById.get(selectedNote.notebookId) : undefined
    return own && !targets.includes(own) ? [own, ...targets] : targets
  }, [notebooks, notebookById, selectedNote?.notebookId])

  useEffect(() => {
    if (selectedId && !visibleNotes.some((note) => note.id === selectedId)) setSelectedId(null)
  }, [selectedId, visibleNotes])

  // A filter on a notebook that was hidden or deleted falls back to all notebooks.
  useEffect(() => {
    if (notebookFilter !== 'all' && !visibleNotebooks.some((notebook) => notebook.id === notebookFilter)) setNotebookFilter('all')
  }, [notebookFilter, visibleNotebooks])

  const handleCreate = useCallback(async () => {
    if (!newNoteTarget || !canCreateNote) return
    try {
      const created = await createNote({ notebookId: newNoteTarget.id })
      setQuery('')
      setNewNoteId(created.id)
      setSelectedId(created.id)
    } catch {
      // Nothing was added locally; the store already reported the failure.
    }
  }, [canCreateNote, createNote, newNoteTarget])

  // The moved note is a new Etebase item, so the selection follows its new id.
  const handleMove = useCallback(async (noteId: string, notebookId: string) => {
    const movedId = await moveNote(noteId, notebookId)
    if (movedId) setSelectedId(movedId)
    return movedId !== null
  }, [moveNote])

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {!isOnline && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          {t('offlineMessage')}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {selectedNote && (
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              aria-label={t('backToNotes')}
              className={`touch-target rounded-md text-[rgb(var(--muted))] transition-colors hover:bg-[rgb(var(--surface))] hover:text-[rgb(var(--foreground))] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 ${layout.backButton}`}
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">{t('title')}</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCollectionSheetOpen(true)}
            aria-label={collectionsT('manageNotebooks')}
            className="touch-target rounded-md text-[rgb(var(--muted))] transition-colors hover:bg-[rgb(var(--surface))] hover:text-[rgb(var(--foreground))] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 md:hidden"
          >
            <Folder className="h-5 w-5" />
          </button>
          {/* Notebooks are managed in the sidebar; while it is collapsed this reveals it.
              Hidden below md with a variant, because touch-target also sets display
              and would override a plain `hidden`. */}
          {!isSidebarExpanded && (
            <button
              type="button"
              onClick={() => setSidebarExpanded(true)}
              aria-label={collectionsT('manageNotebooks')}
              title={collectionsT('manageNotebooks')}
              className="touch-target max-md:hidden rounded-md text-[rgb(var(--muted))] transition-colors hover:bg-[rgb(var(--surface))] hover:text-[rgb(var(--foreground))] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
            >
              <Folder className="h-5 w-5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!canCreateNote}
            title={!canWrite ? t('subscriptionRequired') : newNoteTarget ? t('newNoteIn', { name: newNoteTarget.name }) : !isLoading ? t('noWritableNotebook') : undefined}
            className={`flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 ${!canCreateNote ? 'cursor-not-allowed opacity-50' : 'hover:bg-emerald-500'}`}
          >
            <Plus className="h-4 w-4" />
            {t('newNote')}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        <div className={`w-full shrink-0 ${layout.list} ${selectedNote ? layout.listWhileOpen : 'flex'} min-h-0 flex-col`}>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-12 rounded-lg skeleton-shimmer" />
              ))}
            </div>
          ) : visibleNotes.length === 0 ? (
            <NotesEmptyState
              title={notes.length > 0 ? t('noVisibleNotes') : t('noNotesYet')}
              description={notes.length > 0 ? t('noVisibleNotesDescription') : t('emptyDescription')}
              actionLabel={t('newNote')}
              onAddNote={canCreateNote ? () => void handleCreate() : undefined}
            />
          ) : (
            <>
              {visibleNotebooks.length > 1 && (
                <div role="group" aria-label={t('notebookFilterLabel')} className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5">
                  <NotebookChip label={t('allNotebooks')} selected={notebookFilter === 'all'} onClick={() => setNotebookFilter('all')} />
                  {visibleNotebooks.map((notebook) => (
                    <NotebookChip
                      key={notebook.id}
                      label={notebook.name}
                      color={notebook.color}
                      selected={notebookFilter === notebook.id}
                      onClick={() => setNotebookFilter(notebook.id)}
                    />
                  ))}
                </div>
              )}
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[rgb(var(--muted))]" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('searchPlaceholder')}
                  aria-label={t('searchLabel')}
                  spellCheck={false}
                  autoComplete="off"
                  className="w-full rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] py-2 pl-9 pr-3 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              {listedNotes.length === 0 ? (
                query.trim() ? (
                  <NotesEmptyState
                    title={t('noSearchResults')}
                    description={t('noSearchResultsDescription')}
                    actionLabel={t('newNote')}
                  />
                ) : (
                  <NotesEmptyState
                    title={t('noNotesInNotebook', { name: filteredNotebook?.name ?? '' })}
                    description={t('noNotesInNotebookDescription')}
                    actionLabel={t('newNote')}
                    onAddNote={canCreateNote ? () => void handleCreate() : undefined}
                  />
                )
              ) : (
                <div className="min-h-0 flex-1">
                  <PullToRefresh>
                    <div className="space-y-1.5">
                      {listedNotes.map((note) => (
                        <NoteRow
                          key={note.id}
                          note={note}
                          notebook={showNotebookOnRows && note.notebookId ? notebookById.get(note.notebookId) : undefined}
                          selected={note.id === selectedId}
                          dateLabel={formatNoteDate(note.updated_at, dateFormat, timeFormat, locale)}
                          onSelect={() => {
                            setNewNoteId(null)
                            setSelectedId(note.id)
                          }}
                        />
                      ))}
                    </div>
                  </PullToRefresh>
                </div>
              )}
            </>
          )}
        </div>

        <div className={`min-w-0 flex-1 ${selectedNote ? 'flex' : layout.detailWhileClosed} min-h-0 flex-col`}>
          {selectedNote ? (
            <NoteEditor
              key={selectedNote.id}
              note={selectedNote}
              canWrite={canEditSelected}
              notebooks={pickerNotebooks}
              autoFocusTitle={selectedNote.id === newNoteId}
              onDelete={canEditSelected ? () => setConfirmDelete(true) : undefined}
              onMove={(notebookId) => handleMove(selectedNote.id, notebookId)}
            />
          ) : (
            <div className={`hidden flex-1 items-center justify-center rounded-lg border border-dashed border-[rgb(var(--border))] text-sm text-[rgb(var(--muted))] ${layout.placeholder}`}>
              {t('selectNote')}
            </div>
          )}
        </div>
      </div>

      {confirmDelete && selectedNote && (
        <ConfirmDialog
          title={t('deleteConfirmTitle')}
          message={t('deleteConfirmMessage', { title: selectedNote.title.trim() || t('untitled') })}
          confirmLabel={t('deleteNote')}
          onConfirm={() => {
            setConfirmDelete(false)
            void deleteNote(selectedNote.id)
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      <MobileCollectionSheet
        type="notes"
        open={collectionSheetOpen}
        onClose={() => setCollectionSheetOpen(false)}
      />
    </div>
  )
}
