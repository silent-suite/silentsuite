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

/**
 * Create a new Etebase account (sign up).
 */
export async function signUp(
  serverUrl: string,
  email: string,
  password: string,
): Promise<Etebase.Account> {
  const account = await Etebase.Account.signup(
    { username: email, email },
    password,
    serverUrl,
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
 * Change the account password.
 */
export async function changePassword(
  account: Etebase.Account,
  newPassword: string,
): Promise<void> {
  await account.changePassword(newPassword);
}

/**
 * Log out and invalidate the session.
 */
export async function logout(account: Etebase.Account): Promise<void> {
  await account.logout();
}
