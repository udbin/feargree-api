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
    if (json.result === null || json.result === undefined) return null;
    return typeof json.result === 'string' ? JSON.parse(json.result) : json.result;
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
