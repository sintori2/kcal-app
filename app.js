// 한 끼 칼로리 — 사진 → Claude가 칼로리 추정 → 기기(IndexedDB)에 기록
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.133.0/+esm';
const MEALS = ['아침', '점심', '저녁', '간식'];
const $ = (id) => document.getElementById(id);

// ---------- 설정 (localStorage) ----------
const settings = Object.assign(
  {
    goal: 2000, apiKey: '', model: 'claude-opus-5-5', webSearch: true, localAI: true,
    // 목표 자동 계산용 프로필
    autoGoal: false, sex: 'male', birthYear: 2001, height: 175, activity: 1.375, pace: -0.5,
  },
  safeJSON(localStorageGet('kcal-settings'), {})
);
function saveSettings() { localStorageSet('kcal-settings', JSON.stringify(settings)); }
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function safeJSON(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }

// ---------- 기록 저장소 (IndexedDB) ----------
const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('kcal', 3);
  req.onupgradeneeded = () => {
    const db = req.result;
    // v1: 음식 기록, v2: 체중 기록, v3: 바코드 제품
    for (const name of ['entries', 'weights']) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' }).createIndex('date', 'date');
    }
    if (!db.objectStoreNames.contains('products')) db.createObjectStore('products', { keyPath: 'code' });
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
const getProduct = (code) => tx('readonly', (s) => s.get(code), 'products');
const putProduct = (p) => tx('readwrite', (s) => s.put(p), 'products');
const latestWeight = async () => (await allWeights()).sort((a, b) => b.at - a.at)[0] || null;

// ---------- 목표 (프로필로 자동 계산) ----------
// Mifflin-St Jeor 기초대사량 × 활동량 = 하루 소모량, 주당 목표 변화량(kg) × 7700kcal ÷ 7 만큼 더하거나 뺌
function computeGoal(kg) {
  if (!kg) return null;
  const age = new Date().getFullYear() - settings.birthYear;
  const bmr = 10 * kg + 6.25 * settings.height - 5 * age + (settings.sex === 'male' ? 5 : -161);
  const tdee = bmr * settings.activity;
  const floor = settings.sex === 'male' ? 1500 : 1200;
  const goal = Math.max(floor, Math.round((tdee + (settings.pace * 7700) / 7) / 10) * 10);
  return { bmr: Math.round(bmr), tdee: Math.round(tdee), goal };
}
const proteinTarget = (kg) => Math.round((kg || 65) * (settings.activity >= 1.55 ? 1.6 : 1.2));
let goalCache = { goal: settings.goal, protein: proteinTarget(null) };
async function refreshGoal() {
  const w = await latestWeight();
  const auto = settings.autoGoal ? computeGoal(w?.kg) : null;
  goalCache = { goal: auto ? auto.goal : settings.goal, protein: proteinTarget(w?.kg), detail: auto };
  return goalCache;
}

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
  const { goal, protein } = await refreshGoal();
  const total = list.reduce((s, e) => s + e.kcal, 0);
  $('totalNum').textContent = total.toLocaleString();
  $('goalLabel').textContent = `/ ${goal.toLocaleString()} kcal${settings.autoGoal ? ' (자동)' : ''}`;
  $('barFill').style.width = `${Math.min(100, (total / goal) * 100)}%`;
  $('bar').classList.toggle('over', total > goal);
  const left = goal - total;
  $('remain').textContent = left >= 0 ? `${left.toLocaleString()} kcal 남았어요` : `${(-left).toLocaleString()} kcal 넘었어요`;
  const m = sumMacros(list.flatMap((e) => e.items));
  $('macroCarb').textContent = `${Math.round(m.carb)}g`;
  $('macroProtein').textContent = `${Math.round(m.protein)} / ${protein}g`;
  $('macroFat').textContent = `${Math.round(m.fat)}g`;
  $('proteinFill').style.width = `${Math.min(100, (m.protein / protein) * 100)}%`;

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
  renderTrend();
  renderWeight();
  renderReport();
}
const sumMacros = (items) => items.reduce(
  (s, i) => ({ carb: s.carb + (i.carb || 0), protein: s.protein + (i.protein || 0), fat: s.fat + (i.fat || 0) }),
  { carb: 0, protein: 0, fat: 0 }
);

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

// ---------- 추이 그래프: 섭취 칼로리(막대) / 체중(선) — 축이 달라서 두 개로 나눠 그림 ----------
let trendDays = 7;
async function renderTrend() {
  const [entries, weights] = await Promise.all([allEntries(), allWeights()]);
  const kcalBy = {};
  for (const e of entries) kcalBy[e.date] = (kcalBy[e.date] || 0) + e.kcal;
  const kgBy = {};
  for (const w of weights.sort((a, b) => a.at - b.at)) kgBy[w.date] = w.kg; // 하루 여러 번이면 마지막 값
  const days = [];
  for (let i = trendDays - 1; i >= 0; i--) { const d = new Date(current); d.setDate(d.getDate() - i); days.push(d); }
  const goal = goalCache.goal;
  const W = 340, H = 120, padL = 8, padR = 8, top = 14, bottom = 20;
  const step = (W - padL - padR) / days.length;
  const xLabel = (d, i) => (trendDays === 7 ? '일월화수목금토'[d.getDay()] : (i % 5 === 4 || i === days.length - 1 ? `${d.getMonth() + 1}/${d.getDate()}` : ''));

  // 칼로리 막대
  const kmax = Math.max(goal * 1.15, ...days.map((d) => kcalBy[ymd(d)] || 0));
  const ky = (v) => top + (H - top - bottom) * (1 - v / kmax);
  const bw = Math.max(3, step - 4);
  let svg = `<line class="goal" x1="${padL}" x2="${W - padR}" y1="${ky(goal)}" y2="${ky(goal)}"/>
    <text class="axis" x="${W - padR}" y="${ky(goal) - 4}" text-anchor="end">목표 ${goal.toLocaleString()}</text>`;
  days.forEach((d, i) => {
    const v = kcalBy[ymd(d)] || 0;
    const x = padL + i * step + (step - bw) / 2;
    const y = ky(v);
    const h = H - bottom - y;
    if (v) svg += `<path class="kbar${v > goal ? ' over' : ''}" d="M${x},${H - bottom}V${y + Math.min(4, h)}q0,-${Math.min(4, h)} ${Math.min(4, bw / 2)},-${Math.min(4, h)}H${x + bw - Math.min(4, bw / 2)}q${Math.min(4, bw / 2)},0 ${Math.min(4, bw / 2)},${Math.min(4, h)}V${H - bottom}Z"/>`;
    svg += `<rect class="hit" x="${padL + i * step}" y="0" width="${step}" height="${H}" data-tip="${d.getMonth() + 1}/${d.getDate()} · ${v ? `${v.toLocaleString()} kcal` : '기록 없음'}"/>`;
    svg += `<text class="axis" x="${padL + i * step + step / 2}" y="${H - 5}" text-anchor="middle">${xLabel(d, i)}</text>`;
  });
  $('trendKcal').innerHTML = svg;

  // 체중 선
  const pts = days.map((d, i) => ({ i, d, kg: kgBy[ymd(d)] })).filter((p) => p.kg);
  if (!pts.length) {
    $('trendKg').innerHTML = `<text class="axis" x="${W / 2}" y="50" text-anchor="middle">이 기간 체중 기록이 없어요</text>`;
  } else {
    const lo = Math.min(...pts.map((p) => p.kg)) - 0.5;
    const hi = Math.max(...pts.map((p) => p.kg)) + 0.5;
    const wy = (v) => 12 + (100 - 12 - 18) * (1 - (v - lo) / (hi - lo));
    const wx = (i) => padL + i * step + step / 2;
    let s = `<polyline class="wline" points="${pts.map((p) => `${wx(p.i)},${wy(p.kg)}`).join(' ')}"/>`;
    for (const p of pts) {
      s += `<circle class="wdot" cx="${wx(p.i)}" cy="${wy(p.kg)}" r="4"/>`;
      s += `<rect class="hit" x="${padL + p.i * step}" y="0" width="${step}" height="100" data-tip="${p.d.getMonth() + 1}/${p.d.getDate()} · ${p.kg.toFixed(2)} kg"/>`;
    }
    const first = pts[0];
    const last = pts[pts.length - 1];
    s += `<text class="axis strong" x="${wx(last.i)}" y="${wy(last.kg) - 9}" text-anchor="${last.i > days.length - 3 ? 'end' : 'middle'}">${last.kg.toFixed(1)}</text>`;
    if (pts.length > 1) s += `<text class="axis" x="${wx(first.i)}" y="${wy(first.kg) - 9}" text-anchor="${first.i < 2 ? 'start' : 'middle'}">${first.kg.toFixed(1)}</text>`;
    $('trendKg').innerHTML = s;
  }
  for (const r of document.querySelectorAll('#trendCard .hit')) {
    r.onclick = () => { $('trendTip').textContent = r.dataset.tip; };
    r.onmouseenter = r.onclick;
  }
  $('trendTip').textContent = '막대나 점을 누르면 값이 보여요';
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
// data/foods.json rows: [이름, 브랜드, 100g(ml)당 kcal, 단위, 1회 제공량, 출처구분, 탄, 단, 지(100g당 g)]
let foodDB = null;
const norm = (s) => s.toLowerCase().replace(/[\s_()\[\]·,.\-/]/g, '');
async function loadFoodDB() {
  if (!foodDB) {
    foodDB = fetch('data/foods.json')
      .then((r) => r.json())
      .then((d) => d.rows.map(([name, brand, per100, unit, serving, origin, c, p, f]) => ({
        name: name.replace(/_/g, ' '), brand, per100, unit, serving, origin, m100: [c, p, f], key: norm(name), bkey: norm(brand),
      })));
  }
  return foodDB;
}
const r1 = (v) => Math.round(v * 10) / 10;
// 100g당 값(per100, m100)과 먹은 양(g)으로 kcal·탄단지 계산
function scaleItem(it, grams) {
  it.kcal = Math.round((it.per100 * grams) / 100);
  if (it.m100) [it.carb, it.protein, it.fat] = it.m100.map((v) => r1((v * grams) / 100));
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
            carb: { type: 'number', description: 'Carbohydrate in g for the eaten portion' },
            protein: { type: 'number', description: 'Protein in g for the eaten portion' },
            fat: { type: 'number', description: 'Fat in g for the eaten portion' },
            source: { type: 'string', enum: ['식약처', '웹검색', 'AI추정'] },
            ref: { type: 'string', description: 'Matched database entry name, or the website used; empty for AI추정' },
          },
          required: ['name', 'amount', 'grams', 'kcal', 'carb', 'protein', 'fat', 'source', 'ref'],
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
3. For each item with a reasonable database match: kcal = kcal_per_100 × portion ÷ 100 (carb, protein and fat the same way from their per-100 values), source "식약처", ref = the matched entry name. Prefer generic entries over franchise ones unless the brand is visible.
4. ${web
    ? 'Only for items with no reasonable match, use web_search (prefer Korean nutrition or official sites) and compute kcal for the portion; source "웹검색", ref = the site name. If the search does not help, estimate: source "AI추정", ref "".'
    : 'For items with no reasonable match, estimate from your own knowledge: source "AI추정", ref "".'}
5. Finish by calling submit_result exactly once. Write name and amount in Korean. Round kcal to the nearest 5.
If the photo contains no food, submit an empty items list and say so in note.`;
}

// Claude 호출 공통: SDK 불러오기, 거절 시 자동 재시도(Haiku 제외), 오류를 한국어로
let sdk;
async function callClaude(params) {
  if (!settings.apiKey) throw new Error('설정(⚙️)에서 Claude API 키를 먼저 넣어 주세요.');
  sdk ??= (await import(SDK_URL)).default;
  const Anthropic = sdk;
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const req = { model: settings.model, ...params };
  let res;
  try {
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
  if (res.stop_reason === 'refusal') throw new Error('이 요청은 처리할 수 없어요. 직접 입력해 주세요.');
  if (res.stop_reason === 'max_tokens') throw new Error('응답이 중간에 끊겼어요. 다시 시도해 주세요.');
  return res;
}
const textOf = (res) => res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

async function analyzePhoto(dataUrl, hint, onStep = () => {}) {
  if (!settings.apiKey) throw new Error('설정(⚙️)에서 Claude API 키를 먼저 넣어 주세요.');
  const db = await loadFoodDB();
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
  const base = { max_tokens: 16000, system: systemPrompt(settings.webSearch), tools, output_config: { effort: 'low' } };

  for (let turn = 0; turn < 8; turn++) {
    const res = await callClaude({ ...base, messages });

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
            name: refName(f), kcal_per_100: f.per100, carb_per_100: f.m100[0], protein_per_100: f.m100[1], fat_per_100: f.m100[2],
            unit: f.unit, serving: `${f.serving || 100}${f.unit}`, serving_kcal: servingKcal(f),
          })),
        }));
        return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(results) };
      }),
    });
  }
  throw new Error('분석 결과를 받지 못했어요. 다시 시도해 주세요.');
}

// ---------- 내 AI (폰 안에서 도는 음식 인식 모델, 무료·오프라인) ----------
// model/food.onnx: AI Hub 한국 이미지(음식) 150종으로 학습한 MobileNetV3 (_train/train.py)
const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
let foodModel = null;
async function loadFoodModel() {
  if (!foodModel) {
    foodModel = (async () => {
      const ort = await import(`${ORT_URL}ort.min.mjs`);
      ort.env.wasm.wasmPaths = ORT_URL;
      const [session, classes] = await Promise.all([
        ort.InferenceSession.create('model/food.onnx', { executionProviders: ['wasm'] }),
        fetch('model/classes.json').then((r) => r.json()),
      ]);
      return { ort, session, classes };
    })();
    foodModel.catch(() => { foodModel = null; });
  }
  return foodModel;
}
async function classifyFood(dataUrl) {
  const { ort, session, classes } = await loadFoodModel();
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('사진을 열 수 없어요'));
    im.src = dataUrl;
  });
  // 학습 때와 같게: 짧은 변 224로 줄이고 가운데 224×224, ImageNet 평균·표준편차로 정규화
  const S = 224;
  const k = S / Math.min(img.width, img.height);
  const w = Math.round(img.width * k);
  const h = Math.round(img.height * k);
  const c = document.createElement('canvas');
  c.width = c.height = S;
  c.getContext('2d').drawImage(img, -(w - S) / 2, -(h - S) / 2, w, h);
  const px = c.getContext('2d').getImageData(0, 0, S, S).data;
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const input = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) {
    for (let ch = 0; ch < 3; ch++) input[ch * S * S + i] = (px[i * 4 + ch] / 255 - mean[ch]) / std[ch];
  }
  const out = await session.run({ image: new ort.Tensor('float32', input, [1, 3, S, S]) });
  const logits = out.logits.data;
  const max = Math.max(...logits);
  const exps = Array.from(logits, (v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v, i) => ({ name: classes[i], p: v / sum })).sort((a, b) => b.p - a.p).slice(0, 4);
}
// AI Hub 음식 이름이 식약처 데이터와 다르게 적힌 것들
const FOOD_ALIAS = {
  간장게장: '게장 간장', 양념게장: '게장 양념', 감자채볶음: '감자볶음 감자만', 계란국: '달걀국', 계란말이: '달걀말이',
  계란찜: '달걀찜', 고추장진미채볶음: '오징어채볶음', 곰탕_설렁탕: '설렁탕', 닭계장: '육개장', 도라지무침: '도라지생채',
  떡국_만두국: '떡국', 북엇국: '북어국', 소세지볶음: '소시지볶음', 시래기국: '시래기 된장국', 젓갈: '오징어젓 양념',
  한과: '약과', 삼겹살: '삼겹살구이',
  만두: '만두 고기만두', 새우볶음밥: '볶음밥 새우',
};
// 식약처 데이터에 없는 음식: 일반적인 참고값 (100g당 kcal, 1인분 g)
const FOOD_EXTRA = {
  계란후라이: [196, 50], 떡꼬치: [230, 100], 산낙지: [70, 150], 과메기: [220, 100], 열무국수: [80, 550], 꽈리고추무침: [60, 70],
  멍게: [70, 100], 양념치킨: [290, 250], 후라이드치킨: [270, 250], 수정과: [60, 200],
  // 식약처엔 급식 소량(80ml)만 있거나 여럿이 나눠 먹는 양(1.5kg)이라 1인분 참고값으로
  보쌈: [290, 200], 수육: [290, 200], 편육: [250, 150], 찜닭: [150, 450],
};
// 같은 음식이라도 식약처 데이터엔 100g 기준값·급식·세트상품이 섞여 있어서,
// 이름이 가장 가깝고 실제 1인분 양(100g 초과)이 적힌 일반 음식들 중 가운데 값을 고름
function pickServing(db, query) {
  const q = norm(query);
  const cands = db.filter((f) => !f.brand && f.key.includes(q));
  // 이름이 똑같은 것 → 이름으로 시작하는 것(김치찌개 꽁치 등) → 이름을 포함하는 것 순으로 고름
  const pool = [(f) => f.key === q, (f) => f.key.startsWith(q), () => true]
    .map((test) => cands.filter(test)).find((list) => list.length);
  if (!pool) return null;
  const real = pool.filter((f) => f.serving > 100 && f.serving <= 900 && f.origin !== '급식');
  const use = (real.length ? real : pool).slice().sort((a, b) => servingKcal(a) - servingKcal(b));
  return use[Math.floor((use.length - 1) / 2)];
}
// 인식한 음식 이름 → 식약처 데이터에서 1인분 칼로리
async function itemForFood(name, p) {
  const db = await loadFoodDB();
  const label = name.replace(/_/g, '·');
  const ref = `내 AI ${Math.round(p * 100)}%`;
  if (FOOD_EXTRA[name]) {
    const [per100, g] = FOOD_EXTRA[name];
    const it = { name: label, amount: `${g}g`, source: '내AI', ref: `${ref} · 일반 참고값`, per100, m100: null };
    scaleItem(it, g);
    return it;
  }
  const f = pickServing(db, FOOD_ALIAS[name] || name);
  if (!f) return { name: label, amount: '1인분', kcal: 0, source: '내AI', ref: `${ref} · 칼로리 데이터 없음` };
  const it = { name: f.name, amount: `${f.serving || 100}${f.unit}`, source: '내AI', ref: `${ref} · ${refName(f)}`, per100: f.per100, m100: f.m100 };
  scaleItem(it, f.serving || 100);
  return it;
}
async function runLocalAI() {
  const d = draft;
  $('analyzing').classList.remove('hidden');
  $('analyzeMsg').textContent = '내 AI가 보고 있어요…';
  try {
    const top = await classifyFood(d.photo);
    if (draft !== d) return;
    d.items = [await itemForFood(top[0].name, top[0].p)];
    d.note = top[0].p < 0.5 ? '내 AI가 확신이 낮아요. 아래 후보를 고르거나 Claude로 자세히 분석해 보세요.' : '';
    $('aiNote').textContent = d.note;
    $('aiNote').classList.toggle('hidden', !d.note);
    const box = $('aiCandidates');
    box.innerHTML = '';
    for (const c of top) {
      const b = document.createElement('button');
      b.textContent = `${c.name} ${Math.round(c.p * 100)}%`;
      b.className = c === top[0] ? 'on' : '';
      b.onclick = async () => {
        d.items[0] = await itemForFood(c.name, c.p);
        for (const x of box.children) x.classList.toggle('on', x === b);
        renderDraft();
      };
      box.appendChild(b);
    }
    box.classList.remove('hidden');
    $('entryForm').classList.remove('hidden');
    $('saveEntry').classList.remove('hidden');
    $('analyzeBtn').textContent = '🤖 Claude로 자세히';
    renderDraft();
  } catch (e) {
    toast(`내 AI를 쓸 수 없어요: ${e.message}`, 3500);
  } finally {
    $('analyzing').classList.add('hidden');
  }
}

// ---------- 기록 시트 ----------
let draft = null; // { id?, date, meal, items[], thumb, photo, createdAt, existing }

function openEntry({ entry, photo, thumb, items, title, barcode } = {}) {
  draft = entry
    ? { ...entry, items: entry.items.map((i) => ({ ...i })), existing: true }
    : { date: ymd(current), meal: guessMeal(), items: items || [], thumb: thumb || null, photo: photo || null, createdAt: Date.now(), existing: false, barcode };
  if (!entry && ymd(current) !== ymd(new Date())) {
    // 지난 날짜에 추가할 때는 그날 정오 기준 시간으로 저장
    const d = new Date(current); d.setHours(12, 0, 0, 0); draft.createdAt = d.getTime();
  }
  $('entryTitle').textContent = title || (entry ? '기록 수정' : photo ? '사진 분석' : '직접 입력');
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
  $('aiCandidates').classList.add('hidden');
  $('analyzeBtn').textContent = '분석하기';
  if (!entry && !photo && !draft.items.length) draft.items.push({ name: '', amount: '', kcal: 0 });
  renderDraft();
  $('entrySheet').classList.remove('hidden');
  if (photo && settings.localAI) runLocalAI();
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
      const macro = it.carb || it.protein || it.fat ? ` · 탄 ${r1(it.carb || 0)} 단 ${r1(it.protein || 0)} 지 ${r1(it.fat || 0)}g` : '';
      src.innerHTML = it.source ? `<span class="tag t-${it.source}">${it.source}</span> <span></span>` : '<span></span>';
      src.lastChild.textContent = (it.ref || '') + macro;
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
          Object.assign(it, { name: f.name, amount: `${f.serving || 100}${f.unit}`, source: '식약처', ref: refName(f), per100: f.per100, m100: f.m100 });
          scaleItem(it, f.serving || 100);
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
      if (it.per100 && grams > 0) { scaleItem(it, grams); k.value = it.kcal; showSrc(); updateSum(); }
    };
    k.oninput = () => {
      it.kcal = Math.max(0, parseInt(k.value, 10) || 0);
      Object.assign(it, { source: '직접', ref: '', per100: 0, m100: null, carb: 0, protein: 0, fat: 0 });
      showSrc();
      updateSum();
    };
    wrap.querySelector('.del').onclick = () => { draft.items.splice(idx, 1); renderDraft(); };
    rows.appendChild(wrap);
  });
  updateSum();
}
function updateSum() {
  const m = sumMacros(draft.items);
  $('entrySum').textContent = `${draft.items.reduce((s, i) => s + (i.kcal || 0), 0).toLocaleString()} kcal`;
  $('entryMacro').textContent = `탄 ${Math.round(m.carb)}g · 단 ${Math.round(m.protein)}g · 지 ${Math.round(m.fat)}g`;
}
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
      ? r.items.map((i) => ({
        name: i.name, amount: i.amount, kcal: i.kcal, carb: r1(i.carb), protein: r1(i.protein), fat: r1(i.fat), source: i.source, ref: i.ref,
        // 양을 고치면 다시 계산할 수 있게 100g당 값으로 환산해 둠
        per100: i.grams > 0 ? (i.kcal * 100) / i.grams : 0,
        m100: i.grams > 0 ? [i.carb, i.protein, i.fat].map((v) => (v * 100) / i.grams) : null,
      }))
      : [{ name: '', amount: '', kcal: 0 }];
    draft.note = `추정 정확도: ${r.confidence}${r.note ? ` · ${r.note}` : ''}`;
    $('aiNote').textContent = draft.note;
    $('aiNote').classList.remove('hidden');
    $('aiCandidates').classList.add('hidden');
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
  if (draft.barcode) entry.barcode = draft.barcode;
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
  $('localAIInput').checked = settings.localAI;
  $('autoGoalInput').checked = settings.autoGoal;
  $('sexInput').value = settings.sex;
  $('birthInput').value = settings.birthYear;
  $('heightInput').value = settings.height;
  $('activityInput').value = String(settings.activity);
  $('paceInput').value = String(settings.pace);
  updateGoalPreview();
  $('settingsSheet').classList.remove('hidden');
};
function readProfileInputs() {
  settings.autoGoal = $('autoGoalInput').checked;
  settings.sex = $('sexInput').value;
  settings.birthYear = parseInt($('birthInput').value, 10) || settings.birthYear;
  settings.height = parseFloat($('heightInput').value) || settings.height;
  settings.activity = parseFloat($('activityInput').value);
  settings.pace = parseFloat($('paceInput').value);
}
async function updateGoalPreview() {
  readProfileInputs();
  $('profileFields').classList.toggle('hidden', !settings.autoGoal);
  $('goalInput').disabled = settings.autoGoal;
  if (!settings.autoGoal) { $('goalPreview').textContent = ''; return; }
  const w = await latestWeight();
  const g = computeGoal(w?.kg);
  $('goalPreview').textContent = g
    ? `체중 ${w.kg.toFixed(1)}kg 기준 · 기초대사량 ${g.bmr.toLocaleString()} · 하루 소모 ${g.tdee.toLocaleString()} → 목표 ${g.goal.toLocaleString()} kcal · 단백질 ${proteinTarget(w.kg)}g`
    : '체중 기록이 있어야 계산돼요. 체중 카드에서 먼저 재 주세요.';
}
for (const id of ['autoGoalInput', 'sexInput', 'birthInput', 'heightInput', 'activityInput', 'paceInput']) {
  $(id).addEventListener('input', updateGoalPreview);
}
$('closeSettings').onclick = () => {
  settings.goal = Math.max(500, parseInt($('goalInput').value, 10) || 2000);
  settings.apiKey = $('keyInput').value.trim();
  settings.model = $('modelInput').value;
  settings.webSearch = $('webInput').checked;
  settings.localAI = $('localAIInput').checked;
  readProfileInputs();
  saveSettings();
  $('settingsSheet').classList.add('hidden');
  render();
};
$('exportBtn').onclick = async () => {
  const products = await tx('readonly', (s) => s.getAll(), 'products');
  const blob = new Blob([JSON.stringify({ version: 3, entries: await allEntries(), weights: await allWeights(), products })], { type: 'application/json' });
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
    for (const p of data.products || []) await putProduct(p);
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
  render(); // 자동 목표·그래프도 새 체중으로
};
$('weightClose').onclick = closeWeight;

// ---------- 다시 먹기 (최근·자주 먹은 끼니) ----------
async function openRepeat() {
  const all = (await allEntries()).sort((a, b) => b.createdAt - a.createdAt);
  const groups = new Map();
  for (const e of all) {
    const sig = e.items.map((i) => i.name.trim()).filter(Boolean).sort().join('|');
    if (!sig) continue;
    const g = groups.get(sig);
    if (g) g.count++;
    else groups.set(sig, { entry: e, count: 1 });
  }
  const list = [...groups.values()].sort((a, b) => b.count - a.count || b.entry.createdAt - a.entry.createdAt).slice(0, 20);
  const box = $('repeatList');
  box.innerHTML = list.length ? '' : '<p class="empty">아직 기록이 없어요. 몇 번 기록하면 여기 모여요.</p>';
  for (const { entry: e, count } of list) {
    const b = document.createElement('button');
    b.className = 'entry';
    b.innerHTML = `${e.thumb ? `<img src="${e.thumb}" alt="">` : '<div class="noimg">🍴</div>'}
      <div class="info"><div class="name"></div><div class="meta">${count}번 먹음</div></div><div class="kcal">${e.kcal.toLocaleString()}</div>`;
    b.querySelector('.name').textContent = e.items.map((i) => i.name).join(', ');
    b.onclick = async () => {
      const now = new Date();
      const at = ymd(current) === ymd(now) ? now : new Date(new Date(current).setHours(12, 0, 0, 0));
      const copy = {
        ...e, id: crypto.randomUUID(), date: ymd(current), meal: guessMeal(at), createdAt: at.getTime(),
        items: e.items.map((i) => ({ ...i })), note: '',
      };
      await putEntry(copy);
      $('repeatSheet').classList.add('hidden');
      toast(`${copy.kcal.toLocaleString()} kcal 다시 기록했어요 (눌러서 고칠 수 있어요)`, 3000);
      render();
    };
    box.appendChild(b);
  }
  $('repeatSheet').classList.remove('hidden');
}
$('repeatBtn').onclick = openRepeat;
$('repeatClose').onclick = () => $('repeatSheet').classList.add('hidden');

// ---------- 바코드 ----------
// 1) 이 폰에 저장된 제품 → 2) Open Food Facts(무료) → 3) 영양정보 표 사진을 Claude가 읽음
let pendingBarcode = null;
async function onBarcodePhoto(file) {
  if (!file) return;
  if (!('BarcodeDetector' in window)) {
    toast('이 폰은 바코드 인식을 지원하지 않아요. 영양정보 표를 찍어 주세요.', 3500);
    pendingBarcode = null;
    return $('labelInput').click();
  }
  try {
    const img = await createImageBitmap(file);
    const codes = await new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] }).detect(img);
    if (!codes.length) return toast('바코드를 못 찾았어요. 바코드가 크게 나오게 다시 찍어 주세요.', 3500);
    await lookupBarcode(codes[0].rawValue);
  } catch (e) { toast(`바코드 인식 실패: ${e.message}`, 3500); }
}
function productItem(p) {
  const it = { name: p.name, amount: `${p.serving}${p.unit}`, source: p.source, ref: p.brand ? `${p.brand} · ${p.code}` : p.code, per100: p.per100, m100: p.m100 };
  scaleItem(it, p.serving);
  return it;
}
async function lookupBarcode(code) {
  const saved = await getProduct(code);
  if (saved) return openEntry({ items: [productItem(saved)], title: '바코드 제품', barcode: code });
  toast('제품 정보를 찾는 중…');
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_ko,brands,nutriments,serving_quantity,quantity`);
    const d = await r.json();
    const n = d.product?.nutriments || {};
    if (d.status === 1 && n['energy-kcal_100g'] != null) {
      const p = {
        code, name: d.product.product_name_ko || d.product.product_name || '바코드 제품', brand: d.product.brands || '',
        per100: n['energy-kcal_100g'], m100: [n.carbohydrates_100g || 0, n.proteins_100g || 0, n.fat_100g || 0],
        serving: parseFloat(d.product.serving_quantity) || 100, unit: 'g', source: '바코드',
      };
      await putProduct(p);
      return openEntry({ items: [productItem(p)], title: '바코드 제품', barcode: code });
    }
  } catch { /* 인터넷 오류면 아래 영양정보 표로 */ }
  pendingBarcode = code;
  toast('처음 보는 제품이에요. 포장지의 영양정보 표를 찍어 주세요.', 3500);
  setTimeout(() => $('labelInput').click(), 600);
}
const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Product name in Korean as printed, or a short description' },
    serving_g: { type: 'number', description: 'Grams (or ml) that the printed nutrition values refer to' },
    kcal: { type: 'number' }, carb: { type: 'number' }, protein: { type: 'number' }, fat: { type: 'number' },
    unit: { type: 'string', enum: ['g', 'ml'] },
    readable: { type: 'boolean', description: 'false if no nutrition facts table is readable' },
  },
  required: ['name', 'serving_g', 'kcal', 'carb', 'protein', 'fat', 'unit', 'readable'],
  additionalProperties: false,
};
async function onLabelPhoto(file) {
  if (!file) return;
  const code = pendingBarcode;
  pendingBarcode = null;
  try {
    const img = await loadImage(file);
    toast('영양정보 표를 읽는 중…', 4000);
    const res = await callClaude({
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: LABEL_SCHEMA } },
      system: 'Read the Korean nutrition facts label (영양정보) in the photo. Report the values exactly as printed for the stated basis amount (총 내용량 or 1회 제공량). Do not estimate.',
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: resized(img, 1400, 0.85).split(',')[1] } },
        { type: 'text', text: '영양정보 표를 읽어 주세요.' },
      ] }],
    });
    const l = JSON.parse(textOf(res));
    if (!l.readable || !(l.serving_g > 0)) return toast('영양정보 표를 읽지 못했어요. 표가 잘 보이게 다시 찍어 주세요.', 3500);
    const p = {
      code: code || `label-${Date.now()}`, name: l.name, brand: '', unit: l.unit, serving: l.serving_g, source: '영양표',
      per100: (l.kcal * 100) / l.serving_g, m100: [l.carb, l.protein, l.fat].map((v) => (v * 100) / l.serving_g),
    };
    if (code) await putProduct(p); // 다음에 같은 바코드는 무료로 바로 나옴
    openEntry({ items: [productItem(p)], title: '포장 식품', barcode: code || undefined, thumb: resized(img, 160, 0.7, true) });
  } catch (e) { toast(e.message, 4000); }
}
$('barcodeBtn').onclick = () => $('barcodeInput').click();
$('barcodeInput').onchange = (ev) => { onBarcodePhoto(ev.target.files[0]); ev.target.value = ''; };
$('labelInput').onchange = (ev) => { onLabelPhoto(ev.target.files[0]); ev.target.value = ''; };

// ---------- 주간 리포트 ----------
function renderReport() {
  const r = safeJSON(localStorageGet('kcal-report'), null);
  $('reportText').textContent = r ? r.text : '최근 7일 기록을 Claude가 읽고 짧게 정리해 드려요.';
  $('reportMeta').textContent = r ? `${new Date(r.at).getMonth() + 1}/${new Date(r.at).getDate()} 작성` : '';
}
async function makeReport() {
  const end = new Date(current);
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(end); d.setDate(d.getDate() - i); days.push(ymd(d)); }
  const [entries, weights] = await Promise.all([allEntries(), allWeights()]);
  const inWeek = entries.filter((e) => days.includes(e.date));
  if (!inWeek.length) return toast('최근 7일 기록이 없어요.');
  const daily = days.map((date) => {
    const es = inWeek.filter((e) => e.date === date);
    const m = sumMacros(es.flatMap((e) => e.items));
    return {
      date, kcal: es.reduce((s, e) => s + e.kcal, 0), carb_g: Math.round(m.carb), protein_g: Math.round(m.protein), fat_g: Math.round(m.fat),
      meals: es.map((e) => {
        const t = new Date(e.createdAt);
        return `${pad(t.getHours())}:${pad(t.getMinutes())} ${e.meal} ${e.kcal}kcal (${e.items.map((i) => i.name).join(', ')})`;
      }),
    };
  });
  const ws = weights.filter((w) => days.includes(w.date)).sort((a, b) => a.at - b.at).map((w) => `${w.date} ${w.kg.toFixed(2)}kg`);
  const data = { goal_kcal: goalCache.goal, protein_target_g: goalCache.protein, goal_pace_kg_per_week: settings.autoGoal ? settings.pace : null, daily, weights: ws };
  $('reportBtn').disabled = true;
  $('reportText').textContent = '리포트를 쓰는 중…';
  try {
    const res = await callClaude({
      max_tokens: 4000,
      output_config: { effort: 'low' },
      system: `You write a short weekly food-diary review in Korean for one person, in a warm but direct tone, using polite speech (존댓말).
Use only the data given. Plain text, no markdown symbols. At most 6 short lines:
1) one line summary of the week (average kcal vs goal, days over goal),
2) protein and the carb/fat balance,
3) eating-time pattern (late-night eating counts as 21:00-05:00) and repeated foods,
4) weight change if there are weights,
5-6) two concrete, small suggestions for next week.`,
      messages: [{ role: 'user', content: JSON.stringify(data) }],
    });
    const text = textOf(res).trim();
    localStorageSet('kcal-report', JSON.stringify({ at: Date.now(), text }));
    renderReport();
  } catch (e) {
    toast(e.message, 4000);
    renderReport();
  } finally {
    $('reportBtn').disabled = false;
  }
}
$('reportBtn').onclick = makeReport;

// ---------- 기타 ----------
function toast(msg, ms = 2200) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
for (const id of ['entrySheet', 'settingsSheet', 'repeatSheet']) {
  $(id).addEventListener('click', (ev) => { if (ev.target.id === id) $(id).classList.add('hidden'); });
}
$('weightSheet').addEventListener('click', (ev) => { if (ev.target.id === 'weightSheet') closeWeight(); });
$('prevDay').onclick = () => { current = shiftDay(-1); render(); };
$('nextDay').onclick = () => { current = shiftDay(1); render(); };
$('camBtn').onclick = () => $('camInput').click();
$('galBtn').onclick = () => $('galInput').click();
$('manualBtn').onclick = () => openEntry();
for (const b of document.querySelectorAll('#trendTabs button')) {
  b.onclick = () => {
    trendDays = Number(b.dataset.days);
    for (const x of document.querySelectorAll('#trendTabs button')) x.classList.toggle('on', x === b);
    renderTrend();
  };
}
$('camInput').onchange = (ev) => { onPhoto(ev.target.files[0]); ev.target.value = ''; };
$('galInput').onchange = (ev) => { onPhoto(ev.target.files[0]); ev.target.value = ''; };

// 크롬이 "설치 가능"이라고 알려주면 설치 카드를 보여 줌 (이미 설치된 앱으로 열렸으면 안 뜸)
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  installPrompt = ev;
  $('installCard').classList.remove('hidden');
});
$('installBtn').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  $('installCard').classList.add('hidden');
  if (outcome === 'accepted') toast('설치했어요! 홈 화면의 "칼로리" 아이콘으로 열어 주세요.', 4000);
};
window.addEventListener('appinstalled', () => $('installCard').classList.add('hidden'));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
render();
loadFoodDB().catch(() => { foodDB = null; }); // 직접 입력 검색이 바로 되도록 미리 불러 둠
