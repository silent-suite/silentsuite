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

/**
 * Where a new item goes when none is chosen: the default list if writable, else
 * the only visible writable list, else the first writable one. Undefined when no
 * list accepts writes, so a read-only list is never the target.
 */
export function defaultWritableListId(
  lists: Array<{ id: string; visible: boolean; accessLevel?: number }>,
  activeListId: string | null | undefined,
): string | undefined {
  const writable = lists.filter(canWriteCollection)
  if (activeListId && writable.some((list) => list.id === activeListId)) return activeListId
  const visible = writable.filter((list) => list.visible)
  return (visible.length === 1 ? visible[0] : writable[0])?.id
}
