import * as Etebase from 'etebase';

/**
 * Initialize the Etebase SDK. Must be called before any other operations.
 */
export async function initializeEtebase(serverUrl: string): Promise<void> {
  // The Etebase JS SDK initializes automatically on first use,
  // but we validate the server URL here to fail fast.
  if (!serverUrl) {
    throw new Error('Etebase server URL is required');
  }
}

export interface SignUpOptions {
  /**
   * Owner-issued registration token for servers that require one. Sent only as a
   * header on the signup request; never stored in the account or saved session.
   */
  registrationToken?: string;
}

const REGISTRATION_TOKEN_PATTERN = /^[\x21-\x7E]{1,512}$/;

/**
 * Create a new Etebase account (sign up).
 */
export async function signUp(
  serverUrl: string,
  email: string,
  password: string,
  options?: SignUpOptions,
): Promise<Etebase.Account> {
  const registrationToken = options?.registrationToken;
  if (
    registrationToken !== undefined &&
    (typeof registrationToken !== 'string' || !REGISTRATION_TOKEN_PATTERN.test(registrationToken))
  ) {
    throw new Error('Invalid registration token');
  }
  const account = await Etebase.Account.signup(
    { username: email, email },
    password,
    serverUrl,
    registrationToken === undefined ? undefined : { registrationToken },
  );
  return account;
}

/**
 * Log in to an existing Etebase account.
 */
export async function logIn(
  serverUrl: string,
  email: string,
  password: string,
): Promise<Etebase.Account> {
  const account = await Etebase.Account.login(email, password, serverUrl);
  return account;
}

/**
 * Restore a session from a previously saved session string.
 */
export async function restoreSession(
  _serverUrl: string,
  savedSession: string,
): Promise<Etebase.Account> {
  // The server URL is embedded in the saved session data.
  const account = await Etebase.Account.restore(savedSession);
  return account;
}

/**
 * Serialize the current session for storage.
 */
export async function saveSession(
  account: Etebase.Account,
): Promise<string> {
  return await account.save();
}

/**
 * Return the stable account public-key fingerprint used for cross-device verification.
 */
export function getAccountFingerprint(account: Etebase.Account): string {
  const invitationManager = account.getInvitationManager();
  return Etebase.getPrettyFingerprint(invitationManager.pubkey);
}

/**
 * Change the account password.
 */
export async function changePassword(
  account: Etebase.Account,
  newPassword: string,
): Promise<void> {
  await account.changePassword(newPassword);
}

/** The signed request the server's login email change route expects. */
export interface LoginEmailChangeSignature {
  response: Uint8Array;
  signature: Uint8Array;
}

/**
 * Sign a request to change this account's login to `newUsername` with the
 * current login key. Only fetches a login challenge; the caller posts the result.
 */
export async function signLoginEmailChange(
  account: Etebase.Account,
  newUsername: string,
): Promise<LoginEmailChangeSignature> {
  return await account.signLoginEmailChange(newUsername);
}

function msgpackBin(bytes: Uint8Array): number[] {
  const n = bytes.length;
  if (n < 0x100) return [0xc4, n];
  if (n < 0x10000) return [0xc5, n >> 8, n & 0xff];
  return [0xc6, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function msgpackFixstr(value: string): number[] {
  return [0xa0 | value.length, ...Array.from(value, (c) => c.charCodeAt(0))];
}

/**
 * Msgpack body `{response, signature}` (both binary), the same encoding the
 * SDK uses for change_password, for posting a signed login email change.
 */
export function encodeLoginEmailChangeRequest(signed: LoginEmailChangeSignature): Uint8Array {
  return Uint8Array.from([
    0x82,
    ...msgpackFixstr('response'), ...msgpackBin(signed.response), ...signed.response,
    ...msgpackFixstr('signature'), ...msgpackBin(signed.signature), ...signed.signature,
  ]);
}

/**
 * Log out and invalidate the session.
 */
export async function logout(account: Etebase.Account): Promise<void> {
  await account.logout();
}
