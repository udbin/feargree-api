// api/cron-close.js - 매일 장마감 직후(15:35 KST) Vercel Cron이 자동 호출
// 사람이 접속하지 않아도 서버가 스스로 실행해서 그날 KOSPI/KOSDAQ 등락률을 Redis에 저장한다.

const KIS_APP_KEY    = process.env.KIS_APP_KEY;
const KIS_APP_SECRET = process.env.KIS_APP_SECRET;
const KIS_BASE       = 'https://openapi.koreainvestment.com:9443'; // [변경됨] 실전 도메인으로 통일

const REDIS_URL   = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvSetSimple(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) { console.warn('Redis env missing'); return; }
  const res = await fetch(`${REDIS_URL}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value))
  });
  const json = await res.json();
  console.log(`kvSetSimple[${key}] result:`, JSON.stringify(json));
}

async function kvGetSimple2(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/${key}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.result === null || json.result === undefined) return null;
    return typeof json.result === 'string' ? JSON.parse(json.result) : json.result;
  } catch (e) { return null; }
}

async function getKISToken() {
  // index.js와 같은 Redis 키(feargreed:kistoken)를 공유해서 1분당1회 제한 충돌 방지
  const cached = await kvGetSimple2('feargreed:kistoken');
  if (cached && cached.token && cached.expiresAt && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET })
  });
  if (!res.ok) throw new Error(`KIS token fail: ${res.status}`);
  const data = await res.json();
  const expiresAt = Date.now() + (data.expires_in - 600) * 1000;
  await kvSetSimple('feargreed:kistoken', { token: data.access_token, expiresAt });
  return data.access_token;
}

async function fetchKISIndexRaw(token, code) {
  const res = await fetch(
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-index-price?FID_COND_MRKT_DIV_CODE=U&FID_INPUT_ISCD=${code}`,
    { headers: { 'Content-Type': 'application/json', 'authorization': `Bearer ${token}`, 'appkey': KIS_APP_KEY, 'appsecret': KIS_APP_SECRET, 'tr_id': 'FHPUP02100000' } }
  );
  if (!res.ok) throw new Error(`KIS index ${code}: ${res.status}`);
  const data = await res.json();
  const o = data.output;
  const price = parseFloat(o.bstp_nmix_prpr || 0);
  const change = parseFloat(o.bstp_nmix_prdy_vrss || 0);
  const prev = price - change;
  const changePercent = prev > 0 ? (change / prev) * 100 : 0;
  return { price, change, changePercent };
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }

  try {
    const token = await getKISToken();
    const [kospi, kosdaq] = await Promise.all([
      fetchKISIndexRaw(token, '0001'),
      fetchKISIndexRaw(token, '1001')
    ]);

    const now = new Date().toISOString();

    const results = {};
    if (Math.abs(kospi.changePercent) > 0.001) {
      await kvSetSimple('feargreed:lastclose:0001', { changePercent: kospi.changePercent, updatedAt: now });
      results.kospi = kospi.changePercent;
    } else {
      results.kospi = 'skipped (0 or holiday)';
    }
    if (Math.abs(kosdaq.changePercent) > 0.001) {
      await kvSetSimple('feargreed:lastclose:1001', { changePercent: kosdaq.changePercent, updatedAt: now });
      results.kosdaq = kosdaq.changePercent;
    } else {
      results.kosdaq = 'skipped (0 or holiday)';
    }

    // ============================================================
    // [신규] 30일 히스토리(오늘 점수) 저장 — 하루 1번, 여기서만 수행
    // 저장 전용 API(/api)를 호출해서 오늘의 US/KR 최종 점수를 받아온다
    // ============================================================
    let historyResult = 'skipped';
    try {
      const scoreRes = await fetch('https://feargree-api.vercel.app/api');
      const scoreData = await scoreRes.json();
      if (scoreData && scoreData.success) {
        await saveHistoryEntry(scoreData.us.score, scoreData.kr.score);
        historyResult = { us: scoreData.us.score, kr: scoreData.kr.score };
      }
    } catch (e) {
      console.warn('history 저장 실패:', e.message);
      historyResult = 'error: ' + e.message;
    }

    console.log('cron-close 실행 완료:', JSON.stringify(results), 'history:', JSON.stringify(historyResult));
    return res.status(200).json({ success: true, timestamp: now, saved: results, history: historyResult });
  } catch (e) {
    console.error('cron-close 실패:', e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
};

// ── 히스토리(30일 추이) 하루 1회 저장 ──
function todayKST() {
  return new Date(Date.now() + 9*3600000).toISOString().slice(0,10);
}

async function kvGetSimple(key) {
  const res = await fetch(`${REDIS_URL}/get/${key}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  if (!res.ok) throw new Error(`kvGet HTTP ${res.status}`);
  const json = await res.json();
  let result = json.result;
  if (result === null || result === undefined) return null;
  // 과거에 이중으로 감싸져 저장된 값도 최대 5단계까지 풀어서 실제 값을 꺼낸다
  for (let i = 0; i < 5; i++) {
    let changed = false;
    if (Array.isArray(result) && result.length === 1) { result = result[0]; changed = true; }
    if (typeof result === 'string') {
      try { result = JSON.parse(result); changed = true; } catch(e) {}
    }
    if (!changed) break;
  }
  return result;
}

async function kvSetHistory(value) {
  // [변경됨] 배열로 감싸지 않고 문자열 하나로 저장 (kvSetSimple과 동일 방식)
  const res = await fetch(`${REDIS_URL}/set/feargreed:history`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value))
  });
  if (!res.ok) throw new Error(`kvSet HTTP ${res.status}`);
  return res.json();
}

async function saveHistoryEntry(usScore, krScore) {
  const today = todayKST();
  let history = await kvGetSimple('feargreed:history') || [];
  if (!Array.isArray(history)) history = [];
  const idx = history.findIndex(h => h.date === today);
  if (idx >= 0) { history[idx] = { date: today, us: usScore, kr: krScore }; }
  else { history.push({ date: today, us: usScore, kr: krScore }); }
  history = history.slice(-30);
  await kvSetHistory(history);
  return history;
}
