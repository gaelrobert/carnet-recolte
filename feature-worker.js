/* Describes photos with DINOv2, off the main thread. Photos and descriptions never leave the phone. */
importScripts('vendor/ort.wasm.min.js');

ort.env.wasm.wasmPaths = new URL('vendor/', self.location.href).href;
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, self.navigator.hardwareConcurrency || 2)
  : 1;

const MODEL = 'model/dinov2-small/model_quantized.onnx';
const MODEL_BYTES = 24427763;
const MODEL_CACHE = 'carnet-recolte-model-v1';
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
let session;

/* Errors say which step failed, so the app can tell a cut connection from a phone that cannot run the model. */
class StepError extends Error {
  constructor(step, error) {
    super(String((error && error.message) || error));
    this.step = step;
  }
}

/* Servers such as GitHub Pages compress the download, so its announced length is smaller than
   the file. The pieces are collected as they come, and progress uses the known file size. */
async function download(url, expected) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const announced = Number(response.headers.get('content-length')) || 0;
  const total = (!response.headers.get('content-encoding') && announced) || expected;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    self.postMessage({ type: 'progress', loaded: Math.min(loaded, total), total });
  }
  const data = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}

async function forgetSavedModel() {
  try {
    await (await caches.open(MODEL_CACHE)).delete(MODEL, { ignoreSearch: true });
  } catch (_) { /* nothing saved, or no storage: the next try downloads anyway */ }
}

async function init() {
  let model;
  try {
    model = await download(MODEL, MODEL_BYTES);
  } catch (error) {
    throw new StepError('download', error);
  }
  if (model.length !== MODEL_BYTES) {
    await forgetSavedModel();
    throw new StepError('download', `incomplete model (${model.length} of ${MODEL_BYTES} bytes)`);
  }
  self.postMessage({ type: 'progress', loaded: 0, total: 0 }); // downloaded: now preparing
  try {
    session = await ort.InferenceSession.create(model, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  } catch (error) {
    // The engine file is fetched here, so a cut connection can still show up at this step.
    const network = /fetch|network|load failed|connection|aborted/i.test(String(error && error.message));
    throw new StepError(network ? 'download' : 'engine', error);
  }
  self.postMessage({ type: 'ready' });
}

function normalise(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const length = Math.sqrt(sum) || 1;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= length;
  return vector;
}

/* Same description as the training scripts: the class token and the mean of the patch tokens. */
async function describe(pixels, side) {
  const input = new Float32Array(3 * side * side);
  for (let i = 0, n = side * side; i < n; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      input[c * n + i] = (pixels[i * 4 + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  const started = performance.now();
  const output = await session.run({ pixel_values: new ort.Tensor('float32', input, [1, 3, side, side]) });
  const tensor = output.last_hidden_state;
  const [, count, size] = tensor.dims;
  const tokens = tensor.data;
  const cls = normalise(Float32Array.from(tokens.subarray(0, size)));
  const patch = new Float32Array(size);
  for (let t = 1; t < count; t += 1) {
    for (let i = 0; i < size; i += 1) patch[i] += tokens[t * size + i];
  }
  normalise(patch);
  const vector = new Float32Array(size * 2);
  vector.set(cls);
  vector.set(patch, size);
  return { vector: normalise(vector), ms: Math.round(performance.now() - started) };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') await init();
    if (data.type === 'describe') {
      const { vector, ms } = await describe(data.pixels, data.side);
      self.postMessage({ type: 'vector', id: data.id, vector, ms }, [vector.buffer]);
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: data.id ?? null,
      step: error.step || (data.type === 'init' ? 'engine' : 'photo'),
      message: String((error && error.message) || error),
    });
  }
};
