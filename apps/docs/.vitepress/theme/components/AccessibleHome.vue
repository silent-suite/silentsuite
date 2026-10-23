<script setup lang="ts">
import { useData } from 'vitepress'
import { VPHomeContent, VPHomeFeatures, VPHomeHero } from 'vitepress/theme'

const { frontmatter, theme } = useData()
</script>

<template>
  <main class="VPHome" :class="{ 'external-link-icon-enabled': theme.externalLinkIcon }">
    <VPHomeHero />
    <VPHomeFeatures />
    <VPHomeContent v-if="frontmatter.markdownStyles !== false">
      <Content />
    </VPHomeContent>
    <Content v-else />
  </main>
</template>

<style scoped>
.VPHome {
  margin-bottom: 96px;
}

@media (min-width: 768px) {
  .VPHome {
    margin-bottom: 128px;
  }
}
</style>
