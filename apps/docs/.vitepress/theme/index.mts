import DefaultTheme from 'vitepress/theme'
import { useRouter, type EnhanceAppContext } from 'vitepress'
import { defineComponent, h, onMounted, onUnmounted } from 'vue'
import AppLogoStrip from './components/AppLogoStrip.vue'
import { classifyDocsOutboundEvent, createDocsPageviewTracker } from './public-analytics.mts'
import './custom.css'

declare const __SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__: string

function sendDocsEvent(event: ReturnType<typeof classifyDocsOutboundEvent>) {
  if (!event) return
  const payload = JSON.stringify({
    domain: 'docs.silentsuite.io',
    name: event.event,
    url: 'https://docs.silentsuite.io/',
    props: event.props,
  })
  if (navigator.sendBeacon) {
    navigator.sendBeacon(__SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__, new Blob([payload], { type: 'application/json' }))
    return
  }
  void fetch(__SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  })
}

function sendDocsPageview(path: string) {
  const payload = JSON.stringify({
    domain: 'docs.silentsuite.io',
    name: 'pageview',
    url: `https://docs.silentsuite.io${path}`,
  })
  if (navigator.sendBeacon) {
    navigator.sendBeacon(__SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__, new Blob([payload], { type: 'application/json' }))
    return
  }
  void fetch(__SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true,
  })
}

export default {
  ...DefaultTheme,
  enhanceApp(context: EnhanceAppContext) {
    DefaultTheme.enhanceApp?.(context)
    context.app.component('AppLogoStrip', AppLogoStrip)
  },
  Layout: defineComponent({
    setup() {
      const router = useRouter()
      const trackPageview = createDocsPageviewTracker((path) => sendDocsPageview(path))
      let previousAfterRouteChanged: typeof router.onAfterRouteChanged | undefined
      const handleClick = (event: MouseEvent) => {
        if (!__SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__ || window.location.hostname !== 'docs.silentsuite.io') return
        const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
        const analyticsEvent = anchor ? classifyDocsOutboundEvent(anchor.getAttribute('href') ?? '', window.location.pathname) : undefined
        sendDocsEvent(analyticsEvent)
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
