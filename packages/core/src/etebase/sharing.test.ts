import * as Etebase from 'etebase';
import { describe, expect, it, vi } from 'vitest';
import {
  acceptInvitation,
  cancelOutgoingInvitation,
  fetchUserProfile,
  inviteToCollection,
  leaveCollection,
  listCollectionMembers,
  listIncomingInvitations,
  listOutgoingInvitations,
  modifyCollectionMemberAccess,
  rejectInvitation,
  removeCollectionMember,
} from './sharing.js';

function pagedManager<T>(pages: Array<{ data: T[]; iterator?: string | null; done: boolean }>) {
  const fn = vi.fn(async () => pages.shift());
  return fn;
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

  it('accepts, rejects, and cancels invitations without exposing invite contents', async () => {
    const invitation = { uid: 'invite-1' } as Etebase.SignedInvitation;
    const accept = vi.fn().mockResolvedValue({});
    const reject = vi.fn().mockResolvedValue({});
    const disinvite = vi.fn().mockResolvedValue({});
    const account = {
      getInvitationManager: vi.fn().mockReturnValue({ accept, reject, disinvite }),
    } as any;

    await acceptInvitation(account, invitation);
    await rejectInvitation(account, invitation);
    await cancelOutgoingInvitation(account, invitation);

    expect(accept).toHaveBeenCalledWith(invitation);
    expect(reject).toHaveBeenCalledWith(invitation);
    expect(disinvite).toHaveBeenCalledWith(invitation);
  });

  it('fetches a user profile and invites with the fetched public key', async () => {
    const pubkey = new Uint8Array([1, 2, 3]);
    const collection = { uid: 'collection-1' } as Etebase.Collection;
    const fetchUserProfileMock = vi.fn().mockResolvedValue({ pubkey });
    const invite = vi.fn().mockResolvedValue(undefined);
    const account = {
      getInvitationManager: vi.fn().mockReturnValue({ fetchUserProfile: fetchUserProfileMock, invite }),
    } as any;

    await expect(fetchUserProfile(account, 'friend@example.com')).resolves.toEqual({ pubkey });
    await inviteToCollection(account, collection, 'friend@example.com', 'readWrite');

    expect(fetchUserProfileMock).toHaveBeenCalledWith('friend@example.com');
    expect(invite).toHaveBeenCalledWith(
      collection,
      'friend@example.com',
      pubkey,
      Etebase.CollectionAccessLevel.ReadWrite,
    );
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
