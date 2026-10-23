import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercises the real etebase SDK (key derivation, crypto, Msgpack, URL building and
// its browser XMLHttpRequest transport) against an in-memory test server. The fake
// XMLHttpRequest exists only in this test; the SDK picks its XHR transport at module
// load, so it is installed before the SDK is imported.

const require = createRequire(import.meta.url);

const REGISTRATION_HEADER = 'x-silentsuite-registration-token';
const SYNTHETIC_TOKEN = 'synthetic-owner-registration-token-not-a-secret';
const SERVER_URL = 'https://umbrel.test.invalid/';
const PASSWORD = 'synthetic-password-for-tests';

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | undefined;
}

type Codec = { msgpackEncode: (v: unknown) => Uint8Array; msgpackDecode: (v: ArrayLike<number>) => any };

const requests: RecordedRequest[] = [];
let codec: Codec;
let signupBody: any;
let loginChallengeStatus = 200;

function respond(req: RecordedRequest): { status: number; body: Uint8Array } {
  const path = new URL(req.url).pathname;
  const user = () => ({
    username: signupBody.user.username,
    email: signupBody.user.email,
    pubkey: signupBody.pubkey,
    encryptedContent: signupBody.encryptedContent,
  });
  switch (path) {
    case '/api/v1/authentication/signup/':
      signupBody = codec.msgpackDecode(req.body!);
      return { status: 201, body: codec.msgpackEncode({ token: 'synthetic-auth-token', user: user() }) };
    case '/api/v1/authentication/login_challenge/':
      if (loginChallengeStatus === 401) {
        return { status: 401, body: codec.msgpackEncode({ code: 'user_not_init', detail: 'User not properly init' }) };
      }
      return {
        status: 200,
        body: codec.msgpackEncode({ salt: signupBody.salt, challenge: new Uint8Array(32), version: 1 }),
      };
    case '/api/v1/authentication/login/':
      return { status: 200, body: codec.msgpackEncode({ token: 'synthetic-auth-token-2', user: user() }) };
    case '/api/v1/authentication/change_password/':
    case '/api/v1/authentication/logout/':
      return { status: 204, body: new Uint8Array() };
    case '/api/v1/authentication/dashboard_url/':
      return { status: 200, body: codec.msgpackEncode({ url: 'https://umbrel.test.invalid/dashboard/' }) };
    default:
      return { status: 404, body: codec.msgpackEncode({ detail: 'not found' }) };
  }
}

class FakeXMLHttpRequest {
  responseType = '';
  status = 0;
  statusText = '';
  response: ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private method = '';
  private url = '';
  private headers: Record<string, string> = {};

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }

  send(body?: Uint8Array) {
    const recorded = { method: this.method, url: this.url, headers: this.headers, body };
    requests.push(recorded);
    const result = respond(recorded);
    this.status = result.status;
    this.response = result.body.slice().buffer;
    queueMicrotask(() => this.onload?.());
  }
}

let Etebase: typeof import('etebase');
let core: typeof import('./client.js');

beforeAll(async () => {
  vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
  Etebase = await import('etebase');
  core = await import('./client.js');
  codec = require('etebase/dist/lib-cjs/Helpers.js');
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  requests.length = 0;
  signupBody = undefined;
  loginChallengeStatus = 200;
});

function requestsTo(suffix: string) {
  return requests.filter((r) => new URL(r.url).pathname.endsWith(suffix));
}

function expectNoTokenAnywhereExceptSignupHeader() {
  for (const r of requests) {
    expect(r.url).not.toContain(SYNTHETIC_TOKEN);
    if (r.body) expect(Buffer.from(r.body).toString('latin1')).not.toContain(SYNTHETIC_TOKEN);
    const isSignup = new URL(r.url).pathname === '/api/v1/authentication/signup/';
    if (!isSignup) expect(r.headers[REGISTRATION_HEADER]).toBeUndefined();
  }
}

describe('SDK entry used by the shipped web build', () => {
  it('resolves to the CommonJS main entry that this suite exercises', () => {
    // apps/web/next.config.js aliases `etebase` to require.resolve('etebase').
    const resolved = require.resolve('etebase');
    expect(resolved).toMatch(/etebase[/\\]dist[/\\]lib-cjs[/\\]Etebase\.js$/);
    expect(require('etebase').Account).toBe(Etebase.Account);
  });
});

describe('signup-scoped registration token through the real SDK transport', () => {
  it('sends the token only as a header on the signup POST via XMLHttpRequest', async () => {
    const account = await Etebase.Account.signup(
      { username: 'synthetic-user', email: 'synthetic@example.invalid' },
      PASSWORD,
      SERVER_URL,
      { registrationToken: SYNTHETIC_TOKEN },
    );

    const signups = requestsTo('/authentication/signup/');
    expect(signups).toHaveLength(1);
    expect(signups[0].method).toBe('POST');
    expect(signups[0].url).toBe('https://umbrel.test.invalid/api/v1/authentication/signup/');
    expect(signups[0].headers[REGISTRATION_HEADER]).toBe(SYNTHETIC_TOKEN);
    expect(signups[0].headers['content-type']).toBe('application/msgpack');
    // Client-generated key material still reaches the server unchanged in shape.
    expect(signupBody.salt).toHaveLength(32);
    expect(signupBody.loginPubkey).toHaveLength(32);
    expect(signupBody.pubkey).toHaveLength(32);
    expect(Object.keys(signupBody).sort()).toEqual(['encryptedContent', 'loginPubkey', 'pubkey', 'salt', 'user']);
    expect(account.serverUrl).toBe(SERVER_URL);
    expectNoTokenAnywhereExceptSignupHeader();
  }, 60_000);

  it('does not retain the token in the account, saved session, or later operations', async () => {
    const account = await core.signUp(SERVER_URL, 'synthetic@example.invalid', PASSWORD, {
      registrationToken: SYNTHETIC_TOKEN,
    });
    expect(requestsTo('/authentication/signup/')[0].headers[REGISTRATION_HEADER]).toBe(SYNTHETIC_TOKEN);

    expect(JSON.stringify(Object.entries(account))).not.toContain(SYNTHETIC_TOKEN);
    const saved = await core.saveSession(account);
    expect(Buffer.from(saved, 'base64').toString('latin1')).not.toContain(SYNTHETIC_TOKEN);

    const restored = await core.restoreSession(SERVER_URL, saved);
    expect(restored.serverUrl).toBe(SERVER_URL);
    await restored.getDashboardUrl();
    await core.changePassword(restored, `${PASSWORD}-changed`);
    await core.logIn(SERVER_URL, 'synthetic@example.invalid', `${PASSWORD}-changed`);
    await core.logout(restored);
    await new Promise((resolve) => setTimeout(resolve, 0));

    for (const suffix of ['/dashboard_url/', '/change_password/', '/login_challenge/', '/login/', '/logout/']) {
      expect(requestsTo(suffix).length).toBeGreaterThan(0);
    }
    expect(requestsTo('/authentication/signup/')).toHaveLength(1);
    expectNoTokenAnywhereExceptSignupHeader();
  }, 120_000);

  it('keeps existing signup calls without the option unchanged', async () => {
    await core.signUp(SERVER_URL, 'synthetic@example.invalid', PASSWORD);
    const signups = requestsTo('/authentication/signup/');
    expect(signups).toHaveLength(1);
    expect(signups[0].headers).toEqual({ accept: 'application/msgpack', 'content-type': 'application/msgpack' });
  }, 60_000);

  it('never forwards a token through the SDK login-to-signup fallback', async () => {
    loginChallengeStatus = 401;
    await core.logIn(SERVER_URL, 'synthetic@example.invalid', PASSWORD);
    const signups = requestsTo('/authentication/signup/');
    expect(signups).toHaveLength(1);
    expect(signups[0].headers[REGISTRATION_HEADER]).toBeUndefined();
  }, 60_000);

  it.each([
    ['an empty string', ''],
    ['a value with a line break', 'synthetic\r\nX-Injected: 1'],
    ['a value with spaces', 'synthetic token'],
    ['a non-ASCII value', 'synthetic-tökén'],
    ['an overlong value', 'a'.repeat(513)],
    ['a non-string value', 12345 as unknown as string],
  ])('rejects %s before any network request without echoing it', async (_label, value) => {
    const attempt = core.signUp(SERVER_URL, 'synthetic@example.invalid', PASSWORD, { registrationToken: value });
    await expect(attempt).rejects.toThrow('Invalid registration token');
    await attempt.catch((error: Error) => {
      if (String(value).length > 0) expect(error.message).not.toContain(String(value));
    });
    expect(requests).toHaveLength(0);
  });
});
