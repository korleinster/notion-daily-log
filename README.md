# 📓 Notion Daily Log Bot

매일 아침 Notion에 일지를 자동 생성하고, 날씨 + 캘린더 일정 + 오늘의 할 일을 텔레그램으로 전송하는 자동화 봇입니다.

---

## 📁 레포 경로 (로컬)

```
/Users/leinster/Documents/Claude/Notion/notion-daily-log
```

---

## 🗂 Notion 구조

```
일일업무일지 (ROOT_PAGE_ID: 0a1501a086b945b1b84b7dfc8b44bf52)
└── 2026년
    └── 2026_04
        └── 2026_04_28 (화)   ← 일 페이지 (스크립트가 생성)
        └── 2026_04_29 (수)
        └── ...
```

- 이전 일 페이지를 복제해서 날짜만 바꿔 새 일 페이지 생성
- 각 일 페이지 안에 2컬럼 레이아웃 (왼쪽: 할 일, 오른쪽: 프로젝트 현황)
- 완료된(체크된) to_do 항목은 복사 제외
- 주말에는 일지 생성 없이 텔레그램 메시지만 전송

---

## 🚀 첫 실행 전 부트스트랩

스크립트는 **이전 일지를 복제**하는 방식으로 동작합니다. 최초 실행 전 Notion에 첫 번째 일지 페이지를 수동으로 만들어야 합니다.

1. Notion에서 `일일업무일지 > {년}년 > {년}_{월}` 페이지 경로 수동 생성
2. `{년}_{월}_{일} ({요일})` 형식으로 일 페이지 수동 생성 (예: `2026_05_20 (수)`)
3. 2컬럼 레이아웃(왼쪽: 할 일, 오른쪽: 프로젝트 현황) 직접 설정
4. 이후부터는 스크립트가 이 페이지를 기준으로 자동 복제

---

## 📬 텔레그램 메시지 구성

### 평일 최초 실행
```
🌅 좋은 아침이에요! 오늘도 화이팅입니다 😊

📅 2026년 04월 29일 수요일
🌤 구름 조금 / 기온 14°C / 바람 8km/h

📆 오늘 일정
• 14:00–15:00 팀 스프린트 리뷰

📅 다가오는 일정
• 4/30 (목) 10:00 디자인 싱크
• 5/1 (금) 일정 없음
• 5/2 (토) 일정 없음

📋 오늘의 할 일
• 기획서 검토
  • 세부 항목

오늘 하루도 잘 부탁드려요! 💪
```

### 평일 중복 실행
- 동일 메시지 + 마지막 문구: `이미 일지가 있어서 다시 한 번 보내드렸어요~ 📋`

### 주말 실행 (중복 체크 없음)
- 날씨 + 일정만 전송 (할 일 없음) + `푹 쉬고 충전하는 하루 되세요! 🌿`
- 중복 여부 관계없이 항상 같은 메시지 전송

> ⚠️ GitHub Actions cron은 평일(KST 월~금)만 자동 실행. 주말 메시지는 수동 트리거 시에만 전송됨.

### 에러 발생 시
```
😥 앗, 오늘 일지 작성 중에 문제가 생겼어요.

📅 {날짜}
❌ 오류 내용: {err.message}

확인 부탁드려요!
```

---

## ⚙️ 환경변수

### GitHub Secrets (Actions 워크플로우에서 사용)

| 변수명 | 설명 |
|--------|------|
| `NOTION_TOKEN` | Notion Integration 토큰 (notion.so/my-integrations) |
| `DAILY_LOG_PAGE_ID` | 일일업무일지 페이지 ID (`0a1501a086b945b1b84b7dfc8b44bf52`) |
| `TELEGRAM_BOT_TOKEN` | 텔레그램 봇 토큰 (@BotFather → /mybots) |
| `TELEGRAM_CHAT_ID` | 텔레그램 채널 ID (`-1003908956979`, "Leinster Daily" 채널) |
| `APPLE_ID` | Apple ID 이메일 (iCloud 캘린더 연동, 없으면 캘린더 섹션 생략) |
| `APPLE_APP_PASSWORD` | Apple 앱 암호 (iCloud 캘린더 연동, 없으면 캘린더 섹션 생략) |

### 로컬 전용 (`.env` + pre-push hook)

| 변수명 | 설명 |
|--------|------|
| `GEMINI_API_KEY` | Gemini API 키 (pre-push 코드 리뷰용) |
| `TELEGRAM_BOT_TOKEN` | 위와 동일 |
| `TELEGRAM_CHAT_ID` | 위와 동일 |

---

## 📦 주요 패키지

```json
{
  "@notionhq/client": "Notion API",
  "tsdav": "iCloud CalDAV 연동",
  "ical.js": "iCalendar 파싱"
}
```

---

## ⏰ GitHub Actions 워크플로우 (`daily-work-log.yml`)

- **자동 실행**: KST 월~금 오전 5시 (`cron: '0 20 * * 0-4'` UTC 기준)
  - UTC 일~목 20:00 = KST 월~금 05:00
  - 주말은 자동 실행 없음 — 수동 트리거 시 주말 로직 동작
- **Node.js 버전**: 20
- **수동 실행**: `gh workflow run daily-work-log.yml`
- **사용량 확인**: GitHub → Settings → Billing and plans

---

## 🔄 배포 방법

```bash
cd /Users/leinster/Documents/Claude/Notion/notion-daily-log
cp ~/Downloads/index.js ./index.js
# README 업데이트 후
git add . && git commit -m "커밋 메시지" && git push
```

> ⚠️ 배포 시 항상 README도 함께 업데이트할 것

---

## 🔧 Pre-push Hook 설치

레포를 새로 클론하면 `.git/hooks/`는 자동으로 복원되지 않음. 아래 절차로 설치:

```bash
# 1. pre-push 파일 생성 (아래 내용 붙여넣기)
cat > .git/hooks/pre-push << 'EOF'
#!/bin/bash
echo "🤖 Gemini 코드 리뷰 중..."
node .git/hooks/review.js
exit 0
EOF

# 2. 실행 권한 부여
chmod +x .git/hooks/pre-push

# 3. review.js 파일은 별도로 복사 (레포에 직접 포함되지 않음)
```

- `.env`에 `GEMINI_API_KEY` 설정 필요
- push 시 Gemini가 `index.js`를 리뷰하고 결과를 stdout으로 출력 (Claude 채팅창에 표시)

---

## 🌦 날씨 API

- **Open-Meteo** (무료, 키 불필요)
- 좌표: 성남시 (`LAT: 37.4449, LON: 127.1388`)

---

## 📅 캘린더

- **Apple iCloud CalDAV** 연동
- 오늘 + 앞으로 3일(총 4일) 일정 표시
- 반복 일정 지원
- `APPLE_ID` / `APPLE_APP_PASSWORD` 없으면 캘린더 섹션 생략 (에러 없음)
- GitHub Actions 실행 시에는 해당 env가 워크플로우에 미포함되어 항상 생략됨
