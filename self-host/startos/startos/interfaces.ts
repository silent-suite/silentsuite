import { i18n } from './i18n'
import { sdk } from './sdk'
import { hostId, interfaceId, routerPort } from './utils'

export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
  const multi = sdk.MultiHost.of(effects, hostId)
  // StartOS adds a TLS leg; the router redirects or refuses the plaintext leg.
  const origin = await multi.bindPort(routerPort, { protocol: 'http' })

  const ui = sdk.createInterface(effects, {
    name: i18n('Web app and sync address'),
    id: interfaceId,
    description: i18n(
      'Open SilentSuite in the browser. Use the same https address as the server address in the SilentSuite apps.',
    ),
    type: 'ui',
    masked: false,
    schemeOverride: null,
    username: null,
    path: '',
    query: {},
  })

  return [await origin.export([ui])]
})
