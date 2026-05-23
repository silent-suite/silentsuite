import { describe, expect, it, vi } from 'vitest';
import { listCollections, updateCollectionMeta } from './collections.js';

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
