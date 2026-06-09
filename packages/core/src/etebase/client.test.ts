import * as Etebase from 'etebase';
import { describe, expect, it, vi } from 'vitest';
import { getAccountFingerprint } from './client.js';

vi.mock('etebase', () => ({
  getPrettyFingerprint: vi.fn().mockReturnValue('abcd ef12 3456'),
}));

describe('getAccountFingerprint', () => {
  it('formats the account invitation public key fingerprint', () => {
    const pubkey = new Uint8Array([1, 2, 3, 4]);
    const account = {
      getInvitationManager: vi.fn().mockReturnValue({ pubkey }),
    };

    const fingerprint = getAccountFingerprint(account as any);

    expect(account.getInvitationManager).toHaveBeenCalledTimes(1);
    expect(Etebase.getPrettyFingerprint).toHaveBeenCalledWith(pubkey);
    expect(fingerprint).toBe('abcd ef12 3456');
  });
});
