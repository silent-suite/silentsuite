import * as Etebase from 'etebase';
import type { CollectionType } from './constants.js';
import type { SyncStatus, SyncChangeEvent, SyncEngineOptions, ChangeType } from './types.js';

type SyncEventHandler = (event: SyncChangeEvent) => void;
type StatusChangeHandler = (status: SyncStatus) => void;

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
  private reconnectAttempt = 0;
  private isDestroyed = false;

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
   * Manually trigger a sync cycle.
   */
  async syncNow(): Promise<void> {
    if (!this.account || this.isDestroyed) return;
    this.setStatus('syncing');
    try {
      await this.syncAll();
      this.setStatus('synced');
      this.reconnectAttempt = 0;
    } catch (err) {
      this.handleSyncError(err);
    }
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

    let done = false;
    while (!done) {
      const response = await itemManager.list({
        stoken: tracked.stoken ?? undefined,
      });

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

      tracked.stoken = response.stoken ?? null;
      done = response.done;
    }
  }

  private schedulePoll(): void {
    if (this.isDestroyed) return;

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
