# notion-daily-log

## 프로젝트 개요
- **경로**: `/Users/leinster/Documents/Claude/Notion/notion-daily-log`
- **GitHub**: `korleinster/notion-daily-log`
- **런타임**: Node.js
- **목적**: 날씨, 캘린더 이벤트 등 일일 정보를 Notion에 자동 로깅

## 환경변수 (`.env` 필수)

### index.js (메인 스크립트)
- `NOTION_TOKEN` — Notion Integration 토큰
- `DAILY_LOG_PAGE_ID` — 일일업무일지 루트 페이지 ID (`0a1501a086b945b1b84b7dfc8b44bf52`)
- `FIXED_PAGE_ID` — 고정 작업 페이지 ID (`381e60ccff0c81e2a2dacc14f6fa0f76`, "📌 오늘의 업무")
- `TELEGRAM_BOT_TOKEN` — 텔레그램 봇 토큰
- `TELEGRAM_CHAT_ID` — 텔레그램 개인 DM ID (`5515513986`, notionDailyWorkLog 봇과의 개인 대화)
- `APPLE_ID` — Apple ID 이메일
- `APPLE_APP_PASSWORD` — Apple 앱 암호
- `WORKTASK_DB_ID` — Tasks DB ID (`9e80cbf822064d7dae69e6fbdbb6134c`, "📊 장기업무") — 업무 1개 = 행 1개
- `MEMBERS_DB_ID` — Members DB ID (`384e60ccff0c8189811de0b01b9b2825`, "📊 장기업무_담당자") — 담당자 1명 = 행 1개, 독립 댓글
- `BOARD_PAGE_ID` — 장기업무 보드 페이지 ID (`380e60ccff0c8121a545e0c5f7b9e233`)

### review.js (pre-push 코드리뷰)
- `GEMINI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID` (개인 DM ID, `5515513986`)

### workout-notify.js (운동 기록 알림 — README 미포함, 독립 스크립트)
- `NOTION_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `WORKOUT_PAGE_ID` (선택, 기본값 `372e60ccff0c8060b137e1b65779079b` 하드코딩)

## 핵심 파일
- `index.js` — 메인 로직
- `.github/workflows/daily-work-log.yml` — GitHub Actions 워크플로우 (KST 05:00, 평일만)
- `.git/hooks/pre-push` — bash 진입점
- `.git/hooks/review.js` — Gemini 코드리뷰 + Telegram 전송 로직

## Notion 구조

```
일일업무일지 (ROOT)
├── 📌 오늘의 업무  ← 고정 작업 페이지 (FIXED_PAGE_ID), 항상 이 페이지에서 작업
│     ├── 🔥 나의 업무 현황  (체크박스 / 연차 등 — 사용자가 직접 관리)
│     ├── ---
│     ├── 📋 오늘의 장기업무 현황  (매일 아침 자동 갱신)
│     └── 🔗 장기업무 보드 →
├── 2026년
│   └── 2026_06
│       ├── 2026_06_16 (화)  ← 날짜 백업 (고정 페이지 복제본)
│       └── ...
├── 📊 장기업무  (Tasks DB, WORKTASK_DB_ID) — 업무 1개 = 행 1개
│   (업무명, 일정코드, 카테고리, 상태)
│   └── 업무단위 보드  (GROUP BY 상태, SORT BY 일정코드 ASC)
│
└── 📊 장기업무_담당자  (Members DB, MEMBERS_DB_ID) — 담당자 1명 = 행 1개
    (담당자, 업무→relation, 역할, 일정코드_rollup, 상태_rollup)
    └── 담당자별 보드  (GROUP BY 담당자)
```

### 매일 아침 동작
- **최초 실행**: 고정 페이지 개인섹션 → 날짜 백업 생성 + 고정 페이지 완료항목 삭제 + 스냅샷 갱신
- **중복 실행**: 고정 페이지 스냅샷만 갱신 후 텔레그램 재전송

## index.js 주요 구현
- 시작 시 필수 환경변수 검증 (`REQUIRED_ENV` 목록)
- 날씨 + 캘린더 `Promise.all` 병렬 로딩
- `Intl.DateTimeFormat`으로 KST 날짜 계산 (서버 timezone 무관)
- `event.duration?.toSeconds?.()` null/메서드 안전성 처리
- `event.endDate?.toJSDate()` null 안전성 처리
- `withRetry` 헬퍼로 Notion API rate limit 대응 (최대 3회 재시도)
- `appendBlocksRecursive` 인덱스 안전성 (`Math.min` 사용)
- `collectTodos`에서 `UNSUPPORTED_TYPES` 블록 건너뜀
- Notion API로 일일 로그 페이지 생성/업데이트

### clearPersonalSection(fixedPageId, dateInfo)
- 고정 페이지의 개인 섹션(divider/📋 이전까지) 순회
- 체크된 할 일 → `notion.blocks.delete`
- 각 블록 자식을 `deleteCheckedTodosRecursive` 로 재귀 처리 (연차 자식은 만료 날짜 필터링 포함)

### refreshSnapshotInPage(fixedPageId)
- 고정 페이지에서 `divider` 또는 `📋` heading_2 이후 블록을 전부 삭제
- divider → `buildSnapshotSection` → `link_to_page` 순으로 재추가

### findPersonalBlocks(sourcePageId)
- 구 레이아웃(column_list): 첫 번째 컬럼의 블록 반환
- 신 레이아웃(flat): divider / link_to_page / `📋`로 시작하는 헤딩 이전까지의 블록 반환
- 두 레이아웃 모두 지원하므로 이전 일지에서도 정상 복사 가능

### buildSnapshotSection(dayPageId, tasksDbId, membersDbId)
- Tasks DB를 `일정코드` 오름차순으로 전체 조회 (업무 1개 = 행 1개)
- Members DB 전체 조회 (담당자 1명 = 행 1개, `업무` relation으로 Tasks와 연결)
- Members 행마다 `notion.comments.list({ block_id: row.id })` 호출 → 마지막 댓글을 per-person 업무현황으로 사용
- Tasks 기준 그룹 구성 → Members의 `업무` relation으로 담당자 연결
- 헤더 블록(`[상태] 일정코드 업무명`) append 후, 각 헤더에 담당자 서브 블록 추가
- `tasksDbId` 없으면 heading만 append하고 조기 반환
- `membersDbId` 없으면 담당자 없이 업무 목록만 표시 (graceful degradation)
- 댓글 API 사용: Notion 인테그레이션에 **Read comments + Insert comments** 권한 필요

## 연차 자동 처리
- 개인 섹션의 "연차" 블록 하위 항목을 복사 시 날짜 파싱
- `MMDD` 또는 `MMDD~MMDD` 형식에서 마지막 날짜 추출
- 마지막 날짜 < 오늘이면 해당 항목 제거 (체크된 할 일과 동일한 방식)
- `DD=00`은 해당 월의 마지막 날로 처리 (예: `0900` = 9월 말)
- 오전/오후 반차도 날짜 기준으로만 판단

## 장기업무 DB 구조 (두 DB)

### Tasks DB (`📊 장기업무`)
- DB ID: `9e80cbf822064d7dae69e6fbdbb6134c` (`WORKTASK_DB_ID`)
- 스키마: `업무명`(title), `일정코드`(rich_text), `카테고리`(select), `상태`(select)
- **업무 1개 = 행 1개** (기본 뷰에서 중복 없음)
- **일정코드/상태 변경 → 여기서만** → Members DB rollup 자동 반영
- 뷰: 업무단위 보드 (GROUP BY 상태, SORT BY 일정코드 ASC)

### Members DB (`📊 장기업무_담당자`)
- DB ID: `384e60ccff0c8189811de0b01b9b2825` (`MEMBERS_DB_ID`)
- 스키마: `담당자`(title), `업무`(relation→Tasks DB), `역할`(multi_select), `일정코드_rollup`(rollup 읽기전용), `상태_rollup`(rollup 읽기전용)
- **담당자 1명 = 행 1개** (한 업무에 N명이면 N개 행)
- 진행상황은 각 행의 **댓글**로 관리 → 매일 아침 스냅샷에서 마지막 댓글을 읽어 기록
- 뷰: 담당자별 보드 (GROUP BY 담당자, SORT BY 일정코드_rollup ASC)

### 편집 규칙
| 작업 | 위치 |
|------|------|
| 일정코드/카테고리/상태 변경 | Tasks DB (`장기업무`) |
| 업무현황 업데이트 | Members DB (`장기업무_담당자`) 각자 행에 댓글 |
| 새 업무 추가 | Tasks DB에 행 추가 → Members DB에서 담당자 배정 |

## Git Pre-push Hook
push 시 `index.js`를 Gemini가 자동 코드리뷰하고 결과를 Claude 채팅창에 출력
- 모델: `gemini-2.5-flash-lite` (free tier, 속도 최적화)
- bash hook에서 Node.js 파일 분리 (shell escaping 문제 회피)
- Telegram 전송 없음 — stdout으로만 출력 (Claude Bash 출력에 표시됨)

## 운동 기록 알림 (workout-notify.js)
- **README 미포함** — 개인 운동 기록용 독립 스크립트
- 운동 페이지 구조: 운동(root) → `{year}년` → `{year}년_{MM}` → **Notion Database** (`child_database`)
  - DB 이름: `운동기록` (ID: `1a3d24fc-9bca-444e-91ac-f6a55319669a`)
  - DB 스키마 (Notion properties 방식으로 접근):
    | 필드명 | 타입 | 비고 |
    |--------|------|------|
    | 날짜 | title | `M/D(요일)` 형식 (예: `6/1(월)`) |
    | 운동종류 | select | 사이클/런닝/웨이트/걷기/수영 |
    | 시간(분) | number | 숫자 (분 단위) |
    | 강도 | text | |
    | 평균BPM | number | |
    | 최고BPM | number | |
    | 칼로리 | number | |
    | 체중(kg) | number | |
    | 심박존분포 | text | |
    | 메모 | text | |
    | 트레이너피드백 | text | |
  - `notion.databases.query()` API로 데이터 조회 (`table_row` 방식 아님)
  - `propVal(prop)` 헬퍼로 title/rich_text/select/number 타입 통일 추출
- 상태 파일 `.workout-notify-state.json`: `{ "date": "2026-06-01", "count": 1 }` 구조
  - 날짜가 다르면 count 자동 리셋
  - GitHub Actions Cache에 `workout-state-{date}-{run_id}` 키로 저장
- 워크플로우 `workout-notify.yml`: KST 08:00~23:00 10분마다 실행 (`*/10 0-14,23 * * *` UTC)
- 새 행 감지 시 개인DM으로 알림 전송 (운동 종류/시간/강도/kcal/BPM/체중/트레이너 피드백 요약)
- 차트 삽입 기준: 기존 `image` 블록(캡션 `📊` 시작) 없으면 `child_database` 직전에 삽입


## Dead code (제거 가능)
- `findLatestDayPage(monthPageId)` — 이전 구조에서 소스 페이지를 탐색하던 함수. FIXED_PAGE_ID 구조로 전환 후 main()에서 호출되지 않음
- `findPrevMonthLatestDayPage(year, month)` — 동일 이유로 미사용
- `findFirstColumnList(pageId)` — 현재 `findPersonalBlocks` 내부에서 직접 처리하므로 미사용

## 주의사항
- Gemini는 Default Project 사용 (project-specific quota가 0일 수 있음)
- `gemini-2.5-flash`는 thinking 모드로 느림 → `flash-lite` 사용
- iCloud Drive 특성상 Git 명령이 hang할 수 있음 — 파일 로컬 가용 여부 먼저 확인
- README 수정 시 CLAUDE.md에도 반영 필요
- 워크플로우 파일은 `.github/workflows/daily-work-log.yml` 하나만 존재 (루트의 `daily-work-log.yml`은 삭제됨 — GitHub Actions는 `.github/workflows/`만 읽음)
- `sendTelegram`은 `ok: false` 응답 및 JSON 파싱 실패 시 reject 처리됨 (에러 조용히 무시하지 않음)
- Notion 인테그레이션에 **Read comments + Insert comments** 권한 필요 (notion.so/my-integrations → Capabilities)
