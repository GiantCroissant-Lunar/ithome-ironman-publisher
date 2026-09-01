# ithome-ironman-publisher

「30 天打造 Agent Development Editor/Environment（ADE）」系列的 content-to-publish 工具。Day 001 以 AI Agent 自動發文作為第一個垂直應用；發文自動化是系列基礎設施與案例，不是全部 30 天的主題。工具以 TypeScript + Playwright 實作，不逆向、也不依賴未公開的 HTTP publish endpoint。

目前語意 selector 已通過本機 Chromium E2E fixture，但**尚未在你的 2026 iT 邦 editor 完成校正**。正式使用前必須先執行 live draft sync，確認真實頁面 locator。

## Repository layout

```text
ithome-ironman-publisher/
├─ .agents/skills/             # Repo-local Agent routing and safety workflows
├─ .github/                    # Repository workflows
├─ .pre-commit-config.yaml     # Standard pre-commit configuration
├─ articles/                   # day-NNN Markdown modules and images
├─ infra/
│  ├─ .env                     # Local runtime config; ignored by Git
│  ├─ .env.example             # Safe template
│  ├─ .auth/                   # Playwright storageState; ignored
│  ├─ diagnostics/             # Trace/screenshot/HTML; ignored
│  ├─ logs/                    # launchd output; ignored
│  ├─ state/                   # Discovered URLs, hashes and process lock; ignored
│  └─ launchd/
├─ projects/
│  └─ publisher/
│     ├─ src/
│     ├─ test/
│     └─ package.json
├─ Taskfile.yml
└─ README.md
```

所有日常操作都從 repository root 使用 `task`，不需要手動切換到 Node project 目錄。

## Agent Skills 與 scripts 的責任邊界

Repo-local skills 位於 `.agents/skills/`。它們負責告訴 Agent **何時做、需要哪些證據、何時必須停止、哪種網站變更已獲授權**；不保存重複的 Playwright 實作。

| 放在 Agent Skill | 放在 TypeScript CLI／Task |
|---|---|
| 工作流路由、系列語境與內容判斷 | frontmatter 解析與路徑驗證 |
| 寫入／發布的授權界線 | SHA-256、runtime state 與 process lock |
| series identity 衝突的停止條件 | Playwright 導覽、selector 與 editor 操作 |
| diagnostics 證據的解讀與下一步 | screenshot、HTML、trace 與 structured logging |
| 是否可從 preview 升級為 mutation | draft save、publish click 與公開頁驗證 |

目前提供：

- `$ithome-article-author`：撰寫與驗證 `day-NNN` 文章。
- `$ithome-auth-session`：建立或修復 Edge storageState。
- `$ithome-site-discovery`：只讀探勘動態 URL 與 selector。
- `$ithome-draft-sync`：精準建立或更新一篇草稿，不發布。
- `$ithome-publish`：經明確授權後發布並從公開頁驗證。
- `$ithome-publish-diagnostics`：分析失敗，避免不安全重試。

瀏覽器與資料處理邏輯集中在 `projects/publisher/src/`，由 Taskfile 提供穩定 entrypoint。skills 不建立自己的 `scripts/` 副本，避免 selector、雜湊與安全鎖出現多套真值。Skill 結構驗證已整合進完整 quality gate，也可單獨執行：

```bash
task skills:check
```

## 安裝

需求：

- Node.js 20.19+、22.13+ 或 24+，建議使用偶數版 LTS。
- [Task](https://taskfile.dev/) 3.x。
- [pre-commit](https://pre-commit.com/) 4.x。

```bash
task setup
```

`task setup` 會安裝 locked Node dependencies、Playwright Chromium，以及標準 pre-commit hooks：

```bash
pre-commit install --install-hooks
```

基礎 hooks 會檢查 YAML、JSON、換行、大型檔案、merge marker 與 private key；本機 quality gate 會執行文章驗證、lint、typecheck、測試與 build。手動執行全部 hooks 可使用 `task pre-commit`。

## Runtime config

實際設定集中在 `infra/.env`，已由 `.gitignore` 排除。範例位於 `infra/.env.example`。

已依公開個人頁設定：

```env
ITHOME_PROFILE_URL=https://ithelp.ithome.com.tw/users/20107519
ITHOME_USER_IDENTIFIER=ApprenticeGC
IRONMAN_YEAR=2026
IRONMAN_SERIES_TITLE=30 天打造 Agent Development Editor/Environment（ADE）
```

公開個人頁 ID 是 `20107519`，顯示名稱／handle 為 `ApprenticeGC (apprenticegc)`。預設使用畫面上可見的 `ApprenticeGC` 作登入 identity；若實際 editor 導覽列顯示不同字串，再更新此欄位。

系列、草稿與新增文章 URL 不是第一篇發布前就一定存在的穩定設定，因此不使用假的 placeholder。程式會從公開個人頁及已登入導覽列發現 URL，驗證後寫入 `infra/state/publisher-state.json`：

```json
{
  "version": 1,
  "profileUrl": "https://ithelp.ithome.com.tw/users/20107519",
  "articles": {}
}
```

第一次發布前 `seriesUrl` 可以不存在。流程先用個人文章列表做冪等檢查；發布並確認文章後，再從文章頁發現使用者專屬系列 URL 並保存。`ITHOME_SERIES_URL`、`ITHOME_DRAFTS_URL`、`ITHOME_NEW_ARTICLE_URL` 仍可作人工覆寫，但不是必填值，也不應填暫代網址。

Runtime artifacts 也放在 `infra/`：

```env
AUTH_STATE_PATH=../../infra/.auth/storage-state.json
DIAGNOSTICS_DIR=../../infra/diagnostics
STATE_PATH=../../infra/state/publisher-state.json
LOCK_PATH=../../infra/state/publisher.lock
BROWSER_CHANNEL=msedge
```

這些路徑以 `projects/publisher/` 為 working directory。若要從其他位置啟動 CLI，可用 `ENV_FILE` 指定 `.env` 絕對路徑。

`.env` 不應保存網站密碼。`.auth/storage-state.json` 包含 cookie、localStorage 等登入憑證，權限等同已登入瀏覽器；不得 commit、上傳或分享。

## 文章與圖片

每篇文章是一個獨立 module：

```text
articles/
└─ day-001/
   ├─ index.md
   └─ ref-image-001.png
```

`day-NNN` 固定使用三位數。Day identity 由目錄名稱決定，不在 frontmatter 重複設定。

```markdown
---
title: Day 001：先讓 Agent 自己發文——ADE 的第一個自動化應用
timestamp: "2026-09-01T10:17:00+08:00"
tags:
  - AI Agent
  - Playwright
  - TypeScript
---

# 正文

![說明](./ref-image-001.png)
```

`timestamp` 是最早允許發布的時間，必須是帶秒數及明確 offset 的 RFC 3339。排程若提早執行會安全停止。建議加上引號，避免 YAML parser 改寫原始 offset。

相對圖片必須留在同一個 `day-NNN` 目錄，禁止使用 `../`。支援 PNG、JPEG、GIF、WebP 與 AVIF；HTTPS 圖片保留原 URL。本機圖片上傳後只替換送入 editor 的 Markdown，原始 `index.md` 不會被改寫。

repo 已提供可審稿的 `day-001` 正式文章與 PNG。離線驗證：

```bash
task content:check
```

## 登入、草稿與發布

首次人工登入：

```bash
task auth
```

程式預設會以 Playwright 開啟可見的 Microsoft Edge（`BROWSER_CHANNEL=msedge`、`HEADLESS=false`）。這是獨立的自動化 context，不會讀取日常 Edge profile；完成一次人工登入並確認帳號識別字可見後，在終端按 Enter，storageState 會存到 `infra/.auth/`。真實 iT 邦頁面曾對 headless Edge 回傳 403，因此目前不應在正式流程啟用 headless；本機 fixture 測試仍使用 bundled Chromium headless mode。

若有 CAPTCHA、二階段驗證或新版條款，請在人工登入步驟完成，不應撰寫繞過機制。

預覽 Day 1 會建立或更新哪一篇草稿，不修改網站：

```bash
task draft:preview DAY=1
```

只建立／更新草稿，不發布：

```bash
task draft:sync DAY=1
```

安全發布預覽：

```bash
task publish:dry
```

正式 scheduler entrypoint：

```bash
task publish
```

真正發布需要雙重解鎖：`infra/.env` 的 `PUBLISH_DRY_RUN=false`，而且 Task 會傳入 `--publish`。只要安全鎖仍為 `true`，`task publish` 仍是 dry-run。

## 冪等與安全條件

- 以 `Asia/Taipei` 計算當日與 Day N。
- 載入 `day-NNN/index.md`，驗證 timestamp、圖片與 source hash。
- 取得 process lock，避免每天兩次排程或人工操作同時修改同一篇草稿。
- 發布前先讀公開系列頁；確定今天沒有文章後才繼續。
- 同日已有其他文章、同標題出現在其他日期、公開日期無法完整解析，全部停止。
- 草稿不存在時建立，存在時更新；同標題草稿重複則停止。
- 圖片先上傳並取得 hosted URL，再填入完整 Markdown。
- 每張圖片以 SHA-256 判斷是否改變；未改變時沿用 runtime state 的 hosted URL。
- 儲存後讀回標題與 Markdown；不一致就不發布。
- 發布後重新讀公開系列頁；必須找到今天、同標題文章才算成功。
- 每天可排程兩次；第二次靠公開頁冪等檢查避免重複發文。

內容使用 canonical SHA-256：`sourceHash` 包含 frontmatter、Markdown 與本機圖片雜湊，`renderedHash` 代表替換 hosted image URL 後送入 editor 的內容。公開文章發布後若本機檔案有變更，`PUBLISHED_UPDATE_POLICY=report` 只會警告，不會自動改寫線上文章。

## Diagnostics 與 exit codes

錯誤使用單行 JSON structured log。失敗 artifacts 位於 `infra/diagnostics/<timestamp>/`：

- `failure.png`：全頁截圖。
- `failure.html`：失敗 DOM，可能含私人內容，不要 commit。
- `failure.json`：exit code、URL 與錯誤摘要。
- `trace.zip`：Playwright trace。

```bash
cd projects/publisher
npx playwright show-trace ../../infra/diagnostics/<timestamp>/trace.zip
```

| Code | 意義 |
|---:|---|
| 0 | 已發布、今日已發，或 dry-run 成功 |
| 2 | config、文章 frontmatter、圖片或參數錯誤 |
| 3 | 登入狀態遺失／過期 |
| 4 | 今天不在 Day 1～Day N，或 timestamp 尚未到達 |
| 5 | 冪等性或帳號／系列 identity 無法安全確認 |
| 6 | 精準草稿選擇失敗 |
| 7 | 頁面結構或瀏覽器工作流無法辨識 |
| 8 | 草稿／公開頁驗證失敗；先人工檢查，勿盲目重跑 |
| 9 | 未預期錯誤 |

## launchd：每天 10:17 與 20:47

範例位於 `infra/launchd/com.ithome.ironman-publisher.plist.example`。它從 repository root 執行 `task publish`，並把 stdout/stderr 寫到 `infra/logs/`。

1. 以 `command -v task` 取得 Task 絕對路徑。
2. 複製 plist 到 `~/Library/LaunchAgents/com.ithome.ironman-publisher.plist`。
3. 替換所有 `/ABSOLUTE/PATH/TO/...`。
4. 建立 `infra/logs/`，確認 `task publish:dry` 與一次有人監看的正式發布皆成功。
5. 以 `plutil -lint` 檢查，再用 `launchctl bootstrap gui/$UID ...` 啟用。

launchd 使用 Mac 本機時區；部署前確認為 `Asia/Taipei`。真正觸發時間以 plist 為準。

## 真實頁面校正

登入後，從 `projects/publisher/` 執行：

```bash
npx playwright codegen \
  --load-storage=../../infra/.auth/storage-state.json \
  "https://ithelp.ithome.com.tw/"
```

需逐一確認 `projects/publisher/src/site/locators.ts`：

1. 公開系列文章 card、標題、日期與零文章狀態。
2. 草稿 card、分頁與標題 link。
3. 新文章／草稿 editor 的標題、Markdown、標籤、圖片 input 與儲存草稿控制。
4. 圖片上傳後的 hosted URL 格式及草稿內容讀回值。
5. 發表選項、確認 dialog、成功 URL／toast 與公開頁延遲。
6. Session 過期 redirect 或其他可靠訊號。

優先使用 role、accessible name 與 `data-testid`。CSS class 或畫面位置只能作最後 fallback。

## 開發檢查

```bash
task check
```

目前包含日期、Day N、frontmatter、圖片路徑、content hash、冪等 workflow tests，以及會真的啟動 Chromium 的本機 fixture E2E：載入文章、上傳 PNG、建立草稿、發布、重新讀公開頁驗證。

## 規則提醒

目前**未確認 iT 邦幫忙／iThome 官方允許以瀏覽器自動化方式發文**。啟用前請自行查閱並遵守 2026 競賽規則、網站使用條款、流量限制與官方公告；若規則禁止，請停止使用。不要繞過 CAPTCHA、存取控制或反自動化措施，也不要高頻重試。
