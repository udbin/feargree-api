// api/semi-check.js - 반도체 섹터 5-Factor 공포탐욕지수 (실전 도메인 단일 키 버전)
// 사용법: https://feargree-api.vercel.app/api/semi-check
//
// [변경됨] 모의투자/실전투자 앱키 2쌍 -> 실전 앱키 1쌍으로 통일
// [변경됨] 토큰 캐시를 index.js/cron-close.js와 같은 Redis 키(feargreed:kistoken)로 공유
//          -> 세 파일이 서로 "1분당1회" 제한을 침범하지 않음

const KIS_APP_KEY    = process.env.KIS_APP_KEY;    // 이제 이 값이 실전 앱키
const KIS_APP_SECRET = process.env.KIS_APP_SECRET; // 이제 이 값이 실전 시크릿
const KIS_BASE        = 'https://openapi.koreainvestment.com:9443'; // 실전 도메인

const REDIS_URL   = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

const SEMI_STOCKS = [
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '042700', name: '한미반도체' },
  { code: '007660', name: '이수페타시스' },
  { code: '353200', name: '대덕전자' },
  { code: '240810', name: '원익IPS' },
  { code: '000990', name: 'DB하이텍' },
  { code: '058470', name: '리노공업' },
  { code: '039030', name: '이오테크닉스' },
  { code: '036930', name: '주성엔지니어링' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function normalize(v, min, max) { return Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100)); }
function todayStr() {
  const d = new Date(Date.now() + 9 * 3600000);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
function daysAgoStr(n) {
  const d = new Date(Date.now() + 9 * 3600000 - n * 86400000);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

async function kvGetSimple(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/${key}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.result === null || json.result === undefined) return null;
    return typeof json.result === 'string' ? JSON.parse(json.result) : json.result;
  } catch (e) { return null; }
}

async function kvSetSimple(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await fetch(`${REDIS_URL}/set/${key}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify(value))
    });
  } catch (e) { /* 저장 실패해도 무시 */ }
}

// [변경됨] index.js / cron-close.js와 동일한 Redis 키 사용 -> 토큰 공유
async function getKISToken() {
  const cached = await kvGetSimple('feargreed:kistoken');
  if (cached && cached.token && cached.expiresAt && Date.now() < cached.expiresAt) {
    return cached.token;
  }
  const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`토큰 발급 실패: ${res.status} ${t}`);
  }
  const data = await res.json();
  const expiresAt = Date.now() + (data.expires_in - 600) * 1000;
  await kvSetSimple('feargreed:kistoken', { token: data.access_token, expiresAt });
  return data.access_token;
}

// API ① 현재가 + 52주 고저
async function fetchPrice(token, code) {
  const res = await fetch(
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`,
    { headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}`, appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET, tr_id: 'FHKST01010100', custtype: 'P' } }
  );
  const data = await res.json();
  const o = data.output;
  if (!res.ok || !o) return { error: `price HTTP ${res.status}`, raw: data };
  return {
    price: parseFloat(o.stck_prpr || 0),
    changePct: parseFloat(o.prdy_ctrt || 0),
    marketCap: parseFloat(o.hts_avls || 0),
    w52High: parseFloat(o.w52_hgpr || 0),
    w52Low: parseFloat(o.w52_lwpr || 0),
  };
}

// API ② 최근 20거래일 일별 종가 (변동성용)
async function fetchDailyChart(token, code) {
  const d1 = daysAgoStr(30);
  const d2 = todayStr();
  const res = await fetch(
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}&FID_INPUT_DATE_1=${d1}&FID_INPUT_DATE_2=${d2}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=1`,
    { headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}`, appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET, tr_id: 'FHKST03010100', custtype: 'P' } }
  );
  const data = await res.json();
  const rows = data.output2;
  if (!res.ok || !Array.isArray(rows) || rows.length < 5) {
    return { error: `dailyChart HTTP ${res.status} or 데이터 부족`, raw: rows ? rows.length : data };
  }
  const closes = rows.map(r => parseFloat(r.stck_clpr)).filter(v => v > 0).reverse();
  const last20 = closes.slice(-20);
  if (last20.length < 5) return { error: '유효 종가 데이터 5개 미만' };

  const returns = [];
  for (let i = 1; i < last20.length; i++) returns.push((last20[i] - last20[i - 1]) / last20[i - 1]);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const annualizedVolPct = Math.sqrt(variance) * Math.sqrt(252) * 100;

  return { annualizedVolPct: parseFloat(annualizedVolPct.toFixed(2)), sampleDays: last20.length };
}

// API ③ 종목별 외인기관 추정가집계 (자금흐름용) - 실전 전용 API, 이제 같은 키/토큰 그대로 사용
async function fetchInvestorTrend(token, code) {
  const res = await fetch(
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/investor-trend-estimate?MKSC_SHRN_ISCD=${code}`,
    {
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
        appkey: KIS_APP_KEY,
        appsecret: KIS_APP_SECRET,
        tr_id: 'HHPTJ04160200',
        custtype: 'P'
      }
    }
  );
  const data = await res.json();
  const arr = data.output2;
  if (!res.ok || !Array.isArray(arr) || arr.length === 0) {
    return { error: `investorTrend HTTP ${res.status}`, raw: data };
  }
  const latest = arr[0];
  return {
    입력시점: latest.bsop_hour_gb,
    외국인수량: parseInt(latest.frgn_fake_ntby_qty, 10),
    기관수량: parseInt(latest.orgn_fake_ntby_qty, 10),
    합산수량: parseInt(latest.sum_fake_ntby_qty, 10),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!KIS_APP_KEY || !KIS_APP_SECRET) {
      return res.status(500).json({ success: false, error: 'KIS_APP_KEY 또는 KIS_APP_SECRET 환경변수 없음' });
    }

    const token = await getKISToken(); // 이제 토큰 발급은 딱 1번만 (전체 함수 공유)

    const results = [];
    for (const stock of SEMI_STOCKS) {
      const row = { 종목명: stock.name, 종목코드: stock.code };

      row.price = await fetchPrice(token, stock.code);
      if (row.price && row.price.raw && row.price.raw.msg_cd === 'EGW00201') {
        await sleep(1200);
        row.price = await fetchPrice(token, stock.code);
      }
      await sleep(700);

      row.chart = await fetchDailyChart(token, stock.code);
      if (row.chart && row.chart.raw && row.chart.raw.msg_cd === 'EGW00201') {
        await sleep(1200);
        row.chart = await fetchDailyChart(token, stock.code);
      }
      await sleep(700);

      row.investor = await fetchInvestorTrend(token, stock.code);
      if (row.investor && row.investor.raw && row.investor.raw.msg_cd === 'EGW00201') {
        await sleep(1200);
        row.investor = await fetchInvestorTrend(token, stock.code);
      }
      await sleep(700);

      results.push(row);
    }

    const valid = results.filter(r => !r.price.error);
    const totalCap = valid.reduce((s, r) => s + r.price.marketCap, 0);

    const weightedChange = valid.reduce((s, r) => s + r.price.changePct * (r.price.marketCap / totalCap), 0);
    const upCount = valid.filter(r => r.price.changePct > 0).length;
    const breadthPct = (upCount / valid.length) * 100;
    const rangePositions = valid.map(r => {
      const { price: p, w52High, w52Low } = r.price;
      return w52High > w52Low ? ((p - w52Low) / (w52High - w52Low)) * 100 : 50;
    });
    const avgRangePos = rangePositions.reduce((a, b) => a + b, 0) / rangePositions.length;

    const validVol = valid.filter(r => r.chart && !r.chart.error);
    const avgVol = validVol.length ? validVol.reduce((s, r) => s + r.chart.annualizedVolPct, 0) / validVol.length : null;

    const validFlow = valid.filter(r => r.investor && !r.investor.error);
    const netForeignOrg = validFlow.length
      ? validFlow.reduce((s, r) => s + r.investor.외국인수량 + r.investor.기관수량, 0)
      : null;

    const momentumScore = normalize(weightedChange, -4, 4);
    const breadthScore = breadthPct;
    const strengthScore = avgRangePos;
    const volatilityScore = avgVol !== null ? Math.max(0, Math.min(100, 100 - normalize(avgVol, 20, 60))) : null;
    const flowScore = netForeignOrg !== null ? (netForeignOrg > 0 ? 65 : netForeignOrg < 0 ? 35 : 50) : null;

    const scores = [momentumScore, breadthScore, strengthScore, volatilityScore, flowScore].filter(v => v !== null);
    const finalScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      note: '이 화면 전체를 복사해서 Claude에게 붙여넣어 주세요.',
      summary: {
        시총가중등락률: weightedChange.toFixed(2) + '%',
        상승비율: breadthPct.toFixed(1) + '%',
        평균52주위치: avgRangePos.toFixed(1) + '%',
        평균연환산변동성: avgVol !== null ? avgVol.toFixed(1) + '%' : '계산불가',
        외국인기관순매수합: netForeignOrg,
        '5-Factor점수': {
          모멘텀: momentumScore.toFixed(1),
          시장폭: breadthScore.toFixed(1),
          시장강도: strengthScore.toFixed(1),
          변동성: volatilityScore !== null ? volatilityScore.toFixed(1) : 'N/A',
          자금흐름: flowScore !== null ? flowScore.toFixed(1) : 'N/A',
        },
        최종점수: Math.round(finalScore),
      },
      details: results,
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message,
      cause: e.cause ? (e.cause.message || String(e.cause)) : null,
      stack: e.stack ? e.stack.split('\n').slice(0, 5) : null
    });
  }
};
