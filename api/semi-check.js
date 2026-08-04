// api/semi-check.js - 반도체 대표 종목 10개 현재가를 브라우저에서 바로 확인
// 사용법: 배포 후 아래 주소를 브라우저에 입력하면 끝
//   https://feargree-api.vercel.app/api/semi-check
//
// (KIS 모의투자 도메인을 그대로 씁니다 - 기존 index.js/cron-close.js와 동일)

const KIS_APP_KEY    = process.env.KIS_APP_KEY;
const KIS_APP_SECRET = process.env.KIS_APP_SECRET;
const KIS_BASE        = 'https://openapivts.koreainvestment.com:29443';

// 조회할 반도체 대표 종목 10개 (시가총액 상위)
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

async function getKISToken() {
  const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET })
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`토큰 발급 실패: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function fetchStockPrice(token, code) {
  const res = await fetch(
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`,
    {
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${token}`,
        'appkey': KIS_APP_KEY,
        'appsecret': KIS_APP_SECRET,
        'tr_id': 'FHKST01010100'
      }
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { error: `HTTP ${res.status}: ${errText}` };
  }
  const data = await res.json();
  const o = data.output;
  if (!o) return { error: '응답에 output 없음', raw: data };

  return {
    현재가: o.stck_prpr,
    전일대비: o.prdy_vrss,
    등락률: o.prdy_ctrt + '%',
    거래량: o.acml_vol,
    시가총액: o.hts_avls,           // 억원 단위
    '52주최고가': o.w52_hgpr,
    '52주최저가': o.w52_lwpr,
    '52주최고가대비': o.w52_hgpr_vrss_prpr_rate ? o.w52_hgpr_vrss_prpr_rate + '%' : undefined,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!KIS_APP_KEY || !KIS_APP_SECRET) {
      return res.status(500).json({
        success: false,
        error: 'KIS_APP_KEY 또는 KIS_APP_SECRET 환경변수가 설정 안 되어 있어요. Vercel 프로젝트 설정 > Environment Variables 확인해주세요.'
      });
    }

    const token = await getKISToken();

    // 하나씩 순서대로 호출 (KIS 초당 호출 제한 보호용, 0.3초 간격)
    const results = [];
    for (const stock of SEMI_STOCKS) {
      try {
        const price = await fetchStockPrice(token, stock.code);
        results.push({ 종목명: stock.name, 종목코드: stock.code, ...price });
      } catch (e) {
        results.push({ 종목명: stock.name, 종목코드: stock.code, error: e.message });
      }
      await new Promise(r => setTimeout(r, 300));
    }

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      note: '이 화면 전체를 복사해서 Claude에게 붙여넣어 주시면 반도체 섹터 점수를 계산해드려요.',
      results
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
