import { secretsFromStore } from './init/initializeService'
import { i18n } from './i18n'
import { sdk } from './sdk'
import {
  discoveryPath,
  httpOk,
  pgdata,
  postgresDb,
  postgresInitdbArgs,
  postgresSub,
  postgresUser,
  routerPort,
  serverPort,
  webPort,
  webReadyPath,
} from './utils'

export const main = sdk.setupMain(async ({ effects }) => {
  console.info(i18n('Starting SilentSuite'))

  // Throws (the service does not start) if the stored secrets are missing or malformed.
  const secrets = await secretsFromStore(effects)

  const pgSub = postgresSub(effects, 'postgres-sub')

  const initSub = sdk.SubContainer.of(
    effects,
    { imageId: 'server' },
    sdk.Mounts.of()
      .mountVolume({
        volumeId: 'server',
        subpath: null,
        mountpoint: '/data',
        readonly: false,
      })
      .mountVolume({
        volumeId: 'config',
        subpath: null,
        mountpoint: '/config',
        readonly: false,
      })
      .mountAssets({ subpath: 'bootstrap', mountpoint: '/bootstrap' }),
    'init-sub',
  )

  const serverSub = sdk.SubContainer.of(
    effects,
    { imageId: 'server' },
    sdk.Mounts.of()
      .mountVolume({
        volumeId: 'server',
        subpath: null,
        mountpoint: '/data',
        readonly: false,
      })
      .mountVolume({
        volumeId: 'config',
        subpath: null,
        mountpoint: '/etc/etebase-server',
        readonly: true,
      })
      .mountAssets({ subpath: 'bootstrap', mountpoint: '/bootstrap' }),
    'server-sub',
  )

  const webSub = sdk.SubContainer.of(
    effects,
    { imageId: 'web' },
    sdk.Mounts.of(),
    'web-sub',
  )

  const routerSub = sdk.SubContainer.of(
    effects,
    { imageId: 'router' },
    sdk.Mounts.of().mountAssets({
      subpath: 'router',
      mountpoint: '/etc/nginx/conf.d',
    }),
    'router-sub',
  )

  return sdk.Daemons.of(effects)
    .addOneshot('pg-recover', {
      subcontainer: pgSub,
      exec: {
        // An unclean stop can strand postmaster.pid, which blocks the next start.
        command: ['rm', '-f', `${pgdata}/postmaster.pid`],
        user: 'root',
      },
      requires: [],
    })
    .addDaemon('postgres', {
      subcontainer: pgSub,
      exec: {
        command: sdk.useEntrypoint(['-c', 'listen_addresses=127.0.0.1']),
        env: {
          POSTGRES_DB: postgresDb,
          POSTGRES_USER: postgresUser,
          POSTGRES_PASSWORD: secrets.dbPassword,
          POSTGRES_INITDB_ARGS: postgresInitdbArgs.join(' '),
          PGDATA: pgdata,
        },
      },
      ready: {
        display: i18n('Database'),
        fn: async () => {
          const { exitCode } = await pgSub.exec([
            'pg_isready',
            '-h',
            '127.0.0.1',
            '-U',
            postgresUser,
            '-d',
            postgresDb,
          ])
          return exitCode === 0
            ? { result: 'success', message: i18n('The database is ready') }
            : { result: 'starting', message: i18n('Waiting for the database') }
        },
      },
      requires: ['pg-recover'],
    })
    .addOneshot('init', {
      subcontainer: initSub,
      exec: {
        // Ownership for the server image's own user and a private INI with the
        // database password. Same script as the Umbrel package, loopback host.
        command: ['/bin/sh', '/bootstrap/init.sh'],
        env: { DATABASE_PASSWORD: secrets.dbPassword },
        user: 'root',
      },
      requires: [],
    })
    .addDaemon('server', {
      subcontainer: serverSub,
      exec: {
        // Package startup wrapper: collectstatic, migrations, then uvicorn with
        // access logging off and umask 077. Runs as the image's own user.
        command: ['/bin/sh', '/bootstrap/server-start.sh'],
        env: {
          ETEBASE_EASY_CONFIG_PATH: '/etc/etebase-server/etebase-server.ini',
          ETEBASE_OWNER_PASSWORD: secrets.ownerPassword,
          ETEBASE_REGISTRATION_TOKEN: secrets.registrationSigning,
          ETEBASE_DISABLE_DJANGO_ADMIN: 'true',
          CORS_ALLOWED_ORIGINS: '',
          // TLS ends at StartOS; the router reaches the server over loopback.
          ETEBASE_SECURE_SSL_REDIRECT: 'false',
          TRUSTED_PROXY_IPS: '127.0.0.1',
        },
      },
      ready: {
        display: i18n('Sync server'),
        gracePeriod: 180_000,
        fn: async () =>
          (await httpOk(`http://127.0.0.1:${serverPort}${discoveryPath}`))
            ? { result: 'success', message: i18n('The sync server is ready') }
            : {
                result: 'starting',
                message: i18n('Waiting for the sync server'),
              },
      },
      requires: ['postgres', 'init'],
    })
    .addDaemon('web', {
      subcontainer: webSub,
      exec: { command: sdk.useEntrypoint() },
      ready: {
        display: i18n('Web app'),
        fn: async () =>
          (await httpOk(`http://127.0.0.1:${webPort}${webReadyPath}`))
            ? { result: 'success', message: i18n('The web app is ready') }
            : { result: 'starting', message: i18n('Waiting for the web app') },
      },
      requires: [],
    })
    .addDaemon('router', {
      subcontainer: routerSub,
      exec: { command: sdk.useEntrypoint() },
      ready: {
        display: i18n('Web interface'),
        fn: async () => {
          // The TLS leg as StartOS forwards it: both the app and sync discovery
          // must answer 200 through the router.
          const tls = { 'X-Forwarded-Proto': 'https' }
          const ok =
            (await httpOk(
              `http://127.0.0.1:${routerPort}${discoveryPath}`,
              tls,
            )) &&
            (await httpOk(`http://127.0.0.1:${routerPort}${webReadyPath}`, tls))
          return ok
            ? { result: 'success', message: i18n('SilentSuite is ready') }
            : { result: 'starting', message: i18n('Waiting for SilentSuite') }
        },
      },
      requires: ['server', 'web'],
    })
})
