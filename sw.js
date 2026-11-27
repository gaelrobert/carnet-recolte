/* Opens instantly and works with no signal. Photos live in IndexedDB and are never touched here. */
const PREFIX = 'carnet-recolte-';
// v6 removed the recognition check, now in Pomologue: activating it also deletes the model kept
// for that check (carnet-recolte-model-v1, about 36 MB).
const CACHE = `${PREFIX}v6`;
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'i18n.js',
  'store.js',
  'photo.js',
  'zip.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // 'reload' skips the browser's own copies, so an update never mixes old and new files.
  const fresh = SHELL.map((url) => new Request(url, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  // Other apps on the same website (such as Pomologue) share this storage, so only caches with
  // this prefix are ever removed.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(PREFIX) && key !== CACHE)
        .map((key) => caches.delete(key))))
      .catch((error) => console.error('Cache cleanup failed:', error))
      .then(() => self.clients.claim()),
  );
});

async function respond(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  try {
    return await fetch(request);
  } catch (error) {
    if (request.mode === 'navigate') {
      const page = await cache.match('index.html');
      if (page) return page;
    }
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(respond(event.request));
});
