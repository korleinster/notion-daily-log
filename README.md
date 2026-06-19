# 📓 Notion Daily Log Bot

> Every morning, a Notion daily log is created automatically and your weather, calendar, and tasks are sent to Telegram.

**Notion Daily Log Bot** is a personal automation tool that runs every weekday morning via GitHub Actions.  
It creates a new daily log page in Notion (cloned from the previous day), fetches weather data and iCloud Calendar events, then sends a morning briefing to a Telegram personal DM — all without touching your computer.

[![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-automated-2088FF?logo=github-actions&logoColor=white)](https://github.com/features/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=github-sponsors)](https://github.com/sponsors/korleinster)

---

## ✨ Features

| Feature | Description |
|------|------|
| 📌 **Fixed working page** | User always works on the same page (`📌 오늘의 업무`); no need to navigate to a new page each day |
| 📄 **Daily backup** | Each morning, clones the fixed page's personal section into a dated backup page (year/month hierarchy) |
| 📋 **Long-term task snapshot** | Queries a permanent Notion DB each morning; reads the last comment on each row as the status and writes a snapshot into the daily log |
| 🗂 **Kanban board** | Permanent task DB with two board views (by status, by assignee), both sorted by schedule code |
| 🌤 **Weather info** | Fetches today's weather via Open-Meteo API (free, no key required) |
| 📆 **Calendar integration** | Shows today + next 3 days via iCloud CalDAV, supports recurring events |
| 📬 **Telegram notifications** | Sends weather, schedule, and tasks to your personal DM every morning |
| ⏰ **Fully automated** | Runs automatically on weekdays at 05:00 KST via GitHub Actions; manual trigger available |

---

## ☕ Sponsor

If this project has been useful, consider sponsoring. It makes a big difference for continued development!

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor_on_GitHub-%E2%9D%A4-ea4aaa?style=for-the-badge&logo=github-sponsors)](https://github.com/sponsors/korleinster)

---

## 🗂 Notion Structure

```
Daily Work Log (ROOT_PAGE_ID)
├── 📌 오늘의 업무          ← Fixed working page (FIXED_PAGE_ID) — always stay here
│     ├── 🔥 나의 업무 현황   (todos / leave — user manages directly)
│     ├── ---
│     ├── 📋 오늘의 장기업무 현황  (auto-refreshed every morning)
│     └── 🔗 장기업무 보드 →
│
├── 2026
│   └── 2026_06
│       └── 2026_06_16 (Tue)  ← dated backup (cloned from fixed page)
│
├── 📊 장기업무              ← Tasks DB (WORKTASK_DB_ID) — one row per TASK
│   (업무명, 일정코드, 카테고리, 상태)
│   └── 업무단위 보드  (GROUP BY 상태, SORT BY 일정코드 ASC)
│
└── 📊 장기업무_담당자       ← Members DB (MEMBERS_DB_ID) — one row per PERSON per task
    (담당자, 업무→relation, 역할, 일정코드_rollup, 상태_rollup)
    └── 담당자별 보드  (GROUP BY 담당자)
```

- User always works on the fixed page — no need to navigate to a new page each day
- Each morning: fixed page's personal section is backed up as a dated page, then completed todos are removed and the snapshot is refreshed
- Completed to-dos and expired leave items are removed from the fixed page (not the backup)
- On weekends, no backup is created — only the Telegram message is sent

---

## 🚀 First-Run Bootstrap

The script uses a single **fixed working page** as the source for all daily backups.

1. Create a page titled `📌 오늘의 업무` directly under the Daily Work Log root page
2. Add your personal section (todos, leave, backlog)
3. Set `FIXED_PAGE_ID` to this page's ID in `.env` and GitHub Secrets
4. From then on, the script will back up this page each morning and refresh its snapshot

### Long-term Task DB setup (one-time via migration script)

Two databases are required. Run `migrate-v2.js` to set them up automatically from existing data.

**Tasks DB (`📊 장기업무`)** — one row per task:
- Schema: `업무명` (title), `일정코드` (text), `카테고리` (select), `상태` (select)
- Board view: grouped by `상태`, sorted by `일정코드` ASC, with `일정코드` shown on cards
- `일정코드`/`상태` changes happen here only

**Members DB (`📊 장기업무_담당자`)** — one row per person per task:
- Schema: `담당자` (title), `업무` (relation → Tasks DB), `역할` (multi-select), `일정코드_rollup`, `상태_rollup`
- Board view: grouped by `담당자`, sorted by `일정코드_rollup` ASC
- Progress updates are tracked via **row-level comments** (read last comment per row as status)

**After running `migrate-v2.js --execute`**:
1. Manually add rollup columns to Members DB: `일정코드_rollup` and `상태_rollup` (via `업무` relation)
2. Add `MEMBERS_DB_ID` to GitHub Secrets and local `.env`
3. Enable **Read comments** and **Insert comments** on the Notion integration (notion.so/my-integrations)

---

## 📬 Telegram Message Format

### Weekday (first run)
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
• 제안서 검토
  • 서브 항목

오늘 하루도 잘 부탁드려요! 💪
```

### Weekday (duplicate run)
- Same structure, closing line changes to: `이미 백업이 있어서 스냅샷 갱신 후 다시 보내드렸어요~ 📋`

### Weekend run (no duplicate check)
- Weather + schedule only (no to-dos) + `푹 쉬고 충전하는 하루 되세요! 🌿`
- Always sends the same message regardless of duplicates

> ⚠️ GitHub Actions cron runs only on weekdays (Mon–Fri KST). Weekend messages are sent only on manual trigger.

### On error
```
😥 앗, 오늘 일지 작성 중에 문제가 생겼어요.

📅 {date}
❌ 오류 내용: {err.message}

확인 부탁드려요!
```

---

## ⚙️ Environment Variables

### GitHub Secrets (used in Actions workflow)

| Variable | Description |
|--------|------|
| `NOTION_TOKEN` | Notion Integration token (notion.so/my-integrations) |
| `DAILY_LOG_PAGE_ID` | Daily log root page ID |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (@BotFather → /mybots) |
| `TELEGRAM_CHAT_ID` | Telegram personal DM ID |
| `APPLE_ID` | Apple ID email (for iCloud Calendar; skipped if missing) |
| `APPLE_APP_PASSWORD` | Apple app-specific password (for iCloud Calendar; skipped if missing) |
| `WORKTASK_DB_ID` | Tasks DB ID (`📊 장기업무`) — one row per task, source of truth for 일정코드/상태 |
| `MEMBERS_DB_ID` | Members DB ID (`📊 장기업무_담당자`) — one row per person per task, holds progress comments |
| `BOARD_PAGE_ID` | Long-term task board page ID (linked at the bottom of the fixed page) |
| `FIXED_PAGE_ID` | Fixed working page ID (`📌 오늘의 업무`) — the page the user always works from |

### Local only (`.env` + pre-push hook)

| Variable | Description |
|--------|------|
| `GEMINI_API_KEY` | Gemini API key (for pre-push code review) |
| `TELEGRAM_BOT_TOKEN` | Same as above |
| `TELEGRAM_CHAT_ID` | Same as above |

---

## 📦 Key Packages

```json
{
  "@notionhq/client": "Notion API",
  "tsdav": "iCloud CalDAV integration",
  "ical.js": "iCalendar parsing"
}
```

---

## ⏰ GitHub Actions Workflow (`daily-work-log.yml`)

- **Auto run**: Mon–Fri at 05:00 KST (`cron: '0 20 * * 0-4'` in UTC)
  - UTC Sun–Thu 20:00 = KST Mon–Fri 05:00
  - No automatic run on weekends — weekend logic runs only on manual trigger
- **Node.js version**: 22
- **Manual run**: `gh workflow run daily-work-log.yml`
- **Usage stats**: GitHub → Settings → Billing and plans

---

## 🔄 Deployment

```bash
git add . && git commit -m "commit message" && git push
```

> ⚠️ Always update the README when deploying

---

## 🔧 Pre-push Hook Setup

The `.git/hooks/` directory is not restored automatically when re-cloning. Set it up with these steps:

```bash
# 1. Create the pre-push file (paste content below)
cat > .git/hooks/pre-push << 'EOF'
#!/bin/bash
echo "🤖 Running Gemini code review..."
node .git/hooks/review.js
exit 0
EOF

# 2. Make it executable
chmod +x .git/hooks/pre-push

# 3. Copy review.js separately (not included directly in the repo)
```

- Requires `GEMINI_API_KEY` set in `.env`
- On push, Gemini reviews `index.js` and outputs the result to stdout

---

## 🌦 Weather API

- **Open-Meteo** (free, no key required)
- Coordinates: configured in the script

---

## 📅 Calendar

- **Apple iCloud CalDAV** integration
- Shows today + next 3 days (4 days total)
- Supports recurring events
- Calendar section is gracefully skipped if `APPLE_ID` / `APPLE_APP_PASSWORD` are not set (no error)
- Always skipped in GitHub Actions runs since those env vars are not included in the workflow
