import * as Etebase from 'etebase';
import type { CollectionAccessLevel as SilentSuiteAccessLevel } from './types.js';

export type SharingAccessLevel = SilentSuiteAccessLevel | Etebase.CollectionAccessLevel;

export interface ListSharingOptions {
  limit?: number;
}

export interface UserProfile {
  pubkey: Uint8Array;
}

export interface CollectionMember {
  username: string;
  accessLevel: Etebase.CollectionAccessLevel;
}

function normalizeAccessLevel(accessLevel: SharingAccessLevel): Etebase.CollectionAccessLevel {
  if (typeof accessLevel === 'number') return accessLevel;
  if (accessLevel === 'admin') return Etebase.CollectionAccessLevel.Admin;
  if (accessLevel === 'readWrite') return Etebase.CollectionAccessLevel.ReadWrite;
  return Etebase.CollectionAccessLevel.ReadOnly;
}

async function listWithIterator<T>(
  listPage: (options: { iterator?: string | null; limit?: number }) => Promise<{
    data: T[];
    iterator?: string | null;
    done: boolean;
  }>,
  options: ListSharingOptions = {},
): Promise<T[]> {
  const result: T[] = [];
  let iterator: string | null | undefined = null;
  let done = false;

  while (!done) {
    const page = await listPage({
      iterator,
      limit: options.limit,
    });
    result.push(...page.data);
    iterator = page.iterator ?? null;
    done = page.done;
  }

  return result;
}

/**
 * List incoming collection invitations for the account.
 */
export async function listIncomingInvitations(
  account: Etebase.Account,
  options?: ListSharingOptions,
): Promise<Etebase.SignedInvitation[]> {
  const invitationManager = account.getInvitationManager();
  return listWithIterator<Etebase.SignedInvitation>(
    (pageOptions) => invitationManager.listIncoming(pageOptions),
    options,
  );
}

/**
 * List outgoing collection invitations created by the account.
 */
export async function listOutgoingInvitations(
  account: Etebase.Account,
  options?: ListSharingOptions,
): Promise<Etebase.SignedInvitation[]> {
  const invitationManager = account.getInvitationManager();
  return listWithIterator<Etebase.SignedInvitation>(
    (pageOptions) => invitationManager.listOutgoing(pageOptions),
    options,
  );
}

/**
 * Accept an incoming invitation and create the local collection membership.
 */
export async function acceptInvitation(
  account: Etebase.Account,
  invitation: Etebase.SignedInvitation,
): Promise<void> {
  const invitationManager = account.getInvitationManager();
  await invitationManager.accept(invitation);
}

/**
 * Reject an incoming invitation.
 */
export async function rejectInvitation(
  account: Etebase.Account,
  invitation: Etebase.SignedInvitation,
): Promise<void> {
  const invitationManager = account.getInvitationManager();
  await invitationManager.reject(invitation);
}

/**
 * Cancel an outgoing invitation that has not been accepted yet.
 */
export async function cancelOutgoingInvitation(
  account: Etebase.Account,
  invitation: Etebase.SignedInvitation,
): Promise<void> {
  const invitationManager = account.getInvitationManager();
  await invitationManager.disinvite(invitation);
}

/**
 * Fetch a user's public invitation profile before creating an invite.
 */
export async function fetchUserProfile(account: Etebase.Account, username: string): Promise<UserProfile> {
  const invitationManager = account.getInvitationManager();
  return invitationManager.fetchUserProfile(username);
}

/**
 * Invite another user to a collection using their public invitation profile.
 */
export async function inviteToCollection(
  account: Etebase.Account,
  collection: Etebase.Collection,
  username: string,
  accessLevel: SharingAccessLevel,
): Promise<void> {
  const invitationManager = account.getInvitationManager();
  const profile = await invitationManager.fetchUserProfile(username);
  await invitationManager.invite(collection, username, profile.pubkey, normalizeAccessLevel(accessLevel));
}

/**
 * List members of a shared collection.
 */
export async function listCollectionMembers(
  account: Etebase.Account,
  collection: Etebase.Collection,
  options?: ListSharingOptions,
): Promise<CollectionMember[]> {
  const memberManager = account.getCollectionManager().getMemberManager(collection);
  return listWithIterator<CollectionMember>(
    (pageOptions) => memberManager.list(pageOptions),
    options,
  );
}

/**
 * Remove a member from a collection.
 */
export async function removeCollectionMember(
  account: Etebase.Account,
  collection: Etebase.Collection,
  username: string,
): Promise<void> {
  const memberManager = account.getCollectionManager().getMemberManager(collection);
  await memberManager.remove(username);
}

/**
 * Leave a shared collection as the current account.
 */
export async function leaveCollection(account: Etebase.Account, collection: Etebase.Collection): Promise<void> {
  const memberManager = account.getCollectionManager().getMemberManager(collection);
  await memberManager.leave();
}

/**
 * Change a collection member's access level.
 */
export async function modifyCollectionMemberAccess(
  account: Etebase.Account,
  collection: Etebase.Collection,
  username: string,
  accessLevel: SharingAccessLevel,
): Promise<void> {
  const memberManager = account.getCollectionManager().getMemberManager(collection);
  await memberManager.modifyAccessLevel(username, normalizeAccessLevel(accessLevel));
}
