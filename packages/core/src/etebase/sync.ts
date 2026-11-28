import * as Etebase from 'etebase';
import type { CollectionType } from './constants.js';
import type { SyncStatus, SyncChangeEvent, SyncEngineOptions, ChangeType } from './types.js';

type SyncEventHandler = (event: SyncChangeEvent) => void;
type StatusChangeHandler = (status: SyncStatus) => void;

/**
 * Fired after a successful pagination round trip when the engine has
 * advanced the stoken for a collection. Callers can persist the new
 * stoken to durable storage so the next process start resumes from
 * here instead of re-fetching the whole collection.
 */
export interface StokenAdvanceEvent {
  collectionType: CollectionType;
  collectionUid: string;
  /** The new stoken returned by the server. null means "no items yet". */
  stoken: string | null;
}

type StokenAdvanceHandler = (event: StokenAdvanceEvent) => void;

interface TrackedCollection {
  collectionType: CollectionType;
  collectionUid: string;
  stoken: string | null;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

/**
 * Polling-based sync engine for Etebase collections.
 *
 * Tracks sync state, fetches remote changes using sync tokens,
 * pushes local changes, and emits change events for Zustand stores.
 *
 * Note: WebSocket push is not yet supported by the Etebase REST API.
 * When server support is added, this engine can be extended to use
 * WebSocket for real-time push notifications instead of polling.
 */
export class SyncEngine {
  private account: Etebase.Account | null = null;
  private status: SyncStatus = 'offline';
  private trackedCollections: Map<string, TrackedCollection> = new Map();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private changeHandlers: Set<SyncEventHandler> = new Set();
  private statusHandlers: Set<StatusChangeHandler> = new Set();
  private stokenAdvanceHandlers: Set<StokenAdvanceHandler> = new Set();
  private reconnectAttempt = 0;
  private isDestroyed = false;
  private paused = false;

  readonly options: Required<SyncEngineOptions>;

  constructor(options: SyncEngineOptions) {
    this.options = {
      serverUrl: options.serverUrl,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS,
      enableOfflineQueue: options.enableOfflineQueue ?? true,
    };
  }

  /**
   * Set the authenticated Etebase account and start syncing.
   */
  async start(account: Etebase.Account): Promise<void> {
    this.account = account;
    this.isDestroyed = false;
    this.reconnectAttempt = 0;
    this.setStatus('syncing');

    try {
      await this.syncAll();
      this.setStatus('synced');
      this.schedulePoll();
    } catch (err) {
      this.handleSyncError(err);
    }
  }

  /**
   * Stop syncing and clean up.
   */
  stop(): void {
    this.isDestroyed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.setStatus('offline');
  }

  /**
   * Get the current sync status.
   */
  getStatus(): SyncStatus {
    return this.status;
  }

  /**
   * Track a collection type for sync.
   */
  trackCollection(collectionType: CollectionType, collectionUid: string): void {
    this.trackedCollections.set(collectionUid, {
      collectionType,
      collectionUid,
      stoken: null,
    });
  }

  /**
   * Seed the stoken for a tracked collection from durable storage.
   * Call this before `start()` to resume incremental sync from where
   * the previous process left off.
   *
   * No-op if the collection is not tracked. Existing stoken is overwritten.
   */
  setStoken(collectionUid: string, stoken: string | null): void {
    const tracked = this.trackedCollections.get(collectionUid);
    if (!tracked) return;
    tracked.stoken = stoken;
  }

  /**
   * Read the in-memory stoken for a tracked collection. Returns null
   * if the collection is unknown or has never synced.
   */
  getStoken(collectionUid: string): string | null {
    const tracked = this.trackedCollections.get(collectionUid);
    return tracked?.stoken ?? null;
  }

  /**
   * Remove a collection from tracking.
   */
  untrackCollection(collectionUid: string): void {
    this.trackedCollections.delete(collectionUid);
  }

  /**
   * Subscribe to change events.
   */
  onChange(handler: SyncEventHandler): () => void {
    this.changeHandlers.add(handler);
    return () => {
      this.changeHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to status changes.
   */
  onStatusChange(handler: StatusChangeHandler): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to stoken-advance events. Fired each time the engine
   * successfully advances the stoken for a collection so callers can
   * persist it. Returns an unsubscribe function.
   */
  onStokenAdvance(handler: StokenAdvanceHandler): () => void {
    this.stokenAdvanceHandlers.add(handler);
    return () => {
      this.stokenAdvanceHandlers.delete(handler);
    };
  }

  /**
   * Manually trigger a sync cycle.
   */
  async syncNow(): Promise<void> {
    if (!this.account || this.isDestroyed || this.paused) return;
    this.setStatus('syncing');
    try {
      await this.syncAll();
      this.setStatus('synced');
      this.reconnectAttempt = 0;
    } catch (err) {
      this.handleSyncError(err);
    }
  }

  /**
   * Pause the polling loop. Use during local-heavy work like a large import
   * so the 30s poll doesn't fire `itemManager.list` (which decrypts results
   * on the main thread) while the import is encrypting items on the same
   * thread. Reversible via `resume()`. No-op if already paused or destroyed.
   */
  pause(): void {
    if (this.isDestroyed || this.paused) return;
    this.paused = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Resume polling after `pause()`. Re-arms the poll timer so the next
   * sync cycle fires after `pollIntervalMs`. No-op if not paused or destroyed.
   */
  resume(): void {
    if (this.isDestroyed || !this.paused) return;
    this.paused = false;
    if (this.account) {
      this.schedulePoll();
    }
  }

  /**
   * Whether polling is currently paused.
   */
  isPaused(): boolean {
    return this.paused;
  }

  // ── Internal ──

  private setStatus(status: SyncStatus): void {
    if (this.status !== status) {
      this.status = status;
      for (const handler of this.statusHandlers) {
        try {
          handler(status);
        } catch {
          // Don't let subscriber errors break the engine
        }
      }
    }
  }

  private emitChange(event: SyncChangeEvent): void {
    for (const handler of this.changeHandlers) {
      try {
        handler(event);
      } catch {
        // Don't let subscriber errors break the engine
      }
    }
  }

  private emitStokenAdvance(event: StokenAdvanceEvent): void {
    for (const handler of this.stokenAdvanceHandlers) {
      try {
        handler(event);
      } catch {
        // Don't let subscriber errors break the engine
      }
    }
  }

  private async syncAll(): Promise<void> {
    if (!this.account) return;

    const collections = Array.from(this.trackedCollections.values());
    const results = await Promise.allSettled(
      collections.map((tracked) => this.syncCollection(tracked)),
    );

    // Log individual collection failures without blocking others
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result && result.status === 'rejected') {
        console.error(
          `[SyncEngine] Failed to sync collection ${collections[i]?.collectionUid}:`,
          result.reason,
        );
      }
    }
  }

  private async syncCollection(tracked: TrackedCollection): Promise<void> {
    if (!this.account) return;

    const collectionManager = this.account.getCollectionManager();

    let collection: Etebase.Collection;
    try {
      collection = await collectionManager.fetch(tracked.collectionUid);
    } catch {
      // Collection may not exist yet
      return;
    }

    const itemManager = collectionManager.getItemManager(collection);

    // Stoken-not-found fallback: if the server has pruned the history that
    // our persisted stoken referenced (e.g. account rotation, server-side
    // compaction, or a stale cache from a different vault), the first
    // `list()` call will throw. Drop the stoken, emit an advance event so
    // callers clear their persisted copy, and retry from scratch.
    let done = false;
    while (!done) {
      let response: { data: Etebase.Item[]; stoken: string | null; done: boolean };
      try {
        response = (await itemManager.list({
          stoken: tracked.stoken ?? undefined,
        })) as { data: Etebase.Item[]; stoken: string | null; done: boolean };
      } catch (err) {
        if (tracked.stoken !== null && this.isStokenStaleError(err)) {
          console.warn(
            `[SyncEngine] Stoken rejected for ${tracked.collectionUid}, falling back to full fetch`,
          );
          tracked.stoken = null;
          this.emitStokenAdvance({
            collectionType: tracked.collectionType,
            collectionUid: tracked.collectionUid,
            stoken: null,
          });
          continue;
        }
        throw err;
      }

      if (response.data.length > 0) {
        const createdOrUpdated: string[] = [];
        const deleted: string[] = [];

        for (const item of response.data) {
          if (item.isDeleted) {
            deleted.push(item.uid);
          } else {
            createdOrUpdated.push(item.uid);
          }
        }

        if (createdOrUpdated.length > 0) {
          this.emitChange({
            collectionType: tracked.collectionType,
            collectionUid: tracked.collectionUid,
            itemUids: createdOrUpdated,
            changeType: 'updated',
            timestamp: Date.now(),
          });
        }

        if (deleted.length > 0) {
          this.emitChange({
            collectionType: tracked.collectionType,
            collectionUid: tracked.collectionUid,
            itemUids: deleted,
            changeType: 'deleted',
            timestamp: Date.now(),
          });
        }
      }

      const newStoken = response.stoken ?? null;
      const advanced = newStoken !== tracked.stoken;
      tracked.stoken = newStoken;
      done = response.done;

      if (advanced) {
        this.emitStokenAdvance({
          collectionType: tracked.collectionType,
          collectionUid: tracked.collectionUid,
          stoken: newStoken,
        });
      }
    }
  }

  /**
   * Heuristic for "stoken refers to history we no longer have". Etebase
   * surfaces this as a 409/stoken-mismatch error; the message text is the
   * most reliable signal across the various Etebase server versions we
   * support. Conservative — we only fall back when the message clearly
   * names the stoken so we don't mask real network errors.
   */
  private isStokenStaleError(err: unknown): boolean {
    if (!err) return false;
    const msg = err instanceof Error ? err.message : String(err);
    return /stoken|sync token|history|410|gone/i.test(msg);
  }

  private schedulePoll(): void {
    if (this.isDestroyed || this.paused) return;

    this.pollTimer = setTimeout(() => {
      this.syncNow()
        .then(() => {
          if (!this.isDestroyed) {
            this.schedulePoll();
          }
        })
        .catch((err) => {
          // Prevent unhandled promise rejection — error is already
          // handled inside syncNow via handleSyncError, but catch
          // here as a safety net.
          console.error('[SyncEngine] Unhandled error in poll cycle:', err);
          if (!this.isDestroyed) {
            this.schedulePoll();
          }
        });
    }, this.options.pollIntervalMs);
  }

  private handleSyncError(_err: unknown): void {
    this.setStatus('error');

    if (this.isDestroyed) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempt),
      this.options.maxReconnectDelayMs,
    );
    this.reconnectAttempt++;

    this.pollTimer = setTimeout(async () => {
      if (!this.isDestroyed) {
        await this.syncNow();
        if (this.status === 'synced') {
          this.schedulePoll();
        }
      }
    }, delay);
  }
}
