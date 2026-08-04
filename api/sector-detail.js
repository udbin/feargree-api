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

  const sectorKey = (req.query && req.query.sector) || 'semi';
  const data = await kvGetSimple(`feargreed:sector:${sectorKey}`);

  if (!data) {
    return res.status(404).json({ success: false, error: '아직 수집된 데이터가 없어요. 크론잡이 한 번 돌고 나면 채워져요.' });
  }

  return res.status(200).json({ success: true, sector: sectorKey, ...data });
};
