/**
 * Conditional logger that suppresses debug/info output in production.
 * console.error is always passed through for real error reporting.
 */
const isDev = process.env.NODE_ENV !== 'production'

export const logger = {
  /** Debug-level logging — suppressed in production */
  debug: (...args: unknown[]) => {
    if (isDev) console.debug(...args)
  },
  /** Info-level logging — suppressed in production */
  log: (...args: unknown[]) => {
    if (isDev) console.log(...args)
  },
  /** Warning-level logging — suppressed in production */
  warn: (...args: unknown[]) => {
    if (isDev) console.warn(...args)
  },
  /** Error-level logging — always active */
  error: (...args: unknown[]) => {
    console.error(...args)
  },
}
