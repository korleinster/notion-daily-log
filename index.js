const { Client } = require('@notionhq/client');
const { DAVClient } = require('tsdav');
const ICAL = require('ical.js');
const https = require('https');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const ROOT_PAGE_ID = process.env.DAILY_LOG_PAGE_ID;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WORKTASK_DB_ID = process.env.WORKTASK_DB_ID;
const BOARD_PAGE_ID = process.env.BOARD_PAGE_ID;
const FIXED_PAGE_ID = process.env.FIXED_PAGE_ID;

const REQUIRED_ENV = ['NOTION_TOKEN', 'DAILY_LOG_PAGE_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) { console.error(`❌ 환경변수 누락: ${key}`); process.exit(1); }
}

const LAT = 37.4449;
const LON = 127.1388;

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

async function httpGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET' }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON 파싱 실패 (${hostname}): ${data.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getWeather() {
  try {
    const data = await httpGet('api.open-meteo.com', `/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,weathercode,windspeed_10m&timezone=Asia/Seoul`);
    const { temperature_2m, weathercode, windspeed_10m } = data.current;
    const emoji = weathercode === 0 ? '☀️' : weathercode <= 2 ? '🌤' : weathercode === 3 ? '☁️' : weathercode <= 49 ? '🌫' : weathercode <= 59 ? '🌦' : weathercode <= 69 ? '🌧' : weathercode <= 79 ? '❄️' : weathercode <= 84 ? '🌧' : '⛈';
    const desc = weathercode === 0 ? '맑음' : weathercode === 1 ? '대체로 맑음' : weathercode === 2 ? '구름 조금' : weathercode === 3 ? '흐림' : weathercode <= 49 ? '안개' : weathercode <= 59 ? '이슬비' : weathercode <= 69 ? '비' : weathercode <= 79 ? '눈' : weathercode <= 84 ? '소나기' : '뇌우';
    return `${emoji} ${desc} / 기온 ${temperature_2m}°C / 바람 ${windspeed_10m}km/h`;
  } catch (e) {
    return '날씨 정보를 가져오지 못했어요 😢';
  }
}

function getKSTDate() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day'), dayName: get('weekday').replace('요일', '') };
}

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i < retries - 1 && (e.code === 'rate_limited' || e.status === 429)) {
        console.warn(`⏳ Rate limit 감지. ${i + 1}초 후 재시도...`);
        await new Promise(r => setTimeout(r, (i + 1) * 1000));
        continue;
      }
      throw e;
    }
  }
}

// ──────────────────────────────────────────────
// Apple Calendar (iCloud CalDAV)
// ──────────────────────────────────────────────
async function getCalendarEvents() {
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_PASSWORD) {
    console.warn('⚠️ APPLE_ID 또는 APPLE_APP_PASSWORD 없음. 캘린더 건너뜀.');
    return null;
  }
  try {
    const client = new DAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: { username: process.env.APPLE_ID, password: process.env.APPLE_APP_PASSWORD },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });
    await client.login();
    const calendars = await client.fetchCalendars();

    const { year, month, day } = getKSTDate();
    const todayStart = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    const rangeEnd = new Date(todayStart.getTime() + 4 * 24 * 60 * 60 * 1000);

    const events = [];
    for (const calendar of calendars) {
      let calObjects;
      try {
        calObjects = await client.fetchCalendarObjects({
          calendar,
          timeRange: { start: todayStart.toISOString(), end: rangeEnd.toISOString() },
        });
      } catch (e) { console.warn('캘린더 객체 로드 실패:', calendar.displayName, e.message); continue; }

      for (const obj of calObjects) {
        if (!obj.data) continue;
        try {
          const jcal = ICAL.parse(obj.data);
          const comp = new ICAL.Component(jcal);
          for (const vevent of comp.getAllSubcomponents('vevent')) {
            const event = new ICAL.Event(vevent);
            if (event.isRecurring()) {
              const iter = event.iterator();
              let next;
              while ((next = iter.next())) {
                const startJS = next.toJSDate();
                if (startJS >= rangeEnd) break;
                if (startJS >= todayStart) {
                  const durationSec = event.duration?.toSeconds?.() ?? 0;
                  events.push({
                    summary: event.summary || '(제목 없음)',
                    start: startJS,
                    end: new Date(startJS.getTime() + durationSec * 1000),
                    allDay: next.isDate,
                  });
                }
              }
            } else {
              const startJS = event.startDate.toJSDate();
              const endJS = event.endDate?.toJSDate() ?? startJS;
              if (startJS < rangeEnd && endJS > todayStart) {
                events.push({
                  summary: event.summary || '(제목 없음)',
                  start: startJS,
                  end: endJS,
                  allDay: event.startDate.isDate,
                });
              }
            }
          }
        } catch (e) { console.warn('iCal 파싱 오류 무시:', e.message); }
      }
    }

    events.sort((a, b) => {
      if (a.allDay && !b.allDay) return -1;
      if (!a.allDay && b.allDay) return 1;
      return a.start - b.start;
    });
    return events;
  } catch (e) {
    console.error('캘린더 로드 오류:', e.message);
    return null;
  }
}

function formatCalendarSection(events) {
  if (!events) return '';

  const { year: fy, month: fm, day: fd } = getKSTDate();
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const todayKey = `${fy}-${fm}-${fd}`;

  const grouped = {};
  for (const ev of events) {
    const evKST = ev.allDay ? ev.start : new Date(ev.start.getTime() + 9 * 60 * 60 * 1000);
    const key = `${evKST.getUTCFullYear()}-${String(evKST.getUTCMonth()+1).padStart(2,'0')}-${String(evKST.getUTCDate()).padStart(2,'0')}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({ ev, evKST });
  }

  const todayEvents = grouped[todayKey] || [];
  const todayDate = new Date(Date.UTC(Number(fy), Number(fm) - 1, Number(fd)));

  const lines = [];

  lines.push('\n\n<b>📆 오늘 일정</b>');
  if (todayEvents.length === 0) {
    lines.push('일정 없음');
  } else {
    for (const { ev, evKST } of todayEvents) {
      if (ev.allDay) {
        lines.push(`• ${ev.summary} 🔵 하루종일`);
      } else {
        const hh = String(evKST.getUTCHours()).padStart(2,'0');
        const mm = String(evKST.getUTCMinutes()).padStart(2,'0');
        const endKST = new Date(ev.end.getTime() + 9 * 60 * 60 * 1000);
        const ehh = String(endKST.getUTCHours()).padStart(2,'0');
        const emm = String(endKST.getUTCMinutes()).padStart(2,'0');
        lines.push(`• ${hh}:${mm}–${ehh}:${emm} ${ev.summary}`);
      }
    }
  }

  lines.push('\n<b>📅 다가오는 일정</b>');
  for (let offset = 1; offset <= 3; offset++) {
    const d = new Date(todayDate.getTime() + offset * 24 * 60 * 60 * 1000);
    const dateKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    const [y, m, day] = dateKey.split('-').map(Number);
    const dow = dayNames[new Date(Date.UTC(y, m-1, day)).getUTCDay()];
    const dayEvents = grouped[dateKey] || [];
    if (dayEvents.length === 0) {
      lines.push(`• ${m}/${day} (${dow}) 일정 없음`);
    } else {
      for (const { ev, evKST } of dayEvents) {
        if (ev.allDay) {
          lines.push(`• ${m}/${day} (${dow}) ${ev.summary} 🔵 하루종일`);
        } else {
          const hh = String(evKST.getUTCHours()).padStart(2,'0');
          const mm2 = String(evKST.getUTCMinutes()).padStart(2,'0');
          lines.push(`• ${m}/${day} (${dow}) ${hh}:${mm2} ${ev.summary}`);
        }
      }
    }
  }

  return lines.join('\n');
}

// ──────────────────────────────────────────────
// Notion 함수들
// ──────────────────────────────────────────────
async function getChildPages(pageId) {
  const children = [];
  let cursor = undefined;
  while (true) {
    const res = await withRetry(() => notion.blocks.children.list({ block_id: pageId, start_cursor: cursor, page_size: 100 }));
    for (const block of res.results) {
      if (block.type === 'child_page') children.push({ id: block.id, title: block.child_page.title });
    }
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return children;
}

async function findPage(parentId, title) {
  const children = await getChildPages(parentId);
  return children.find(p => p.title === title) || null;
}

async function findOrCreatePage(parentId, title) {
  const found = await findPage(parentId, title);
  if (found) { console.log(`✅ 페이지 찾음: ${title}`); return found.id; }
  console.log(`🆕 페이지 생성: ${title}`);
  const res = await withRetry(() => notion.pages.create({ parent: { page_id: parentId }, properties: { title: { title: [{ text: { content: title } }] } } }));
  return res.id;
}

async function getAllBlocks(pageId) {
  const blocks = [];
  let cursor = undefined;
  while (true) {
    const res = await withRetry(() => notion.blocks.children.list({ block_id: pageId, start_cursor: cursor, page_size: 100 }));
    blocks.push(...res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return blocks;
}

function extractText(richText) {
  return richText?.map(t => t.plain_text).join('') || '';
}

async function findLatestDayPage(monthPageId) {
  const children = await getChildPages(monthPageId);
  const dayPages = children.filter(p => /^\d{4}_\d{2}_\d{2}/.test(p.title));
  if (dayPages.length === 0) return null;
  dayPages.sort((a, b) => b.title.localeCompare(a.title));
  return dayPages[0];
}

async function findPrevMonthLatestDayPage(year, month) {
  const prevMonth = month === '01'
    ? { year: String(Number(year) - 1), month: '12' }
    : { year, month: String(Number(month) - 1).padStart(2, '0') };
  const prevYearPage = await findPage(ROOT_PAGE_ID, `${prevMonth.year}년`);
  if (!prevYearPage) return null;
  const prevMonthPage = await findPage(prevYearPage.id, `${prevMonth.year}_${prevMonth.month}`);
  if (!prevMonthPage) return null;
  return await findLatestDayPage(prevMonthPage.id);
}

async function findFirstColumnList(pageId) {
  const blocks = await getAllBlocks(pageId);
  for (const block of blocks) {
    if (block.type === 'column_list') return block.id;
  }
  return null;
}

function replaceDateInRichText(richText, { year, month, day, dayName }) {
  const newDateStr = `${year}년 ${month}월 ${day}일 ${dayName}요일`;
  return richText.map(rt => {
    const updated = JSON.parse(JSON.stringify(rt));
    if (updated.plain_text && /\d{4}년 \d{2}월 \d{2}일/.test(updated.plain_text)) {
      if (updated.text?.content) {
        updated.text.content = updated.text.content.replace(/\d{4}년 \d{2}월 \d{2}일 .요일/, newDateStr);
      }
    }
    return updated;
  });
}

function isCheckedTodo(block) {
  return block.type === 'to_do' && block.to_do?.checked === true;
}

// MMDD or MMDD~MMDD 패턴에서 마지막 날짜 반환 (연차 만료 판단용)
function parseLeaveDateRange(text, year) {
  const Y = Number(year);
  const rangeMatch = text.match(/^(\d{4})~(\d{4})/);
  if (rangeMatch) {
    const em = parseInt(rangeMatch[2].slice(0, 2));
    const ed = parseInt(rangeMatch[2].slice(2, 4));
    return { end: ed ? new Date(Date.UTC(Y, em - 1, ed)) : new Date(Date.UTC(Y, em, 0)) };
  }
  const singleMatch = text.match(/^(\d{4})/);
  if (singleMatch) {
    const mm = parseInt(singleMatch[1].slice(0, 2));
    const dd = parseInt(singleMatch[1].slice(2, 4));
    return { end: dd ? new Date(Date.UTC(Y, mm - 1, dd)) : new Date(Date.UTC(Y, mm, 0)) };
  }
  return null;
}

function removeNulls(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(removeNulls);
  return Object.fromEntries(
    Object.entries(obj).filter(([_, v]) => v !== null).map(([k, v]) => [k, removeNulls(v)])
  );
}

const UNSUPPORTED_TYPES = ['unsupported', 'child_page', 'child_database'];

async function collectTodos(sourceBlocks, addedItems, depth = 0) {
  for (const block of sourceBlocks) {
    if (isCheckedTodo(block)) continue;
    if (UNSUPPORTED_TYPES.includes(block.type)) continue;
    if (block.type === 'to_do') {
      const text = extractText(block.to_do.rich_text);
      if (text) {
        addedItems.push('  '.repeat(depth) + '• ' + text);
      }
    }
    if (block.has_children) {
      const subBlocks = await getAllBlocks(block.id);
      await collectTodos(subBlocks, addedItems, depth + 1);
    }
  }
}

function convertBlockFlat(block, dateInfo) {
  if (isCheckedTodo(block)) return null;
  const type = block.type;
  if (UNSUPPORTED_TYPES.includes(type)) return null;
  if (!block[type]) return { object: 'block', type: 'paragraph', paragraph: { rich_text: [] } };

  const blockData = removeNulls(JSON.parse(JSON.stringify(block[type])));

  if (blockData.rich_text) {
    blockData.rich_text = replaceDateInRichText(blockData.rich_text, dateInfo);
  }

  if (type === 'to_do') {
    blockData.checked = false;
  }

  if (['image', 'video', 'file', 'audio', 'pdf'].includes(type)) {
    const caption = blockData.caption || [];
    const name = blockData.name;
    let mediaObj;
    if (blockData.external?.url) {
      mediaObj = { external: { url: blockData.external.url } };
    } else if (blockData.file?.url) {
      mediaObj = { external: { url: blockData.file.url } };
    } else {
      return null;
    }
    if (name) mediaObj.name = name;
    return { object: 'block', type, [type]: { ...mediaObj, caption } };
  }

  delete blockData.children;
  return { object: 'block', type, [type]: blockData };
}

async function appendBlocksRecursive(parentId, sourceBlocks, dateInfo, filterPastLeaves = false) {
  const today = new Date(Date.UTC(Number(dateInfo.year), Number(dateInfo.month) - 1, Number(dateInfo.day)));
  const flatBlocks = [];
  const sourceBlocksFiltered = [];

  for (const src of sourceBlocks) {
    if (filterPastLeaves) {
      const t = src.type;
      const text = src[t]?.rich_text ? extractText(src[t].rich_text) : '';
      const dateRange = parseLeaveDateRange(text, dateInfo.year);
      if (dateRange && dateRange.end < today) continue;
    }

    const converted = convertBlockFlat(src, dateInfo);
    if (converted) {
      flatBlocks.push(converted);
      sourceBlocksFiltered.push(src);
    }
  }

  if (flatBlocks.length === 0) return;

  const res = await withRetry(() => notion.blocks.children.append({ block_id: parentId, children: flatBlocks }));

  const count = Math.min(res.results.length, sourceBlocksFiltered.length);
  for (let i = 0; i < count; i++) {
    const newBlock = res.results[i];
    const srcBlock = sourceBlocksFiltered[i];
    if (srcBlock.has_children) {
      const subBlocks = await getAllBlocks(srcBlock.id);
      if (subBlocks.length > 0) {
        const t = srcBlock.type;
        const text = srcBlock[t]?.rich_text ? extractText(srcBlock[t].rich_text) : '';
        await appendBlocksRecursive(newBlock.id, subBlocks, dateInfo, text === '연차');
      }
    }
  }
}

// ──────────────────────────────────────────────
// 개인 섹션 블록 추출 (구/신 레이아웃 모두 지원)
// ──────────────────────────────────────────────
async function findPersonalBlocks(sourcePageId) {
  const blocks = await getAllBlocks(sourcePageId);

  // 구 레이아웃: column_list가 있으면 첫 번째 컬럼에서 개인 블록 추출
  const colList = blocks.find(b => b.type === 'column_list');
  if (colList) {
    const columns = await getAllBlocks(colList.id);
    if (columns.length > 0) {
      return await getAllBlocks(columns[0].id);
    }
    return [];
  }

  // 신 레이아웃: divider / link_to_page / 📋로 시작하는 블록 이전까지
  const personal = [];
  for (const block of blocks) {
    if (block.type === 'divider' || block.type === 'link_to_page') break;
    const text = block[block.type]?.rich_text ? extractText(block[block.type].rich_text) : '';
    if (text.startsWith('📋')) break;
    personal.push(block);
  }
  return personal;
}

// ──────────────────────────────────────────────
// 장기업무 DB 스냅샷 섹션 생성
// ──────────────────────────────────────────────
async function buildSnapshotSection(dayPageId, dbId) {
  // heading
  await withRetry(() => notion.blocks.children.append({
    block_id: dayPageId,
    children: [{
      object: 'block', type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: '📋 오늘의 장기업무 현황' } }] },
    }],
  }));

  if (!dbId) return;

  // DB 전체 조회 (일정코드 오름차순)
  const rows = [];
  let cursor;
  while (true) {
    const res = await withRetry(() => notion.databases.query({
      database_id: dbId,
      sorts: [{ property: '일정코드', direction: 'ascending' }],
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    }));
    rows.push(...res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  // 각 행의 마지막 댓글 수집
  const commentMap = {};
  for (const row of rows) {
    const res = await withRetry(() => notion.comments.list({ block_id: row.id, page_size: 100 }));
    const last = res.results[res.results.length - 1];
    commentMap[row.id] = last?.rich_text?.map(t => t.plain_text).join('') || '';
  }

  // 업무명 기준으로 그룹핑 (일정코드 정렬 유지)
  const groups = new Map();
  for (const row of rows) {
    const p = row.properties;
    const propText = prop => prop?.rich_text?.map(t => t.plain_text).join('') || prop?.title?.map(t => t.plain_text).join('') || '';
    const 업무명 = propText(p['업무명']);
    const 일정코드 = propText(p['일정코드']);
    const 상태 = p['상태']?.select?.name || '';
    const 담당자 = p['담당자']?.select?.name || '';
    const 역할 = (p['역할']?.multi_select || []).map(r => r.name).join('/');
    const 업무현황 = commentMap[row.id] || '';

    const key = `${일정코드}|||${업무명}`;
    if (!groups.has(key)) groups.set(key, { 업무명, 일정코드, 상태, members: [] });
    if (담당자) groups.get(key).members.push({ 담당자, 역할, 업무현황 });
  }

  if (groups.size === 0) return;

  // 헤더 블록 먼저 append
  const groupList = [...groups.values()];
  const headerBlocks = groupList.map(({ 업무명, 일정코드, 상태 }) => {
    const prefix = 일정코드 ? `${일정코드} ` : '';
    return {
      object: 'block', type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: [{ type: 'text', text: { content: `[${상태 || '—'}] ${prefix}${업무명}` } }] },
    };
  });

  const headerRes = await withRetry(() => notion.blocks.children.append({
    block_id: dayPageId,
    children: headerBlocks,
  }));

  // 각 헤더 블록에 담당자 행 추가
  const count = Math.min(headerRes.results.length, groupList.length);
  for (let i = 0; i < count; i++) {
    const { members } = groupList[i];
    if (members.length === 0) continue;
    await withRetry(() => notion.blocks.children.append({
      block_id: headerRes.results[i].id,
      children: members.map(({ 담당자, 역할, 업무현황 }) => ({
        object: 'block', type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [{ type: 'text', text: { content: `${담당자}${역할 ? ` (${역할})` : ''}: ${업무현황 || '—'}` } }],
        },
      })),
    }));
  }
}

// ──────────────────────────────────────────────
// 고정 페이지 관리
// ──────────────────────────────────────────────

// 체크된 할 일 및 만료 연차를 재귀적으로 삭제
async function deleteCheckedTodosRecursive(parentId, dateInfo, filterExpiredLeaves = false) {
  const today = new Date(Date.UTC(Number(dateInfo.year), Number(dateInfo.month) - 1, Number(dateInfo.day)));
  const blocks = await getAllBlocks(parentId);
  for (const block of blocks) {
    if (isCheckedTodo(block)) {
      await withRetry(() => notion.blocks.delete({ block_id: block.id }));
      continue;
    }
    if (filterExpiredLeaves) {
      const t = block.type;
      const text = block[t]?.rich_text ? extractText(block[t].rich_text) : '';
      const dateRange = parseLeaveDateRange(text, dateInfo.year);
      if (dateRange && dateRange.end < today) {
        await withRetry(() => notion.blocks.delete({ block_id: block.id }));
        continue;
      }
    }
    if (block.has_children) {
      const t = block.type;
      const text = block[t]?.rich_text ? extractText(block[t].rich_text) : '';
      await deleteCheckedTodosRecursive(block.id, dateInfo, text === '연차');
    }
  }
}

// 고정 페이지 개인 섹션에서 완료 항목 및 만료 연차 삭제
async function clearPersonalSection(fixedPageId, dateInfo) {
  const today = new Date(Date.UTC(Number(dateInfo.year), Number(dateInfo.month) - 1, Number(dateInfo.day)));
  const blocks = await getAllBlocks(fixedPageId);
  for (const block of blocks) {
    if (block.type === 'divider' || block.type === 'link_to_page') break;
    const t = block.type;
    const text = block[t]?.rich_text ? extractText(block[t].rich_text) : '';
    if (text.startsWith('📋')) break;

    if (isCheckedTodo(block)) {
      await withRetry(() => notion.blocks.delete({ block_id: block.id }));
      continue;
    }
    if (block.has_children) {
      await deleteCheckedTodosRecursive(block.id, dateInfo, text === '연차');
    }
  }
}

// 고정 페이지 하단 divider+스냅샷 삭제 후 재생성
async function refreshSnapshotInPage(fixedPageId) {
  const blocks = await getAllBlocks(fixedPageId);

  // divider 또는 📋 heading_2 이후 블록 전부 삭제 (divider 포함)
  let deleteFromIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === 'divider' && deleteFromIdx === -1) {
      deleteFromIdx = i;
      break;
    }
    if (block.type === 'heading_2') {
      const text = extractText(block.heading_2.rich_text);
      if (text.startsWith('📋')) { deleteFromIdx = i; break; }
    }
  }
  if (deleteFromIdx >= 0) {
    for (let i = deleteFromIdx; i < blocks.length; i++) {
      await withRetry(() => notion.blocks.delete({ block_id: blocks[i].id }));
    }
  }

  // divider + 새 스냅샷 + 보드 링크 추가
  await withRetry(() => notion.blocks.children.append({
    block_id: fixedPageId,
    children: [{ object: 'block', type: 'divider', divider: {} }],
  }));
  await buildSnapshotSection(fixedPageId, WORKTASK_DB_ID);
  if (BOARD_PAGE_ID) {
    await withRetry(() => notion.blocks.children.append({
      block_id: fixedPageId,
      children: [{ object: 'block', type: 'link_to_page', link_to_page: { type: 'page_id', page_id: BOARD_PAGE_ID } }],
    }));
  }
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────
async function main() {
  const dateInfo = getKSTDate();
  const { year, month, day, dayName } = dateInfo;
  const todayStr = `${year}년 ${month}월 ${day}일`;
  const dayPageTitle = `${year}_${month}_${day} (${dayName})`;
  const isWeekend = dayName === '토' || dayName === '일';

  console.log(`📅 오늘 날짜 (KST): ${todayStr} ${dayName}요일`);

  const calendarPromise = getCalendarEvents();

  try {
    const [weather, calendarEvents] = await Promise.all([
      getWeather(),
      calendarPromise,
    ]);
    const calendarText = formatCalendarSection(calendarEvents);

    if (isWeekend) {
      console.log('🏖 주말이에요. 일지 생성 없이 메시지만 전송합니다.');
      await sendTelegram(
`🌅 좋은 아침이에요! 즐거운 주말 보내세요 😊

📅 <b>${todayStr} ${dayName}요일</b>
${weather}${calendarText}

푹 쉬고 충전하는 하루 되세요! 🌿`
      );
      return;
    }

    // 평일만 Notion 접근
    if (!FIXED_PAGE_ID) throw new Error('FIXED_PAGE_ID 환경변수가 설정되지 않았습니다.');

    const yearPageId = await findOrCreatePage(ROOT_PAGE_ID, `${year}년`);
    const monthPageId = await findOrCreatePage(yearPageId, `${year}_${month}`);
    const existingBackup = await findPage(monthPageId, dayPageTitle);

    // 중복 실행: 스냅샷만 갱신 후 재전송
    if (existingBackup) {
      console.log('⚠️ 오늘 백업이 이미 존재합니다. 스냅샷 갱신 후 재전송합니다.');
      await refreshSnapshotInPage(FIXED_PAGE_ID);
      const addedItems = [];
      const personalBlocks = await findPersonalBlocks(FIXED_PAGE_ID);
      await collectTodos(personalBlocks, addedItems);
      const itemsText = addedItems.length > 0 ? `\n\n<b>📋 오늘의 할 일</b>\n${addedItems.join('\n')}` : '';
      await sendTelegram(
`🌅 좋은 아침이에요! 오늘도 화이팅입니다 😊

📅 <b>${todayStr} ${dayName}요일</b>
${weather}${calendarText}${itemsText}

이미 백업이 있어서 스냅샷 갱신 후 다시 보내드렸어요~ 📋`
      );
      return;
    }

    // 최초 실행: 고정 페이지 → 날짜 백업 생성 + 고정 페이지 갱신
    const sourcePersonalBlocks = await findPersonalBlocks(FIXED_PAGE_ID);
    if (sourcePersonalBlocks.length === 0) throw new Error('고정 페이지(📌 오늘의 업무)에서 개인 섹션을 찾을 수 없습니다.');

    // 1. 날짜 백업 생성 (연/월 계층)
    const backupPageId = await findOrCreatePage(monthPageId, dayPageTitle);
    await appendBlocksRecursive(backupPageId, sourcePersonalBlocks, dateInfo);
    await withRetry(() => notion.blocks.children.append({
      block_id: backupPageId,
      children: [{ object: 'block', type: 'divider', divider: {} }],
    }));
    await buildSnapshotSection(backupPageId, WORKTASK_DB_ID);
    if (BOARD_PAGE_ID) {
      await withRetry(() => notion.blocks.children.append({
        block_id: backupPageId,
        children: [{ object: 'block', type: 'link_to_page', link_to_page: { type: 'page_id', page_id: BOARD_PAGE_ID } }],
      }));
    }
    console.log(`✅ 백업 생성: ${dayPageTitle}`);

    // 2. 고정 페이지: 완료 항목 삭제 + 스냅샷 갱신
    await clearPersonalSection(FIXED_PAGE_ID, dateInfo);
    await refreshSnapshotInPage(FIXED_PAGE_ID);
    console.log('✅ 고정 페이지 갱신 완료');

    // 3. 텔레그램 전송 (백업 생성 전 개인 섹션 기준으로 할 일 수집)
    const addedItems = [];
    await collectTodos(sourcePersonalBlocks, addedItems);
    const itemsText = addedItems.length > 0 ? `\n\n<b>📋 오늘의 할 일</b>\n${addedItems.join('\n')}` : '';

    await sendTelegram(
`🌅 좋은 아침이에요! 오늘도 화이팅입니다 😊

📅 <b>${todayStr} ${dayName}요일</b>
${weather}${calendarText}${itemsText}

오늘 하루도 잘 부탁드려요! 💪`
    );

  } catch (err) {
    console.error('❌ 오류 발생:', err);
    await sendTelegram(
`😥 앗, 오늘 일지 작성 중에 문제가 생겼어요.

📅 ${todayStr}
❌ 오류 내용: ${err.message}

확인 부탁드려요!`
    );
    process.exit(1);
  }
}

main();
