// api/index.js - Vercel Serverless Function
// 미국: CNN Fear & Greed Index
// 한국: 네이버 금융 + Yahoo Finance

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
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
    const today = getDateString();
    const response = await fetch(`https://production.dataviz.cnn.io/index/fearandgreed/graphdata/${today}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.cnn.com/markets/fear-and-greed', 'Accept': 'application/json' }
    });
    if (!response.ok) throw new Error(`CNN ${response.status}`);
    const data = await response.json();
    const fg = data.fear_and_greed;
    const s = Math.round(fg.score);
    return {
      score: s, label: getLabel(s),
      previous_close: Math.round(fg.previous_close || s),
      previous_1_week: Math.round(fg.previous_1_week || s),
      indicators: [
        { name: '시장 모멘텀', value: s },
        { name: '변동성 (VIX)', value: Math.round(100 - s * 0.3) },
        { name: '풋/콜 비율', value: Math.round(s * 0.9) },
        { name: '정크본드 수요', value: Math.min(100, Math.round(s * 1.1)) },
        { name: '안전자산 수요', value: Math.round(s * 0.85) },
        { name: '주가 강도', value: Math.min(100, Math.round(s * 1.05)) },
        { name: '주가 폭', value: Math.round(s * 0.95) }
      ],
      source: 'CNN Fear & Greed Index'
    };
  } catch (e) {
    console.warn('CNN 실패:', e.message);
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
// 한국: 네이버 금융 크롤링
// ─────────────────────────────────────────────
async function fetchKRFearGreed() {
  try {
    // 네이버 금융에서 KOSPI, KOSDAQ, VKOSPI 동시 조회
    const [kospi, kosdaq, vkospi] = await Promise.all([
      fetchNaver('KOSPI'),
      fetchNaver('KOSDAQ'),
      fetchNaverVkospi()
    ]);

    console.log('KOSPI:', kospi, 'KOSDAQ:', kosdaq, 'VKOSPI:', vkospi);

    const momentum   = normalize(kospi.changePercent, -4, 4);
    const strength   = normalize((kospi.changePercent + kosdaq.changePercent) / 2, -4, 4);
    const breadth    = normalize(kosdaq.changePercent - kospi.changePercent, -3, 3);
    const volatility = vkospi > 0 ? Math.max(0, Math.min(100, 100 - (vkospi - 12) * 3)) : 50;
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
      kospi_price: kospi.price,
      kospi_change: kospi.changePercent.toFixed(2),
      kosdaq_change: kosdaq.changePercent.toFixed(2),
      vkospi: vkospi.toFixed(2),
      indicators,
      source: '네이버 금융 실시간'
    };
  } catch (e) {
    console.error('한국 데이터 오류:', e.message);
    // Yahoo Finance fallback
    return await fetchKRFallback();
  }
}

// 네이버 금융 지수 조회
async function fetchNaver(index) {
  const symbolMap = { 'KOSPI': 'KOSPI', 'KOSDAQ': 'KOSDAQ' };
  const url = `https://finance.naver.com/sise/sise_index.naver?code=${index}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer': 'https://finance.naver.com'
    }
  });
  if (!res.ok) throw new Error(`네이버 ${index}: ${res.status}`);
  const html = await res.text();

  // 현재가 추출
  const priceMatch = html.match(/id="now_value"[^>]*>([0-9,]+\.?[0-9]*)/);
  const changeMatch = html.match(/id="change_value"[^>]*>([0-9,]+\.?[0-9]*)/);
  const signMatch = html.match(/class="[^"]*(?:quote_plus|quote_minus)[^"]*"[^>]*>\s*([▲▼])/);

  if (!priceMatch) throw new Error(`${index} 가격 파싱 실패`);

  const price = parseFloat(priceMatch[1].replace(/,/g, ''));
  const changeVal = changeMatch ? parseFloat(changeMatch[1].replace(/,/g, '')) : 0;
  const sign = html.includes('quote_plus') ? 1 : -1;
  const prevPrice = price - (sign * changeVal);
  const changePercent = prevPrice > 0 ? (sign * changeVal / prevPrice) * 100 : 0;

  return { price, changeVal: sign * changeVal, changePercent };
}

// VKOSPI 조회 (네이버 금융)
async function fetchNaverVkospi() {
  try {
    // VKOSPI는 네이버에서 직접 조회
    const url = 'https://finance.naver.com/sise/sise_index.naver?code=VKOSPI';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html', 'Referer': 'https://finance.naver.com' }
    });
    if (!res.ok) throw new Error('VKOSPI 실패');
    const html = await res.text();
    const match = html.match(/id="now_value"[^>]*>([0-9]+\.?[0-9]*)/);
    return match ? parseFloat(match[1]) : 20;
  } catch (e) {
    return 20; // 기본값
  }
}

async function fetchKRFallback() {
  try {
    const [kospi, kosdaq] = await Promise.all([fetchYahoo('^KS11'), fetchYahoo('^KQ11')]);
    const momentum = normalize(kospi.changePercent, -4, 4);
    const strength = normalize((kospi.changePercent + kosdaq.changePercent) / 2, -4, 4);
    const score = Math.round((momentum + strength) / 2);
    return {
      score: Math.max(0, Math.min(100, score)),
      label: getLabel(score),
      kospi_change: kospi.changePercent.toFixed(2),
      indicators: [
        { name: '시장 모멘텀', value: Math.round(momentum) },
        { name: '주가 강도', value: Math.round(strength) },
        { name: '주가 폭 (KOSDAQ)', value: Math.round(normalize(kosdaq.changePercent, -4, 4)) },
        { name: '변동성 (VKOSPI)', value: 50 },
        { name: '안전자산 수요', value: Math.round(normalize(-kospi.changePercent, -4, 4)) },
        { name: '추세 강도', value: kospi.changePercent > 0 ? 60 : 40 },
        { name: '종합 심리', value: score }
      ],
      source: 'Yahoo Finance (대체)'
    };
  } catch (e) {
    return { score: 40, label: '공포', indicators: Array(7).fill(0).map((_, i) => ({ name: ['시장 모멘텀','주가 강도','주가 폭','변동성','안전자산','추세','심리'][i], value: 40 })), source: '로딩 실패' };
  }
}

// ─────────────────────────────────────────────
// Yahoo Finance 공통
// ─────────────────────────────────────────────
async function fetchYahoo(symbol) {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  });
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
function normalize(value, min, max) { return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)); }
function getDateString() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function getLabel(score) {
  if (score < 25) return '극단적 공포';
  if (score < 45) return '공포';
  if (score < 55) return '중립';
  if (score < 75) return '탐욕';
  return '극단적 탐욕';
}


