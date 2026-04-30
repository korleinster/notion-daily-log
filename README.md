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
- 주말에는 일지 생성 없이 마커 페이지만 생성

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

📋 오늘의 할 일
• 기획서 검토
  • 세부 항목

오늘 하루도 잘 부탁드려요! 💪
```

### 평일 중복 실행
- 동일 메시지 + 마지막 문구: `이미 일지가 있어서 다시 한 번 보내드렸어요~ 📋`

### 주말 최초 실행
- 날씨 + 일정만 전송 (할 일 없음) + `푹 쉬고 충전하는 하루 되세요! 🌿`

### 주말 중복 실행
- 날씨 + 일정만 전송 + `이미 보내드렸는데 다시 한 번 보내드렸어요~ 😄`

---

## ⚙️ 환경변수 (GitHub Secrets)

| 변수명 | 설명 |
|--------|------|
| `NOTION_TOKEN` | Notion Integration 토큰 (notion.so/my-integrations) |
| `DAILY_LOG_PAGE_ID` | 일일업무일지 페이지 ID (`0a1501a086b945b1b84b7dfc8b44bf52`) |
| `TELEGRAM_BOT_TOKEN` | 텔레그램 봇 토큰 (@BotFather → /mybots) |
| `TELEGRAM_CHAT_ID` | 텔레그램 챗 ID (`5515513986`) |
| `APPLE_ID` | Apple ID 이메일 (`leinster92@gmail.com`) |
| `APPLE_APP_PASSWORD` | Apple 앱 암호 (appleid.apple.com에서 발급) |

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

## ⏰ GitHub Actions 스케줄

- **매일 KST 오전 7시** 자동 실행 (평일 + 주말)
- 수동 실행: `gh workflow run daily-work-log.yml`
- 사용량 확인: GitHub → Settings → Billing and plans

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

## 🌦 날씨 API

- **Open-Meteo** (무료, 키 불필요)
- 좌표: 성남시 (`LAT: 37.4449, LON: 127.1388`)

---

## 📅 캘린더

- **Apple iCloud CalDAV** 연동
- 오늘 + 앞으로 3일(총 4일) 일정 표시
- 반복 일정 지원
- 환경변수 없으면 캘린더 섹션 생략 (에러 없음)
