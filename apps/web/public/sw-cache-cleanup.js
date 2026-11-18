// Remove entries left by earlier workers when the network-only routes take over.
self.addEventListener('activate', (event) => {
  // Storage errors must still allow the updated worker to activate.
  event.waitUntil(caches.delete('cross-origin').catch(() => {}))
})
