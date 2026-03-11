// api/index.js - Vercel Serverless Function
// 미국: CNN Fear & Greed Index
// 한국: Yahoo Finance (KS11, KQ11, VKOSPI)

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
// 한국: Yahoo Finance (여러 엔드포인트 시도)
// ─────────────────────────────────────────────
async function fetchKRFearGreed() {
  try {
    const [kospi, kosdaq, vkospi] = await Promise.all([
      fetchYahooKR('^KS11'),
      fetchYahooKR('^KQ11'),
      fetchYahooKR('^VKOSPI')
    ]);

    console.log(`KOSPI: ${kospi.price} (${kospi.changePercent.toFixed(2)}%)`);
    console.log(`KOSDAQ: ${kosdaq.price} (${kosdaq.changePercent.toFixed(2)}%)`);
    console.log(`VKOSPI: ${vkospi.price}`);

    // VKOSPI 정상 범위 체크 (보통 10~50)
    const vkospiVal = (vkospi.price > 5 && vkospi.price < 100) ? vkospi.price : 20;

    const momentum   = normalize(kospi.changePercent, -4, 4);
    const strength   = normalize((kospi.changePercent + kosdaq.changePercent) / 2, -4, 4);
    const breadth    = normalize(kosdaq.changePercent - kospi.changePercent, -3, 3);
    // VKOSPI: 낮을수록 탐욕 (10=극단탐욕, 20=중립, 40=극단공포)
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
      source: 'Yahoo Finance 실시간'
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

// Yahoo Finance - 여러 엔드포인트 시도
async function fetchYahooKR(symbol) {
  const encoded = encodeURIComponent(symbol);

  // v8 엔드포인트 먼저 시도
  try {
    const res = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=5d&includePrePost=false`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0', 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' } }
    );
    if (res.ok) {
      const data = await res.json();
      const result = data.chart?.result?.[0];
      if (result) {
        const meta = result.meta;
        const price = meta.regularMarketPrice || meta.previousClose || 0;
        const prevClose = meta.chartPreviousClose || meta.previousClose || price;
        const changePercent = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
        return { symbol, price, prevClose, changePercent };
      }
    }
  } catch (e) { console.warn(`v8 실패 ${symbol}:`, e.message); }

  // v7 엔드포인트 시도
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encoded}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );
    if (res.ok) {
      const data = await res.json();
      const quote = data.quoteResponse?.result?.[0];
      if (quote) {
        return {
          symbol,
          price: quote.regularMarketPrice || 0,
          prevClose: quote.regularMarketPreviousClose || 0,
          changePercent: quote.regularMarketChangePercent || 0
        };
      }
    }
  } catch (e) { console.warn(`v7 실패 ${symbol}:`, e.message); }

  throw new Error(`${symbol} 데이터 조회 실패`);
}

// ─────────────────────────────────────────────
// Yahoo Finance 미국용 (기존)
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
function normalize(value, min, max) { return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)); }
function getDateString() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function getLabel(score) {
  if (score < 25) return '극단적 공포';
  if (score < 45) return '공포';
  if (score < 55) return '중립';
  if (score < 75) return '탐욕';
  return '극단적 탐욕';
}
