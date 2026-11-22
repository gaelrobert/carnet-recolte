/* All data stays on the phone, in IndexedDB. A photo and its thumbnail are saved together or not at all. */
const NAME = 'carnet-recolte';
const VERSION = 1;
let database;

function open() {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open(NAME, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('varieties', { keyPath: 'id' });
        db.createObjectStore('photos', { keyPath: 'id' }).createIndex('varietyId', 'varietyId');
        db.createObjectStore('images');
        db.createObjectStore('thumbs');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return database;
}

async function transaction(stores, mode, work) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
    work(tx, (value) => { result = value; });
  });
}

const read = (store, method, ...args) => transaction([store], 'readonly', (tx, done) => {
  const request = tx.objectStore(store)[method](...args);
  request.onsuccess = () => done(request.result);
});

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function nameKey(name) {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export const listVarieties = () => read('varieties', 'getAll');
export const getVariety = (id) => read('varieties', 'get', id);
export const listPhotos = () => read('photos', 'getAll');
export const getPhoto = (id) => read('photos', 'get', id);
export const photosOf = (varietyId) => transaction(['photos'], 'readonly', (tx, done) => {
  const request = tx.objectStore('photos').index('varietyId').getAll(varietyId);
  request.onsuccess = () => done(request.result);
});
export const getImage = (id) => read('images', 'get', id);
export const getThumb = (id) => read('thumbs', 'get', id);

export async function addVarieties(names) {
  const existing = new Set((await listVarieties()).map((variety) => nameKey(variety.name)));
  const fresh = [];
  let repeated = 0;
  for (const raw of names) {
    const name = raw.trim().replace(/\s+/g, ' ');
    const key = nameKey(name);
    if (!key) continue;
    if (existing.has(key)) { repeated += 1; continue; }
    existing.add(key);
    fresh.push({ id: newId(), name, createdAt: new Date().toISOString(), newAppleAfter: null });
  }
  await transaction(['varieties'], 'readwrite', (tx) => {
    fresh.forEach((variety) => tx.objectStore('varieties').put(variety));
  });
  return { added: fresh.length, repeated };
}

export const putVariety = (variety) => transaction(['varieties'], 'readwrite', (tx) => {
  tx.objectStore('varieties').put(variety);
});

export const deleteVariety = (id) => transaction(['varieties', 'photos', 'images', 'thumbs'], 'readwrite', (tx) => {
  tx.objectStore('varieties').delete(id);
  const keys = tx.objectStore('photos').index('varietyId').getAllKeys(id);
  keys.onsuccess = () => {
    for (const key of keys.result) {
      tx.objectStore('photos').delete(key);
      tx.objectStore('images').delete(key);
      tx.objectStore('thumbs').delete(key);
    }
  };
});

export const addPhoto = (record, image, thumb) => transaction(['photos', 'images', 'thumbs'], 'readwrite', (tx) => {
  tx.objectStore('photos').put(record);
  tx.objectStore('images').put(image, record.id);
  tx.objectStore('thumbs').put(thumb, record.id);
});

export const deletePhoto = (id) => transaction(['photos', 'images', 'thumbs'], 'readwrite', (tx) => {
  tx.objectStore('photos').delete(id);
  tx.objectStore('images').delete(id);
  tx.objectStore('thumbs').delete(id);
});

export const markExported = (ids, when) => transaction(['photos'], 'readwrite', (tx) => {
  const photos = tx.objectStore('photos');
  for (const id of ids) {
    const request = photos.get(id);
    request.onsuccess = () => {
      if (request.result) photos.put({ ...request.result, exportedAt: when });
    };
  }
});
