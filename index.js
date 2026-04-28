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

async function findOrCreatePage(parentId, title) {
  const children = await getChildPages(parentId);
  const found = children.find(p => p.title === title);
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

async function findDateInColumnList(blockId) {
  const columns = await getAllBlocks(blockId);
  if (!columns.length) return null;
  const firstColumnChildren = await getAllBlocks(columns[0].id);
  for (const child of firstColumnChildren) {
    if (child.type === 'bulleted_list_item') {
      const text = extractText(child.bulleted_list_item.rich_text);
      if (/\d{4}년 \d{2}월 \d{2}일/.test(text)) return text;
    }
  }
  return null;
}

async function todayAlreadyExists(monthPageId, todayStr) {
  const blocks = await getAllBlocks(monthPageId);
  for (const block of blocks) {
    if (block.type === 'column_list') {
      const dateText = await findDateInColumnList(block.id);
      if (dateText && dateText.includes(todayStr)) return true;
    }
  }
  return false;
}

async function findLatestColumnList(monthPageId) {
  const blocks = await getAllBlocks(monthPageId);
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

const UNSUPPORTED_TYPES = ['unsupported', 'child_page', 'child_database'];

// 블록을 Notion API 형식으로 변환 (children 없이, 평탄한 블록만)
function convertBlockFlat(block, dateInfo, addedItems) {
  if (isCheckedTodo(block)) return null;

  const type = block.type;
  if (UNSUPPORTED_TYPES.includes(type)) return null;

  if (!block[type]) {
    return { object: 'block', type: 'paragraph', paragraph: { rich_text: [] } };
  }

  const blockData = JSON.parse(JSON.stringify(block[type]));

  if (blockData.rich_text) {
    blockData.rich_text = replaceDateInRichText(blockData.rich_text, dateInfo);
  }

  if (type === 'to_do') {
    blockData.checked = false;
    const text = extractText(block.to_do.rich_text);
    if (text) {
      const depth = addedItems._depth || 0;
      const indent = '　'.repeat(depth);
      addedItems.push(`${indent}• ${text}`);
    }
  }

  // children 필드 제거 (별도로 추가할 거임)
  delete blockData.children;

  // null 값인 필드 제거 (Notion API는 null 허용 안 함)
  function removeNulls(obj) {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(removeNulls);
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([_, v]) => v !== null)
        .map(([k, v]) => [k, removeNulls(v)])
    );
  }
  const cleanBlockData = removeNulls(blockData);

  return { object: 'block', type, [type]: cleanBlockData };
}

// 블록 트리를 재귀적으로 추가
// parentId 아래에 sourceBlocks 의 변환된 형태를 순서대로 append
async function appendBlocksRecursive(parentId, sourceBlocks, dateInfo, addedItems) {
  // 1. 먼저 평탄한 블록들을 한꺼번에 append
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

  const res = await notion.blocks.children.append({
    block_id: parentId,
    children: flatBlocks,
  });

  // 2. 각 추가된 블록에 대해, 원본에 children이 있었으면 재귀적으로 append
  for (let i = 0; i < res.results.length; i++) {
    const newBlock = res.results[i];
    const srcBlock = sourceBlocksFiltered[i];

    // children을 가질 수 있는 타입만 재귀
    if (!newBlock.has_children && srcBlock.has_children) {
      // newBlock은 children이 없지만 src는 있음 (일반적으로 발생 안 함)
    }
    if (srcBlock.has_children) {
      const subBlocks = await getAllBlocks(srcBlock.id);
      if (subBlocks.length > 0) {
        addedItems._depth = (addedItems._depth || 0) + 1;
        await appendBlocksRecursive(newBlock.id, subBlocks, dateInfo, addedItems);
        addedItems._depth = (addedItems._depth || 1) - 1;
      }
    }
  }
}

async function insertTodaySection(monthPageId, sourceColumnListId, dateInfo) {
  const addedItems = [];

  // 기존 블록들 미리 저장
  const existingBlocks = await getAllBlocks(monthPageId);

  // 1. column_list + column들 생성
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
    block_id: monthPageId,
    children: [{ object: 'block', type: 'column_list', column_list: { children: columnsForCreation } }],
  });

  const newColumnListId = res.results[0].id;
  const newColumns = await getAllBlocks(newColumnListId);

  // 각 column에 실제 내용 추가
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

  // 2. 기존 블록들을 새 섹션 뒤로 이동 (새 섹션을 맨 위로)
  // 기존 블록을 다시 맨 뒤에 append 후 원본 삭제
  for (const block of existingBlocks) {
    if (block.type === 'unsupported' || block.type === 'child_page' || block.type === 'child_database') continue;
    try {
      // 기존 블록을 맨 뒤에 복사
      const blockData = JSON.parse(JSON.stringify(block[block.type] || {}));
      delete blockData.children;
      function removeNullsLocal(obj) {
        if (typeof obj !== 'object' || obj === null) return obj;
        if (Array.isArray(obj)) return obj.map(removeNullsLocal);
        return Object.fromEntries(Object.entries(obj).filter(([_, v]) => v !== null).map(([k, v]) => [k, removeNullsLocal(v)]));
      }
      const cleanData = removeNullsLocal(blockData);
      const appendRes = await notion.blocks.children.append({
        block_id: monthPageId,
        children: [{ object: 'block', type: block.type, [block.type]: cleanData }],
      });
      // 새로 추가된 블록에 children 재귀적으로 추가
      if (block.has_children) {
        const subBlocks = await getAllBlocks(block.id);
        if (subBlocks.length > 0) {
          await appendBlocksRecursive(appendRes.results[0].id, subBlocks, dateInfo, []);
        }
      }
      // 원본 삭제
      await notion.blocks.delete({ block_id: block.id });
    } catch (e) {
      console.log();
    }
  }

  return addedItems;
}

async function main() {
  const dateInfo = getKSTDate();
  const { year, month, day, dayName } = dateInfo;
  const todayStr = `${year}년 ${month}월 ${day}일`;

  console.log(`📅 오늘 날짜 (KST): ${todayStr} ${dayName}요일`);

  try {
    const yearPageId = await findOrCreatePage(ROOT_PAGE_ID, `${year}년`);
    const monthPageId = await findOrCreatePage(yearPageId, `${year}_${month}`);

    const alreadyExists = await todayAlreadyExists(monthPageId, todayStr);
    if (alreadyExists) {
      console.log(`⚠️ 오늘 날짜 섹션이 이미 존재합니다.`);
      await sendTelegram(`⚠️ 오늘(${todayStr}) 일지가 이미 작성되어 있어요!`);
      return;
    }

    let sourceColumnListId = await findLatestColumnList(monthPageId);

    if (!sourceColumnListId) {
      const prevMonth = month === '01'
        ? { year: String(Number(year) - 1), month: '12' }
        : { year, month: String(Number(month) - 1).padStart(2, '0') };
      const prevYearChildren = await getChildPages(ROOT_PAGE_ID);
      const prevYearPage = prevYearChildren.find(p => p.title === `${prevMonth.year}년`);
      if (prevYearPage) {
        const prevMonthChildren = await getChildPages(prevYearPage.id);
        const prevMonthPage = prevMonthChildren.find(p => p.title === `${prevMonth.year}_${prevMonth.month}`);
        if (prevMonthPage) sourceColumnListId = await findLatestColumnList(prevMonthPage.id);
      }
    }

    if (!sourceColumnListId) throw new Error('복사할 소스 섹션을 찾을 수 없습니다.');

    const addedItems = await insertTodaySection(monthPageId, sourceColumnListId, dateInfo);
    console.log(`✅ 오늘(${todayStr}) 섹션 추가 완료`);

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
