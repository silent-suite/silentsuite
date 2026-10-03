import * as Etebase from 'etebase';
import { describe, expect, it, vi } from 'vitest';
import { getAccountFingerprint } from './client.js';
import {
  acceptInvitation,
  cancelOutgoingInvitation,
  fetchUserProfile,
  getPublicKeyFingerprint,
  inviteToCollection,
  leaveCollection,
  listCollectionMembers,
  listIncomingInvitations,
  listOutgoingInvitations,
  modifyCollectionMemberAccess,
  rejectInvitation,
  removeCollectionMember,
  snapshotInvitation,
} from './sharing.js';

function pagedManager<T>(pages: Array<{ data: T[]; iterator?: string | null; done: boolean }>) {
  const fn = vi.fn(async () => pages.shift());
  return fn;
}

function sharingKey(seed: number): Uint8Array {
  return new Uint8Array(32).map((_, index) => (seed + index) & 0xff);
}

function signedInvitation(overrides: Record<string, unknown> = {}): Etebase.SignedInvitation {
  return {
    uid: 'invite-1',
    version: 1,
    username: 'me@example.com',
    collection: 'collection-1',
    accessLevel: Etebase.CollectionAccessLevel.ReadWrite,
    signedEncryptionKey: new Uint8Array([9, 8, 7, 6]),
    fromUsername: 'friend@example.com',
    fromPubkey: sharingKey(40),
    ...overrides,
  } as Etebase.SignedInvitation;
}

describe('sharing invitation wrappers', () => {
  it('lists incoming invitations across iterator pages', async () => {
    const first = { uid: 'invite-1' } as Etebase.SignedInvitation;
    const second = { uid: 'invite-2' } as Etebase.SignedInvitation;
    const listIncoming = pagedManager([
      { data: [first], iterator: 'next-page', done: false },
      { data: [second], iterator: null, done: true },
    ]);
    const account = {
      getInvitationManager: vi.fn().mockReturnValue({ listIncoming }),
    } as any;

    await expect(listIncomingInvitations(account, { limit: 1 })).resolves.toEqual([first, second]);
    expect(listIncoming).toHaveBeenNthCalledWith(1, { iterator: null, limit: 1 });
    expect(listIncoming).toHaveBeenNthCalledWith(2, { iterator: 'next-page', limit: 1 });
  });

  it('lists outgoing invitations through the invitation manager', async () => {
    const invitation = { uid: 'outgoing' } as Etebase.SignedInvitation;
    const listOutgoing = pagedManager([{ data: [invitation], iterator: null, done: true }]);
    const account = {
      getInvitationManager: vi.fn().mockReturnValue({ listOutgoing }),
    } as any;

    await expect(listOutgoingInvitations(account)).resolves.toEqual([invitation]);
    expect(listOutgoing).toHaveBeenCalledWith({ iterator: null, limit: undefined });
  });

  it('accepts with a confirmed sender key, rejects, and cancels invitations', async () => {
    const invitation = signedInvitation();
    const accept = vi.fn().mockResolvedValue({});
    const reject = vi.fn().mockResolvedValue({});
    const disinvite = vi.fn().mockResolvedValue({});
    const account = {
      getInvitationManager: vi.fn().mockReturnValue({ accept, reject, disinvite }),
    } as any;

    await acceptInvitation(account, invitation, sharingKey(40));
    await rejectInvitation(account, invitation);
    await cancelOutgoingInvitation(account, invitation);

    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept.mock.calls[0][0]).not.toBe(invitation);
    expect(accept.mock.calls[0][0]).toEqual(invitation);
    expect(reject).toHaveBeenCalledWith(invitation);
    expect(disinvite).toHaveBeenCalledWith(invitation);
  });

  it('fetches a user profile through the invitation manager', async () => {
    const pubkey = new Uint8Array([1, 2, 3]);
    const fetchUserProfileMock = vi.fn().mockResolvedValue({ pubkey });
    const account = {
      getInvitationManager: vi.fn().mockReturnValue({ fetchUserProfile: fetchUserProfileMock }),
    } as any;

    await expect(fetchUserProfile(account, 'friend@example.com')).resolves.toEqual({ pubkey });
    expect(fetchUserProfileMock).toHaveBeenCalledWith('friend@example.com');
  });

  it('invites with the explicitly confirmed public key and never fetches a replacement', async () => {
    const confirmedPubkey = new Uint8Array(32).map((_, i) => i + 1);
    const serverPubkey = new Uint8Array(32).fill(0xee);
    const collection = { uid: 'collection-1' } as Etebase.Collection;
    const fetchUserProfileMock = vi.fn().mockResolvedValue({ pubkey: serverPubkey });
    const invite = vi.fn().mockResolvedValue(undefined);
    const account = {
      getInvitationManager: vi.fn().mockReturnValue({ fetchUserProfile: fetchUserProfileMock, invite }),
    } as any;

    await inviteToCollection(account, collection, 'friend@example.com', confirmedPubkey, 'readWrite');

    expect(fetchUserProfileMock).not.toHaveBeenCalled();
    expect(invite).toHaveBeenCalledTimes(1);
    const [invitedCollection, invitedUsername, invitedPubkey, invitedAccess] = invite.mock.calls[0];
    expect(invitedCollection).toBe(collection);
    expect(invitedUsername).toBe('friend@example.com');
    expect(invitedPubkey).toBeInstanceOf(Uint8Array);
    expect(Array.from(invitedPubkey as Uint8Array)).toEqual(Array.from(confirmedPubkey));
    expect(invitedAccess).toBe(Etebase.CollectionAccessLevel.ReadWrite);
  });

  it('sends a private copy of the confirmed key that later caller mutation cannot change', async () => {
    const confirmedPubkey = sharingKey(7);
    const expected = Array.from(confirmedPubkey);
    let release!: () => void;
    const invite = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const account = { getInvitationManager: vi.fn().mockReturnValue({ invite }) } as any;

    const pending = inviteToCollection(account, { uid: 'c' } as Etebase.Collection, 'friend@example.com', confirmedPubkey, 'readOnly');
    confirmedPubkey.fill(0);
    await vi.waitFor(() => expect(invite).toHaveBeenCalledTimes(1));
    release();
    await pending;

    const sent = invite.mock.calls[0] as unknown[];
    expect(sent[2]).not.toBe(confirmedPubkey);
    expect(Array.from(sent[2] as Uint8Array)).toEqual(expected);
  });

  it.each([
    ['missing', undefined],
    ['plain array', Array.from(sharingKey(1))],
    ['short', new Uint8Array(31)],
    ['long', new Uint8Array(33)],
  ])('rejects a %s confirmed key without inviting', async (_label, key) => {
    const invite = vi.fn();
    const fetchUserProfileMock = vi.fn();
    const account = { getInvitationManager: vi.fn().mockReturnValue({ invite, fetchUserProfile: fetchUserProfileMock }) } as any;

    await expect(
      inviteToCollection(account, { uid: 'c' } as Etebase.Collection, 'friend@example.com', key as Uint8Array, 'readOnly'),
    ).rejects.toThrow();
    expect(invite).not.toHaveBeenCalled();
    expect(fetchUserProfileMock).not.toHaveBeenCalled();
  });

  it('formats a public key fingerprint identically to the own-account fingerprint', async () => {
    await Etebase.ready;
    const key = sharingKey(90);
    const own = getAccountFingerprint({ getInvitationManager: () => ({ pubkey: key }) } as any);

    expect(getPublicKeyFingerprint(key)).toBe(own);
    expect(getPublicKeyFingerprint(key)).toBe(Etebase.getPrettyFingerprint(key));
    expect(getPublicKeyFingerprint(sharingKey(91))).not.toBe(own);
    expect(() => getPublicKeyFingerprint(new Uint8Array(31))).toThrow();
  });

  it('snapshots invitations so later mutation of the original cannot change accepted bytes', async () => {
    const invitation = signedInvitation();
    const snapshot = snapshotInvitation(invitation);
    (invitation.fromPubkey as Uint8Array).fill(0);
    (invitation.signedEncryptionKey as Uint8Array).fill(0);
    (invitation as any).uid = 'changed';

    expect(snapshot.uid).toBe('invite-1');
    expect(Array.from(snapshot.fromPubkey)).toEqual(Array.from(sharingKey(40)));
    expect(Array.from(snapshot.signedEncryptionKey)).toEqual([9, 8, 7, 6]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it.each([
    ['missing sender key', { fromPubkey: undefined }],
    ['short sender key', { fromPubkey: new Uint8Array(12) }],
    ['missing encrypted key', { signedEncryptionKey: undefined }],
    ['missing uid', { uid: undefined }],
  ])('refuses to snapshot an invitation with a %s', (_label, overrides) => {
    expect(() => snapshotInvitation(signedInvitation(overrides))).toThrow();
  });

  it('refuses to accept when the confirmed sender key does not match', async () => {
    const accept = vi.fn();
    const account = { getInvitationManager: vi.fn().mockReturnValue({ accept }) } as any;

    await expect(acceptInvitation(account, signedInvitation(), sharingKey(41))).rejects.toThrow();
    await expect(acceptInvitation(account, signedInvitation(), undefined as unknown as Uint8Array)).rejects.toThrow();
    await expect(acceptInvitation(account, signedInvitation({ fromPubkey: new Uint8Array(3) }), sharingKey(40))).rejects.toThrow();
    expect(accept).not.toHaveBeenCalled();
  });
});

describe('sharing member wrappers', () => {
  it('lists collection members across iterator pages', async () => {
    const collection = { uid: 'collection-1' } as Etebase.Collection;
    const owner = { username: 'owner', accessLevel: Etebase.CollectionAccessLevel.Admin };
    const invited = { username: 'invited', accessLevel: Etebase.CollectionAccessLevel.ReadOnly };
    const list = pagedManager([
      { data: [owner], iterator: 'next-members', done: false },
      { data: [invited], iterator: null, done: true },
    ]);
    const getMemberManager = vi.fn().mockReturnValue({ list });
    const account = {
      getCollectionManager: vi.fn().mockReturnValue({ getMemberManager }),
    } as any;

    await expect(listCollectionMembers(account, collection, { limit: 1 })).resolves.toEqual([owner, invited]);
    expect(getMemberManager).toHaveBeenCalledWith(collection);
    expect(list).toHaveBeenNthCalledWith(1, { iterator: null, limit: 1 });
    expect(list).toHaveBeenNthCalledWith(2, { iterator: 'next-members', limit: 1 });
  });

  it('removes, leaves, and modifies collection membership', async () => {
    const collection = { uid: 'collection-1' } as Etebase.Collection;
    const remove = vi.fn().mockResolvedValue({});
    const leave = vi.fn().mockResolvedValue({});
    const modifyAccessLevel = vi.fn().mockResolvedValue({});
    const account = {
      getCollectionManager: vi.fn().mockReturnValue({
        getMemberManager: vi.fn().mockReturnValue({ remove, leave, modifyAccessLevel }),
      }),
    } as any;

    await removeCollectionMember(account, collection, 'friend@example.com');
    await leaveCollection(account, collection);
    await modifyCollectionMemberAccess(account, collection, 'friend@example.com', 'admin');

    expect(remove).toHaveBeenCalledWith('friend@example.com');
    expect(leave).toHaveBeenCalledTimes(1);
    expect(modifyAccessLevel).toHaveBeenCalledWith('friend@example.com', Etebase.CollectionAccessLevel.Admin);
  });
});
