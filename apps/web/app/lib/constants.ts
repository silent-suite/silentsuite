/**
 * Named duration and timing constants.
 *
 * Use these instead of inline magic numbers so intent is clear and values
 * are easy to find / change in one place.
 */

// ── Time unit multipliers (ms) ──────────────────────────────────────────
export const MS_PER_SECOND = 1_000
export const MS_PER_MINUTE = 60 * MS_PER_SECOND
export const MS_PER_HOUR = 60 * MS_PER_MINUTE
export const MS_PER_DAY = 24 * MS_PER_HOUR

// ── Cookie / session lifetimes (seconds) ────────────────────────────────
/** Self-hosted admin cookie lifetime: 7 days */
export const COOKIE_MAX_AGE_SELF_HOSTED = 7 * 24 * 60 * 60
/** Hosted admin cookie lifetime: 15 minutes */
export const COOKIE_MAX_AGE_HOSTED = 15 * 60

// ── UI toast / feedback durations (ms) ──────────────────────────────────
export const TOAST_DURATION_MS = 5_000
export const COPY_FEEDBACK_MS = 2_000
export const PHASE_TRANSITION_MS = 2_500
export const UNDO_TOAST_MS = 5_000

// ── Notification scheduler ──────────────────────────────────────────────
export const NOTIFICATION_LOOKAHEAD_MS = MS_PER_DAY
export const NOTIFICATION_MAX_FUTURE_MS = 14 * MS_PER_DAY
