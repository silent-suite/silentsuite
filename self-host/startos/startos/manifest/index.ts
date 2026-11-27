import { setupManifest } from '@start9labs/start-sdk'
import { long, short } from './i18n'

// Released SilentSuite images, pinned by tag and multi-arch index digest. The tag
// must equal `v<upstream version>` from versions/current.ts; see UPDATING.md.
export const serverImage =
  'ghcr.io/silent-suite/silentsuite-server:v0.5.20-beta@sha256:6a5ab47d21feeed4fc05379258e8c2686e1fa67138dbd6570900eea732b0c7bb'
export const webImage =
  'ghcr.io/silent-suite/silentsuite-web-selfhost:v0.5.20-beta@sha256:5156f5d9b67db5c7a6dcdf51c603b104e4c3ec6e2789ad2a6552431fd66e8088'
export const postgresImage =
  'postgres:16.16-alpine@sha256:81e77a4833487b8132fe4b00bedd39dc3f74b8641e387f19312a48f7de218c2e'
export const routerImage =
  'nginxinc/nginx-unprivileged:1.30.6-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03'

export const manifest = setupManifest({
  id: 'silentsuite',
  title: 'SilentSuite',
  license: 'AGPL-3.0-only',
  packageRepo: 'https://github.com/silent-suite/silentsuite',
  upstreamRepo: 'https://github.com/silent-suite/silentsuite',
  marketingUrl: 'https://silentsuite.io',
  donationUrl: null,
  description: { short, long },
  volumes: ['startos', 'server', 'config', 'db'],
  images: {
    server: {
      source: { dockerTag: serverImage },
      arch: ['x86_64', 'aarch64'],
    },
    web: {
      source: { dockerTag: webImage },
      arch: ['x86_64', 'aarch64'],
    },
    postgres: {
      source: { dockerTag: postgresImage },
      arch: ['x86_64', 'aarch64'],
    },
    router: {
      source: { dockerTag: routerImage },
      arch: ['x86_64', 'aarch64'],
    },
  },
  hardwareRequirements: {
    ram: 1024 ** 3,
  },
})
