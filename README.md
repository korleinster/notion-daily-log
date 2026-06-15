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
| 📄 **Auto Notion daily log** | Clones the previous day's personal section (todos, leave) to create a new daily page |
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
└── 2026
    └── 2026_06
        └── 2026_06_15 (Mon)   ← daily page (created by script)
            ├── 🔥 나의 업무 현황  (personal section: todos / leave / backlog)
            ├── ---
            ├── 📋 오늘의 장기업무 현황  (auto-generated snapshot)
            │       • [진행중] 260701 신념의 탑 3층
            │           • 임재호 (보스): 보스 추가 수정중
            │           • 우양권 (레벨): 스포너 배치중
            └── 🔗 장기업무 보드  (link to the Kanban page)

📊 장기업무 (permanent, separate page)
    ├── 뷰1: 업무단위 보드  (GROUP BY 상태)
    └── 뷰2: 담당자별 보드  (GROUP BY 담당자)
```

- Daily page clones only the personal section from the previous day (not the snapshot)
- Completed to-dos and expired leave items are excluded from the copy
- The snapshot is generated fresh each morning from the long-term task DB
- On weekends, no log is created — only the Telegram message is sent

---

## 🚀 First-Run Bootstrap

The script works by **cloning the personal section from the previous daily log**. Before the first run, you need to manually create the first page in Notion.

1. Manually create the page path in Notion: `Daily Work Log > {Year} > {Year}_{Month}`
2. Manually create a daily page in the format `{Year}_{Month}_{Day} ({Weekday})` (e.g. `2026_05_20 (Wed)`)
3. Add your personal section at the top (todos, leave, backlog)
4. From then on, the script will auto-clone only the personal section each day

### Long-term Task DB setup (one-time)

1. Create a `📊 장기업무` page in your Daily Work Log root
2. Create a Notion database inside with this schema:
   - `업무명` (title), `일정코드` (text), `카테고리` (select), `상태` (select), `담당자` (select), `역할` (multi-select)
   - Progress updates are tracked via **row-level comments** (no separate status column)
3. Add two board views: grouped by `상태` and by `담당자`, both sorted by `일정코드` ASC
4. Add `WORKTASK_DB_ID` and `BOARD_PAGE_ID` to GitHub Secrets and local `.env`
5. Enable **Read comments** and **Insert comments** capabilities on the Notion integration (notion.so/my-integrations → Capabilities)

---

## 📬 Telegram Message Format

### Weekday (first run)
```
🌅 Good morning! Have a great day 😊

📅 Wednesday, April 29, 2026
🌤 Partly Cloudy / 14°C / Wind 8 km/h

📆 Today's Schedule
• 14:00–15:00 Team Sprint Review

📅 Upcoming Events
• 4/30 (Thu) 10:00 Design Sync
• 5/1 (Fri) No events
• 5/2 (Sat) No events

📋 Today's To-Dos
• Review proposal
  • Sub-item

Have a wonderful day! 💪
```

### Weekday (duplicate run)
- Same message + closing line: `Log already existed — sending it again 📋`

### Weekend run (no duplicate check)
- Weather + schedule only (no to-dos) + `Have a restful, recharging day! 🌿`
- Always sends the same message regardless of duplicates

> ⚠️ GitHub Actions cron runs only on weekdays (Mon–Fri KST). Weekend messages are sent only on manual trigger.

### On error
```
😥 Oops, something went wrong while creating today's log.

📅 {date}
❌ Error: {err.message}

Please check!
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
| `WORKTASK_DB_ID` | Long-term task DB ID (for daily snapshot; reads last comment per row) |
| `BOARD_PAGE_ID` | Long-term task board page ID (linked at the bottom of each daily page) |

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
