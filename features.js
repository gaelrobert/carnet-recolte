/* Step 2: each saved photo is described by DINOv2 on the phone, in the background.
   Only the description (768 numbers) is stored, next to the photo. Nothing is sent anywhere. */
import * as store from './store.js';

export const FEATURE_TAG = 'dinov2-small-q8/224/centre-square/v1';
export const INPUT_SIZE = 224;
export const DOWNLOAD_MB = 36;
export const MAX_ATTEMPTS = 3;
const SETTING = 'analysis';
// A tiny WebAssembly program using SIMD, which the analysis engine needs (iOS 16.4 and later, recent Android browsers).
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

const listeners = new Set();
const status = {
  enabled: readSetting(), phase: 'off', loaded: 0, total: 0, pending: null, failed: 0, ms: null,
  attempt: 0, step: null, error: null,
};
const waiting = new Map();
const failed = new Set();
let worker = null;
let retryTimer = null;
let draining = false;
let again = false;
let nextRequest = 1;

function readSetting() {
  try { return localStorage.getItem(SETTING) === 'on'; } catch (_) { return false; }
}

function update(changes) {
  Object.assign(status, changes);
  listeners.forEach((listener) => listener({ ...status }));
}

export const getStatus = () => ({ ...status });

export function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function enable() {
  try { localStorage.setItem(SETTING, 'on'); } catch (_) { /* the choice then lasts until the app closes */ }
  update({ enabled: true });
  start();
}

function supported() {
  try {
    return typeof Worker === 'function' && typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE);
  } catch (_) {
    return false;
  }
}

export function start() {
  if (!status.enabled || worker || retryTimer) return;
  if (!supported()) {
    update({ phase: 'unsupported' });
    return;
  }
  launch(1);
}

function launch(attempt) {
  update({ phase: 'loading', loaded: 0, total: 0, attempt, step: null, error: null });
  worker = new Worker('feature-worker.js');
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') update({ loaded: data.loaded, total: data.total });
    else if (data.type === 'ready') { update({ phase: 'ready' }); analyseSoon(); }
    else if (data.type === 'vector') settle(data.id, null, data);
    else if (data.type === 'error' && data.id) settle(data.id, new Error(data.message));
    else if (data.type === 'error') stop(data.message, data.step);
  };
  // A worker that closes without a message usually ran out of memory.
  worker.onerror = (event) => { event.preventDefault?.(); stop(event.message || 'the analysis engine closed', 'engine'); };
  worker.postMessage({ type: 'init' });
}

export function retry() {
  if (status.phase === 'error') start();
}

/* Runs now, or once the farmer is back in the app: phones pause hidden pages. */
function whenVisible(run) {
  if (document.visibilityState !== 'hidden') {
    run();
    return;
  }
  const back = () => {
    if (document.visibilityState === 'hidden') return;
    document.removeEventListener('visibilitychange', back);
    run();
  };
  document.addEventListener('visibilitychange', back);
}

function stop(message, step = 'engine') {
  console.error('Photo analysis stopped:', step, message);
  const attempt = status.attempt;
  const wasLoading = status.phase === 'loading';
  worker?.terminate();
  worker = null;
  for (const entry of waiting.values()) entry.reject(new Error(message));
  waiting.clear();
  if (wasLoading && step === 'download' && attempt < MAX_ATTEMPTS) {
    // A cut connection is tried again by itself, a little later each time.
    update({ phase: 'loading', loaded: 0, total: 0, attempt: attempt + 1, step, error: message });
    retryTimer = setTimeout(() => whenVisible(() => {
      retryTimer = null;
      launch(attempt + 1);
    }), attempt * 4000);
    return;
  }
  update({ phase: 'error', step, error: message });
}

function settle(id, error, data) {
  const entry = waiting.get(id);
  if (!entry) return;
  waiting.delete(id);
  if (error) entry.reject(error);
  else entry.resolve(data);
}

function draw(source, x, y, side, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: size === INPUT_SIZE });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, x, y, side, side, 0, 0, size, size);
  return canvas;
}

/* The centre square of the photo, halved step by step so every browser smooths it the same way. */
export async function photoPixels(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    let side = Math.min(bitmap.width, bitmap.height);
    let source = bitmap;
    let x = Math.floor((bitmap.width - side) / 2);
    let y = Math.floor((bitmap.height - side) / 2);
    while (side >= INPUT_SIZE * 2) {
      const half = Math.round(side / 2);
      source = draw(source, x, y, side, half);
      x = 0;
      y = 0;
      side = half;
    }
    return draw(source, x, y, side, INPUT_SIZE).getContext('2d').getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
  } finally {
    bitmap.close?.();
  }
}

/* Resolves with { vector, ms } once the model is ready. */
export async function describeBlob(blob) {
  if (status.phase !== 'ready' || !worker) throw new Error('analysis is not ready');
  const pixels = await photoPixels(blob);
  return new Promise((resolve, reject) => {
    const id = nextRequest;
    nextRequest += 1;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ type: 'describe', id, pixels, side: INPUT_SIZE }, [pixels.buffer]);
  });
}

/* Called after each new photo and when the model becomes ready. */
export function analyseSoon() {
  if (status.phase !== 'ready') return;
  if (draining) { again = true; return; }
  drain();
}

async function drain() {
  draining = true;
  try {
    do {
      again = false;
      const queue = (await store.photosWithoutFeature(FEATURE_TAG)).filter((photo) => !failed.has(photo.id));
      update({ pending: queue.length });
      for (const photo of queue) {
        if (status.phase !== 'ready') return;
        try {
          const blob = await store.getImage(photo.id);
          if (!blob) throw new Error('photo missing');
          const { vector, ms } = await describeBlob(blob);
          await store.putFeature({ id: photo.id, tag: FEATURE_TAG, vector });
          update({ pending: status.pending - 1, ms });
        } catch (error) {
          if (status.phase !== 'ready') return;
          console.error('Photo not analysed:', photo.id, error);
          failed.add(photo.id);
          update({ pending: status.pending - 1, failed: failed.size });
        }
      }
    } while (again);
  } catch (error) {
    console.error('Photo analysis paused:', error);
  } finally {
    draining = false;
  }
}
