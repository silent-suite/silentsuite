import { afterEach, describe, expect, it } from 'vitest'
import { bumpAccountEpoch, getAccountEpoch } from '../account-epoch'
import {
  clearNotePreviewVerdict,
  markNotePreviewFormatAnywayFailed,
  notePreviewFormatAnyway,
  notePreviewWasOk,
  rememberNotePreviewFormatAnyway,
  rememberNotePreviewOk,
} from '../note-preview-verdict'

describe('the remembered Notes preview verdict', () => {
  afterEach(() => clearNotePreviewVerdict())

  it('knows only the last body that was ok', () => {
    rememberNotePreviewOk('first', getAccountEpoch())
    expect(notePreviewWasOk('first')).toBe(true)
    expect(notePreviewWasOk('second')).toBe(false)

    rememberNotePreviewOk('second', getAccountEpoch())
    expect(notePreviewWasOk('second')).toBe(true)
    expect(notePreviewWasOk('first')).toBe(false)
  })

  it('ends at an account boundary, so one account never sees what another previewed', () => {
    rememberNotePreviewOk('body', getAccountEpoch())
    bumpAccountEpoch()
    expect(notePreviewWasOk('body')).toBe(false)
  })

  it('does not keep a body whose epoch was read before an account boundary', () => {
    const sent = getAccountEpoch()
    bumpAccountEpoch()
    rememberNotePreviewOk('body', sent)
    expect(notePreviewWasOk('body')).toBe(false)
  })

  it('can be cleared', () => {
    rememberNotePreviewOk('body', getAccountEpoch())
    clearNotePreviewVerdict()
    expect(notePreviewWasOk('body')).toBe(false)
  })
})

describe('the remembered choice to format a Notes preview anyway', () => {
  afterEach(() => clearNotePreviewVerdict())

  it('holds for that exact body only, and only for the last body chosen', () => {
    expect(rememberNotePreviewFormatAnyway('first', getAccountEpoch())).toBe(true)
    expect(notePreviewFormatAnyway('first')).toBe('chosen')
    expect(notePreviewFormatAnyway('first ')).toBe('none')
    expect(notePreviewFormatAnyway('second')).toBe('none')

    rememberNotePreviewFormatAnyway('second', getAccountEpoch())
    expect(notePreviewFormatAnyway('second')).toBe('chosen')
    expect(notePreviewFormatAnyway('first')).toBe('none')
  })

  it('is not an ok verdict: the body did not parse in time', () => {
    rememberNotePreviewFormatAnyway('body', getAccountEpoch())
    expect(notePreviewWasOk('body')).toBe(false)
  })

  it('ends at an account boundary, and is refused when the epoch was read before one', () => {
    rememberNotePreviewFormatAnyway('body', getAccountEpoch())
    bumpAccountEpoch()
    expect(notePreviewFormatAnyway('body')).toBe('none')

    const shown = getAccountEpoch()
    bumpAccountEpoch()
    expect(rememberNotePreviewFormatAnyway('body', shown)).toBe(false)
    expect(notePreviewFormatAnyway('body')).toBe('none')
  })

  it('remembers a forced parse that failed, for that body, apart from a later choice', () => {
    rememberNotePreviewFormatAnyway('broken', getAccountEpoch())
    markNotePreviewFormatAnywayFailed('broken')
    expect(notePreviewFormatAnyway('broken')).toBe('failed')

    rememberNotePreviewFormatAnyway('other', getAccountEpoch())
    expect(notePreviewFormatAnyway('other')).toBe('chosen')
    expect(notePreviewFormatAnyway('broken')).toBe('failed')
  })

  it('marks a failure only for the body that was chosen', () => {
    rememberNotePreviewFormatAnyway('chosen body', getAccountEpoch())
    markNotePreviewFormatAnywayFailed('another body')
    expect(notePreviewFormatAnyway('another body')).toBe('none')
    expect(notePreviewFormatAnyway('chosen body')).toBe('chosen')
  })

  it('ends a failure mark at an account boundary', () => {
    rememberNotePreviewFormatAnyway('broken', getAccountEpoch())
    markNotePreviewFormatAnywayFailed('broken')
    bumpAccountEpoch()
    expect(notePreviewFormatAnyway('broken')).toBe('none')
  })

  it('is cleared with the verdict', () => {
    rememberNotePreviewFormatAnyway('chosen', getAccountEpoch())
    rememberNotePreviewFormatAnyway('broken', getAccountEpoch())
    markNotePreviewFormatAnywayFailed('broken')
    rememberNotePreviewFormatAnyway('chosen', getAccountEpoch())
    clearNotePreviewVerdict()
    expect(notePreviewFormatAnyway('chosen')).toBe('none')
    expect(notePreviewFormatAnyway('broken')).toBe('none')
  })
})
