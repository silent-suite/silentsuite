/** Per input position: acknowledged, left out because already on the server, never sent,
 * refused in full by the server, or possibly saved (an attempt's outcome is unknown). */
export type ImportPositionOutcome = 'saved' | 'skipped' | 'notSent' | 'refused' | 'uncertain'

/**
 * An import in which the server did not acknowledge every record. `saved` counts
 * acknowledged records; `unsaved` holds the input positions, in order, of the rest.
 * An unacknowledged record may still exist remotely when a response was lost, so
 * `uncertain` is false when every unsaved input is known not to have been sent.
 * File contact imports also carry `outcomes`, one per original input position.
 */
export class ImportIncompleteError extends Error {
  constructor(
    readonly saved: number,
    readonly unsaved: number[],
    readonly uncertain: boolean,
    readonly outcomes?: readonly ImportPositionOutcome[],
  ) {
    super(`Imported ${saved} of ${saved + unsaved.length} records`)
    this.name = 'ImportIncompleteError'
  }
}

/** Thrown when a file import could not read what is already saved, before anything was written. */
export class ImportReconcileFailedError extends Error {
  constructor() {
    super('Could not read the target collection before importing')
    this.name = 'ImportReconcileFailedError'
  }
}
