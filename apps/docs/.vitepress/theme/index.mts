import DefaultTheme from 'vitepress/theme'
import { defineComponent, h, onMounted, onUnmounted } from 'vue'
import { classifyDocsOutboundEvent } from './public-analytics.mts'
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

export default {
  ...DefaultTheme,
  Layout: defineComponent({
    setup() {
      const handleClick = (event: MouseEvent) => {
        if (!__SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__ || window.location.hostname !== 'docs.silentsuite.io') return
        const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
        const analyticsEvent = anchor ? classifyDocsOutboundEvent(anchor.getAttribute('href') ?? '', window.location.pathname) : undefined
        sendDocsEvent(analyticsEvent)
      }

      onMounted(() => document.addEventListener('click', handleClick))
      onUnmounted(() => document.removeEventListener('click', handleClick))
      return () => h(DefaultTheme.Layout!)
    },
  }),
}
