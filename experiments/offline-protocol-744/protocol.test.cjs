'use strict';
// Each schedule runs against the control (must show the failure) and the
// candidate (must avoid it). Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./protocol.cjs');
const N = require('./candidate.cjs');
const C = P.control;

const T = 'notes/nb1/item1';
const remote = (...history) => ({ history });
async function setup(fingerprint = 'acct-A') {
  const factory = P.newFactory();
  const q1 = await P.openQueue(factory, 2);
  await P.initOwner(q1, fingerprint);
  const q2 = await P.openQueue(factory, 2);
  return { factory, a: await P.context(q1), b: await P.context(q2) };
}
async function expectReject(promise, safe, code) {
  if (safe) await assert.rejects(promise, { code });
  else await promise;
}

test('F01 loss is retained alongside replacement work', async () => {
  for (const [impl, safe] of [[C, false], [N, true]]) {
    const { a } = await setup();
    await impl.admit(a, T, { body: 'SYNTH-1' });
    await P.dropPayload(a.db, T);
    await impl.admit(a, T, { body: 'SYNTH-2' });
    assert.equal((await P.listLoss(a.db)).length, safe ? 1 : 0, safe ? 'candidate' : 'control');
    assert.equal((await P.getWork(a.db, T)).status, 'pending');
  }
});

test('F01b loss capacity rejects without erasing evidence', async () => {
  P.limits.loss = 1;
  try {
    const { a } = await setup();
    await N.admit(a, 'notes/nb1/x', { body: 'SYNTH-x' });
    await P.dropPayload(a.db, 'notes/nb1/x');
    await N.admit(a, 'notes/nb1/x', { body: 'SYNTH-x2' });
    await N.admit(a, T, { body: 'SYNTH-1' });
    await P.dropPayload(a.db, T);
    await assert.rejects(N.admit(a, T, { body: 'SYNTH-2' }), { code: 'loss-capacity' });
    assert.equal((await P.listLoss(a.db)).length, 1);
    assert.equal((await P.getWork(a.db, T)).status, 'pending', 'unclassified evidence row retained');
  } finally { P.limits.loss = 100; }
});

test('F02 favourite value and body are ciphertext at rest', async () => {
  for (const [impl, leaks] of [[C, true], [N, false]]) {
    const { a } = await setup();
    await impl.admit(a, 'contacts/ab1/c1', { body: 'SYNTH-VCARD' });
    await impl.admitFavorite(a, 'contacts/ab1/c1', true);
    assert.equal(/favorite|SYNTH/.test(await P.rawDump(a.db)), leaks, leaks ? 'control leaks' : 'candidate');
  }
  const { a, b } = await setup();
  await N.admit(a, 'contacts/ab1/c1', { body: 'SYNTH-VCARD' });
  await N.admitFavorite(a, 'contacts/ab1/c1', true);
  assert.deepEqual(await N.intent(b, 'contacts/ab1/c1'), { body: 'SYNTH-VCARD', favorite: true });
});

test('F03 attempts are serialized, immutable and bound to their materialization', async () => {
  for (const [impl, safe] of [[C, false], [N, true]]) {
    const { a, b } = await setup();
    const w = await impl.admit(a, T, { body: 'SYNTH-1' });
    const expected = { workGen: w.workGen, attemptId: null };
    const first = await impl.beginDispatch(a, T, expected, 'rev-1', { body: 'SYNTH-1' });
    await expectReject(impl.beginDispatch(b, T, expected, 'rev-2', { body: 'SYNTH-1' }), safe, 'dispatch-cas');
    // The client request aborted, but the server committed rev-1.
    assert.equal(await impl.reconcile(a, T, remote('base', 'rev-1')), safe ? 'applied' : 'resend');
    if (safe) {
      assert.equal(await impl.ack(a, first, T), 'acked');
      assert.equal(await impl.publish(a, T, first), 'SYNTH-1');
    }
  }
});

test('F04 a stale acknowledged generation cannot publish over newer work', async () => {
  for (const [impl, safe] of [[C, false], [N, true]]) {
    const { a } = await setup();
    const x = await impl.admit(a, T, { body: 'SYNTH-X' });
    const att = await impl.beginDispatch(a, T, { workGen: x.workGen, attemptId: null }, 'rev-x', { body: 'SYNTH-X' });
    await impl.ack(a, att, T);
    await impl.admit(a, T, { body: 'SYNTH-Y' });
    await expectReject(impl.publish(a, T, att), safe, 'stale-publication');
    assert.equal(a.memory.get(T).body, safe ? 'SYNTH-Y' : 'SYNTH-X');
  }
});

test('F04b refresh and restart hydration keep durable intent over the server copy', async () => {
  for (const [impl, safe] of [[C, false], [N, true]]) {
    const { a, b } = await setup();
    await impl.admit(a, T, { body: 'SYNTH-LOCAL' });
    await impl.refreshPublish(a, [[T, 'SYNTH-SERVER']]);
    assert.equal((await impl.hydrate(b)).get(T), safe ? 'SYNTH-LOCAL' : 'SYNTH-SERVER');
  }
});

test('F05 old cache-only writer cannot destroy migration evidence after cutover', async () => {
  {
    const s = await P.seedLegacy();
    const old = await P.openCache(s.factory, 5);
    const ctx = await s.newContext();
    const out = await C.migrate(ctx, s.factory, { beforeCopy: () => P.oldCachePut(old, s.serverCopy) });
    assert.notDeepEqual(out[0].raw.ct, s.original.ct, 'control: pinned evidence overwritten by old writer');
    old.close();
  }
  if (N === C) assert.fail('candidate not implemented');
  const s = await P.seedLegacy();
  const old = await P.openCache(s.factory, 5);
  const ctx = await s.newContext();
  await assert.rejects(N.migrate(ctx, s.factory), { code: 'upgrade-blocked' });
  old.close();
  const out = await N.migrate(ctx, s.factory);
  await assert.rejects(P.openCache(s.factory, 5), { name: 'VersionError' });
  await assert.rejects(P.openQueue(s.factory, 1), { name: 'VersionError' });
  assert.deepEqual(out[0].raw.ct, s.original.ct);
  assert.equal(out[0].status, 'unverified');
  assert.equal(P.dispatchable(out[0]), false, 'legacy copy is never auto-dispatched');
});

test('F06 locked and ambiguous legacy material stays pending with original ciphertext', async () => {
  {
    const s = await P.seedLegacy({ withKey: false });
    const out = await C.migrate(await s.newContext(), s.factory);
    assert.equal(out[0].raw, null, 'control released the only ciphertext');
  }
  {
    const s = await P.seedLegacy({ withKey: false });
    const ctx = await s.newContext();
    const out = await N.migrate(ctx, s.factory);
    assert.equal(out[0].status, 'pending-locked');
    assert.deepEqual(out[0].raw.ct, s.original.ct);
    assert.deepEqual(await N.migrate(ctx, s.factory), out, 'resume is idempotent');
  }
  {
    const s = await P.seedLegacy({ foreignKey: true });
    const ctx = await s.newContext();
    assert.equal((await N.migrate(ctx, s.factory))[0].status, 'pending-ambiguous');
    assert.equal((await P.listLoss(ctx.db)).length, 0, 'authentication failure is not loss');
  }
  {
    const s = await P.seedLegacy({ malformed: true });
    const ctx = await s.newContext();
    assert.equal((await N.migrate(ctx, s.factory))[0].status, 'lost');
    assert.equal((await P.listLoss(ctx.db)).length, 1);
  }
});

test('F07 legacy deletes and missing updates are never silently retired', async () => {
  const mk = () => P.seedLegacy({
    mutations: [{ id: 'm-del', type: 'delete', itemUid: 'gone1' }, { id: 'm-upd', type: 'update', itemUid: 'gone2' }],
    items: [],
  });
  {
    const s = await mk();
    const out = await C.migrate(await s.newContext(), s.factory);
    assert.deepEqual(out.map((r) => r.status), ['retired', 'retired']);
  }
  const s = await mk();
  const out = await N.migrate(await s.newContext(), s.factory);
  assert.deepEqual(out.map((r) => r.status), ['unverified-delete', 'legacy-unresolved']);
  assert.equal(out.some(P.dispatchable), false);
});

test('F08 same-account owner/envelope replacement fences stale publishers', async () => {
  for (const [impl, safe] of [[C, false], [N, true]]) {
    const { a, b } = await setup();
    await N.replaceOwner(b.db, b.owner.lifecycleGen, b.owner.fingerprint);
    await expectReject(impl.admit(a, T, { body: 'SYNTH-STALE' }), safe, 'owner-changed');
    await expectReject(impl.refreshPublish(a, [[T, 'SYNTH-SERVER']]), safe, 'owner-changed');
  }
});

test('F09 owner and session commit together; stale logins and aborted writes are refused', async () => {
  {
    const f = P.newFactory();
    const q = await P.openQueue(f, 2);
    const sec = await P.openSecure(f);
    let release; let reached;
    const gate = new Promise((r) => { release = r; });
    const atGate = new Promise((r) => { reached = r; });
    const loginA = C.login(q, sec, 'acct-A', { beforeSession: () => { reached(); return gate; } });
    await atGate;
    await C.login(q, sec, 'acct-B');
    release();
    await loginA;
    assert.equal((await P.readOwner(q)).fingerprint, 'acct-B');
    assert.equal(await P.readSecure(sec), 'session-acct-A', 'control: queue owner and session disagree');
  }
  {
    const q = await P.openQueue(P.newFactory(), 2);
    const gen0 = 0;
    assert.equal(await N.replaceOwner(q, gen0, 'acct-A'), 1);
    await assert.rejects(N.replaceOwner(q, gen0, 'acct-B'), { code: 'stale-owner' });
    await N.replaceOwner(q, (await P.readOwner(q)).lifecycleGen, 'acct-B');
    const owner = await P.readOwner(q);
    assert.equal(owner.fingerprint, 'acct-B');
    assert.equal(owner.session, 'session-acct-B');
    const ctx = await P.context(q);
    await N.admit(ctx, T, { body: 'SYNTH-U' });
    await N.publishSession(q, owner.lifecycleGen, 'acct-B', 'session-acct-B-unlocked');
    assert.equal((await P.getWork(q, T)).status, 'pending', 'same-account unlock keeps work');
  }
  {
    const q = await P.openQueue(P.newFactory(), 2);
    assert.equal(await P.requestSuccessWrite(q, 'v', true), 'resolved');
    assert.equal(await P.readProbe(q), undefined, 'control reported an aborted write as done');
    await assert.rejects(P.durableWrite(q, 'v', true));
    await P.durableWrite(q, 'v2', false);
    assert.equal(await P.readProbe(q), 'v2');
  }
});

test('F10 dispatch requires a confirmed fence bound to the same server', async () => {
  const { a } = await setup();
  assert.equal(await C.dispatchAllowed(a, 'srv-1'), true, 'control: no activation state machine');
  assert.equal(await N.dispatchAllowed(a, 'srv-1'), false);
  await N.setFence(a, 'activating', 'srv-1');
  assert.equal(await N.dispatchAllowed(a, 'srv-1'), false, 'lost activation response stays closed');
  await N.setFence(a, 'active', 'srv-1');
  assert.equal(await N.dispatchAllowed(a, 'srv-1'), true);
  assert.equal(await N.dispatchAllowed(a, 'srv-2'), false);
});

test('F12 destructive actions classify first and respect precedence and barriers', async () => {
  for (const [impl, safe] of [[C, false], [N, true]]) {
    const { a } = await setup();
    await impl.admit(a, T, { body: 'SYNTH-1' });
    await P.dropPayload(a.db, T);
    await impl.beginCollectionDelete(a, 'nb1');
    await expectReject(impl.admit(a, 'notes/nb1/other', { body: 'SYNTH-2' }), safe, 'collection-barrier');
    await impl.collectionDelete(a, 'nb1');
    assert.equal((await P.listLoss(a.db)).length, safe ? 1 : 0);
    await impl.admitMove(a, 'notes/nb2/m1', { body: 'SYNTH-M', target: 'nb3' });
    await expectReject(impl.admitDelete(a, 'notes/nb2/m1'), safe, 'move-in-progress');
  }
});

test('F13 bulk delete admits a truthful bounded subset and maps visibility', async () => {
  P.limits.work = 3;
  try {
    for (const [impl, safe] of [[C, false], [N, true]]) {
      const { a } = await setup();
      await impl.admit(a, 'notes/nb1/a', { body: 'SYNTH-a' });
      await impl.admit(a, 'notes/nb1/b', { body: 'SYNTH-b' });
      const r = impl.admitDeletes(a, ['notes/nb1/c', 'notes/nb1/d', 'notes/nb1/a']);
      if (!safe) { await assert.rejects(r, { code: 'capacity' }); continue; }
      const out = await r;
      assert.deepEqual(out.admitted, ['notes/nb1/c', 'notes/nb1/a']);
      assert.deepEqual(out.rejected, ['notes/nb1/d']);
    }
  } finally { P.limits.work = 100; }
  assert.equal(P.visibility('rejected'), 'visible');
  assert.equal(P.visibility('uncertain'), 'pending-visible');
  assert.equal(P.visibility('queued'), 'hidden');
});

test('P01 ordinary save, favourite, delete, move and full capacity make progress', async () => {
  const { a, b } = await setup();
  const w = await N.admit(a, T, { body: 'SYNTH-1' });
  const at = await N.beginDispatch(a, T, { workGen: w.workGen, attemptId: null }, 'rev-1', { body: 'SYNTH-1' });
  assert.equal(await N.ack(a, at, T), 'acked');
  assert.equal(await N.publish(a, T, at), 'SYNTH-1');
  assert.equal(await P.getWork(a.db, T), undefined, 'retired');
  assert.equal((await N.hydrate(b)).get(T), 'SYNTH-1');
  const c = 'contacts/ab1/c1';
  await N.admit(a, c, { body: 'SYNTH-V' });
  await N.admitFavorite(b, c, true);
  assert.deepEqual(await N.intent(a, c), { body: 'SYNTH-V', favorite: true });
  assert.equal((await N.admitDelete(a, 'notes/nb1/d1')).kind, 'delete');
  assert.equal((await N.admitMove(a, 'notes/nb2/m1', { body: 'SYNTH-M', target: 'nb3' })).kind, 'move');
  const { a: x } = await setup();
  for (let i = 0; i < P.limits.work; i++) await N.admit(x, `notes/nb9/i${i}`, { body: 'SYNTH' });
  await assert.rejects(N.admit(x, 'notes/nb9/overflow', { body: 'SYNTH' }), { code: 'capacity' });
});
