// scriptcast studio: a friendly editor for demo scripts.
// The page talks to the local studio server, which saves demo.yml and runs scriptcast.

const token = new URLSearchParams(location.search).get('token') ?? '';
const $ = (id) => document.getElementById(id);

const ACTIONS = {
  click: { label: '👆 Click', fields: ['target'] },
  type: { label: '⌨️ Type', fields: ['text', 'into'] },
  say: { label: '💬 Caption', fields: ['caption', 'for'] },
  press: { label: '↵ Press key', fields: ['key'] },
  wait: { label: '⏱ Wait', fields: ['ms'] },
  waitFor: { label: '👀 Wait for', fields: ['target'] },
  hover: { label: '🖱 Hover', fields: ['target'] },
  scroll: { label: '↕ Scroll', fields: ['by'] },
  goto: { label: '🔗 Go to page', fields: ['url'] },
};
const NEW_STEP = {
  click: { action: 'click', text: '' },
  type: { action: 'type', text: '', into: '' },
  say: { action: 'say', text: '' },
  press: { action: 'press', key: 'Enter' },
  wait: { action: 'wait', ms: '1s' },
  waitFor: { action: 'waitFor', text: '' },
  hover: { action: 'hover', text: '' },
  scroll: { action: 'scroll', by: 400 },
  goto: { action: 'goto', url: '' },
};
const BACKGROUNDS = {
  aurora: 'linear-gradient(135deg, #7f7fd5, #86a8e7, #91eae4)',
  sunset: 'linear-gradient(135deg, #ff7e5f, #feb47b)',
  ocean: 'linear-gradient(135deg, #1a2980, #26d0ce)',
  candy: 'linear-gradient(135deg, #d53369, #daae51)',
  forest: 'linear-gradient(135deg, #134e5e, #71b280)',
  midnight: 'linear-gradient(135deg, #0f2027, #203a43, #2c5364)',
  mono: 'linear-gradient(135deg, #e0e0e0, #f5f5f5)',
};

let doc = {};
let lists = { steps: [], setup: [] };
let busy = null;

// ---------- converting between YAML steps and editable steps ----------

function fromRaw(raw) {
  const action = Object.keys(raw ?? {})[0];
  const v = raw?.[action];
  const target = (t) => (t && typeof t === 'object' ? { text: t.text ?? '', in: t.in ?? '', nth: t.nth ?? '' } : { text: t ?? '', in: '', nth: '' });
  switch (action) {
    case 'click': case 'hover': case 'waitFor': return { action, ...target(v) };
    case 'type': return typeof v === 'object' ? { action, text: v.text ?? '', into: typeof v.into === 'object' ? v.into.text : v.into ?? '' } : { action, text: v ?? '', into: '' };
    case 'say': return typeof v === 'object' ? { action, text: v.text ?? '', for: v.for ?? '' } : { action, text: v ?? '', for: '' };
    case 'press': return { action, key: v ?? '' };
    case 'wait': return { action, ms: String(v ?? '') };
    case 'scroll': return { action, by: v ?? 0 };
    case 'goto': return { action, url: v ?? '' };
    default: return { action: 'unknown', raw };
  }
}

function toRaw(s) {
  switch (s.action) {
    case 'click': case 'hover': case 'waitFor': {
      if (!s.in && !s.nth) return { [s.action]: s.text };
      const t = { text: s.text };
      if (s.in) t.in = s.in;
      if (s.nth) t.nth = Number(s.nth);
      return { [s.action]: t };
    }
    case 'type': return s.into ? { type: { into: s.into, text: s.text } } : { type: s.text };
    case 'say': return s.for ? { say: { text: s.text, for: s.for } } : { say: s.text };
    case 'press': return { press: s.key };
    case 'wait': return { wait: /^\d+$/.test(s.ms) ? Number(s.ms) : s.ms };
    case 'scroll': return { scroll: Number(s.by) || 0 };
    case 'goto': return { goto: s.url };
    default: return s.raw;
  }
}

// ---------- server calls ----------

async function api(path, body, method = body ? 'POST' : 'GET') {
  const res = await fetch(path, {
    method,
    headers: { 'x-studio-token': token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function buildDoc() {
  const next = { ...doc };
  next.url = $('url').value.trim();
  next.displayUrl = $('display-url').value.trim() || undefined;
  next.steps = lists.steps.map(toRaw);
  if (lists.setup.length) next.setup = lists.setup.map(toRaw);
  else delete next.setup;
  if ($('remember-login').checked && lists.setup.length) next.session = next.session ?? '.scriptcast/session.json';
  else delete next.session;
  next.output = { ...(doc.output ?? {}), gif: $('gif').checked };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  return next;
}

let saveTimer = null;
function scheduleSave() {
  $('save-state').textContent = 'Saving…';
  $('save-state').classList.remove('error');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 350);
}

async function save() {
  clearTimeout(saveTimer);
  doc = buildDoc();
  try {
    const res = await api('/api/doc', { doc }, 'PUT');
    $('save-state').textContent = 'Saved';
    $('yaml').textContent = res.yaml;
    showProblem(res.error);
  } catch (err) {
    $('save-state').textContent = `Couldn't save: ${err.message}`;
    $('save-state').classList.add('error');
  }
}

function showProblem(message) {
  // An empty script isn't a problem worth shouting about yet.
  const show = message && !(lists.steps.length === 0 && /steps/.test(message));
  $('problem').hidden = !show;
  $('problem').textContent = show ? `⚠ ${message}` : '';
}

// ---------- rendering the editor ----------

function input(value, placeholder, onInput, cls = '') {
  const el = document.createElement('input');
  el.value = value ?? '';
  el.placeholder = placeholder;
  if (cls) el.className = cls;
  el.spellcheck = false;
  el.addEventListener('input', () => { onInput(el.value); scheduleSave(); });
  return el;
}

function labelled(text, el) {
  const wrap = document.createElement('label');
  wrap.className = 'inline-field';
  const span = document.createElement('span');
  span.textContent = text;
  wrap.append(span, el);
  return wrap;
}

// Main fields are always shown; extra fields hide behind "More" unless they have a value.
function fieldsFor(step) {
  const set = (key) => (v) => { step[key] = v; };
  switch (step.action) {
    case 'click': case 'hover': case 'waitFor':
      return {
        main: [input(step.text, step.action === 'waitFor' ? 'Text that should appear' : 'Text on the button, link or field', set('text'))],
        extra: [
          labelled('near', input(step.in, 'e.g. Settings', set('in'), 'small')),
          labelled('which one', input(step.nth, '1, 2, 3…', set('nth'), 'tiny')),
        ],
        filled: Boolean(step.in || step.nth),
      };
    case 'type':
      return { main: [input(step.text, 'Text to type', set('text')), labelled('into', input(step.into, 'field label (optional)', set('into')))], extra: [] };
    case 'say':
      return {
        main: [input(step.text, 'Caption shown in the video (leave empty to hide it)', set('text'))],
        extra: [labelled('show for', input(step.for, 'e.g. 2s', set('for'), 'tiny'))],
        filled: Boolean(step.for),
      };
    case 'press': {
      const el = input(step.key, 'Enter, Tab, Escape…', set('key'));
      el.setAttribute('list', 'keys');
      return { main: [el], extra: [] };
    }
    case 'wait': return { main: [input(step.ms, 'e.g. 1s or 500ms', set('ms'))], extra: [] };
    case 'scroll': return { main: [input(step.by, 'Pixels to scroll (e.g. 400, or -400 to go up)', set('by'))], extra: [] };
    case 'goto': return { main: [input(step.url, 'URL or path, e.g. /settings', set('url'))], extra: [] };
    default: {
      const note = document.createElement('span');
      note.className = 'muted';
      note.textContent = `Edit this step in the YAML file: ${JSON.stringify(step.raw)}`;
      return { main: [note], extra: [] };
    }
  }
}

function iconButton(symbol, title, onClick, cls = '') {
  const b = document.createElement('button');
  b.className = `icon-btn ${cls}`;
  b.textContent = symbol;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function renderList(name) {
  const list = lists[name];
  const ol = $(name);
  ol.replaceChildren();
  list.forEach((step, i) => {
    const li = document.createElement('li');
    li.className = `step ${step.action}`;

    const num = document.createElement('span');
    num.className = 'step-num';
    num.textContent = i + 1;

    const select = document.createElement('select');
    for (const [key, info] of Object.entries(ACTIONS)) select.add(new Option(info.label, key, false, key === step.action));
    if (step.action === 'unknown') select.add(new Option('Other', 'unknown', false, true));
    select.addEventListener('change', () => {
      list[i] = { ...structuredClone(NEW_STEP[select.value]), text: step.text ?? '' };
      renderList(name);
      scheduleSave();
    });

    const { main, extra, filled } = fieldsFor(step);
    const fields = document.createElement('div');
    fields.className = 'step-fields';
    fields.append(...main);
    const showExtra = extra.length > 0 && (filled || step._more);
    if (showExtra) fields.append(...extra);

    const tools = document.createElement('div');
    tools.className = 'step-tools';
    if (extra.length && !filled) {
      tools.append(iconButton('⋯', showExtra ? 'Fewer options' : 'More options', () => { step._more = !step._more; renderList(name); }));
    }
    tools.append(
      iconButton('↑', 'Move up', () => move(name, i, -1)),
      iconButton('↓', 'Move down', () => move(name, i, 1)),
      iconButton('＋', 'Add a caption after this step', () => { list.splice(i + 1, 0, structuredClone(NEW_STEP.say)); renderList(name); scheduleSave(); focusStep(name, i + 1); }),
      iconButton('✕', 'Delete step', () => { list.splice(i, 1); renderList(name); scheduleSave(); }, 'danger'),
    );

    li.append(num, select, fields, tools);
    ol.append(li);
  });
  if (name === 'steps') $('empty').hidden = list.length > 0;
}

function move(name, i, by) {
  const list = lists[name];
  const j = i + by;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  renderList(name);
  scheduleSave();
}

function focusStep(name, i) {
  $(name).children[i]?.querySelector('input')?.focus();
}

function renderAddBars() {
  for (const bar of document.querySelectorAll('.add-bar')) {
    const name = bar.dataset.list;
    bar.replaceChildren();
    for (const [key, info] of Object.entries(ACTIONS)) {
      if (name === 'setup' && key === 'say') continue;
      const b = document.createElement('button');
      b.textContent = `+ ${info.label.replace(/^\S+\s/, '')}`;
      b.addEventListener('click', () => {
        lists[name].push(structuredClone(NEW_STEP[key]));
        renderList(name);
        scheduleSave();
        focusStep(name, lists[name].length - 1);
      });
      bar.append(b);
    }
  }
}

function renderBackgrounds() {
  const current = doc.output?.background ?? 'aurora';
  const box = $('backgrounds');
  box.replaceChildren();
  for (const [name, css] of Object.entries(BACKGROUNDS)) {
    const b = document.createElement('button');
    b.className = `swatch${name === current ? ' on' : ''}`;
    b.style.background = css;
    b.title = name;
    b.addEventListener('click', () => {
      doc.output = { ...(doc.output ?? {}), background: name };
      renderBackgrounds();
      scheduleSave();
    });
    box.append(b);
  }
}

// ---------- jobs: check, record, capture ----------

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}

function setBusy(kind) {
  busy = kind;
  $('check-btn').disabled = Boolean(kind);
  $('record-btn').disabled = Boolean(kind);
  $('capture-btn').disabled = Boolean(kind) && kind !== 'capture';
  $('capture-btn').classList.toggle('active', kind === 'capture');
  $('capture-label').textContent = kind === 'capture' ? 'Stop recording clicks' : 'Record my clicks';
  $('capture-banner').hidden = kind !== 'capture';
}

function appendLog(text) {
  const log = $('log');
  log.textContent += `${text}\n`;
  log.scrollTop = log.scrollHeight;
}

async function startJob(kind) {
  await save();
  $('log').textContent = '';
  try {
    await api(`/api/${kind}`, {});
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

$('check-btn').addEventListener('click', () => startJob('check'));
$('record-btn').addEventListener('click', () => startJob('record'));

$('capture-btn').addEventListener('click', async () => {
  if (busy === 'capture') return api('/api/capture/stop', {});
  await save();
  if (!doc.url) return setStatus('Enter the website to record first.', 'error');
  setStatus('Opening a browser window…', 'busy');
  try {
    await api('/api/capture/start', { url: doc.url, viewport: doc.viewport });
    setBusy('capture');
    setStatus('Recording your clicks in the other window…', 'busy');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

$('reveal').addEventListener('click', () => api('/api/reveal', {}));
$('copy-yaml').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('yaml').textContent);
  $('copy-yaml').textContent = 'Copied';
  setTimeout(() => ($('copy-yaml').textContent = 'Copy'), 1200);
});

function onEvent(e) {
  switch (e.type) {
    case 'hello':
      setBusy(e.busy);
      break;
    case 'log':
      appendLog(e.text);
      if (e.text.startsWith('● Making the GIF')) setStatus('Making the GIF…', 'busy');
      if (e.text.startsWith('● First run')) setStatus('Downloading the browser scriptcast uses. This happens only once and takes about a minute…', 'busy');
      break;
    case 'start':
      setBusy(e.kind);
      if (e.kind === 'check') setStatus('Checking every step…', 'busy');
      if (e.kind === 'record') {
        setStatus('Recording your site… (this takes about as long as the video)', 'busy');
        $('progress').hidden = true;
      }
      break;
    case 'progress':
      $('progress').hidden = false;
      $('progress').firstElementChild.style.width = `${e.value}%`;
      setStatus(`Making the video… ${e.value}%`, 'busy');
      break;
    case 'captured':
      lists.steps.push(fromRaw(e.step));
      renderList('steps');
      $('steps').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      scheduleSave();
      break;
    case 'done':
      setBusy(null);
      $('progress').hidden = true;
      if (e.kind === 'check') {
        const warn = e.warnings ? ` (${e.warnings} warning${e.warnings > 1 ? 's' : ''}: see Details)` : '';
        setStatus(`✔ All steps work${warn}. Took ${e.seconds.toFixed(1)}s.`, 'ok');
      }
      if (e.kind === 'record') {
        setStatus('✔ Your video is ready.', 'ok');
        const q = `?token=${token}&v=${e.stamp}`;
        $('video').src = `/api/output/video${q}`;
        $('dl-video').href = `/api/output/video${q}`;
        $('dl-gif').href = `/api/output/gif${q}`;
        $('dl-gif').hidden = !e.gif;
        $('player').hidden = false;
        $('video').play().catch(() => {});
      }
      if (e.kind === 'capture') setStatus('Done recording clicks. Add captions with ＋, then press Make video.', 'ok');
      break;
    case 'error':
      setBusy(null);
      $('progress').hidden = true;
      setStatus(e.message, 'error');
      break;
  }
}

// ---------- start up ----------

async function load() {
  const res = await api('/api/doc');
  doc = res.doc;
  $('file-name').textContent = res.file;
  $('file-path').textContent = res.path;
  $('save-state').textContent = res.exists ? 'Saved' : 'New script';
  $('url').value = doc.url ?? '';
  $('display-url').value = doc.displayUrl ?? '';
  $('gif').checked = Boolean(doc.output?.gif);
  $('remember-login').checked = Boolean(doc.session);
  lists.steps = (doc.steps ?? []).map(fromRaw);
  lists.setup = (doc.setup ?? []).map(fromRaw);
  if (lists.setup.length) $('login-card').open = true;
  renderList('steps');
  renderList('setup');
  renderAddBars();
  renderBackgrounds();
  showProblem(res.error);
  const yaml = await api('/api/yaml', { doc });
  $('yaml').textContent = yaml.yaml;

  for (const id of ['url', 'display-url']) $(id).addEventListener('input', scheduleSave);
  for (const id of ['gif', 'remember-login']) $(id).addEventListener('change', scheduleSave);

  const events = new EventSource(`/api/events?token=${token}`);
  events.onmessage = (m) => onEvent(JSON.parse(m.data));
}

const keys = document.createElement('datalist');
keys.id = 'keys';
for (const k of ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Backspace', 'Space', 'Meta+K', 'Control+K']) keys.append(new Option(k));
document.body.append(keys);

load().catch((err) => {
  $('save-state').textContent = '';
  setStatus(err.message, 'error');
});
