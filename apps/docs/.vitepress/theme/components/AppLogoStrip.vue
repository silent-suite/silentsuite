<script setup lang="ts">
const props = withDefaults(defineProps<{ compact?: boolean }>(), {
  compact: false,
})

const apps = [
  {
    name: 'SilentSuite',
    logo: '/logo.svg',
    href: 'https://silentsuite.io/',
  },
  {
    name: 'Tasks.org',
    logo: '/app-logos/tasks-org.svg',
    href: 'https://tasks.org/',
  },
  {
    name: 'Evolution',
    logo: '/app-logos/evolution.svg',
    href: 'https://help.gnome.org/evolution/index.html',
  },
  {
    name: 'GNOME Calendar',
    logo: '/app-logos/gnome-calendar.svg',
    href: 'https://apps.gnome.org/Calendar/',
  },
  {
    name: 'GNOME Contacts',
    logo: '/app-logos/gnome-contacts.svg',
    href: 'https://apps.gnome.org/Contacts/',
  },
  {
    name: 'KDE Kontact',
    logo: '/app-logos/kontact.svg',
    href: 'https://kontact.kde.org/',
  },
  {
    name: 'Thunderbird',
    logo: '/app-logos/thunderbird.png',
    href: 'https://www.thunderbird.net/',
  },
  {
    name: 'Apple Calendar',
    logo: '/app-logos/apple-calendar.png',
    href: 'https://support.apple.com/guide/calendar/welcome/mac',
  },
  {
    name: 'Apple Contacts',
    logo: '/app-logos/apple-contacts.png',
    href: 'https://support.apple.com/guide/contacts/welcome/mac',
  },
  {
    name: 'Microsoft Outlook',
    logo: '/app-logos/outlook.svg',
    href: 'https://www.microsoft.com/en-us/microsoft-365/outlook/outlook-for-windows',
  },
] as const
</script>

<template>
  <nav class="app-logo-strip" :class="{ 'is-compact': props.compact }" aria-label="Official app sites">
    <a
      v-for="app in apps"
      :key="app.name"
      class="app-logo-card"
      :href="app.href"
      rel="noreferrer"
      :aria-label="`${app.name} official site`"
    >
      <span class="app-logo-frame" aria-hidden="true">
        <img :src="app.logo" alt="" width="48" height="48" loading="lazy" decoding="async">
      </span>
      <span class="app-logo-name">{{ app.name }}</span>
      <span class="app-logo-external" aria-hidden="true">↗</span>
    </a>
  </nav>
</template>

<style scoped>
.app-logo-strip {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 24px 0;
}

.app-logo-card {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 116px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 14px 10px 12px;
  color: var(--vp-c-text-1);
  text-align: center;
  text-decoration: none !important;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
}

.app-logo-card:hover {
  border-color: var(--vp-c-brand-2);
  box-shadow: 0 8px 24px rgba(10, 16, 24, 0.09);
  transform: translateY(-2px);
}

.app-logo-card:focus-visible {
  outline: 3px solid var(--vp-c-brand-2);
  outline-offset: 3px;
}

.app-logo-frame {
  display: grid;
  width: 58px;
  height: 58px;
  place-items: center;
  overflow: hidden;
  background: #ffffff;
  border: 1px solid rgba(10, 16, 24, 0.09);
  border-radius: 14px;
}

.app-logo-frame img {
  display: block;
  width: 48px;
  height: 48px;
  object-fit: contain;
}

.app-logo-name {
  max-width: 100%;
  font-size: 13px;
  font-weight: 650;
  line-height: 1.25;
}

.app-logo-external {
  position: absolute;
  top: 9px;
  right: 10px;
  color: var(--vp-c-text-3);
  font-size: 12px;
}

@media (min-width: 640px) {
  .app-logo-strip {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (min-width: 960px) {
  .app-logo-strip {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .app-logo-strip.is-compact {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (prefers-reduced-motion: reduce) {
  .app-logo-card {
    transition: none;
  }

  .app-logo-card:hover {
    transform: none;
  }
}
</style>
