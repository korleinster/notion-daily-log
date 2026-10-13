# notion-daily-log — current operating note

The current operator-facing setup and notification contract is in
[`README.md`](./README.md); the external heartbeat/uptime monitor and its
Revision 2 artifact-state behavior are in
[`docs/UPTIME-MONITOR.md`](./docs/UPTIME-MONITOR.md). Treat older implementation
notes below as historical where they conflict with those current guides.

Slack corrective Revision 2 was approved for direct local execution and is
historically implemented locally; Revision 3 was approved for direct local
execution on 2026-10-12. Its path correction and docs passed independent QA:
29 Python 3.12 uptime tests and 10 Node 22.23.3 notification tests. Overall R3
local acceptance is **BLOCKED** by a separate Discord sanitizer regression.
Revision 4 is approved but not yet implemented. Nothing is provisioned,
deployed, or activated. Preserve the existing Notion integration, page/task
behavior, and schedule. The last read-only GitHub provisioning check was
2026-09-30 and found required Slack settings absent; no values were read and no
recheck has been made.

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

### review.js (pre-push 코드리뷰)
- `GEMINI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID` (개인 DM ID, `5515513986`)

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
│
├── 2026년
│   └── 2026_06
│       ├── 2026_06_16 (화)  ← 날짜 백업 (고정 페이지 복제본)
│       └── ...
```

### 매일 아침 동작
- **최초 실행**: 고정 페이지 개인섹션 → 날짜 백업 생성 + 고정 페이지 완료항목 삭제
- **중복 실행**: 새 백업 없이 텔레그램 재전송

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

### findPersonalBlocks(sourcePageId)
- 구 레이아웃(column_list): 첫 번째 컬럼의 블록 반환
- 신 레이아웃(flat): divider / link_to_page / child_database / `📋`로 시작하는 헤딩 이전까지의 블록 반환
- 두 레이아웃 모두 지원하므로 이전 일지에서도 정상 복사 가능

## 연차 자동 처리
- 개인 섹션의 "연차" 블록 하위 항목을 복사 시 날짜 파싱
- `MMDD` 또는 `MMDD~MMDD` 형식에서 마지막 날짜 추출
- 마지막 날짜 < 오늘이면 해당 항목 제거 (체크된 할 일과 동일한 방식)
- `DD=00`은 해당 월의 마지막 날로 처리 (예: `0900` = 9월 말)
- 오전/오후 반차도 날짜 기준으로만 판단

## Git Pre-push Hook
push 시 `index.js`를 Gemini가 자동 코드리뷰하고 결과를 Claude 채팅창에 출력
- 모델: `gemini-2.5-flash-lite` (free tier, 속도 최적화)
- bash hook에서 Node.js 파일 분리 (shell escaping 문제 회피)
- Telegram 전송 없음 — stdout으로만 출력 (Claude Bash 출력에 표시됨)

## Dead code (제거 가능)
- `findLatestDayPage(monthPageId)` — 이전 구조에서 소스 페이지를 탐색하던 함수. FIXED_PAGE_ID 구조로 전환 후 main()에서 호출되지 않음
- `findPrevMonthLatestDayPage(year, month)` — 동일 이유로 미사용
- `findFirstColumnList(pageId)` — 현재 `findPersonalBlocks` 내부에서 직접 처리하므로 미사용

## 주의사항
- Gemini는 Default Project 사용 (project-specific quota가 0일 수 있음)
- `gemini-2.5-flash`는 thinking 모드로 느림 → `flash-lite` 사용
- iCloud Drive 특성상 Git 명령이 hang할 수 있음 — 파일 로컬 가용 여부 먼저 확인
- README 수정 시 CLAUDE.md에도 반영 필요
- Notion 저장소에는 `.github/workflows/daily-work-log.yml`(일일 작업)과 `.github/workflows/macmini-uptime.yml`(외부 감시) 워크플로우가 있다. 일일 작업의 기존 스케줄과 페이지 동작은 유지한다.
- `sendTelegram`은 `ok: false` 응답 및 JSON 파싱 실패 시 reject 처리됨 (에러 조용히 무시하지 않음)
