// 일회성 마이그레이션 스크립트: 단일 DB → Tasks DB + Members DB (Relation 구조)
// 실행: set -o allexport && source .env && set +o allexport && node migrate-worktask.js [--dry-run]
'use strict';

const { Client } = require('@notionhq/client');

['NOTION_TOKEN', 'WORKTASK_DB_ID', 'DAILY_LOG_PAGE_ID'].forEach(k => {
  if (!process.env[k]) { console.error(`❌ 환경변수 누락: ${k}`); process.exit(1); }
});

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const MEMBERS_DB_ID = process.env.WORKTASK_DB_ID;    // 기존 장기업무 DB = 앞으로의 Members DB
const DAILY_LOG_PAGE_ID = process.env.DAILY_LOG_PAGE_ID;
const DRY_RUN = process.argv.includes('--dry-run');

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
  if (DRY_RUN) console.log('🔍 드라이런 모드 — Notion에 실제 변경 없음\n');

  // ── 1. 기존 Members DB 전체 행 조회 ─────────────────────────────────
  const memberRows = [];
  let cursor;
  while (true) {
    const res = await withRetry(() => notion.databases.query({
      database_id: MEMBERS_DB_ID,
      sorts: [{ property: '일정코드', direction: 'ascending' }],
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    }));
    memberRows.push(...res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  console.log(`📋 기존 행 ${memberRows.length}개 조회 완료\n`);

  // ── 2. 유니크 태스크 추출 (최신 수정 행 우선) ────────────────────────
  const taskMap = new Map(); // 업무명 → { 일정코드, 카테고리, 상태, last_edited_time }
  for (const row of memberRows) {
    const p = row.properties;
    const 업무명 = propText(p['업무명']);
    if (!업무명) continue;
    const existing = taskMap.get(업무명);
    if (!existing || row.last_edited_time > existing.last_edited_time) {
      taskMap.set(업무명, {
        일정코드: propText(p['일정코드']),
        카테고리: p['카테고리']?.select?.name || '',
        상태: p['상태']?.select?.name || '',
        last_edited_time: row.last_edited_time,
      });
    }
  }

  console.log(`📊 유니크 업무 ${taskMap.size}개 (Tasks DB에 생성 예정):`);
  for (const [업무명, { 일정코드, 상태 }] of taskMap) {
    console.log(`  [${상태 || '—'}] ${일정코드 ? 일정코드 + ' ' : ''}${업무명}`);
  }

  if (DRY_RUN) {
    console.log('\n✅ 드라이런 완료. --dry-run 없이 실행하면 위 내용으로 Tasks DB가 생성됩니다.');
    return;
  }

  // ── 3. Tasks DB 생성 (일일업무일지 루트 하위) ────────────────────────
  console.log('\n📦 Tasks DB 생성 중...');
  const tasksDb = await withRetry(() => notion.databases.create({
    parent: { type: 'page_id', page_id: DAILY_LOG_PAGE_ID },
    title: [{ type: 'text', text: { content: '📊 장기업무_태스크' } }],
    properties: {
      '업무명': { title: {} },
      '일정코드': { rich_text: {} },
      '카테고리': { select: { options: [] } },
      '상태': { select: { options: [] } },
    },
  }));
  const TASKS_DB_ID = tasksDb.id;
  console.log(`  Tasks DB 생성 완료: ${TASKS_DB_ID}`);

  // ── 4. Tasks DB에 행 추가 ─────────────────────────────────────────
  console.log('  태스크 행 추가 중...');
  const taskPageMap = new Map(); // 업무명 → Tasks DB page id
  for (const [업무명, { 일정코드, 카테고리, 상태 }] of taskMap) {
    const properties = {
      '업무명': { title: [{ type: 'text', text: { content: 업무명 } }] },
      '일정코드': { rich_text: 일정코드 ? [{ type: 'text', text: { content: 일정코드 } }] : [] },
    };
    if (카테고리) properties['카테고리'] = { select: { name: 카테고리 } };
    if (상태) properties['상태'] = { select: { name: 상태 } };

    const page = await withRetry(() => notion.pages.create({
      parent: { type: 'database_id', database_id: TASKS_DB_ID },
      properties,
    }));
    taskPageMap.set(업무명, page.id);
    console.log(`    ✓ ${업무명}`);
  }

  // ── 5. Members DB에 태스크 relation 컬럼 추가 ────────────────────────
  console.log('\n🔗 Members DB에 태스크 relation 컬럼 추가 중...');
  await withRetry(() => notion.databases.update({
    database_id: MEMBERS_DB_ID,
    properties: {
      '태스크': {
        type: 'relation',
        relation: {
          database_id: TASKS_DB_ID,
          type: 'single_property',
          single_property: {},
        },
      },
    },
  }));
  console.log('  relation 컬럼 추가 완료');

  // ── 6. 각 Members 행에 태스크 relation 연결 ──────────────────────────
  console.log('\n🔗 기존 행들에 태스크 relation 연결 중...');
  let linked = 0, skipped = 0;
  for (const row of memberRows) {
    const 업무명 = propText(row.properties['업무명']);
    const taskPageId = taskPageMap.get(업무명);
    if (!taskPageId) { skipped++; continue; }
    await withRetry(() => notion.pages.update({
      page_id: row.id,
      properties: { '태스크': { relation: [{ id: taskPageId }] } },
    }));
    linked++;
  }
  console.log(`  ${linked}개 연결, ${skipped}개 스킵`);

  // ── 7. 결과 출력 ─────────────────────────────────────────────────
  console.log('\n✅ 마이그레이션 완료!\n');
  console.log('📝 .env 업데이트 필요:');
  console.log(`  WORKTASK_DB_ID=${TASKS_DB_ID}`);
  console.log(`  MEMBERS_DB_ID=${MEMBERS_DB_ID}`);
  console.log('\n📝 GitHub Secrets 업데이트 필요:');
  console.log(`  WORKTASK_DB_ID → ${TASKS_DB_ID}`);
  console.log(`  MEMBERS_DB_ID  → ${MEMBERS_DB_ID} (신규 추가)`);
  console.log('\n📝 Notion에서 수동으로 할 일:');
  console.log('  1. Members DB에 Rollup 컬럼 추가 (태스크 관계 통해):');
  console.log('     - 일정코드_rollup (Tasks.일정코드)');
  console.log('     - 상태_rollup (Tasks.상태)');
  console.log('  2. 업무단위 칸반 뷰를 Tasks DB로 이동 (GROUP BY 상태)');
  console.log('  3. 기존 업무명/일정코드/카테고리/상태 컬럼은 Rollup 확인 후 제거 가능');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
