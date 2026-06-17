const { Client } = require('@notionhq/client');

if (!process.env.NOTION_TOKEN) { console.error('❌ 환경변수 누락: NOTION_TOKEN'); process.exit(1); }
if (!process.env.WORKTASK_DB_ID) { console.error('❌ 환경변수 누락: WORKTASK_DB_ID'); process.exit(1); }

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const WORKTASK_DB_ID = process.env.WORKTASK_DB_ID;

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

const propText = (prop) =>
  prop?.rich_text?.map(t => t.plain_text).join('') ||
  prop?.title?.map(t => t.plain_text).join('') || '';

async function main() {
  // 1. 전체 행 조회
  const rows = [];
  let cursor;
  while (true) {
    const res = await withRetry(() => notion.databases.query({
      database_id: WORKTASK_DB_ID,
      sorts: [{ property: '일정코드', direction: 'ascending' }],
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    }));
    rows.push(...res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  console.log(`📋 전체 ${rows.length}개 행 조회 완료\n`);

  // 2. 업무명 기준 그룹핑
  const groups = new Map();
  for (const row of rows) {
    const 업무명 = propText(row.properties['업무명']);
    if (!업무명) continue;
    if (!groups.has(업무명)) groups.set(업무명, []);
    groups.get(업무명).push(row);
  }

  let syncCount = 0;
  let rowCount = 0;

  // 3. 각 그룹 동기화
  for (const [업무명, groupRows] of groups) {
    if (groupRows.length === 1) continue;

    // 가장 최근 수정된 행을 master로
    const master = [...groupRows].sort((a, b) =>
      new Date(b.last_edited_time) - new Date(a.last_edited_time)
    )[0];

    const mp = master.properties;
    const master일정코드 = propText(mp['일정코드']);
    const master카테고리 = mp['카테고리']?.select?.name || '';
    const master상태 = mp['상태']?.select?.name || '';

    const toUpdate = [];
    for (const row of groupRows) {
      if (row.id === master.id) continue;

      const p = row.properties;
      const cur일정코드 = propText(p['일정코드']);
      const cur카테고리 = p['카테고리']?.select?.name || '';
      const cur상태 = p['상태']?.select?.name || '';

      if (cur일정코드 === master일정코드 && cur카테고리 === master카테고리 && cur상태 === master상태) continue;

      const changes = [];
      if (cur일정코드 !== master일정코드) changes.push(`일정코드: "${cur일정코드}" → "${master일정코드}"`);
      if (cur카테고리 !== master카테고리) changes.push(`카테고리: "${cur카테고리}" → "${master카테고리}"`);
      if (cur상태 !== master상태) changes.push(`상태: "${cur상태}" → "${master상태}"`);
      toUpdate.push({ row, changes });
    }

    if (toUpdate.length === 0) {
      console.log(`[${업무명}] ✓ 일치`);
      continue;
    }

    const properties = {
      '일정코드': { rich_text: master일정코드 ? [{ type: 'text', text: { content: master일정코드 } }] : [] },
      '카테고리': { select: master카테고리 ? { name: master카테고리 } : null },
      '상태': { select: master상태 ? { name: master상태 } : null },
    };

    for (const { row } of toUpdate) {
      await withRetry(() => notion.pages.update({ page_id: row.id, properties }));
      rowCount++;
    }

    const changeDesc = toUpdate.flatMap(d => d.changes).filter((v, i, a) => a.indexOf(v) === i).join(', ');
    console.log(`[${업무명}] ${changeDesc} (${toUpdate.length}개 행 갱신)`);
    syncCount++;
  }

  console.log(`\n✅ 완료: ${syncCount}개 업무 동기화, ${rowCount}개 행 갱신`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
