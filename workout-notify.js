'use strict';
const { Client } = require('@notionhq/client');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── 환경변수 ──────────────────────────────────────────────────────────────────
const NOTION_TOKEN       = process.env.NOTION_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
// 운동 루트 페이지 ID (운동 → 2026년 → 2026년_06 → table)
const WORKOUT_PAGE_ID    = process.env.WORKOUT_PAGE_ID || '372e60ccff0c8060b137e1b65779079b';

const REQUIRED_ENV = ['NOTION_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) { console.error(`❌ 환경변수 누락: ${key}`); process.exit(1); }
}

const notion = new Client({ auth: NOTION_TOKEN });
const STATE_FILE = path.join(__dirname, '.workout-notify-state.json');

// 차트 블록 식별자 (Notion 캡션으로 구분)
const CHART_CAPTION = '📊 월간 운동 현황';

// ── 헬퍼 함수 ─────────────────────────────────────────────────────────────────

async function withRetry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
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

// table_row 셀 → 텍스트
function cellText(cell = []) {
  return cell.map(rt => rt.plain_text ?? rt.text?.content ?? '').join('').trim();
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

// dataRows(table_row 배열)에서 차트 config 생성 — 체중 추이 + 목표선
function buildChartConfig(dataRows, monthLabel) {
  const labels = [], weights = [];

  for (const row of dataRows) {
    const cells = row.table_row?.cells ?? [];
    labels.push(cellText(cells[0]));
    const wtRaw = cellText(cells[7]).replace(/[^0-9.]/g, '');
    weights.push(wtRaw ? parseFloat(wtRaw) : null);
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

// 월 페이지 최상단 차트 블록 삽입/갱신
async function updateMonthlyChart(monthPageId, dataRows, monthLabel) {
  if (dataRows.length === 0) return;

  console.log('📊 차트 생성 중...');
  const chartUrl = await createChartUrl(buildChartConfig(dataRows, monthLabel));
  console.log('📊 차트 URL 생성 완료');

  // 현재 페이지 블록 목록
  const blocks = await getAllBlocks(monthPageId);

  // 기존 차트 블록 탐색 (캡션으로 식별)
  const chartIdx = blocks.findIndex(b => {
    if (b.type !== 'image') return false;
    const cap = (b.image?.caption ?? []).map(c => c.plain_text ?? '').join('');
    return cap.includes(CHART_CAPTION);
  });

  let insertAfterBlockId;

  if (chartIdx !== -1) {
    // 차트 직전 블록을 삽입 기준으로 기억한 뒤 삭제
    insertAfterBlockId = chartIdx > 0 ? blocks[chartIdx - 1].id : null;
    await withRetry(() => notion.blocks.delete({ block_id: blocks[chartIdx].id }));
    console.log('🗑️ 기존 차트 삭제');
  } else {
    // 첫 삽입: 테이블 직전 블록 다음에 끼워 넣기
    const tableIdx = blocks.findIndex(b => b.type === 'table');
    insertAfterBlockId = tableIdx > 0 ? blocks[tableIdx - 1].id : null;
  }

  const appendParams = {
    block_id: monthPageId,
    children: [{
      type: 'image',
      image: {
        type: 'external',
        external: { url: chartUrl },
        caption: [{ type: 'text', text: { content: CHART_CAPTION } }],
      },
    }],
  };
  if (insertAfterBlockId) appendParams.after = insertAfterBlockId;

  await withRetry(() => notion.blocks.children.append(appendParams));
  console.log('✅ 차트 업데이트 완료');
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

  // ③ 월 페이지 → table 블록
  const monthBlocks = await getAllBlocks(monthPage.id);
  const tableBlock = monthBlocks.find(b => b.type === 'table');
  if (!tableBlock) {
    console.log('⚠️ 테이블 없음.');
    writeState(today.dateStr, prevCount);
    return;
  }

  // ④ 테이블 행 (헤더 제외)
  const allRows = (await getAllBlocks(tableBlock.id)).filter(b => b.type === 'table_row');
  const hasRowHeader = tableBlock.table?.has_row_header ?? true;
  const dataRows = hasRowHeader ? allRows.slice(1) : allRows;

  // ⑤ 오늘 날짜 행 필터
  const todayRows = dataRows.filter(row => {
    const dateCell = cellText((row.table_row?.cells ?? [])[0]);
    return dateCell.startsWith(today.cellPrefix);
  });

  const currentCount = todayRows.length;
  console.log(`🏋️ 오늘 운동 기록: ${currentCount}건 (이전: ${prevCount}건)`);

  // ⑥ 새 기록 감지 → 알림 + 차트 갱신
  if (currentCount > prevCount) {
    const newRows = todayRows.slice(prevCount);
    for (const row of newRows) {
      const cells = row.table_row?.cells ?? [];
      const dateCell     = cellText(cells[0]);
      const typeCell     = cellText(cells[1]);
      const timeCell     = cellText(cells[2]);
      const levelCell    = cellText(cells[3]);
      const avgBPM       = cellText(cells[4]);
      const maxBPM       = cellText(cells[5]);
      const kcalCell     = cellText(cells[6]);
      const weightCell   = cellText(cells[7]);
      const feedbackCell = cellText(cells[9]);

      const parts = [];
      if (typeCell)  parts.push(typeCell);
      if (timeCell)  parts.push(timeCell);
      if (levelCell) parts.push(`강도 ${levelCell}`);
      if (kcalCell)  parts.push(kcalCell);
      const bpm = avgBPM && maxBPM ? `BPM ${avgBPM}/${maxBPM}`
                : avgBPM ? `평균BPM ${avgBPM}`
                : maxBPM ? `최고BPM ${maxBPM}` : '';
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
    await updateMonthlyChart(monthPage.id, dataRows, monthLabel);
  } else {
    console.log('ℹ️ 새 운동 기록 없음.');
  }

  writeState(today.dateStr, currentCount);
}

main().catch(err => {
  console.error('❌ 오류:', err.message);
  process.exit(1);
});
