/**
 * Self-hosted mode detection.
 * When NEXT_PUBLIC_SELF_HOSTED is set to "true", the app runs without
 * the billing API — all features are unlocked and billing UI is hidden.
 */
export const isSelfHosted = process.env.NEXT_PUBLIC_SELF_HOSTED === 'true'
