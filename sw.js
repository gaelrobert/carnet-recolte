/* Opens instantly and works with no signal. Photos live in IndexedDB and are never touched here. */
const PREFIX = 'carnet-recolte-';
const CACHE = `${PREFIX}v3`;
// The 36 MB model is fetched only when the farmer turns analysis on, then kept across app updates.
const MODEL_CACHE = `${PREFIX}model-v1`;
const LARGE = /\/(vendor\/ort-wasm-simd-threaded\.wasm|model\/dinov2-small\/model_quantized\.onnx)$/;
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'i18n.js',
  'store.js',
  'photo.js',
  'zip.js',
  'features.js',
  'selftest.js',
  'feature-worker.js',
  'vendor/ort.wasm.min.js',
  'vendor/ort-wasm-simd-threaded.mjs',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(PREFIX) && key !== CACHE && key !== MODEL_CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function respond(event) {
  const { request } = event;
  const large = LARGE.test(new URL(request.url).pathname);
  const cache = await caches.open(large ? MODEL_CACHE : CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const response = await fetch(request);
    // Kept in the background, so the download progress still reaches the page.
    if (large && response.ok) event.waitUntil(cache.put(request, response.clone()));
    return response;
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
  event.respondWith(respond(event));
});
