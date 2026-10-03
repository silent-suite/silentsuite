import { describe, expect, it, vi } from 'vitest';
import { createItem, listCollections, updateCollectionMeta, updateItem } from './collections.js';

describe('listCollections', () => {
  it('filters deleted collection tombstones', async () => {
    const active = { uid: 'active' };
    const legacyActive = { uid: 'legacy-active', isDeleted: false };
    const deleted = { uid: 'deleted', isDeleted: true };
    const collectionManager = {
      // done: true is deliberate: a single-page response must say it is complete,
      // because listCollections keeps paging until the server reports done.
      list: vi.fn().mockResolvedValue({ data: [active, deleted, legacyActive], done: true }),
    };
    const account = {
      getCollectionManager: vi.fn().mockReturnValue(collectionManager),
    };

    const collections = await listCollections(account as any, 'etebase.vevent');

    expect(collectionManager.list).toHaveBeenCalledTimes(1);
    expect(collectionManager.list).toHaveBeenCalledWith('etebase.vevent');
    expect(collections).toEqual([active, legacyActive]);
  });

  it('follows stokens and combines every page until the server reports done', async () => {
    const first = { uid: 'first' };
    const second = { uid: 'second' };
    const third = { uid: 'third' };
    const collectionManager = {
      list: vi
        .fn()
        .mockResolvedValueOnce({ data: [first], stoken: 'stoken-1', done: false })
        .mockResolvedValueOnce({ data: [second], stoken: 'stoken-2', done: false })
        .mockResolvedValueOnce({ data: [third], stoken: 'stoken-3', done: true }),
    };
    const account = {
      getCollectionManager: vi.fn().mockReturnValue(collectionManager),
    };

    const collections = await listCollections(account as any, 'etebase.vevent');

    expect(collectionManager.list.mock.calls).toEqual([
      ['etebase.vevent'],
      ['etebase.vevent', { stoken: 'stoken-1' }],
      ['etebase.vevent', { stoken: 'stoken-2' }],
    ]);
    expect(collections).toEqual([first, second, third]);
  });

  it('does not treat a page without done as the final page', async () => {
    const first = { uid: 'first' };
    const second = { uid: 'second' };
    const collectionManager = {
      list: vi
        .fn()
        .mockResolvedValueOnce({ data: [first], stoken: 'stoken-1' })
        .mockResolvedValueOnce({ data: [second], stoken: 'stoken-2', done: true }),
    };
    const account = {
      getCollectionManager: vi.fn().mockReturnValue(collectionManager),
    };

    const collections = await listCollections(account as any, 'etebase.vevent');

    expect(collectionManager.list).toHaveBeenCalledTimes(2);
    expect(collections).toEqual([first, second]);
  });

  it('keeps the later page when a uid repeats and drops collections deleted on a later page', async () => {
    const stale = { uid: 'updated', etag: 'old' };
    const liveThenDeleted = { uid: 'removed' };
    const fresh = { uid: 'updated', etag: 'new' };
    const tombstone = { uid: 'removed', isDeleted: true };
    const other = { uid: 'other' };
    const collectionManager = {
      list: vi
        .fn()
        .mockResolvedValueOnce({ data: [stale, liveThenDeleted], stoken: 'stoken-1', done: false })
        .mockResolvedValueOnce({ data: [fresh, tombstone, other], stoken: 'stoken-2', done: true }),
    };
    const account = {
      getCollectionManager: vi.fn().mockReturnValue(collectionManager),
    };

    const collections = await listCollections(account as any, 'etebase.vevent');

    expect(collections).toEqual([fresh, other]);
  });

  it.each([
    ['missing', { data: [{ uid: 'first' }], done: false }],
    ['null', { data: [{ uid: 'first' }], stoken: null, done: false }],
    ['missing alongside a missing done', { data: [{ uid: 'first' }] }],
  ])('throws when an unfinished page has a %s stoken', async (_label, page) => {
    const collectionManager = {
      list: vi.fn().mockResolvedValueOnce(page),
    };
    const account = {
      getCollectionManager: vi.fn().mockReturnValue(collectionManager),
    };

    await expect(listCollections(account as any, 'etebase.vevent')).rejects.toThrow(
      'Collection list is not done but returned no stoken',
    );
    expect(collectionManager.list).toHaveBeenCalledTimes(1);
  });

  it('throws when an unfinished page returns the stoken it was requested with', async () => {
    const collectionManager = {
      list: vi
        .fn()
        .mockResolvedValueOnce({ data: [{ uid: 'first' }], stoken: 'stoken-1', done: false })
        .mockResolvedValueOnce({ data: [{ uid: 'second' }], stoken: 'stoken-1', done: false }),
    };
    const account = {
      getCollectionManager: vi.fn().mockReturnValue(collectionManager),
    };

    await expect(listCollections(account as any, 'etebase.vevent')).rejects.toThrow(
      'Collection list returned a repeated stoken',
    );
    expect(collectionManager.list).toHaveBeenCalledTimes(2);
  });

  it('throws when an earlier stoken comes back after other pages', async () => {
    const collectionManager = {
      list: vi
        .fn()
        .mockResolvedValueOnce({ data: [{ uid: 'first' }], stoken: 'stoken-1', done: false })
        .mockResolvedValueOnce({ data: [{ uid: 'second' }], stoken: 'stoken-2', done: false })
        .mockResolvedValueOnce({ data: [{ uid: 'third' }], stoken: 'stoken-1', done: false }),
    };
    const account = {
      getCollectionManager: vi.fn().mockReturnValue(collectionManager),
    };

    await expect(listCollections(account as any, 'etebase.vevent')).rejects.toThrow(
      'Collection list returned a repeated stoken',
    );
    expect(collectionManager.list).toHaveBeenCalledTimes(3);
  });

  it('throws after the page cap when the server never reports done', async () => {
    let calls = 0;
    const collectionManager = {
      list: vi.fn().mockImplementation(async () => {
        calls += 1;
        // Stops a listCollections without a cap from spinning forever in this test.
        if (calls > 1500) throw new Error('mock ran past the page cap');
        return { data: [{ uid: `collection-${calls}` }], stoken: `stoken-${calls}`, done: false };
      }),
    };
    const account = {
      getCollectionManager: vi.fn().mockReturnValue(collectionManager),
    };

    await expect(listCollections(account as any, 'etebase.vevent')).rejects.toThrow(
      'Collection list exceeded 1000 pages',
    );
    expect(collectionManager.list).toHaveBeenCalledTimes(1000);
  });

  it('throws instead of returning a partial list when a later page fails', async () => {
    const collectionManager = {
      list: vi
        .fn()
        .mockResolvedValueOnce({ data: [{ uid: 'first' }], stoken: 'stoken-1', done: false })
        .mockRejectedValueOnce(new Error('network down')),
    };
    const account = {
      getCollectionManager: vi.fn().mockReturnValue(collectionManager),
    };

    await expect(listCollections(account as any, 'etebase.vevent')).rejects.toThrow('network down');
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
