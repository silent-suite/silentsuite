import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'SilentSuite Docs',
  description: 'Documentation for SilentSuite — end-to-end encrypted calendar, contacts & tasks.',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
    ['meta', { name: 'theme-color', content: '#0a1018' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'SilentSuite Docs' }],
    ['meta', { property: 'og:description', content: 'Documentation for SilentSuite — end-to-end encrypted calendar, contacts & tasks.' }],
    ['meta', { property: 'og:url', content: 'https://docs.silentsuite.io' }],
  ],

  cleanUrls: true,

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'SilentSuite',

    nav: [
      { text: 'User Guide', link: '/user-guide/getting-started', activeMatch: '/user-guide/' },
      { text: 'Self-Hosting', link: '/self-hosting/quick-start', activeMatch: '/self-hosting/' },
      { text: 'Contributing', link: '/contributing/dev-setup', activeMatch: '/contributing/' },
      { text: 'silentsuite.io', link: 'https://silentsuite.io' },
    ],

    sidebar: {
      '/user-guide/': [
        {
          text: 'User Guide',
          items: [
            { text: 'Getting Started', link: '/user-guide/getting-started' },
            { text: 'Calendar', link: '/user-guide/calendar' },
            { text: 'Contacts', link: '/user-guide/contacts' },
            { text: 'Tasks', link: '/user-guide/tasks' },
            { text: 'How Encryption Works', link: '/user-guide/encryption-explained' },
            { text: 'FAQ', link: '/user-guide/faq' },
          ],
        },
        {
          text: 'Apps & Integrations',
          items: [
            { text: 'Overview', link: '/user-guide/apps/' },
            { text: 'Android', link: '/user-guide/apps/android' },
            { text: 'iOS (EteSync)', link: '/user-guide/apps/ios' },
            { text: 'Tasks.org', link: '/user-guide/apps/tasks-org' },
            { text: 'GNOME Evolution', link: '/user-guide/apps/evolution' },
            { text: 'KDE Kontact', link: '/user-guide/apps/kde' },
          ],
        },
        {
          text: 'DAV Bridge Apps',
          items: [
            { text: 'DAV Bridge Setup', link: '/user-guide/apps/dav-bridge' },
            { text: 'Thunderbird', link: '/user-guide/apps/thunderbird' },
            { text: 'macOS', link: '/user-guide/apps/macos' },
            { text: 'Windows', link: '/user-guide/apps/windows' },
          ],
        },
      ],
      '/self-hosting/': [
        {
          text: 'Self-Hosting',
          items: [
            { text: 'Overview', link: '/self-hosting/' },
            { text: 'Requirements', link: '/self-hosting/requirements' },
            { text: 'Quick Start', link: '/self-hosting/quick-start' },
            { text: 'Manual Setup', link: '/self-hosting/manual-setup' },
            { text: 'Configuration', link: '/self-hosting/configuration' },
            { text: 'Admin Dashboard', link: '/self-hosting/admin-dashboard' },
          ],
        },
        {
          text: 'Operations',
          items: [
            { text: 'Updating', link: '/self-hosting/updating' },
            { text: 'Backup & Restore', link: '/self-hosting/backup-and-restore' },
            { text: 'Architecture', link: '/self-hosting/architecture' },
            { text: 'Troubleshooting', link: '/self-hosting/troubleshooting' },
            { text: 'Uninstalling', link: '/self-hosting/uninstalling' },
          ],
        },
      ],
      '/contributing/': [
        {
          text: 'Contributing',
          items: [
            { text: 'Development Setup', link: '/contributing/dev-setup' },
            { text: 'Architecture Overview', link: '/contributing/architecture-overview' },
            { text: 'Code Conventions', link: '/contributing/code-conventions' },
            { text: 'Testing', link: '/contributing/testing' },
            { text: 'Pull Request Guide', link: '/contributing/pull-request-guide' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/silentsuite/silentsuite' },
    ],

    editLink: {
      pattern: 'https://github.com/silentsuite/silentsuite/edit/main/apps/docs/:path',
      text: 'Edit this page on GitHub',
    },

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Released under the AGPL-3.0 License.',
      copyright: `Copyright © ${new Date().getFullYear()} SilentSuite`,
    },
  },
})
