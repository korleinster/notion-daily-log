// 일회성 마이그레이션: 장기업무 단일 DB → Tasks DB + Members DB 두 DB 구조
// 실행: set -o allexport && source .env && set +o allexport && node migrate-v2.js
// 확인 후 실행: node migrate-v2.js --execute
'use strict';

const { Client } = require('@notionhq/client');

['NOTION_TOKEN', 'WORKTASK_DB_ID', 'DAILY_LOG_PAGE_ID'].forEach(k => {
  if (!process.env[k]) { console.error(`❌ 환경변수 누락: ${k}`); process.exit(1); }
});

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const TASKS_DB_ID = process.env.WORKTASK_DB_ID;       // 기존 장기업무 DB (Tasks로 유지)
const OLD_DB_ID   = '382e60ccff0c81968726e03c3b978099'; // 고아 장기업무_태스크 DB
const DRY_RUN     = !process.argv.includes('--execute');

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

const propText = prop =>
  prop?.rich_text?.map(t => t.plain_text).join('') ||
  prop?.title?.map(t => t.plain_text).join('') || '';

async function main() {
  if (DRY_RUN) console.log('🔍 DRY RUN (변경 없음). 실행: node migrate-v2.js --execute\n');

  // 1. 기존 장기업무 DB 전체 조회
  console.log('📊 장기업무 DB 조회 중...');
  const rows = [];
  let cursor;
  while (true) {
    const res = await withRetry(() => notion.databases.query({
      database_id: TASKS_DB_ID,
      sorts: [{ property: '일정코드', direction: 'ascending' }],
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    }));
    rows.push(...res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  console.log(`  총 ${rows.length}개 행`);

  // 2. 업무명 기준 그룹핑 → 유니크 task 목록 + member 정보 분리
  const taskGroups = new Map();
  for (const row of rows) {
    const 업무명 = propText(row.properties['업무명']);
    if (!업무명) continue;
    if (!taskGroups.has(업무명)) taskGroups.set(업무명, []);
    taskGroups.get(업무명).push(row);
  }

  const masterRows = [];    // Tasks DB에 남길 유니크 행
  const duplicateIds = [];  // 아카이브할 중복 행
  const memberData = [];    // Members DB에 생성할 데이터

  for (const [, groupRows] of taskGroups) {
    // 최근 수정 행을 master로
    const master = [...groupRows].sort((a, b) =>
      new Date(b.last_edited_time) - new Date(a.last_edited_time))[0];
    masterRows.push(master);

    for (const row of groupRows) {
      const p = row.properties;
      const 담당자 = p['담당자']?.select?.name || '';
      const 역할 = (p['역할']?.multi_select || []).map(r => r.name);
      memberData.push({ taskId: master.id, 담당자, 역할 });
      if (row.id !== master.id) duplicateIds.push(row.id);
    }
  }

  const memberDataFiltered = memberData.filter(m => m.담당자);

  console.log(`\n📋 유니크 업무: ${masterRows.length}개`);
  console.log(`👥 담당자 행: ${memberDataFiltered.length}개`);
  console.log(`🗑  중복 행 (삭제 예정): ${duplicateIds.length}개`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] 실행 시 수행될 작업:');
    console.log(`  1. 장기업무_태스크 DB (${OLD_DB_ID}) 아카이브`);
    console.log(`  2. 장기업무 DB: 중복 행 ${duplicateIds.length}개 아카이브`);
    console.log(`  3. 장기업무 DB: 담당자/역할 컬럼 제거`);
    console.log(`  4. Members DB 신규 생성 → relation 설정`);
    console.log(`  5. Members DB에 ${memberDataFiltered.length}개 행 생성`);
    console.log(`  6. Members DB에 rollup 컬럼 추가 시도 (실패 시 수동 안내)`);
    console.log('\n--execute 플래그로 실행하세요.');
    return;
  }

  // ── EXECUTE MODE ─────────────────────────────────────────────────

  // Step 1: 고아 장기업무_태스크 아카이브
  console.log('\n🗑  고아 DB (장기업무_태스크) 아카이브 중...');
  try {
    await withRetry(() => notion.pages.update({ page_id: OLD_DB_ID, archived: true }));
    console.log('  ✅ 완료');
  } catch (e) {
    console.log(`  ⚠️  실패 (권한 부족, Notion에서 수동 삭제 필요): ${e.message}`);
  }

  // Step 2: 중복 행 아카이브
  console.log(`\n🗑  중복 행 ${duplicateIds.length}개 아카이브 중...`);
  for (let i = 0; i < duplicateIds.length; i++) {
    await withRetry(() => notion.pages.update({ page_id: duplicateIds[i], archived: true }));
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${duplicateIds.length}...`);
  }
  console.log(`  ✅ ${duplicateIds.length}개 완료`);

  // Step 3: 장기업무 DB에서 담당자/역할 컬럼 제거 (Tasks DB로 단순화)
  console.log('\n🔧 Tasks DB 스키마 정리 (담당자/역할 컬럼 제거)...');
  await withRetry(() => notion.databases.update({
    database_id: TASKS_DB_ID,
    properties: { '담당자': null, '역할': null },
  }));
  console.log('  ✅ 완료');

  // Step 4: Members DB 생성
  console.log('\n🆕 Members DB (장기업무_담당자) 생성 중...');
  const membersDb = await withRetry(() => notion.databases.create({
    parent: { type: 'page_id', page_id: process.env.DAILY_LOG_PAGE_ID },
    title: [{ type: 'text', text: { content: '📊 장기업무_담당자' } }],
    properties: {
      '담당자': { title: {} },
      '업무':  { relation: { database_id: TASKS_DB_ID, single_property: {} } },
      '역할':  { multi_select: { options: [] } },
    },
  }));
  const MEMBERS_DB_ID = membersDb.id;
  console.log(`  ✅ 완료: ${MEMBERS_DB_ID}`);

  // Step 5: Rollup 컬럼 추가 시도
  console.log('\n🔧 Rollup 컬럼 추가 시도...');
  try {
    await withRetry(() => notion.databases.update({
      database_id: MEMBERS_DB_ID,
      properties: {
        '일정코드_rollup': {
          rollup: {
            relation_property_name: '업무',
            rollup_property_name: '일정코드',
            function: 'show_original',
          },
        },
        '상태_rollup': {
          rollup: {
            relation_property_name: '업무',
            rollup_property_name: '상태',
            function: 'show_original',
          },
        },
      },
    }));
    console.log('  ✅ Rollup 컬럼 추가 완료');
  } catch (e) {
    console.log(`  ⚠️  Rollup API 미지원: ${e.message}`);
    console.log('  → Notion UI에서 수동 추가 필요 (Step 7 참고)');
  }

  // Step 6: Members 행 생성
  console.log(`\n👥 Members 행 ${memberDataFiltered.length}개 생성 중...`);
  let created = 0;
  for (const { taskId, 담당자, 역할 } of memberDataFiltered) {
    await withRetry(() => notion.pages.create({
      parent: { database_id: MEMBERS_DB_ID },
      properties: {
        '담당자': { title: [{ type: 'text', text: { content: 담당자 } }] },
        '업무':  { relation: [{ id: taskId }] },
        '역할':  { multi_select: 역할.map(name => ({ name })) },
      },
    }));
    created++;
    if (created % 10 === 0) console.log(`  ${created}/${memberDataFiltered.length}...`);
  }
  console.log(`  ✅ ${created}개 완료`);

  console.log('\n🎉 마이그레이션 완료!');
  console.log('\n📝 .env 업데이트:');
  console.log(`  WORKTASK_DB_ID=${TASKS_DB_ID}`);
  console.log(`  MEMBERS_DB_ID=${MEMBERS_DB_ID}`);
  console.log('\n📝 GitHub Secrets:');
  console.log(`  MEMBERS_DB_ID=${MEMBERS_DB_ID}  ← 추가`);
  console.log('\n📝 Notion 수동 작업:');
  console.log('  1. 📊 장기업무_담당자 DB에 Rollup 컬럼이 없으면 직접 추가:');
  console.log('     - 일정코드_rollup (업무 relation → 일정코드, show_original)');
  console.log('     - 상태_rollup (업무 relation → 상태, show_original)');
  console.log('  2. 📊 장기업무 DB 보드 뷰: 카드에 일정코드 속성 표시 + 일정코드 ASC 정렬');
  console.log('  3. 📊 장기업무_담당자 DB 보드 뷰 생성 (GROUP BY 담당자)');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
