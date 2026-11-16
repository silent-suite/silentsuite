/**
 * Why creating a note produced no note, when the store knows:
 * - 'queue-refused': the offline queue would not hold the new note, which it
 *   cannot do for a note's text, so the note needs a connection;
 * - 'failed': the request to the server, or the queue, failed another way;
 * - 'unavailable': there was no account session or notebook collection to create it in.
 */
export type NoteCreateRefusalReason = 'queue-refused' | 'failed' | 'unavailable'

/** Thrown by `createNote` when no note was created for one of those reasons. The store shows no toast for it. */
export class NoteCreateRefusedError extends Error {
  readonly reason: NoteCreateRefusalReason

  constructor(reason: NoteCreateRefusalReason) {
    super('Note could not be saved.')
    this.name = 'NoteCreateRefusedError'
    this.reason = reason
  }
}
