import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.5.20-beta:0',
  releaseNotes: {
    en_US: 'First StartOS package of SilentSuite.',
    es_ES: 'Primer paquete de SilentSuite para StartOS.',
    de_DE: 'Erstes StartOS-Paket von SilentSuite.',
    pl_PL: 'Pierwszy pakiet SilentSuite dla StartOS.',
    fr_FR: 'Premier paquet SilentSuite pour StartOS.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
