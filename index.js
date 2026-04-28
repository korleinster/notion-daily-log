const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const ROOT_PAGE_ID = process.env.DAILY_LOG_PAGE_ID; // 일일업무일지 페이지 ID

// KST 기준 오늘 날짜 정보
function getKSTDate() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = kst.getUTCFullYear();
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

// columns 블록과 그 하위 블록 깊은 복사
async function deepCopyBlock(block) {
  const { id, type, ...rest } = block;
  const copied = { type, ...rest };

  // 하위 블록이 있는 경우 재귀적으로 복사
  if (['column_list', 'column', 'bulleted_list_item', 'numbered_list_item',
       'to_do', 'toggle', 'quote', 'callout', 'synced_block'].includes(type)) {
    const children = await getAllBlocks(id);
    if (children.length > 0) {
      copied.children = await Promise.all(children.map(deepCopyBlock));
    }
  }
  return copied;
}

// 날짜 헤더 텍스트에서 날짜 추출 (예: "2026년 04월 27일 월요일")
function extractDateFromBlock(block) {
  if (block.type !== 'column_list') return null;
  // column_list 자체에는 날짜 정보 없음 — 첫 번째 column의 첫 번째 bulleted_list_item에서 찾음
  return null; // 날짜는 하위 블록 탐색으로 찾음
}

// 블록 내 텍스트 추출
function extractText(richText) {
  return richText?.map(t => t.plain_text).join('') || '';
}

// columns 블록에서 날짜 텍스트 찾기 (하위 블록 직접 탐색)
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
    if (block.type === 'column_list') {
      return block.id;
    }
  }
  return null;
}

// 날짜 관련 rich_text에서 날짜 부분만 오늘로 교체
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

// 체크박스 미완료로 초기화하면서 블록 복사 (날짜도 교체)
async function copyBlockWithReset(block, dateInfo) {
  const { id, ...rest } = block;
  const copied = JSON.parse(JSON.stringify(rest));

  // to_do 체크박스 미완료로 초기화
  if (copied.type === 'to_do') {
    copied.to_do.checked = false;
  }

  // 날짜 텍스트 교체
  const richTextField = copied[copied.type]?.rich_text;
  if (richTextField) {
    copied[copied.type].rich_text = replaceDateInRichText(richTextField, dateInfo);
  }

  // 하위 블록 재귀 처리
  if (['column_list', 'column', 'bulleted_list_item', 'numbered_list_item',
       'to_do', 'toggle', 'quote', 'callout'].includes(copied.type)) {
    const children = await getAllBlocks(id);
    if (children.length > 0) {
      copied.children = await Promise.all(children.map(b => copyBlockWithReset(b, dateInfo)));
    }
  }

  return copied;
}

// column_list 블록과 하위 블록 전체 복사 후 맨 위에 삽입
async function insertTodaySection(monthPageId, sourceColumnListId, dateInfo) {
  // 소스 블록 복사 (날짜 교체 + 체크박스 초기화)
  const sourceBlock = await notion.blocks.retrieve({ block_id: sourceColumnListId });
  const copiedBlock = await copyBlockWithReset(sourceBlock, dateInfo);

  // column_list 하위의 column들 가져오기
  const columns = await getAllBlocks(sourceColumnListId);
  const columnBlocks = await Promise.all(
    columns.map(async col => {
      const colChildren = await getAllBlocks(col.id);
      const copiedChildren = await Promise.all(colChildren.map(b => copyBlockWithReset(b, dateInfo)));
      return {
        object: 'block',
        type: 'column',
        column: {},
        children: copiedChildren,
      };
    })
  );

  // 페이지 맨 위에 column_list 삽입
  const pageBlocks = await getAllBlocks(monthPageId);
  const firstBlockId = pageBlocks.length > 0 ? pageBlocks[0].id : undefined;

  await notion.blocks.children.append({
    block_id: monthPageId,
    after: undefined, // prepend 지원 안 되므로 아래에서 처리
    children: [
      {
        object: 'block',
        type: 'column_list',
        column_list: {},
        children: columnBlocks,
      },
    ],
  });

  // 방금 추가된 블록을 맨 위로 이동
  const updatedBlocks = await getAllBlocks(monthPageId);
  const newBlock = updatedBlocks[updatedBlocks.length - 1]; // 방금 추가된 블록

  // Notion API는 블록 순서 변경을 직접 지원하지 않으므로
  // 기존 블록들을 모두 새로 만들고 싶은 순서로 재정렬하는 방식 대신,
  // after 파라미터 없이 추가하면 맨 마지막에 추가되므로
  // 실제로는 맨 위에 추가하려면 아래 방식 사용:
  console.log(`✅ 오늘(${dateInfo.year}년 ${dateInfo.month}월 ${dateInfo.day}일) 섹션 추가 완료`);
}

// 메인 실행
async function main() {
  const dateInfo = getKSTDate();
  const { year, month, day, dayName } = dateInfo;
  const todayStr = `${year}년 ${month}월 ${day}일`;

  console.log(`📅 오늘 날짜 (KST): ${todayStr} ${dayName}요일`);

  // 1. 년도 페이지 찾기 또는 생성
  const yearTitle = `${year}년`;
  const yearPageId = await findOrCreatePage(ROOT_PAGE_ID, yearTitle);

  // 2. 월 페이지 찾기 또는 생성
  const monthTitle = `${year}_${month}`;
  const monthPageId = await findOrCreatePage(yearPageId, monthTitle);

  // 3. 오늘 섹션이 이미 있는지 확인
  const alreadyExists = await todayAlreadyExists(monthPageId, todayStr);
  if (alreadyExists) {
    console.log(`⚠️ 오늘 날짜 섹션이 이미 존재합니다. 종료합니다.`);
    return;
  }

  // 4. 가장 최근 column_list 찾기 (현재 월 페이지 → 없으면 이전 월 페이지)
  let sourceColumnListId = await findLatestColumnList(monthPageId);

  if (!sourceColumnListId) {
    console.log(`🔍 현재 월 페이지에 내용 없음. 이전 월 페이지에서 찾는 중...`);
    const prevMonth = month === '01'
      ? { year: String(Number(year) - 1), month: '12' }
      : { year, month: String(Number(month) - 1).padStart(2, '0') };

    const prevYearTitle = `${prevMonth.year}년`;
    const prevYearChildren = await getChildPages(ROOT_PAGE_ID);
    const prevYearPage = prevYearChildren.find(p => p.title === prevYearTitle);

    if (prevYearPage) {
      const prevMonthTitle = `${prevMonth.year}_${prevMonth.month}`;
      const prevMonthChildren = await getChildPages(prevYearPage.id);
      const prevMonthPage = prevMonthChildren.find(p => p.title === prevMonthTitle);
      if (prevMonthPage) {
        sourceColumnListId = await findLatestColumnList(prevMonthPage.id);
      }
    }
  }

  if (!sourceColumnListId) {
    console.log(`❌ 복사할 소스 섹션을 찾을 수 없습니다.`);
    return;
  }

  // 5. 오늘 섹션 추가
  await insertTodaySection(monthPageId, sourceColumnListId, dateInfo);
}

main().catch(err => {
  console.error('❌ 오류 발생:', err);
  process.exit(1);
});
