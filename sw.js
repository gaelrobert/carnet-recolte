/* Opens instantly and works with no signal. Photos live in IndexedDB and are never touched here. */
const PREFIX = 'carnet-recolte-';
const CACHE = `${PREFIX}v4`;
// The 36 MB model is fetched only when the farmer turns analysis on, then kept across app updates.
const MODEL_CACHE = `${PREFIX}model-v1`;
const LARGE = /\/(vendor\/ort-wasm-simd-threaded\.wasm|model\/dinov2-small\/model_quantized\.onnx)$/;
// Exact sizes, so a download cut short is never kept. Update them if either file changes.
const SIZES = {
  'ort-wasm-simd-threaded.wasm': 11210254,
  'model_quantized.onnx': 24427763,
};
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

const fileName = (url) => new URL(url).pathname.split('/').pop();

self.addEventListener('install', (event) => {
  // 'reload' skips the browser's own copies, so an update never mixes old and new files.
  const fresh = SHELL.map((url) => new Request(url, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(fresh)).then(() => self.skipWaiting()));
});

/* Removes a saved model or engine that is not complete, so it is downloaded again. */
async function dropIncomplete() {
  const cache = await caches.open(MODEL_CACHE);
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    const size = response ? (await response.arrayBuffer()).byteLength : -1;
    if (size !== SIZES[fileName(request.url)]) await cache.delete(request);
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(PREFIX) && key !== CACHE && key !== MODEL_CACHE)
        .map((key) => caches.delete(key))))
      .then(dropIncomplete)
      .catch((error) => console.error('Cache check failed:', error))
      .then(() => self.clients.claim()),
  );
});

async function keepIfComplete(request, response) {
  const body = await response.arrayBuffer();
  if (body.byteLength !== SIZES[fileName(request.url)]) return;
  const cache = await caches.open(MODEL_CACHE);
  await cache.put(request, new Response(body, {
    headers: { 'content-type': response.headers.get('content-type') || 'application/octet-stream' },
  }));
}

/* The large files are kept after a complete download. `kept` ends the service worker's wait. */
async function respondLarge(request, kept) {
  try {
    const hit = await (await caches.open(MODEL_CACHE)).match(request, { ignoreSearch: true });
    if (hit) {
      kept();
      return hit;
    }
    const response = await fetch(request);
    kept(response.ok ? keepIfComplete(request, response.clone()).catch(() => {}) : undefined);
    return response;
  } catch (error) {
    kept();
    throw error;
  }
}

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
  if (LARGE.test(url.pathname)) {
    // waitUntil is called now, while the event is live: Safari refuses it later.
    let kept;
    event.waitUntil(new Promise((resolve) => { kept = resolve; }));
    event.respondWith(respondLarge(event.request, kept));
    return;
  }
  event.respondWith(respond(event.request));
});
