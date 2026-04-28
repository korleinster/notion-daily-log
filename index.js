const { Client } = require('@notionhq/client');
const https = require('https');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const ROOT_PAGE_ID = process.env.DAILY_LOG_PAGE_ID;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
      res.on('end', () => resolve(JSON.parse(data)));
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
      res.on('end', () => resolve(JSON.parse(data)));
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
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = String(kst.getUTCFullYear());
  const month = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(kst.getUTCDate()).padStart(2, '0');
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const dayName = dayNames[kst.getUTCDay()];
  return { year, month, day, dayName };
}

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
  if (found) { console.log(`✅ 페이지 찾음: ${title}`); return { id: found.id, created: false }; }
  console.log(`🆕 페이지 생성: ${title}`);
  const res = await notion.pages.create({ parent: { page_id: parentId }, properties: { title: { title: [{ text: { content: title } }] } } });
  return { id: res.id, created: true };
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

// 월 페이지의 일 페이지 중 가장 최근 것 찾기 (제목 형식: YYYY_MM_DD)
async function findLatestDayPage(monthPageId) {
  const children = await getChildPages(monthPageId);
  const dayPages = children.filter(p => /^\d{4}_\d{2}_\d{2}/.test(p.title));
  if (dayPages.length === 0) return null;
  // 제목 기준으로 내림차순 정렬 후 첫 번째
  dayPages.sort((a, b) => b.title.localeCompare(a.title));
  return dayPages[0];
}

// 페이지에서 첫 번째 column_list 블록 ID 반환 (최신 내용)
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

function convertBlockFlat(block, dateInfo, addedItems) {
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
    const text = extractText(block.to_do.rich_text);
    if (text) {
      const depth = addedItems._depth || 0;
      const indent = '  '.repeat(depth);
      addedItems.push(`${indent}• ${text}`);
    }
  }

  delete blockData.children;
  return { object: 'block', type, [type]: blockData };
}

async function appendBlocksRecursive(parentId, sourceBlocks, dateInfo, addedItems) {
  const flatBlocks = [];
  const sourceBlocksFiltered = [];

  for (const src of sourceBlocks) {
    const converted = convertBlockFlat(src, dateInfo, addedItems);
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
        addedItems._depth = (addedItems._depth || 0) + 1;
        await appendBlocksRecursive(newBlock.id, subBlocks, dateInfo, addedItems);
        addedItems._depth = Math.max(0, (addedItems._depth || 1) - 1);
      }
    }
  }
}

// column_list를 pageId 하위에 생성
async function appendColumnList(pageId, sourceColumnListId, dateInfo, addedItems) {
  const sourceColumns = await getAllBlocks(sourceColumnListId);
  const columnsForCreation = [];
  const sourceColumnsFiltered = [];

  for (const col of sourceColumns) {
    if (col.type !== 'column') continue;
    columnsForCreation.push({ object: 'block', type: 'column', column: { children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }] } });
    sourceColumnsFiltered.push(col);
  }

  if (columnsForCreation.length < 2) throw new Error('column이 2개 이상 필요합니다.');

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
      try { await notion.blocks.delete({ block_id: p.id }); } catch (e) {}
    }

    const subBlocks = await getAllBlocks(srcCol.id);
    if (subBlocks.length > 0) {
      await appendBlocksRecursive(newCol.id, subBlocks, dateInfo, addedItems);
    }
  }
}

// 이전 달/해의 마지막 일 페이지에서 column_list 찾기
async function findPrevSourceColumnList(year, month) {
  const prevMonth = month === '01'
    ? { year: String(Number(year) - 1), month: '12' }
    : { year, month: String(Number(month) - 1).padStart(2, '0') };

  const prevYearPage = await findPage(ROOT_PAGE_ID, `${prevMonth.year}년`);
  if (!prevYearPage) return null;

  const prevMonthPage = await findPage(prevYearPage.id, `${prevMonth.year}_${prevMonth.month}`);
  if (!prevMonthPage) return null;

  // 이전 달의 가장 최근 일 페이지 찾기
  const latestDayPage = await findLatestDayPage(prevMonthPage.id);
  if (latestDayPage) {
    const columnListId = await findFirstColumnList(latestDayPage.id);
    if (columnListId) return columnListId;
  }

  // 일 페이지가 없으면 월 페이지에서 직접 찾기 (구버전 호환)
  return await findFirstColumnList(prevMonthPage.id);
}

async function main() {
  const dateInfo = getKSTDate();
  const { year, month, day, dayName } = dateInfo;
  const todayStr = `${year}년 ${month}월 ${day}일`;
  const dayPageTitle = `${year}_${month}_${day} (${dayName})`;

  console.log(`📅 오늘 날짜 (KST): ${todayStr} ${dayName}요일`);

  try {
    // 1. 년도 페이지
    const { id: yearPageId } = await findOrCreatePage(ROOT_PAGE_ID, `${year}년`);

    // 2. 월 페이지
    const { id: monthPageId } = await findOrCreatePage(yearPageId, `${year}_${month}`);

    // 3. 오늘 일 페이지 중복 확인
    const existingDayPage = await findPage(monthPageId, dayPageTitle);
    if (existingDayPage) {
      console.log(`⚠️ 오늘 날짜 페이지가 이미 존재합니다.`);
      await sendTelegram(`⚠️ 오늘(${todayStr}) 일지가 이미 작성되어 있어요!`);
      return;
    }

    // 4. 소스 column_list 찾기 (이전 일 페이지 → 이전 달)
    let sourceColumnListId = null;

    // 현재 달의 가장 최근 일 페이지에서 찾기
    const latestDayPage = await findLatestDayPage(monthPageId);
    if (latestDayPage) {
      sourceColumnListId = await findFirstColumnList(latestDayPage.id);
      console.log(`📋 소스: ${latestDayPage.title}`);
    }

    // 현재 달에 일 페이지가 없으면 이전 달에서 찾기
    if (!sourceColumnListId) {
      console.log(`🔍 현재 달에 일 페이지 없음. 이전 달에서 찾는 중...`);
      sourceColumnListId = await findPrevSourceColumnList(year, month);
    }

    if (!sourceColumnListId) throw new Error('복사할 소스 섹션을 찾을 수 없습니다. 첫 일지를 수동으로 작성해주세요.');

    // 5. 오늘 일 페이지 생성
    const { id: dayPageId } = await findOrCreatePage(monthPageId, dayPageTitle);

    // 6. 내용 복사
    const addedItems = [];
    await appendColumnList(dayPageId, sourceColumnListId, dateInfo, addedItems);
    console.log(`✅ 오늘(${dayPageTitle}) 페이지 생성 완료`);

    // 7. 텔레그램 알림
    const weather = await getWeather();
    const itemsText = addedItems.length > 0 ? `\n\n<b>📋 오늘의 할 일</b>\n${addedItems.join('\n')}` : '';

    await sendTelegram(
`🌅 좋은 아침이에요! 오늘도 화이팅입니다 😊

📅 <b>${todayStr} ${dayName}요일</b>
🏙 성남시 현재 날씨
${weather}${itemsText}

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
