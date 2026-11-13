/**
 * Whether a calendar or task list accepts writes. Etebase access: 0 read-only,
 * 1 admin, 2 read/write. A missing level fails closed, as for contacts and notes.
 */
export function canWriteCollection(collection: { accessLevel?: number } | null | undefined): boolean {
  return collection?.accessLevel === 1 || collection?.accessLevel === 2
}

/**
 * The calendar or task list an item is written to. As in the Etebase store, a
 * missing, 'default' or 'all' id means the account's first collection.
 */
export function findItemCollection<T extends { id: string }>(lists: T[], id: string | undefined): T | undefined {
  if (id && id !== 'default' && id !== 'all') return lists.find((list) => list.id === id)
  return lists[0]
}
