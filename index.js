// api/index.js
// Vercel Serverless Function
// 미국: CNN Fear & Greed Index API
// 한국: Yahoo Finance KOSPI 데이터로 계산

export default async function handler(req, res) {
  // CORS 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate'); // 1시간 캐시

  try {
    const [usData, krData] = await Promise.all([
      fetchUSFearGreed(),
      fetchKRFearGreed()
    ]);

    res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      us: usData,
      kr: krData
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// ─────────────────────────────────────────────
// 미국: CNN Fear & Greed Index 직접 가져오기
// ─────────────────────────────────────────────
async function fetchUSFearGreed() {
  try {
    const url = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata/' + getDateString();
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FearGreedBot/1.0)',
        'Referer': 'https://www.cnn.com/markets/fear-and-greed'
      }
    });

    if (!response.ok) throw new Error('CNN API 응답 오류');

    const data = await response.json();
    const current = data.fear_and_greed;

    return {
      score: Math.round(current.score),
      label: getLabelUS(current.score),
      rating: current.rating,
      previous_close: Math.round(current.previous_close),
      previous_1_week: Math.round(current.previous_1_week),
      previous_1_month: Math.round(current.previous_1_month),
      previous_1_year: Math.round(current.previous_1_year),
      indicators: {
        market_momentum: Math.round(data.fear_and_greed_historical?.data?.[0]?.x ?? current.score),
      },
      source: 'CNN Fear & Greed Index'
    };
  } catch (e) {
    // CNN API 실패 시 fallback
    console.error('CNN API error:', e.message);
    return await fetchUSFallback();
  }
}

// CNN API 실패 시 대체 데이터
async function fetchUSFallback() {
  try {
    // Yahoo Finance VIX + S&P500 데이터로 간이 계산
    const [vix, sp500] = await Promise.all([
      fetchYahooFinance('^VIX'),
      fetchYahooFinance('^GSPC')
    ]);

    // VIX 기반 간이 공포탐욕 계산 (VIX 높을수록 공포)
    const vixScore = Math.max(0, Math.min(100, 100 - (vix.price - 10) * 3));
    const momentumScore = sp500.change > 0 ? 55 + sp500.changePercent * 5 : 45 + sp500.changePercent * 5;
    const score = Math.round((vixScore * 0.5 + momentumScore * 0.5));

    return {
      score: Math.max(0, Math.min(100, score)),
      label: getLabelUS(score),
      vix: vix.price,
      sp500_change: sp500.changePercent,
      source: 'Yahoo Finance (VIX 기반 추정)'
    };
  } catch (e) {
    return { score: 45, label: '중립', source: '데이터 로딩 실패' };
  }
}

// ─────────────────────────────────────────────
// 한국: KOSPI 데이터 기반 공포탐욕 계산
// ─────────────────────────────────────────────
async function fetchKRFearGreed() {
  try {
    // 여러 한국 시장 지표 동시 조회
    const [kospi, kosdaq, vkospi] = await Promise.all([
      fetchYahooFinance('^KS11'),   // KOSPI
      fetchYahooFinance('^KQ11'),   // KOSDAQ
      fetchYahooFinance('^VKOSPI') // VKOSPI (한국판 VIX)
    ]);

    // 7가지 지표 계산 (CNN 방식 한국 적용)
    const indicators = calculateKRIndicators(kospi, kosdaq, vkospi);
    const score = Math.round(
      indicators.reduce((sum, ind) => sum + ind.value, 0) / indicators.length
    );

    return {
      score: Math.max(0, Math.min(100, score)),
      label: getLabelKR(score),
      kospi_price: kospi.price,
      kospi_change: kospi.changePercent,
      kosdaq_change: kosdaq.changePercent,
      vkospi: vkospi.price,
      indicators: indicators,
      source: 'Yahoo Finance KOSPI 데이터'
    };
  } catch (e) {
    console.error('KR data error:', e.message);
    return { score: 40, label: '공포', source: '데이터 로딩 실패' };
  }
}

function calculateKRIndicators(kospi, kosdaq, vkospi) {
  // 1. 시장 모멘텀 (당일 등락 기반)
  const momentum = normalizeChange(kospi.changePercent, -5, 5);

  // 2. 주가 강도 (KOSPI + KOSDAQ 평균)
  const strength = normalizeChange((kospi.changePercent + kosdaq.changePercent) / 2, -5, 5);

  // 3. 주가 폭 (KOSDAQ vs KOSPI 상대 강도)
  const breadth = normalizeChange(kosdaq.changePercent - kospi.changePercent, -3, 3);

  // 4. 변동성 VKOSPI (낮을수록 탐욕)
  const volatility = vkospi.price > 0
    ? Math.max(0, Math.min(100, 100 - (vkospi.price - 10) * 3))
    : 50;

  // 5. 안전자산 수요 (KOSPI 등락 반영)
  const safeHaven = normalizeChange(-kospi.changePercent, -5, 5);

  // 6. 시장 모멘텀 추세 (전일대비)
  const trend = kospi.changePercent > 0 ? 60 : 40;

  // 7. 종합 심리
  const sentiment = (momentum + volatility) / 2;

  return [
    { name: '시장 모멘텀', value: momentum },
    { name: '주가 강도', value: strength },
    { name: '주가 폭 (KOSDAQ)', value: breadth },
    { name: '변동성 (VKOSPI)', value: volatility },
    { name: '안전자산 수요', value: safeHaven },
    { name: '추세 강도', value: trend },
    { name: '종합 심리', value: sentiment },
  ];
}

// ─────────────────────────────────────────────
// Yahoo Finance 데이터 조회
// ─────────────────────────────────────────────
async function fetchYahooFinance(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible)',
      'Accept': 'application/json'
    }
  });

  if (!response.ok) throw new Error(`Yahoo Finance ${symbol} 오류`);

  const data = await response.json();
  const result = data.chart.result[0];
  const meta = result.meta;

  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose;
  const change = price - prevClose;
  const changePercent = (change / prevClose) * 100;

  return { symbol, price, prevClose, change, changePercent };
}

// ─────────────────────────────────────────────
// 유틸 함수
// ─────────────────────────────────────────────
function normalizeChange(value, min, max) {
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

function getDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getLabelUS(score) {
  if (score < 25) return 'Extreme Fear';
  if (score < 45) return 'Fear';
  if (score < 55) return 'Neutral';
  if (score < 75) return 'Greed';
  return 'Extreme Greed';
}

function getLabelKR(score) {
  if (score < 25) return '극단적 공포';
  if (score < 45) return '공포';
  if (score < 55) return '중립';
  if (score < 75) return '탐욕';
  return '극단적 탐욕';
}
