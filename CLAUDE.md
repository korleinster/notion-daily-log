# notion-daily-log

## 프로젝트 개요
- **경로**: `/Users/leinster/Documents/Claude/Notion/notion-daily-log`
- **GitHub**: `korleinster/notion-daily-log`
- **런타임**: Node.js
- **목적**: 날씨, 캘린더 이벤트 등 일일 정보를 Notion에 자동 로깅

## 환경변수 (`.env` 필수)

### index.js (메인 스크립트)
- `NOTION_TOKEN` — Notion Integration 토큰
- `DAILY_LOG_PAGE_ID` — 일일업무일지 페이지 ID (`0a1501a086b945b1b84b7dfc8b44bf52`)
- `TELEGRAM_BOT_TOKEN` — 텔레그램 봇 토큰
- `TELEGRAM_CHAT_ID` — 텔레그램 개인 DM ID (`5515513986`, notionDailyWorkLog 봇과의 개인 대화)
- `APPLE_ID` — Apple ID 이메일
- `APPLE_APP_PASSWORD` — Apple 앱 암호

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

## 연차 자동 처리
- 왼쪽 컬럼의 "연차" 블록 하위 항목을 복사 시 날짜 파싱
- `MMDD` 또는 `MMDD~MMDD` 형식에서 마지막 날짜 추출
- 마지막 날짜 < 오늘이면 해당 항목 제거 (체크된 할 일과 동일한 방식)
- `DD=00`은 해당 월의 마지막 날로 처리 (예: `0900` = 9월 말)
- 오전/오후 반차도 날짜 기준으로만 판단

## 마일스톤 담당자 현황
- 오른쪽 컬럼 복사 후 `scanMilestoneAssignees`로 담당자별 일감 수 집계
- `MILESTONE_RE = /^(\d{4,6}|미정)\s*[-–—]/` 패턴으로 마일스톤 식별
- 백로그 같은 카테고리 블록은 재귀 스캔으로 중첩 마일스톤도 집계
- 각 마일스톤 첫 번째 자식에서 `이름(역할), 이름(역할)` 파싱
- 일감 수 내림차순으로 정렬 후 `📊 담당자 현황` 블록으로 컬럼 하단에 추가
- 이전 날짜에서 복사 시 기존 `📊 담당자 현황` 블록은 자동 제외 후 새로 생성

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
- 워크플로우 `workout-notify.yml`: KST 08:00~23:00 매시간 실행 (`0 0-14,23 * * *` UTC)
- 새 행 감지 시 개인DM으로 알림 전송 (운동 종류/시간/강도/kcal/BPM/체중/트레이너 피드백 요약)
- 차트 삽입 기준: 기존 `image` 블록(캡션 `📊` 시작) 없으면 `child_database` 직전에 삽입

## 주의사항
- Gemini는 Default Project 사용 (project-specific quota가 0일 수 있음)
- `gemini-2.5-flash`는 thinking 모드로 느림 → `flash-lite` 사용
- iCloud Drive 특성상 Git 명령이 hang할 수 있음 — 파일 로컬 가용 여부 먼저 확인
- README 수정 시 CLAUDE.md에도 반영 필요
- 워크플로우 파일은 `.github/workflows/daily-work-log.yml` 하나만 존재 (루트의 `daily-work-log.yml`은 삭제됨 — GitHub Actions는 `.github/workflows/`만 읽음)
- `sendTelegram`은 `ok: false` 응답 및 JSON 파싱 실패 시 reject 처리됨 (에러 조용히 무시하지 않음)
