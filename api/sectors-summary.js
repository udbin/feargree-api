// api/sectors-summary.js - 메인 페이지용 경량 API (KIS 호출 없음, Redis 캐시만 즉시 읽음)
// 사용법: https://feargree-api.vercel.app/api/sectors-summary

const REDIS_URL   = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

const SECTOR_KEYS = ['semi', 'battery', 'bio', 'defense'];

async function kvGetSimple(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/${key}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
    if (!res.ok) return null;
    const json = await res.json();
    let result = json.result;
    if (result === null || result === undefined) return null;
    // [수정됨] 이중으로 감싸져 저장된 값도 최대 5단계까지 풀어서 실제 값을 꺼낸다 (index.js kvGet과 동일 로직)
    for (let i = 0; i < 5; i++) {
      let changed = false;
      if (Array.isArray(result) && result.length === 1) { result = result[0]; changed = true; }
      if (typeof result === 'string') {
        try { result = JSON.parse(result); changed = true; } catch (e) { /* 더 이상 JSON 아님 */ }
      }
      if (!changed) break;
    }
    return result;
  } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const sectors = {};
  for (const key of SECTOR_KEYS) {
    sectors[key] = await kvGetSimple(`feargreed:sector:${key}`);
  }

  return res.status(200).json({ success: true, sectors });
};
