/* God's Eye View service worker — makes the app installable and gives it an
 * offline shell and instant repeat loads, WITHOUT ever caching live data.
 *
 * Safety rules (see strategyFor):
 *   - Non-GET, cross-origin (map tiles, external feeds), and /api/* (the
 *     key-brokering proxies and live feeds) are always passed straight to the
 *     network — never cached.
 *   - Navigation (the HTML document) is network-first so updates land, with the
 *     last good shell served when offline.
 *   - Same-origin static assets (JS/CSS/fonts/icons/wasm) are
 *     stale-while-revalidate: served from cache instantly, refreshed in the
 *     background.
 *
 * The strategy is a pure function so it can be unit-tested (src/pwa/sw.test.mjs
 * extracts and exercises it from this file — keep it self-contained).
 */

var CACHE = 'gev-shell-v2';

function strategyFor(req, selfOrigin) {
  if (req.method !== 'GET') return 'passthrough';
  var url = new URL(req.url);
  if (url.origin !== selfOrigin) return 'passthrough';
  if (url.pathname.indexOf('/api/') === 0) return 'passthrough';
  // Vite dev-server internals, if the SW is ever active in dev.
  if (
    url.pathname.indexOf('/@') === 0 ||
    url.pathname.indexOf('/node_modules/') === 0
  )
    return 'passthrough';
  if (req.mode === 'navigate' || req.destination === 'document')
    return 'navigate';
  return 'asset';
}

// Share this file's one true origin check with the test.
if (typeof self !== 'undefined' && self.addEventListener) {
  self.addEventListener('install', function () {
    // A fresh worker is ready immediately; it still only takes control on the
    // next navigation unless a client asks it to skip waiting.
    self.skipWaiting();
  });

  self.addEventListener('activate', function (event) {
    event.waitUntil(
      caches
        .keys()
        .then(function (keys) {
          return Promise.all(
            keys.map(function (key) {
              if (key !== CACHE) return caches.delete(key);
              return undefined;
            }),
          );
        })
        .then(function () {
          return self.clients.claim();
        }),
    );
  });

  self.addEventListener('message', function (event) {
    if (event.data === 'skipWaiting') self.skipWaiting();
  });

  self.addEventListener('fetch', function (event) {
    var strategy = strategyFor(event.request, self.location.origin);
    if (strategy === 'passthrough') return; // default browser handling

    if (strategy === 'navigate') {
      event.respondWith(
        fetch(event.request)
          .then(function (response) {
            if (response && response.ok) {
              var copy = response.clone();
              caches.open(CACHE).then(function (cache) {
                cache.put(event.request, copy);
              });
            }
            return response;
          })
          .catch(function () {
            return caches.match(event.request).then(function (cached) {
              return cached || caches.match('/');
            });
          }),
      );
      return;
    }

    // asset: stale-while-revalidate.
    event.respondWith(
      caches.open(CACHE).then(function (cache) {
        return cache.match(event.request).then(function (cached) {
          var network = fetch(event.request)
            .then(function (response) {
              if (response && response.ok && response.type === 'basic') {
                cache.put(event.request, response.clone());
              }
              return response;
            })
            .catch(function () {
              return cached;
            });
          return cached || network;
        });
      }),
    );
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { strategyFor: strategyFor, CACHE: CACHE };
}
