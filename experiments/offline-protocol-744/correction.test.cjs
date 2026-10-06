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
  // Setup only: refresh now requires an issued pre-enumeration token.
  const token = await N.refreshBegin(a);
  await complete(a, T, { body: 'SYNTH-Y' });
  await N.refreshPublish(a, [[T, 'SYNTH-X']], token);
  assert.equal((await N.hydrate(b)).get(T), 'SYNTH-Y');
  const token2 = await N.refreshBegin(a);
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

// ---- review follow-up regressions (four reproduced findings) ----

const { webcrypto } = require('node:crypto');
const readDisplay = (db, tuple) => P.run(db, ['display'], 'readonly', async (s) => P.req(s.display.get(tuple)));

// Pauses the next AES-GCM decryption until released; restores on release.
function pauseNextDecrypt() {
  const subtle = webcrypto.subtle;
  const original = subtle.decrypt;
  let enter; let release;
  const entered = new Promise((r) => { enter = r; });
  const resumed = new Promise((r) => { release = r; });
  let once = false;
  subtle.decrypt = function decrypt(...args) {
    if (once) return original.apply(this, args);
    once = true;
    enter();
    return resumed.then(() => original.apply(this, args));
  };
  return { entered, release: () => { subtle.decrypt = original; release(); } };
}

test('R10 paused favourite cannot compose a body replaced by a valid refresh; refresh order is monotonic', async () => {
  const { a } = await setupA();
  await N.refreshPublish(a, [[T, 'SYNTH-X']], await N.refreshBegin(a));
  assert.equal(await P.getWork(a.db, T), undefined, 'no live work: display is authoritative');
  const before = await readDisplay(a.db, T);
  const pause = pauseNextDecrypt();
  let fav;
  try {
    fav = N.admitFavorite(a, T, true);
    await pause.entered; // favourite has read X and is decrypting it
    await N.refreshPublish(a, [[T, 'SYNTH-Y']], await N.refreshBegin(a)); // valid pre-enumeration token
    const after = await readDisplay(a.db, T);
    assert.notEqual(after.seq, before.seq, 'every display mutation must advance the display revision');
  } finally {
    pause.release();
    if (fav) await fav.catch(() => {});
  }
  const intent = await N.intent(a, T).catch((e) => ({ refused: e.code }));
  assert.notDeepEqual(intent, { body: 'SYNTH-X', favorite: true }, 'favourite must not resurrect the replaced body');
  // Reverse completion order: a refresh captured earlier finishes last.
  const { a: r } = await setupA();
  const early = await N.refreshBegin(r);
  const late = await N.refreshBegin(r);
  await N.refreshPublish(r, [[T, 'SYNTH-NEWER']], late);
  await N.refreshPublish(r, [[T, 'SYNTH-OLDER']], early);
  assert.equal((await N.hydrate(r)).get(T), 'SYNTH-NEWER', 'an earlier capture cannot overwrite a later one');
});

test('R10b positive control: an ordinary later refresh replaces the display body', async () => {
  const { a, b } = await setupA();
  await complete(a, T, { body: 'SYNTH-SAVED' });
  await N.refreshPublish(a, [[T, 'SYNTH-SERVER-NEWER']], await N.refreshBegin(a));
  assert.equal((await N.hydrate(b)).get(T), 'SYNTH-SERVER-NEWER');
  await N.admitFavorite(a, T, true);
  assert.deepEqual(await N.intent(a, T), { body: 'SYNTH-SERVER-NEWER', favorite: true });
});

test('R11 a completed delete is not resurrected by the two-argument refresh; tokens are lifecycle-bound', async () => {
  const { a } = await setupA();
  await complete(a, T, { body: 'SYNTH-X' });
  const enumeratedBeforeDelete = [[T, 'SYNTH-X']];
  await complete(a, T, { kind: 'delete' });
  const fresh = await P.context(a.db);
  assert.equal((await N.hydrate(fresh)).has(T), false);
  await N.refreshPublish(a, enumeratedBeforeDelete).catch((e) => { if (typeof e.code !== 'string') throw e; });
  assert.equal((await N.hydrate(fresh)).has(T), false, 'two-argument refresh resurrected a completed delete');
  // Lifecycle binding: a token captured before same-account replacement is stale.
  const { a: c } = await setupA();
  const staleToken = await N.refreshBegin(c);
  await N.replaceOwner(c.db, c.owner.lifecycleGen, c.owner.fingerprint);
  const replaced = await P.context(c.db);
  await assert.rejects(N.refreshPublish(replaced, [[T, 'SYNTH-OLD-LIFECYCLE']], staleToken), (e) => typeof e.code === 'string');
  assert.equal(await readDisplay(c.db, T), undefined, 'stale-lifecycle refresh wrote display state');
  // Positive control: a token captured after the delete may publish a newer server body.
  await N.refreshPublish(a, [[T, 'SYNTH-RECREATED']], await N.refreshBegin(a));
  assert.equal((await N.hydrate(fresh)).get(T), 'SYNTH-RECREATED');
});

test('R12 completed collection deletion is durable for recreated contexts and delayed refresh', async () => {
  const { a, b } = await setupA();
  await complete(a, T, { body: 'SYNTH-COLLECTION' });
  await complete(a, 'notes/nb2/keep', { body: 'SYNTH-OTHER' });
  const delayed = await N.refreshBegin(a);
  await N.beginCollectionDelete(a, 'nb1');
  await N.collectionDelete(a, 'nb1');
  const fresh = await P.context(b.db);
  assert.equal((await N.hydrate(fresh)).has(T), false, 'deleted collection item visible after recreation');
  assert.equal((await N.hydrate(fresh)).get('notes/nb2/keep'), 'SYNTH-OTHER', 'other collections unaffected');
  await N.refreshPublish(a, [[T, 'SYNTH-COLLECTION']], delayed);
  assert.equal((await N.hydrate(fresh)).has(T), false, 'delayed refresh resurrected a deleted collection item');
  // Pending replacement work must not expose the older display copy.
  const { a: c } = await setupA();
  await complete(c, T, { body: 'SYNTH-OLD' });
  await N.admit(c, T, { body: 'SYNTH-PENDING' });
  await N.beginCollectionDelete(c, 'nb1');
  await N.collectionDelete(c, 'nb1');
  assert.equal((await N.hydrate(await P.context(c.db))).has(T), false, 'older display copy exposed');
});

test('R13 bulk deletion reaches exactly the loss limit with real IDB counts', async () => {
  const { a } = await setupA();
  assert.equal(P.limits.loss, 100);
  await P.run(a.db, ['loss'], 'readwrite', async (s) => {
    for (let i = 0; i < 98; i++) s.loss.put({ id: `SYNTH-LOSS-${i}`, tuple: `notes/nb9/${i}`, lossGen: `SYNTH-GEN-${i}` });
  });
  const members = ['notes/nb1/missing1', 'notes/nb1/missing2', 'notes/nb1/missing3'];
  for (const t of members) {
    await N.admit(a, t, { body: 'SYNTH-MISSING' });
    await P.dropPayload(a.db, t);
  }
  assert.equal((await P.listLoss(a.db)).length, 98);
  const out = await N.admitDeletes(a, members);
  assert.deepEqual(out, { admitted: members.slice(0, 2), rejected: [members[2]] }, 'post-state of exactly 100 losses must be admitted');
  assert.equal((await P.listLoss(a.db)).length, 100);
  assert.equal((await P.getWork(a.db, members[2])).kind, 'body', 'rejected member keeps its evidence');
});

// ---- bounded refresh-token lifetime and recovery ----

// Stated contract: at most TOKEN_CAP issued refresh tokens are outstanding at any
// time (conservatively below the 100-item work limit). Abandoned tokens are retired
// by their own caller when possible, and the oldest are expired at issuance.
const TOKEN_CAP = 8;

// Reads real IDB meta state: no cleanup or reshaping happens here.
async function metaState(db) {
  return P.run(db, ['meta'], 'readonly', async (s) => ({
    keys: (await P.req(s.meta.getAllKeys())).map(String),
    values: await P.req(s.meta.getAll()),
  }));
}
async function assertTokensBounded(db, max, label) {
  const { keys, values } = await metaState(db);
  const tokens = keys.filter((k) => k.startsWith('refresh:'));
  assert.ok(tokens.length <= max, `${label}: ${tokens.length} outstanding refresh tokens exceed ${max}`);
  for (const v of values) {
    if (Array.isArray(v)) assert.ok(v.length <= TOKEN_CAP, `${label}: meta array of ${v.length} entries`);
    if (v && typeof v === 'object') {
      for (const inner of Object.values(v)) {
        if (Array.isArray(inner)) assert.ok(inner.length <= TOKEN_CAP, `${label}: nested meta array of ${inner.length} entries`);
      }
    }
  }
  return tokens.length;
}
// Account, work, loss and display evidence that token handling must never erase.
async function evidence(db) {
  return P.run(db, ['meta', 'work', 'loss', 'display'], 'readonly', async (s) => ({
    owner: await P.req(s.meta.get('owner')),
    work: (await P.req(s.work.getAllKeys())).map(String).sort(),
    loss: (await P.req(s.loss.getAllKeys())).map(String).sort(),
    display: (await P.req(s.display.getAllKeys())).map(String).sort(),
  }));
}
async function seedEvidence(a) {
  await complete(a, 'notes/nb1/shown', { body: 'SYNTH-SHOWN' });
  await N.admit(a, 'notes/nb1/pending', { body: 'SYNTH-PENDING' });
  await N.admit(a, 'notes/nb1/lost', { body: 'SYNTH-LOST' });
  await P.dropPayload(a.db, 'notes/nb1/lost');
  await N.admit(a, 'notes/nb1/lost', { body: 'SYNTH-AFTER-LOSS' }); // records one loss
  assert.equal((await P.listLoss(a.db)).length, 1);
}
const offline = async () => { throw new Error('SYNTH-OFFLINE'); };

test('R14 producer failure retires its refresh token; retries stay bounded and evidence is kept', async () => {
  const { factory, a, b } = await setupA();
  await seedEvidence(a);
  const before = await evidence(a.db);
  for (let i = 0; i < 10; i++) {
    const ctx = await P.context(a.db); // recreated context for every attempt
    await assert.rejects(N.refreshWith(ctx, offline), /SYNTH-OFFLINE/);
  }
  assert.equal(await assertTokensBounded(a.db, TOKEN_CAP, 'after producer failures'), 0, 'failed producers must retire their tokens');
  assert.deepEqual(await evidence(a.db), before, 'token handling erased evidence');
  const fresh = await P.context(a.db);
  await N.refreshWith(fresh, async () => [[T, 'SYNTH-AFTER-FAILURES']]);
  assert.equal((await N.hydrate(fresh)).get(T), 'SYNTH-AFTER-FAILURES', 'ordinary refresh progresses after failures');
  assert.equal(await assertTokensBounded(a.db, TOKEN_CAP, 'after success'), 0);
  // Cleanup retires only the failing caller's token; another context's stays valid.
  const other = await N.refreshBegin(b);
  await assert.rejects(N.refreshWith(a, offline), /SYNTH-OFFLINE/);
  assert.equal(await assertTokensBounded(a.db, TOKEN_CAP, 'other context'), 1, "another context's token was retired");
  await N.refreshPublish(b, [[T, 'SYNTH-OTHER']], other);
  assert.equal((await N.hydrate(b)).get(T), 'SYNTH-OTHER');
  // A cleanup that cannot run reports both errors, keeps the original, and leaves one bounded token.
  const q3 = await P.openQueue(factory, 2);
  const closing = await P.context(q3);
  const err = await N.refreshWith(closing, async () => { q3.close(); throw new Error('SYNTH-OFFLINE-CLOSED'); })
    .then(() => null, (e) => e);
  assert.ok(err, 'failed cleanup must not turn into success');
  assert.equal(err.code, 'refresh-token-cleanup-failed');
  assert.equal(err.errors[0].message, 'SYNTH-OFFLINE-CLOSED', 'original producer error is kept');
  assert.equal(err.cause, err.errors[0]);
  assert.equal(await assertTokensBounded(a.db, TOKEN_CAP, 'after cleanup failure'), 1);
  await N.refreshWith(a, async () => [[T, 'SYNTH-AFTER-CLEANUP-FAILURE']]);
  assert.equal((await N.hydrate(a)).get(T), 'SYNTH-AFTER-CLEANUP-FAILURE', 'a retained token does not block refresh');
  const after = await evidence(a.db);
  assert.deepEqual([after.owner, after.work, after.loss], [before.owner, before.work, before.loss]);
});

test('R15 an aborted publication transaction does not leave its token behind', async () => {
  const { a } = await setupA();
  await seedEvidence(a);
  const before = await evidence(a.db);
  // An invalid IDB key aborts the real publication transaction after the token checks.
  await assert.rejects(N.refreshWith(a, async () => [[undefined, 'SYNTH-ABORT']]), { name: 'DataError' });
  assert.equal((await N.hydrate(a)).has(T), false);
  assert.equal(await assertTokensBounded(a.db, TOKEN_CAP, 'after aborted publication'), 0, 'aborted publication left its token');
  assert.deepEqual(await evidence(a.db), before);
  await N.refreshWith(a, async () => [[T, 'SYNTH-AFTER-ABORT']]);
  assert.equal((await N.hydrate(a)).get(T), 'SYNTH-AFTER-ABORT');
});

test('R16 interrupted refreshes across recreated contexts stay within the stated cap; newest tokens remain valid', async () => {
  const { a } = await setupA();
  await seedEvidence(a);
  const before = await evidence(a.db);
  const issued = [];
  for (let i = 0; i < 3 * TOKEN_CAP; i++) {
    const ctx = await P.context(a.db); // the issuing tab is interrupted before publishing
    issued.push(await N.refreshBegin(ctx));
    await assertTokensBounded(a.db, TOKEN_CAP, `after issuance ${i + 1}`);
  }
  assert.deepEqual(await evidence(a.db), before, 'expiry erased evidence');
  const ctx = await P.context(a.db);
  // The oldest token was expired; refusing it is bounded, not universal.
  await assert.rejects(N.refreshPublish(ctx, [[T, 'SYNTH-OLDEST']], issued[0]), { code: 'stale-refresh-token' });
  await N.refreshPublish(ctx, [[T, 'SYNTH-NEWEST']], issued[issued.length - 1]);
  assert.equal((await N.hydrate(ctx)).get(T), 'SYNTH-NEWEST', 'newest outstanding token still publishes');
  // An older retained token cannot overwrite the newer publication.
  await N.refreshPublish(ctx, [[T, 'SYNTH-OLDER-RETAINED']], issued[issued.length - 2]);
  assert.equal((await N.hydrate(ctx)).get(T), 'SYNTH-NEWEST', 'ordering preserved under the cap');
  await N.refreshWith(ctx, async () => [[T, 'SYNTH-LATER']]);
  assert.equal((await N.hydrate(ctx)).get(T), 'SYNTH-LATER');
  assert.deepEqual((await evidence(a.db)).owner, before.owner);
});

test('R17 concurrent valid refreshes and repeated progression stay bounded; newer wins', async () => {
  const { a, b } = await setupA();
  await seedEvidence(a);
  const older = await N.refreshBegin(a);
  const newer = await N.refreshBegin(b);
  await N.refreshPublish(b, [[T, 'SYNTH-NEWER']], newer);
  await N.refreshPublish(a, [[T, 'SYNTH-OLDER']], older);
  assert.equal((await N.hydrate(a)).get(T), 'SYNTH-NEWER');
  assert.equal(await assertTokensBounded(a.db, TOKEN_CAP, 'after concurrent pair'), 0);
  for (let i = 0; i < 3 * TOKEN_CAP; i++) {
    if (i % 3 === 0) await assert.rejects(N.refreshWith(a, offline), /SYNTH-OFFLINE/);
    else await N.refreshWith(i % 2 ? a : b, async () => [[T, `SYNTH-ROUND-${i}`]]);
    await assertTokensBounded(a.db, TOKEN_CAP, `round ${i}`);
  }
  assert.equal((await N.hydrate(a)).get(T), `SYNTH-ROUND-${3 * TOKEN_CAP - 1}`);
  assert.equal((await P.listLoss(a.db)).length, 1, 'loss evidence retained');
  assert.ok(await P.getWork(a.db, 'notes/nb1/pending'), 'pending work retained');
});
