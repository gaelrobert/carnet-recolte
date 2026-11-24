/* Step 4: the phone learns each variety from its first two picking days,
   then tests itself on photos from later days, which it has never seen. */
import { rolesByPhoto } from './zip.js';

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function normalise(vector) {
  const length = Math.sqrt(dot(vector, vector)) || 1;
  return vector.map((value) => value / length);
}

/* 1 when the right variety scores highest. Ties count against it. */
function rankOf(scores, truth) {
  let rank = 1;
  scores.forEach((score, index) => { if (index !== truth && score >= scores[truth]) rank += 1; });
  return rank;
}

function best(scores) {
  return scores.reduce((top, score, index) => (score > scores[top] ? index : top), 0);
}

/**
 * photos: records from the app ({ id, varietyId, day, appleNo }).
 * vectors: Map from photo id to its description (unit length).
 * Each variety is represented by the average of its training photos; a test photo goes to the closest one.
 */
export function selfTest(photos, vectors) {
  const roles = rolesByPhoto(photos);
  const sums = new Map();
  const trained = new Map();
  for (const photo of photos) {
    const vector = vectors.get(photo.id);
    if (!vector || roles.get(photo.id) !== 'train') continue;
    if (!sums.has(photo.varietyId)) sums.set(photo.varietyId, new Float64Array(vector.length));
    const sum = sums.get(photo.varietyId);
    for (let i = 0; i < vector.length; i += 1) sum[i] += vector[i];
    trained.set(photo.varietyId, (trained.get(photo.varietyId) || 0) + 1);
  }
  const candidates = [...sums.keys()];
  const prototypes = candidates.map((id) => normalise(sums.get(id)));
  const position = new Map(candidates.map((id, index) => [id, index]));
  const perVariety = new Map(candidates.map((id) => [id, {
    varietyId: id, train: trained.get(id), test: 0, correct: 0, mistakes: new Map(),
  }]));

  const result = { varieties: candidates.length, photos: 0, top1: 0, top3: 0, apples: 0, appleTop1: 0, untrainedTests: 0 };
  const apples = new Map();
  for (const photo of photos) {
    if (roles.get(photo.id) !== 'test') continue;
    const vector = vectors.get(photo.id);
    if (!vector) continue;
    if (!position.has(photo.varietyId)) { result.untrainedTests += 1; continue; }
    const truth = position.get(photo.varietyId);
    const scores = prototypes.map((prototype) => dot(vector, prototype));
    const rank = rankOf(scores, truth);
    const entry = perVariety.get(photo.varietyId);
    entry.test += 1;
    result.photos += 1;
    if (rank === 1) { entry.correct += 1; result.top1 += 1; }
    else {
      const wrong = candidates[best(scores)];
      entry.mistakes.set(wrong, (entry.mistakes.get(wrong) || 0) + 1);
    }
    if (rank <= 3) result.top3 += 1;

    const key = `${photo.varietyId}|${photo.day}|${photo.appleNo}`;
    if (!apples.has(key)) apples.set(key, { truth, scores: new Float64Array(candidates.length) });
    scores.forEach((score, index) => { apples.get(key).scores[index] += score; });
  }
  for (const apple of apples.values()) {
    result.apples += 1;
    if (rankOf(Array.from(apple.scores), apple.truth) === 1) result.appleTop1 += 1;
  }
  result.perVariety = [...perVariety.values()].map(({ mistakes, ...entry }) => {
    const [confusedWith = null, confusedCount = 0] = [...mistakes].sort((a, b) => b[1] - a[1])[0] || [];
    return { ...entry, confusedWith, confusedCount };
  });
  return result;
}
