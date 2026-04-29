const { Client } = require('@notionhq/client');
const { DAVClient } = require('tsdav');
const ICAL = require('ical.js');
const https = require('https');

// ──────────────────────────────────────────────
// 환경변수 유효성 검사
// ──────────────────────────────────────────────
const REQUIRED_ENV = ['NOTION_TOKEN', 'DAILY_LOG_PAGE_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ 필수 환경변수 누락: ${key}`);
    process.exit(1);
  }
}

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const ROOT_PAGE_ID = process.env.DAILY_LOG_PAGE_ID;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const LAT = 37.4449;
const LON = 127.1388;

// ──────────────────────────────────────────────
// 유틸
// ──────────────────────────────────────────────
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
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('텔레그램 응답 파싱 실패: ' + data.slice(0, 100))); }
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
        catch (e) { reject(new Error(`JSON 파싱 실패 (${hostname}): ${String(data).slice(0, 200) || '(빈 응답)'}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ──────────────────────────────────────────────
// 날씨
// ──────────────────────────────────────────────
async function getWeather() {
  try {
    const data = await httpGet('api.open-meteo.com', `/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,weathercode,windspeed_10m&timezone=Asia/Seoul`);
    const { temperature_2m, weathercode, windspeed_10m } = data.current;

    const WEATHER_MAP = [
      { max: 0,  emoji: '☀️', desc: '맑음' },
      { max: 1,  emoji: '🌤', desc: '대체로 맑음' },
      { max: 2,  emoji: '🌤', desc: '구름 조금' },
      { max: 3,  emoji: '☁️', desc: '흐림' },
      { max: 49, emoji: '🌫', desc: '안개' },
      { max: 59, emoji: '🌦', desc: '이슬비' },
      { max: 69, emoji: '🌧', desc: '비' },
      { max: 79, emoji: '❄️', desc: '눈' },
      { max: 84, emoji: '🌧', desc: '소나기' },
      { max: 99, emoji: '⛈', desc: '뇌우' },
    ];
    const weather = WEATHER_MAP.find(w => weathercode <= w.max) || { emoji: '🌡', desc: '알 수 없음' };
    return `${weather.emoji} ${weather.desc} / 기온 ${temperature_2m}°C / 바람 ${windspeed_10m}km/h`;
  } catch (e) {
    console.warn('날씨 로드 실패:', e.message);
    return '날씨 정보를 가져오지 못했어요 😢';
  }
}

// ──────────────────────────────────────────────
// KST 날짜
// ──────────────────────────────────────────────
function getKSTDate() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = String(kst.getUTCFullYear());
  const month = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(kst.getUTCDate()).padStart(2, '0');
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const dayName = dayNames[kst.getUTCDay()];
  return { year, month, day, dayName };
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

    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const todayStart = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()));
    const rangeEnd = new Date(todayStart.getTime() + 4 * 24 * 60 * 60 * 1000);

    const events = [];
    for (const calendar of calendars) {
      let calObjects;
      try {
        calObjects = await client.fetchCalendarObjects({
          calendar,
          timeRange: { start: todayStart.toISOString(), end: rangeEnd.toISOString() },
        });
      } catch (e) {
        console.warn(`캘린더 페치 실패 (${calendar.displayName}):`, e.message);
        continue;
      }

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
                  // duration이 없을 경우 endDate - startDate로 계산
                  let endJS;
                  try {
                    const durationSec = event.duration?.toSeconds?.();
                    if (typeof durationSec === 'number' && durationSec > 0) {
                      endJS = new Date(startJS.getTime() + durationSec * 1000);
                    } else {
                      endJS = event.endDate?.toJSDate?.() || new Date(startJS.getTime() + 60 * 60 * 1000);
                    }
                  } catch (e) {
                    endJS = new Date(startJS.getTime() + 60 * 60 * 1000);
                  }
                  events.push({
                    summary: event.summary || '(제목 없음)',
                    start: startJS,
                    end: endJS,
                    allDay: next.isDate,
                  });
                }
              }
            } else {
              const startJS = event.startDate.toJSDate();
              const endJS = event.endDate.toJSDate();
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
        } catch (e) {
          console.warn('iCal 파싱 오류 (건너뜀):', e.message);
        }
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

  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const todayKey = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth()+1).padStart(2,'0')}-${String(kst.getUTCDate()).padStart(2,'0')}`;

  const grouped = {};
  for (const ev of events) {
    // toJSDate()는 UTC 기준 Date 객체를 반환하므로 +9h로 KST 변환
    // allDay 이벤트는 시간 정보가 없으므로 UTC 날짜 그대로 사용
    const evKST = ev.allDay ? ev.start : new Date(ev.start.getTime() + 9 * 60 * 60 * 1000);
    const key = `${evKST.getUTCFullYear()}-${String(evKST.getUTCMonth()+1).padStart(2,'0')}-${String(evKST.getUTCDate()).padStart(2,'0')}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({ ev, evKST });
  }

  // 각 날짜 그룹 내 이벤트를 시작 시간순 정렬
  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => a.ev.start - b.ev.start);
  }

  const todayEvents = grouped[todayKey] || [];
  const upcomingKeys = Object.keys(grouped).sort().filter(k => k !== todayKey);

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
        // ev.end도 UTC 기준이므로 +9h KST 변환
        const endKST = new Date(ev.end.getTime() + 9 * 60 * 60 * 1000);
        const ehh = String(endKST.getUTCHours()).padStart(2,'0');
        const emm = String(endKST.getUTCMinutes()).padStart(2,'0');
        lines.push(`• ${hh}:${mm}–${ehh}:${emm} ${ev.summary}`);
      }
    }
  }

  lines.push('\n<b>📅 다가오는 일정</b>');
  if (upcomingKeys.length === 0) {
    lines.push('일정 없음');
  } else {
    for (const dateKey of upcomingKeys) {
      const [y, m, d] = dateKey.split('-').map(Number);
      const dow = dayNames[new Date(Date.UTC(y, m-1, d)).getUTCDay()];
      for (const { ev, evKST } of grouped[dateKey]) {
        if (ev.allDay) {
          lines.push(`• ${m}/${d} (${dow}) ${ev.summary} 🔵 하루종일`);
        } else {
          const hh = String(evKST.getUTCHours()).padStart(2,'0');
          const mm2 = String(evKST.getUTCMinutes()).padStart(2,'0');
          lines.push(`• ${m}/${d} (${dow}) ${hh}:${mm2} ${ev.summary}`);
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
    const res = await notion.blocks.children.list({ block_id: pageId, start_cursor: cursor, page_size: 100 });
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
  const res = await notion.pages.create({ parent: { page_id: parentId }, properties: { title: { title: [{ text: { content: title } }] } } });
  return res.id;
}

async function getAllBlocks(pageId) {
  const blocks = [];
  let cursor = undefined;
  while (true) {
    const res = await notion.blocks.children.list({ block_id: pageId, start_cursor: cursor, page_size: 100 });
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
      if (updated.text) {
        updated.text.content = updated.text.content.replace(/\d{4}년 \d{2}월 \d{2}일 .요일/, newDateStr);
      }
    }
    return updated;
  });
}

function isCheckedTodo(block) {
  return block.type === 'to_do' && block.to_do?.checked === true;
}

function removeNulls(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(removeNulls);
  return Object.fromEntries(
    Object.entries(obj).filter(([_, v]) => v !== null).map(([k, v]) => [k, removeNulls(v)])
  );
}

const UNSUPPORTED_TYPES = ['unsupported', 'child_page', 'child_database'];

// todo 항목을 소스에서 DFS 순서로 수집
async function collectTodos(sourceBlocks, addedItems, depth = 0) {
  for (const block of sourceBlocks) {
    if (isCheckedTodo(block)) continue; // 체크된 항목은 자식도 건너뜀
    if (block.type === 'to_do') {
      const text = extractText(block.to_do.rich_text);
      if (text) addedItems.push('  '.repeat(depth) + '• ' + text);
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

  delete blockData.children;
  return { object: 'block', type, [type]: blockData };
}

async function appendBlocksRecursive(parentId, sourceBlocks, dateInfo) {
  const flatBlocks = [];
  const sourceBlocksFiltered = [];

  for (const src of sourceBlocks) {
    const converted = convertBlockFlat(src, dateInfo);
    if (converted) {
      flatBlocks.push(converted);
      sourceBlocksFiltered.push(src);
    }
  }

  if (flatBlocks.length === 0) return;

  const res = await notion.blocks.children.append({ block_id: parentId, children: flatBlocks });

  for (let i = 0; i < res.results.length; i++) {
    const newBlock = res.results[i];
    const srcBlock = sourceBlocksFiltered[i];
    if (srcBlock.has_children) {
      const subBlocks = await getAllBlocks(srcBlock.id);
      if (subBlocks.length > 0) {
        await appendBlocksRecursive(newBlock.id, subBlocks, dateInfo);
      }
    }
  }
}

async function appendColumnList(pageId, sourceColumnListId, dateInfo, addedItems) {
  const sourceColumns = await getAllBlocks(sourceColumnListId);
  const columnsForCreation = [];
  const sourceColumnsFiltered = [];

  for (const col of sourceColumns) {
    if (col.type !== 'column') continue;
    columnsForCreation.push({ object: 'block', type: 'column', column: { children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }] } });
    sourceColumnsFiltered.push(col);
  }

  if (columnsForCreation.length < 2) throw new Error('소스 페이지에 column이 2개 이상 있어야 합니다.');

  const res = await notion.blocks.children.append({
    block_id: pageId,
    children: [{ object: 'block', type: 'column_list', column_list: { children: columnsForCreation } }],
  });

  const newColumnListId = res.results[0].id;
  const newColumns = await getAllBlocks(newColumnListId);

  for (let i = 0; i < newColumns.length; i++) {
    const newCol = newColumns[i];
    const srcCol = sourceColumnsFiltered[i];
    const placeholders = await getAllBlocks(newCol.id);
    for (const p of placeholders) {
      try {
        await notion.blocks.delete({ block_id: p.id });
      } catch (e) {
        console.warn(`placeholder 삭제 실패 (${p.id}):`, e.message);
      }
    }
    const subBlocks = await getAllBlocks(srcCol.id);
    if (subBlocks.length > 0) {
      await appendBlocksRecursive(newCol.id, subBlocks, dateInfo);
      if (i === 0) await collectTodos(subBlocks, addedItems);
    }
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

  try {
    // 날씨/캘린더 병렬 로드, 각각 실패해도 계속 진행
    const [weatherResult, calendarResult] = await Promise.allSettled([
      getWeather(),
      getCalendarEvents(),
    ]);

    const weather = weatherResult.status === 'fulfilled' ? weatherResult.value : '날씨 정보를 가져오지 못했어요 😢';
    const calendarEvents = calendarResult.status === 'fulfilled' ? calendarResult.value : null;
    const calendarText = formatCalendarSection(calendarEvents);

    const yearPageId = await findOrCreatePage(ROOT_PAGE_ID, `${year}년`);
    const monthPageId = await findOrCreatePage(yearPageId, `${year}_${month}`);
    const existingDayPage = await findPage(monthPageId, dayPageTitle);

    if (isWeekend) {
      if (existingDayPage) {
        console.log('🏖 주말 메시지 이미 전송됨. 재전송합니다.');
        await sendTelegram(
`🌅 좋은 아침이에요! 즐거운 주말 보내세요 😊

📅 <b>${todayStr} ${dayName}요일</b>
${weather}${calendarText}

이미 보내드렸는데 다시 한 번 보내드렸어요~ 😄`
        );
      } else {
        console.log('🏖 주말이에요. 일지 생성 없이 메시지만 전송합니다.');
        await findOrCreatePage(monthPageId, dayPageTitle);
        await sendTelegram(
`🌅 좋은 아침이에요! 즐거운 주말 보내세요 😊

📅 <b>${todayStr} ${dayName}요일</b>
${weather}${calendarText}

푹 쉬고 충전하는 하루 되세요! 🌿`
        );
      }
      return;
    }

    // 평일 중복
    if (existingDayPage) {
      console.log('⚠️ 오늘 날짜 페이지가 이미 존재합니다. todo 포함 재전송합니다.');
      const addedItems = [];
      const existingColumnListId = await findFirstColumnList(existingDayPage.id);
      if (existingColumnListId) {
        const existingColumns = await getAllBlocks(existingColumnListId);
        if (existingColumns.length > 0) {
          const firstColBlocks = await getAllBlocks(existingColumns[0].id);
          await collectTodos(firstColBlocks, addedItems);
        }
      }
      const itemsText = addedItems.length > 0 ? `\n\n<b>📋 오늘의 할 일</b>\n${addedItems.join('\n')}` : '';
      await sendTelegram(
`🌅 좋은 아침이에요! 오늘도 화이팅입니다 😊

📅 <b>${todayStr} ${dayName}요일</b>
${weather}${calendarText}${itemsText}

이미 일지가 있어서 다시 한 번 보내드렸어요~ 📋`
      );
      return;
    }

    // 평일 최초
    let sourceDayPage = await findLatestDayPage(monthPageId);
    if (!sourceDayPage) {
      console.log('🔍 현재 달에 일 페이지 없음. 이전 달에서 찾는 중...');
      sourceDayPage = await findPrevMonthLatestDayPage(year, month);
    }

    if (!sourceDayPage) throw new Error('복사할 이전 일지를 찾을 수 없습니다. 첫 일지를 수동으로 작성해주세요.');
    console.log(`📋 소스 페이지: ${sourceDayPage.title}`);

    const sourceColumnListId = await findFirstColumnList(sourceDayPage.id);
    if (!sourceColumnListId) throw new Error(`소스 페이지(${sourceDayPage.title})에서 내용을 찾을 수 없습니다.`);

    const dayPageId = await findOrCreatePage(monthPageId, dayPageTitle);
    const addedItems = [];
    await appendColumnList(dayPageId, sourceColumnListId, dateInfo, addedItems);
    console.log(`✅ 오늘(${dayPageTitle}) 페이지 생성 완료`);

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
