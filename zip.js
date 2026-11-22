/* Builds ZIP backups without loading every photo into memory. JPEGs are stored as they are. */
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
const UTF8_NAMES = 0x0800;
export const PART_LIMIT = 180 * 1024 * 1024;

function dosStamp(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const stamp = dosStamp(entry.date);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, stamp.time, true);
    local.setUint16(12, stamp.date, true);
    local.setUint32(14, entry.crc, true);
    local.setUint32(18, entry.size, true);
    local.setUint32(22, entry.size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, entry.data);

    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, UTF8_NAMES, true);
    record.setUint16(10, 0, true);
    record.setUint16(12, stamp.time, true);
    record.setUint16(14, stamp.date, true);
    record.setUint32(16, entry.crc, true);
    record.setUint32(20, entry.size, true);
    record.setUint32(24, entry.size, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    central.push(record.buffer, name);
    offset += 30 + name.length + entry.size;
  }
  const centralSize = central.reduce((total, part) => total + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

function slug(name) {
  const text = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/œ/g, 'oe').replace(/Œ/g, 'oe');
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'variete';
}

/* The first two picking days of a variety train the model. Later days are kept for testing it. */
export function rolesByPhoto(photos) {
  const days = new Map();
  for (const photo of photos) {
    if (!days.has(photo.varietyId)) days.set(photo.varietyId, new Set());
    days.get(photo.varietyId).add(photo.day);
  }
  const ranked = new Map([...days].map(([id, set]) => [id, [...set].sort()]));
  return new Map(photos.map((photo) => [photo.id, ranked.get(photo.varietyId).indexOf(photo.day) < 2 ? 'train' : 'test']));
}

const stampName = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
};

export async function buildExport({ chosen, allPhotos, varieties, getImage, limit = PART_LIMIT, now = new Date() }) {
  const names = new Map(varieties.map((variety) => [variety.id, variety]));
  const roles = rolesByPhoto(allPhotos);
  const ordered = [...chosen].sort((a, b) => (
    names.get(a.varietyId).name.localeCompare(names.get(b.varietyId).name) || a.takenAt.localeCompare(b.takenAt)
  ));
  const groups = [];
  let current = [];
  let size = 0;
  for (const photo of ordered) {
    if (current.length && size + photo.size > limit) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(photo);
    size += photo.size;
  }
  if (current.length) groups.push(current);

  const files = [];
  const missing = [];
  for (let index = 0; index < groups.length; index += 1) {
    const entries = [];
    const listed = [];
    for (const photo of groups[index]) {
      const image = await getImage(photo.id);
      if (!image) { missing.push(photo.id); continue; }
      const variety = names.get(photo.varietyId);
      const apple = String(photo.appleNo).padStart(2, '0');
      const file = `images/${slug(variety.name)}-${variety.id.slice(0, 6)}/${photo.day}_pomme-${apple}_${photo.view}_${photo.id.slice(0, 8)}.jpg`;
      entries.push({ name: file, data: image, size: image.size, crc: photo.crc, date: new Date(photo.takenAt) });
      listed.push({
        file,
        id: photo.id,
        variety: variety.name,
        varietyId: variety.id,
        day: photo.day,
        takenAt: photo.takenAt,
        apple: photo.appleNo,
        appleGroup: `${variety.id}:${photo.day}:${photo.appleNo}`,
        view: photo.view,
        role: roles.get(photo.id),
        width: photo.width,
        height: photo.height,
        sharpness: photo.sharpness,
        brightness: photo.brightness,
        warnings: photo.warnings,
      });
    }
    const manifest = encoder.encode(JSON.stringify({
      format: 'carnet-recolte',
      version: 1,
      exportedAt: now.toISOString(),
      part: index + 1,
      parts: groups.length,
      photos: listed,
    }, null, 1));
    entries.unshift({ name: 'manifest.json', data: manifest, size: manifest.length, crc: crc32(manifest), date: now });
    const blob = buildZip(entries);
    files.push({
      name: `recolte-${stampName(now)}-${index + 1}-sur-${groups.length}.zip`,
      blob,
      size: blob.size,
      count: listed.length,
      ids: listed.map((photo) => photo.id),
      sent: false,
      confirmed: false,
    });
  }
  return { files, missing };
}
