const { Client } = require('@notionhq/client');
const https = require('https');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const ROOT_PAGE_ID = process.env.DAILY_LOG_PAGE_ID;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// 텔레그램 메시지 전송
async function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
    });
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

// KST 기준 오늘 날짜 정보
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

// 하위 페이지 목록 가져오기
async function getChildPages(pageId) {
  const children = [];
  let cursor = undefined;
  while (true) {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
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

// 페이지 찾기 또는 생성
async function findOrCreatePage(parentId, title) {
  const children = await getChildPages(parentId);
  const found = children.find(p => p.title === title);
  if (found) {
    console.log(`✅ 페이지 찾음: ${title}`);
    return found.id;
  }
  console.log(`🆕 페이지 생성: ${title}`);
  const res = await notion.pages.create({
    parent: { page_id: parentId },
    properties: {
      title: { title: [{ text: { content: title } }] },
    },
  });
  return res.id;
}

// 페이지 전체 블록 가져오기
async function getAllBlocks(pageId) {
  const blocks = [];
  let cursor = undefined;
  while (true) {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return blocks;
}

// 블록 내 텍스트 추출
function extractText(richText) {
  return richText?.map(t => t.plain_text).join('') || '';
}

// columns 블록에서 날짜 텍스트 찾기
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

// 오늘 날짜 섹션이 이미 있는지 확인
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

// 가장 최근 column_list 블록 ID 찾기
async function findLatestColumnList(monthPageId) {
  const blocks = await getAllBlocks(monthPageId);
  for (const block of blocks) {
    if (block.type === 'column_list') return block.id;
  }
  return null;
}

// 날짜 rich_text 교체
function replaceDateInRichText(richText, { year, month, day, dayName }) {
  const newDateStr = `${year}년 ${month}월 ${day}일 ${dayName}요일`;
  return richText.map(rt => {
    const updated = { ...rt };
    if (updated.plain_text && /\d{4}년 \d{2}월 \d{2}일/.test(updated.plain_text)) {
      if (updated.text) {
        updated.text = {
          ...updated.text,
          content: updated.text.content.replace(/\d{4}년 \d{2}월 \d{2}일 .요일/, newDateStr),
        };
      }
    }
    return updated;
  });
}

// 체크된 to_do 블록인지 확인
function isCheckedTodo(block) {
  return block.type === 'to_do' && block.to_do?.checked === true;
}

// 블록 복사 (체크된 항목 제거 + 날짜 교체 + 체크박스 초기화)
async function copyBlockWithReset(block, dateInfo) {
  const { id, ...rest } = block;
  const copied = JSON.parse(JSON.stringify(rest));

  // 체크박스 초기화
  if (copied.type === 'to_do') {
    copied.to_do.checked = false;
  }

  // 날짜 텍스트 교체
  const richTextField = copied[copied.type]?.rich_text;
  if (richTextField) {
    copied[copied.type].rich_text = replaceDateInRichText(richTextField, dateInfo);
  }

  // 하위 블록 재귀 처리 (체크된 항목 제거)
  if (['column_list', 'column', 'bulleted_list_item', 'numbered_list_item',
       'to_do', 'toggle', 'quote', 'callout'].includes(copied.type)) {
    const children = await getAllBlocks(id);
    const filteredChildren = children.filter(child => !isCheckedTodo(child));
    if (filteredChildren.length > 0) {
      copied.children = await Promise.all(filteredChildren.map(b => copyBlockWithReset(b, dateInfo)));
    }
  }

  return copied;
}

// 오늘 섹션 삽입
async function insertTodaySection(monthPageId, sourceColumnListId, dateInfo) {
  const columns = await getAllBlocks(sourceColumnListId);
  const addedItems = [];

  const columnBlocks = await Promise.all(
    columns.map(async col => {
      const colChildren = await getAllBlocks(col.id);
      const filteredChildren = colChildren.filter(child => !isCheckedTodo(child));
      const copiedChildren = await Promise.all(filteredChildren.map(b => copyBlockWithReset(b, dateInfo)));

      // 미완료 to_do 항목 텍스트 수집
      for (const child of filteredChildren) {
        if (child.type === 'to_do') {
          const text = extractText(child.to_do.rich_text);
          if (text) addedItems.push(`• ${text}`);
        }
      }

      return {
        object: 'block',
        type: 'column',
        column: {},
        children: copiedChildren,
      };
    })
  );

  await notion.blocks.children.append({
    block_id: monthPageId,
    children: [
      {
        object: 'block',
        type: 'column_list',
        column_list: {},
        children: columnBlocks,
      },
    ],
  });

  return addedItems;
}

// 메인 실행
async function main() {
  const dateInfo = getKSTDate();
  const { year, month, day, dayName } = dateInfo;
  const todayStr = `${year}년 ${month}월 ${day}일`;

  console.log(`📅 오늘 날짜 (KST): ${todayStr} ${dayName}요일`);

  try {
    // 1. 년도 페이지 찾기 또는 생성
    const yearPageId = await findOrCreatePage(ROOT_PAGE_ID, `${year}년`);

    // 2. 월 페이지 찾기 또는 생성
    const monthPageId = await findOrCreatePage(yearPageId, `${year}_${month}`);

    // 3. 오늘 섹션 중복 확인
    const alreadyExists = await todayAlreadyExists(monthPageId, todayStr);
    if (alreadyExists) {
      console.log(`⚠️ 오늘 날짜 섹션이 이미 존재합니다.`);
      await sendTelegram(`⚠️ <b>일일업무일지</b>\n오늘(${todayStr}) 섹션이 이미 존재합니다.`);
      return;
    }

    // 4. 소스 column_list 찾기 (현재 월 → 없으면 이전 월)
    let sourceColumnListId = await findLatestColumnList(monthPageId);

    if (!sourceColumnListId) {
      console.log(`🔍 현재 월 페이지에 내용 없음. 이전 월 페이지에서 찾는 중...`);
      const prevMonth = month === '01'
        ? { year: String(Number(year) - 1), month: '12' }
        : { year, month: String(Number(month) - 1).padStart(2, '0') };

      const prevYearChildren = await getChildPages(ROOT_PAGE_ID);
      const prevYearPage = prevYearChildren.find(p => p.title === `${prevMonth.year}년`);
      if (prevYearPage) {
        const prevMonthChildren = await getChildPages(prevYearPage.id);
        const prevMonthPage = prevMonthChildren.find(p => p.title === `${prevMonth.year}_${prevMonth.month}`);
        if (prevMonthPage) {
          sourceColumnListId = await findLatestColumnList(prevMonthPage.id);
        }
      }
    }

    if (!sourceColumnListId) {
      throw new Error('복사할 소스 섹션을 찾을 수 없습니다.');
    }

    // 5. 오늘 섹션 추가
    const addedItems = await insertTodaySection(monthPageId, sourceColumnListId, dateInfo);
    console.log(`✅ 오늘(${todayStr}) 섹션 추가 완료`);

    // 6. 텔레그램 성공 알림
    const itemsText = addedItems.length > 0
      ? `\n\n<b>오늘의 할 일:</b>\n${addedItems.join('\n')}`
      : '';
    await sendTelegram(
      `✅ <b>일일업무일지 작성 완료</b>\n${todayStr} ${dayName}요일${itemsText}`
    );

  } catch (err) {
    console.error('❌ 오류 발생:', err);
    await sendTelegram(`❌ <b>일일업무일지 작성 실패</b>\n${todayStr}\n\n오류: ${err.message}`);
    process.exit(1);
  }
}

main();
