'use strict';
// Synthetic offline-protocol experiment: shared IDB/crypto helpers and the
// control model of the rejected behaviour. Not application code.
const path = require('node:path');
const { createRequire } = require('node:module');
const { webcrypto, randomUUID } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const { IDBFactory } = createRequire(path.join(ROOT, 'apps/web/package.json'))('fake-indexeddb');
const subtle = webcrypto.subtle;
const limits = { work: 100, loss: 100 };

class Reject extends Error {
  constructor(code) { super(code); this.code = code; }
}
const rid = () => randomUUID();
const newFactory = () => new IDBFactory();
const collectionOf = (tuple) => tuple.split('/')[1];
const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

// One IDB transaction. Resolves only on `complete`; any throw aborts it.
async function run(db, names, mode, body) {
  const t = db.transaction(names, mode);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error || new Error('AbortError'));
  });
  const s = {};
  for (const n of names) s[n] = t.objectStore(n);
  let out;
  try {
    out = await body(s, t);
  } catch (err) {
    try { t.abort(); } catch { /* already finished */ }
    await done.catch(() => {});
    throw err;
  }
  await done;
  return out;
}

const V2 = ['meta', 'crypto', 'work', 'payload', 'loss', 'attempt', 'display', 'legacy'];
function openQueue(factory, version) {
  return new Promise((resolve, reject) => {
    const r = factory.open('synthetic-queue', version);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('mutations')) db.createObjectStore('mutations', { keyPath: 'id' });
      if (version >= 2) {
        for (const n of V2) {
          if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, n === 'meta' || n === 'crypto' ? undefined : { keyPath: 'id' });
        }
      }
    };
    r.onblocked = () => reject(new Reject('upgrade-blocked'));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// Synthetic cache. v5 mirrors the current layout; v6 copies legacy primaries
// into `hold` inside the version-change transaction itself.
function openCache(factory, version) {
  return new Promise((resolve, reject) => {
    const r = factory.open('synthetic-cache', version);
    r.onupgradeneeded = (ev) => {
      const db = r.result;
      if (ev.oldVersion < 5) {
        db.createObjectStore('items', { keyPath: 'itemUid' });
        db.createObjectStore('meta');
        db.createObjectStore('crypto');
      }
      if (version >= 6 && ev.oldVersion < 6) {
        const hold = db.createObjectStore('hold', { keyPath: 'itemUid' });
        const t = r.transaction;
        const keyReq = t.objectStore('crypto').get('envelope-key');
        keyReq.onsuccess = () => {
          const cacheKey = keyReq.result || null;
          t.objectStore('items').openCursor().onsuccess = (e) => {
            const cur = e.target.result;
            if (!cur) return;
            if (cur.value.collectionType === 'notes' || cur.value.collectionType === 'contacts') hold.put({ ...cur.value, cacheKey });
            cur.continue();
          };
        };
      }
    };
    r.onblocked = () => reject(new Reject('upgrade-blocked'));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function openSecure(factory) {
  return new Promise((resolve, reject) => {
    const r = factory.open('synthetic-secure', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keyval');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// ---- crypto ----
const genKey = () => subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
async function seal(key, value) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(JSON.stringify(value))));
  return { iv: Array.from(iv), ct: Array.from(ct) };
}
async function unseal(key, rec) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(rec.iv) }, key, Uint8Array.from(rec.ct));
  return JSON.parse(Buffer.from(pt).toString());
}
function bytes(a, min, max) {
  if (!Array.isArray(a) || a.length < min || a.length > max) return false;
  for (let i = 0; i < a.length; i++) {
    if (!(i in a)) return false;
    const v = a[i];
    if (!Number.isInteger(v) || v < 0 || v > 255) return false;
  }
  return true;
}
const structural = (rec) => Boolean(rec) && bytes(rec.iv, 12, 12) && bytes(rec.ct, 16, Infinity);
async function classify(key, rec) {
  if (!rec) return 'absent';
  if (!structural(rec)) return 'malformed';
  if (!key) return 'locked';
  try { await unseal(key, rec); return 'intact'; } catch { return 'ambiguous'; }
}

// ---- owner / context ----
async function initOwner(db, fingerprint) {
  const key = await genKey();
  const envelopeId = rid();
  await run(db, ['meta', 'crypto'], 'readwrite', async (s) => {
    s.meta.put({ fingerprint, lifecycleGen: 1, envelopeId, session: `session-${fingerprint}` }, 'owner');
    s.crypto.put({ key, envelopeId }, 'env');
  });
}
async function context(db) {
  const owner = await run(db, ['meta', 'crypto'], 'readonly', async (s) => {
    const m = await req(s.meta.get('owner'));
    const c = await req(s.crypto.get('env'));
    return { fingerprint: m.fingerprint, lifecycleGen: m.lifecycleGen, envelopeId: m.envelopeId, key: c.key };
  });
  return { db, owner, memory: new Map() };
}
async function checkOwner(s, owner, fingerprintOnly = false) {
  const m = await req(s.meta.get('owner'));
  if (!m || m.fingerprint !== owner.fingerprint) throw new Reject('owner-changed');
  if (!fingerprintOnly && (m.lifecycleGen !== owner.lifecycleGen || m.envelopeId !== owner.envelopeId)) throw new Reject('owner-changed');
  return m;
}

// ---- inspection / fixture helpers ----
const readOwner = (db) => run(db, ['meta'], 'readonly', async (s) => req(s.meta.get('owner')));
const readProbe = (db) => run(db, ['meta'], 'readonly', async (s) => req(s.meta.get('probe')));
const readSecure = (db) => run(db, ['keyval'], 'readonly', async (s) => req(s.keyval.get('etebase_session')));
const getWork = (db, tuple) => run(db, ['work'], 'readonly', async (s) => req(s.work.get(tuple)));
async function dropPayload(db, tuple) {
  await run(db, ['work', 'payload'], 'readwrite', async (s) => {
    const w = await req(s.work.get(tuple));
    if (w && w.payloadId) s.payload.delete(w.payloadId);
  });
}
async function listLoss(db) {
  return run(db, ['loss', 'work'], 'readonly', async (s) => [
    ...(await req(s.loss.getAll())),
    ...(await req(s.work.getAll())).filter((w) => w.status === 'lost'),
  ]);
}
async function rawDump(db) {
  const names = [...db.objectStoreNames].filter((n) => n !== 'crypto');
  return run(db, names, 'readonly', async (s) => {
    const out = {};
    for (const n of names) out[n] = await req(s[n].getAll());
    return JSON.stringify(out);
  });
}
const oldCachePut = (cacheDb, item) => run(cacheDb, ['items'], 'readwrite', async (s) => { s.items.put(item); });
const dispatchable = (rec) => rec.status === 'pending';
const VISIBILITY = { remote: 'hidden', queued: 'hidden', uncertain: 'pending-visible', rejected: 'visible' };
const visibility = (outcome) => VISIBILITY[outcome];

// Resolves on request success like a fire-and-forget helper (control).
function requestSuccessWrite(db, value, abortAfter) {
  return new Promise((resolve) => {
    const t = db.transaction(['meta'], 'readwrite');
    const r = t.objectStore('meta').put(value, 'probe');
    t.onabort = () => {};
    r.onsuccess = () => { resolve('resolved'); if (abortAfter) t.abort(); };
    r.onerror = () => resolve('swallowed');
  });
}
// Resolves only when the transaction commits (candidate).
const durableWrite = (db, value, abortAfter) => run(db, ['meta'], 'readwrite', async (s) => {
  await req(s.meta.put(value, 'probe'));
  if (abortAfter) throw new Reject('aborted');
});

async function seedLegacy(o = {}) {
  const factory = newFactory();
  const key = await genKey();
  const foreign = await genKey();
  const base = { itemUid: 'item1', collectionType: 'notes', collectionUid: 'nb1' };
  const original = { ...base, ...(await seal(o.foreignKey ? foreign : key, { body: 'SYNTH-LEGACY-LOCAL' })) };
  if (o.malformed) original.iv = [1, 2, 3];
  const serverCopy = { ...base, ...(await seal(key, { body: 'SYNTH-SERVER-COPY' })) };
  const mutations = o.mutations || [{ id: 'm1', type: 'update', collectionType: 'notes', itemUid: 'item1' }];
  const items = o.items || [original];
  const q = await openQueue(factory, 1);
  await run(q, ['mutations'], 'readwrite', async (s) => {
    for (const m of mutations) s.mutations.put({ accountFingerprint: 'acct-A', status: 'pending', collectionType: 'notes', ...m });
  });
  q.close();
  const c = await openCache(factory, 5);
  await run(c, ['items', 'crypto'], 'readwrite', async (s) => {
    for (const it of items) s.items.put(it);
    if (o.withKey !== false) s.crypto.put(key, 'envelope-key');
  });
  c.close();
  const newContext = async () => {
    const db = await openQueue(factory, 2);
    await initOwner(db, 'acct-A');
    return context(db);
  };
  return { factory, original, serverCopy, newContext };
}

// ---- control: models the rejected behaviour ----
async function readPrimaryV5(factory, itemUid) {
  const c = await openCache(factory, 5);
  try {
    return await run(c, ['items', 'crypto'], 'readonly', async (s) => ({
      raw: (await req(s.items.get(itemUid))) || null,
      key: (await req(s.crypto.get('envelope-key'))) || null,
    }));
  } finally { c.close(); }
}

const control = {
  async admit(ctx, tuple, value) {
    const { favorite, ...rest } = value;
    const sealed = await seal(ctx.owner.key, rest);
    const row = await run(ctx.db, ['meta', 'work', 'payload'], 'readwrite', async (s) => {
      await checkOwner(s, ctx.owner, true);
      const old = await req(s.work.get(tuple));
      if (old && !(old.payloadId && (await req(s.payload.get(old.payloadId))))) { old.status = 'lost'; s.work.put(old); }
      if (!old && (await req(s.work.count())) + 1 > limits.work) throw new Reject('capacity');
      const payloadId = rid();
      s.payload.put({ id: payloadId, ...sealed });
      const next = { id: tuple, collection: collectionOf(tuple), kind: value.kind || 'body', workGen: rid(), payloadId, status: 'pending' };
      if (favorite !== undefined) next.patch = { favorite };
      s.work.put(next);
      return next;
    });
    ctx.memory.set(tuple, { body: value.body });
    return row;
  },
  admitFavorite(ctx, tuple, favorite) {
    const m = ctx.memory.get(tuple);
    return control.admit(ctx, tuple, { body: m ? m.body : null, favorite });
  },
  async intent(ctx, tuple) {
    const { w, p } = await run(ctx.db, ['work', 'payload'], 'readonly', async (s) => {
      const w = await req(s.work.get(tuple));
      return { w, p: await req(s.payload.get(w.payloadId)) };
    });
    return { ...(await unseal(ctx.owner.key, p)), ...(w.patch || {}) };
  },
  beginDispatch(ctx, tuple, expected, revUid, materialized) {
    return run(ctx.db, ['work'], 'readwrite', async (s) => {
      const w = await req(s.work.get(tuple));
      if (!w || w.workGen !== expected.workGen) throw new Reject('dispatch-cas');
      w.dispatch = { revUid };
      s.work.put(w);
      return { revUid, body: materialized.body, workGen: w.workGen };
    });
  },
  async reconcile(ctx, tuple, remote) {
    const w = await getWork(ctx.db, tuple);
    return w && w.dispatch && remote.history.includes(w.dispatch.revUid) ? 'applied' : 'resend';
  },
  ack(ctx, attempt, tuple) {
    return run(ctx.db, ['work'], 'readwrite', async (s) => {
      const w = await req(s.work.get(tuple));
      if (!w || w.workGen !== attempt.workGen) return 'superseded';
      w.status = 'acked';
      s.work.put(w);
      return 'acked';
    });
  },
  async publish(ctx, tuple, attempt) {
    await run(ctx.db, ['display'], 'readwrite', async (s) => { s.display.put({ id: tuple, body: attempt.body }); });
    ctx.memory.set(tuple, { body: attempt.body });
    return attempt.body;
  },
  refreshPublish(ctx, items) {
    return run(ctx.db, ['display'], 'readwrite', async (s) => {
      for (const [tuple, body] of items) s.display.put({ id: tuple, body });
    });
  },
  async hydrate(ctx) {
    const rows = await run(ctx.db, ['display'], 'readonly', async (s) => req(s.display.getAll()));
    return new Map(rows.map((r) => [r.id, r.body]));
  },
  admitDelete: (ctx, tuple) => control.admit(ctx, tuple, { kind: 'delete' }),
  admitMove: (ctx, tuple, value) => control.admit(ctx, tuple, { ...value, kind: 'move' }),
  async beginCollectionDelete() {},
  collectionDelete(ctx, collection) {
    return run(ctx.db, ['work'], 'readwrite', async (s) => {
      for (const w of await req(s.work.getAll())) if (w.collection === collection) s.work.delete(w.id);
    });
  },
  admitDeletes(ctx, tuples) {
    return run(ctx.db, ['work'], 'readwrite', async (s) => {
      if ((await req(s.work.count())) + tuples.length > limits.work) throw new Reject('capacity');
      for (const t of tuples) s.work.put({ id: t, collection: collectionOf(t), kind: 'delete', workGen: rid(), status: 'pending' });
      return { admitted: tuples, rejected: [] };
    });
  },
  async replaceOwner(db, _expectedGen, fingerprint) {
    const key = await genKey();
    const envelopeId = rid();
    return run(db, ['meta', 'crypto', 'work', 'payload'], 'readwrite', async (s) => {
      const m = await req(s.meta.get('owner'));
      const gen = (m ? m.lifecycleGen : 0) + 1;
      s.work.clear();
      s.payload.clear();
      s.meta.put({ fingerprint, lifecycleGen: gen, envelopeId, session: null }, 'owner');
      s.crypto.put({ key, envelopeId }, 'env');
      return gen;
    });
  },
  publishSession(db, _gen, _fingerprint, session) {
    return run(db, ['meta'], 'readwrite', async (s) => {
      const m = await req(s.meta.get('owner'));
      s.meta.put({ ...m, session }, 'owner');
    });
  },
  // Owner in the queue DB, session in a separate DB, no generation check.
  async login(queueDb, secureDb, fingerprint, hooks = {}) {
    await control.replaceOwner(queueDb, null, fingerprint);
    if (hooks.beforeSession) await hooks.beforeSession();
    await new Promise((resolve) => {
      const t = secureDb.transaction(['keyval'], 'readwrite');
      const r = t.objectStore('keyval').put(`session-${fingerprint}`, 'etebase_session');
      r.onsuccess = () => resolve();
      r.onerror = () => resolve();
    });
  },
  async setFence() {},
  async dispatchAllowed() { return true; },
  // Pins in the old-readable cache, copy later.
  async migrate(ctx, factory, hooks = {}) {
    const muts = await run(ctx.db, ['mutations'], 'readonly', async (s) => req(s.mutations.getAll()));
    const c = await openCache(factory, 5);
    await run(c, ['meta'], 'readwrite', async (s) => { s.meta.put(muts.map((m) => m.itemUid), 'pins'); });
    c.close();
    if (hooks.beforeCopy) await hooks.beforeCopy();
    const out = [];
    for (const m of muts) {
      const { raw, key } = await readPrimaryV5(factory, m.itemUid);
      let status;
      if (m.type === 'delete' || !raw) status = 'retired';
      else if (!key) status = 'unverified';
      else status = 'unverified';
      out.push({ id: m.id, kind: m.type, status, raw: !key || !raw ? null : { iv: raw.iv, ct: raw.ct } });
    }
    return out;
  },
};

module.exports = {
  ROOT, limits, Reject, rid, req, run, newFactory, collectionOf,
  openQueue, openCache, openSecure, genKey, seal, unseal, structural, classify,
  initOwner, context, checkOwner, readOwner, readProbe, readSecure, getWork, dropPayload,
  listLoss, rawDump, oldCachePut, dispatchable, visibility, requestSuccessWrite, durableWrite,
  seedLegacy, control,
};
