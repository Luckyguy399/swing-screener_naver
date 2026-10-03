// 단타·스윙 스크리너 서버 — 네이버 금융 데이터 + 종목 검색 + 점수 산정 (Node 18+, 외부 패키지·API 키 불필요)
// 비공식 데이터 경로라 네이버가 구조를 바꾸면 멈출 수 있어요.
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const UA = { 'user-agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36', referer: 'https://finance.naver.com/' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

async function get(url, enc) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' (' + new URL(url).hostname + ')');
  return new TextDecoder(enc || 'utf-8').decode(await r.arrayBuffer());
}

// 실시간 시세 (요청한 종목 한 번에)
async function quotes(codes) {
  const t = await get('https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:' + codes.join(','), 'euc-kr');
  const j = JSON.parse(t), m = {};
  for (const a of (j.result && j.result.areas) || []) for (const d of a.datas || []) m[d.cd] = d;
  if (!Object.keys(m).length) throw new Error('네이버 시세 응답이 비어 있어요 (차단되었거나 구조가 바뀌었을 수 있어요)');
  return m;
}

// 실시간 시세 (요청한 종목 한 번에)
async function quotes(codes) {
  const t = await get('https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:' + codes.join(','), 'euc-kr');
  const j = JSON.parse(t), m = {};
  for (const a of (j.result && j.result.areas) || []) for (const d of a.datas || []) m[d.cd] = d;
  if (!Object.keys(m).length) throw new Error('네이버 시세 응답이 비어 있어요 (차단되었거나 구조가 바뀌었을 수 있어요)');
  return m;
}

// 일봉 (10분 캐시)
const cc = new Map();
async function chart(c) {
  const h = cc.get(c);
  if (h && Date.now() - h.t < 6e5) return h.d;
  const x = await get('https://fchart.stock.naver.com/sise.nhn?symbol=' + c + '&timeframe=day&count=150&requestType=0', 'euc-kr');
  const d = [...x.matchAll(/<item data="([^"]+)"/g)].map(m => m[1].split('|'))
    .map(a => ({ c: +a[4], h: +a[2], l: +a[3], v: +a[5] })).filter(b => b.c > 0);
  cc.set(c, { t: Date.now(), d });
  return d;
}

// ===== 통합시세 (거래량·거래대금·시총) =====
const num = s => { const v = parseFloat(String(s).replace(/[^\d.\-]/g, '')); return isFinite(v) ? v : 0; };
function money(s) { // 문자열 → 억원 ('1조 2,345억', '5,432백만' 등)
  s = String(s); let v = 0, hit = false;
  const j = s.match(/([\d,.]+)\s*조/), e = s.match(/([\d,.]+)\s*억/), b = s.match(/([\d,.]+)\s*백만/);
  if (j) { v += num(j[1]) * 10000; hit = true; }
  if (e) { v += num(e[1]); hit = true; }
  if (b) { v += num(b[1]) / 100; hit = true; }
  return hit ? v : num(s) / 1e8;
}
const ic = new Map();
async function integ(c) {
  const h = ic.get(c);
  if (h && Date.now() - h.t < 20000) return h.v;
  const v = {};
  try {
    const j = JSON.parse(await get('https://m.stock.naver.com/api/stock/' + c + '/integration'));
    for (const it of j.totalInfos || []) {
      if (it.code === 'accumulatedTradingVolume') v.vol = num(it.value);
      else if (it.code === 'accumulatedTradingValue') v.val = money(it.value);
      else if (it.code === 'marketValue' || it.key === '시총') v.cap = money(it.value);
    }
  } catch (e) { v.err = e.message; }
  ic.set(c, { t: v.err ? Date.now() - 15000 : Date.now(), v });
  return v;
}

// ===== 지표 계산 =====
function calc(bars) {
  const n = bars.length;
  if (n < 61) return null;
  const cl = bars.map(b => b.c), p = cl[n - 1];
  const ma = k => n >= k ? avg(cl.slice(-k)) : null;
  const m5 = ma(5), m20 = ma(20), m60 = ma(60), m120 = ma(120);
  const m20p = avg(cl.slice(-25, -5));                       // 5거래일 전 20일선
  let g = 0, l = 0;                                          // RSI(14, Wilder)
  for (let i = 1; i <= 14; i++) { const d = cl[i] - cl[i - 1]; d > 0 ? g += d : l -= d; }
  g /= 14; l /= 14;
  for (let i = 15; i < n; i++) { const d = cl[i] - cl[i - 1]; g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14; }
  const rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  const s20 = cl.slice(-20), sd = Math.sqrt(avg(s20.map(x => (x - m20) ** 2)));   // 볼린저(20, 2.0)
  const pb = sd ? (p - (m20 - 2 * sd)) / (4 * sd) : 0.5;
  const tr = [];                                             // ATR(14) % (갭 포함 True Range)
  for (let i = n - 14; i < n; i++) tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - cl[i - 1]), Math.abs(bars[i].l - cl[i - 1])));
  const atr = avg(tr) / p * 100;
  const tv = bars[n - 1].v;
  const v5 = avg(bars.slice(-6, -1).map(b => b.v));          // 직전 5일 평균 거래량
  const vr = v5 ? Math.round(tv / v5 * 100) : 0;
  const a20 = avg(bars.slice(-21, -1).map(b => b.c * b.v / 1e8));   // 직전 20일 평균 거래대금(억)
  const amtR = a20 ? Math.round(p * tv / 1e8 / a20 * 100) : 0;
  const hi20 = Math.max(...bars.slice(-21, -1).map(b => b.h));
  const hi60 = Math.max(...bars.slice(-61, -1).map(b => b.h));
  const touch = Math.min(...bars.slice(-3).map(b => b.l)) <= m20 * 1.01 && p > m20 && p > cl[n - 2];
  return {
    rsi: +rsi.toFixed(1), pb: +pb.toFixed(2), atr: +atr.toFixed(1), vr, amtR,
    m5, m20, m60, m120, slopeUp: m20 > m20p, hi20, hi60, dayHigh: bars[n - 1].h, touch,
  };
}

// ===== 점수 산정 (각 항목: l 이름, p 점수, m 만점, t 근거) =====
const fa = v => v >= 10000 ? (v / 10000).toFixed(1) + '조' : Math.round(v).toLocaleString() + '억';
function score(d) {
  const P = (l, p, m, t) => ({ l, p, m, t });
  const dp = [], sp = [];
  // 단타 1. 거래대금·수급 (30)
  const B = d.amtR >= 200, C = d.cap > 0 && d.amt / d.cap * 100 >= 3;
  const a = d.amt >= 500 && (B || C) ? 30 : d.amt >= 1000 ? 20 : d.amt >= 300 && d.amt < 500 && (B || C) ? 20 : d.amt >= 200 ? 10 : 0;
  dp.push(P('거래대금·수급', a, 30, fa(d.amt) + ' · 평소(20일)의 ' + d.amtR + '% · 시총 대비 ' + (d.cap ? (d.amt / d.cap * 100).toFixed(1) + '%' : '-')));
  // 단타 2. 거래량 증가 (30)
  dp.push(P('거래량 증가', d.vr >= 300 ? 30 : d.vr >= 200 ? 20 : d.vr >= 120 ? 10 : 0, 30, '직전 5일 평균의 ' + d.vr + '%'));
  // 단타 3. 변동성 (20)
  dp.push(P('변동성(ATR14)', d.atr >= 4 ? 20 : d.atr >= 2.5 ? 10 : 0, 20, 'ATR ' + d.atr + '%'));
  // 단타 4. 20일 고점 돌파 (20)
  const broke = d.p > d.hi20, held = broke && d.p >= d.dayHigh * 0.98, near = !broke && d.p >= d.hi20 * 0.98;
  dp.push(P('20일 고점 돌파', held ? 20 : (broke || near) ? 10 : 0, 20, held ? '돌파 후 고가 부근 유지' : broke ? '돌파했으나 고가에서 밀림' : near ? '돌파 시도 중(2% 이내)' : '미돌파'));
  // 스윙 1. 추세·정배열 (35)
  const up = (x, y) => x != null && y != null && x > y;
  const three = up(d.m5, d.m20) && up(d.m20, d.m60), full = three && up(d.m60, d.m120);
  const tr = full && d.slopeUp ? 35 : three ? 25 : (up(d.m5, d.m20) && d.p > d.m20) ? 10 : 0;
  sp.push(P('추세·정배열', tr, 35, (full ? '5>20>60>120' : three ? (d.m120 == null ? '5>20>60 (120일 데이터 부족)' : '5>20>60') : tr ? '역배열 탈출 초기' : '정배열 아님') + (d.slopeUp ? ' · 20일선 상향' : ' · 20일선 하향')));
  // 스윙 2. 눌림·RSI (25)
  const r = d.rsi;
  const rp = r >= 40 && r <= 50 ? (d.touch ? 25 : 15) : r > 50 && r <= 60 ? 15 : (r >= 70 || r <= 30) ? 5 : 0;
  sp.push(P('눌림·RSI', rp, 25, 'RSI ' + r + (d.touch ? ' · 20일선 터치 후 지지' : '')));
  // 스윙 3. 테마 강도 (15)
  const hasT = d.t && d.t !== '미분류';
  const tp = !hasT ? 0 : (d.tavg >= 5 || d.tlead) ? 15 : d.tavg >= 2 ? 8 : 0;
  sp.push(P('테마 강도', tp, 15, hasT ? d.t + ' 평균 ' + (d.tavg >= 0 ? '+' : '') + d.tavg.toFixed(1) + '%' + (d.tlead ? ' · 급등 종목 포함' : '') : '테마 미분류'));
  // 스윙 4. 60일 고점 돌파 (15)
  const b60 = d.p > d.hi60;
  sp.push(P('60일 고점 돌파', b60 && d.vr >= 150 ? 15 : (b60 || d.p >= d.hi60 * 0.97) ? 8 : 0, 15, b60 ? (d.vr >= 150 ? '돌파 + 거래량 동반' : '돌파(거래량 약함)') : d.p >= d.hi60 * 0.97 ? '돌파 시도 중(3% 이내)' : '미돌파'));
  // 스윙 5. 볼린저 (10)
  const bp = d.pb > 1 ? 5 : d.pb >= 0.5 ? (d.slopeUp ? 10 : 5) : 0;
  sp.push(P('볼린저(20,2.0)', bp, 10, '%B ' + d.pb + (d.pb > 1 ? ' · 상단 돌파 과열' : d.pb >= 0.5 ? ' · 중심~상단' : d.pb < 0 ? ' · 하단 이탈' : ' · 중심선 아래')));
  const sum = L => L.reduce((x, y) => x + y.p, 0);
  return { day: sum(dp), sw: sum(sp), dp, sp };
}

// 종목 검색 (자동완성 응답 모양이 달라도 읽도록 느슨하게 파싱)
const isCode = s => /^[0-9A-Z]{6}$/.test(s) && /\d/.test(s);
const SKIP = /^(KOSPI|KOSDAQ|KONEX|ETF|ETN|stock|KRX)$/i;
const rowOf = n => n.length && n.every(e => typeof e === 'string') ? n
  : (n.length && n.every(e => Array.isArray(e) && e.every(s => typeof s === 'string')) ? n.flat() : null);
function walk(n, out) {
  if (Array.isArray(n)) {
    const f = rowOf(n);
    if (f) {
      const c = f.find(isCode);
      const nm = f.find(s => s !== c && !SKIP.test(s) && !isCode(s) && /[가-힣A-Za-z]/.test(s));
      const mk = f.find(s => /^(KOSPI|KOSDAQ|ETF|ETN)$/i.test(s));
      if (c && nm) out.push({ c, n: nm, m: mk || '' });
      return;
    }
    n.forEach(e => walk(e, out));
  } else if (n && typeof n === 'object') {
    const c = n.code || n.cd || n.itemCode, nm = n.name || n.nm || n.stockName;
    if (typeof c === 'string' && isCode(c) && typeof nm === 'string' && (!n.nationCode || n.nationCode === 'KOR')) {
      out.push({ c, n: nm, m: n.typeCode || n.market || '' }); return;
    }
    Object.values(n).forEach(e => walk(e, out));
  }
}
async function search(q) {
  q = q.trim().slice(0, 30);
  if (!q) return [];
  let out = [];
  for (const u of searchUrls(q)) { try { walk(JSON.parse(await get(u)), out); } catch (x) { /* 다음 경로 시도 */ } if (out.length) break; }
  const seen = new Set();
  out = out.filter(x => !seen.has(x.c) && seen.add(x.c)).slice(0, 10);
  const up = q.toUpperCase();
  if (!out.length && isCode(up)) {
    try { const j = JSON.parse(await get('https://m.stock.naver.com/api/stock/' + up + '/basic')); if (j.stockName) out = [{ c: up, n: j.stockName, m: '' }]; } catch (x) { /* 없음 */ }
  }
  return out;
}
const searchUrls = q => { const e = encodeURIComponent(q); return [
  'https://ac.finance.naver.com/ac?q=' + e + '&q_enc=utf-8&st=111&r_format=json&r_enc=utf-8&r_unicode=0&t_koreng=1&r_lt=111',
  'https://ac.stock.naver.com/ac?q=' + e + '&target=stock',
  'https://m.stock.naver.com/front-api/search/autoComplete?query=' + e + '&target=stock']; };

// 시세·지표·점수 (화면이 보낸 종목 목록 기준)
const lc = new Map();
function load(list) {
  const key = list.map(x => x.c).sort().join(',');
  const h = lc.get(key);
  if (h && Date.now() - h.t < 20000) return h.p;
  const p = (async () => {
    const q = await quotes(list.map(x => x.c));
    const items = [];
    for (const w of list) {
      try {
        const o = q[w.c];
        if (!o) throw new Error('시세 없음');
        const px = +o.nv, sv = +o.sv;
        const chg = sv ? (px / sv - 1) * 100 : 0;
        const bars = (await chart(w.c)).map(x => ({ ...x }));
        if (bars.length) { bars[bars.length - 1].c = px; if (+o.aq) bars[bars.length - 1].v = +o.aq; }
        const ind = calc(bars);
        if (!ind) throw new Error('일봉 데이터 부족');
        const I = await integ(w.c);
        // 거래대금(억): 통합시세 → 실시간 → 추정 순서. 단위 오류를 막기 위해 추정치와 크게 어긋나면 버림
        const est = +o.aq * px / 1e8, aa = +o.aa / 100;
        const okv = v => v > 0 && (!est || (v > est * 0.5 && v < est * 5));
        let amt = est, src = '추정';
        if (okv(I.val)) { amt = I.val; src = '통합'; }
        else if (okv(aa)) { amt = aa; src = '실시간'; }
        items.push({ ...w, p: px, chg: +chg.toFixed(2), cap: I.cap || 0, amt: Math.round(amt), amtSrc: src, ...ind });
      } catch (e) { items.push({ ...w, err: e.message }); }
      await sleep(100);
    }
    const grp = {};
    items.filter(i => !i.err && i.t && i.t !== '미분류').forEach(i => (grp[i.t] = grp[i.t] || []).push(i.chg));
    items.forEach(i => { if (!i.err) { const g = grp[i.t]; i.tavg = g ? avg(g) : 0; i.tlead = g ? g.some(x => x >= 15) : false; i.sc = score(i); } });
    return { asOf: new Date().toISOString(), items };
  })();
  lc.set(key, { t: Date.now(), p });
  if (lc.size > 30) lc.delete(lc.keys().next().value);
  p.catch(() => lc.delete(key));
  return p;
}

const body = req => new Promise((ok, no) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 1e5) { no(new Error('요청이 너무 커요')); req.destroy(); } });
  req.on('end', () => ok(b)); req.on('error', no);
});

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const h = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  const send = (c, o) => { res.writeHead(c, h); res.end(JSON.stringify(o)); };
  if (['/api/stocks', '/api/search', '/api/debug'].includes(u.pathname)) {
    try {
      if (u.pathname === '/api/search') return send(200, { items: await search(u.searchParams.get('q') || '') });
      if (u.pathname === '/api/debug') { // 원본 응답 확인용: /api/debug?c=058470  /api/debug?q=삼성전자
        const c = u.searchParams.get('c'), q = u.searchParams.get('q'), o = {};
        if (c) {
          try { o.polling = (await quotes([c]))[c]; } catch (e) { o.pollingErr = e.message; }
          try { o.totalInfos = (JSON.parse(await get('https://m.stock.naver.com/api/stock/' + c + '/integration')).totalInfos || []).map(x => [x.code, x.key, x.value]); } catch (e) { o.integErr = e.message; }
        }
        if (q) { o.search = {}; for (const s of searchUrls(q)) { try { o.search[s] = (await get(s)).slice(0, 400); } catch (e) { o.search[s] = 'ERR ' + e.message; } } }
        return send(200, o);
      }
      let list = JSON.parse(await body(req) || '[]');
      if (!Array.isArray(list)) throw new Error('잘못된 요청이에요');
      list = list.slice(0, 40).filter(x => x && isCode(String(x.c)))
        .map(x => ({ c: String(x.c), t: String(x.t || '').slice(0, 30), s: String(x.s || '').slice(0, 40) }));
      if (!list.length) return send(200, { asOf: new Date().toISOString(), items: [] });
      return send(200, await load(list));
    } catch (e) { return send(500, { error: e.message }); }
  }
  fs.readFile(path.join(__dirname, 'index.html'), (e, b) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(b);
  });
}).listen(PORT, () => console.log('listening on ' + PORT));
