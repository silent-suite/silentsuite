import DefaultTheme from 'vitepress/theme'
import { useRouter, type EnhanceAppContext } from 'vitepress'
import { defineComponent, h, onMounted, onUnmounted } from 'vue'
import AppLogoStrip from './components/AppLogoStrip.vue'
import AccessibleHome from './components/AccessibleHome.vue'
import { deliverDocsAnalyticsPayload } from './analytics-transport.mts'
import {
  DOCS_ANALYTICS_DOMAIN,
  DOCS_ANALYTICS_ORIGIN,
  buildDocsPageviewPayload,
  classifyDocsOutboundEvent,
  createDocsPageviewTracker,
} from './public-analytics.mts'
import './custom.css'

declare const __SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__: string

function sendDocsEvent(rawHref: string, docsPath: string) {
  deliverDocsAnalyticsPayload(__SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__, JSON.stringify({
    domain: DOCS_ANALYTICS_DOMAIN,
    name: 'outbound',
    path: docsPath,
    href: rawHref,
  }))
}

function sendDocsPageview(path: string, rawReferrer: string) {
  const pageview = buildDocsPageviewPayload(path, rawReferrer)
  if (!pageview) return
  deliverDocsAnalyticsPayload(__SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__, JSON.stringify(pageview))
}

export default {
  ...DefaultTheme,
  enhanceApp(context: EnhanceAppContext) {
    DefaultTheme.enhanceApp?.(context)
    context.app.component('AppLogoStrip', AppLogoStrip)
    context.app.component('AccessibleHome', AccessibleHome)
  },
  Layout: defineComponent({
    setup() {
      const router = useRouter()
      const trackPageview = createDocsPageviewTracker((path) => sendDocsPageview(path, document.referrer))
      let previousAfterRouteChanged: typeof router.onAfterRouteChanged | undefined
      const handleClick = (event: MouseEvent) => {
        if (!__SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__ || window.location.hostname !== 'docs.silentsuite.io') return
        const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
        if (anchor) {
          const href = anchor.getAttribute('href') ?? ''
          if (classifyDocsOutboundEvent(href, window.location.pathname)) sendDocsEvent(href, window.location.pathname)
        }
      }

      onMounted(() => {
        if (!__SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__ || window.location.protocol !== 'https:' || window.location.hostname !== 'docs.silentsuite.io') return
        trackPageview(window.location.pathname)
        previousAfterRouteChanged = router.onAfterRouteChanged
        router.onAfterRouteChanged = (to) => {
          previousAfterRouteChanged?.(to)
          trackPageview(to)
        }
        document.addEventListener('click', handleClick)
      })
      onUnmounted(() => {
        document.removeEventListener('click', handleClick)
        if (router.onAfterRouteChanged !== previousAfterRouteChanged) router.onAfterRouteChanged = previousAfterRouteChanged
      })
      return () => h(DefaultTheme.Layout!)
    },
  }),
}
