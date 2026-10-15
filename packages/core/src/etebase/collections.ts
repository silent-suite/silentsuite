import * as Etebase from 'etebase';

import type { ItemMeta } from './types.js';

export interface CollectionMeta {
  name: string;
  description?: string;
  color?: string;
  mtime?: number;
}

export interface CollectionMetaUpdate {
  name?: string;
  description?: string;
  color?: string;
  mtime?: number;
}

/** Etebase notes identify plain notes by an empty item type, so never upload one. */
function toEtebaseItemMeta(meta: ItemMeta): ItemMeta {
  const next: ItemMeta = { ...meta };
  if (!next.type) delete next.type;
  return next;
}

export interface ItemListResponse {
  items: Etebase.Item[];
  stoken: string | null;
  done: boolean;
}

/**
 * Create a new collection of the given type.
 */
export async function createCollection(
  account: Etebase.Account,
  collectionType: string,
  meta: CollectionMeta,
): Promise<Etebase.Collection> {
  const collectionManager = account.getCollectionManager();
  const collection = await collectionManager.create(
    collectionType,
    {
      name: meta.name,
      description: meta.description,
      color: meta.color,
      ...(meta.mtime !== undefined ? { mtime: meta.mtime } : {}),
    },
    '',
  );
  await collectionManager.upload(collection);
  return collection;
}

/** Upper bound on server pages read by listCollections before it gives up. */
const MAX_COLLECTION_LIST_PAGES = 1000;

/**
 * List all collections of a given type, following every server page.
 * Throws rather than returning a partial list if paging cannot complete.
 */
export async function listCollections(
  account: Etebase.Account,
  collectionType: string,
): Promise<Etebase.Collection[]> {
  const collectionManager = account.getCollectionManager();
  let response = await collectionManager.list(collectionType);
  // Later pages win so a tombstone replaces the live copy seen on an earlier page.
  const byUid = new Map<string, Etebase.Collection>();
  for (const collection of response.data) byUid.set(collection.uid, collection);
  const seenStokens = new Set<string>();
  let pages = 1;
  while (response.done !== true) {
    if (pages >= MAX_COLLECTION_LIST_PAGES) {
      throw new Error(`Collection list exceeded ${MAX_COLLECTION_LIST_PAGES} pages`);
    }
    pages += 1;
    const stoken = response.stoken;
    if (!stoken) {
      throw new Error('Collection list is not done but returned no stoken');
    }
    if (seenStokens.has(stoken)) {
      throw new Error('Collection list returned a repeated stoken');
    }
    seenStokens.add(stoken);
    response = await collectionManager.list(collectionType, { stoken });
    for (const collection of response.data) byUid.set(collection.uid, collection);
  }
  return [...byUid.values()].filter((collection) => !(collection as any).isDeleted);
}

/**
 * Get a single collection by UID.
 */
export async function getCollection(
  account: Etebase.Account,
  collectionUid: string,
): Promise<Etebase.Collection> {
  const collectionManager = account.getCollectionManager();
  return await collectionManager.fetch(collectionUid);
}

/**
 * Update collection metadata and upload the collection.
 */
export async function updateCollectionMeta(
  account: Etebase.Account,
  collection: Etebase.Collection,
  meta: CollectionMetaUpdate,
): Promise<Etebase.Collection> {
  const collectionManager = account.getCollectionManager();
  const currentMeta = (collection as any).getMeta?.() ?? {};
  const nextMeta = {
    ...currentMeta,
    ...(meta.name !== undefined ? { name: meta.name } : {}),
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    ...(meta.color !== undefined ? { color: meta.color } : {}),
    ...(meta.mtime !== undefined ? { mtime: meta.mtime } : {}),
  };

  if (typeof (collection as any).setMeta === 'function') {
    await (collection as any).setMeta(nextMeta);
  } else {
    (collection as any).meta = nextMeta;
  }

  await collectionManager.upload(collection);
  return collection;
}

/**
 * Mark a collection deleted and upload the tombstone.
 */
export async function deleteCollection(
  account: Etebase.Account,
  collection: Etebase.Collection,
): Promise<void> {
  const collectionManager = account.getCollectionManager();
  (collection as any).delete();
  await collectionManager.upload(collection);
}

/**
 * Create a new item in a collection.
 */
export async function createItem(
  account: Etebase.Account,
  collection: Etebase.Collection,
  content: string,
  meta?: ItemMeta,
): Promise<Etebase.Item> {
  const collectionManager = account.getCollectionManager();
  const itemManager = collectionManager.getItemManager(collection);
  const item = await itemManager.create(toEtebaseItemMeta(meta ?? {}), content);
  // Ensure meta.name is set for bridge/EteSync compatibility
  const itemMeta = item.getMeta();
  if (!itemMeta.name) {
    itemMeta.name = item.uid;
    item.setMeta(itemMeta);
  }
  await itemManager.batch([item]);
  return item;
}

/**
 * List items in a collection, optionally resuming from a sync token.
 */
export async function listItems(
  account: Etebase.Account,
  collection: Etebase.Collection,
  stoken?: string | null,
): Promise<ItemListResponse> {
  const collectionManager = account.getCollectionManager();
  const itemManager = collectionManager.getItemManager(collection);
  const response = await itemManager.list({
    stoken: stoken ?? undefined,
  });
  return {
    items: response.data,
    stoken: response.stoken ?? null,
    done: response.done,
  };
}

/**
 * Update an existing item's content and optionally its metadata.
 */
export async function updateItem(
  account: Etebase.Account,
  collection: Etebase.Collection,
  item: Etebase.Item,
  content: string,
  meta?: ItemMeta,
): Promise<Etebase.Item> {
  const collectionManager = account.getCollectionManager();
  const itemManager = collectionManager.getItemManager(collection);
  if (meta) {
    // Merge so metadata written by other clients (e.g. EteSync Notes) survives.
    const currentMeta: ItemMeta = item.getMeta?.() ?? {};
    await item.setMeta(toEtebaseItemMeta({ ...currentMeta, ...meta }));
  }
  await item.setContent(content);
  await itemManager.batch([item]);
  return item;
}

/**
 * The server revision an SDK item was saved at, or null when it is unknown or
 * the object has local, unsaved changes.
 */
export function savedRevisionOf(item: Etebase.Item | null | undefined): string | null {
  if (!item) return null;
  const lastEtag = (item as any).encryptedItem?.lastEtag;
  if (typeof lastEtag !== 'string' || lastEtag.length === 0) return null;
  return lastEtag === item.etag ? lastEtag : null;
}

/**
 * Fetch one item fresh from the server. A NotFoundError resolves null;
 * everything else is rethrown. Callers never read null as proof of absence.
 */
export async function fetchItemFresh(
  account: Etebase.Account,
  collection: Etebase.Collection,
  itemUid: string,
): Promise<Etebase.Item | null> {
  try {
    return await account.getCollectionManager().getItemManager(collection).fetch(itemUid);
  } catch (err) {
    if (err instanceof Etebase.NotFoundError || (err instanceof Error && err.name === 'NotFoundError')) return null;
    throw err;
  }
}

export type ConditionalUpdateResult =
  | { kind: 'saved'; item: Etebase.Item; etag: string }
  | { kind: 'conflict' };

function isConflictError(err: unknown): boolean {
  return err instanceof Etebase.ConflictError || (err instanceof Error && err.name === 'ConflictError');
}

/**
 * Write `content` only if the server still holds the given revision. The
 * write goes through a clone, so the source item is never mutated. `deps` are
 * sent as transaction dependencies at their own saved revisions. A 409 is
 * reported as a conflict; every other error is rethrown.
 */
export async function updateItemIfUnchanged(
  account: Etebase.Account,
  collection: Etebase.Collection,
  item: Etebase.Item,
  content: string,
  meta: ItemMeta | undefined,
  options: { etagOverride?: string; deps?: Etebase.Item[]; beforeDispatch?: () => void } = {},
): Promise<ConditionalUpdateResult> {
  const itemManager = account.getCollectionManager().getItemManager(collection);
  const clone = (item as any)._clone() as Etebase.Item;
  (clone as any).encryptedItem.lastEtag = options.etagOverride ?? (item as any).encryptedItem.lastEtag;
  if (meta) {
    const currentMeta: ItemMeta = clone.getMeta?.() ?? {};
    await clone.setMeta(toEtebaseItemMeta({ ...currentMeta, ...meta }));
  }
  await clone.setContent(content);
  options.beforeDispatch?.();
  try {
    await itemManager.transaction([clone], options.deps);
  } catch (err) {
    if (isConflictError(err)) return { kind: 'conflict' };
    throw err;
  }
  return { kind: 'saved', item: clone, etag: (clone as any).encryptedItem.lastEtag };
}

export type ConditionalDeleteResult = { kind: 'deleted' } | { kind: 'conflict' };

/**
 * Delete an item only if the server still holds the given revision. The
 * tombstone goes through a clone, so the source item is never mutated. A 409
 * is reported as a conflict; every other error is rethrown.
 */
export async function deleteItemIfUnchanged(
  account: Etebase.Account,
  collection: Etebase.Collection,
  item: Etebase.Item,
  options: { etagOverride?: string; deps?: Etebase.Item[]; beforeDispatch?: () => void } = {},
): Promise<ConditionalDeleteResult> {
  const itemManager = account.getCollectionManager().getItemManager(collection);
  const clone = (item as any)._clone() as Etebase.Item;
  (clone as any).encryptedItem.lastEtag = options.etagOverride ?? (item as any).encryptedItem.lastEtag;
  clone.delete();
  options.beforeDispatch?.();
  try {
    await itemManager.transaction([clone], options.deps);
  } catch (err) {
    if (isConflictError(err)) return { kind: 'conflict' };
    throw err;
  }
  return { kind: 'deleted' };
}

/**
 * Tombstone a collection only if its main item is still at the revision it was
 * fetched at and nothing in the collection changed since `stoken`. Pass a
 * freshly fetched collection: it is marked deleted. A 409 is reported as a
 * conflict; every other error is rethrown.
 */
export async function deleteCollectionIfUnchanged(
  account: Etebase.Account,
  collection: Etebase.Collection,
  stoken: string,
  options: { beforeDispatch?: () => void } = {},
): Promise<ConditionalDeleteResult> {
  (collection as any).delete();
  options.beforeDispatch?.();
  try {
    await account.getCollectionManager().transaction(collection, { stoken });
  } catch (err) {
    if (isConflictError(err)) return { kind: 'conflict' };
    throw err;
  }
  return { kind: 'deleted' };
}

/**
 * Mark an item as deleted and upload the change.
 */
export async function deleteItem(
  account: Etebase.Account,
  collection: Etebase.Collection,
  item: Etebase.Item,
): Promise<void> {
  const collectionManager = account.getCollectionManager();
  const itemManager = collectionManager.getItemManager(collection);
  item.delete();
  await itemManager.batch([item]);
}

/**
 * Upload a batch of items at once.
 */
export async function batchUpload(
  account: Etebase.Account,
  collection: Etebase.Collection,
  items: Etebase.Item[],
): Promise<void> {
  const collectionManager = account.getCollectionManager();
  const itemManager = collectionManager.getItemManager(collection);
  await itemManager.batch(items);
}
