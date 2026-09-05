import { describe, expect, it, vi } from 'vitest';
import { createItem, listCollections, updateCollectionMeta, updateItem } from './collections.js';

describe('listCollections', () => {
  it('filters deleted collection tombstones', async () => {
    const active = { uid: 'active' };
    const legacyActive = { uid: 'legacy-active', isDeleted: false };
    const deleted = { uid: 'deleted', isDeleted: true };
    const collectionManager = {
      list: vi.fn().mockResolvedValue({ data: [active, deleted, legacyActive] }),
    };
    const account = {
      getCollectionManager: vi.fn().mockReturnValue(collectionManager),
    };

    const collections = await listCollections(account as any, 'etebase.vevent');

    expect(collectionManager.list).toHaveBeenCalledWith('etebase.vevent');
    expect(collections).toEqual([active, legacyActive]);
  });
});

describe('updateCollectionMeta', () => {
  it('preserves existing metadata fields when updating only color', async () => {
    const collection = {
      uid: 'calendar-1',
      getMeta: vi.fn().mockReturnValue({
        name: 'Work',
        description: 'Existing description',
        color: '#111111',
      }),
      setMeta: vi.fn().mockResolvedValue(undefined),
    };
    const collectionManager = {
      upload: vi.fn().mockResolvedValue(undefined),
    };
    const account = {
      getCollectionManager: vi.fn().mockReturnValue(collectionManager),
    };

    const result = await updateCollectionMeta(account as any, collection as any, { color: '#ff0000' });

    expect(collection.setMeta).toHaveBeenCalledWith({
      name: 'Work',
      description: 'Existing description',
      color: '#ff0000',
    });
    expect(collectionManager.upload).toHaveBeenCalledWith(collection);
    expect(result).toBe(collection);
  });
});

describe('createItem', () => {
  it('passes name and numeric mtime through to the item manager', async () => {
    const created = {
      uid: 'item-1',
      getMeta: vi.fn().mockReturnValue({ name: 'Shopping list', mtime: 1_700_000_000_000 }),
      setMeta: vi.fn(),
    };
    const itemManager = {
      create: vi.fn().mockResolvedValue(created),
      batch: vi.fn().mockResolvedValue(undefined),
    };
    const account = {
      getCollectionManager: vi.fn().mockReturnValue({
        getItemManager: vi.fn().mockReturnValue(itemManager),
      }),
    };

    await createItem(account as any, { uid: 'col-1' } as any, '- apples', {
      name: 'Shopping list',
      mtime: 1_700_000_000_000,
    });

    expect(itemManager.create).toHaveBeenCalledWith(
      { name: 'Shopping list', mtime: 1_700_000_000_000 },
      '- apples',
    );
    expect(itemManager.batch).toHaveBeenCalledWith([created]);
  });
});

describe('updateItem', () => {
  it('merges item metadata instead of replacing it', async () => {
    const item = {
      uid: 'item-1',
      getMeta: vi.fn().mockReturnValue({ name: 'Old title', mtime: 1 }),
      setMeta: vi.fn().mockResolvedValue(undefined),
      setContent: vi.fn().mockResolvedValue(undefined),
    };
    const itemManager = {
      batch: vi.fn().mockResolvedValue(undefined),
    };
    const account = {
      getCollectionManager: vi.fn().mockReturnValue({
        getItemManager: vi.fn().mockReturnValue(itemManager),
      }),
    };

    await updateItem(account as any, { uid: 'col-1' } as any, item as any, 'new body', {
      name: 'New title',
      mtime: 2,
    });

    expect(item.setMeta).toHaveBeenCalledWith({ name: 'New title', mtime: 2 });
    expect(item.setContent).toHaveBeenCalledWith('new body');
    expect(itemManager.batch).toHaveBeenCalledWith([item]);
  });
});
