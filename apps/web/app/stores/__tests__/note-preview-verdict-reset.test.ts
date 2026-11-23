import { afterEach, describe, expect, it } from 'vitest'
import { getAccountEpoch } from '@/app/lib/account-epoch'
import {
  clearNotePreviewVerdict,
  markNotePreviewFormatAnywayFailed,
  notePreviewFormatAnyway,
  notePreviewWasOk,
  rememberNotePreviewFormatAnyway,
  rememberNotePreviewOk,
} from '@/app/lib/note-preview-verdict'
import { resetNoteLifecycle } from '../use-note-store'

describe('account reset and the remembered Notes preview verdict', () => {
  afterEach(() => clearNotePreviewVerdict())

  it('drops the body the preview last parsed in time, which is decrypted note text', () => {
    rememberNotePreviewOk('decrypted note body', getAccountEpoch())
    expect(notePreviewWasOk('decrypted note body')).toBe(true)

    resetNoteLifecycle()

    expect(notePreviewWasOk('decrypted note body')).toBe(false)
  })

  it('drops the body chosen to format anyway, and a forced parse that failed, which are decrypted note text too', () => {
    rememberNotePreviewFormatAnyway('failed body', getAccountEpoch())
    markNotePreviewFormatAnywayFailed('failed body')
    rememberNotePreviewFormatAnyway('chosen body', getAccountEpoch())
    expect(notePreviewFormatAnyway('chosen body')).toBe('chosen')
    expect(notePreviewFormatAnyway('failed body')).toBe('failed')

    resetNoteLifecycle()

    expect(notePreviewFormatAnyway('chosen body')).toBe('none')
    expect(notePreviewFormatAnyway('failed body')).toBe('none')
  })
})
