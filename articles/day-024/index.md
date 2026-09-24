---
title: Day 024：Agent 開工前要帶什麼——Jupiter 如何配發 MCP 與 Skills
timestamp: "2026-09-24T20:47:00+08:00"
tags:
  - AI Agent
  - MCP
  - Agent Development Environment
---

# Agent 開工前要帶什麼：Jupiter 如何配發 MCP 與 Skills

Day 023 記錄 Jupiter 承接真實開發工作後，Sessions 暴露的核准、transcript 與用量問題。今天往前看一步：在第一個 prompt 送出之前，這個 Agent 到底拿到了什麼？

先前 Adapter 建立 ACP session 時，送出的 `mcpServers` 固定是空陣列。Jupiter 能啟動 CLI，卻還沒有把 ADE 配置的 MCP servers 與 Bundle 裡的 Skills 一起交給它。CLI 原本自己的設定可能仍然有效，但那不是 Jupiter 這次配發的內容。

9 月 24 日合入的 session context 補上這條路。既有 live review 記錄，一個真正的 Claude Code session 收到 `probe` server，呼叫 `mcp__probe__probe` 得到 `probe answered`，也載入了被放進 workspace 的 `probe-skill`。

今天要拆開看：工具入口從哪裡來、Skill 由誰寫入，以及什麼證據足以說明它們真的到達了 Agent。

## 從空的 mcpServers，走到可核對的開工環境

這次新增的 Host interface 叫 `session-context`，兩個操作共用 `session-context:provision` permission：

| 操作 | Host 負責的事 |
|---|---|
| `servers(agent)` | 從 policy 找出可配發給這個 Agent 的 MCP aliases |
| `place-skills(cwd, sink)` | 把已安裝 Bundle 的 Skill 檔案放進指定工作目錄 |

Sessions 在建立 session 時呼叫它們，再把結果交給 Adapter：

```text
Station policy 與已安裝的 Bundles
→ Host 解析可用 servers、驗證並放置 Skills
→ Sessions 保存來源與處理結果
→ Adapter 送出 ACP session/new
→ CLI 使用自己的 MCP client 與 Skill 載入機制
```

這裡有兩種不同的資料。

MCP server 描述可連線的工具入口；Skill 則說明在這個專案裡，何時及如何使用工具。一個 server 可以不需要額外 Skill，一份 Skill 也不等於取得 server 的使用權限。

Session record 保存配發的 alias 名稱，以及 Skill 的 bundle、revision、name。Transcript 則留下配發成功、放置失敗或未知 Skill 目錄的 system entry，讓後續 review 能看到工作從什麼環境開始。

## MCP Alias 決定提供什麼，CLI 負責連線

Policy 增加 `servers` table，每個 alias 描述 transport、consumers、exposure 等設定。

目前 `consumers.sessions` 放的是 Sessions 裡的 **agent ID**，例如 `claude-opus` 或 `opencode`。Execution profiles 尚未接入這裡，所以不能把這個欄位解讀成已完成的 profile 授權模型。

測試用同一個 Host、同一個 `probe` alias，比較兩個 sessions：列在 consumers 裡的 Agent 收到 `probe`，另一個收到空清單。這證明本次配發有依 Agent 過濾；它沒有替 CLI 原本從其他設定取得的工具做總盤點。

Alias 還需要可用的底層設定。Stdio server 指向 program alias，HTTP server 指向 origin alias；設定遺失時，Host 略過它並記錄原因。Stdio program 另須標為 `trusted full`，因為接下來是 CLI 自己啟動 server，不能假設它會套用 Station 原本的 confined process 路徑。

Adapter 再把 Host 的資料轉成這次驗證過的 ACP 形狀：

| Transport | `session/new` 裡的內容 |
|---|---|
| Stdio | `name`、`command`、`args`、空的 `env` |
| HTTP | `type: "http"`、`name`、`url`、空的 `headers` |

HTTP 還會檢查 Agent 握手時是否宣告支援；不支援就不傳入，並留下 note。

這次刻意沒有將 credential value 放進這兩個陣列。Stdio server 若需要環境變數，必須由啟動 **Agent process** 的 program 設定允許繼承，再由它傳給子程序；配發紀錄只描述變數名稱。

需要 bearer 的 HTTP origin 則先不配發。因為這次固定的 ACP schema 要求 header 同時帶 name 與 value，省略 value 無法完成驗證，填入 value 又會把 credential 帶進 session request。這個情況留下拒絕原因，等待後續的 proxy 或其他 credential 傳遞機制。

目前走的是 pass-through：CLI 直接連到 MCP server，Station 負責準備清單。Policy 雖有 `tools` 欄位，這條路還沒有逐工具攔截與 enforcement；ADE 看到的是 CLI 回報的 tool-call updates。若要只開放 server 的部分工具，還需要後續的 proxy 與呼叫檢查。

## Skills 跟著 Bundle 交付，由 Host 放進工作目錄

Day 023 提到 Plugin 沒有一般 file-write capability，不能直接在 workspace 裡寫 `opencode.json`。這次 Skill 配發沒有擴張成任意檔案寫入，而是增加一個用途明確的 Host 操作。

Bundle v2 的 content 只要包含這類路徑，就能成為 Skill 來源：

```text
skills/probe-skill/SKILL.md
skills/probe-notes/SKILL.md
```

沒有新增 Skill 專用 manifest 欄位，也沒有依賴 v2 不存在的 resource `kind`。Host 從安裝紀錄中取得每個 Bundle 最後一份未列為 refused 的紀錄，找到 `skills/<name>/...`，讀取檔案並核對 manifest 裡的 digest 與 size。

Sessions 再依 program alias 選擇 Skill 的落地目錄。這份對照是本次 increment 對本機 CLI／bridge 核對後保存的結果：

| CLI 對應的 program aliases | Workspace 內的目錄 |
|---|---|
| `claude`、`claude-acp` | `.claude/skills` |
| `codex`、`codex-acp` | `.agents/skills` |
| `opencode`、`opencode-acp`、`opencode-omni` | `.opencode/skills` |

不在表裡的 program 不猜目錄，會在 transcript 說明沒有放置。這是依已知 CLI 慣例準備檔案，不代表每一個 CLI 都已接受相同的 live 驗證。

真正需要小心的是 workspace 原本已有的檔案。

Host 在 Skill 目錄保存 `.bearpunch-placed.json`，逐檔記錄來源 Bundle revision 與 digest。若目標已存在，只有它在放置紀錄裡，而且目前 bytes 仍與紀錄相符，才允許覆寫。

因此以下兩種情況都會保留檔案：

- 使用者自己建立同名 `SKILL.md`，Host 從未放置過；
- Host 曾放置檔案，但使用者後來修改了它。

測試讓 `probe-skill` 與使用者的檔案衝突，確認它被拒絕、原檔未變，而另一個 `probe-notes` 仍正常放置。另一個案例則修改已放置的檔案，下一次 session 建立時也不覆寫。

路徑方面，sink 必須是合法相對路徑；workspace 以下的目錄與目標檔案逐段檢查 reparse point。Parent 補上的 Windows junction 測試，把 `.claude` 指向 workspace 外，確認放置被拒絕、外部目錄仍為空。這份證據針對指定 workspace 以下的路徑；workspace 根目錄本身仍是操作端指定的起點。

這樣放進 workspace 的工作方法，才同時有來源、有版本，也保留使用者後續修改的空間。

## 改契約時，讓新舊 Topic 各有身分

把 server 清單交給 Adapter，會改變 Sessions 與 Adapter 之間的 open command。

Day 023 已遇過同一 topic 改 shape 後，舊 installation 擋住新版安裝的問題。今天先落地的 topic identity 規則，把這個限制帶進開發檢查：**同一個 topic ID 持續代表同一份契約；新的 shape 使用新的 ID。**

因此這次保留：

```text
bearpunch.agents.open
```

另外增加帶 `mcpServers` 的：

```text
bearpunch.agents.open.v2
```

新版 contract bundle 同時宣告兩者，Adapter 與 echo 處理兩種入口，Sessions 改用 `.open.v2`。

`projects/contracts/topics.lock.json` 保存 topic 的已知 shape，conformance test 比對 stage manifests。Parent review 又補上一個關鍵檢查：如果開發者連 manifest 與 lock 一起改，單看 working tree 的測試仍可能通過。因此 pre-commit hook 另外比較歷史與 staged lock，拒絕修改或刪除舊 entry，只接受新增。

本次 live review 記錄的順序是：先安裝同時含舊、新 topic 的 contract，再安裝為新版入口建置的 Adapter 與 Sessions。這次沒有重建 fresh state。

不過，新增 `session-context` Host interface 也改了 platform WIT，所以 Station binary 仍有重新建置與重啟。保留既有 state 的契約升級，和 Host process 全程不中斷，是不同的證據；這輪完成的是前者。

## 測試一路走到工具回覆與檔案內容

只檢查 `mcpServers` 不是空的，還不能確認 Agent 真的能使用其中的工具。

這次 Station test 使用真正的 Sessions／Adapter Wasm bundles，加上 fake ACP process。Fake Agent 從收到的 `session/new` 清單啟動 fake MCP server，列出工具、呼叫 `probe`，再回報工具事件。最後測試確認 transcript 出現：

```text
tool [completed]: probe.probe: probe answered
```

Skill 測試則核對落地 bytes 與 fixture 相同，placement record 具有 bundle／revision，session record 也列出來源。

幾個 negative controls 刻意切斷路徑：把 Adapter 改回空清單，工具呼叫測試就失敗；移除 Agent 過濾，未列名 session 就看見不該配發的 alias；移除覆寫保護，使用者的 Skill 檔案就被改掉。

Credential 測試使用固定的測試值，確認它透過 Agent environment 到達 server，卻沒有進入被檢查的 session record、events、logs 與檔案。對應 control 刻意把值塞進紀錄，首先失敗的是 provisioning line 的精確比對；不能將它描述成後面的全文搜尋先抓到洩漏。

Parent 另發現兩條已存在的檢查，停用後原本六個 session-context tests 仍全部通過：`trusted full` 與 junction refusal。`53aa9bc` 因而增加兩個針對案例，review 記錄它們在規則停用時失敗、還原時通過。

本次撰文核對的 Jupiter 基線是乾淨的本機 `main@17f9b7a`。Session context 由 `6396532` 合入，`c866a52` 保存 worker report、parent review 與 live proof：

| 證據 | 可以支持的範圍 |
|---|---|
| Parent gate 記錄 | Station 268、conformance 16 通過；runner test 與 A2 gate 通過 |
| Parent follow-up | 補上 trust 與 junction 的兩個 regression；不將它們加回前一輪總數冒充完整重跑 |
| 真實 Claude Code session `s16` | 收到 `probe`、呼叫工具取得回覆，並載入放置的 `probe-skill` |
| 契約 live upgrade | 新舊 open topics 並存，沿用既有 Station state |

Live proof 在 scratch workspace 執行，完成後移除測試用 Bundle、alias 與 program。本文核對 source、tests、committed report／review，以及保存的部分 gate／control 結果；沒有重新啟動 Agent 或重跑 Jupiter gates。

## Session 建立成功，還要讀懂配發結果

目前 `provision()` 的設計會把失敗寫成 transcript，繼續建立 session。Skill 放置失敗、未知 program 目錄，或 server 查詢失敗，都不會自動讓整個 session creation 失敗。

因此 orchestrator 後續仍需要判斷：這件工作缺少某個工具或 Skill 時，是否還能開始。

紀錄本身也有範圍。Session 保存 Host 選出的 alias 名稱，但 policy 尚無 revision，Adapter 之後還可能因 Agent 不支援 HTTP 而略過其中一筆。Alias 被列入、傳進 CLI、連線成功、工具執行成功，仍是不同階段。

這次 server list 接在 ACP 路徑；Adapter 另有的 Codex app-server 與 Antigravity dialect 沒有接上同一份清單。走 `codex-acp` 與走原生 Codex dialect，也不能混為同一個驗證案例。

Skills 則在建立 session 時從已安裝 Bundles 配發，沒有逐 Agent 的 Skill allowlist。是否採用某份工作方法由 Agent 判斷，工具權限仍由工具自己的路徑處理。

至於長期記憶，今天 main 已有 knowledge sidecar 的 brief，但這輪 session context 的交付不包含 Semantica。現在完成的是讓後續服務有一條可用、可觀察的入口。

## 回到 Unity：把工作方法帶到執行現場

假設接下來要讓 Agent 修改 Unity Component，再執行 Edit Mode tests，開工時就有兩種需要準備的內容：

| 內容 | Unity 工作中的可能用途 |
|---|---|
| MCP server | 查詢 Editor 狀態、取得編譯結果、提出測試工作 |
| Skill | 專案的修改慣例、等待編譯的順序、如何讀取測試與 review 證據 |
| Session 紀錄 | 哪個工具入口被配發、工作方法來自哪份 Bundle revision |
| 配發失敗的處理 | 必要工具不可用時，停止派工或明確改變工作範圍 |

這是應用構想，尚未成為本次 Jupiter 的 Unity consumer。

如果專案已經有團隊維護的 Skill，新版工具 Bundle 不應只因檔名相同就蓋掉它。如果 Agent 看見「已配發測試工具」，也還需要確認連到的是預期的 Editor／project，才能開始操作。

Day 024 讓開工環境多了一份可以核對的資料：工具清單如何選出、工作方法從哪個版本複製、哪些內容沒有成功到達。接下來派一件 Unity 工作時，這些資訊就能成為 readiness 與驗收的一部分。
