# Notion 일일업무일지 자동화

매일 KST 오전 7시에 Notion 일일업무일지 페이지에 오늘 날짜 섹션을 자동으로 추가합니다.

## 동작 방식

1. KST 기준 오늘 날짜 확인
2. `일일업무일지` 하위에 **년도 페이지** (`2026년`) 없으면 생성
3. 년도 페이지 하위에 **월 페이지** (`2026_05`) 없으면 생성
4. 가장 최근 날짜 섹션을 복사해서 오늘 날짜로 변경 후 맨 위에 추가
   - 월이 바뀐 경우 이전 월 페이지의 마지막 섹션을 복사
5. 오늘 섹션이 이미 있으면 중복 실행하지 않음

## GitHub Actions 설정 방법

### 1. 레포지토리 생성 및 파일 업로드

이 프로젝트를 GitHub 레포지토리에 업로드합니다.

```
notion-daily-log/
├── .github/
│   └── workflows/
│       └── daily-work-log.yml
├── index.js
├── package.json
└── README.md
```

### 2. Secrets 설정

GitHub 레포지토리 → Settings → Secrets and variables → Actions → New repository secret

| Secret 이름 | 값 |
|---|---|
| `NOTION_TOKEN` | Notion Integration 토큰 (secret_xxx...) |
| `DAILY_LOG_PAGE_ID` | 일일업무일지 페이지 ID |

### 3. 페이지 ID 확인 방법

Notion 페이지 URL에서 마지막 32자리 문자열이 페이지 ID입니다.
```
https://www.notion.so/일일업무일지-0a1501a086b945b1b84b7dfc8b44bf52
                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                  이 부분이 페이지 ID
```

### 4. 실행 확인

- 자동 실행: 매일 KST 오전 7시
- 수동 실행: GitHub Actions 탭 → Daily Work Log → Run workflow
