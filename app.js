import { STRINGS } from './i18n.js';
import * as store from './store.js';
import { processPhoto } from './photo.js';
import { buildExport } from './zip.js';
import * as analysis from './features.js';
import { selfTest } from './selftest.js';

const GOALS = { day1: 10, day2: 10, test: 6 };
const VIEWS = ['side', 'stem', 'eye'];
const ATTRIBUTES = new Set(['capture', 'accept', 'for', 'role', 'href', 'rows']);

const view = document.getElementById('view');
const backLink = document.getElementById('back');
const brand = document.getElementById('brand');
const langButton = document.getElementById('lang');
const toastBox = document.getElementById('toast');
const dialog = document.getElementById('confirm');

const state = {
  lang: initialLanguage(),
  token: 0,
  busy: false,
  last: null,
  viewChoice: null,
  backup: null,
  includeAll: false,
  preparing: false,
  installPrompt: null,
  thumbs: new Map(),
  fullUrl: null,
};

function initialLanguage() {
  try {
    const saved = localStorage.getItem('lang');
    if (saved === 'fr' || saved === 'en') return saved;
  } catch (_) { /* optional */ }
  return (navigator.language || 'fr').toLowerCase().startsWith('en') ? 'en' : 'fr';
}

function t(key, values = {}) {
  const text = STRINGS[state.lang][key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
}
const counted = (key, n) => t(`${key}_${n < 2 ? 'one' : 'other'}`, { n });
const photosText = (n) => counted('photo', n);

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (ATTRIBUTES.has(key) || key.includes('-')) element.setAttribute(key, value === true ? '' : value);
    else element[key] = value;
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

const VIEW_ICONS = {
  side: '<path d="M32 18c-5-5-20-4-22 12-2 14 9 28 16 28 3 0 4-2 6-2s3 2 6 2c7 0 18-14 16-28-2-16-17-17-22-12Z"/><path d="M32 18c0-5 2-9 6-12"/><path d="M38 12c4-4 9-4 12-2-2 4-7 6-12 2Z"/>',
  stem: '<circle cx="32" cy="32" r="25"/><circle cx="32" cy="32" r="10"/><path d="M32 32l7-9"/><circle cx="32" cy="32" r="2" fill="currentColor"/>',
  eye: '<circle cx="32" cy="32" r="25"/><circle cx="32" cy="32" r="8"/><path d="M32 24v-6M32 40v6M24 32h-6M40 32h6M26 26l-4-4M38 38l4 4M38 26l4-4M26 38l-4 4"/>',
};

function viewIcon(name) {
  const box = h('span', { class: 'view-icon', 'aria-hidden': 'true' });
  box.innerHTML = `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${VIEW_ICONS[name]}</svg>`;
  return box;
}

function localDay(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function showDay(day) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).toLocaleDateString(state.lang === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'long' });
}

function showSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} ${state.lang === 'fr' ? 'Ko' : 'KB'}`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} ${state.lang === 'fr' ? 'Mo' : 'MB'}`;
  return `${(bytes / 1024 ** 3).toFixed(2)} ${state.lang === 'fr' ? 'Go' : 'GB'}`;
}

function summarize(photos) {
  const days = [...new Set(photos.map((photo) => photo.day))].sort();
  const onDay = (index) => photos.filter((photo) => photo.day === days[index]).length;
  const test = photos.filter((photo) => days.indexOf(photo.day) >= 2).length;
  const counts = { day1: onDay(0), day2: onDay(1), test };
  const complete = counts.day1 >= GOALS.day1 && counts.day2 >= GOALS.day2 && counts.test >= GOALS.test;
  return { days, counts, complete };
}

function stageFor(days, today) {
  const rank = days.includes(today) ? days.indexOf(today) : days.length;
  return rank === 0 ? 'day1' : rank === 1 ? 'day2' : 'test';
}

function nextShot(variety, photos, today) {
  const todays = photos.filter((photo) => photo.day === today).sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const last = todays[todays.length - 1];
  let apple = 1;
  let next = 'side';
  if (last) {
    apple = last.appleNo;
    const used = new Set(todays.filter((photo) => photo.appleNo === apple).map((photo) => photo.view));
    const open = VIEWS.find((name) => !used.has(name));
    if (variety.newAppleAfter === last.id || !open) {
      apple += 1;
    } else {
      next = open;
    }
  }
  const choice = state.viewChoice?.varietyId === variety.id ? state.viewChoice.view : null;
  return { apple, view: choice || next, hasPhotoOfApple: Boolean(last && last.appleNo === apple) };
}

function toast(message) {
  toastBox.textContent = message;
  toastBox.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { toastBox.hidden = true; }, 3600);
}

function confirmAction(message) {
  document.getElementById('confirm-text').textContent = message;
  const yes = document.getElementById('confirm-yes');
  const no = document.getElementById('confirm-no');
  yes.textContent = t('confirmDelete');
  no.textContent = t('cancel');
  return new Promise((resolve) => {
    const finish = (answer) => {
      yes.onclick = null;
      no.onclick = null;
      dialog.oncancel = null;
      dialog.close();
      resolve(answer);
    };
    yes.onclick = () => finish(true);
    no.onclick = () => finish(false);
    dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    dialog.showModal();
    no.focus();
  });
}

function thumbImage(photo, alt) {
  const image = h('img', { alt, loading: 'lazy', decoding: 'async' });
  const cached = state.thumbs.get(photo.id);
  if (cached) {
    image.src = cached;
  } else {
    store.getThumb(photo.id).then((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      state.thumbs.set(photo.id, url);
      image.src = url;
    });
  }
  return image;
}

function forgetThumb(id) {
  const url = state.thumbs.get(id);
  if (url) URL.revokeObjectURL(url);
  state.thumbs.delete(id);
}

function tracker(counts, current) {
  return h('div', { class: 'tracker' }, ['day1', 'day2', 'test'].map((key) => {
    const share = Math.min(100, Math.round((counts[key] / GOALS[key]) * 100));
    const done = counts[key] >= GOALS[key];
    return h('div', { class: `step${key === current ? ' current' : ''}${done ? ' done' : ''}` },
      h('span', { class: 'step-label' }, t(key)),
      h('span', { class: 'step-count' }, `${counts[key]}/${GOALS[key]}`),
      h('span', { class: 'step-bar' }, h('span', { style: `width:${share}%` })));
  }));
}

function installBanner() {
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return null;
  try { if (localStorage.getItem('install-dismissed')) return null; } catch (_) { /* optional */ }
  const iphone = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!iphone && !state.installPrompt) return null;
  const close = () => {
    try { localStorage.setItem('install-dismissed', '1'); } catch (_) { /* optional */ }
    render();
  };
  const install = async () => {
    const prompt = state.installPrompt;
    state.installPrompt = null;
    await prompt.prompt();
    render();
  };
  return h('section', { class: 'notice' },
    h('strong', {}, t('installTitle')),
    h('p', {}, iphone ? t('installIos') : t('installLead')),
    h('div', { class: 'notice-actions' },
      !iphone && h('button', { class: 'small primary', type: 'button', onclick: install }, t('installButton')),
      h('button', { class: 'small', type: 'button', onclick: close }, t('dismiss'))));
}

async function renderHome() {
  const [varieties, photos] = await Promise.all([store.listVarieties(), store.listPhotos()]);
  if (!varieties.length) {
    return [
      installBanner(),
      h('h1', {}, t('emptyTitle')),
      h('p', { class: 'lead' }, t('emptyLead')),
      h('h2', {}, t('planTitle')),
      h('ol', { class: 'plan' }, h('li', {}, t('plan1')), h('li', {}, t('plan2')), h('li', {}, t('plan3'))),
      h('div', { class: 'dock' }, h('a', { class: 'button primary', href: '#/add' }, t('addVarieties'))),
    ];
  }
  const pending = photos.filter((photo) => !photo.exportedAt).length;
  const collator = new Intl.Collator(state.lang);
  const cards = [...varieties].sort((a, b) => collator.compare(a.name, b.name)).map((variety) => {
    const own = photos.filter((photo) => photo.varietyId === variety.id);
    const { counts, complete, days } = summarize(own);
    const status = complete ? t('complete') : own.length ? photosText(own.length) : t('notStarted');
    return h('li', {}, h('a', { class: 'card', href: `#/variety/${variety.id}` },
      h('span', { class: 'card-head' },
        h('span', { class: 'card-name' }, variety.name),
        h('span', { class: `card-status${complete ? ' ok' : ''}` }, status)),
      tracker(counts, complete ? null : stageFor(days, localDay()))));
  });
  return [
    installBanner(),
    h('h1', {}, t('homeTitle')),
    photos.length > 0 && h('a', { class: `backup-strip${pending ? ' due' : ''}`, href: '#/backup' },
      h('span', {}, pending ? t('toBackup', { photos: photosText(pending) }) : t('allSaved')),
      h('span', { class: 'strip-action' }, t('backupAction'))),
    checkStrip(photos),
    h('ul', { class: 'cards' }, cards),
    h('div', { class: 'dock' }, h('a', { class: 'button', href: '#/add' }, t('addVarieties'))),
  ];
}

function renderAdd() {
  const field = h('textarea', { id: 'names', rows: 8, placeholder: t('addPlaceholder'), autocapitalize: 'words', spellcheck: false });
  const submit = async (event) => {
    event.preventDefault();
    const { added, repeated } = await store.addVarieties(field.value.split(/\r?\n/));
    if (!added && !repeated) { toast(t('nothingAdded')); return; }
    const parts = [];
    if (added) parts.push(t('added', { varieties: counted('variety', added) }));
    if (repeated) parts.push(t('repeated', { n: repeated }));
    toast(parts.join(' · '));
    location.hash = '#/';
  };
  return [
    h('h1', {}, t('addTitle')),
    h('p', { class: 'lead' }, t('addLead')),
    h('form', { onsubmit: submit },
      h('label', { class: 'field-label', for: 'names' }, t('addLabel')),
      field,
      h('div', { class: 'dock' }, h('button', { class: 'button primary', type: 'submit' }, t('addButton')))),
  ];
}

async function capture(event, variety, shot, replaces) {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file || state.busy) return;
  state.busy = true;
  render();
  try {
    let processed;
    try {
      processed = await processPhoto(file);
    } catch (_) {
      toast(t('errorRead'));
      return;
    }
    const now = new Date();
    const record = {
      id: store.newId(),
      varietyId: variety.id,
      day: localDay(now),
      takenAt: now.toISOString(),
      appleNo: shot.apple,
      view: shot.view,
      width: processed.width,
      height: processed.height,
      size: processed.size,
      crc: processed.crc,
      sharpness: processed.sharpness,
      brightness: processed.brightness,
      warnings: processed.warnings,
      exportedAt: null,
    };
    try {
      await store.addPhoto(record, processed.blob, processed.thumb);
    } catch (error) {
      toast(error && error.name === 'QuotaExceededError' ? t('errorFull') : t('errorSave'));
      return;
    }
    if (replaces) {
      await store.deletePhoto(replaces.id);
      forgetThumb(replaces.id);
      const current = await store.getVariety(variety.id);
      if (current && current.newAppleAfter === replaces.id) {
        await store.putVariety({ ...current, newAppleAfter: record.id });
      }
    }
    state.last = { id: record.id, varietyId: variety.id, warnings: record.warnings };
    state.viewChoice = null;
    state.backup = null;
    analysis.analyseSoon();
    navigator.storage?.persist?.().catch(() => {});
  } finally {
    state.busy = false;
    render();
  }
}

function cameraButton(label, className, onchange) {
  return h('label', { class: `button ${className}${state.busy ? ' is-busy' : ''}`, 'aria-disabled': state.busy ? 'true' : null },
    h('span', {}, state.busy ? t('saving') : label),
    h('input', { type: 'file', accept: 'image/*', capture: 'environment', disabled: state.busy, onchange }));
}

function photoGrid(photos, name) {
  return h('ul', { class: 'grid' }, photos.map((photo) => h('li', {},
    h('a', { href: `#/photo/${photo.id}`, 'aria-label': `${name}, ${t('apple', { n: photo.appleNo })}, ${t(`view_${photo.view}`)}` },
      thumbImage(photo, ''),
      photo.warnings.length > 0 && h('span', { class: 'flag', 'aria-hidden': 'true' }, '!')))));
}

async function renderVariety(id) {
  const variety = await store.getVariety(id);
  if (!variety) return missingScreen();
  const photos = (await store.photosOf(id)).sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  const today = localDay();
  const { counts, days, complete } = summarize(photos);
  const stage = stageFor(days, today);
  const shot = nextShot(variety, photos, today);
  const todays = photos.filter((photo) => photo.day === today);
  const earlier = photos.filter((photo) => photo.day !== today);
  const goalMet = counts[stage] >= GOALS[stage];

  const lastPhoto = state.last?.varietyId === id ? todays.find((photo) => photo.id === state.last.id) : null;
  const feedback = lastPhoto && h('section', { class: `feedback${lastPhoto.warnings.length ? ' warn' : ''}` },
    thumbImage(lastPhoto, ''),
    h('div', { class: 'feedback-text' },
      h('strong', {}, t('savedShot')),
      lastPhoto.warnings.length > 0 && h('p', {}, `${lastPhoto.warnings.map((key) => t(`warn_${key}`)).join(' ')} ${t('retakeAdvice')}`)),
    h('label', { class: `small${lastPhoto.warnings.length ? ' primary' : ''}` },
      t('retake'),
      h('input', {
        type: 'file', accept: 'image/*', capture: 'environment', disabled: state.busy,
        onchange: (event) => capture(event, variety, { apple: lastPhoto.appleNo, view: lastPhoto.view }, lastPhoto),
      })));

  const selector = h('div', { class: 'views', role: 'group', 'aria-label': t('chooseView') }, VIEWS.map((name) => h('button', {
    type: 'button',
    class: 'view-choice',
    'aria-pressed': String(name === shot.view),
    onclick: () => { state.viewChoice = { varietyId: id, view: name }; render(); },
  }, viewIcon(name), h('span', {}, t(`view_${name}`)))));

  const nextApple = async () => {
    const last = todays[0];
    if (!last) return;
    await store.putVariety({ ...variety, newAppleAfter: last.id });
    state.viewChoice = null;
    render();
  };

  const renameField = h('input', { id: 'rename', type: 'text', value: variety.name, autocapitalize: 'words' });
  const rename = async (event) => {
    event.preventDefault();
    const name = renameField.value.trim().replace(/\s+/g, ' ');
    if (!store.nameKey(name) || name === variety.name) return;
    const others = (await store.listVarieties()).filter((other) => other.id !== id);
    if (others.some((other) => store.nameKey(other.name) === store.nameKey(name))) { toast(t('nameTaken')); return; }
    await store.putVariety({ ...variety, name });
    state.backup = null;
    toast(t('renamed'));
    render();
  };
  const removeVariety = async () => {
    if (!await confirmAction(t('deleteVarietyAsk', { name: variety.name, photos: photosText(photos.length) }))) return;
    await store.deleteVariety(id);
    photos.forEach((photo) => forgetThumb(photo.id));
    state.backup = null;
    location.hash = '#/';
  };

  return [
    h('h1', { class: 'variety-title' }, variety.name),
    h('p', { class: `stage stage-${stage}` }, t(`stage_${stage}`)),
    tracker(counts, complete ? null : stage),
    complete && h('p', { class: 'goal ok' }, t('allDone')),
    !complete && goalMet && h('p', { class: 'goal' }, t('needNewDay')),
    feedback,
    h('section', { class: 'shot' },
      h('p', { class: 'shot-apple' }, t('apple', { n: shot.apple })),
      h('p', { class: 'shot-hint' }, t(`hint_${shot.view}`)),
      selector),
    todays.length > 0 && h('h2', {}, `${t('todayPhotos')} (${todays.length})`),
    todays.length > 0 && photoGrid(todays, variety.name),
    earlier.length > 0 && h('h2', {}, `${t('earlierPhotos')} (${earlier.length})`),
    earlier.length > 0 && photoGrid(earlier, variety.name),
    h('details', { class: 'fold' },
      h('summary', {}, t('tipsTitle')),
      h('ul', { class: 'tips' }, ['tip1', 'tip2', 'tip3', 'tip4'].map((key) => h('li', {}, t(key))))),
    h('details', { class: 'fold' },
      h('summary', {}, t('manage')),
      h('form', { class: 'manage', onsubmit: rename },
        h('label', { class: 'field-label', for: 'rename' }, t('renameLabel')),
        renameField,
        h('button', { class: 'button', type: 'submit' }, t('rename')),
        h('button', { class: 'button danger-outline', type: 'button', onclick: removeVariety }, t('deleteVariety')))),
    h('div', { class: 'dock dock-camera' },
      h('button', { class: 'button next-apple', type: 'button', disabled: !shot.hasPhotoOfApple || state.busy, onclick: nextApple }, t('nextApple')),
      cameraButton(t('take'), 'primary take', (event) => capture(event, variety, shot, null))),
  ];
}

async function renderPhoto(id) {
  const photo = await store.getPhoto(id);
  if (!photo) return missingScreen();
  const variety = await store.getVariety(photo.varietyId);
  const blob = await store.getImage(id);
  if (state.fullUrl) URL.revokeObjectURL(state.fullUrl);
  state.fullUrl = blob ? URL.createObjectURL(blob) : null;
  const remove = async () => {
    if (!await confirmAction(t('deletePhotoAsk'))) return;
    await store.deletePhoto(id);
    forgetThumb(id);
    if (state.last?.id === id) state.last = null;
    state.backup = null;
    toast(t('deleted'));
    location.replace(`#/variety/${photo.varietyId}`);
  };
  return [
    h('h1', { class: 'variety-title' }, variety.name),
    h('p', { class: 'lead' }, t('photoMeta', { day: showDay(photo.day), apple: photo.appleNo, view: t(`view_${photo.view}`) })),
    state.fullUrl && h('img', { class: 'full', src: state.fullUrl, alt: variety.name }),
    photo.warnings.length > 0 && h('p', { class: 'goal' }, photo.warnings.map((key) => t(`warn_${key}`)).join(' ')),
    h('div', { class: 'actions' }, h('button', { class: 'button danger-outline', type: 'button', onclick: remove }, t('deletePhoto'))),
  ];
}

function saveFile(file, share) {
  const zip = new File([file.blob], file.name, { type: 'application/zip' });
  const done = () => { file.sent = true; render(); };
  if (share) {
    navigator.share({ files: [zip], title: file.name }).then(done).catch(() => {});
    return;
  }
  const url = URL.createObjectURL(zip);
  const link = h('a', { href: url, download: file.name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  done();
}

async function renderBackup() {
  const [photos, varieties, estimate, persisted] = await Promise.all([
    store.listPhotos(),
    store.listVarieties(),
    navigator.storage?.estimate?.().catch(() => null) ?? null,
    navigator.storage?.persisted?.().catch(() => false) ?? false,
  ]);
  const pending = photos.filter((photo) => !photo.exportedAt);
  const chosen = state.includeAll ? photos : pending;
  const prepare = async () => {
    state.preparing = true;
    render();
    try {
      state.backup = await buildExport({ chosen, allPhotos: photos, varieties, getImage: store.getImage });
    } catch (_) {
      toast(t('errorExport'));
    } finally {
      state.preparing = false;
      render();
    }
  };
  const list = state.backup?.files ?? [];
  const canShare = (file) => {
    try {
      return Boolean(navigator.canShare?.({ files: [new File([file.blob], file.name, { type: 'application/zip' })] }));
    } catch (_) {
      return false;
    }
  };
  return [
    h('h1', {}, t('backupTitle')),
    h('p', { class: 'lead' }, t('backupLead')),
    h('dl', { class: 'stats' },
      h('div', {}, h('dt', {}, t('statPhotos')), h('dd', {}, String(photos.length))),
      h('div', {}, h('dt', {}, t('statPending')), h('dd', {}, String(pending.length))),
      h('div', {}, h('dt', {}, t('statSpace')), h('dd', {}, showSize(photos.reduce((sum, photo) => sum + photo.size, 0) || (estimate?.usage ?? 0))))),
    h('p', { class: persisted ? 'protected yes' : 'protected' }, persisted ? t('protectedYes') : t('protectedNo')),
    h('label', { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: state.includeAll,
        onchange: (event) => { state.includeAll = event.target.checked; state.backup = null; render(); },
      }),
      h('span', {}, t('includeAll'))),
    !list.length && h('div', { class: 'actions' },
      chosen.length
        ? h('button', { class: 'button primary', type: 'button', disabled: state.preparing, onclick: prepare },
          state.preparing ? t('preparing') : t('prepare', { photos: photosText(chosen.length) }))
        : h('p', { class: 'goal ok' }, t('nothingToSave'))),
    state.backup?.missing.length > 0 && h('p', { class: 'goal' }, t('missing', { n: state.backup.missing.length })),
    list.length > 0 && h('ul', { class: 'files' }, list.map((file, index) => h('li', { class: file.confirmed ? 'saved' : '' },
      h('div', { class: 'file-head' },
        h('strong', {}, t('fileLabel', { i: index + 1, n: list.length })),
        h('span', {}, t('fileMeta', { photos: photosText(file.count), size: showSize(file.size) }))),
      file.confirmed
        ? h('p', { class: 'goal ok' }, t('fileConfirmed'))
        : h('div', { class: 'file-actions' },
          h('button', { class: 'button primary', type: 'button', onclick: () => saveFile(file, false) }, t('download')),
          canShare(file) && h('button', { class: 'button', type: 'button', onclick: () => saveFile(file, true) }, t('share')),
          file.sent && h('button', {
            class: 'button',
            type: 'button',
            onclick: async () => {
              await store.markExported(file.ids, new Date().toISOString());
              file.confirmed = true;
              render();
            },
          }, t('confirmSaved')))))),
    list.length > 0 && h('p', { class: 'caution' }, t('afterSave')),
  ];
}

const percent = (value) => new Intl.NumberFormat(state.lang === 'fr' ? 'fr-FR' : 'en-GB', { style: 'percent', maximumFractionDigits: 0 }).format(value);

function meter(share) {
  const value = Math.round(Math.min(1, Math.max(0, share)) * 100);
  return h('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(value) },
    h('span', { style: `width:${value}%` }));
}

function checkStrip(photos) {
  if (!photos.length) return null;
  const status = analysis.getStatus();
  let text = t('checkStripReady');
  if (!status.enabled) text = t('checkStripOff');
  else if (status.phase === 'loading') text = t('checkStripLoading');
  else if (status.phase === 'error') text = t('checkStripError');
  else if (status.pending) text = t('checkStripPending', { photos: photosText(status.pending) });
  return h('a', { class: `backup-strip${status.phase === 'error' ? ' due' : ''}`, href: '#/check' },
    h('span', {}, text),
    h('span', { class: 'strip-action' }, t('checkAction')));
}

function checkRows(varieties, result) {
  const names = new Map(varieties.map((variety) => [variety.id, variety.name]));
  const entries = new Map(result.perVariety.map((entry) => [entry.varietyId, entry]));
  const collator = new Intl.Collator(state.lang);
  return [...varieties].sort((a, b) => collator.compare(a.name, b.name)).map((variety) => {
    const entry = entries.get(variety.id);
    const tested = Boolean(entry && entry.test);
    let line = t('noTrainYet');
    if (tested) line = t('varietyScore', { right: entry.correct, n: entry.test });
    else if (entry) line = t('noTestYet');
    return h('li', { class: 'card' },
      h('span', { class: 'card-head' },
        h('span', { class: 'card-name' }, variety.name),
        tested && h('span', { class: `card-status${entry.correct === entry.test ? ' ok' : ''}` }, percent(entry.correct / entry.test))),
      h('span', { class: 'card-line' }, line),
      tested && entry.confusedWith && h('span', { class: 'card-line' },
        t('confusedWith', { name: names.get(entry.confusedWith) ?? '?', n: entry.confusedCount })));
  });
}

async function renderCheck() {
  const status = analysis.getStatus();
  const head = [h('h1', {}, t('checkTitle')), h('p', { class: 'lead' }, t('checkLead'))];
  if (!status.enabled) {
    const turnOn = () => { analysis.enable(); render(); };
    return [
      ...head,
      h('ul', { class: 'tips' }, ['checkHow1', 'checkHow2', 'checkHow3'].map((key) => h('li', {}, t(key)))),
      h('p', { class: 'caution' }, t('checkDownload', { mb: analysis.DOWNLOAD_MB })),
      h('div', { class: 'dock' }, h('button', { class: 'button primary', type: 'button', onclick: turnOn }, t('enableAnalysis'))),
    ];
  }

  const busy = status.phase === 'loading' || (status.phase === 'ready' && status.pending !== 0);
  const [varieties, photos, features] = await Promise.all([
    store.listVarieties(),
    store.listPhotos(),
    busy ? [] : store.listFeatures(), // descriptions are only read once the analysis has caught up
  ]);
  const progress = [];
  if (status.phase === 'loading') {
    const share = status.total ? status.loaded / status.total : 0;
    progress.push(h('p', { class: 'stage' }, status.total ? t('modelLoading', { pct: percent(share) }) : t('modelPreparing')), meter(share));
  } else if (status.phase === 'error') {
    const again = () => { analysis.retry(); render(); };
    progress.push(h('p', { class: 'goal' }, t('analysisFailed')),
      h('div', { class: 'actions' }, h('button', { class: 'button', type: 'button', onclick: again }, t('retry'))));
  } else if (busy) {
    const done = Math.max(0, photos.length - (status.pending ?? photos.length) - status.failed);
    progress.push(h('p', { class: 'stage' }, t('analysing', { done, total: photos.length })), meter(photos.length ? done / photos.length : 0));
  }
  if (status.failed) progress.push(h('p', { class: 'goal' }, t('analysisSkipped', { n: status.failed })));
  if (busy) return [...head, ...progress, h('p', { class: 'caution' }, t('resultsAfter'))];

  const vectors = new Map(features.filter((item) => item.tag === analysis.FEATURE_TAG).map((item) => [item.id, item.vector]));
  const result = selfTest(photos, vectors);
  if (result.varieties < 2 || !result.photos) return [...head, ...progress, h('p', { class: 'goal' }, t('checkNeeds'))];
  const stats = [
    [t('statTop1'), percent(result.top1 / result.photos)],
    result.varieties >= 4 && [t('statTop3'), percent(result.top3 / result.photos)],
    [t('statChance'), percent(1 / result.varieties)],
  ].filter(Boolean);
  return [
    ...head,
    ...progress,
    h('dl', { class: 'stats' }, stats.map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value)))),
    h('p', { class: 'stage' }, t('checkBasis', { photos: photosText(result.photos), varieties: counted('variety', result.varieties) })),
    result.apples > 0 && h('p', { class: 'stage' },
      t('checkApples', { pct: percent(result.appleTop1 / result.apples), apples: counted('apple', result.apples) })),
    h('h2', {}, t('perVariety')),
    h('ul', { class: 'cards' }, checkRows(varieties, result)),
    h('p', { class: 'caution' }, t('checkCaution')),
  ];
}

function missingScreen() {
  return [
    h('h1', {}, t('notFound')),
    h('div', { class: 'actions' }, h('a', { class: 'button', href: '#/' }, t('backHome'))),
  ];
}

function currentRoute() {
  const [, screen = '', id = ''] = location.hash.replace(/^#/, '').split('/');
  return { screen, id };
}

async function render() {
  const token = ++state.token;
  const { screen, id } = currentRoute();
  document.documentElement.lang = state.lang;
  document.title = t('appName');
  brand.textContent = t('appName');
  langButton.textContent = state.lang === 'fr' ? 'EN' : 'FR';
  backLink.hidden = !screen;
  backLink.setAttribute('aria-label', t('back'));
  backLink.textContent = '‹';
  backLink.href = screen === 'photo' ? `#/variety/${(await store.getPhoto(id))?.varietyId ?? ''}` : '#/';
  let nodes;
  if (screen === 'add') nodes = renderAdd();
  else if (screen === 'variety') nodes = await renderVariety(id);
  else if (screen === 'photo') nodes = await renderPhoto(id);
  else if (screen === 'backup') nodes = await renderBackup();
  else if (screen === 'check') nodes = await renderCheck();
  else nodes = await renderHome();
  if (token !== state.token) return;
  const open = [...view.querySelectorAll('details')].map((item) => item.open);
  const scroll = window.scrollY;
  view.replaceChildren(...nodes.filter(Boolean));
  view.querySelectorAll('details').forEach((item, index) => { item.open = Boolean(open[index]); });
  window.scrollTo(0, render.routeChanged ? 0 : scroll);
  render.routeChanged = false;
}

window.addEventListener('hashchange', () => {
  render.routeChanged = true;
  state.viewChoice = null;
  render();
});
langButton.addEventListener('click', () => {
  state.lang = state.lang === 'fr' ? 'en' : 'fr';
  try { localStorage.setItem('lang', state.lang); } catch (_) { /* optional */ }
  render();
});
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.installPrompt = event;
  render();
});
window.addEventListener('appinstalled', () => {
  state.installPrompt = null;
  render();
});

// Progress only changes the home and check screens; at most one refresh every 0.7 s.
analysis.onChange(() => {
  const { screen } = currentRoute();
  if ((screen !== '' && screen !== 'check') || render.analysisTimer) return;
  render.analysisTimer = setTimeout(() => { render.analysisTimer = null; render(); }, 700);
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
analysis.start();
render();
