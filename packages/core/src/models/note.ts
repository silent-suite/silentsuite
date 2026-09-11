import type { ItemMeta } from '../etebase/types.js';

/**
 * Etebase Markdown note (collection type `etebase.md.note`). The Etebase item
 * content is the Markdown body; the title and modification time live in the
 * item metadata (`name`, `mtime`).
 */
export interface Note {
  id: string;
  uid: string;
  title: string;
  /** Markdown or plain-text body. This is the Etebase item content. */
  content: string;
  notebookId?: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Etebase Markdown notes: an empty/missing item type is a note. Any other
 * type (e.g. future attachments) must be skipped by clients.
 */
export function isMarkdownNoteItem(meta: { type?: string | null } | null | undefined): boolean {
  if (!meta) return true;
  return meta.type == null || meta.type === '';
}

/** Largest millisecond offset from the epoch that a Date can represent. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * Note mtimes come from synced (possibly shared) item metadata and the local
 * cache, so anything that would make an Invalid Date falls back to now.
 */
function validMtime(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MS
    ? value
    : Date.now();
}

export function noteToItemMeta(note: Pick<Note, 'title' | 'updated_at'>): ItemMeta {
  return {
    name: note.title,
    mtime: validMtime(note.updated_at.getTime()),
  };
}

export function noteFromEtebaseItem(
  uid: string,
  markdown: string,
  meta: ItemMeta | null | undefined,
  notebookId?: string,
): Note {
  const mtime = validMtime(meta?.mtime);
  const title = typeof meta?.name === 'string' && meta.name.trim()
    ? meta.name
    : 'Untitled';
  return {
    id: uid,
    uid,
    title,
    content: markdown,
    notebookId,
    created_at: new Date(mtime),
    updated_at: new Date(mtime),
  };
}

interface NoteCacheEnvelope {
  title: string;
  content: string;
  mtime: number;
}

function isNoteCacheEnvelope(value: unknown): value is NoteCacheEnvelope {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  // mtime is range-checked when read, so a bad date never costs the body.
  return typeof record.title === 'string'
    && typeof record.content === 'string'
    && typeof record.mtime === 'number';
}

/**
 * Local encrypted-cache format only: the body plus the metadata the Etebase
 * item keeps outside its content. Etebase item content stays raw Markdown.
 */
export function serializeNote(note: Note): string {
  const envelope: NoteCacheEnvelope = {
    title: note.title,
    content: note.content,
    mtime: validMtime(note.updated_at.getTime()),
  };
  return JSON.stringify(envelope);
}

/** Inverse of serializeNote; tolerates a raw Markdown body as a fallback. */
export function deserializeNote(raw: string, uid: string, notebookId?: string): Note {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isNoteCacheEnvelope(parsed)) {
      const mtime = validMtime(parsed.mtime);
      return {
        id: uid,
        uid,
        title: parsed.title.trim() ? parsed.title : 'Untitled',
        content: parsed.content,
        notebookId,
        created_at: new Date(mtime),
        updated_at: new Date(mtime),
      };
    }
  } catch {
    // Not an envelope: treat the whole string as the body.
  }
  return noteFromEtebaseItem(uid, raw, { name: 'Untitled' }, notebookId);
}
