import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

const ETEBASE_SERVER_URL = 'https://server.silentsuite.io';
const ETEBASE_SESSION_KEY = 'etebase_session';

type CollectionTypeKey = 'calendar' | 'tasks' | 'contacts';

interface EtebaseState {
  isInitialized: boolean;
  isInitializing: boolean;
  account: any | null;
  collections: Record<CollectionTypeKey, any | null>;
  itemCache: Map<string, any>;
  itemTypeMap: Map<string, CollectionTypeKey>;

  initialize: () => Promise<void>;
  createItem: (type: CollectionTypeKey, content: string) => Promise<string>;
  updateItem: (type: CollectionTypeKey, itemUid: string, content: string) => Promise<void>;
  deleteItem: (type: CollectionTypeKey, itemUid: string) => Promise<void>;
  fetchAllItems: (type: CollectionTypeKey) => Promise<Array<{ uid: string; content: string }>>;
  destroy: () => void;
}

export const useEtebaseStore = create<EtebaseState>((set, get) => ({
  isInitialized: false,
  isInitializing: false,
  account: null,
  collections: { calendar: null, tasks: null, contacts: null },
  itemCache: new Map(),
  itemTypeMap: new Map(),

  initialize: async () => {
    if (get().isInitialized || get().isInitializing) return;
    set({ isInitializing: true });

    try {
      const {
        restoreSession,
        listCollections,
        createCollection,
        COLLECTION_TYPE_CALENDAR,
        COLLECTION_TYPE_TASKS,
        COLLECTION_TYPE_CONTACTS,
      } = await import('@silentsuite/core');

      const session = await SecureStore.getItemAsync(ETEBASE_SESSION_KEY);
      if (!session) throw new Error('No saved session');

      const account = await restoreSession(ETEBASE_SERVER_URL, session);

      const collections: Record<CollectionTypeKey, any | null> = {
        calendar: null,
        tasks: null,
        contacts: null,
      };

      // Fetch existing collections by type
      const typeConfig: Array<{ key: CollectionTypeKey; type: string; name: string }> = [
        { key: 'calendar', type: COLLECTION_TYPE_CALENDAR, name: 'Personal Calendar' },
        { key: 'tasks', type: COLLECTION_TYPE_TASKS, name: 'Personal Tasks' },
        { key: 'contacts', type: COLLECTION_TYPE_CONTACTS, name: 'Personal Contacts' },
      ];

      for (const { key, type, name } of typeConfig) {
        const existing = await listCollections(account, type);
        if (existing.length > 0) {
          collections[key] = existing[0];
        } else {
          collections[key] = await createCollection(account, type, { name });
        }
      }

      set({ account, collections, isInitialized: true, isInitializing: false });
    } catch (e) {
      console.error('Etebase init failed:', e);
      set({ isInitializing: false });
      throw e;
    }
  },

  createItem: async (type, content) => {
    const { account, collections } = get();
    if (!account || !collections[type]) throw new Error('Not initialized');

    const { createItem } = await import('@silentsuite/core');
    const item = await createItem(account, collections[type], content);
    const uid = item.uid;

    get().itemCache.set(uid, item);
    get().itemTypeMap.set(uid, type);

    return uid;
  },

  updateItem: async (type, itemUid, content) => {
    const { account, collections, itemCache } = get();
    if (!account || !collections[type]) throw new Error('Not initialized');

    const item = itemCache.get(itemUid);
    if (!item) throw new Error(`Item not found: ${itemUid}`);

    const { updateItem } = await import('@silentsuite/core');
    await updateItem(account, collections[type], item, content);
  },

  deleteItem: async (type, itemUid) => {
    const { account, collections, itemCache } = get();
    if (!account || !collections[type]) throw new Error('Not initialized');

    const item = itemCache.get(itemUid);
    if (!item) throw new Error(`Item not found: ${itemUid}`);

    const { deleteItem } = await import('@silentsuite/core');
    await deleteItem(account, collections[type], item);

    itemCache.delete(itemUid);
    get().itemTypeMap.delete(itemUid);
  },

  fetchAllItems: async (type) => {
    const { account, collections, itemCache, itemTypeMap } = get();
    if (!account || !collections[type]) throw new Error('Not initialized');

    const { listItems } = await import('@silentsuite/core');
    const response = await listItems(account, collections[type]);
    const results: Array<{ uid: string; content: string }> = [];

    for (const item of response.items) {
      itemCache.set(item.uid, item);
      itemTypeMap.set(item.uid, type);
      const rawContent = await item.getContent();
      const content = typeof rawContent === 'string'
        ? rawContent
        : new TextDecoder().decode(rawContent);
      results.push({ uid: item.uid, content });
    }

    return results;
  },

  destroy: () => {
    set({
      isInitialized: false,
      account: null,
      collections: { calendar: null, tasks: null, contacts: null },
      itemCache: new Map(),
      itemTypeMap: new Map(),
    });
  },
}));
