// api/index.js - Vercel Serverless Function
const KIS_APP_KEY    = process.env.KIS_APP_KEY;
const KIS_APP_SECRET = process.env.KIS_APP_SECRET;
const KIS_BASE       = 'https://openapivts.koreainvestment.com:29443';

const REDIS_URL   = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

let kisToken = null;
let kisTokenExpiry = 0;

// ── Upstash Redis REST ──
async function kvGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) { console.warn('Redis env missing'); return null; }
  try {
    const res = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const json = await res.json();
    let result = json.result;
    if (result === null || result === undefined) return null;
    // 배열이면 첫 번째 요소 사용
    if (Array.isArray(result)) result = result[0];
    // 문자열이면 JSON 파싱
    if (typeof result === 'string') {
      try { result = JSON.parse(result); } catch(e) {
        try { result = JSON.parse(JSON.parse(result)); } catch(e2) { return null; }
      }
    }
    return result;
  } catch(e) { console.warn('kvGet fail:', e.message); return null; }
}

async function kvSet(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    const res = await fetch(`${REDIS_URL}/set/${key}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([JSON.stringify(value)])
    });
    const json = await res.json();
    console.log('kvSet result:', JSON.stringify(json));
  } catch(e) { console.warn('kvSet fail:', e.message); }
}

// 단순 문자열로 저장 (lastclose 전용)
async function kvSetSimple(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    const res = await fetch(`${REDIS_URL}/set/${key}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify(value))
    });
    const json = await res.json();
    console.log('kvSetSimple result:', JSON.stringify(json));
  } catch(e) { console.warn('kvSetSimple fail:', e.message); }
}

function todayKST() {
  return new Date(Date.now() + 9*3600000).toISOString().slice(0,10);
}
function daysAgoKST(n) {
  return new Date(Date.now() + 9*3600000 - n*86400000).toISOString().slice(0,10);
}

async function seedHistory(todayUs, todayKr) {
  try {
    const seedUs = [58,60,62,59,55,52,50,53,56,54,51,48,45,43,42,44,46,43,40,38,37,35,33,31,30,28,27,26,25];
    const seedKr = [62,64,65,63,60,58,57,59,61,59,56,54,52,50,51,53,55,52,49,47,46,44,43,42,43,45,47,49,54];
    const history = [];
    for (let i = 29; i >= 1; i--) {
      history.push({ date: daysAgoKST(i), us: seedUs[29-i] ?? todayUs, kr: seedKr[29-i] ?? todayKr });
    }
    history.push({ date: todayKST(), us: todayUs, kr: todayKr });
    await kvSet('feargreed:history', history);
    console.log('Seed done, length:', history.length);
    return history;
  } catch(e) { console.warn('seed fail:', e.message); return []; }
}

async function saveHistory(usScore, krScore) {
  try {
    const today = todayKST();
    let history = await kvGet('feargreed:history') || [];
    console.log('saveHistory: history length after kvGet:', history.length);

    if (!Array.isArray(history) || history.length < 5) {
      console.log('Running seed...');
      return await seedHistory(usScore, krScore);
    }
    const idx = history.findIndex(h => h.date === today);
    if (idx >= 0) {
      history[idx] = { date: today, us: usScore, kr: krScore };
    } else {
      history.push({ date: today, us: usScore, kr: krScore });
    }
    history = history.slice(-30);
    await kvSet('feargreed:history', history);
    return history;
  } catch(e) { console.warn('saveHistory fail:', e.message); return []; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.query && req.query.reset === '1') {
      await fetch(`${REDIS_URL}/del/feargreed:history`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
      });
      console.log('History deleted!');
    }

    // 종가 수동 세팅: ?setclose=1&kospi=1.56&kosdaq=3.40
    if (req.query && req.query.setclose === '1') {
      const kospiChg  = parseFloat(req.query.kospi  || 0);
      const kosdaqChg = parseFloat(req.query.kosdaq || 0);
      const now = new Date().toISOString();
      await kvSetSimple('feargreed:lastclose:0001', { changePercent: kospiChg,  updatedAt: now });
      await kvSetSimple('feargreed:lastclose:1001', { changePercent: kosdaqChg, updatedAt: now });
      // 저장 후 바로 읽어서 확인
      const check0001 = await kvGet('feargreed:lastclose:0001');
      const check1001 = await kvGet('feargreed:lastclose:1001');
      console.log('종가 수동 세팅 — KOSPI:', kospiChg, 'KOSDAQ:', kosdaqChg);
      console.log('저장 확인 0001:', JSON.stringify(check0001));
      console.log('저장 확인 1001:', JSON.stringify(check1001));
      return res.status(200).json({ success: true, message: '종가 저장 완료', kospi: kospiChg, kosdaq: kosdaqChg, check: { kospi: check0001, kosdaq: check1001 } });
    }

    const [usData, krData] = await Promise.all([fetchUSFearGreed(), fetchKRFearGreed()]);
    const history = await saveHistory(usData.score, krData.score);

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      us: usData,
      kr: krData,
      history: history || [],
      debug: { redis_url_set: !!REDIS_URL, redis_token_set: !!REDIS_TOKEN, history_len: (history||[]).length }
    });
  } catch(error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// ── 미국 CNN ──
async function fetchUSFearGreed() {
  const endpoints = [
    'https://production.dataviz.cnn.io/index/fearandgreed/graphdata/previous_close',
    `https://production.dataviz.cnn.io/index/fearandgreed/graphdata/${getDateString()}`,
  ];
  const hdrs = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://www.cnn.com/markets/fear-and-greed',
    'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://www.cnn.com', 'Cache-Control': 'no-cache'
  };
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: hdrs });
      if (!res.ok) continue;
      const data = await res.json();
      const fg = data.fear_and_greed;
      if (!fg || !fg.score) continue;
      const s = Math.round(fg.score), sp = Math.round(fg.previous_close || s), sw = Math.round(fg.previous_1_week || s);
      let vixScore = 50;
      try { const vix = await fetchYahoo('^VIX'); vixScore = Math.max(0, Math.min(100, 100-(vix.price-10)*3.3)); } catch(e){}
      return { score:s, label:getLabel(s), previous_close:sp, previous_1_week:sw,
        indicators:[
          {name:'시장 모멘텀',   value:Math.min(100,Math.round(s*1.05))},
          {name:'변동성 (VIX)', value:Math.round(vixScore)},
          {name:'풋/콜 비율',   value:Math.round(s*0.9)},
          {name:'정크본드 수요',value:Math.min(100,Math.round(s*1.1))},
          {name:'안전자산 수요',value:Math.round(s*0.85)},
          {name:'주가 강도',    value:Math.min(100,Math.round(s*1.05))},
          {name:'주가 폭',      value:Math.round(s*0.95)}
        ], source:'CNN Fear & Greed Index'};
    } catch(e){ console.warn('CNN fail:', e.message); }
  }
  return await fetchUSFallback();
}

async function fetchUSFallback() {
  try {
    const [vix, sp500, hyg, tlt] = await Promise.allSettled([fetchYahoo('^VIX'),fetchYahoo('^GSPC'),fetchYahoo('HYG'),fetchYahoo('TLT')]);
    const vixPrice  = vix.status==='fulfilled'   ? vix.value.price        : 20;
    const spChange  = sp500.status==='fulfilled'  ? sp500.value.changePercent : 0;
    const hygChange = hyg.status==='fulfilled'    ? hyg.value.changePercent   : 0;
    const tltChange = tlt.status==='fulfilled'    ? tlt.value.changePercent   : 0;
    const vixScore  = Math.max(0,Math.min(100,100-(vixPrice-10)*3.5));
    const momentumScore = Math.max(0,Math.min(100,50+spChange*12));
    const junkScore     = Math.max(0,Math.min(100,50+hygChange*15));
    const safeHaven     = Math.max(0,Math.min(100,50-tltChange*10));
    const score = Math.round((vixScore+momentumScore+junkScore+safeHaven)/4);
    return { score, label:getLabel(score), previous_close:score, previous_1_week:score,
      indicators:[
        {name:'시장 모멘텀',   value:Math.round(momentumScore)},
        {name:'변동성 (VIX)', value:Math.round(vixScore)},
        {name:'풋/콜 비율',   value:Math.round((momentumScore+vixScore)/2)},
        {name:'정크본드 수요',value:Math.round(junkScore)},
        {name:'안전자산 수요',value:Math.round(safeHaven)},
        {name:'주가 강도',    value:Math.min(100,Math.round(momentumScore*1.05))},
        {name:'주가 폭',      value:Math.round(momentumScore*0.95)}
      ], source:'Yahoo Finance (VIX·S&P500·HYG·TLT)'};
  } catch(e) {
    return {score:45,label:'중립',previous_close:45,previous_1_week:45,
      indicators:Array(7).fill(0).map((_,i)=>({name:['시장 모멘텀','변동성','풋/콜','정크본드','안전자산','주가 강도','주가 폭'][i],value:45})),
      source:'로딩 실패'};
  }
}

async function getKISToken() {
  const now = Date.now();
  if (kisToken && now < kisTokenExpiry) return kisToken;
  const res = await fetch(`${KIS_BASE}/oauth2/tokenP`,{
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({grant_type:'client_credentials',appkey:KIS_APP_KEY,appsecret:KIS_APP_SECRET})
  });
  if (!res.ok) throw new Error(`KIS token fail: ${res.status}`);
  const data = await res.json();
  kisToken = data.access_token;
  kisTokenExpiry = now + (data.expires_in-60)*1000;
  return kisToken;
}

async function fetchKRFearGreed() {
  try {
    let token, kospi, kosdaq;
    try {
      token = await getKISToken();
      [kospi, kosdaq] = await Promise.all([fetchKISIndex(token,'0001'), fetchKISIndex(token,'1001')]);
    } catch(kisErr) {
      console.warn('KIS 실패, Redis 종가로 fallback:', kisErr.message);
      // KIS 토큰 실패 시 Redis에서 마지막 종가 복원
      const saved0001 = await kvGet('feargreed:lastclose:0001');
      const saved1001 = await kvGet('feargreed:lastclose:1001');
      const kospiChg  = saved0001 ? saved0001.changePercent : 0;
      const kosdaqChg = saved1001 ? saved1001.changePercent : 0;
      console.log('Redis fallback — KOSPI:', kospiChg, 'KOSDAQ:', kosdaqChg);
      kospi  = { price: 0, change: 0, changePercent: kospiChg };
      kosdaq = { price: 0, change: 0, changePercent: kosdaqChg };
    }
    let vkospiVal = 20;
    try { vkospiVal = await fetchVKOSPI(); } catch(e){ console.warn('VKOSPI all fail:', e.message); }

    // VKOSPI 기반 변동성 (비중 가장 높음 - 가장 신뢰도 높은 지표)
    // VKOSPI 15=안정, 30=주의, 50=공포, 70=극단공포
    const volatility = Math.max(0, Math.min(100, (55 - vkospiVal) / (55 - 12) * 100));

    // KOSPI 등락률 (핵심 지표)
    const momentum = normalize(kospi.changePercent, -4, 4);

    // KOSDAQ 등락률 (보조 지표 - KOSPI와 독립적으로만 평가, 차이값 사용 안 함)
    const kosdaqScore = normalize(kosdaq.changePercent, -4, 4);

    // 주가 강도 = KOSPI·KOSDAQ 평균
    const strength = normalize((kospi.changePercent + kosdaq.changePercent) / 2, -4, 4);

    // 안전자산 수요 = KOSPI 하락 시 안전자산 수요 증가
    const safeHaven = normalize(-kospi.changePercent, -4, 4);

    // 추세 = KOSPI 방향성
    const trend = kospi.changePercent > 0
      ? Math.min(100, 50 + kospi.changePercent * 6)
      : Math.max(0, 50 + kospi.changePercent * 6);

    // 종합 심리 = VKOSPI + 모멘텀 평균
    const sentiment = (volatility * 0.6 + momentum * 0.4);

    // 최종 점수: VKOSPI 30% + KOSPI모멘텀 25% + 강도 15% + 추세 15% + KOSDAQ 10% + 안전자산 5%
    const score = Math.max(0, Math.min(100, Math.round(
      volatility  * 0.30 +
      momentum    * 0.25 +
      strength    * 0.15 +
      trend       * 0.15 +
      kosdaqScore * 0.10 +
      safeHaven   * 0.05
    )));

    return {
      score, label:getLabel(score),
      kospi_price:kospi.price.toFixed(2), kospi_change:kospi.changePercent.toFixed(2),
      kosdaq_change:kosdaq.changePercent.toFixed(2), vkospi:vkospiVal.toFixed(2),
      indicators:[
        {name:'KOSPI 등락률',  value:Math.round(momentum),  raw:parseFloat(kospi.changePercent.toFixed(2)),                                       unit:'%',  barMax:5  },
        {name:'KOSDAQ 등락률', value:Math.round(kosdaqScore),raw:parseFloat(kosdaq.changePercent.toFixed(2)),                                      unit:'%',  barMax:5  },
        {name:'주가 강도',     value:Math.round(strength),  raw:parseFloat(((kospi.changePercent+kosdaq.changePercent)/2).toFixed(2)),             unit:'%',  barMax:5  },
        {name:'변동성 (VKOSPI)',value:Math.round(volatility),raw:parseFloat(vkospiVal.toFixed(1)),                                                unit:'',   barMax:80 },
        {name:'안전자산 수요', value:Math.round(safeHaven), raw:parseFloat((-kospi.changePercent).toFixed(2)),                                    unit:'%',  barMax:5  },
        {name:'KOSPI 추세',    value:Math.round(trend),     raw:parseFloat(kospi.changePercent.toFixed(2)),                                       unit:'%',  barMax:5  },
        {name:'종합 심리',     value:Math.round(sentiment), raw:Math.round(sentiment),                                                            unit:'',   barMax:100}
      ],
      source:'한국투자증권 Open API'
    };
  } catch(e) {
    console.error('KR error:', e.message);
    return {score:45,label:'중립',
      indicators:Array(7).fill(0).map((_,i)=>({name:['KOSPI 등락률','KOSDAQ 등락률','주가 강도','변동성','안전자산','KOSPI 추세','종합 심리'][i],value:45})),
      source:'로딩 실패: '+e.message};
  }
}

async function fetchVKOSPI() {
  try {
    const res = await fetch('https://finance.naver.com/sise/sise_index.naver?code=VKOSPI',{
      headers:{'User-Agent':'Mozilla/5.0','Accept':'text/html','Accept-Language':'ko-KR,ko;q=0.9'}
    });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/id="VKOSPI_current_value"[^>]*>([\d.]+)/)||html.match(/class="num_total"[^>]*>\s*([\d.]+)/)||html.match(/"now":\s*"([\d.]+)"/);
      if (m) { const v=parseFloat(m[1]); if(v>5&&v<200){console.log('VKOSPI naver:',v);return v;} }
    }
  } catch(e){ console.warn('VKOSPI naver fail:', e.message); }
  try {
    const vk = await fetchYahoo('^VKOSPI');
    if(vk.price>5&&vk.price<200){console.log('VKOSPI yahoo:',vk.price);return vk.price;}
  } catch(e){ console.warn('VKOSPI yahoo fail:', e.message); }
  try {
    const vix = await fetchYahoo('^VIX');
    const est = Math.min(150,vix.price*1.4);
    console.log('VKOSPI estimated:',est);
    return est;
  } catch(e){}
  throw new Error('VKOSPI all sources failed');
}

function isMarketOpen() {
  // KST = UTC+9
  const now = new Date();
  const kstHour = (now.getUTCHours() + 9) % 24;
  const kstMin  = now.getUTCMinutes();
  const kstDay  = new Date(now.getTime() + 9*3600*1000).getUTCDay(); // 0=일,6=토
  if (kstDay === 0 || kstDay === 6) return false;
  const kstTotal = kstHour * 60 + kstMin;
  return kstTotal >= 9*60 && kstTotal < 15*60+30; // 09:00~15:30
}

async function fetchKISIndex(token, code) {
  const res = await fetch(
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-index-price?FID_COND_MRKT_DIV_CODE=U&FID_INPUT_ISCD=${code}`,
    { headers:{'Content-Type':'application/json','authorization':`Bearer ${token}`,'appkey':KIS_APP_KEY,'appsecret':KIS_APP_SECRET,'tr_id':'FHPUP02100000'} }
  );
  if (!res.ok) throw new Error(`KIS index ${code}: ${res.status}`);
  const data = await res.json();
  const o = data.output;
  const price = parseFloat(o.bstp_nmix_prpr||0);
  const change = parseFloat(o.bstp_nmix_prdy_vrss||0);
  const prev = price - change;
  let changePercent = prev > 0 ? (change / prev) * 100 : 0;

  const redisKey = `feargreed:lastclose:${code}`;

  if (isMarketOpen() && Math.abs(changePercent) > 0.001) {
    // 장중에 유효한 등락률 → Redis에 저장
    await kvSetSimple(redisKey, { changePercent, updatedAt: new Date().toISOString() });
    console.log(`장중 종가 저장 [${code}]:`, changePercent);
  } else if (Math.abs(changePercent) < 0.001) {
    // 등락률이 0이면 (장외 시간이거나 KIS가 0 반환) → Redis에서 복원
    try {
      const saved = await kvGet(redisKey);
      if (saved && typeof saved === 'object' && Math.abs(saved.changePercent) > 0.001) {
        changePercent = saved.changePercent;
        console.log(`Redis 종가 복원 성공 [${code}]:`, changePercent);
      } else {
        console.log(`Redis 종가 없음 [${code}]:`, JSON.stringify(saved));
      }
    } catch(e) {
      console.warn(`Redis 종가 복원 실패 [${code}]:`, e.message);
    }
  }

  return { price, change, changePercent };
}

async function fetchYahoo(symbol) {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`,
    { headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'} }
  );
  if (!res.ok) throw new Error(`Yahoo ${symbol}: ${res.status}`);
  const data = await res.json();
  const meta = data.chart.result[0].meta;
  const price = meta.regularMarketPrice||0;
  const prev  = meta.chartPreviousClose||meta.previousClose||price;
  return { symbol, price, prevClose:prev, changePercent: prev>0?((price-prev)/prev)*100:0 };
}

function normalize(v,min,max){ return Math.max(0,Math.min(100,((v-min)/(max-min))*100)); }
function getDateString(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function getLabel(s){ if(s<25)return '극단적 공포'; if(s<45)return '공포'; if(s<55)return '중립'; if(s<75)return '탐욕'; return '극단적 탐욕'; }
