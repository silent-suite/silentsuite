/**
 * Why creating a note produced no note in the list, when the store knows:
 * - 'queue-refused': the offline queue would not hold the new note, which it
 *   cannot do for a note's text, so the note needs a connection;
 * - 'failed': the request to the server, or the queue, failed another way;
 * - 'queued': the create was queued for replay when the connection returns;
 * - 'no-session': the account is not unlocked on this page (no Etebase session);
 * - 'unavailable': the session is there but no queue guard or notebook collection was.
 */
export type NoteNotCreatedReason = 'queue-refused' | 'failed' | 'queued' | 'no-session' | 'unavailable'

/** Thrown by `createNote` when no note was added to the list. The store shows no toast for it. */
export class NoteNotCreatedError extends Error {
  readonly reason: NoteNotCreatedReason

  constructor(reason: NoteNotCreatedReason) {
    super('Note could not be saved.')
    this.name = 'NoteNotCreatedError'
    this.reason = reason
  }
}
