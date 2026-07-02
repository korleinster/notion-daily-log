'use strict';
const { Client } = require('@notionhq/client');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── 환경변수 ──────────────────────────────────────────────────────────────────
const NOTION_TOKEN       = process.env.NOTION_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
// 운동 루트 페이지 ID (운동 → 2026년 → 2026년_06 → database)
const WORKOUT_PAGE_ID    = process.env.WORKOUT_PAGE_ID || '372e60ccff0c8060b137e1b65779079b';

const REQUIRED_ENV = ['NOTION_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) { console.error(`❌ 환경변수 누락: ${key}`); process.exit(1); }
}

const notion = new Client({ auth: NOTION_TOKEN });
const STATE_FILE = path.join(__dirname, '.workout-notify-state.json');

// 차트 블록 캡션 식별자
const CHART_CAPTIONS = {
  weight:    '📊 체중 변화',
  intensity: '📊 운동 강도',
};

// ── 헬퍼 함수 ─────────────────────────────────────────────────────────────────

function isTransientError(err) {
  const status = err?.status ?? err?.response?.status;
  const code = err?.code ?? err?.cause?.code;
  const message = String(err?.message || err || '');

  return [429, 502, 503, 504].includes(status) ||
    ['ECONNRESET', 'ETIMEDOUT'].includes(code) ||
    /Premature close|fetch failed/i.test(message);
}

async function withRetry(fn, retries = 5, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === retries - 1) throw err;
      const waitMs = delay * (2 ** i);
      if (isTransientError(err)) {
        console.warn(`⏳ 일시적 오류 감지. ${waitMs}ms 후 재시도 (${i + 1}/${retries - 1}): ${err.message}`);
      }
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

async function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) reject(new Error(`Telegram API 오류: ${parsed.description}`));
          else resolve(parsed);
        } catch (e) {
          reject(new Error(`Telegram 응답 파싱 실패: ${data.slice(0, 100)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getChildPages(pageId) {
  const children = [];
  let cursor;
  while (true) {
    const res = await withRetry(() =>
      notion.blocks.children.list({ block_id: pageId, start_cursor: cursor, page_size: 100 })
    );
    for (const block of res.results) {
      if (block.type === 'child_page') {
        children.push({ id: block.id, title: block.child_page.title });
      }
    }
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return children;
}

async function getAllBlocks(blockId) {
  const blocks = [];
  let cursor;
  while (true) {
    const res = await withRetry(() =>
      notion.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 })
    );
    blocks.push(...res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return blocks;
}

// 운동 데이터베이스 전체 조회 (날짜 오름차순)
async function getAllDbRows(dbId) {
  const rows = [];
  let cursor;
  while (true) {
    const res = await withRetry(() =>
      notion.databases.query({
        database_id: dbId,
        sorts: [{ property: '날짜', direction: 'ascending' }],
        start_cursor: cursor,
        page_size: 100,
      })
    );
    rows.push(...res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return rows;
}

// Notion DB properties에서 값 추출
function propVal(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':     return (prop.title ?? [])[0]?.plain_text ?? '';
    case 'rich_text': return (prop.rich_text ?? [])[0]?.plain_text ?? '';
    case 'select':    return prop.select?.name ?? '';
    case 'number':    return prop.number != null ? String(prop.number) : '';
    default:          return '';
  }
}

// ── KST 오늘 날짜 ─────────────────────────────────────────────────────────────

function getKSTToday() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const year  = kst.getUTCFullYear();
  const month = kst.getUTCMonth() + 1;
  const day   = kst.getUTCDate();
  return {
    dateStr:    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    year, month, day,
    yearKey:    `${year}년`,
    monthKey:   `${year}년_${String(month).padStart(2, '0')}`,
    cellPrefix: `${month}/${day}(`,
  };
}

// ── 상태 파일 ─────────────────────────────────────────────────────────────────

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch { /* 파싱 실패 시 초기화 */ }
  return { date: '', count: 0 };
}

function writeState(date, count) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ date, count }), 'utf-8');
}

// ── QuickChart — 차트 이미지 생성 ─────────────────────────────────────────────

async function createChartUrl(chartConfig) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ chart: chartConfig, width: 700, height: 320, backgroundColor: 'white', version: 3 });
    const req = https.request({
      hostname: 'quickchart.io',
      path: '/chart/create',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.success) resolve(parsed.url);
          else reject(new Error('QuickChart 오류: ' + data.slice(0, 200)));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── 차트 1: 체중 추이 + 목표선 ───────────────────────────────────────────────
function buildWeightChartConfig(dbRows, monthLabel) {
  const labels = [], weights = [];

  for (const row of dbRows) {
    const p = row.properties;
    labels.push(propVal(p['날짜']));
    const wt = p['체중(kg)']?.number;
    weights.push(wt != null ? wt : null);
  }

  // Y축 범위: 목표(80kg) 포함, 현재 체중 위로 여유
  const valid = weights.filter(w => w !== null);
  const minW = valid.length > 0 ? Math.min(...valid) : 85;
  const maxW = valid.length > 0 ? Math.max(...valid) : 90;
  const yMin = Math.floor(Math.min(79, minW) - 0.5);
  const yMax = Math.ceil(maxW + 1.5);

  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '체중(kg)',
          data: weights,
          borderColor: 'rgba(66, 153, 225, 1)',
          backgroundColor: 'rgba(66, 153, 225, 0.08)',
          pointBackgroundColor: 'rgba(66, 153, 225, 1)',
          pointBorderColor: '#fff',
          pointBorderWidth: 2,
          pointRadius: 7,
          fill: true,
          tension: 0.3,
          spanGaps: true,
        },
        {
          label: '목표 (80kg)',
          data: labels.map(() => 80),
          borderColor: 'rgba(239, 68, 68, 0.65)',
          borderDash: [7, 4],
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: `${monthLabel} 체중 변화`,
          font: { size: 15, weight: 'bold' },
          padding: { bottom: 10 },
        },
        legend: { position: 'top' },
      },
      scales: {
        y: {
          min: yMin,
          max: yMax,
          title: { display: true, text: '체중 (kg)' },
          ticks: { stepSize: 1 },
        },
      },
    },
  };
}

// ── 차트 2: 칼로리(막대) + 평균BPM(선) ──────────────────────────────────────
function buildIntensityChartConfig(dbRows, monthLabel) {
  const labels = [], calories = [], avgBPMs = [];

  for (const row of dbRows) {
    const p = row.properties;
    labels.push(propVal(p['날짜']));
    calories.push(p['칼로리']?.number ?? null);
    avgBPMs.push(p['평균BPM']?.number ?? null);
  }

  const validCal = calories.filter(c => c !== null);
  const validBPM = avgBPMs.filter(b => b !== null);
  const calMin = validCal.length ? Math.floor(Math.min(...validCal) * 0.85) : 0;
  const calMax = validCal.length ? Math.ceil(Math.max(...validCal)  * 1.12) : 500;
  const bpmMin = validBPM.length ? Math.floor(Math.min(...validBPM) * 0.95) : 100;
  const bpmMax = validBPM.length ? Math.ceil(Math.max(...validBPM)  * 1.05) : 180;

  return {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: '칼로리(kcal)',
          data: calories,
          backgroundColor: 'rgba(251, 191, 36, 0.75)',
          borderColor:     'rgba(245, 158, 11, 1)',
          borderWidth: 1,
          yAxisID: 'y',
          order: 2,
        },
        {
          type: 'line',
          label: '평균 BPM',
          data: avgBPMs,
          borderColor:          'rgba(239, 68, 68, 1)',
          backgroundColor:      'transparent',
          pointBackgroundColor: 'rgba(239, 68, 68, 1)',
          pointBorderColor:     '#fff',
          pointBorderWidth: 2,
          pointRadius: 6,
          fill: false,
          tension: 0.3,
          spanGaps: true,
          yAxisID: 'y1',
          order: 1,
        },
      ],
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: `${monthLabel} 운동 강도`,
          font: { size: 15, weight: 'bold' },
          padding: { bottom: 10 },
        },
        legend: { position: 'top' },
      },
      scales: {
        y: {
          type: 'linear',
          position: 'left',
          min: calMin,
          max: calMax,
          title: { display: true, text: '칼로리(kcal)' },
        },
        y1: {
          type: 'linear',
          position: 'right',
          min: bpmMin,
          max: bpmMax,
          title: { display: true, text: '평균 BPM' },
          grid: { drawOnChartArea: false },
        },
      },
    },
  };
}

// 이미지 블록 생성 헬퍼
function makeImageBlock(url, caption) {
  return {
    type: 'image',
    image: {
      type: 'external',
      external: { url },
      caption: [{ type: 'text', text: { content: caption } }],
    },
  };
}

// 월 페이지에 차트 2개 삽입/갱신 (체중 → 강도 순)
async function updateMonthlyChart(monthPageId, dbRows, monthLabel) {
  if (dbRows.length === 0) return;

  console.log('📊 차트 2개 생성 중...');
  const [weightUrl, intensityUrl] = await Promise.all([
    createChartUrl(buildWeightChartConfig(dbRows, monthLabel)),
    createChartUrl(buildIntensityChartConfig(dbRows, monthLabel)),
  ]);
  console.log('📊 차트 URL 생성 완료');

  const blocks = await getAllBlocks(monthPageId);

  // 기존 차트 블록 모두 찾기 (캡션에 📊 포함)
  const existingCharts = blocks.filter(b => {
    if (b.type !== 'image') return false;
    const cap = (b.image?.caption ?? []).map(c => c.plain_text ?? '').join('');
    return cap.startsWith('📊');
  });

  // 삽입 기준: 첫 번째 기존 차트 직전 블록 (없으면 데이터베이스 직전)
  let insertAfterBlockId = null;
  if (existingCharts.length > 0) {
    const firstIdx = blocks.findIndex(b => b.id === existingCharts[0].id);
    insertAfterBlockId = firstIdx > 0 ? blocks[firstIdx - 1].id : null;
    for (const chart of existingCharts) {
      await withRetry(() => notion.blocks.delete({ block_id: chart.id }));
    }
    console.log(`🗑️ 기존 차트 ${existingCharts.length}개 삭제`);
  } else {
    const dbIdx = blocks.findIndex(b => b.type === 'child_database');
    insertAfterBlockId = dbIdx > 0 ? blocks[dbIdx - 1].id : null;
  }

  // 체중 차트 삽입
  const weightParams = { block_id: monthPageId, children: [makeImageBlock(weightUrl, CHART_CAPTIONS.weight)] };
  if (insertAfterBlockId) weightParams.after = insertAfterBlockId;
  const weightRes = await withRetry(() => notion.blocks.children.append(weightParams));
  console.log('✅ 체중 차트 삽입');

  // 강도 차트 삽입 (체중 차트 바로 다음)
  const intensityParams = {
    block_id: monthPageId,
    after: weightRes.results[0].id,
    children: [makeImageBlock(intensityUrl, CHART_CAPTIONS.intensity)],
  };
  await withRetry(() => notion.blocks.children.append(intensityParams));
  console.log('✅ 운동 강도 차트 삽입');
}

// ── 메인 ──────────────────────────────────────────────────────────────────────

async function main() {
  const today = getKSTToday();
  console.log(`📅 오늘 (KST): ${today.dateStr}`);

  const state = readState();
  const prevCount = state.date === today.dateStr ? state.count : 0;
  console.log(`📊 이전 집계: ${prevCount}건 (저장 날짜: ${state.date || '없음'})`);

  // ① 운동 루트 → 연도 페이지
  const yearPages = await getChildPages(WORKOUT_PAGE_ID);
  const yearPage = yearPages.find(p => p.title === today.yearKey)
    ?? yearPages.sort((a, b) => b.title.localeCompare(a.title))[0];
  if (!yearPage) {
    console.log(`⚠️ 연도 페이지(${today.yearKey}) 없음.`);
    writeState(today.dateStr, prevCount);
    return;
  }
  console.log(`📁 연도: ${yearPage.title}`);

  // ② 연도 페이지 → 월 페이지
  const monthPages = await getChildPages(yearPage.id);
  const monthPage = monthPages.find(p => p.title === today.monthKey)
    ?? monthPages.sort((a, b) => b.title.localeCompare(a.title))[0];
  if (!monthPage) {
    console.log(`⚠️ 월 페이지(${today.monthKey}) 없음.`);
    writeState(today.dateStr, prevCount);
    return;
  }
  console.log(`📁 월: ${monthPage.title}`);

  // ③ 월 페이지 → child_database 블록 탐색
  const monthBlocks = await getAllBlocks(monthPage.id);
  const dbBlock = monthBlocks.find(b => b.type === 'child_database');
  if (!dbBlock) {
    console.log('⚠️ 운동 데이터베이스 없음.');
    writeState(today.dateStr, prevCount);
    return;
  }
  const dbId = dbBlock.id;
  console.log(`🗄️ 데이터베이스 ID: ${dbId}`);

  // ④ 데이터베이스 전체 조회 (날짜 오름차순)
  const allRows = await getAllDbRows(dbId);

  // ⑤ 오늘 날짜 행 필터
  const todayRows = allRows.filter(row => {
    const dateVal = row.properties['날짜']?.title?.[0]?.plain_text ?? '';
    return dateVal.startsWith(today.cellPrefix);
  });

  const currentCount = todayRows.length;
  console.log(`🏋️ 오늘 운동 기록: ${currentCount}건 (이전: ${prevCount}건)`);

  // ⑥ 새 기록 감지 → 알림 + 차트 갱신
  if (currentCount > prevCount) {
    const newRows = todayRows.slice(prevCount);
    for (const row of newRows) {
      const p = row.properties;

      const dateCell     = propVal(p['날짜']);
      const typeCell     = propVal(p['운동종류']);
      const timeNum      = p['시간(분)']?.number;
      const timeCell     = timeNum != null ? `${timeNum}분` : '';
      const levelCell    = propVal(p['강도']);
      const avgBPMNum    = p['평균BPM']?.number;
      const maxBPMNum    = p['최고BPM']?.number;
      const kcalNum      = p['칼로리']?.number;
      const kcalCell     = kcalNum != null ? `${kcalNum}kcal` : '';
      const weightNum    = p['체중(kg)']?.number;
      const weightCell   = weightNum != null ? `${weightNum}kg` : '';
      const feedbackCell = propVal(p['트레이너피드백']);

      const avgBPMStr = avgBPMNum != null ? String(avgBPMNum) : '';
      const maxBPMStr = maxBPMNum != null ? String(maxBPMNum) : '';

      const parts = [];
      if (typeCell)  parts.push(typeCell);
      if (timeCell)  parts.push(timeCell);
      if (levelCell) parts.push(`강도 ${levelCell}`);
      if (kcalCell)  parts.push(kcalCell);
      const bpm = avgBPMStr && maxBPMStr ? `BPM ${avgBPMStr}/${maxBPMStr}`
                : avgBPMStr ? `평균BPM ${avgBPMStr}`
                : maxBPMStr ? `최고BPM ${maxBPMStr}` : '';
      if (bpm) parts.push(bpm);

      const summaryLine  = parts.join(' · ');
      const weightLine   = weightCell   ? `\n⚖️ 체중: ${weightCell}` : '';
      const feedbackLine = feedbackCell ? `\n\n🤖 트레이너 피드백\n${feedbackCell}` : '';

      const msg =
        `💪 운동 기록이 추가됐어요!\n\n` +
        `📅 ${dateCell}\n` +
        `🏋️ ${summaryLine}${weightLine}${feedbackLine}`;

      console.log('📨 Telegram 전송 중...');
      await sendTelegram(msg);
      console.log('✅ 전송 완료');
    }

    // 月 전체 데이터로 차트 갱신
    // "2026년_06" → "2026년 6월"
    const monthLabel = monthPage.title.replace(/년_(\d{2})$/, (_, m) => `년 ${parseInt(m)}월`);
    await updateMonthlyChart(monthPage.id, allRows, monthLabel);
  } else {
    console.log('ℹ️ 새 운동 기록 없음.');
  }

  writeState(today.dateStr, currentCount);
}

main().catch(err => {
  console.error('❌ 오류:', err.message);
  if (isTransientError(err)) {
    console.warn('⚠️ Notion/네트워크 일시 오류라서 이번 Workout Notify 실행은 실패 처리하지 않고 종료합니다.');
    process.exit(0);
  }
  process.exit(1);
});
