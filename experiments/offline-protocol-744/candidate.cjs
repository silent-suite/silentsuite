'use strict';
// Proposed synthetic protocol under test. Not application code.
const P = require('./protocol.cjs');
const { Reject, req, run, rid, limits, collectionOf, seal, unseal, structural, checkOwner, genKey, openCache } = P;
const { webcrypto } = require('node:crypto');

const ownerTag = (o) => ({ fingerprint: o.fingerprint, lifecycleGen: o.lifecycleGen, envelopeId: o.envelopeId });
const sameOwner = (a, b) => Boolean(a && b) && a.fingerprint === b.fingerprint && a.lifecycleGen === b.lifecycleGen && a.envelopeId === b.envelopeId;
const RECEIPT_FIELDS = ['id', 'tuple', 'workGen', 'revUid', 'payloadId'];
// Outstanding refresh tokens per queue; well below the work limit.
const REFRESH_TOKEN_CAP = 8;

async function nextSeq(s) {
  const seq = ((await req(s.meta.get('seq'))) || 0) + 1;
  s.meta.put(seq, 'seq');
  return seq;
}

// Common admission policy for every mutator (single, bulk, move endpoints).
async function policy(s, tuple, value) {
  if ((await req(s.meta.get('cutover'))) === 'pending') throw new Reject('cutover-pending');
  const cols = [collectionOf(tuple)];
  if (value && value.kind === 'move' && value.target) cols.push(value.target);
  for (const col of cols) if (await req(s.meta.get(`barrier:${col}`))) throw new Reject('collection-barrier');
}

// Classifies the evidence a replacement would retire. The loss count is read
// inside the same transaction, so it already includes losses written earlier
// in it; `checkLimit` is false only when the caller checked the whole post-state.
async function retireEvidence(s, tuple, old, checkLimit = true) {
  const p = old.payloadId ? await req(s.payload.get(old.payloadId)) : null;
  const loss = old.kind !== 'delete' && !structural(p);
  if (loss && checkLimit && (await req(s.loss.count())) + 1 > limits.loss) throw new Reject('loss-capacity');
  const commit = () => {
    if (loss) s.loss.put({ id: `${tuple}#${old.workGen}`, tuple, lossGen: old.workGen });
    if (p) s.payload.delete(old.payloadId);
  };
  return { loss, commit };
}

async function admit(ctx, tuple, value, opts = {}) {
  const sealed = value.kind === 'delete' ? null : await seal(ctx.owner.key, value);
  const row = await run(ctx.db, ['meta', 'work', 'payload', 'loss', 'display'], 'readwrite', async (s) => {
    await checkOwner(s, ctx.owner);
    await policy(s, tuple, value);
    const old = await req(s.work.get(tuple));
    if (opts.expectGen !== undefined && (old ? old.workGen : null) !== opts.expectGen) throw new Reject('retry');
    if (opts.expectDisplayRev !== undefined) {
      const d = await req(s.display.get(tuple));
      if ((d ? d.rev : null) !== opts.expectDisplayRev) throw new Reject('retry');
    }
    if (old && old.kind === 'move' && value.kind !== 'move') throw new Reject('move-in-progress');
    if (old && value.kind === 'move') throw new Reject('work-in-progress');
    if (!old && (await req(s.work.count())) + 1 > limits.work) throw new Reject('capacity');
    if (old) (await retireEvidence(s, tuple, old)).commit();
    const seq = await nextSeq(s);
    let payloadId = null;
    if (sealed) {
      payloadId = rid();
      s.payload.put({ id: payloadId, envelopeId: ctx.owner.envelopeId, ...sealed });
    }
    const next = { id: tuple, collection: collectionOf(tuple), kind: value.kind || 'body', workGen: rid(), seq, payloadId, status: 'pending', attemptId: null };
    if (value.kind === 'move') next.target = value.target; // collection id: allowlisted metadata
    s.work.put(next);
    return next;
  });
  ctx.memory.set(tuple, { seq: row.seq, body: value.body });
  return row;
}

async function decryptOwned(ctx, rec) {
  if (!ctx.owner.key || rec.envelopeId !== ctx.owner.envelopeId) throw new Reject('unreadable-evidence');
  try { return await unseal(ctx.owner.key, rec); } catch { throw new Reject('unreadable-evidence'); }
}

// The authoritative current body: live work, else the display copy.
async function authoritative(ctx, tuple) {
  const snap = await run(ctx.db, ['meta', 'work', 'payload', 'display'], 'readonly', async (s) => {
    await checkOwner(s, ctx.owner);
    const w = await req(s.work.get(tuple));
    if (w) return { gen: w.workGen, kind: w.kind, rec: w.payloadId ? (await req(s.payload.get(w.payloadId))) || null : null };
    const d = await req(s.display.get(tuple));
    return { gen: null, displayRev: d ? d.rev : null, rec: d && !d.tombstone ? d : null };
  });
  if (!snap.rec || !structural(snap.rec)) throw new Reject('no-authoritative-body');
  return { ...snap, value: await decryptOwned(ctx, snap.rec) };
}

async function resolveAttempt(s, receipt, tuple) {
  const a = receipt && receipt.id ? await req(s.attempt.get(receipt.id)) : null;
  if (!a || a.tuple !== tuple || RECEIPT_FIELDS.some((f) => a[f] !== receipt[f])) throw new Reject('receipt-mismatch');
  return a;
}

const candidate = {
  admit,
  async admitFavorite(ctx, tuple, favorite) {
    for (let i = 0; i < 3; i++) {
      const cur = await authoritative(ctx, tuple);
      const opts = cur.gen !== null ? { expectGen: cur.gen } : { expectGen: null, expectDisplayRev: cur.displayRev };
      try {
        return await admit(ctx, tuple, { body: cur.value.body, favorite }, opts);
      } catch (err) {
        if (err.code !== 'retry') throw err;
      }
    }
    throw new Reject('retry-exhausted');
  },
  async intent(ctx, tuple) {
    return (await authoritative(ctx, tuple)).value;
  },
  async beginDispatch(ctx, tuple, expected, revUid, materialized) {
    const sealed = await seal(ctx.owner.key, materialized);
    return run(ctx.db, ['meta', 'work', 'attempt', 'payload'], 'readwrite', async (s) => {
      const m = await checkOwner(s, ctx.owner);
      const f = await req(s.meta.get('fence'));
      if (!f || f.state !== 'active' || f.server !== ctx.server || f.fingerprint !== m.fingerprint || f.lifecycleGen !== m.lifecycleGen) throw new Reject('not-activated');
      const w = await req(s.work.get(tuple));
      if (!w || w.workGen !== expected.workGen || w.attemptId !== (expected.attemptId ?? null)) throw new Reject('dispatch-cas');
      const payloadId = rid();
      s.payload.put({ id: payloadId, envelopeId: ctx.owner.envelopeId, ...sealed });
      const attempt = { id: rid(), tuple, workGen: w.workGen, revUid, payloadId, owner: ownerTag(ctx.owner), server: ctx.server };
      s.attempt.add(attempt);
      w.attemptId = attempt.id;
      s.work.put(w);
      return { id: attempt.id, tuple, workGen: attempt.workGen, revUid, payloadId };
    });
  },
  async reconcile(ctx, tuple, remote) {
    const attempts = await run(ctx.db, ['meta', 'work', 'attempt'], 'readonly', async (s) => {
      await checkOwner(s, ctx.owner);
      const w = await req(s.work.get(tuple));
      if (!w) return [];
      return (await req(s.attempt.getAll())).filter((a) => a.tuple === tuple && a.workGen === w.workGen);
    });
    return attempts.some((a) => remote.history.includes(a.revUid)) ? 'applied' : 'resend';
  },
  ack(ctx, receipt, tuple) {
    return run(ctx.db, ['meta', 'work', 'attempt'], 'readwrite', async (s) => {
      await checkOwner(s, ctx.owner);
      const a = await resolveAttempt(s, receipt, tuple || receipt.tuple);
      if (!sameOwner(a.owner, ctx.owner)) throw new Reject('receipt-mismatch');
      const w = await req(s.work.get(a.tuple));
      if (!w || w.workGen !== a.workGen) return 'superseded';
      w.status = 'acked';
      w.ackedAttempt = a.id;
      s.work.put(w);
      return 'acked';
    });
  },
  async publish(ctx, tuple, receipt) {
    const pre = await run(ctx.db, ['meta', 'attempt', 'payload'], 'readonly', async (s) => {
      await checkOwner(s, ctx.owner);
      const a = await resolveAttempt(s, receipt, tuple);
      return { a, p: (await req(s.payload.get(a.payloadId))) || null };
    });
    if (!pre.p || !sameOwner(pre.a.owner, ctx.owner)) throw new Reject('receipt-mismatch');
    const value = await decryptOwned(ctx, pre.p);
    const seq = await run(ctx.db, ['meta', 'work', 'display', 'payload', 'attempt'], 'readwrite', async (s) => {
      await checkOwner(s, ctx.owner);
      const a = await resolveAttempt(s, receipt, tuple); // revalidate at retirement
      const w = await req(s.work.get(tuple));
      if (!w || w.status !== 'acked' || w.ackedAttempt !== a.id || w.workGen !== a.workGen) throw new Reject('stale-publication');
      const next = await nextSeq(s); // publication is newer than any earlier refresh capture
      if (value.tombstone) s.display.put({ id: tuple, seq: next, rev: rid(), tombstone: true });
      else s.display.put({ id: tuple, seq: next, rev: rid(), iv: pre.p.iv, ct: pre.p.ct, envelopeId: pre.p.envelopeId });
      s.work.delete(tuple);
      if (w.payloadId) s.payload.delete(w.payloadId);
      return next;
    });
    const m = ctx.memory.get(tuple);
    if (!m || m.seq === undefined || m.seq <= seq) ctx.memory.set(tuple, { seq, body: value.body, tombstone: Boolean(value.tombstone) });
    return value.body;
  },
  // Authority is captured before any asynchronous enumeration. Each capture
  // takes a fresh position in the shared order and is recorded durably, bound
  // to the owner and lifecycle generation; publication consumes it once.
  // Issuance also expires tokens: any not bound to the current owner, then the
  // lowest sequences, so at most REFRESH_TOKEN_CAP stay outstanding.
  refreshBegin(ctx) {
    return run(ctx.db, ['meta'], 'readwrite', async (s) => {
      const m = await checkOwner(s, ctx.owner);
      const live = [];
      for (const k of await req(s.meta.getAllKeys())) {
        if (!String(k).startsWith('refresh:')) continue;
        const t = await req(s.meta.get(k));
        if (t && sameOwner(t, m)) live.push([t.seq, k]);
        else s.meta.delete(k);
      }
      live.sort((x, y) => x[0] - y[0]);
      for (const [, k] of live.slice(0, Math.max(0, live.length - (REFRESH_TOKEN_CAP - 1)))) s.meta.delete(k);
      const token = { id: rid(), seq: await nextSeq(s), ...ownerTag(m) };
      s.meta.put(token, `refresh:${token.id}`);
      return token;
    });
  },
  // Retires only this caller's own issued token, under the same owner check.
  // An already consumed or expired token needs no cleanup.
  refreshAbandon(ctx, token) {
    return run(ctx.db, ['meta'], 'readwrite', async (s) => {
      const issued = await req(s.meta.get(`refresh:${token.id}`));
      if (!issued || issued.seq !== token.seq || !sameOwner(issued, token)) return;
      await checkOwner(s, ctx.owner);
      s.meta.delete(`refresh:${token.id}`);
    });
  },
  // Convenience: capture first, then run the asynchronous producer. A failed
  // producer or publication retires its token and rethrows the original error;
  // if that cleanup also fails, both errors are reported and the token stays
  // until it is expired by a later issuance.
  async refreshWith(ctx, producer) {
    const token = await candidate.refreshBegin(ctx);
    try {
      return await candidate.refreshPublish(ctx, await producer(), token);
    } catch (err) {
      try {
        await candidate.refreshAbandon(ctx, token);
      } catch (cleanupErr) {
        const both = new AggregateError([err, cleanupErr], 'refresh-token-cleanup-failed', { cause: err });
        both.code = 'refresh-token-cleanup-failed';
        throw both;
      }
      throw err;
    }
  },
  async refreshPublish(ctx, items, token) {
    const sealed = [];
    for (const [tuple, body] of items) sealed.push([tuple, await seal(ctx.owner.key, { body })]);
    await run(ctx.db, ['meta', 'work', 'display'], 'readwrite', async (s) => {
      const m = await checkOwner(s, ctx.owner);
      if (!token || !token.id) throw new Reject('refresh-token-required');
      const issued = await req(s.meta.get(`refresh:${token.id}`));
      if (!issued || issued.seq !== token.seq || !sameOwner(issued, m)
        || token.lifecycleGen !== m.lifecycleGen) throw new Reject('stale-refresh-token');
      s.meta.delete(`refresh:${token.id}`);
      for (const [tuple, rec] of sealed) {
        if (await req(s.work.get(tuple))) continue; // live work keeps the overlay
        const retired = await req(s.meta.get(`retired:${collectionOf(tuple)}`));
        if (retired && retired > token.seq) continue; // collection deleted after capture
        const d = await req(s.display.get(tuple));
        if (d && d.seq > token.seq) continue; // later capture, publication or tombstone wins
        s.display.put({ id: tuple, seq: token.seq, rev: rid(), envelopeId: ctx.owner.envelopeId, ...rec });
      }
    });
  },
  async hydrate(ctx) {
    const { display, work, payloads } = await run(ctx.db, ['meta', 'display', 'work', 'payload'], 'readonly', async (s) => {
      await checkOwner(s, ctx.owner);
      return { display: await req(s.display.getAll()), work: await req(s.work.getAll()), payloads: await req(s.payload.getAll()) };
    });
    const byId = new Map(payloads.map((p) => [p.id, p]));
    const view = new Map();
    for (const d of display) if (!d.tombstone) view.set(d.id, (await decryptOwned(ctx, d)).body);
    for (const w of work) {
      if (w.kind === 'delete') { view.delete(w.id); continue; }
      const p = byId.get(w.payloadId);
      if (structural(p)) view.set(w.id, (await decryptOwned(ctx, p)).body);
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
    return run(ctx.db, ['meta', 'work', 'payload', 'loss', 'display'], 'readwrite', async (s) => {
      await checkOwner(s, ctx.owner);
      const all = await req(s.work.getAll());
      if (all.some((w) => w.kind === 'move' && (w.collection === collection || w.target === collection))) throw new Reject('move-in-progress');
      const apply = [];
      let pendingLoss = 0;
      for (const w of all) {
        if (w.collection !== collection) continue;
        const p = w.payloadId ? await req(s.payload.get(w.payloadId)) : null;
        if (w.kind !== 'delete' && !structural(p)) pendingLoss += 1;
        apply.push(w);
      }
      if ((await req(s.loss.count())) + pendingLoss > limits.loss) throw new Reject('loss-capacity');
      const hide = new Set();
      for (const w of apply) {
        (await retireEvidence(s, w.id, w, false)).commit();
        s.work.delete(w.id);
        hide.add(w.id);
      }
      // Durable visibility retirement: tombstone every displayed or queued item
      // of the collection, and record when it was retired for delayed refreshes.
      for (const d of await req(s.display.getAll())) if (collectionOf(d.id) === collection) hide.add(d.id);
      const retiredAt = await nextSeq(s);
      for (const id of hide) s.display.put({ id, seq: retiredAt, rev: rid(), tombstone: true });
      s.meta.put(retiredAt, `retired:${collection}`);
      s.meta.delete(`barrier:${collection}`);
    });
  },
  admitDeletes(ctx, tuples) {
    return run(ctx.db, ['meta', 'work', 'payload', 'loss'], 'readwrite', async (s) => {
      await checkOwner(s, ctx.owner);
      let free = limits.work - (await req(s.work.count()));
      const admitted = [];
      const rejected = [];
      for (const tuple of tuples) {
        try {
          await policy(s, tuple, { kind: 'delete' });
          const old = await req(s.work.get(tuple));
          if (old && old.kind === 'move') throw new Reject('move-in-progress');
          if (!old && free <= 0) throw new Reject('capacity');
          if (old) {
            (await retireEvidence(s, tuple, old)).commit();
          } else {
            free -= 1;
          }
        } catch (err) {
          if (!(err instanceof Reject)) throw err;
          rejected.push(tuple);
          continue;
        }
        const seq = await nextSeq(s);
        s.work.put({ id: tuple, collection: collectionOf(tuple), kind: 'delete', workGen: rid(), seq, payloadId: null, status: 'pending', attemptId: null });
        admitted.push(tuple);
      }
      return { admitted, rejected };
    });
  },
  // Owner, session and key change together; incompatible fence and barrier metadata is cleared.
  async replaceOwner(db, expectedGen, fingerprint) {
    const key = await genKey();
    const envelopeId = rid();
    return run(db, ['meta', 'crypto', 'work', 'payload', 'attempt', 'display', 'loss', 'legacy'], 'readwrite', async (s) => {
      const m = await req(s.meta.get('owner'));
      if ((m ? m.lifecycleGen : 0) !== expectedGen) throw new Reject('stale-owner');
      for (const n of ['work', 'payload', 'attempt', 'display', 'loss', 'legacy']) s[n].clear();
      for (const k of await req(s.meta.getAllKeys())) {
        const key = String(k);
        if (key === 'fence' || key.startsWith('barrier:') || key.startsWith('refresh:') || key.startsWith('retired:')) s.meta.delete(k);
      }
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
      const m = await checkOwner(s, ctx.owner);
      s.meta.put({ state, server, fingerprint: m.fingerprint, lifecycleGen: m.lifecycleGen }, 'fence');
    });
  },
  dispatchAllowed(ctx, server) {
    return run(ctx.db, ['meta'], 'readonly', async (s) => {
      const m = await checkOwner(s, ctx.owner);
      const f = await req(s.meta.get('fence'));
      return Boolean(f && f.state === 'active' && f.server === server && f.fingerprint === m.fingerprint && f.lifecycleGen === m.lifecycleGen);
    });
  },
  // Cache v6 upgrade is blocked by any open old cache connection. Preservation
  // starts when the upgrade completes; bytes replaced or cleared earlier are
  // not recoverable and are classified from what remains.
  async migrate(ctx, factory) {
    const cache = await openCache(factory, 6);
    try {
      const muts = await run(ctx.db, ['mutations'], 'readonly', async (s) => req(s.mutations.getAll()));
      const out = [];
      for (const m of muts) {
        const held = await run(cache, ['hold'], 'readonly', async (s) => (await req(s.hold.get(m.itemUid))) || null);
        const owned = m.accountFingerprint === ctx.owner.fingerprint
          && (!held || (held.cacheFingerprint === ctx.owner.fingerprint && held.collectionType === m.collectionType && held.collectionUid === m.collectionUid));
        let status;
        if (!owned) status = 'quarantined';
        else if (m.type === 'delete') status = 'unverified-delete';
        else if (!held) status = 'legacy-unresolved';
        else status = await authenticateRaw(held.cacheKey, held);
        const keep = owned && held;
        const rec = await run(ctx.db, ['meta', 'legacy', 'loss'], 'readwrite', async (s) => {
          await checkOwner(s, ctx.owner);
          const existing = await req(s.legacy.get(m.id));
          if (existing) return existing;
          let st = status;
          if (st === 'lost' && (await req(s.loss.count())) + 1 > limits.loss) st = 'pending-loss-capacity';
          const next = { id: m.id, kind: m.type, status: st, raw: keep ? { iv: held.iv, ct: held.ct } : null, cacheKey: keep ? held.cacheKey : null };
          s.legacy.put(next);
          if (st === 'lost') s.loss.put({ id: `legacy:${m.id}`, tuple: `${m.collectionType}/${m.collectionUid}/${m.itemUid}`, lossGen: m.id });
          return next;
        });
        // Release the held copy only after an owned queue copy is durable.
        if (keep && rec.raw && rec.status !== 'quarantined') await run(cache, ['hold'], 'readwrite', async (s) => { s.hold.delete(m.itemUid); });
        const { cacheKey, ...pub } = rec;
        out.push(pub);
      }
      await run(ctx.db, ['meta'], 'readwrite', async (s) => { await checkOwner(s, ctx.owner); s.meta.put('done', 'cutover'); });
      return out;
    } finally { cache.close(); }
  },
  // A later-available cache key lets locked legacy copies authenticate.
  async unlockLegacy(ctx, key) {
    const rows = await run(ctx.db, ['legacy'], 'readonly', async (s) => req(s.legacy.getAll()));
    const out = [];
    for (const r of rows) {
      let next = r;
      if (r.status === 'pending-locked' && r.raw) {
        const st = await authenticateRaw(key, r.raw);
        if (st !== 'pending-locked') {
          next = { ...r, status: st, cacheKey: key };
          await run(ctx.db, ['meta', 'legacy'], 'readwrite', async (s) => {
            await checkOwner(s, ctx.owner);
            const cur = await req(s.legacy.get(r.id));
            if (cur && cur.status === 'pending-locked') s.legacy.put(next);
          });
        }
      }
      const { cacheKey, ...pub } = next;
      out.push(pub);
    }
    return out;
  },
};

// AES-GCM authentication of the raw stored bytes only; no plaintext parsing.
async function authenticateRaw(key, rec) {
  if (!structural(rec)) return 'lost';
  if (!key) return 'pending-locked';
  try {
    await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(rec.iv) }, key, Uint8Array.from(rec.ct));
    return 'unverified';
  } catch {
    return 'pending-ambiguous';
  }
}

module.exports = candidate;
