const CACHE_NAME = 'songfa-v12'
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/logo.png'
]

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS_TO_CACHE)
    })
  )
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    })
  )
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  // Only intercept GET requests
  if (event.request.method !== 'GET') return

  const url = new URL(event.request.url)

  // API calls: Network first, fallback to cache (if we eventually cache data)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    )
    return
  }

  // Static assets: Cache first, fallback to network
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) {
        // Stale-while-revalidate for assets
        fetch(event.request).then(netResponse => {
          if (netResponse && netResponse.status === 200) {
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, netResponse)
            })
          }
        }).catch(() => {})
        return cachedResponse
      }
      return fetch(event.request)
    })
  )
})
