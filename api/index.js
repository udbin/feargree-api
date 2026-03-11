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
  // CNN 여러 엔드포인트 순서대로 시도
  const endpoints = [
    'https://production.dataviz.cnn.io/index/fearandgreed/graphdata/previous_close',
    `https://production.dataviz.cnn.io/index/fearandgreed/graphdata/${getDateString()}`,
    'https://production.dataviz.cnn.io/index/fearandgreed/graphdata/2025-01-01',
  ];
  const hdrs = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://www.cnn.com/markets/fear-and-greed',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://www.cnn.com',
    'Cache-Control': 'no-cache'
  };

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: hdrs });
      if (!res.ok) continue;
      const data = await res.json();
      const fg = data.fear_and_greed;
      if (!fg || !fg.score) continue;
      const s  = Math.round(fg.score);
      const sp = Math.round(fg.previous_close || s);
      const sw = Math.round(fg.previous_1_week || s);
      let vixScore = 50;
      try { const vix = await fetchYahoo('^VIX'); vixScore = Math.max(0, Math.min(100, 100 - (vix.price - 10) * 3.3)); } catch(e) {}
      return {
        score: s, label: getLabel(s),
        previous_close: sp, previous_1_week: sw,
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
    } catch(e) { console.warn(`CNN 엔드포인트 실패 ${url}:`, e.message); }
  }
  // 모두 실패시 VIX + S&P500 + HYG(정크본드) + TLT(국채) 기반 직접 계산
  return await fetchUSFallback();
}

async function fetchUSFallback() {
  try {
    // VIX, S&P500, 정크본드(HYG), 국채(TLT) 동시 조회
    const [vix, sp500, hyg, tlt] = await Promise.allSettled([
      fetchYahoo('^VIX'),
      fetchYahoo('^GSPC'),
      fetchYahoo('HYG'),   // 정크본드 ETF
      fetchYahoo('TLT'),   // 장기국채 ETF
    ]);

    const vixPrice      = vix.status === 'fulfilled'   ? vix.value.price        : 20;
    const spChange      = sp500.status === 'fulfilled' ? sp500.value.changePercent : 0;
    const hygChange     = hyg.status === 'fulfilled'   ? hyg.value.changePercent  : 0;
    const tltChange     = tlt.status === 'fulfilled'   ? tlt.value.changePercent  : 0;

    // 각 지표를 0~100으로 환산
    const vixScore      = Math.max(0, Math.min(100, 100 - (vixPrice - 10) * 3.5));  // VIX 낮을수록 탐욕
    const momentumScore = Math.max(0, Math.min(100, 50 + spChange * 12));            // S&P500 모멘텀
    const junkScore     = Math.max(0, Math.min(100, 50 + hygChange * 15));           // 정크본드 수요
    const safeHaven     = Math.max(0, Math.min(100, 50 - tltChange * 10));           // 안전자산 역방향

    // CNN 가중 평균 모방 (동일 가중)
    const score = Math.round((vixScore + momentumScore + junkScore + safeHaven) / 4);

    return {
      score, label: getLabel(score),
      previous_close: score,
      previous_1_week: score,
      indicators: [
        { name: '시장 모멘텀',   value: Math.round(momentumScore) },
        { name: '변동성 (VIX)', value: Math.round(vixScore) },
        { name: '풋/콜 비율',   value: Math.round((momentumScore + vixScore) / 2) },
        { name: '정크본드 수요', value: Math.round(junkScore) },
        { name: '안전자산 수요', value: Math.round(safeHaven) },
        { name: '주가 강도',    value: Math.min(100, Math.round(momentumScore * 1.05)) },
        { name: '주가 폭',      value: Math.round(momentumScore * 0.95) }
      ],
      source: 'Yahoo Finance (VIX·S&P500·HYG·TLT 기반)'
    };
  } catch (e) {
    return { score: 45, label: '중립', previous_close: 45, previous_1_week: 45,
      indicators: Array(7).fill(0).map((_, i) => ({ name: ['시장 모멘텀','변동성','풋/콜','정크본드','안전자산','주가 강도','주가 폭'][i], value: 45 })),
      source: '로딩 실패' };
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

    // VKOSPI — 네이버금융 → Yahoo → VIX추정 순서로 시도
    let vkospiVal = 20;
    try {
      vkospiVal = await fetchVKOSPI();
    } catch(e) {
      console.warn('VKOSPI 전체 실패:', e.message);
    }

    console.log(`KOSPI: ${kospi.price} (${kospi.changePercent.toFixed(2)}%)`);
    console.log(`KOSDAQ: ${kosdaq.price} (${kosdaq.changePercent.toFixed(2)}%)`);
    console.log(`VKOSPI: ${vkospiVal}`);

    // 실제 시장 기준: VKOSPI 15=안정, 30+=경계(패널티 시작), 40+=공포, 70+=극단공포
    const vkospiPenalty = vkospiVal > 30 ? Math.min(1, (vkospiVal - 30) / 50) : 0;
    const cap = Math.round(100 - vkospiPenalty * 50); // VKOSPI 80이면 상한 50

    const momentum   = Math.min(cap, normalize(kospi.changePercent, -4, 4));
    const strength   = Math.min(cap, normalize((kospi.changePercent + kosdaq.changePercent) / 2, -4, 4));
    const breadth    = normalize(kosdaq.changePercent - kospi.changePercent, -3, 3);
    // VKOSPI 15(안정)→100점, 40(공포)→50점, 70(극단)→0점
    const volatility = Math.max(0, Math.min(100, (70 - vkospiVal) / (70 - 15) * 100));
    const safeHaven  = normalize(-kospi.changePercent, -4, 4);
    const trend      = Math.min(cap, kospi.changePercent > 0
      ? Math.min(100, 55 + kospi.changePercent * 5)
      : Math.max(0, 45 + kospi.changePercent * 5));
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

    // VKOSPI에 가중치 2배 부여 (VIX처럼 시장 공포의 핵심 지표)
    const weightedScore = (
      momentum * 1 +
      strength * 1 +
      breadth  * 1 +
      volatility * 2 +  // VKOSPI 가중치 2배
      safeHaven * 1 +
      trend    * 1 +
      sentiment * 1
    ) / 8;

    const score = Math.max(0, Math.min(100, Math.round(weightedScore)));

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

// VKOSPI 전용 — 네이버금융 스크래핑 → Yahoo → VIX추정
async function fetchVKOSPI() {
  // 1차: 네이버금융 VKOSPI 페이지 스크래핑
  try {
    const res = await fetch('https://finance.naver.com/sise/sise_index.naver?code=VKOSPI', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'ko-KR,ko;q=0.9'
      }
    });
    if (res.ok) {
      const html = await res.text();
      // 네이버금융 현재가: <span class="num_total">XX.XX</span> 또는 <strong id="VKOSPI_current_value">
      const match = html.match(/id="VKOSPI_current_value"[^>]*>([\d.]+)/)
                 || html.match(/class="num_total"[^>]*>\s*([\d.]+)/)
                 || html.match(/"now":\s*"([\d.]+)"/)
                 || html.match(/현재가[^>]*>\s*<[^>]+>([\d.]+)/);
      if (match) {
        const v = parseFloat(match[1]);
        if (v > 5 && v < 200) { console.log(`VKOSPI 네이버: ${v}`); return v; }
      }
    }
  } catch(e) { console.warn('VKOSPI 네이버 실패:', e.message); }

  // 2차: KRX 데이터 API
  try {
    const res = await fetch('https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://data.krx.co.kr'
      },
      body: 'bld=dbms/MDC/STAT/standard/MDCSTAT09601&indIdx=1&indIdx2=001'
    });
    if (res.ok) {
      const data = await res.json();
      // VKOSPI 항목 찾기
      const rows = data.output || data.OutBlock_1 || [];
      for (const row of rows) {
        const name = row.IDX_NM || row.idxNm || '';
        if (name.includes('VKOSPI') || name.includes('변동성')) {
          const v = parseFloat(row.CLSPRC_IDX || row.clsprcIdx || 0);
          if (v > 5 && v < 200) { console.log(`VKOSPI KRX: ${v}`); return v; }
        }
      }
    }
  } catch(e) { console.warn('VKOSPI KRX 실패:', e.message); }

  // 3차: Yahoo Finance ^VKOSPI
  try {
    const vk = await fetchYahoo('^VKOSPI');
    if (vk.price > 5 && vk.price < 200) { console.log(`VKOSPI Yahoo: ${vk.price}`); return vk.price; }
  } catch(e) { console.warn('VKOSPI Yahoo 실패:', e.message); }

  // 4차: VIX 기반 추정 (한미 변동성 상관계수 ~0.85, VKOSPI가 VIX보다 평균 40% 높음)
  try {
    const vix = await fetchYahoo('^VIX');
    const estimated = Math.min(150, vix.price * 1.4);
    console.log(`VKOSPI VIX추정: ${estimated} (VIX=${vix.price})`);
    return estimated;
  } catch(e) {}

  throw new Error('VKOSPI 모든 소스 실패');
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
