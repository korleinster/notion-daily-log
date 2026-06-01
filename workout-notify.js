'use strict';
const { Client } = require('@notionhq/client');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── 환경변수 ──────────────────────────────────────────────────────────────────
const NOTION_TOKEN      = process.env.NOTION_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
// 운동 루트 페이지 ID (운동 → 2026년 → 2026년_06 → table)
const WORKOUT_PAGE_ID   = process.env.WORKOUT_PAGE_ID || '372e60ccff0c8060b137e1b65779079b';

const REQUIRED_ENV = ['NOTION_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) { console.error(`❌ 환경변수 누락: ${key}`); process.exit(1); }
}

const notion = new Client({ auth: NOTION_TOKEN });
const STATE_FILE = path.join(__dirname, '.workout-notify-state.json');

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
  // UTC + 9h
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const year  = kst.getUTCFullYear();
  const month = kst.getUTCMonth() + 1;
  const day   = kst.getUTCDate();
  return {
    dateStr:   `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    year, month, day,
    yearKey:   `${year}년`,
    monthKey:  `${year}년_${String(month).padStart(2, '0')}`,
    // 날짜 셀 접두사: "6/1(" 형식
    cellPrefix: `${month}/${day}(`,
  };
}

// ── 상태 파일 (당일 집계 수 유지) ─────────────────────────────────────────────

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch { /* 파싱 실패 시 초기화 */ }
  return { date: '', count: 0 };
}

function writeState(date, count) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ date, count }), 'utf-8');
}

// ── 메인 ──────────────────────────────────────────────────────────────────────

async function main() {
  const today = getKSTToday();
  console.log(`📅 오늘 (KST): ${today.dateStr}`);

  // 이전 집계 읽기 (날짜 다르면 0으로 리셋)
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

  // ② 연도 페이지 → 월 페이지 (정확히 일치하는 것, 없으면 이름 내림차순 최신)
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

  // ④ 테이블 행 가져오기 (헤더 행 제외)
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

  // ⑥ 새 기록이 있으면 알림 전송
  if (currentCount > prevCount) {
    // 새로 추가된 행만 (prevCount 이후)
    const newRows = todayRows.slice(prevCount);
    for (const row of newRows) {
      const cells = row.table_row?.cells ?? [];
      const dateCell     = cellText(cells[0]);  // 날짜
      const typeCell     = cellText(cells[1]);  // 운동 종류
      const timeCell     = cellText(cells[2]);  // 시간
      const levelCell    = cellText(cells[3]);  // 강도
      const avgBPM       = cellText(cells[4]);  // 평균BPM
      const maxBPM       = cellText(cells[5]);  // 최고BPM
      const kcalCell     = cellText(cells[6]);  // 칼로리
      const weightCell   = cellText(cells[7]);  // 체중
      const feedbackCell = cellText(cells[9]);  // 트레이너 피드백

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
  } else {
    console.log('ℹ️ 새 운동 기록 없음.');
  }

  writeState(today.dateStr, currentCount);
}

main().catch(err => {
  console.error('❌ 오류:', err.message);
  process.exit(1);
});
