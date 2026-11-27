export const DEFAULT_LANG = 'en_US'

const dict = {
  'Starting SilentSuite': 0,
  Database: 1,
  'The database is ready': 2,
  'Waiting for the database': 3,
  'Sync server': 4,
  'The sync server is ready': 5,
  'Waiting for the sync server': 6,
  'Web app': 7,
  'The web app is ready': 8,
  'Waiting for the web app': 9,
  'Web interface': 10,
  'SilentSuite is ready': 11,
  'Waiting for SilentSuite': 12,
  'Web app and sync address': 13,
  'Open SilentSuite in the browser. Use the same https address as the server address in the SilentSuite apps.': 14,
  'Show Installation Password': 15,
  'Shows the installation password that every new SilentSuite account needs at sign-up.': 16,
  'Installation password': 17,
  'Use this as the installation password when you choose Sign up. Your account password is separate and never leaves your device.': 18,
} as const

/**
 * Plumbing. DO NOT EDIT.
 */
export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
