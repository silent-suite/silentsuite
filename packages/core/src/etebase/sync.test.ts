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
});
