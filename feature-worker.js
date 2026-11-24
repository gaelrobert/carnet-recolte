/* Describes photos with DINOv2, off the main thread. Photos and descriptions never leave the phone. */
importScripts('vendor/ort.wasm.min.js');

ort.env.wasm.wasmPaths = new URL('vendor/', self.location.href).href;
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, self.navigator.hardwareConcurrency || 2)
  : 1;

const MODEL = 'model/dinov2-small/model_quantized.onnx';
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
let session;

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body || !total) return new Uint8Array(await response.arrayBuffer());
  const data = new Uint8Array(total);
  const reader = response.body.getReader();
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    data.set(value, loaded);
    loaded += value.length;
    self.postMessage({ type: 'progress', loaded, total });
  }
  return data.subarray(0, loaded);
}

async function init() {
  const model = await download(MODEL);
  session = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
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
    self.postMessage({ type: 'error', id: data.id ?? null, message: String((error && error.message) || error) });
  }
};
