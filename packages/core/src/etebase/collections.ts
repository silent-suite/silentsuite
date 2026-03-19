import * as Etebase from 'etebase';

export interface CollectionMeta {
  name: string;
  description?: string;
  color?: string;
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
    },
    '',
  );
  await collectionManager.upload(collection);
  return collection;
}

/**
 * List all collections of a given type.
 */
export async function listCollections(
  account: Etebase.Account,
  collectionType: string,
): Promise<Etebase.Collection[]> {
  const collectionManager = account.getCollectionManager();
  const response = await collectionManager.list(collectionType);
  return response.data;
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
 * Create a new item in a collection.
 */
export async function createItem(
  account: Etebase.Account,
  collection: Etebase.Collection,
  content: string,
  meta?: Record<string, string>,
): Promise<Etebase.Item> {
  const collectionManager = account.getCollectionManager();
  const itemManager = collectionManager.getItemManager(collection);
  const item = await itemManager.create(meta ?? {}, content);
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
  meta?: Record<string, string>,
): Promise<Etebase.Item> {
  const collectionManager = account.getCollectionManager();
  const itemManager = collectionManager.getItemManager(collection);
  if (meta) {
    await item.setMeta(meta);
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
