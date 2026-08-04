// api/semi-check-v2.js - 반도체 섹터 5-Factor 공포탐욕지수 (통합 버전)
// 사용법: 배포 후 브라우저에서 접속
//   https://feargree-api.vercel.app/api/semi-check-v2
//
// 종목당 API 3개(현재가/52주, 20일 일별시세, 외인기관 추정가집계) 호출
// 10종목 x 3API = 30콜, 요청 사이 0.35초 대기 (KIS 제한 보호)
// 전체 완료까지 대략 15~20초 정도 걸려요. 느리다고 놀라지 마세요!

const KIS_APP_KEY    = process.env.KIS_APP_KEY;
const KIS_APP_SECRET = process.env.KIS_APP_SECRET;
const KIS_BASE        = 'https://openapivts.koreainvestment.com:29443';

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

async function getKISToken() {
  const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`토큰 발급 실패: ${res.status} ${t}`);
  }
  return (await res.json()).access_token;
}

// API ① 현재가 + 52주 고저
async function fetchPrice(token, code) {
  const res = await fetch(
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`,
    { headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}`, appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET, tr_id: 'FHKST01010100' } }
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
  const d1 = daysAgoStr(30); // 주말/휴장 감안해 30일치 요청 -> 실제 거래일 20개 이상 확보
  const d2 = todayStr();
  const res = await fetch(
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}&FID_INPUT_DATE_1=${d1}&FID_INPUT_DATE_2=${d2}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=1`,
    { headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}`, appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET, tr_id: 'FHKST03010100' } }
  );
  const data = await res.json();
  const rows = data.output2;
  if (!res.ok || !Array.isArray(rows) || rows.length < 5) {
    return { error: `dailyChart HTTP ${res.status} or 데이터 부족`, raw: rows ? rows.length : data };
  }
  // 최신순으로 오는 경우가 많음 -> 종가만 뽑아서 오래된 순으로 정렬
  const closes = rows
    .map(r => parseFloat(r.stck_clpr))
    .filter(v => v > 0)
    .reverse();
  const last20 = closes.slice(-20);
  if (last20.length < 5) return { error: '유효 종가 데이터 5개 미만' };

  // 일별 수익률
  const returns = [];
  for (let i = 1; i < last20.length; i++) {
    returns.push((last20[i] - last20[i - 1]) / last20[i - 1]);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const dailyVol = Math.sqrt(variance);
  const annualizedVolPct = dailyVol * Math.sqrt(252) * 100; // 연환산 변동성(%)

  return { annualizedVolPct: parseFloat(annualizedVolPct.toFixed(2)), sampleDays: last20.length };
}

// API ③ 종목별 외인기관 추정가집계 (자금흐름용)
async function fetchInvestorTrend(token, code) {
  const res = await fetch(
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/investor-trend-estimate?MKSC_SHRN_ISCD=${code}`,
    { headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}`, appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET, tr_id: 'HHPTJ04160200' } }
  );
  const data = await res.json();
  // 이 API는 output2가 배열(최근 여러 시점)일 수 있어서 첫 번째(최신) 항목만 사용
  const arr = data.output2;
  const o = Array.isArray(arr) ? arr[0] : data.output;
  if (!res.ok || !o) return { error: `investorTrend HTTP ${res.status}`, raw: data };
  return {
    foreignNetQty: parseFloat(o.frgn_ntby_qty || 0),
    orgNetQty: parseFloat(o.orgn_ntby_qty || 0),
    _rawFields: Object.keys(o), // 실제 필드명 확인용 - 값이 이상하면 이 목록을 보고 필드명 조정
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!KIS_APP_KEY || !KIS_APP_SECRET) {
      return res.status(500).json({ success: false, error: 'KIS_APP_KEY 또는 KIS_APP_SECRET 환경변수 없음' });
    }

    const token = await getKISToken();
    const results = [];

    for (const stock of SEMI_STOCKS) {
      const row = { 종목명: stock.name, 종목코드: stock.code };

      const price = await fetchPrice(token, stock.code);
      row.price = price;
      await sleep(350);

      const chart = await fetchDailyChart(token, stock.code);
      row.chart = chart;
      await sleep(350);

      const investor = await fetchInvestorTrend(token, stock.code);
      row.investor = investor;
      await sleep(350);

      results.push(row);
    }

    // ── 5-Factor 계산 (시가총액 가중) ──
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
    const avgVol = validVol.length
      ? validVol.reduce((s, r) => s + r.chart.annualizedVolPct, 0) / validVol.length
      : null;

    const validFlow = valid.filter(r => r.investor && !r.investor.error);
    const netForeignOrg = validFlow.length
      ? validFlow.reduce((s, r) => s + r.investor.foreignNetQty + r.investor.orgNetQty, 0)
      : null;

    const momentumScore = normalize(weightedChange, -4, 4);
    const breadthScore = breadthPct;
    const strengthScore = avgRangePos;
    // 변동성: 낮을수록 탐욕(고득점), 높을수록 공포(저득점). 20~60% 대를 기준 레인지로 잡음(임시)
    const volatilityScore = avgVol !== null ? Math.max(0, Math.min(100, 100 - normalize(avgVol, 20, 60))) : null;
    // 자금흐름: 수량 기준이라 절대치 스케일이 종목마다 달라 임시로 부호만 반영 (양수=탐욕 방향)
    const flowScore = netForeignOrg !== null ? (netForeignOrg > 0 ? 65 : netForeignOrg < 0 ? 35 : 50) : null;

    const scores = [momentumScore, breadthScore, strengthScore, volatilityScore, flowScore].filter(v => v !== null);
    const finalScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      note: '이 화면 전체를 복사해서 Claude에게 붙여넣어 주세요. investor._rawFields를 보고 필드명이 맞는지도 같이 확인해드릴게요.',
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
    return res.status(500).json({ success: false, error: e.message });
  }
};
