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

const SHARING_PUBLIC_KEY_LENGTH = 32;

export class InvalidSharingKeyError extends Error {
  constructor(message = 'Sharing public key is missing or malformed') {
    super(message);
    this.name = 'InvalidSharingKeyError';
  }
}

export class InvalidSharingInvitationError extends Error {
  constructor(message = 'Sharing invitation is missing required fields') {
    super(message);
    this.name = 'InvalidSharingInvitationError';
  }
}

function copySharingPublicKey(pubkey: unknown): Uint8Array {
  if (!(pubkey instanceof Uint8Array) || pubkey.length !== SHARING_PUBLIC_KEY_LENGTH) {
    throw new InvalidSharingKeyError();
  }
  return pubkey.slice();
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

/**
 * Format a sharing public key with the same fingerprint used for the account's own key.
 */
export function getPublicKeyFingerprint(pubkey: Uint8Array): string {
  return Etebase.getPrettyFingerprint(copySharingPublicKey(pubkey));
}

/**
 * Return a frozen copy of an incoming invitation whose key material cannot be changed through the original object.
 */
export function snapshotInvitation(invitation: Etebase.SignedInvitation): Etebase.SignedInvitation {
  if (!invitation || typeof invitation !== 'object') throw new InvalidSharingInvitationError();
  const { uid, version, username, collection, accessLevel, signedEncryptionKey, fromUsername, fromPubkey } = invitation;
  if (
    typeof uid !== 'string' || !uid ||
    typeof version !== 'number' ||
    typeof username !== 'string' ||
    typeof collection !== 'string' || !collection ||
    typeof accessLevel !== 'number' ||
    !(signedEncryptionKey instanceof Uint8Array) || signedEncryptionKey.length === 0 ||
    (fromUsername !== undefined && fromUsername !== null && typeof fromUsername !== 'string')
  ) {
    throw new InvalidSharingInvitationError();
  }
  const snapshot: Etebase.SignedInvitation = {
    uid,
    version,
    username,
    collection,
    accessLevel,
    signedEncryptionKey: signedEncryptionKey.slice(),
    fromPubkey: copySharingPublicKey(fromPubkey),
  };
  if (typeof fromUsername === 'string') snapshot.fromUsername = fromUsername;
  return Object.freeze(snapshot);
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
 * Accept an incoming invitation only when its sender key matches the key the user confirmed.
 */
export async function acceptInvitation(
  account: Etebase.Account,
  invitation: Etebase.SignedInvitation,
  confirmedFromPubkey: Uint8Array,
): Promise<void> {
  const confirmed = copySharingPublicKey(confirmedFromPubkey);
  const snapshot = snapshotInvitation(invitation);
  if (!bytesEqual(snapshot.fromPubkey, confirmed)) {
    throw new InvalidSharingKeyError('Invitation sender key does not match the confirmed key');
  }
  const invitationManager = account.getInvitationManager();
  await invitationManager.accept(snapshot);
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
 * Invite another user to a collection with the public key the inviter already confirmed.
 * Never fetches a replacement key.
 */
export async function inviteToCollection(
  account: Etebase.Account,
  collection: Etebase.Collection,
  username: string,
  confirmedPubkey: Uint8Array,
  accessLevel: SharingAccessLevel,
): Promise<void> {
  const pubkey = copySharingPublicKey(confirmedPubkey);
  const invitationManager = account.getInvitationManager();
  await invitationManager.invite(collection, username, pubkey, normalizeAccessLevel(accessLevel));
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
