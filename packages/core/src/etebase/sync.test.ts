import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEngine } from './sync.js';
import type { SyncStatus, SyncChangeEvent, SyncEngineOptions } from './types.js';
import { COLLECTION_TYPE_CALENDAR } from './constants.js';

// ── Mock Etebase SDK ──

function createMockItem(uid: string, isDeleted = false) {
  return {
    uid,
    isDeleted,
    getMeta: vi.fn().mockReturnValue({}),
    getContent: vi.fn().mockResolvedValue(new Uint8Array()),
  };
}

function createMockListResponse(
  items: ReturnType<typeof createMockItem>[],
  stoken = 'stoken-1',
  done = true,
) {
  return {
    data: items,
    stoken,
    done,
  };
}

function createMockAccount(listResponse?: ReturnType<typeof createMockListResponse>) {
  const mockItemManager = {
    list: vi.fn().mockResolvedValue(
      listResponse ?? createMockListResponse([]),
    ),
    fetch: vi.fn(),
    create: vi.fn(),
    batch: vi.fn(),
    transaction: vi.fn(),
  };

  const mockCollection = {
    uid: 'col-1',
    getMeta: vi.fn().mockReturnValue({}),
    getContent: vi.fn().mockResolvedValue(new Uint8Array()),
  };

  const mockCollectionManager = {
    fetch: vi.fn().mockResolvedValue(mockCollection),
    getItemManager: vi.fn().mockReturnValue(mockItemManager),
    list: vi.fn(),
    create: vi.fn(),
    upload: vi.fn(),
  };

  const account = {
    getCollectionManager: vi.fn().mockReturnValue(mockCollectionManager),
    save: vi.fn().mockResolvedValue('session-data'),
    logout: vi.fn().mockResolvedValue(undefined),
  };

  return { account, mockCollectionManager, mockItemManager, mockCollection };
}

function defaultOptions(overrides?: Partial<SyncEngineOptions>): SyncEngineOptions {
  return {
    serverUrl: 'https://etebase.example.com',
    pollIntervalMs: 60_000, // Long poll interval to avoid triggering in tests
    maxReconnectDelayMs: 30_000,
    enableOfflineQueue: true,
    ...overrides,
  };
}

// ── Tests ──

describe('SyncEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Construction ──

  describe('constructor', () => {
    it('sets default options', () => {
      const engine = new SyncEngine({ serverUrl: 'https://example.com' });

      expect(engine.options.serverUrl).toBe('https://example.com');
      expect(engine.options.pollIntervalMs).toBe(30_000);
      expect(engine.options.maxReconnectDelayMs).toBe(30_000);
      expect(engine.options.enableOfflineQueue).toBe(true);
    });

    it('allows overriding options', () => {
      const engine = new SyncEngine({
        serverUrl: 'https://example.com',
        pollIntervalMs: 5_000,
        maxReconnectDelayMs: 10_000,
        enableOfflineQueue: false,
      });

      expect(engine.options.pollIntervalMs).toBe(5_000);
      expect(engine.options.maxReconnectDelayMs).toBe(10_000);
      expect(engine.options.enableOfflineQueue).toBe(false);
    });

    it('starts with offline status', () => {
      const engine = new SyncEngine(defaultOptions());
      expect(engine.getStatus()).toBe('offline');
    });
  });

  // ── Event emission ──

  describe('event emission', () => {
    it('emits change events when items are synced', async () => {
      const items = [createMockItem('item-1'), createMockItem('item-2')];
      const { account } = createMockAccount(createMockListResponse(items));

      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      const changes: SyncChangeEvent[] = [];
      engine.onChange((event) => changes.push(event));

      // @ts-expect-error - mock account doesn't fully implement Etebase.Account
      await engine.start(account);

      expect(changes).toHaveLength(1);
      expect(changes[0]!.collectionType).toBe(COLLECTION_TYPE_CALENDAR);
      expect(changes[0]!.collectionUid).toBe('col-1');
      expect(changes[0]!.itemUids).toEqual(['item-1', 'item-2']);
      expect(changes[0]!.changeType).toBe('updated');
      expect(changes[0]!.timestamp).toBeGreaterThan(0);

      engine.stop();
    });

    it('emits separate events for updated and deleted items', async () => {
      const items = [
        createMockItem('item-1', false),
        createMockItem('item-2', true),
        createMockItem('item-3', false),
      ];
      const { account } = createMockAccount(createMockListResponse(items));

      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      const changes: SyncChangeEvent[] = [];
      engine.onChange((event) => changes.push(event));

      // @ts-expect-error - mock account doesn't fully implement Etebase.Account
      await engine.start(account);

      expect(changes).toHaveLength(2);

      const updated = changes.find((c) => c.changeType === 'updated');
      const deleted = changes.find((c) => c.changeType === 'deleted');

      expect(updated).toBeDefined();
      expect(updated!.itemUids).toEqual(['item-1', 'item-3']);

      expect(deleted).toBeDefined();
      expect(deleted!.itemUids).toEqual(['item-2']);

      engine.stop();
    });

    it('does not emit change events when there are no items', async () => {
      const { account } = createMockAccount(createMockListResponse([]));

      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      const changes: SyncChangeEvent[] = [];
      engine.onChange((event) => changes.push(event));

      // @ts-expect-error - mock account doesn't fully implement Etebase.Account
      await engine.start(account);

      expect(changes).toHaveLength(0);

      engine.stop();
    });

    it('emits status events through lifecycle', async () => {
      const { account } = createMockAccount();

      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      const statuses: SyncStatus[] = [];
      engine.onStatusChange((status) => statuses.push(status));

      // @ts-expect-error - mock account doesn't fully implement Etebase.Account
      await engine.start(account);

      // Should have gone through syncing → synced
      expect(statuses).toContain('syncing');
      expect(statuses).toContain('synced');

      engine.stop();

      // After stop, should be offline
      expect(statuses).toContain('offline');
    });

    it('allows unsubscribing from change events', async () => {
      const items = [createMockItem('item-1')];
      const { account } = createMockAccount(createMockListResponse(items));

      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      const changes: SyncChangeEvent[] = [];
      const unsub = engine.onChange((event) => changes.push(event));
      unsub();

      // @ts-expect-error - mock account doesn't fully implement Etebase.Account
      await engine.start(account);

      expect(changes).toHaveLength(0);

      engine.stop();
    });

    it('allows unsubscribing from status events', async () => {
      const { account } = createMockAccount();

      const engine = new SyncEngine(defaultOptions());

      const statuses: SyncStatus[] = [];
      const unsub = engine.onStatusChange((status) => statuses.push(status));
      unsub();

      // @ts-expect-error - mock account doesn't fully implement Etebase.Account
      await engine.start(account);

      expect(statuses).toHaveLength(0);

      engine.stop();
    });

    it('does not break when a change handler throws', async () => {
      const items = [createMockItem('item-1')];
      const { account } = createMockAccount(createMockListResponse(items));

      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      const received: SyncChangeEvent[] = [];
      engine.onChange(() => {
        throw new Error('handler boom');
      });
      engine.onChange((event) => received.push(event));

      // @ts-expect-error - mock account doesn't fully implement Etebase.Account
      await engine.start(account);

      // Second handler should still receive the event
      expect(received).toHaveLength(1);

      engine.stop();
    });

    it('does not break when a status handler throws', async () => {
      const { account } = createMockAccount();

      const engine = new SyncEngine(defaultOptions());

      const received: SyncStatus[] = [];
      engine.onStatusChange(() => {
        throw new Error('status boom');
      });
      engine.onStatusChange((status) => received.push(status));

      // @ts-expect-error - mock account doesn't fully implement Etebase.Account
      await engine.start(account);

      expect(received.length).toBeGreaterThan(0);

      engine.stop();
    });
  });

  // ── Status transitions ──

  describe('status transitions', () => {
    it('transitions synced → syncing → synced on syncNow', async () => {
      const { account } = createMockAccount();

      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      const statuses: SyncStatus[] = [];
      engine.onStatusChange((s) => statuses.push(s));

      // @ts-expect-error - mock account doesn't fully implement Etebase.Account
      await engine.start(account);

      // Reset
      statuses.length = 0;

      await engine.syncNow();

      // Should go syncing → synced
      expect(statuses).toEqual(['syncing', 'synced']);

      engine.stop();
    });

    it('transitions to synced even when individual collections fail (errors are logged)', async () => {
      const { account, mockItemManager } = createMockAccount();
      // itemManager.list rejects, but syncAll uses Promise.allSettled so the
      // error is logged per-collection and doesn't propagate.
      mockItemManager.list.mockRejectedValueOnce(new Error('network error'));

      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      const statuses: SyncStatus[] = [];
      engine.onStatusChange((s) => statuses.push(s));

      // @ts-expect-error - mock account doesn't fully implement Etebase.Account
      await engine.start(account);

      expect(statuses).toContain('syncing');
      // With Promise.allSettled, individual collection errors are swallowed
      expect(statuses).toContain('synced');

      engine.stop();
    });

    it('transitions to offline on stop', async () => {
      const { account } = createMockAccount();

      const engine = new SyncEngine(defaultOptions());

      // @ts-expect-error - mock account doesn't fully implement Etebase.Account
      await engine.start(account);

      const statuses: SyncStatus[] = [];
      engine.onStatusChange((s) => statuses.push(s));

      engine.stop();

      expect(statuses).toEqual(['offline']);
      expect(engine.getStatus()).toBe('offline');
    });

    it('does not emit duplicate status events', async () => {
      const { account } = createMockAccount();

      const engine = new SyncEngine(defaultOptions());

      const statuses: SyncStatus[] = [];
      engine.onStatusChange((s) => statuses.push(s));

      // Start twice to see if there are dups
      // @ts-expect-error - mock account doesn't fully implement Etebase.Account
      await engine.start(account);
      engine.stop();

      // syncing, synced, offline - no duplicates
      for (let i = 1; i < statuses.length; i++) {
        expect(statuses[i]).not.toBe(statuses[i - 1]);
      }
    });
  });

  // ── Exponential backoff ──

  describe('exponential backoff', () => {
    it('does not enter error state when individual collections fail (Promise.allSettled)', async () => {
      const { account, mockItemManager } = createMockAccount();

      // Make itemManager.list always fail — but syncAll uses Promise.allSettled
      // so individual collection errors are logged, not thrown.
      mockItemManager.list.mockRejectedValue(new Error('network error'));

      const engine = new SyncEngine(
        defaultOptions({ pollIntervalMs: 60_000, maxReconnectDelayMs: 30_000 }),
      );
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      const statuses: SyncStatus[] = [];
      engine.onStatusChange((s) => statuses.push(s));

      // @ts-expect-error - mock account doesn't fully implement Etebase.Account
      await engine.start(account);

      // With Promise.allSettled, the engine reaches 'synced' even when
      // individual collections fail — errors are logged per-collection.
      expect(engine.getStatus()).toBe('synced');
      expect(statuses).toContain('syncing');
      expect(statuses).toContain('synced');

      // Verify that the list was called (the collection was attempted)
      expect(mockItemManager.list).toHaveBeenCalledTimes(1);

      // Poll timer fires after pollIntervalMs; advance and verify re-sync
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockItemManager.list).toHaveBeenCalledTimes(2);

      engine.stop();
    });

    it('continues polling on schedule even when collections keep failing', async () => {
      const { account, mockItemManager } = createMockAccount();

      // First call fails, second succeeds with empty list
      mockItemManager.list
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue(createMockListResponse([]));

      const engine = new SyncEngine(
        defaultOptions({ pollIntervalMs: 60_000, maxReconnectDelayMs: 30_000 }),
      );
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      // @ts-expect-error - mock
      await engine.start(account);

      // Promise.allSettled swallows the error, so status is synced
      expect(engine.getStatus()).toBe('synced');

      // Advance past poll interval — second sync should succeed
      await vi.advanceTimersByTimeAsync(60_000);

      expect(engine.getStatus()).toBe('synced');
      expect(mockItemManager.list).toHaveBeenCalledTimes(2);

      engine.stop();
    });
  });

  // ── Collection tracking ──

  describe('collection tracking', () => {
    it('tracks and untracks collections', () => {
      const engine = new SyncEngine(defaultOptions());

      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-2');

      // No public API to check tracked count, but we can verify
      // syncing doesn't crash after untracking
      engine.untrackCollection('col-1');

      // Should not throw
      expect(() => engine.untrackCollection('nonexistent')).not.toThrow();
    });
  });

  // ── syncNow ──

  describe('syncNow', () => {
    it('does nothing when account is not set', async () => {
      const engine = new SyncEngine(defaultOptions());

      // Should not throw
      await engine.syncNow();

      expect(engine.getStatus()).toBe('offline');
    });

    it('does nothing when engine is destroyed', async () => {
      const { account } = createMockAccount();
      const engine = new SyncEngine(defaultOptions());

      // @ts-expect-error - mock
      await engine.start(account);
      engine.stop();

      const statuses: SyncStatus[] = [];
      engine.onStatusChange((s) => statuses.push(s));

      await engine.syncNow();

      // Should not have changed status from offline
      expect(statuses).toHaveLength(0);
    });
  });

  // ── Stop ──

  describe('stop', () => {
    it('clears poll timer', async () => {
      const { account } = createMockAccount();

      const engine = new SyncEngine(
        defaultOptions({ pollIntervalMs: 1_000 }),
      );
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      // @ts-expect-error - mock
      await engine.start(account);

      engine.stop();

      // Advance timers - should not trigger any more syncs
      const { account: account2, mockCollectionManager } = createMockAccount();
      // Even after advancing, the stopped engine shouldn't call anything
      await vi.advanceTimersByTimeAsync(10_000);

      expect(engine.getStatus()).toBe('offline');
    });

    it('can be called multiple times safely', () => {
      const engine = new SyncEngine(defaultOptions());

      expect(() => {
        engine.stop();
        engine.stop();
        engine.stop();
      }).not.toThrow();
    });
  });

  // ── Pagination ──

  describe('pagination', () => {
    it('handles paginated responses (done=false)', async () => {
      const page1Items = [createMockItem('item-1')];
      const page2Items = [createMockItem('item-2')];

      const mockItemManager = {
        list: vi
          .fn()
          .mockResolvedValueOnce(createMockListResponse(page1Items, 'stoken-1', false))
          .mockResolvedValueOnce(createMockListResponse(page2Items, 'stoken-2', true)),
      };

      const mockCollection = {
        uid: 'col-1',
        getMeta: vi.fn().mockReturnValue({}),
      };

      const mockCollectionManager = {
        fetch: vi.fn().mockResolvedValue(mockCollection),
        getItemManager: vi.fn().mockReturnValue(mockItemManager),
      };

      const account = {
        getCollectionManager: vi.fn().mockReturnValue(mockCollectionManager),
      };

      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      const changes: SyncChangeEvent[] = [];
      engine.onChange((event) => changes.push(event));

      // @ts-expect-error - mock
      await engine.start(account);

      // Should have received events from both pages
      expect(changes).toHaveLength(2);
      expect(changes[0]!.itemUids).toEqual(['item-1']);
      expect(changes[1]!.itemUids).toEqual(['item-2']);

      engine.stop();
    });
  });

  // ── Stoken persistence hooks ──

  describe('stoken seeding and persistence', () => {
    it('seeds the stoken via setStoken before start so the first list passes it through', async () => {
      const { account, mockItemManager } = createMockAccount();

      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');
      engine.setStoken('col-1', 'stk-persisted');

      // @ts-expect-error - mock account doesn't fully implement Etebase.Account
      await engine.start(account);

      expect(mockItemManager.list).toHaveBeenCalledWith(
        expect.objectContaining({ stoken: 'stk-persisted' }),
      );

      engine.stop();
    });

    it('setStoken on an unknown collection is a no-op', () => {
      const engine = new SyncEngine(defaultOptions());
      // No tracked collection — should not throw.
      expect(() => engine.setStoken('nope', 'stk')).not.toThrow();
      expect(engine.getStoken('nope')).toBeNull();
    });

    it('getStoken reflects the latest server-returned stoken', async () => {
      const items = [createMockItem('item-1')];
      const { account } = createMockAccount(createMockListResponse(items, 'stk-after-sync'));

      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      // @ts-expect-error - mock
      await engine.start(account);

      expect(engine.getStoken('col-1')).toBe('stk-after-sync');

      engine.stop();
    });

    it('emits onStokenAdvance when the server returns a new stoken', async () => {
      const items = [createMockItem('item-1')];
      const { account } = createMockAccount(createMockListResponse(items, 'stk-advanced'));

      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      const advances: { collectionUid: string; stoken: string | null }[] = [];
      engine.onStokenAdvance((event) => {
        advances.push({ collectionUid: event.collectionUid, stoken: event.stoken });
      });

      // @ts-expect-error - mock
      await engine.start(account);

      expect(advances).toHaveLength(1);
      expect(advances[0]!.collectionUid).toBe('col-1');
      expect(advances[0]!.stoken).toBe('stk-advanced');

      engine.stop();
    });

    it('does not emit onStokenAdvance when the stoken is unchanged', async () => {
      const { account, mockItemManager } = createMockAccount();
      // Both calls return the same stoken
      mockItemManager.list.mockResolvedValue(createMockListResponse([], 'stk-same'));

      const engine = new SyncEngine(defaultOptions({ pollIntervalMs: 60_000 }));
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');
      // Pre-seed with the same stoken so the first response doesn't count as advance.
      engine.setStoken('col-1', 'stk-same');

      const advances: { stoken: string | null }[] = [];
      engine.onStokenAdvance((event) => advances.push({ stoken: event.stoken }));

      // @ts-expect-error - mock
      await engine.start(account);

      expect(advances).toHaveLength(0);

      engine.stop();
    });

    it('falls back to a full fetch when the server rejects a stale stoken', async () => {
      const { account, mockItemManager } = createMockAccount();
      const listMock = mockItemManager.list;
      listMock.mockReset();
      // First call (with stoken=stale) rejects; second call (with no stoken) succeeds.
      listMock
        .mockRejectedValueOnce(new Error('invalid sync token (stoken)'))
        .mockResolvedValueOnce(createMockListResponse([createMockItem('item-1')], 'stk-fresh'));

      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');
      engine.setStoken('col-1', 'stk-stale');

      const advances: { stoken: string | null }[] = [];
      engine.onStokenAdvance((event) => advances.push({ stoken: event.stoken }));

      // @ts-expect-error - mock
      await engine.start(account);

      // Two list calls: stale stoken, then no stoken
      expect(listMock).toHaveBeenCalledTimes(2);
      expect(listMock.mock.calls[0]![0]).toEqual({ stoken: 'stk-stale' });
      expect(listMock.mock.calls[1]![0]).toEqual({ stoken: undefined });

      // Engine should converge on the fresh stoken
      expect(engine.getStoken('col-1')).toBe('stk-fresh');

      // We expect at least two stoken advances: clear-to-null (fallback)
      // followed by the new stoken from the successful refetch.
      expect(advances.length).toBeGreaterThanOrEqual(2);
      expect(advances[0]!.stoken).toBeNull();
      expect(advances[advances.length - 1]!.stoken).toBe('stk-fresh');

      engine.stop();
    });

    it('does not swallow non-stoken errors in syncCollection', async () => {
      const { account, mockItemManager } = createMockAccount();
      mockItemManager.list.mockRejectedValue(new Error('connection refused'));

      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');
      engine.setStoken('col-1', 'stk-x');

      // @ts-expect-error - mock
      await engine.start(account);

      // Promise.allSettled at the syncAll level swallows it as a logged
      // rejection — but the original error must NOT have been re-tried
      // as a stoken-stale fallback (only one list call).
      expect(mockItemManager.list).toHaveBeenCalledTimes(1);
      // Stoken should remain unchanged on a non-stale error.
      expect(engine.getStoken('col-1')).toBe('stk-x');

      engine.stop();
    });

    it('allows unsubscribing from stoken advance events', async () => {
      const items = [createMockItem('item-1')];
      const { account } = createMockAccount(createMockListResponse(items, 'stk-x'));

      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      const advances: unknown[] = [];
      const unsub = engine.onStokenAdvance((e) => advances.push(e));
      unsub();

      // @ts-expect-error - mock
      await engine.start(account);

      expect(advances).toHaveLength(0);

      engine.stop();
    });

    it('does not break when a stoken-advance handler throws', async () => {
      const items = [createMockItem('item-1')];
      const { account } = createMockAccount(createMockListResponse(items, 'stk-x'));

      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      const received: unknown[] = [];
      engine.onStokenAdvance(() => {
        throw new Error('handler boom');
      });
      engine.onStokenAdvance((e) => received.push(e));

      // @ts-expect-error - mock
      await engine.start(account);

      expect(received).toHaveLength(1);

      engine.stop();
    });
  });

  // ── Pause / resume ──

  describe('pause and resume', () => {
    it('does not poll while paused', async () => {
      const { account, mockItemManager } = createMockAccount();
      const engine = new SyncEngine(defaultOptions({ pollIntervalMs: 1_000 }));
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      // @ts-expect-error - mock
      await engine.start(account);
      expect(mockItemManager.list).toHaveBeenCalledTimes(1);

      engine.pause();
      expect(engine.isPaused()).toBe(true);

      // Advance well past several poll intervals — no new list calls
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockItemManager.list).toHaveBeenCalledTimes(1);
    });

    it('syncNow is a no-op while paused', async () => {
      const { account, mockItemManager } = createMockAccount();
      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      // @ts-expect-error - mock
      await engine.start(account);
      mockItemManager.list.mockClear();

      engine.pause();
      await engine.syncNow();

      expect(mockItemManager.list).not.toHaveBeenCalled();
    });

    it('resumes polling on resume()', async () => {
      const { account, mockItemManager } = createMockAccount();
      const engine = new SyncEngine(defaultOptions({ pollIntervalMs: 1_000 }));
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      // @ts-expect-error - mock
      await engine.start(account);
      engine.pause();
      mockItemManager.list.mockClear();

      engine.resume();
      expect(engine.isPaused()).toBe(false);

      // Next poll interval should fire
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mockItemManager.list).toHaveBeenCalledTimes(1);

      engine.stop();
    });

    it('pause is idempotent and resume is a no-op when not paused', async () => {
      const { account } = createMockAccount();
      const engine = new SyncEngine(defaultOptions());

      // @ts-expect-error - mock
      await engine.start(account);

      engine.pause();
      engine.pause(); // no-op
      expect(engine.isPaused()).toBe(true);

      engine.resume();
      engine.resume(); // no-op
      expect(engine.isPaused()).toBe(false);

      engine.stop();
    });

    it('pause does not change reported status', async () => {
      const { account } = createMockAccount();
      const engine = new SyncEngine(defaultOptions());
      engine.trackCollection(COLLECTION_TYPE_CALENDAR, 'col-1');

      // @ts-expect-error - mock
      await engine.start(account);
      expect(engine.getStatus()).toBe('synced');

      engine.pause();
      // We deliberately do NOT flip status to 'offline' on pause — the user
      // is still online, we're just deferring polls.
      expect(engine.getStatus()).toBe('synced');

      engine.stop();
    });
  });
});
