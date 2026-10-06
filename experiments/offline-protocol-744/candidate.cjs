'use strict';
// Proposed synthetic protocol under test. Not application code.
const P = require('./protocol.cjs');
const { Reject, req, run, rid, limits, collectionOf, seal, unseal, structural, classify, checkOwner, genKey, openCache } = P;

async function admit(ctx, tuple, value, opts = {}) {
  const sealed = value.kind === 'delete' ? null : await seal(ctx.owner.key, value);
  const row = await run(ctx.db, ['meta', 'work', 'payload', 'loss'], 'readwrite', async (s) => {
    await checkOwner(s, ctx.owner);
    if (await req(s.meta.get(`barrier:${collectionOf(tuple)}`))) throw new Reject('collection-barrier');
    const old = await req(s.work.get(tuple));
    if (opts.expectGen !== undefined && (old ? old.workGen : null) !== opts.expectGen) throw new Reject('retry');
    if (old && old.kind === 'move' && value.kind !== 'move') throw new Reject('move-in-progress');
    if (old && value.kind === 'move') throw new Reject('work-in-progress');
    if (!old && (await req(s.work.count())) + 1 > limits.work) throw new Reject('capacity');
    if (old) {
      // Classify the evidence being replaced inside the same transaction.
      const p = old.payloadId ? await req(s.payload.get(old.payloadId)) : null;
      if (old.kind !== 'delete' && !structural(p)) {
        if ((await req(s.loss.count())) + 1 > limits.loss) throw new Reject('loss-capacity');
        s.loss.put({ id: `${tuple}#${old.workGen}`, tuple, lossGen: old.workGen });
      }
      if (p) s.payload.delete(old.payloadId);
    }
    const seq = ((await req(s.meta.get('seq'))) || 0) + 1;
    s.meta.put(seq, 'seq');
    let payloadId = null;
    if (sealed) {
      payloadId = rid();
      s.payload.put({ id: payloadId, envelopeId: ctx.owner.envelopeId, ...sealed });
    }
    const next = { id: tuple, collection: collectionOf(tuple), kind: value.kind || 'body', workGen: rid(), seq, payloadId, status: 'pending', attemptId: null };
    s.work.put(next);
    return next;
  });
  ctx.memory.set(tuple, { seq: row.seq, body: value.body });
  return row;
}

async function readIntent(ctx, tuple) {
  const snap = await run(ctx.db, ['work', 'payload'], 'readonly', async (s) => {
    const w = await req(s.work.get(tuple));
    return { gen: w ? w.workGen : null, p: w && w.payloadId ? await req(s.payload.get(w.payloadId)) : null };
  });
  const value = structural(snap.p) ? await unseal(ctx.owner.key, snap.p).catch(() => null) : null;
  return { gen: snap.gen, value };
}

const candidate = {
  admit,
  async admitFavorite(ctx, tuple, favorite) {
    for (let i = 0; i < 3; i++) {
      const { gen, value } = await readIntent(ctx, tuple);
      try {
        return await admit(ctx, tuple, { body: value ? value.body : null, favorite }, { expectGen: gen });
      } catch (err) {
        if (err.code !== 'retry') throw err;
      }
    }
    throw new Reject('retry-exhausted');
  },
  async intent(ctx, tuple) {
    const { value } = await readIntent(ctx, tuple);
    return value;
  },
  async beginDispatch(ctx, tuple, expected, revUid, materialized) {
    const sealed = await seal(ctx.owner.key, materialized);
    return run(ctx.db, ['meta', 'work', 'attempt', 'payload'], 'readwrite', async (s) => {
      await checkOwner(s, ctx.owner);
      const w = await req(s.work.get(tuple));
      if (!w || w.workGen !== expected.workGen || w.attemptId !== (expected.attemptId ?? null)) throw new Reject('dispatch-cas');
      const payloadId = rid();
      s.payload.put({ id: payloadId, envelopeId: ctx.owner.envelopeId, ...sealed });
      const attempt = { id: rid(), tuple, workGen: w.workGen, revUid, payloadId };
      s.attempt.add(attempt);
      w.attemptId = attempt.id;
      s.work.put(w);
      return attempt;
    });
  },
  async reconcile(ctx, tuple, remote) {
    const attempts = await run(ctx.db, ['work', 'attempt'], 'readonly', async (s) => {
      const w = await req(s.work.get(tuple));
      if (!w) return [];
      return (await req(s.attempt.getAll())).filter((a) => a.tuple === tuple && a.workGen === w.workGen);
    });
    return attempts.some((a) => remote.history.includes(a.revUid)) ? 'applied' : 'resend';
  },
  ack(ctx, attempt) {
    return run(ctx.db, ['meta', 'work'], 'readwrite', async (s) => {
      await checkOwner(s, ctx.owner);
      const w = await req(s.work.get(attempt.tuple));
      if (!w || w.workGen !== attempt.workGen) return 'superseded';
      w.status = 'acked';
      w.ackedAttempt = attempt.id;
      s.work.put(w);
      return 'acked';
    });
  },
  async publish(ctx, tuple, attempt) {
    const p = await run(ctx.db, ['payload'], 'readonly', async (s) => req(s.payload.get(attempt.payloadId)));
    if (!p) throw new Reject('stale-publication');
    const body = (await unseal(ctx.owner.key, p)).body;
    const seq = await run(ctx.db, ['meta', 'work', 'display', 'payload'], 'readwrite', async (s) => {
      await checkOwner(s, ctx.owner);
      const w = await req(s.work.get(tuple));
      if (!w || w.status !== 'acked' || w.ackedAttempt !== attempt.id) throw new Reject('stale-publication');
      const d = await req(s.display.get(tuple));
      if (d && d.seq > w.seq) throw new Reject('stale-publication');
      s.display.put({ id: tuple, seq: w.seq, iv: p.iv, ct: p.ct, envelopeId: p.envelopeId });
      s.work.delete(tuple);
      if (w.payloadId) s.payload.delete(w.payloadId);
      return w.seq;
    });
    const m = ctx.memory.get(tuple);
    if (!m || m.seq === undefined || m.seq <= seq) ctx.memory.set(tuple, { seq, body });
    return body;
  },
  async refreshPublish(ctx, items) {
    const sealed = [];
    for (const [tuple, body] of items) sealed.push([tuple, await seal(ctx.owner.key, { body })]);
    await run(ctx.db, ['meta', 'work', 'display'], 'readwrite', async (s) => {
      await checkOwner(s, ctx.owner);
      const seq = (await req(s.meta.get('seq'))) || 0;
      for (const [tuple, rec] of sealed) {
        if (await req(s.work.get(tuple))) continue; // live work keeps the overlay
        s.display.put({ id: tuple, seq, envelopeId: ctx.owner.envelopeId, ...rec });
      }
    });
  },
  async hydrate(ctx) {
    const { display, work, payloads } = await run(ctx.db, ['display', 'work', 'payload'], 'readonly', async (s) => ({
      display: await req(s.display.getAll()),
      work: await req(s.work.getAll()),
      payloads: await req(s.payload.getAll()),
    }));
    const byId = new Map(payloads.map((p) => [p.id, p]));
    const view = new Map();
    for (const d of display) view.set(d.id, (await unseal(ctx.owner.key, d)).body);
    for (const w of work) {
      if (w.kind === 'delete') { view.delete(w.id); continue; }
      const p = byId.get(w.payloadId);
      if (structural(p)) view.set(w.id, (await unseal(ctx.owner.key, p)).body);
    }
    return view;
  },
  admitDelete: (ctx, tuple) => admit(ctx, tuple, { kind: 'delete' }),
  admitMove: (ctx, tuple, value) => admit(ctx, tuple, { ...value, kind: 'move' }),
  beginCollectionDelete(ctx, collection) {
    return run(ctx.db, ['meta'], 'readwrite', async (s) => {
      await checkOwner(s, ctx.owner);
      s.meta.put(true, `barrier:${collection}`);
    });
  },
  collectionDelete(ctx, collection) {
    return run(ctx.db, ['meta', 'work', 'payload', 'loss'], 'readwrite', async (s) => {
      await checkOwner(s, ctx.owner);
      for (const w of await req(s.work.getAll())) {
        if (w.collection !== collection) continue;
        if (w.kind === 'move' && w.attemptId) throw new Reject('move-in-progress');
        const p = w.payloadId ? await req(s.payload.get(w.payloadId)) : null;
        if (w.kind !== 'delete' && !structural(p)) s.loss.put({ id: `${w.id}#${w.workGen}`, tuple: w.id, lossGen: w.workGen });
        if (p) s.payload.delete(w.payloadId);
        s.work.delete(w.id);
      }
      s.meta.delete(`barrier:${collection}`);
    });
  },
  admitDeletes(ctx, tuples) {
    return run(ctx.db, ['meta', 'work', 'payload', 'loss'], 'readwrite', async (s) => {
      await checkOwner(s, ctx.owner);
      let free = limits.work - (await req(s.work.count()));
      const admitted = [];
      const rejected = [];
      let seq = (await req(s.meta.get('seq'))) || 0;
      for (const tuple of tuples) {
        const old = await req(s.work.get(tuple));
        if ((old && old.kind === 'move') || (!old && free <= 0)) { rejected.push(tuple); continue; }
        if (old) {
          const p = old.payloadId ? await req(s.payload.get(old.payloadId)) : null;
          if (old.kind !== 'delete' && !structural(p)) s.loss.put({ id: `${tuple}#${old.workGen}`, tuple, lossGen: old.workGen });
          if (p) s.payload.delete(old.payloadId);
        } else {
          free -= 1;
        }
        seq += 1;
        s.work.put({ id: tuple, collection: collectionOf(tuple), kind: 'delete', workGen: rid(), seq, payloadId: null, status: 'pending', attemptId: null });
        admitted.push(tuple);
      }
      s.meta.put(seq, 'seq');
      return { admitted, rejected };
    });
  },
  // Owner, session and key change together, guarded by the lifecycle generation.
  async replaceOwner(db, expectedGen, fingerprint) {
    const key = await genKey();
    const envelopeId = rid();
    return run(db, ['meta', 'crypto', 'work', 'payload', 'attempt', 'display', 'loss', 'legacy'], 'readwrite', async (s) => {
      const m = await req(s.meta.get('owner'));
      if ((m ? m.lifecycleGen : 0) !== expectedGen) throw new Reject('stale-owner');
      for (const n of ['work', 'payload', 'attempt', 'display', 'loss', 'legacy']) s[n].clear();
      s.meta.put({ fingerprint, lifecycleGen: expectedGen + 1, envelopeId, session: `session-${fingerprint}` }, 'owner');
      s.crypto.put({ key, envelopeId }, 'env');
      return expectedGen + 1;
    });
  },
  publishSession(db, expectedGen, fingerprint, session) {
    return run(db, ['meta'], 'readwrite', async (s) => {
      const m = await req(s.meta.get('owner'));
      if (!m || m.lifecycleGen !== expectedGen || m.fingerprint !== fingerprint) throw new Reject('stale-owner');
      s.meta.put({ ...m, session }, 'owner');
    });
  },
  setFence(ctx, state, server) {
    return run(ctx.db, ['meta'], 'readwrite', async (s) => {
      await checkOwner(s, ctx.owner);
      s.meta.put({ state, server }, 'fence');
    });
  },
  async dispatchAllowed(ctx, server) {
    const f = await run(ctx.db, ['meta'], 'readonly', async (s) => req(s.meta.get('fence')));
    return Boolean(f && f.state === 'active' && f.server === server);
  },
  // Cache v6 upgrade is blocked by any open old cache connection; once it
  // completes, old bundles cannot open the cache or the queue at all.
  async migrate(ctx, factory) {
    const cache = await openCache(factory, 6);
    try {
      const muts = await run(ctx.db, ['mutations'], 'readonly', async (s) => req(s.mutations.getAll()));
      const out = [];
      for (const m of muts) {
        const held = await run(cache, ['hold'], 'readonly', async (s) => (await req(s.hold.get(m.itemUid))) || null);
        let status;
        if (m.type === 'delete') status = 'unverified-delete';
        else if (!held) status = 'legacy-unresolved';
        else status = { intact: 'unverified', locked: 'pending-locked', ambiguous: 'pending-ambiguous', malformed: 'lost' }[await classify(held.cacheKey, held)];
        const raw = held ? { iv: held.iv, ct: held.ct } : null;
        const rec = await run(ctx.db, ['meta', 'legacy', 'loss'], 'readwrite', async (s) => {
          await checkOwner(s, ctx.owner);
          const existing = await req(s.legacy.get(m.id));
          if (existing) return existing;
          const next = { id: m.id, kind: m.type, status, raw, cacheKey: held ? held.cacheKey : null };
          s.legacy.put(next);
          if (status === 'lost') s.loss.put({ id: `legacy:${m.id}`, tuple: `${m.collectionType}/legacy/${m.itemUid}`, lossGen: m.id });
          return next;
        });
        // Release the held copy only after the queue copy is durable.
        if (held && rec.raw) await run(cache, ['hold'], 'readwrite', async (s) => { s.hold.delete(m.itemUid); });
        const { cacheKey, ...pub } = rec;
        out.push(pub);
      }
      return out;
    } finally { cache.close(); }
  },
};

module.exports = candidate;
