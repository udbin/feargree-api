// api/sector-check.js - 섹터별 5-Factor 공포탐욕지수 (통합, 파라미터로 섹터 선택)
//
// 사용법 (섹터마다 URL 뒤에 ?sector=코드 만 바꿔서 접속):
//   https://feargree-api.vercel.app/api/sector-check?sector=semi      (반도체)
//   https://feargree-api.vercel.app/api/sector-check?sector=battery  (2차전지)
//   https://feargree-api.vercel.app/api/sector-check?sector=bio      (바이오)
//   https://feargree-api.vercel.app/api/sector-check?sector=defense  (방산)
//
// 한 번에 4개 다 돌리면 타임아웃 위험이 커서, 섹터 하나씩 따로 호출하는 구조예요.
// 섹터당 10종목 x 3API = 30콜, 완료까지 25~35초 정도 걸려요.

const KIS_APP_KEY    = process.env.KIS_APP_KEY;
const KIS_APP_SECRET = process.env.KIS_APP_SECRET;
const KIS_BASE        = 'https://openapi.koreainvestment.com:9443';

const REDIS_URL   = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

// ── 섹터별 대표 종목 (시가총액 상위 10개) ──
const SECTORS = {
  semi: {
    label: '반도체',
    stocks: [
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
    ]
  },
  battery: {
    label: '2차전지',
    stocks: [
      { code: '373220', name: 'LG에너지솔루션' },
      { code: '006400', name: '삼성SDI' },
      { code: '003670', name: '포스코퓨처엠' },
      { code: '247540', name: '에코프로비엠' },
      { code: '086520', name: '에코프로' },
      { code: '066970', name: '엘앤에프' },
      { code: '005070', name: '코스모신소재' },
      { code: '278280', name: '천보' },
      { code: '121600', name: '나노신소재' },
      { code: '361610', name: 'SK아이이테크놀로지' },
    ]
  },
  bio: {
    label: '바이오',
    stocks: [
      { code: '207940', name: '삼성바이오로직스' },
      { code: '068270', name: '셀트리온' },
      { code: '000100', name: '유한양행' },
      { code: '128940', name: '한미약품' },
      { code: '196170', name: '알테오젠' },
      { code: '141080', name: '리가켐바이오' },
      { code: '028300', name: 'HLB' },
      { code: '185750', name: '종근당' },
      { code: '302440', name: 'SK바이오사이언스' },
      { code: '068760', name: '셀트리온제약' },
    ]
  },
  defense: {
    label: '방산',
    stocks: [
      { code: '012450', name: '한화에어로스페이스' },
      { code: '079550', name: 'LIG넥스원' },
      { code: '064350', name: '현대로템' },
      { code: '272210', name: '한화시스템' },
      { code: '047810', name: '한국항공우주' },
      { code: '103140', name: '풍산' },
      { code: '065450', name: '빅텍' },
      { code: '005870', name: '휴니드' },
      { code: '042660', name: '한화오션' },
      { code: '077970', name: 'STX엔진' },
    ]
  },
};

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
  } catch (e) { /* 무시 */ }
}

// index.js / cron-close.js와 동일한 Redis 키로 토큰 공유
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

async function fetchDailyChart(token, code) {
  const d1 = daysAgoStr(90);
  const d2 = todayStr();
  const res = await fetch(
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}&FID_INPUT_DATE_1=${d1}&FID_INPUT_DATE_2=${d2}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=1`,
    { headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}`, appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET, tr_id: 'FHKST03010100', custtype: 'P' } }
  );
  const data = await res.json();
  const rows = data.output2;
  if (!res.ok || !Array.isArray(rows) || rows.length < 15) {
    return { error: `dailyChart HTTP ${res.status} or 데이터 부족`, raw: rows ? rows.length : data };
  }
  const closes = rows.map(r => parseFloat(r.stck_clpr)).filter(v => v > 0).reverse();
  const last60 = closes.slice(-60);
  if (last60.length < 15) return { error: '유효 종가 데이터 15개 미만' };

  const returns = [];
  for (let i = 1; i < last60.length; i++) returns.push((last60[i] - last60[i - 1]) / last60[i - 1]);

  function annualizedVol(arr) {
    if (arr.length < 2) return null;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const v = arr.reduce((a, b) => a + Math.pow(b - m, 2), 0) / arr.length;
    return Math.sqrt(v) * Math.sqrt(252) * 100;
  }

  const recentReturns = returns.slice(-10);
  const baselineReturns = returns.slice(0, -10);
  const recentVol = annualizedVol(recentReturns);
  const baselineVol = annualizedVol(baselineReturns.length >= 10 ? baselineReturns : returns);
  const volRatio = (recentVol !== null && baselineVol) ? recentVol / baselineVol : null;

  return {
    recentVolPct: recentVol !== null ? parseFloat(recentVol.toFixed(1)) : null,
    baselineVolPct: baselineVol !== null ? parseFloat(baselineVol.toFixed(1)) : null,
    volRatio: volRatio !== null ? parseFloat(volRatio.toFixed(2)) : null,
    sampleDays: last60.length
  };
}

async function fetchInvestorTrend(token, code) {
  const res = await fetch(
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/investor-trend-estimate?MKSC_SHRN_ISCD=${code}`,
    { headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}`, appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET, tr_id: 'HHPTJ04160200', custtype: 'P' } }
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

    const sectorKey = (req.query && req.query.sector) || 'semi';
    const sector = SECTORS[sectorKey];
    if (!sector) {
      return res.status(400).json({
        success: false,
        error: `알 수 없는 sector 파라미터: "${sectorKey}"`,
        사용가능한섹터: Object.keys(SECTORS)
      });
    }

    const token = await getKISToken();
    const results = [];

    for (const stock of sector.stocks) {
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

    const validVol = valid.filter(r => r.chart && !r.chart.error && r.chart.volRatio !== null);
    const avgVolRatio = validVol.length ? validVol.reduce((s, r) => s + r.chart.volRatio, 0) / validVol.length : null;

    // [변경됨] 수량 단순 합산 -> 종목별 (수량 x 가격)으로 "금액" 환산 후 합산
    //          -> 대형주/소형주 간 가격 차이로 왜곡되던 문제 해결
    const validFlow = valid.filter(r => r.investor && !r.investor.error);
    const netForeignOrgValue = validFlow.length
      ? validFlow.reduce((s, r) => s + (r.investor.외국인수량 + r.investor.기관수량) * r.price.price, 0)
      : null;
    // 바스켓 전체 시가총액(억원) 대비 순매수 금액 비율(%)로 정규화 -> 섹터 규모와 무관하게 공정 비교
    const totalCapWon = totalCap * 1e8; // 억원 -> 원
    const flowPct = (netForeignOrgValue !== null && totalCapWon > 0) ? (netForeignOrgValue / totalCapWon) * 100 : null;

    const momentumScore = normalize(weightedChange, -8, 8); // [변경됨] -4~4 -> -8~8 (급등락일에도 변별력 유지)
    const breadthScore = breadthPct;
    const strengthScore = avgRangePos;
    const volatilityScore = avgVolRatio !== null
      ? Math.max(0, Math.min(100, 100 - normalize(avgVolRatio, 0.5, 2.0)))
      : null;
    const flowScore = flowPct !== null ? normalize(flowPct, -0.3, 0.3) : null; // ±0.3%가 이 추정치 API 특성상 상당히 큰 편이라 이 정도로 스케일링

    const scores = [momentumScore, breadthScore, strengthScore, volatilityScore, flowScore].filter(v => v !== null);
    const finalScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    // 섹터별 결과도 Redis에 저장해두면, 나중에 사이트 페이지에서 매번 API 재조회 없이 바로 불러다 쓸 수 있어요
    await kvSetSimple(`feargreed:sector:${sectorKey}`, {
      date: todayStr(),
      score: Math.round(finalScore),
      label: sector.label,
      updatedAt: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      섹터: sector.label,
      섹터코드: sectorKey,
      timestamp: new Date().toISOString(),
      note: '이 화면 전체를 복사해서 Claude에게 붙여넣어 주세요.',
      summary: {
        시총가중등락률: weightedChange.toFixed(2) + '%',
        상승비율: breadthPct.toFixed(1) + '%',
        평균52주위치: avgRangePos.toFixed(1) + '%',
        평균변동성비율: avgVolRatio !== null ? avgVolRatio.toFixed(2) + ' (1.0=평소수준)' : '계산불가',
        외국인기관순매수금액_억원: netForeignOrgValue !== null ? Math.round(netForeignOrgValue / 1e8) : null,
        시총대비순매수비율: flowPct !== null ? flowPct.toFixed(3) + '%' : '계산불가',
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
