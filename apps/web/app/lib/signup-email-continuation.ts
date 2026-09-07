import type { AnnualOfferResponse, EmailOwnership } from '@/app/lib/billing-v2'

/** One mounted email-link lineage. Bearer proof stays in memory, never storage. */
export function createEmailLinkContinuation(
  consume: () => Promise<EmailOwnership>,
  loadOffer: () => Promise<AnnualOfferResponse>,
) {
  let proof: EmailOwnership | null = null
  let consumption: Promise<EmailOwnership> | null = null
  let pending: Promise<{ ownership: EmailOwnership; offer: AnnualOfferResponse }> | null = null

  return {
    hasProof: () => proof !== null,
    load() {
      // Strict Mode effect replay and rapid retries must join the same request.
      if (pending) return pending
      const retrying = proof !== null
      pending = (async () => {
        consumption ??= consume()
        proof = await consumption
        if (retrying && Date.parse(proof.expiresAt) <= Date.now()) {
          throw new Error('Email verification expired. Request a new link.')
        }
        return { ownership: proof, offer: await loadOffer() }
      })().finally(() => { pending = null })
      return pending
    },
  }
}
