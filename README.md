# ithome-ironman-publisher

「From (Unity) Game Dev to Orchestration of (Unity) Game Dev」系列的 content-to-publish 工具，參賽分類為 `Vibe Coding`。Day 001 以 AI Agent 自動發文作為第一個 orchestration 垂直應用；發文自動化是系列基礎設施與案例，不是全部 30 天的主題。工具以 TypeScript + Playwright 實作，不逆向、也不依賴未公開的 HTTP publish endpoint。

語意 selector 已通過本機 Chromium E2E fixture；標題、SimpleMDE／CodeMirror、圖片上傳／插入、Select2 tag 與發表下拉選單也已依你的 2026 iT 邦 editor diagnostics 校正。正式 publish 與公開頁驗證仍須以一次有人監看的 live run 作最終確認。

## Repository layout

```text
ithome-ironman-publisher/
├─ .agents/skills/             # Repo-local Agent routing and safety workflows
├─ .codex/config.toml          # Project-scoped MCP config; never contains the API key
├─ .github/                    # Repository workflows
├─ .pre-commit-config.yaml     # Standard pre-commit configuration
├─ articles/                   # day-NNN Markdown modules, images and publication receipts
├─ infra/
│  ├─ .env                     # Local runtime config; ignored by Git
│  ├─ .env.example             # Safe template
│  ├─ .auth/                   # Playwright storageState; ignored
│  ├─ diagnostics/             # Trace/screenshot/HTML; ignored
│  ├─ generated/               # Unselected Leonardo candidates; ignored
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
- `$ithome-article-illustrator`：透過 Leonardo 產生候選圖、人工選圖並保存 provenance。
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
IRONMAN_SERIES_TITLE=From (Unity) Game Dev to Orchestration of (Unity) Game Dev
IRONMAN_CATEGORY=Vibe Coding
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
REPOSITORY_ROOT=../..
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
   ├─ ref-image-001.png
   └─ publication.json         # 發布成功後由程式產生並 commit
```

`day-NNN` 固定使用三位數。Day identity 由目錄名稱決定，不在 frontmatter 重複設定。

```markdown
---
title: Day 001：從 Unity Game Dev 到 Orchestration——先讓 Agent 接手發文流程
timestamp: "2026-09-01T10:17:00+08:00"
tags:
  - Unity
  - AI Agent
  - Vibe Coding
---

# 正文

![說明](./ref-image-001.png)
```

`timestamp` 是最早允許發布的時間，必須是帶秒數及明確 offset 的 RFC 3339。排程若提早執行會安全停止。建議加上引號，避免 YAML parser 改寫原始 offset。

相對圖片必須留在同一個 `day-NNN` 目錄，禁止使用 `../`。支援 PNG、JPEG、GIF、WebP 與 AVIF；HTTPS 圖片保留原 URL。本機圖片上傳後只替換送入 editor 的 Markdown，原始 `index.md` 不會被改寫。

`publication.json` 是公開文章的不可變發布收據，不是手寫 frontmatter。程式只在公開頁確認文章後建立，內容包含 iT 文章 ID、canonical URL、系列、發布時間，以及當時的 `sourceHash`／`renderedHash`。它必須留在對應的 `day-NNN` 目錄並由 Git 追蹤；相同 Day 若出現不同文章 ID，流程會停止，不會覆寫舊收據。

## Leonardo.Ai 生圖流程

Leonardo 的網站訂閱 token 與 API credits 是兩套額度。本專案不購買或使用 API credits，也不需要 API key；它只透過可見的 Microsoft Edge 操作 Leonardo Web，使用 Solo 方案原本的網站 token。流程不呼叫 undocumented HTTP／GraphQL endpoint、不讀取日常 Edge profile，也不使用 stealth 或 CAPTCHA 繞過。

`.codex/config.toml` 中的 `playwright-leonardo` 是 Microsoft Playwright MCP，僅用於 Agent 做只讀 UI 探勘與 selector 修復。真正可重複的生成、下載、診斷與 provenance 由本 repository 的 TypeScript CLI 負責。Leonardo 官方 MCP 需要 API credits，因此不是本方案的 runtime dependency。

Windows 首次登入：

```bash
task leonardo:auth
```

它會開啟獨立的 Edge profile。請自行完成 Facebook／其他第三方登入、二階段驗證或條款確認；程式不讀取或填寫帳密與驗證碼。登入完成並回到 `app.leonardo.ai` 後，session 會保存為 Git 忽略的 `infra/.auth/leonardo-storage-state.json`，日後不需每次登入。session 過期時重新執行同一命令即可。不要 commit、分享或上傳 `infra/.auth/`。

每張圖先建立一份可追蹤的 request JSON；Day 001 範例是：

```text
articles/day-001/images/prompts/agent-publishing-loop.json
```

零成本預覽只驗證 request、文章 Day 與設定，不開瀏覽器：

```bash
task leonardo:preview REQUEST=articles/day-001/images/prompts/agent-publishing-loop.json
```

明確要求真正生成時才執行：

```bash
task leonardo:generate REQUEST=articles/day-001/images/prompts/agent-publishing-loop.json
```

這個命令只按一次正常網頁的 Generate，可能消耗 Leonardo Web tokens。完成後會透過頁面上的 Download 控制下載最多 `maxCandidates` 張，並將 request、前後截圖、候選圖、尺寸、generation ID、來源頁與 SHA-256 寫到：

```text
infra/generated/day-NNN/<run-id>/
```

如果 UI 改版或 generation 逾時，失敗的 screenshot、HTML 與 trace 會放在 `infra/diagnostics/leonardo/`。可以先執行 `task leonardo:probe` 做不消耗 token 的 selector 診斷。

工作流刻意分成兩階段：

```text
index.md → Agent 設計 prompt → Leonardo 候選圖
                                  │
                         infra/generated/（忽略）
                                  │ 人工選定
                                  ▼
              articles/day-NNN/images/generated/<name>.png
                                  │
                         manifest.json + SHA-256
                                  │
                      images:check → content:check
                                  │
                          draft sync / publish
```

未採用候選圖留在 `infra/generated/`，不進 Git。選定候選圖後，先把建議的 Markdown reference 加入 `index.md`，再執行 promotion；例如：

```bash
task leonardo:promote RUN=C:/absolute/path/to/run.json CANDIDATE=1 NAME=agent-publishing-loop.jpg
```

`NAME` 的副檔名必須和候選檔一致。promotion 會拒絕覆寫不同檔案，驗證 run record 的 SHA-256，複製候選圖到 `articles/day-NNN/images/generated/`，建立或更新 `manifest.json`，最後重新驗證 Markdown reference 與 provenance。manifest 記錄 model、完整 prompt、尺寸、時間、可選 generation ID、alt text 與 SHA-256。只有不含簽章 query／credential 的穩定 URL 才會保留；遠端結果 URL 不能作為文章 source of truth。

```bash
task images:check DAY=2
task content:check
```

第一個命令只檢查指定 Day；第二個命令會檢查全部文章。manifest 中的每張圖都必須被 Markdown 引用，`images/generated/` 下被引用的圖也必須有 manifest，且實際檔案 SHA-256 必須一致。生圖不放進 launchd 或 `task publish`：它有成本且需要編輯判斷，排程只發布已審核、已落地、已驗證的本機資產。

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

正式發布還要求目前 branch 已設定 upstream、與 upstream 完全同步，且發文前 Git working tree 完全乾淨。程式會在網站 mutation 前先 `git fetch` 並執行 push dry-run；公開頁驗證成功後，建立 `articles/day-NNN/publication.json`，只 stage 這一個檔案，以 `chore(article): record Day NNN publication ID` commit，隨即執行 `git push`。dry-run 與 draft sync 都不會建立收據或 push。

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
- 從已驗證的公開 URL 解析文章 ID，建立不可變 `publication.json`，並立即 commit、push。
- 每天可排程兩次；第二次靠公開頁冪等檢查避免重複發文。

內容使用 canonical SHA-256：`sourceHash` 包含 frontmatter、Markdown 與本機圖片雜湊，`renderedHash` 代表替換 hosted image URL 後送入 editor 的內容。公開文章發布後若本機檔案有變更，`PUBLISHED_UPDATE_POLICY=report` 只會警告，不會自動改寫線上文章。

發布收據範例：

```json
{
  "version": 1,
  "dayNumber": 1,
  "articleId": "10406763",
  "articleUrl": "https://ithelp.ithome.com.tw/articles/10406763",
  "seriesUrl": "https://ithelp.ithome.com.tw/users/20107519/ironman/9242",
  "ironmanYear": 2026,
  "seriesTitle": "From (Unity) Game Dev to Orchestration of (Unity) Game Dev",
  "category": "Vibe Coding",
  "title": "Day 001：...",
  "publishedAt": "2026-09-01T02:17:00.000Z",
  "sourceHash": "...",
  "renderedHash": "..."
}
```

如果文章已公開，但 receipt 的 commit 或 push 失敗，**不要再次執行發布來補救**。先確認公開文章與本機 Day／標題相符，清理其他 Git 變更，再使用不會開瀏覽器、也不會重新發布的復原命令：

```bash
# runtime state 已保存 articleUrl
task publication:sync DAY=1

# runtime state 遺失時，人工提供已核對的 canonical URL
task publication:sync DAY=1 ARTICLE_URL=https://ithelp.ithome.com.tw/articles/10406763
```

這個命令會驗證 URL origin 與 `/articles/<ID>` 格式、建立或讀取既有 receipt，只 commit 該 receipt，然後 push。若 receipt 已 commit 但先前只有 push 失敗，它會直接重試 push。

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
| 10 | 文章可能已公開，但 publication receipt 的建立、commit 或 push 失敗；勿重發，使用 `publication:sync` |

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
