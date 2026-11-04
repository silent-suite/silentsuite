import { describe, expect, it, vi } from 'vitest'
import en from '../../messages/en.json'

// A deliberately partial Italian catalogue: proves future missing keys fall back
// to English per nested key instead of rendering raw message keys.
vi.mock('../../messages/it.json', () => ({
  default: {
    Navigation: { calendar: 'Calendario' },
    SettingsSecurity: { AccountFingerprint: { title: 'Impronta' } },
  },
}))

describe('Italian messages with nested English fallback', () => {
  it('keeps Italian values and fills every missing nested key from English', async () => {
    const { getMessagesForLocale } = await import('../messages')
    const messages = getMessagesForLocale('it') as typeof en

    expect(messages.Navigation.calendar).toBe('Calendario')
    expect(messages.Navigation.tasks).toBe(en.Navigation.tasks)
    expect(messages.SettingsSecurity.AccountFingerprint.title).toBe('Impronta')
    expect(messages.SettingsSecurity.AccountFingerprint.copy).toBe(en.SettingsSecurity.AccountFingerprint.copy)
    expect(messages.SettingsSecurity.RestoreDiagnostics).toEqual(en.SettingsSecurity.RestoreDiagnostics)
    expect(messages.Notes).toEqual(en.Notes)
  })

  it('does not mutate the source catalogues and returns English unchanged for en', async () => {
    const { getMessagesForLocale } = await import('../messages')
    const itModule = await import('../../messages/it.json')
    const snapshot = JSON.stringify(en)
    getMessagesForLocale('it')
    expect(JSON.stringify(en)).toBe(snapshot)
    expect(itModule.default).toEqual({
      Navigation: { calendar: 'Calendario' },
      SettingsSecurity: { AccountFingerprint: { title: 'Impronta' } },
    })
    expect(getMessagesForLocale('en')).toEqual(en)
  })
})
