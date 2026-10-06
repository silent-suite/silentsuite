'use strict';
// Library controls against the installed Etebase SDK. Synthetic keys, transport
// intercepted, no network. Not browser, server or application evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '..', '..');
const sdkDir = path.dirname(createRequire(path.join(ROOT, 'packages/core/package.json')).resolve('etebase/package.json'));
const lib = (f) => require(path.join(sdkDir, 'dist/lib-cjs', f));
const E = lib('Etebase.js');
const M = lib('EncryptedModels.js');
const H = lib('Helpers.js');
const R = lib('Request.js');

const original = R.default;
const calls = [];
let mode = 'ok';
R.default = async (url, options) => {
  calls.push({ path: new URL(url).pathname, body: H.msgpackDecode(options.body) });
  if (mode === 'network') throw new TypeError('SYNTH_TRANSPORT_FAILURE');
  if (mode === 'conflict') return { ok: false, status: 409, body: H.msgpackEncode({ detail: 'SYNTH_CONFLICT' }) };
  return { ok: true, status: 200, body: H.msgpackEncode(null) };
};
test.after(() => { R.default = original; });

async function manager() {
  await E.ready;
  const parent = new M.MinimalCollectionCryptoManager(new Uint8Array(32).fill(7));
  return new E.ItemManager({ serverUrl: 'https://sdk-boundary.invalid/', authToken: '' }, parent, H.toBase64(new Uint8Array(24).fill(3)));
}

test('S0 SDK version is the pinned 0.43.1', () => {
  assert.equal(require(path.join(sdkDir, 'package.json')).version, '0.43.1');
});

test('S1 frozen snapshot carries the base etag; conflict and transport keep the baseline; batch is distinct', async () => {
  const m = await manager();
  calls.length = 0; mode = 'ok';
  const item = await m.create({ type: 'synthetic' }, new Uint8Array([1]));
  item.encryptedItem.__markSaved(); // fixture: a synthetic prior saved revision
  const base = item.encryptedItem.lastEtag;
  await item.setContent(new Uint8Array([2]));
  const rev = item.etag;
  const snap = m.cacheSave(item, { saveContent: true });
  const frozen = m.cacheLoad(snap);
  await m.transaction([frozen]);
  assert.match(calls[0].path, /\/item\/transaction\/$/);
  assert.equal(calls[0].body.items[0].etag, base);
  assert.equal(calls[0].body.items[0].content.uid, rev);
  assert.equal(frozen.encryptedItem.lastEtag, rev, 'marked saved after the response');
  assert.equal(item.encryptedItem.lastEtag, base, 'shared object untouched');
  mode = 'conflict';
  const c = m.cacheLoad(snap);
  await assert.rejects(m.transaction([c]), (e) => e instanceof E.ConflictError);
  assert.equal(c.encryptedItem.lastEtag, base);
  mode = 'network';
  const n = m.cacheLoad(snap);
  await assert.rejects(m.transaction([n]), (e) => e instanceof E.NetworkError);
  assert.equal(n.encryptedItem.lastEtag, base);
  mode = 'ok';
  await m.batch([m.cacheLoad(snap)]);
  assert.match(calls[3].path, /\/item\/batch\/$/);
  assert.equal(calls.length, 4);
});

test('S2 F11 a persisted create snapshot re-sends the same SDK-generated identity and revision', async () => {
  const m = await manager();
  calls.length = 0; mode = 'network';
  const created = await m.create({ type: 'synthetic' }, new Uint8Array([9]));
  const snap = m.cacheSave(created, { saveContent: true }); // durable before dispatch
  await assert.rejects(m.transaction([m.cacheLoad(snap)]), (e) => e instanceof E.NetworkError);
  mode = 'ok';
  await m.transaction([m.cacheLoad(snap)]);
  const [first, resend] = calls.map((c) => c.body.items[0]);
  assert.equal(first.uid, resend.uid);
  assert.equal(first.content.uid, resend.content.uid);
  assert.equal(first.etag ?? null, null);
  assert.equal(resend.etag ?? null, null);
  const regenerated = await m.create({ type: 'synthetic' }, new Uint8Array([9]));
  assert.notEqual(regenerated.uid, first.uid, 'control: recreating mints a different identity');
});

test('S3 F11 move legs bind source delete and target rollback to recorded revisions', async () => {
  const m = await manager();
  calls.length = 0; mode = 'ok';
  const source = await m.create({ type: 'synthetic' }, new Uint8Array([4]));
  source.encryptedItem.__markSaved(); // fixture: source exists remotely
  const sourceBase = source.etag;
  const target = await m.create({ type: 'synthetic' }, new Uint8Array([4]));
  const targetSnap = m.cacheSave(target, { saveContent: true });
  await m.transaction([m.cacheLoad(targetSnap)]); // leg 1: create target
  const createdTarget = m.cacheLoad(targetSnap);
  createdTarget.encryptedItem.__markSaved(); // fixture: confirmed create
  const createdRev = createdTarget.etag;
  const sourceDelete = m.cacheLoad(m.cacheSave(source, { saveContent: true }));
  sourceDelete.delete();
  await m.transaction([sourceDelete]); // leg 2: conditional source delete
  assert.equal(calls[1].body.items[0].etag, sourceBase);
  assert.equal(calls[1].body.items[0].content.deleted, true);
  createdTarget.delete();
  mode = 'conflict'; // target edited elsewhere: the rollback must not win
  await assert.rejects(m.transaction([createdTarget]), (e) => e instanceof E.ConflictError);
  assert.equal(calls[2].body.items[0].etag, createdRev);
  assert.equal(calls.length, 3);
});

// Snapshots persisted in synthetic IndexedDB and reloaded by recreated
// managers in distinct collections. The server's handling of a re-sent
// revision is NOT exercised: only what the SDK puts on the wire is shown.
test('S4 F11 snapshots survive recreated contexts; cross-collection legs re-send recorded revisions', async () => {
  const { IDBFactory } = createRequire(path.join(ROOT, 'apps/web/package.json'))('fake-indexeddb');
  const factory = new IDBFactory();
  const open = () => new Promise((resolve, reject) => {
    const r = factory.open('synthetic-sdk-snapshots', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('snap');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const put = async (key, value) => {
    const db = await open();
    await new Promise((resolve, reject) => {
      const t = db.transaction('snap', 'readwrite');
      t.objectStore('snap').put(value, key);
      t.oncomplete = resolve;
      t.onabort = () => reject(t.error);
    });
    db.close();
  };
  const get = async (key) => {
    const db = await open();
    const value = await new Promise((resolve, reject) => {
      const r = db.transaction('snap').objectStore('snap').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return value;
  };
  const colA = H.toBase64(new Uint8Array(24).fill(3));
  const colB = H.toBase64(new Uint8Array(24).fill(5));
  const managerFor = async (col) => {
    await E.ready;
    return new E.ItemManager({ serverUrl: 'https://sdk-boundary.invalid/', authToken: '' }, new M.MinimalCollectionCryptoManager(new Uint8Array(32).fill(7)), col);
  };
  calls.length = 0; mode = 'ok';
  // Context 1: source exists remotely (fixture); target snapshot persisted before dispatch.
  const m1A = await managerFor(colA);
  const source = await m1A.create({ type: 'synthetic' }, new Uint8Array([4]));
  source.encryptedItem.__markSaved();
  await put('source', m1A.cacheSave(source, { saveContent: true }));
  await put('sourceRevision', source.etag);
  const m1B = await managerFor(colB);
  const target = await m1B.create({ type: 'synthetic' }, new Uint8Array([4]));
  await put('target', m1B.cacheSave(target, { saveContent: true }));
  mode = 'network'; // the request was sent; the response never arrived
  await assert.rejects(m1B.transaction([m1B.cacheLoad(await get('target'))]), (e) => e instanceof E.NetworkError);
  // Context 2: recreated managers reload only from synthetic IndexedDB.
  mode = 'ok';
  const m2B = await managerFor(colB);
  await m2B.transaction([m2B.cacheLoad(await get('target'))]);
  const m2A = await managerFor(colA);
  const del = m2A.cacheLoad(await get('source'));
  del.delete();
  await put('sourceDelete', m2A.cacheSave(del, { saveContent: true }));
  mode = 'network';
  await assert.rejects(m2A.transaction([m2A.cacheLoad(await get('sourceDelete'))]), (e) => e instanceof E.NetworkError);
  // Context 3: the source deletion is retried from the persisted snapshot.
  mode = 'ok';
  const m3A = await managerFor(colA);
  await m3A.transaction([m3A.cacheLoad(await get('sourceDelete'))]);
  const [lostCreate, retryCreate, lostDelete, retryDelete] = calls;
  for (const c of [lostCreate, retryCreate]) assert.ok(c.path.includes(`/collection/${colB}/item/transaction/`));
  for (const c of [lostDelete, retryDelete]) assert.ok(c.path.includes(`/collection/${colA}/item/transaction/`));
  assert.equal(retryCreate.body.items[0].uid, lostCreate.body.items[0].uid);
  assert.equal(retryCreate.body.items[0].content.uid, lostCreate.body.items[0].content.uid);
  assert.equal(retryCreate.body.items[0].etag ?? null, null);
  assert.equal(retryDelete.body.items[0].etag, await get('sourceRevision'));
  assert.equal(retryDelete.body.items[0].content.uid, lostDelete.body.items[0].content.uid);
  assert.equal(retryDelete.body.items[0].content.deleted, true);
  assert.equal(calls.length, 4);
});
