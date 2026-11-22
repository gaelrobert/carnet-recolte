/* Redrawing the photo removes its hidden metadata, including any GPS position. */
import { crc32 } from './zip.js';

const MAX_SIDE = 2048;
const THUMB_SIDE = 360;
const CHECK_SIDE = 512;
// Calibrated on 220 real apple photos: no sharp photo fell below BLUR_LIMIT.
const BLUR_LIMIT = 14;
const DARK_LIMIT = 55;
const BRIGHT_LIMIT = 215;
const CLIPPED_LIMIT = 0.3;

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (_) {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function resized(source, width, height, side) {
  const scale = Math.min(1, side / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: side === CHECK_SIDE });
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const toJpeg = (canvas, quality) => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode'))), 'image/jpeg', quality);
});

export function analyse(canvas) {
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
  const grey = new Float32Array(width * height);
  let sum = 0;
  let clipped = 0;
  for (let i = 0; i < grey.length; i += 1) {
    const value = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
    grey[i] = value;
    sum += value;
    if (value < 8 || value > 248) clipped += 1;
  }
  const left = Math.floor(width * 0.2);
  const right = Math.floor(width * 0.8);
  const top = Math.floor(height * 0.2);
  const bottom = Math.floor(height * 0.8);
  let count = 0;
  let mean = 0;
  let square = 0;
  for (let y = Math.max(top, 1); y < Math.min(bottom, height - 1); y += 1) {
    for (let x = Math.max(left, 1); x < Math.min(right, width - 1); x += 1) {
      const at = y * width + x;
      const value = 4 * grey[at] - grey[at - 1] - grey[at + 1] - grey[at - width] - grey[at + width];
      mean += value;
      square += value * value;
      count += 1;
    }
  }
  const sharpness = count ? square / count - (mean / count) ** 2 : 0;
  const brightness = sum / grey.length;
  const clippedShare = clipped / grey.length;
  const warnings = [];
  if (sharpness < BLUR_LIMIT) warnings.push('blurry');
  if (brightness < DARK_LIMIT) warnings.push('dark');
  else if (brightness > BRIGHT_LIMIT || clippedShare > CLIPPED_LIMIT) warnings.push('bright');
  return {
    sharpness: Math.round(sharpness * 10) / 10,
    brightness: Math.round(brightness),
    warnings,
  };
}

export async function processPhoto(file) {
  const source = await decode(file);
  const width = source.width;
  const height = source.height;
  try {
    const full = resized(source, width, height, MAX_SIDE);
    const blob = await toJpeg(full, 0.92);
    const thumb = await toJpeg(resized(full, full.width, full.height, THUMB_SIDE), 0.78);
    const quality = analyse(resized(full, full.width, full.height, CHECK_SIDE));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { blob, thumb, width: full.width, height: full.height, size: blob.size, crc: crc32(bytes), ...quality };
  } finally {
    source.close?.();
  }
}
