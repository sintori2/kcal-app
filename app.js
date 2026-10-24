// 한 끼 칼로리 — 사진 → Claude가 칼로리 추정 → 기기(IndexedDB)에 기록
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.133.0/+esm';
const MEALS = ['아침', '점심', '저녁', '간식'];
const $ = (id) => document.getElementById(id);

// ---------- 설정 (localStorage) ----------
const settings = Object.assign(
  { goal: 2000, apiKey: '', model: 'claude-opus-5-5' },
  safeJSON(localStorageGet('kcal-settings'), {})
);
function saveSettings() { localStorageSet('kcal-settings', JSON.stringify(settings)); }
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function safeJSON(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }

// ---------- 기록 저장소 (IndexedDB) ----------
const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('kcal', 1);
  req.onupgradeneeded = () => {
    const store = req.result.createObjectStore('entries', { keyPath: 'id' });
    store.createIndex('date', 'date');
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function tx(mode, fn) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const t = db.transaction('entries', mode);
    const result = fn(t.objectStore('entries'));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
const putEntry = (e) => tx('readwrite', (s) => s.put(e));
const deleteEntry = (id) => tx('readwrite', (s) => s.delete(id));
const entriesOn = (date) => tx('readonly', (s) => s.index('date').getAll(date));
const allEntries = () => tx('readonly', (s) => s.getAll());

// ---------- 날짜 ----------
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
let current = new Date();
function shiftDay(n) { const d = new Date(current); d.setDate(d.getDate() + n); return d; }
function dateLabel(d) {
  const today = ymd(new Date());
  const yest = ymd(new Date(Date.now() - 864e5));
  const s = ymd(d);
  const base = `${d.getMonth() + 1}월 ${d.getDate()}일 (${'일월화수목금토'[d.getDay()]})`;
  return s === today ? `오늘 · ${base}` : s === yest ? `어제 · ${base}` : base;
}
function guessMeal(d = new Date()) {
  const h = d.getHours();
  return h >= 5 && h < 10 ? '아침' : h >= 11 && h < 15 ? '점심' : h >= 17 && h < 21 ? '저녁' : '간식';
}

// ---------- 메인 화면 ----------
async function render() {
  const date = ymd(current);
  $('dateLabel').textContent = dateLabel(current);
  $('nextDay').disabled = date >= ymd(new Date());
  $('nextDay').style.visibility = $('nextDay').disabled ? 'hidden' : 'visible';

  const list = (await entriesOn(date)).sort((a, b) => a.createdAt - b.createdAt);
  const total = list.reduce((s, e) => s + e.kcal, 0);
  $('totalNum').textContent = total.toLocaleString();
  $('goalLabel').textContent = `/ ${settings.goal.toLocaleString()} kcal`;
  $('barFill').style.width = `${Math.min(100, (total / settings.goal) * 100)}%`;
  $('bar').classList.toggle('over', total > settings.goal);
  const left = settings.goal - total;
  $('remain').textContent = left >= 0 ? `${left.toLocaleString()} kcal 남았어요` : `${(-left).toLocaleString()} kcal 넘었어요`;

  const wrap = $('meals');
  wrap.innerHTML = '';
  if (!list.length) {
    wrap.innerHTML = '<section class="card"><div class="empty">아직 기록이 없어요.<br>먹기 전에 사진 한 장 찍어 보세요 📷</div></section>';
  }
  for (const meal of MEALS) {
    const items = list.filter((e) => e.meal === meal);
    if (!items.length) continue;
    const sec = document.createElement('section');
    sec.className = 'card meal';
    sec.innerHTML = `<h3><span>${meal}</span><span>${items.reduce((s, e) => s + e.kcal, 0).toLocaleString()} kcal</span></h3>`;
    for (const e of items) {
      const b = document.createElement('button');
      b.className = 'entry';
      const t = new Date(e.createdAt);
      b.innerHTML = `${e.thumb ? `<img src="${e.thumb}" alt="">` : '<div class="noimg">🍴</div>'}
        <div class="info"><div class="name"></div><div class="meta">${pad(t.getHours())}:${pad(t.getMinutes())}</div></div>
        <div class="kcal">${e.kcal.toLocaleString()}</div>`;
      b.querySelector('.name').textContent = e.items.map((i) => i.name).join(', ') || '음식';
      b.onclick = () => openEntry({ entry: e });
      sec.appendChild(b);
    }
    wrap.appendChild(sec);
  }
  renderWeek();
}

async function renderWeek() {
  const all = await allEntries();
  const byDate = {};
  for (const e of all) byDate[e.date] = (byDate[e.date] || 0) + e.kcal;
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(current); d.setDate(d.getDate() - i); days.push(d); }
  const max = Math.max(settings.goal, ...days.map((d) => byDate[ymd(d)] || 0));
  $('week').innerHTML = days.map((d) => {
    const v = byDate[ymd(d)] || 0;
    const cls = ['b', v > settings.goal ? 'over' : '', ymd(d) === ymd(current) ? 'today' : ''].join(' ');
    return `<div class="col" title="${v} kcal"><small>${v ? v.toLocaleString() : ''}</small>
      <div class="${cls}" style="height:${(v / max) * 70}%"></div><small>${'일월화수목금토'[d.getDay()]}</small></div>`;
  }).join('');
}

// ---------- 사진 처리 ----------
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('사진을 열 수 없어요')); };
    img.src = url;
  });
}
function resized(img, maxSide, quality, square = false) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  if (square) {
    const side = Math.min(img.width, img.height);
    c.width = c.height = maxSide;
    ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, maxSide, maxSide);
  } else {
    const k = Math.min(1, maxSide / Math.max(img.width, img.height));
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    ctx.drawImage(img, 0, 0, c.width, c.height);
  }
  return c.toDataURL('image/jpeg', quality);
}

// ---------- Claude로 칼로리 추정 ----------
const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, amount: { type: 'string' }, kcal: { type: 'integer' } },
        required: ['name', 'amount', 'kcal'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'string', enum: ['낮음', '보통', '높음'] },
    note: { type: 'string' },
  },
  required: ['items', 'confidence', 'note'],
  additionalProperties: false,
};
const SYSTEM = `You estimate calories from food photos for a personal food diary.
List each distinct food or drink you can see, estimate the visible portion, and give an approximate kcal for that portion.
Use typical Korean serving sizes and recipes when the dish is Korean. Round kcal to the nearest 5.
Write name and amount in Korean (amount like "1공기", "약 150g", "1/2인분").
note: one short Korean sentence on anything that makes the estimate uncertain (hidden sauce, unclear portion), or how to get a better estimate.
If the photo contains no food, return an empty items list and say so in note.`;

let sdk;
async function analyzePhoto(dataUrl, hint) {
  if (!settings.apiKey) throw new Error('설정(⚙️)에서 Claude API 키를 먼저 넣어 주세요.');
  sdk ??= (await import(SDK_URL)).default;
  const Anthropic = sdk;
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const req = {
    model: settings.model,
    max_tokens: 8000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: RESULT_SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: dataUrl.split(',')[1] } },
        { type: 'text', text: hint ? `먹은 사람의 메모: ${hint}` : '이 음식의 칼로리를 추정해 주세요.' },
      ],
    }],
  };
  let res;
  try {
    // Haiku 외 모델은 안전 거절 시 다른 모델로 자동 재시도(server-side fallback)
    res = settings.model === 'claude-haiku-5-5'
      ? await client.messages.create(req)
      : await client.beta.messages.create({ ...req, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('API 키가 올바르지 않아요. 설정에서 확인해 주세요.');
    if (err instanceof Anthropic.PermissionDeniedError) throw new Error('이 API 키로는 해당 모델을 쓸 수 없어요.');
    if (err instanceof Anthropic.RateLimitError) throw new Error('요청이 너무 많아요. 잠시 후 다시 시도해 주세요.');
    if (err instanceof Anthropic.BadRequestError) throw new Error(`요청 오류: ${err.message}`);
    if (err instanceof Anthropic.APIConnectionError) throw new Error('인터넷 연결을 확인해 주세요.');
    if (err instanceof Anthropic.APIError) throw new Error(`서버 오류(${err.status ?? '?'}). 잠시 후 다시 시도해 주세요.`);
    throw err;
  }
  if (res.stop_reason === 'refusal') throw new Error('이 사진은 분석할 수 없어요. 직접 입력해 주세요.');
  if (res.stop_reason === 'max_tokens') throw new Error('분석이 중간에 끊겼어요. 다시 시도해 주세요.');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

// ---------- 기록 시트 ----------
let draft = null; // { id?, date, meal, items[], thumb, photo, createdAt, existing }

function openEntry({ entry, photo, thumb } = {}) {
  draft = entry
    ? { ...entry, items: entry.items.map((i) => ({ ...i })), existing: true }
    : { date: ymd(current), meal: guessMeal(), items: [], thumb: thumb || null, photo: photo || null, createdAt: Date.now(), existing: false };
  if (!entry && ymd(current) !== ymd(new Date())) {
    // 지난 날짜에 추가할 때는 그날 정오 기준 시간으로 저장
    const d = new Date(current); d.setHours(12, 0, 0, 0); draft.createdAt = d.getTime();
  }
  $('entryTitle').textContent = entry ? '기록 수정' : photo ? '사진 분석' : '직접 입력';
  $('entryImg').classList.toggle('hidden', !(photo || draft.thumb));
  if (photo || draft.thumb) $('entryImg').src = photo || draft.thumb;
  const awaitingAnalysis = !!photo;
  $('hintField').classList.toggle('hidden', !awaitingAnalysis);
  $('hintInput').value = '';
  $('analyzeBtn').classList.toggle('hidden', !awaitingAnalysis);
  $('saveEntry').classList.toggle('hidden', awaitingAnalysis);
  $('entryForm').classList.toggle('hidden', awaitingAnalysis);
  $('deleteEntry').classList.toggle('hidden', !entry);
  $('aiNote').classList.toggle('hidden', !draft.note);
  $('aiNote').textContent = draft.note || '';
  $('analyzing').classList.add('hidden');
  if (!entry && !photo) draft.items.push({ name: '', amount: '', kcal: 0 });
  renderDraft();
  $('entrySheet').classList.remove('hidden');
}

function renderDraft() {
  $('mealSeg').innerHTML = '';
  for (const m of MEALS) {
    const b = document.createElement('button');
    b.textContent = m;
    b.className = m === draft.meal ? 'on' : '';
    b.onclick = () => { draft.meal = m; renderDraft(); };
    $('mealSeg').appendChild(b);
  }
  const rows = $('itemRows');
  rows.innerHTML = '';
  draft.items.forEach((it, idx) => {
    const r = document.createElement('div');
    r.className = 'row';
    r.innerHTML = `<input placeholder="음식"><input placeholder="양"><input type="number" inputmode="numeric" placeholder="kcal"><button class="del" aria-label="삭제">✕</button>`;
    const [n, a, k] = r.querySelectorAll('input');
    n.value = it.name; a.value = it.amount; k.value = it.kcal || '';
    n.oninput = () => { it.name = n.value; };
    a.oninput = () => { it.amount = a.value; };
    k.oninput = () => { it.kcal = Math.max(0, parseInt(k.value, 10) || 0); updateSum(); };
    r.querySelector('.del').onclick = () => { draft.items.splice(idx, 1); renderDraft(); };
    rows.appendChild(r);
  });
  updateSum();
}
function updateSum() { $('entrySum').textContent = `${draft.items.reduce((s, i) => s + (i.kcal || 0), 0).toLocaleString()} kcal`; }
function closeEntry() { $('entrySheet').classList.add('hidden'); draft = null; }

async function onPhoto(file) {
  if (!file) return;
  try {
    const img = await loadImage(file);
    openEntry({ photo: resized(img, 1024, 0.82), thumb: resized(img, 160, 0.7, true) });
  } catch (e) { toast(e.message); }
}

$('analyzeBtn').onclick = async () => {
  $('analyzeBtn').disabled = true;
  $('hintField').classList.add('hidden');
  $('analyzing').classList.remove('hidden');
  try {
    const r = await analyzePhoto(draft.photo, $('hintInput').value.trim());
    draft.items = r.items.length ? r.items : [{ name: '', amount: '', kcal: 0 }];
    draft.note = `추정 정확도: ${r.confidence}${r.note ? ` · ${r.note}` : ''}`;
    $('aiNote').textContent = draft.note;
    $('aiNote').classList.remove('hidden');
    $('analyzeBtn').classList.add('hidden');
    $('saveEntry').classList.remove('hidden');
    $('entryForm').classList.remove('hidden');
    renderDraft();
  } catch (e) {
    toast(e.message, 4000);
    $('hintField').classList.remove('hidden');
  } finally {
    $('analyzing').classList.add('hidden');
    $('analyzeBtn').disabled = false;
  }
};

$('saveEntry').onclick = async () => {
  const items = draft.items.filter((i) => i.name.trim() || i.kcal);
  if (!items.length) return toast('음식을 하나 이상 넣어 주세요.');
  const entry = {
    id: draft.id || crypto.randomUUID(),
    date: draft.date, meal: draft.meal, items,
    kcal: items.reduce((s, i) => s + (i.kcal || 0), 0),
    thumb: draft.thumb, note: draft.note || '', createdAt: draft.createdAt,
  };
  await putEntry(entry);
  closeEntry();
  toast(`${entry.kcal.toLocaleString()} kcal 기록했어요`);
  render();
};
$('deleteEntry').onclick = async () => {
  if (!confirm('이 기록을 지울까요?')) return;
  await deleteEntry(draft.id);
  closeEntry();
  render();
};
$('cancelEntry').onclick = closeEntry;
$('addItem').onclick = () => { draft.items.push({ name: '', amount: '', kcal: 0 }); renderDraft(); };

// ---------- 설정 시트 ----------
$('openSettings').onclick = () => {
  $('goalInput').value = settings.goal;
  $('keyInput').value = settings.apiKey;
  $('modelInput').value = settings.model;
  $('settingsSheet').classList.remove('hidden');
};
$('closeSettings').onclick = () => {
  settings.goal = Math.max(500, parseInt($('goalInput').value, 10) || 2000);
  settings.apiKey = $('keyInput').value.trim();
  settings.model = $('modelInput').value;
  saveSettings();
  $('settingsSheet').classList.add('hidden');
  render();
};
$('exportBtn').onclick = async () => {
  const blob = new Blob([JSON.stringify({ version: 1, entries: await allEntries() })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `칼로리_백업_${ymd(new Date())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('importBtn').onclick = () => $('importInput').click();
$('importInput').onchange = async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    for (const e of data.entries || []) await putEntry(e);
    toast(`${(data.entries || []).length}개 기록을 불러왔어요`);
    render();
  } catch { toast('백업 파일을 읽을 수 없어요'); }
};

// ---------- 기타 ----------
function toast(msg, ms = 2200) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
for (const id of ['entrySheet', 'settingsSheet']) {
  $(id).addEventListener('click', (ev) => { if (ev.target.id === id) $(id).classList.add('hidden'); });
}
$('prevDay').onclick = () => { current = shiftDay(-1); render(); };
$('nextDay').onclick = () => { current = shiftDay(1); render(); };
$('camBtn').onclick = () => $('camInput').click();
$('galBtn').onclick = () => $('galInput').click();
$('manualBtn').onclick = () => openEntry();
$('camInput').onchange = (ev) => { onPhoto(ev.target.files[0]); ev.target.value = ''; };
$('galInput').onchange = (ev) => { onPhoto(ev.target.files[0]); ev.target.value = ''; };

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
render();
