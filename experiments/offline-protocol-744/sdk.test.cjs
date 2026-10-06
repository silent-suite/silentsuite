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
