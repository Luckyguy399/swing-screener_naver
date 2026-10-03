// 단타·스윙 스크리너 서버 — 네이버 금융 데이터 버전 (Node 18+, 외부 패키지·API 키 불필요)
// 비공식 데이터 경로라 네이버가 구조를 바꾸면 멈출 수 있어요. 개인용으로 요청 간격을 넉넉히 둡니다.
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const UA = { 'user-agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36', referer: 'https://finance.naver.com/' };

// 관심 종목 + 테마 (여기에 추가/수정하세요)
const WATCH = [
  { c: '095610', n: '테스', t: '반도체 소부장', s: '전공정 · 증착장비' },
  { c: '067310', n: '하나마이크론', t: '반도체 소부장', s: '후공정 · 패키징(OSAT)' },
  { c: '042700', n: '한미반도체', t: '반도체 소부장', s: '후공정 · HBM TC본더' },
  { c: '058470', n: '리노공업', t: '반도체 소부장', s: '테스트 · 소켓/핀' },
  { c: '058610', n: '에스피지', t: '로봇', s: '액츄에이터 · 감속기' },
  { c: '277810', n: '레인보우로보틱스', t: '로봇', s: '휴머노이드 · 완제품' },
  { c: '086520', n: '에코프로', t: '2차전지', s: '양극재 · 소재' },
  { c: '010140', n: '삼성중공업', t: '조선', s: '조선 · LNG선' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

async function get(url, enc) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' (' + new URL(url).hostname + ')');
  return new TextDecoder(enc || 'utf-8').decode(await r.arrayBuffer());
}

// 실시간 시세 (전 종목 한 번에)
async function quotes() {
  const t = await get('https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:' + WATCH.map(w => w.c).join(','), 'euc-kr');
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

let cache = { t: 0, d: null }, inflight = null;
function load() {
  if (cache.d && Date.now() - cache.t < 20000) return Promise.resolve(cache.d);
  if (inflight) return inflight;
  inflight = (async () => {
    const q = await quotes();
    const items = [];
    for (const w of WATCH) {
      try {
        const o = q[w.c];
        if (!o) throw new Error('시세 없음');
        const p = +o.nv, sv = +o.sv;
        const chg = sv ? (p / sv - 1) * 100 : 0;
        const bars = (await chart(w.c)).map(x => ({ ...x }));
        if (bars.length) { bars[bars.length - 1].c = p; if (+o.aq) bars[bars.length - 1].v = +o.aq; }
        const ind = calc(bars);
        if (!ind) throw new Error('일봉 데이터 부족');
        const est = +o.aq * p / 1e8;                       // 거래대금 추정(억)
        const aa = +o.aa / 100;                            // 네이버 값(백만원 → 억), 단위 검증 후 사용
        const amt = Math.round(aa && est && aa > est * 0.3 && aa < est * 3 ? aa : est);
        items.push({ ...w, p, chg: +chg.toFixed(2), cap: await cap(w.c), amt, ...ind });
      } catch (e) { items.push({ ...w, err: e.message }); }
      await sleep(120);
    }
    const grp = {};
    items.filter(i => !i.err).forEach(i => (grp[i.t] = grp[i.t] || []).push(i.chg));
    items.forEach(i => { if (!i.err) i.ts = Math.max(0, Math.min(10, Math.round(5 + avg(grp[i.t]) * 1.2))); });
    cache = { t: Date.now(), d: { asOf: new Date().toISOString(), items } };
    return cache.d;
  })().finally(() => { inflight = null; });
  return inflight;
}

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/stocks')) {
    const h = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    try {
      const d = await load();
      res.writeHead(200, h); res.end(JSON.stringify(d));
    } catch (e) { res.writeHead(500, h); res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  fs.readFile(path.join(__dirname, 'index.html'), (e, b) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(b);
  });
}).listen(PORT, () => console.log('listening on ' + PORT));
