// 한 끼 칼로리 — 사진 → Claude가 칼로리 추정 → 기기(IndexedDB)에 기록
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.133.0/+esm';
const MEALS = ['아침', '점심', '저녁', '간식'];
const $ = (id) => document.getElementById(id);

// ---------- 설정 (localStorage) ----------
const settings = Object.assign(
  { goal: 2000, apiKey: '', model: 'claude-opus-5-5', webSearch: true },
  safeJSON(localStorageGet('kcal-settings'), {})
);
function saveSettings() { localStorageSet('kcal-settings', JSON.stringify(settings)); }
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function safeJSON(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }

// ---------- 기록 저장소 (IndexedDB) ----------
const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('kcal', 2);
  req.onupgradeneeded = () => {
    const db = req.result;
    // v1: 음식 기록, v2: 체중 기록
    for (const name of ['entries', 'weights']) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' }).createIndex('date', 'date');
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function tx(mode, fn, storeName = 'entries') {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const result = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
const putEntry = (e) => tx('readwrite', (s) => s.put(e));
const deleteEntry = (id) => tx('readwrite', (s) => s.delete(id));
const entriesOn = (date) => tx('readonly', (s) => s.index('date').getAll(date));
const allEntries = () => tx('readonly', (s) => s.getAll());
const putWeight = (w) => tx('readwrite', (s) => s.put(w), 'weights');
const deleteWeight = (id) => tx('readwrite', (s) => s.delete(id), 'weights');
const allWeights = () => tx('readonly', (s) => s.getAll(), 'weights');

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
  renderWeight();
}

async function renderWeight() {
  const list = (await allWeights()).sort((a, b) => b.at - a.at);
  const latest = list[0];
  $('weightNum').textContent = latest ? latest.kg.toFixed(2) : '–';
  if (!latest) { $('weightMeta').textContent = '체중계에 올라가 첫 기록을 남겨 보세요'; return; }
  const d = new Date(latest.at);
  const weekAgo = list.find((w) => w.at <= latest.at - 6 * 864e5);
  let diff = '';
  if (weekAgo) {
    const delta = latest.kg - weekAgo.kg;
    diff = ` · 일주일 전보다 ${delta > 0 ? '+' : ''}${delta.toFixed(1)}kg`;
  }
  $('weightMeta').textContent = `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())} 측정${diff}`;
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

// ---------- 내장 음식 DB (식약처) ----------
// data/foods.json rows: [이름, 브랜드, 100g(ml)당 kcal, 단위, 1회 제공량, 출처구분]
let foodDB = null;
const norm = (s) => s.toLowerCase().replace(/[\s_()\[\]·,.\-/]/g, '');
async function loadFoodDB() {
  if (!foodDB) {
    foodDB = fetch('data/foods.json')
      .then((r) => r.json())
      .then((d) => d.rows.map(([name, brand, per100, unit, serving, origin]) => ({
        name: name.replace(/_/g, ' '), brand, per100, unit, serving, origin, key: norm(name), bkey: norm(brand),
      })));
  }
  return foodDB;
}
function searchFoods(db, query, limit = 6) {
  const q = norm(query);
  if (!q) return [];
  const tokens = query.split(/[\s_]+/).map(norm).filter(Boolean);
  const scored = [];
  for (const f of db) {
    let s;
    if (f.key === q) s = 100;
    else if (f.key.startsWith(q)) s = 80 - (f.key.length - q.length) * 0.5;
    else if (f.key.includes(q)) s = 60 - (f.key.length - q.length) * 0.3;
    else if (tokens.length > 1 && tokens.every((t) => f.key.includes(t) || (f.bkey && f.bkey.includes(t)))) s = 50;
    else continue;
    if (f.brand && !(f.bkey && q.includes(f.bkey))) s -= 15; // 브랜드 이름을 안 썼으면 일반 음식 우선
    s += ORIGIN_BONUS[f.origin] || 0; // 급식은 학생 기준 1인분이라 뒤로
    scored.push([s, f]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const out = [];
  const seen = new Set();
  for (const [, f] of scored) {
    const id = `${fullName(f)}|${f.origin}|${servingKcal(f)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(f);
    if (out.length >= limit) break;
  }
  return out;
}
const ORIGIN_BONUS = { 외식: 4, 가정식: 3, 급식: -3 };
const servingKcal = (f) => Math.round((f.per100 * (f.serving || 100)) / 100);
const fullName = (f) => (f.brand ? `${f.brand} ${f.name}` : f.name);
const refName = (f) => (f.brand ? fullName(f) : `${f.name} (${f.origin})`);

// ---------- Claude로 칼로리 추정 (DB 조회 → 없으면 웹 검색) ----------
const LOOKUP_TOOL = {
  name: 'lookup_food',
  description: 'Search the built-in Korean MFDS food nutrition database (about 19,000 dishes, including franchise menus). '
    + 'Returns up to 5 candidate entries per query with kcal per 100 g or 100 ml and the typical serving size. '
    + 'Use plain Korean dish names (e.g. "김치찌개", "쌀밥", "떡볶이"); try a more generic name if a specific one finds nothing.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: { queries: { type: 'array', items: { type: 'string' }, description: 'One Korean food name per item' } },
    required: ['queries'],
    additionalProperties: false,
  },
};
const SUBMIT_TOOL = {
  name: 'submit_result',
  description: 'Submit the final calorie estimate. Call exactly once, after looking up every item.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Korean food name' },
            amount: { type: 'string', description: 'Korean portion description, e.g. "1공기 (약 210g)"' },
            grams: { type: 'number', description: 'Estimated eaten amount in g (or ml for soups and drinks)' },
            kcal: { type: 'integer' },
            source: { type: 'string', enum: ['식약처', '웹검색', 'AI추정'] },
            ref: { type: 'string', description: 'Matched database entry name, or the website used; empty for AI추정' },
          },
          required: ['name', 'amount', 'grams', 'kcal', 'source', 'ref'],
          additionalProperties: false,
        },
      },
      confidence: { type: 'string', enum: ['낮음', '보통', '높음'] },
      note: { type: 'string', description: 'One short Korean sentence about what makes the estimate uncertain' },
    },
    required: ['items', 'confidence', 'note'],
    additionalProperties: false,
  },
};
function systemPrompt(web) {
  return `You estimate calories of the food in a photo for a personal food diary. The user is Korean.
1. Identify each distinct food or drink and estimate the eaten portion in grams (ml for soups, stews and drinks). Use typical Korean portions for Korean dishes.
2. Call lookup_food once with every item name. Entries give kcal per 100 g or 100 ml from the Korean MFDS database, plus a typical serving size. The label in parentheses is the data basis: 외식 (restaurant), 가정식 (home), 급식 (school or cafeteria meals, smaller portions); values for the same dish can differ, so pick the entry closest to what is in the photo.
3. For each item with a reasonable database match: kcal = kcal_per_100 × portion ÷ 100, source "식약처", ref = the matched entry name. Prefer generic entries over franchise ones unless the brand is visible.
4. ${web
    ? 'Only for items with no reasonable match, use web_search (prefer Korean nutrition or official sites) and compute kcal for the portion; source "웹검색", ref = the site name. If the search does not help, estimate: source "AI추정", ref "".'
    : 'For items with no reasonable match, estimate from your own knowledge: source "AI추정", ref "".'}
5. Finish by calling submit_result exactly once. Write name and amount in Korean. Round kcal to the nearest 5.
If the photo contains no food, submit an empty items list and say so in note.`;
}

let sdk;
async function analyzePhoto(dataUrl, hint, onStep = () => {}) {
  if (!settings.apiKey) throw new Error('설정(⚙️)에서 Claude API 키를 먼저 넣어 주세요.');
  const [db, mod] = await Promise.all([loadFoodDB(), sdk ? null : import(SDK_URL)]);
  sdk ??= mod.default;
  const Anthropic = sdk;
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const isHaiku = settings.model === 'claude-haiku-5-5';
  const tools = [LOOKUP_TOOL, SUBMIT_TOOL];
  if (settings.webSearch) {
    tools.push({ type: isHaiku ? 'web_search_20250305' : 'web_search_20260209', name: 'web_search', max_uses: 3 });
  }
  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: dataUrl.split(',')[1] } },
      { type: 'text', text: hint ? `먹은 사람의 메모: ${hint}` : '이 음식의 칼로리를 계산해 주세요.' },
    ],
  }];
  const base = { model: settings.model, max_tokens: 16000, system: systemPrompt(settings.webSearch), tools, output_config: { effort: 'low' } };

  for (let turn = 0; turn < 8; turn++) {
    let res;
    try {
      // Haiku 외 모델은 안전 거절 시 다른 모델로 자동 재시도(server-side fallback)
      res = isHaiku
        ? await client.messages.create({ ...base, messages })
        : await client.beta.messages.create({ ...base, messages, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
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

    const submit = res.content.find((b) => b.type === 'tool_use' && b.name === 'submit_result');
    if (submit) return submit.input;

    messages.push({ role: 'assistant', content: res.content });
    if (res.content.some((b) => b.type === 'server_tool_use')) onStep('인터넷에서 찾아보고 있어요…');
    if (res.stop_reason === 'pause_turn') continue; // 웹 검색이 길어져 잠시 멈춤 → 그대로 이어서 요청

    const lookups = res.content.filter((b) => b.type === 'tool_use');
    if (!lookups.length) break;
    onStep('식약처 데이터에서 찾고 있어요…');
    messages.push({
      role: 'user',
      content: lookups.map((b) => {
        if (b.name !== 'lookup_food') {
          return { type: 'tool_result', tool_use_id: b.id, content: `Unknown tool ${b.name}`, is_error: true };
        }
        const results = b.input.queries.map((q) => ({
          query: q,
          matches: searchFoods(db, q, 5).map((f) => ({
            name: refName(f), kcal_per_100: f.per100, unit: f.unit, serving: `${f.serving || 100}${f.unit}`, serving_kcal: servingKcal(f),
          })),
        }));
        return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(results) };
      }),
    });
  }
  throw new Error('분석 결과를 받지 못했어요. 다시 시도해 주세요.');
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
    const wrap = document.createElement('div');
    wrap.className = 'item';
    wrap.innerHTML = `<div class="row"><input placeholder="음식 (검색)"><input placeholder="양"><input type="number" inputmode="numeric" placeholder="kcal"><button class="del" aria-label="삭제">✕</button></div>
      <div class="src"></div><div class="suggest hidden"></div>`;
    const [n, a, k] = wrap.querySelectorAll('input');
    const src = wrap.querySelector('.src');
    const sug = wrap.querySelector('.suggest');
    const showSrc = () => {
      src.innerHTML = it.source ? `<span class="tag t-${it.source}">${it.source}</span> <span></span>` : '';
      if (it.source) src.lastChild.textContent = it.ref || '';
    };
    n.value = it.name; a.value = it.amount; k.value = it.kcal || '';
    showSrc();
    n.oninput = async () => {
      it.name = n.value;
      const db = await loadFoodDB();
      const found = n.value.trim() ? searchFoods(db, n.value, 6) : [];
      sug.innerHTML = '';
      for (const f of found) {
        const b = document.createElement('button');
        b.innerHTML = '<span></span><b></b>';
        b.firstChild.textContent = refName(f);
        b.lastChild.textContent = `${f.serving || 100}${f.unit} · ${servingKcal(f)}kcal`;
        b.onclick = () => {
          Object.assign(it, { name: f.name, amount: `${f.serving || 100}${f.unit}`, kcal: servingKcal(f), source: '식약처', ref: refName(f), per100: f.per100 });
          renderDraft();
        };
        sug.appendChild(b);
      }
      sug.classList.toggle('hidden', !found.length);
    };
    n.onblur = () => setTimeout(() => sug.classList.add('hidden'), 200);
    a.oninput = () => {
      it.amount = a.value;
      const grams = parseFloat(a.value.replace(/[^\d.]/g, ''));
      if (it.per100 && grams > 0) { it.kcal = Math.round((it.per100 * grams) / 100); k.value = it.kcal; updateSum(); }
    };
    k.oninput = () => {
      it.kcal = Math.max(0, parseInt(k.value, 10) || 0);
      Object.assign(it, { source: '직접', ref: '', per100: 0 });
      showSrc();
      updateSum();
    };
    wrap.querySelector('.del').onclick = () => { draft.items.splice(idx, 1); renderDraft(); };
    rows.appendChild(wrap);
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
  $('analyzeMsg').textContent = '사진을 보고 있어요…';
  $('hintField').classList.add('hidden');
  $('analyzing').classList.remove('hidden');
  try {
    const r = await analyzePhoto(draft.photo, $('hintInput').value.trim(), (msg) => { $('analyzeMsg').textContent = msg; });
    draft.items = r.items.length
      ? r.items.map((i) => ({ name: i.name, amount: i.amount, kcal: i.kcal, source: i.source, ref: i.ref, per100: i.grams > 0 ? (i.kcal * 100) / i.grams : 0 }))
      : [{ name: '', amount: '', kcal: 0 }];
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
  $('webInput').checked = settings.webSearch;
  $('settingsSheet').classList.remove('hidden');
};
$('closeSettings').onclick = () => {
  settings.goal = Math.max(500, parseInt($('goalInput').value, 10) || 2000);
  settings.apiKey = $('keyInput').value.trim();
  settings.model = $('modelInput').value;
  settings.webSearch = $('webInput').checked;
  saveSettings();
  $('settingsSheet').classList.add('hidden');
  render();
};
$('exportBtn').onclick = async () => {
  const blob = new Blob([JSON.stringify({ version: 2, entries: await allEntries(), weights: await allWeights() })], { type: 'application/json' });
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
    for (const w of data.weights || []) await putWeight(w);
    toast(`음식 ${(data.entries || []).length}개 · 체중 ${(data.weights || []).length}개를 불러왔어요`);
    render();
  } catch { toast('백업 파일을 읽을 수 없어요'); }
};

// ---------- 체중계 (앳플리 T8, 블루투스) ----------
// 2026-10-25 대표님 체중계(T8_SR405) 기록으로 해독: 서비스 0xffb0, 알림 0xffb2, 20바이트
// ac 27 .. [b3 b4 b5] .. : 무게 = ((b3 & 0x1f) << 16 | b4 << 8 | b5) / 1000 kg, 0.25초마다 옴
const SCALE_SERVICE = 0xffb0;
const SCALE_NOTIFY = 0xffb2;
const STABLE_COUNT = 6; // 같은 값이 6번(약 1.5초) 이어지면 측정 끝으로 봄
function parseScale(dv) {
  if (dv.byteLength < 6 || dv.getUint8(0) !== 0xac || dv.getUint8(1) !== 0x27) return null;
  return (((dv.getUint8(3) & 0x1f) << 16) | (dv.getUint8(4) << 8) | dv.getUint8(5)) / 1000;
}

let scale = null; // { device, kg, done }
function openWeight(kg = null) {
  scale = { device: null, kg, done: kg != null };
  $('scaleNum').textContent = kg != null ? kg.toFixed(2) : '–';
  $('scaleMsg').textContent = kg != null ? '측정이 끝났어요. 저장해 주세요.' : '체중계를 한 번 밟아 켠 뒤 연결을 눌러 주세요.';
  $('scaleConnect').classList.toggle('hidden', kg != null);
  $('weightManual').value = kg != null ? kg.toFixed(2) : '';
  $('weightSave').disabled = kg == null;
  renderWeightList();
  $('weightSheet').classList.remove('hidden');
}
function closeWeight() {
  if (scale?.device?.gatt?.connected) scale.device.gatt.disconnect();
  scale = null;
  $('weightSheet').classList.add('hidden');
}
async function connectScale() {
  if (!navigator.bluetooth) return toast('이 브라우저는 블루투스를 지원하지 않아요. 안드로이드 크롬에서 열어 주세요.', 3500);
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'T8' }, { services: [SCALE_SERVICE] }],
      optionalServices: [SCALE_SERVICE],
    });
    scale.device = device;
    $('scaleMsg').textContent = '연결하는 중…';
    const server = await device.gatt.connect();
    const ch = await (await server.getPrimaryService(SCALE_SERVICE)).getCharacteristic(SCALE_NOTIFY);
    let last = null;
    let same = 0;
    ch.addEventListener('characteristicvaluechanged', (ev) => {
      if (!scale || scale.done) return;
      const kg = parseScale(ev.target.value);
      if (kg == null) return;
      $('scaleNum').textContent = kg ? kg.toFixed(2) : '0.00';
      same = kg === last ? same + 1 : 0;
      last = kg;
      if (kg >= 10 && same >= STABLE_COUNT) {
        scale.done = true;
        scale.kg = kg;
        $('scaleMsg').textContent = '✅ 측정 끝! 내려오셔도 돼요.';
        $('weightManual').value = kg.toFixed(2);
        $('weightSave').disabled = false;
        if (navigator.vibrate) navigator.vibrate(150);
        device.gatt.disconnect();
      } else if (kg >= 10) {
        $('scaleMsg').textContent = '측정 중… 가만히 서 계세요';
      }
    });
    device.addEventListener('gattserverdisconnected', () => {
      if (scale && !scale.done) $('scaleMsg').textContent = '연결이 끊겼어요. 다시 연결을 눌러 주세요.';
    });
    await ch.startNotifications();
    $('scaleConnect').classList.add('hidden');
    $('scaleMsg').textContent = '연결됐어요! 맨발로 체중계에 올라가세요.';
  } catch (e) {
    if (e.name !== 'NotFoundError') $('scaleMsg').textContent = `연결 실패: ${e.message}`;
  }
}
async function renderWeightList() {
  const list = (await allWeights()).sort((a, b) => b.at - a.at).slice(0, 10);
  const box = $('weightList');
  box.innerHTML = list.length ? '' : '<p class="small">아직 기록이 없어요.</p>';
  for (const w of list) {
    const d = new Date(w.at);
    const row = document.createElement('div');
    row.className = 'wrow';
    row.innerHTML = `<span>${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}</span>
      <b>${w.kg.toFixed(2)} kg</b><small>${w.source}</small><button class="del" aria-label="삭제">✕</button>`;
    row.querySelector('.del').onclick = async () => {
      if (!confirm('이 체중 기록을 지울까요?')) return;
      await deleteWeight(w.id);
      renderWeightList();
      renderWeight();
    };
    box.appendChild(row);
  }
}
$('weightCard').onclick = () => openWeight();
$('scaleConnect').onclick = connectScale;
$('weightManual').oninput = () => { $('weightSave').disabled = !(parseFloat($('weightManual').value) > 0); };
$('weightSave').onclick = async () => {
  const kg = parseFloat($('weightManual').value);
  if (!(kg > 0)) return;
  const at = Date.now();
  const fromScale = scale?.kg != null && Math.abs(kg - scale.kg) < 0.001;
  await putWeight({ id: crypto.randomUUID(), date: ymd(new Date(at)), at, kg, source: fromScale ? '체중계' : '직접' });
  closeWeight();
  toast(`${kg.toFixed(2)}kg 기록했어요`);
  renderWeight();
};
$('weightClose').onclick = closeWeight;

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
$('weightSheet').addEventListener('click', (ev) => { if (ev.target.id === 'weightSheet') closeWeight(); });
$('prevDay').onclick = () => { current = shiftDay(-1); render(); };
$('nextDay').onclick = () => { current = shiftDay(1); render(); };
$('camBtn').onclick = () => $('camInput').click();
$('galBtn').onclick = () => $('galInput').click();
$('manualBtn').onclick = () => openEntry();
$('camInput').onchange = (ev) => { onPhoto(ev.target.files[0]); ev.target.value = ''; };
$('galInput').onchange = (ev) => { onPhoto(ev.target.files[0]); ev.target.value = ''; };

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
render();
loadFoodDB().catch(() => { foodDB = null; }); // 직접 입력 검색이 바로 되도록 미리 불러 둠
