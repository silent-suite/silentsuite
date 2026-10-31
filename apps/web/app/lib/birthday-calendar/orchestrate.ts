/**
 * Public Birthdays entry (#738).
 *
 * reconcileBirthdays is one fresh read and write. Callers that need the
 * post-check guarantee must use runBirthdayCalendar: it retries from fresh
 * reads, checks source tokens after the last plan, and coalesces overlapping
 * triggers. It does not enable or disable the feature, and it does not queue
 * work offline.
 */
import { BIRTHDAY_MAX_RERUNS, decideAfterBirthdayRun, type BirthdayPostCheck } from '@silentsuite/core'
import {
  reconcileBirthdays,
  type BirthdayGates,
  type BirthdayReconcileResult,
  type BirthdaySourceTokens,
  type BirthdayTransport,
} from './reconcile'

export interface BirthdayRunInput {
  accountKey: string
  username: string
  gates: BirthdayGates
  transport: BirthdayTransport
}

type Slot = {
  epoch: number
  pending: boolean
  latest: BirthdayRunInput
  waiters: Array<(result: BirthdayReconcileResult) => void>
}

const slots = new Map<string, Slot>()

function slotKey(input: BirthdayRunInput): string {
  return `${input.accountKey}\0${input.gates.accountEpoch}`
}

function blocked(gates: BirthdayGates): string | null {
  if (!gates.isCurrentEpoch()) return 'stale-account'
  if (!gates.isOnline()) return 'offline'
  if (!gates.canWrite()) return 'read-only'
  if (!gates.hasSubtleCrypto()) return 'no-subtle-crypto'
  return null
}

function skipped(reason: string, sourceTokens: BirthdaySourceTokens | null = null): BirthdayReconcileResult {
  return { status: 'skipped', reason, sourceTokens }
}

/** Test isolation. Production runs do not need this. */
export function resetBirthdayCalendarRuns(): void {
  slots.clear()
}

export function runBirthdayCalendar(input: BirthdayRunInput): Promise<BirthdayReconcileResult> {
  const key = slotKey(input)
  const existing = slots.get(key)
  if (existing) {
    existing.pending = true
    existing.latest = input
    return new Promise((resolve) => existing.waiters.push(resolve))
  }
  const slot: Slot = { epoch: input.gates.accountEpoch, pending: false, latest: input, waiters: [] }
  slots.set(key, slot)
  return drain(key, slot)
}

async function drain(key: string, slot: Slot): Promise<BirthdayReconcileResult> {
  let result: BirthdayReconcileResult
  try {
    result = await executeWithRetry(slot.latest)
  } catch {
    result = { status: 'failed', reason: 'reconcile-failed', sourceTokens: null }
  }
  if (slots.get(key) !== slot) return result
  if (slot.pending) {
    slot.pending = false
    const waiters = slot.waiters.splice(0)
    const follow = drain(key, slot)
    for (const waiter of waiters) void follow.then(waiter)
    return result
  }
  slots.delete(key)
  return result
}

async function executeWithRetry(input: BirthdayRunInput): Promise<BirthdayReconcileResult> {
  let reruns = 0
  for (;;) {
    const closed = blocked(input.gates)
    if (closed) return skipped(closed)
    const result = await reconcileBirthdays(input)
    if (result.status === 'skipped' || result.status === 'failed') return result
    if (result.status === 'pending') {
      if ((result.reason === 'conflict' || result.reason === 'uncertain') && reruns < BIRTHDAY_MAX_RERUNS) {
        reruns += 1
        continue
      }
      return result
    }
    const decision = await postCheck(input, result.sourceTokens, reruns)
    if (decision.kind === 'stop') return decision.result
    reruns += 1
  }
}

async function postCheck(
  input: BirthdayRunInput,
  tokens: BirthdaySourceTokens,
  reruns: number,
): Promise<{ kind: 'stop'; result: BirthdayReconcileResult } | { kind: 'rerun' }> {
  const check = await readSourceCheck(input, tokens)
  if (!input.gates.isCurrentEpoch()) return { kind: 'stop', result: skipped('stale-account', tokens) }
  const next = decideAfterBirthdayRun(check, reruns)
  if (next === 'done') return { kind: 'stop', result: { status: 'done', sourceTokens: tokens } }
  if (next === 'pending') return { kind: 'stop', result: { status: 'pending', reason: 'post-check', sourceTokens: tokens } }
  if (reruns >= BIRTHDAY_MAX_RERUNS) {
    return { kind: 'stop', result: { status: 'pending', reason: 'post-check', sourceTokens: tokens } }
  }
  return { kind: 'rerun' }
}

async function readSourceCheck(input: BirthdayRunInput, tokens: BirthdaySourceTokens): Promise<BirthdayPostCheck> {
  const incomplete = { complete: false, inventoryChanged: false, changedBooks: [] as string[] }
  if (!tokens.inventoryToken || tokens.books.some((book) => !book.stoken) || !input.transport.checkSourceTokens) return incomplete
  try {
    const check = await input.transport.checkSourceTokens({
      inventoryToken: tokens.inventoryToken,
      books: tokens.books.flatMap((book) => book.stoken ? [{ bookUid: book.bookUid, stoken: book.stoken }] : []),
    })
    if (!check.complete) return incomplete
    return check
  } catch {
    return incomplete
  }
}
