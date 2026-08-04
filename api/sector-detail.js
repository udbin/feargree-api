// api/sector-detail.js - 섹터 카드 클릭시 상세페이지에서 호출 (Redis 캐시만 읽음, KIS 호출 없음)
// 사용법: https://feargree-api.vercel.app/api/sector-detail?sector=semi

const REDIS_URL   = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

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

  const sectorKey = (req.query && req.query.sector) || 'semi';
  const data = await kvGetSimple(`feargreed:sector:${sectorKey}`);

  if (!data) {
    return res.status(404).json({ success: false, error: '아직 수집된 데이터가 없어요. 크론잡이 한 번 돌고 나면 채워져요.' });
  }

  return res.status(200).json({ success: true, sector: sectorKey, ...data });
};
