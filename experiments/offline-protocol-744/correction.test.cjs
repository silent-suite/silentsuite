'use strict';
// Candidate-only regressions for the reviewed boundary defects (findings 2-9).
// Synthetic data only; these do not exercise application code.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./protocol.cjs');
const N = require('./candidate.cjs');

const T = 'notes/nb1/item1';
const SERVER = 'srv-1';
async function setupA({ activate = true } = {}) {
  const factory = P.newFactory();
  const q1 = await P.openQueue(factory, 2);
  await P.initOwner(q1, 'acct-A');
  const q2 = await P.openQueue(factory, 2);
  const a = await P.context(q1);
  const b = await P.context(q2);
  a.server = SERVER;
  b.server = SERVER;
  if (activate) await N.setFence(a, 'active', SERVER);
  return { factory, a, b };
}
async function complete(ctx, tuple, value) {
  const w = value.kind === 'delete' ? await N.admitDelete(ctx, tuple) : await N.admit(ctx, tuple, value);
  const materialized = value.kind === 'delete' ? { tombstone: true } : { body: value.body, favorite: value.favorite };
  const at = await N.beginDispatch(ctx, tuple, { workGen: w.workGen, attemptId: null }, `rev-${w.workGen}`, materialized);
  assert.equal(await N.ack(ctx, at, tuple), 'acked');
  return N.publish(ctx, tuple, at);
}

test('R02 ack and publication resolve the durable attempt; forged receipts are refused', async () => {
  const { a } = await setupA();
  const TB = 'notes/nb1/item2';
  const wa = await N.admit(a, T, { body: 'SYNTH-A' });
  const wb = await N.admit(a, TB, { body: 'SYNTH-B' });
  const ra = await N.beginDispatch(a, T, { workGen: wa.workGen, attemptId: null }, 'rev-a', { body: 'SYNTH-A' });
  const rb = await N.beginDispatch(a, TB, { workGen: wb.workGen, attemptId: null }, 'rev-b', { body: 'SYNTH-B' });
  await assert.rejects(N.ack(a, { ...ra, payloadId: rb.payloadId }, T), { code: 'receipt-mismatch' });
  assert.equal(await N.ack(a, ra, T), 'acked');
  await assert.rejects(N.publish(a, T, { ...ra, payloadId: rb.payloadId }), { code: 'receipt-mismatch' });
  await assert.rejects(N.publish(a, TB, ra), { code: 'receipt-mismatch' });
  await assert.rejects(N.publish(a, T, { ...ra, revUid: 'rev-forged' }), { code: 'receipt-mismatch' });
  assert.equal(await N.publish(a, T, ra), 'SYNTH-A', 'genuine receipt still publishes');
  assert.equal((await N.hydrate(a)).get(T), 'SYNTH-A');
});

test('R03 dispatch requires owner-bound activation for this server; replacement clears it', async () => {
  const { a } = await setupA({ activate: false });
  const w = await N.admit(a, T, { body: 'SYNTH-1' });
  const expected = { workGen: w.workGen, attemptId: null };
  await assert.rejects(N.beginDispatch(a, T, expected, 'r1', { body: 'SYNTH-1' }), { code: 'not-activated' });
  await N.setFence(a, 'active', 'srv-2');
  await assert.rejects(N.beginDispatch(a, T, expected, 'r1', { body: 'SYNTH-1' }), { code: 'not-activated' });
  await N.setFence(a, 'active', SERVER);
  const at = await N.beginDispatch(a, T, expected, 'r1', { body: 'SYNTH-1' });
  assert.equal(await N.ack(a, at, T), 'acked');
  // Same-account generation replacement: fence cleared, stale context fenced.
  await N.replaceOwner(a.db, a.owner.lifecycleGen, a.owner.fingerprint);
  const fresh = await P.context(a.db);
  fresh.server = SERVER;
  assert.equal(await N.dispatchAllowed(fresh, SERVER), false);
  await assert.rejects(N.hydrate(a), { code: 'owner-changed' });
  await assert.rejects(N.reconcile(a, T, { history: ['r1'] }), { code: 'owner-changed' });
  await assert.rejects(N.publish(a, T, at));
  assert.equal(a.memory.get(T).body, 'SYNTH-1', 'no late publication into stale memory');
  // Account replacement does not inherit an activation.
  await N.setFence(fresh, 'active', SERVER);
  await N.replaceOwner(a.db, fresh.owner.lifecycleGen, 'acct-B');
  const b = await P.context(a.db);
  b.server = SERVER;
  assert.equal(await N.dispatchAllowed(b, SERVER), false);
  await assert.rejects(N.dispatchAllowed(fresh, SERVER), { code: 'owner-changed' });
});

test('R04 favourite after retirement composes from the display body; unreadable evidence is refused', async () => {
  const { a } = await setupA();
  const C1 = 'contacts/ab1/c1';
  await complete(a, C1, { body: 'SYNTH-V' });
  await N.admitFavorite(a, C1, true);
  assert.deepEqual(await N.intent(a, C1), { body: 'SYNTH-V', favorite: true });
  assert.equal(await complete(a, C1, await N.intent(a, C1)), 'SYNTH-V', 'favourite save completes');
  await assert.rejects(N.admitFavorite(a, 'contacts/ab1/none', true), { code: 'no-authoritative-body' });
  const C2 = 'contacts/ab1/c2';
  await N.admit(a, C2, { body: 'SYNTH-W' });
  await P.foreignPayload(a.db, C2);
  const before = await P.rawPayload(a.db, C2);
  await assert.rejects(N.admitFavorite(a, C2, true), { code: 'unreadable-evidence' });
  assert.deepEqual(await P.rawPayload(a.db, C2), before, 'ciphertext preserved on refusal');
  const C3 = 'contacts/ab1/c3';
  await N.admit(a, C3, { body: 'SYNTH-Z' });
  await P.dropPayload(a.db, C3);
  await assert.rejects(N.admitFavorite(a, C3, true), { code: 'no-authoritative-body' });
  assert.equal((await P.getWork(a.db, C3)).status, 'pending', 'missing evidence retained');
});

test('R05 refresh captured earlier cannot overwrite later publication; tombstones persist', async () => {
  const { a, b } = await setupA();
  const token = { seq: await P.readSeq(a.db) };
  await complete(a, T, { body: 'SYNTH-Y' });
  await N.refreshPublish(a, [[T, 'SYNTH-X']], token);
  assert.equal((await N.hydrate(b)).get(T), 'SYNTH-Y');
  const token2 = { seq: await P.readSeq(a.db) };
  await complete(a, T, { kind: 'delete' });
  const c = await P.context(b.db); // refreshed context: memory empty, durable state only
  assert.equal((await N.hydrate(c)).has(T), false, 'completed delete hidden after restart');
  await N.refreshPublish(a, [[T, 'SYNTH-X']], token2);
  assert.equal((await N.hydrate(c)).has(T), false, 'delayed refresh cannot resurrect');
});

test('R06 common admission policy: barriers, both move endpoints, post-state loss limits', async () => {
  const { a } = await setupA();
  await N.beginCollectionDelete(a, 'nb1');
  const r = await N.admitDeletes(a, ['notes/nb1/x', 'notes/nb5/y']);
  assert.deepEqual(r.rejected, ['notes/nb1/x']);
  assert.deepEqual(r.admitted, ['notes/nb5/y']);
  await N.admitMove(a, 'notes/nb2/m1', { body: 'SYNTH-M', target: 'nb3' });
  await assert.rejects(N.collectionDelete(a, 'nb3'), { code: 'move-in-progress' });
  await assert.rejects(N.collectionDelete(a, 'nb2'), { code: 'move-in-progress' });
  await assert.rejects(N.admitMove(a, 'notes/nb4/m2', { body: 'SYNTH-M', target: 'nb1' }), { code: 'collection-barrier' });
  P.limits.loss = 0;
  try {
    await N.admit(a, 'notes/nb6/l1', { body: 'SYNTH-L' });
    await P.dropPayload(a.db, 'notes/nb6/l1');
    const bulk = await N.admitDeletes(a, ['notes/nb6/l1', 'notes/nb6/l2']);
    assert.deepEqual(bulk.rejected, ['notes/nb6/l1']);
    assert.deepEqual(bulk.admitted, ['notes/nb6/l2']);
    assert.equal((await P.getWork(a.db, 'notes/nb6/l1')).kind, 'body', 'rejected member keeps its evidence');
    await assert.rejects(N.collectionDelete(a, 'nb6'), { code: 'loss-capacity' });
    assert.ok(await P.getWork(a.db, 'notes/nb6/l1'), 'collection deletion is atomic');
  } finally { P.limits.loss = 100; }
  await N.collectionDelete(a, 'nb6');
  assert.equal((await P.listLoss(a.db)).length, 1, 'ordinary collection deletion records the loss');
});

test('R07 migration refuses legacy evidence owned by another account or identity', async () => {
  const s = await P.seedLegacy();
  const ctxA = await s.newContext();
  await N.replaceOwner(ctxA.db, ctxA.owner.lifecycleGen, 'acct-B');
  const ctxB = await P.context(ctxA.db);
  const out = await N.migrate(ctxB, s.factory);
  assert.equal(out[0].status, 'quarantined');
  assert.equal(out[0].raw, null, 'A ciphertext not imported into B');
  assert.equal(await P.holdCount(s.factory), 1, 'A evidence retained');
  const s2 = await P.seedLegacy({ mutations: [{ id: 'm1', type: 'update', collectionUid: 'nbX', itemUid: 'item1' }] });
  assert.equal((await N.migrate(await s2.newContext(), s2.factory))[0].status, 'quarantined', 'collection mismatch');
  const s3 = await P.seedLegacy({ cacheFingerprint: 'acct-Z' });
  assert.equal((await N.migrate(await s3.newContext(), s3.factory))[0].status, 'quarantined', 'cache owner mismatch');
});

test('R08 blocked cutover interval, late connection, and gated admissions', async () => {
  const s = await P.seedLegacy();
  const ctx = await s.newContext();
  await assert.rejects(N.admit(ctx, T, { body: 'SYNTH' }), { code: 'cutover-pending' });
  const old = await P.openCache(s.factory, 5);
  const lateBefore = P.stats.lateClosed;
  await assert.rejects(N.migrate(ctx, s.factory), { code: 'upgrade-blocked' });
  await P.oldCachePut(old, s.serverCopy); // old writer during the blocked interval
  old.close();
  const out = await N.migrate(ctx, s.factory);
  assert.ok(P.stats.lateClosed > lateBefore, 'late connection closed');
  assert.equal(out[0].status, 'unverified');
  assert.notDeepEqual(out[0].raw.ct, s.original.ct, 'bytes replaced before the upgrade completed are not recoverable');
  await N.admit(ctx, T, { body: 'SYNTH' });
  const s2 = await P.seedLegacy();
  const ctx2 = await s2.newContext();
  const old2 = await P.openCache(s2.factory, 5);
  await assert.rejects(N.migrate(ctx2, s2.factory), { code: 'upgrade-blocked' });
  await P.oldCacheClear(old2); // old cleanup during the blocked interval
  old2.close();
  assert.equal((await N.migrate(ctx2, s2.factory))[0].status, 'legacy-unresolved');
});

test('R09 raw UTF-8 cache content authenticates without JSON parsing; unlock progresses', async () => {
  const s = await P.seedLegacy({ format: 'vcard' });
  assert.equal((await N.migrate(await s.newContext(), s.factory))[0].status, 'unverified');
  const s2 = await P.seedLegacy({ format: 'vcard', withKey: false });
  const c2 = await s2.newContext();
  assert.equal((await N.migrate(c2, s2.factory))[0].status, 'pending-locked');
  assert.equal((await N.unlockLegacy(c2, s2.key))[0].status, 'unverified');
  const s3 = await P.seedLegacy({ format: 'vcard', foreignKey: true });
  assert.equal((await N.migrate(await s3.newContext(), s3.factory))[0].status, 'pending-ambiguous');
});
