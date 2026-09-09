import { beforeEach, expect, it, vi } from 'vitest'
import { useAuthStore } from '../use-auth-store'
import { createElement } from 'react'
import { act, render, screen } from '@testing-library/react'

vi.mock('@/app/lib/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/lib/config')>(),
  BILLING_API_URL: 'https://billing.test',
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search) }))
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }))

const mocks = vi.hoisted(() => ({
  session: null as string | null,
  signup: vi.fn(async () => ({ savedSession: 'encrypted-session', authToken: 'unused' })),
  login: vi.fn(),
  proof: vi.fn(),
}))
vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(async () => mocks.session),
  secureSet: vi.fn(async (_key: string, value: string) => { mocks.session = value }),
  secureRemove: vi.fn(), secureClear: vi.fn(), migrateFromLocalStorage: vi.fn(),
}))
vi.mock('@/app/lib/etebase-auth', () => ({ etebaseSignUp: mocks.signup, etebaseLogIn: mocks.login, issueBillingLinkProof: mocks.proof }))
vi.mock('@/app/lib/self-hosted', () => ({ isSelfHosted: false, isCustomServer: (url?: string) => !!url && url !== 'https://server.silentsuite.io' }))

const email = 'signup@example.test'
const id = '5fd4d86d-34de-4b82-9a66-9598ddf6e02f'
const capability = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const completed = {
  contractVersion: 2, id, email, provisioningStatus: 'trialing_no_card', emailVerified: true,
  earlyAdopter: true, rememberDevice: false, createdAt: '2026-08-11T00:00:00Z',
  clientSecret: null, cryptoCheckoutUrl: null, cryptoInvoiceId: null, cryptoInvoiceLookupToken: null,
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

beforeEach(() => {
  useAuthStore.setState({ pendingSignup: null, user: null, isAuthenticated: false, isLoading: false, error: null, subscriptionStatus: null })
  localStorage.clear(); sessionStorage.clear()
  window.history.replaceState({}, '', '/signup')
  vi.stubGlobal('scrollTo', vi.fn())
  mocks.session = null
  mocks.signup.mockClear(); mocks.login.mockReset().mockResolvedValue({ savedSession: 'encrypted-session', authToken: 'unused' }); mocks.proof.mockReset()
  let sequence = 0
  mocks.proof.mockImplementation(async () => `fresh-proof-${++sequence}`)
  vi.stubGlobal('fetch', vi.fn())
})


import SignupSuccessPage from '../../(auth)/signup/success/page';
it.each(['succeeded','processing'])('review4: Stripe %s discloses undurable completed receipt before exchange and loss', async (status) => {
 const key='silentsuite-signup-redirect-state'; mocks.session='encrypted-session';
 useAuthStore.setState({pendingSignup:{email,paymentSessionToken:capability,paymentSessionRequestKey:id,paymentMethod:'stripe',billingContractVersion:2}});
 useAuthStore.getState().saveSignupStateForRedirect('annual');
 useAuthStore.setState({pendingSignup:null});
 window.history.replaceState({},'',`/signup/success?setup_intent=fixture&redirect_status=${status}`);
 const view=render(createElement(SignupSuccessPage));
 await screen.findByText('Card verified successfully');
 const original=Storage.prototype.setItem; let failReceipt=false;
 const spy=vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(this:Storage,k,v){if(failReceipt&&k===key)throw new Error('quota'); return original.call(this,k,v)});
 let atExchange=false; let warningAtExchange=false;
 vi.mocked(fetch).mockImplementation(async(url)=>{
  const p=new URL(String(url)).pathname;
  if(p.endsWith('/finalize-payment/v2')){failReceipt=true;return json({...completed,provisioningStatus:'active',planId:'early_annual',isAdmin:false})}
  expect(p).toBe('/auth/token-exchange');
  expect(useAuthStore.getState().signupRecoveryDurability).toBe('memory-only');
  expect(useAuthStore.getState().pendingSignup?.provisionedUser?.id).toBe(id);
  expect(sessionStorage.getItem(key)).toBeNull();
  atExchange=true; warningAtExchange=Boolean(screen.queryByText(/Stay in this tab/));
  return json({},503);
 });
 try {
  await act(async()=>{await expect(useAuthStore.getState().finalizePaidSignup()).rejects.toThrow(/session/i)});
  expect(atExchange).toBe(true);
  expect(useAuthStore.getState().signupRecoveryDurability).toBe('memory-only');
  const warningAfterFailure=Boolean(screen.queryByText(/Stay in this tab/));
  view.unmount(); useAuthStore.setState({pendingSignup:null}); mocks.session=null;
  render(createElement(SignupSuccessPage));
  await screen.findByRole('heading',{name:'Session expired'});
  expect(useAuthStore.getState().pendingSignup).toBeNull();
  expect({warningAtExchange,warningAfterFailure}).toEqual({warningAtExchange:true,warningAfterFailure:true});
 } finally {spy.mockRestore()}
});
