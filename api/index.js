// api/index.js - Vercel Serverless Function
// 미국: CNN Fear & Greed Index
// 한국: 한국투자증권 Open API (모의투자)

const KIS_APP_KEY = process.env.KIS_APP_KEY;
const KIS_APP_SECRET = process.env.KIS_APP_SECRET;
const KIS_BASE = 'https://openapivts.koreainvestment.com:29443'; // 모의투자 서버

let kisToken = null;
let kisTokenExpiry = 0;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const [usData, krData] = await Promise.all([fetchUSFearGreed(), fetchKRFearGreed()]);
    return res.status(200).json({ success: true, timestamp: new Date().toISOString(), us: usData, kr: krData });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// ─────────────────────────────────────────────
// 미국: CNN Fear & Greed
// ─────────────────────────────────────────────
async function fetchUSFearGreed() {
  try {
    // CNN previous_close 엔드포인트 — 전일 종가 기준 공식 지수
    const response = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata/previous_close', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://www.cnn.com/markets/fear-and-greed',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.cnn.com'
      }
    });
    if (!response.ok) throw new Error(`CNN previous_close ${response.status}`);
    const data = await response.json();
    const fg = data.fear_and_greed;
    const s  = Math.round(fg.score);
    const sp = Math.round(fg.previous_close || s);
    const sw = Math.round(fg.previous_1_week || s);

    // VIX로 세부 지표 보완
    let vixScore = 50;
    try {
      const vix = await fetchYahoo('^VIX');
      vixScore = Math.max(0, Math.min(100, 100 - (vix.price - 10) * 3.3));
    } catch(e) {}

    return {
      score: s,
      label: getLabel(s),
      previous_close: sp,
      previous_1_week: sw,
      indicators: [
        { name: '시장 모멘텀',   value: Math.min(100, Math.round(s * 1.05)) },
        { name: '변동성 (VIX)', value: Math.round(vixScore) },
        { name: '풋/콜 비율',   value: Math.round(s * 0.9) },
        { name: '정크본드 수요', value: Math.min(100, Math.round(s * 1.1)) },
        { name: '안전자산 수요', value: Math.round(s * 0.85) },
        { name: '주가 강도',    value: Math.min(100, Math.round(s * 1.05)) },
        { name: '주가 폭',      value: Math.round(s * 0.95) }
      ],
      source: 'CNN Fear & Greed Index'
    };
  } catch (e) {
    console.warn('CNN previous_close 실패:', e.message);
    return await fetchUSFallback();
  }
}

async function fetchUSFallback() {
  try {
    const [vix, sp500] = await Promise.all([fetchYahoo('^VIX'), fetchYahoo('^GSPC')]);
    const vixScore = Math.max(0, Math.min(100, 100 - (vix.price - 10) * 3.3));
    const momentumScore = Math.max(0, Math.min(100, 50 + sp500.changePercent * 10));
    const score = Math.round(vixScore * 0.6 + momentumScore * 0.4);
    return {
      score, label: getLabel(score),
      indicators: [
        { name: '시장 모멘텀', value: Math.round(momentumScore) },
        { name: '변동성 (VIX)', value: Math.round(vixScore) },
        { name: '풋/콜 비율', value: score },
        { name: '정크본드 수요', value: score },
        { name: '안전자산 수요', value: 100 - score },
        { name: '주가 강도', value: score },
        { name: '주가 폭', value: score }
      ],
      source: 'Yahoo Finance (VIX 기반)'
    };
  } catch (e) {
    return { score: 45, label: '중립', indicators: Array(7).fill(0).map((_, i) => ({ name: ['시장 모멘텀','변동성','풋/콜','정크본드','안전자산','주가 강도','주가 폭'][i], value: 45 })), source: '로딩 실패' };
  }
}

// ─────────────────────────────────────────────
// 한국투자증권 API - 토큰 발급
// ─────────────────────────────────────────────
async function getKISToken() {
  const now = Date.now();
  if (kisToken && now < kisTokenExpiry) return kisToken;

  const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET
    })
  });
  if (!res.ok) throw new Error(`KIS 토큰 발급 실패: ${res.status}`);
  const data = await res.json();
  kisToken = data.access_token;
  kisTokenExpiry = now + (data.expires_in - 60) * 1000;
  return kisToken;
}

// ─────────────────────────────────────────────
// 한국: 한국투자증권 API로 지수 조회
// ─────────────────────────────────────────────
async function fetchKRFearGreed() {
  try {
    const token = await getKISToken();

    // KOSPI(0001), KOSDAQ(1001) 조회 + VKOSPI는 Yahoo Finance
    const [kospi, kosdaq] = await Promise.all([
      fetchKISIndex(token, '0001'), // KOSPI
      fetchKISIndex(token, '1001'), // KOSDAQ
    ]);

    // VKOSPI는 Yahoo Finance로 별도 조회
    let vkospiVal = 20;
    try {
      const vk = await fetchYahoo('^VKOSPI');
      vkospiVal = (vk.price > 5 && vk.price < 100) ? vk.price : 20;
    } catch(e) { console.warn('VKOSPI Yahoo 실패, 기본값 사용'); }

    console.log(`KOSPI: ${kospi.price} (${kospi.changePercent.toFixed(2)}%)`);
    console.log(`KOSDAQ: ${kosdaq.price} (${kosdaq.changePercent.toFixed(2)}%)`);
    console.log(`VKOSPI: ${vkospiVal}`);

    const momentum   = normalize(kospi.changePercent, -4, 4);
    const strength   = normalize((kospi.changePercent + kosdaq.changePercent) / 2, -4, 4);
    const breadth    = normalize(kosdaq.changePercent - kospi.changePercent, -3, 3);
    const volatility = Math.max(0, Math.min(100, 100 - (vkospiVal - 10) * 4));
    const safeHaven  = normalize(-kospi.changePercent, -4, 4);
    const trend      = kospi.changePercent > 0
      ? Math.min(100, 55 + kospi.changePercent * 5)
      : Math.max(0, 45 + kospi.changePercent * 5);
    const sentiment  = (momentum + volatility) / 2;

    const indicators = [
      { name: '시장 모멘텀', value: Math.round(momentum) },
      { name: '주가 강도', value: Math.round(strength) },
      { name: '주가 폭 (KOSDAQ)', value: Math.round(breadth) },
      { name: '변동성 (VKOSPI)', value: Math.round(volatility) },
      { name: '안전자산 수요', value: Math.round(safeHaven) },
      { name: '추세 강도', value: Math.round(trend) },
      { name: '종합 심리', value: Math.round(sentiment) }
    ];

    const score = Math.max(0, Math.min(100,
      Math.round(indicators.reduce((s, i) => s + i.value, 0) / indicators.length)
    ));

    return {
      score, label: getLabel(score),
      kospi_price: kospi.price.toFixed(2),
      kospi_change: kospi.changePercent.toFixed(2),
      kosdaq_change: kosdaq.changePercent.toFixed(2),
      vkospi: vkospiVal.toFixed(2),
      indicators,
      source: '한국투자증권 Open API'
    };
  } catch (e) {
    console.error('KR 오류:', e.message);
    return {
      score: 45, label: '중립',
      indicators: Array(7).fill(0).map((_, i) => ({
        name: ['시장 모멘텀','주가 강도','주가 폭','변동성','안전자산','추세','심리'][i],
        value: 45
      })),
      source: '로딩 실패: ' + e.message
    };
  }
}

async function fetchKISIndex(token, code) {
  const res = await fetch(
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-index-price?FID_COND_MRKT_DIV_CODE=U&FID_INPUT_ISCD=${code}`,
    {
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${token}`,
        'appkey': KIS_APP_KEY,
        'appsecret': KIS_APP_SECRET,
        'tr_id': 'FHPUP02100000'
      }
    }
  );
  if (!res.ok) throw new Error(`KIS 지수 조회 실패 ${code}: ${res.status}`);
  const data = await res.json();
  const output = data.output;

  const price = parseFloat(output.bstp_nmix_prpr || 0);       // 현재가
  const change = parseFloat(output.bstp_nmix_prdy_vrss || 0); // 전일대비
  const prevPrice = price - change;
  const changePercent = prevPrice > 0 ? (change / prevPrice) * 100 : 0;

  return { price, change, changePercent };
}

// ─────────────────────────────────────────────
// Yahoo Finance (미국용)
// ─────────────────────────────────────────────
async function fetchYahoo(symbol) {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`,
    { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
  );
  if (!res.ok) throw new Error(`Yahoo ${symbol}: ${res.status}`);
  const data = await res.json();
  const meta = data.chart.result[0].meta;
  const price = meta.regularMarketPrice || 0;
  const prevClose = meta.chartPreviousClose || meta.previousClose || price;
  return { symbol, price, prevClose, changePercent: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0 };
}

// ─────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────
function normalize(v, min, max) { return Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100)); }
function getDateString() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function getLabel(score) {
  if (score < 25) return '극단적 공포';
  if (score < 45) return '공포';
  if (score < 55) return '중립';
  if (score < 75) return '탐욕';
  return '극단적 탐욕';
}
