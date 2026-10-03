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
