// api/token-check.js - 실전 토큰 발급/캐싱만 단독 테스트
// 사용법: https://feargree-api.vercel.app/api/token-check

const KIS_REAL_BASE   = 'https://openapi.koreainvestment.com:9443';
const KIS_REAL_APPKEY = process.env.KIS_REAL_APP_KEY;
const KIS_REAL_SECRET = process.env.KIS_REAL_APP_SECRET;

const REDIS_URL   = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGetSimple(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return { error: 'Redis env 없음' };
  const res = await fetch(`${REDIS_URL}/get/${key}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  if (!res.ok) return { error: `kvGet HTTP ${res.status}` };
  const json = await res.json();
  if (json.result === null || json.result === undefined) return null;
  try { return typeof json.result === 'string' ? JSON.parse(json.result) : json.result; }
  catch (e) { return { error: 'parse 실패', raw: json.result }; }
}

async function kvSetSimple(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return { error: 'Redis env 없음' };
  const res = await fetch(`${REDIS_URL}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value))
  });
  return res.ok ? { ok: true } : { error: `kvSet HTTP ${res.status}` };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const debug = {
    env체크: {
      KIS_REAL_APP_KEY_있음: !!KIS_REAL_APPKEY,
      KIS_REAL_APP_KEY_길이: KIS_REAL_APPKEY ? KIS_REAL_APPKEY.length : 0,
      KIS_REAL_APP_SECRET_있음: !!KIS_REAL_SECRET,
      KIS_REAL_APP_SECRET_길이: KIS_REAL_SECRET ? KIS_REAL_SECRET.length : 0,
      REDIS_URL_있음: !!REDIS_URL,
      REDIS_TOKEN_있음: !!REDIS_TOKEN,
    }
  };

  // 1) 캐시 확인
  const cached = await kvGetSimple('semi:realtoken');
  debug.캐시조회결과 = cached;

  if (cached && cached.token && cached.expiresAt && Date.now() < cached.expiresAt) {
    debug.결과 = '캐시된 토큰 사용 (재발급 안 함)';
    debug.토큰앞10자 = cached.token.slice(0, 10) + '...';
    debug.만료까지남은시간_분 = Math.round((cached.expiresAt - Date.now()) / 60000);
    return res.status(200).json({ success: true, ...debug });
  }

  // 2) 캐시 없으면 새로 발급 시도
  try {
    const tokenRes = await fetch(`${KIS_REAL_BASE}/oauth2/tokenP`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', appkey: KIS_REAL_APPKEY, appsecret: KIS_REAL_SECRET })
    });
    const tokenText = await tokenRes.text();
    debug.토큰발급HTTP상태 = tokenRes.status;
    debug.토큰발급응답원문 = tokenText;

    if (!tokenRes.ok) {
      return res.status(200).json({ success: false, 결과: '토큰 발급 실패', ...debug });
    }

    const data = JSON.parse(tokenText);
    const expiresInSec = data.expires_in || 86400;
    const expiresAt = Date.now() + (expiresInSec - 600) * 1000;
    const saveResult = await kvSetSimple('semi:realtoken', { token: data.access_token, expiresAt });

    debug.결과 = '새 토큰 발급 성공 + 캐시 저장';
    debug.캐시저장결과 = saveResult;
    debug.토큰앞10자 = data.access_token.slice(0, 10) + '...';

    return res.status(200).json({ success: true, ...debug });
  } catch (e) {
    return res.status(200).json({
      success: false,
      결과: 'fetch 예외 발생',
      error: e.message,
      cause: e.cause ? (e.cause.message || String(e.cause)) : null,
      ...debug
    });
  }
};
