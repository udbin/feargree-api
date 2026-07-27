// api/cron-close.js - 매일 장마감 직후(15:35 KST) Vercel Cron이 자동 호출
// 사람이 접속하지 않아도 서버가 스스로 실행해서 그날 KOSPI/KOSDAQ 등락률을 Redis에 저장한다.

const KIS_APP_KEY    = process.env.KIS_APP_KEY;
const KIS_APP_SECRET = process.env.KIS_APP_SECRET;
const KIS_BASE       = 'https://openapivts.koreainvestment.com:29443';

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

async function getKISToken() {
  const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET })
  });
  if (!res.ok) throw new Error(`KIS token fail: ${res.status}`);
  const data = await res.json();
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
  // Vercel Cron이 아닌 외부에서 함부로 호출 못하게 최소한의 보호
  // (선택) 환경변수 CRON_SECRET을 설정해두면 Vercel이 자동으로 Authorization 헤더에 넣어줌
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

    // 장마감 직후 호출이므로 값이 정상적이면(0이 아니면) 그대로 "오늘의 최종 종가"로 저장
    // 혹시 이 시점에도 0이 오면(공휴일 등) 기존 저장값을 건드리지 않고 건너뜀
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

    console.log('cron-close 실행 완료:', JSON.stringify(results));
    return res.status(200).json({ success: true, timestamp: now, saved: results });
  } catch (e) {
    console.error('cron-close 실패:', e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
};
