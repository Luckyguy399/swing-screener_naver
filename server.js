// 단타·스윙 스크리너 서버 — 네이버 금융 데이터 + 종목 검색 (Node 18+, 외부 패키지·API 키 불필요)
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

// 시가총액 (1시간 캐시)
const capC = new Map();
function parseCap(s) {
  let v = 0;
  const a = String(s).match(/([\d,]+)\s*조/), b = String(s).match(/([\d,]+)\s*억/);
  if (a) v += +a[1].replace(/,/g, '') * 10000;
  if (b) v += +b[1].replace(/,/g, '');
  return v;
}
async function cap(c) {
  const h = capC.get(c);
  if (h && Date.now() - h.t < 36e5) return h.v;
  let v = 0;
  try {
    const j = JSON.parse(await get('https://m.stock.naver.com/api/stock/' + c + '/integration'));
    const it = (j.totalInfos || []).find(x => x.code === 'marketValue' || x.key === '시총');
    if (it) v = parseCap(it.value);
  } catch (e) { /* 실패 시 화면에 '-' 표시 */ }
  capC.set(c, { t: v ? Date.now() : Date.now() - 36e5 + 6e4, v });
  return v;
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

function calc(bars) {
  const cl = bars.map(b => b.c), n = cl.length;
  if (n < 61) return null;
  const ma = k => avg(cl.slice(-k));
  let g = 0, l = 0;
  for (let i = 1; i <= 14; i++) { const d = cl[i] - cl[i - 1]; d > 0 ? g += d : l -= d; }
  g /= 14; l /= 14;
  for (let i = 15; i < n; i++) {
    const d = cl[i] - cl[i - 1];
    g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14;
  }
  const rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  const s20 = cl.slice(-20), m = avg(s20), sd = Math.sqrt(avg(s20.map(x => (x - m) ** 2)));
  const p = cl[n - 1];
  const pb = sd ? (p - (m - 2 * sd)) / (4 * sd) : 0.5;
  const v20 = avg(bars.slice(-21, -1).map(b => b.v));
  const vr = v20 ? Math.round(bars[n - 1].v / v20 * 100) : 0;
  const atr = avg(bars.slice(-14).map(b => (b.h - b.l) / b.c * 100));
  const hi20 = Math.max(...bars.slice(-21, -1).map(b => b.h));
  const m5 = ma(5), m20 = ma(20), m60 = ma(60);
  const trend = (m5 > m20 && m20 > m60 && p > m20) ? 2 : p > m20 ? 1 : 0;
  return {
    rsi: +rsi.toFixed(1), pb: +pb.toFixed(2), vr, atr: +atr.toFixed(1), trend,
    brk: (p > hi20 && vr >= 150) ? 1 : 0,
    pull: (trend === 2 && p / m20 - 1 <= 0.05 && p < m5) ? 1 : 0,
  };
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
  const e = encodeURIComponent(q);
  const urls = ['https://ac.stock.naver.com/ac?q=' + e + '&target=stock',
    'https://m.stock.naver.com/front-api/search/autoComplete?query=' + e + '&target=stock'];
  let out = [];
  for (const u of urls) { try { walk(JSON.parse(await get(u)), out); } catch (x) { /* 다음 경로 시도 */ } if (out.length) break; }
  const seen = new Set();
  out = out.filter(x => !seen.has(x.c) && seen.add(x.c)).slice(0, 10);
  const up = q.toUpperCase();
  if (!out.length && isCode(up)) {
    try { const j = JSON.parse(await get('https://m.stock.naver.com/api/stock/' + up + '/basic')); if (j.stockName) out = [{ c: up, n: j.stockName, m: '' }]; } catch (x) { /* 없음 */ }
  }
  return out;
}

// 시세·지표 계산 (화면이 보낸 종목 목록 기준)
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
        const est = +o.aq * px / 1e8;
        const aa = +o.aa / 100;
        const amt = Math.round(aa && est && aa > est * 0.3 && aa < est * 3 ? aa : est);
        items.push({ ...w, p: px, chg: +chg.toFixed(2), cap: await cap(w.c), amt, ...ind });
      } catch (e) { items.push({ ...w, err: e.message }); }
      await sleep(100);
    }
    const grp = {};
    items.filter(i => !i.err && i.t && i.t !== '미분류').forEach(i => (grp[i.t] = grp[i.t] || []).push(i.chg));
    items.forEach(i => { if (!i.err) i.ts = grp[i.t] ? Math.max(0, Math.min(10, Math.round(5 + avg(grp[i.t]) * 1.2))) : 5; });
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
  if (u.pathname === '/api/stocks' || u.pathname === '/api/search') {
    try {
      if (u.pathname === '/api/search') return send(200, { items: await search(u.searchParams.get('q') || '') });
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
