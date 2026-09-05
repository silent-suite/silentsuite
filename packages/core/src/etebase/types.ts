import type { CollectionType } from './constants.js';

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error';

export type ChangeType = 'created' | 'updated' | 'deleted';

export interface SyncChangeEvent {
  collectionType: CollectionType;
  collectionUid: string;
  itemUids: string[];
  changeType: ChangeType;
  timestamp: number;
}

export type CollectionAccessLevel = 'admin' | 'readWrite' | 'readOnly';

export interface SyncEngineOptions {
  serverUrl: string;
  pollIntervalMs?: number;
  maxReconnectDelayMs?: number;
  enableOfflineQueue?: boolean;
}

/**
 * Etebase item metadata. The Etebase type specs use `name`, `mtime`, and an
 * optional `type`; unknown keys written by other clients are preserved.
 */
export interface ItemMeta {
  name?: string;
  mtime?: number;
  type?: string;
  [key: string]: unknown;
}
