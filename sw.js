// Offline support for the whole site (every game page registers this file with scope "/").
// On install it saves every game page and the files they share, so after one visit to any page
// all games open without internet. Pages are fetched network first, so a new deploy reaches
// players right away; the saved copy is used when the network is down or too slow.
// Google Fonts are saved the first time they load. Friend games (Firebase), the usage counters
// and the admin page still need the internet; the Firebase SDK is never served from the cache,
// so friend games show an "offline" note instead of hanging.
// Bump VERSION when the list below changes.
const VERSION = 'v4';
const CACHE = 'wpsg-' + VERSION;
const FONTS = 'wpsg-fonts';
const GAMES = ['baseball', 'tennis', 'clay', 'bowling', 'soccer', 'basketball', 'ballboy'];
const PRECACHE = [
  './', 'manifest.webmanifest', 'firebase-config.js', 'track.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
  'baseball/icons/favicon-32.png',
].concat(...GAMES.map(g => [g + '/', g + '/icons/icon.svg', g + '/icons/icon-192.png']));
const NET_WAIT = 4000; // ms to wait for the network before using the saved copy

self.addEventListener('install', e => {
  self.skipWaiting();
  // one file failing (or a slow network) must not stop the rest from being saved
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(PRECACHE.map(p => {
    const url = new URL('/' + p.replace(/^\.\//, ''), location.origin).href;
    return fetch(url, { cache: 'reload' }).then(r => { if (r.ok) return c.put(url, r); }).catch(() => {});
  }))));
});

self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== FONTS).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

function fromCache(req) {
  return caches.open(CACHE).then(c => c.match(req, { ignoreSearch: true }).then(r => {
    if (r || req.mode !== 'navigate') return r;
    // /tennis and /tennis/index.html are the same page as /tennis/
    const u = new URL(req.url);
    let p = u.pathname.replace(/index\.html$/, '');
    if (!p.endsWith('/')) p += '/';
    return c.match(u.origin + p);
  }));
}

function networkFirst(e) {
  const req = e.request;
  // no-cache: ask the server every time (a quick "not changed" answer when nothing changed),
  // so a new deploy shows up on the next visit instead of after the browser's 10 minute cache
  const net = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(r => {
    if (r.redirected && req.mode === 'navigate') return Response.redirect(r.url, 302); // /tennis -> /tennis/
    if (r && r.ok && r.type === 'basic') {
      const copy = r.clone();
      e.waitUntil(caches.open(CACHE).then(c => c.put(req.url.split('#')[0].split('?')[0], copy)));
    }
    return r;
  });
  return new Promise(resolve => {
    let done = false;
    const useCache = () => fromCache(req).then(r => { if (r && !done) { done = true; resolve(r); } return r; });
    const t = setTimeout(useCache, NET_WAIT);
    net.then(r => { clearTimeout(t); if (!done) { done = true; resolve(r); } })
      .catch(() => { clearTimeout(t); useCache().then(r => { if (!done) { done = true; resolve(r || Response.error()); } }); });
  });
}

function fontCacheFirst(e) {
  return caches.open(FONTS).then(c => c.match(e.request).then(hit => {
    const net = fetch(e.request).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(e.request, r.clone()); return r; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net;
  }));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === location.origin) {
    if (u.pathname.startsWith('/admin')) return; // admin stats are live data only
    e.respondWith(networkFirst(e));
  } else if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') {
    e.respondWith(fontCacheFirst(e));
  }
});
