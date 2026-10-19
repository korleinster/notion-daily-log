# 📓 Notion Daily Log Bot

> Every morning, a Notion daily log is created automatically and your weather, calendar, and to-dos are sent through the configured notification backend.

**Notion Daily Log Bot** is a personal automation tool that runs every weekday morning via GitHub Actions.  
It creates a new daily log page in Notion (cloned from the previous day), fetches weather data and iCloud Calendar events, then sends a morning briefing through Telegram (the default), Slack, or both during a temporary transition — all without touching your computer.

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
| 🌤 **Weather info** | Fetches today's weather via Open-Meteo API (free, no key required) |
| 📆 **Calendar integration** | Shows today + next 3 days via iCloud CalDAV, supports recurring events |
| 📬 **Morning notifications** | Sends weather, schedule, and tasks to Telegram or the configured Slack routine channel |
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
│
├── 2026
│   └── 2026_06
│       └── 2026_06_16 (Tue)  ← dated backup (cloned from fixed page)
```

- User always works on the fixed page — no need to navigate to a new page each day
- Each morning: fixed page's personal section is backed up as a dated page, then completed todos and expired leave items are removed
- Completed to-dos and expired leave items are removed from the fixed page (not the backup)
- On weekends, no backup is created — only the configured morning notification is sent

---

## 🚀 First-Run Bootstrap

The script uses a single **fixed working page** as the source for all daily backups.

1. Create a page titled `📌 오늘의 업무` directly under the Daily Work Log root page
2. Add your personal section (todos, leave, backlog)
3. Set `FIXED_PAGE_ID` to this page's ID in `.env` and GitHub Secrets
4. From then on, the script will back up this page each morning and clean up completed todos and expired leave items

---

## 📬 Morning Message Format

The examples below show message content; both providers now receive safe plain text rather than Telegram HTML formatting. Successful morning summaries go to the Slack routine channel when Slack is selected. Execution failures go to the Slack alerts channel. A notification delivery failure fails the workflow but does not trigger a second, potentially duplicate message.

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
- Same structure, closing line changes to: `이미 백업이 있어서 일지 생성은 건너뛰고 다시 보내드렸어요~ 📋`

### Weekend run (no duplicate check)
- Weather + schedule only (no to-dos) + `푹 쉬고 충전하는 하루 되세요! 🌿`
- Always sends the same message regardless of duplicates

> ⚠️ GitHub Actions cron runs only on weekdays (Mon–Fri KST). Weekend messages are sent only on manual trigger.

### On error
```
😥 앗, 오늘 일지 작성 중에 문제가 생겼어요.

📅 {date}
❌ 자동화 실행 중 오류가 발생했어. 실행 상태를 확인해줘.

확인 부탁드려요!
```

---

## ⚙️ Environment Variables

### GitHub Secrets (used in Actions workflow)

| Variable | Description |
|--------|------|
| `NOTION_TOKEN` | Notion Integration token (notion.so/my-integrations) |
| `DAILY_LOG_PAGE_ID` | Daily log root page ID |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token; required only in `telegram` or `dual` mode |
| `TELEGRAM_CHAT_ID` | Telegram personal DM ID; required only in `telegram` or `dual` mode |
| `SLACK_BOT_TOKEN` | Slack bot token; required only in `slack` or `dual` mode; bot needs `chat:write` and access to both channels |
| `APPLE_ID` | Apple ID email (for iCloud Calendar; skipped if missing) |
| `APPLE_APP_PASSWORD` | Apple app-specific password (for iCloud Calendar; skipped if missing) |
| `FIXED_PAGE_ID` | Fixed working page ID (`📌 오늘의 업무`) — the page the user always works from |

### GitHub Variables (used in Actions workflow)

| Variable | Description |
|--------|------|
| `OPS_NOTIFICATION_BACKEND` | `telegram` (default), `slack`, or temporary `dual`; any other explicit value fails closed |
| `SLACK_ROUTINE_CHANNEL_ID` | Channel for successful morning summaries; required in `slack` or `dual` mode |
| `SLACK_ALERTS_CHANNEL_ID` | Channel for daily-workflow failures; required in `slack` or `dual` mode |

The notification adapter and corrective Revision 3 are implemented locally;
Notion's R3 scope independently passed QA (29 Python 3.12 uptime tests and 10
Node 22.23.3 notification tests). Overall R3 local acceptance is **BLOCKED** by
a separate Discord sanitizer finding. Protected Slack settings were provisioned
on 2026-10-15, but the current main branch (`7d81282`) still uses Telegram and
no Slack release is active. Slack delivery is therefore **not live**; this is
not a fully migrated or cutover system. R3 accepts only the exact trusted
workflow path forms `.github/workflows/macmini-uptime.yml`, `@main`, and
`@refs/heads/main`; all other provenance and artifact-integrity gates remain
enforced. Slack-only mode does not require Telegram credentials. Messages are
capped at 3,000 characters, neutralize Slack mentions, suppress unfurls, and do
not include raw service error responses or credentials. Unknown delivery
outcomes are not retried; HTTP 429 may receive one bounded retry.

The private workspace Slack app and protected settings are provisioned, but
the sender is not released or active on the current main branch. Before a
separately approved rollout, verify the app's existing access to the private
routine and alerts channels and its least-privilege `chat:write` permission;
do not add permissions or replace credentials as part of documentation work.
Keep credential values only in protected GitHub Actions Secrets, and channel
IDs and `OPS_NOTIFICATION_BACKEND` in GitHub Actions Variables. Never put
credential values in workflow YAML, committed files, logs, or test fixtures.
The existing Notion integration, its page access, daily page/task behavior,
and morning schedule are unchanged by the notification adapter.

The 2026-10-15 provisioning check found the required protected Slack settings
present; secret values were not read. Provisioning alone does not activate the
sender: the current main branch still uses Telegram, no Slack release is
active, and no 72-hour observation has started. Do not treat Notion as migrated
or cut over until the separately gated release and acceptance steps pass. Do
not create a replacement secret merely because older documentation described
the settings as absent.

The existing Notion integration, page access, daily page/task behavior, and
weekday schedule are unchanged. R3 passed 29/29 uptime tests on Python 3.12 and
10/10 notification cases on Node 22.23.3, with syntax and workflow checks.
These checks do not verify the real GitHub Ubuntu workflow or Slack receipt.
Live acceptance and any 72-hour observation have not begun.

### Local only (`.env` + pre-push hook)

| Variable | Description |
|--------|------|
| `GEMINI_API_KEY` | Gemini API key (for pre-push code review) |

Run the fake-only notification tests with `node --test tests/notifications.test.js`. Do not run the live daily workflow as a test of the transport change.

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
