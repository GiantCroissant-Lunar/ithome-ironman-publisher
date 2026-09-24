---
title: Day 023：讓 Jupiter 接手自己的開發——真實派工如何暴露 Sessions 的缺口
timestamp: "2026-09-23T20:47:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Vibe Coding
---

# 讓 Jupiter 接手自己的開發：真實派工如何暴露 Sessions 的缺口

Day 022 談到一個 Bundle 裡的元件如何各自升級，以及部分升級失敗時，Host 應保存什麼狀態。今天把焦點移回使用這套系統的人。

Jupiter 已經能啟動 Agent、送出 prompt、收取回覆，也有 Sessions 畫面。當它真的拿來處理自己的開發工作，問題就變得很具體：

> Agent 已經寫完並提交了，為什麼 Approve 一次也沒出現？用量顯示零，代表沒有花費，還是根本沒收到資料？幾百筆 transcript 裡，哪些其實是同一次工具呼叫？

9 月 22 日到 23 日的實際派工，把這些問題變成了下一批修正。修正合入之後，再裝回日常使用的 Station，又找到了測試沒有走到的地方。

這篇記錄的，就是這一輪從使用、發現問題、修正，再回到使用的過程。

## 先讓下一件工作真的經過 Jupiter

Day 021 已經記錄過 Jupiter 承載派工、兩個 Provider 先後遇到 quota 的經驗。後續紀錄卻顯示，接續開發逐漸改由 parent 自己的 Agent tool 執行，Jupiter 又退回被開發的對象。

這裡的 parent，指負責派工、review 與整合的上層 Agent。

9 月 22 日重新確立的規則是：實作 worker 必須是運行中 Station 透過 `bearpunch.sessions` 開出的 session。這條路遇到的缺陷，也要成為經過同一路徑處理的工作。

規則確立後，第一件工作是整理九個 reference projects。它的產物是一份文件，適合先驗證完整的交付與 review 過程：

```text
Parent 寫 brief、指定 worktree
→ Station 開 session、啟動 OpenCode
→ Worker 閱讀並提交文件
→ Parent 檢查引用，透過同一個 session 送回修正
→ Worker 再提交，Parent 整合
```

既有紀錄顯示，從啟動 process 到第二次提交約十二分鐘。Parent 驗證引用路徑，抽查行號，送回五項修正；修正後文件有 77 處 clone 引用，最後透過 `5b6f274` 合入 main。

這是新規則下的第一件工作，並非 Jupiter 第一次啟動真實 Agent。它也還沒有接上 durable work record，不能直接算成完整的 J4 工作流程驗收。

任務完成了，使用過程卻留下 432 筆 transcript、未曾觸發的核准按鈕，以及沒有正確表達未知狀態的用量資訊。這些才是今天要處理的問題。

## 有 Approve 按鈕，還要確認誰在決定權限

第一輪 OpenCode session 讀檔、執行命令、寫入並提交，都沒有向 ADE 提出 permission request。當時真正決定行為的是 CLI 自己的設定。

因此，Sessions 裡有 Approve 與 Deny，並不足以證明操作都經過這裡。

這次修改先讓核准政策成為每個 session 保存的資料：

| 政策 | Sessions 收到 request 後的處理 |
|---|---|
| `manual` | 等待明確回覆 |
| `auto` | 自動核准，留下紀錄 |
| `workspace` | 依可解析的路徑描述判斷；符合 workspace 規則才自動核准 |

目前 `workspace` 的實作讀取 description 中以反引號括住的路徑，做文字層次的正規化與前綴檢查。沒有可解析路徑，或解析到 workspace 外的路徑，就保留待回覆。

它處理的是 request 的描述，沒有解析任意 shell command 的實際效果，也沒有提供檔案系統 sandbox。更根本的限制是：CLI 必須先送出 request，Sessions 才有機會判斷。

Adapter 因而還要把政策傳進 CLI。未完成版本曾把 `approvalPolicy` 直接加進 ACP 的 `session/new`，但這不是本次固定的協定形狀裡可用的設定入口。修正後，Adapter 讀取該 Agent 回覆的 `configOptions`，再透過 `session/set_config_option` 設定它實際提供的選項。

本機保存的握手資料也提醒我：同樣叫 `mode`，內容未必都是權限。當時 OpenCode 提供的是 persona 選項，沒有對應的 permission value；Adapter 會記錄政策未能套用，不能宣稱已接管 CLI 的所有操作。原 brief 提議寫入 `opencode.json`，但 Plugin 沒有 file-write capability，因此這一部分留下明確的未完成範圍。

另一個改變是把單一 pending slot 改成 queue，並增加：

```text
respond-request(session, request-id, allow)
```

測試同時放入兩筆 request，先拒絕第二筆，再核准第一筆，確認操作依 request ID 對應。

這接近 Day 020 提到的「核准究竟指向哪一筆」問題，但目前畫面的 Approve／Deny 仍呼叫舊的 `respond(session, allow)`，回答 queue 的第一筆。精確回覆的 API 已存在，畫面綁定與完整的過期檢查仍不能一起算成完成。

## 同一次工具呼叫，只留下一個持續更新的 Entry

工具呼叫常有幾次狀態更新：

```text
call-tool-1: pending
call-tool-1: in_progress
call-tool-1: completed
```

如果每次都附加一段文字，使用者就得自己判斷哪些紀錄屬於同一件事。這次改為以 call ID 更新同一個 entry，保存 `id`、`role`、`state` 與 `text`。後續事件只有狀態、沒有文字時，保留第一次收到的工具標題。

Review 在這裡找到一個比版面更前面的問題：未完成版本的 Adapter 已送出 `{id, text, state}`，topic contract 卻仍把 `tool-call` 宣告成字串。Host 因形狀不符而拒絕訊息，工具 entry 根本沒有送到 Sessions。

原本名稱看似在測 coalescing 的測試，送出的 prompt 卻沒有觸發工具事件，所以仍然通過。

修正後，測試透過 fake ACP process 送出一筆 `tool_call` 與兩筆 `tool_call_update`，穿過真正的 Wasm／Host 路徑，確認：

- 三筆工具更新都已送達；
- transcript 只有一個對應 call ID 的 entry；
- 最終狀態是 `completed`，原始標題仍在。

Parent 再把 contract 刻意改回字串，這個測試就失敗；還原後通過。這讓測試能證明合併確實發生，而不是因為訊息沒送到，剛好只剩很少的 entries。

效能改善也需要照實描述。目前每筆 delivered update 仍會保存 session，沒有把整個 turn 合成一次寫入。這次減少的是 transcript 重複項目，以及每次保存的內容；不能直接宣稱先前的 backpressure 已全部解決。

## 沒回報用量，就保留未知

第一輪工作畫面上的零 tokens、沒有 cost，容易讓人以為這次沒有消耗。

但當時的原因是 ADE 沒有收到對應的用量資料。

修正後，session 的 usage line 在沒有可用回報時顯示：

```text
usage: not reported by acp
```

這份證據有清楚範圍。Repository 保存了三種本機 ACP CLI 的握手 fixtures，內容是 `initialize` 與 `session/new`，沒有送出 prompt。它們能確認當時提供哪些選項、握手階段沒有 usage；無法證明各 Provider 在真實工作後都會回報哪些費用或額度。

目前實作也還不是完整的「數值＋是否已回報」模型：`usage_line` 以非零計數或非空 cost 判斷是否有資訊，Summary 的總數也仍有零值顯示。這次先修正最直接的誤導，後續仍要處理各欄位的未知狀態與來源。

CLI preflight 有類似問題。先前只在 bundle activation 時執行 `<alias> --version`，稍後才設定的 alias 仍顯示「未設定」。現在增加 Refresh，讓使用者重新探測。

欄位雖叫 `checked-at`，目前顯示的是 `probe #N`。Plugin 沒有 clock capability，因此它表示這次 activation 內的探測輪次，不能當成實際時間，也沒有在 policy 改變時自動刷新。

對 Agent 來說，這些區別都會影響下一步：沒有資料、資料過時，以及確認為零，是三種不同的判斷依據。

## 真正裝回去，才碰到舊資料與畫面

Sessions 修正於 9 月 23 日透過 `e2b3a18` 整合。但把它裝回日常使用的 Station 時，又出現四個缺口：

| 實際遇到的情況 | 暴露的問題 |
|---|---|
| 舊 installation 仍宣告原本的 topic shape | 新版改變 shape，安裝被判定衝突 |
| Store 裡保留舊形狀的 session records | 新版載入失敗後，列表直接略過，沒有顯示原因 |
| 使用新的 Station state，identity 改變 | App 提示移除並重新加入 link，卻沒有對應的移除控制 |
| View data 已包含 entry records | App 將 list-of-record 轉成字串，顯示成 `[object Object]` |

第一項直接接回 Day 022。元件可以獨立替換，仍要滿足共享契約的相容條件。Framework 會比對既有 installations 的 topic 宣告，不能因為是自己的新版，就忽略舊版還在使用的 shape。

既有驗收紀錄指出，這次把舊 dev state 移到保留目錄，再啟動 fresh state。新的唯讀 session 證明工具呼叫 entry 能在資料層原地更新，Sessions view 也能載入。

這提供了新版本可運行的證據，同時留下 upgrade 與 migration 的缺口。不能將它描述為舊 Station 無縫熱更新成功。

畫面也是同樣的道理。資料裡有 `entries`，renderer 還要知道如何呈現每筆 record。Day 020 建立的 Surface 契約，到了真實使用時，需要繼續驗證資料形狀是否一路走到人能讀懂的畫面。

## 把驗收結果綁回這份 Source

本次撰文核對的 Jupiter 基線是本機 `main@a7a3177`。Tracked tree 沒有修改，另有一份尚未追蹤的 H1b／A1 brief；本文沒有把那份規劃算成已交付功能。

Sessions 這輪工作也經歷了中斷：`s11` 隨 Station 停止，parent 保存 WIP；`s12` 找到綠色測試漏掉的 contract 問題；`s13` 完成修正。後兩個 sessions 又先後遇到 Provider 的 session limit。Day 021 的保存與續接要求，到了這裡仍然適用。

Merge commit `e2b3a18` 記錄，parent 對 `bbf59bf` 使用獨立 checkout 與 fresh target 驗證：

| 範圍 | 既有紀錄中的結果 |
|---|---|
| Station | 35 suites，232 tests 通過 |
| Conformance | 15 tests 通過 |
| 整合 gate | `gate-prepare` 與 A2 通過 |
| Parent negative control | Tool-call contract 改回字串後，對應測試失敗；還原後通過 |

同一份 merge 訊息也保留限制：worker 的 B～D 組 negative-control logs 未保存下來，只有 A 組仍在。本次可讀到的 A 組原始 logs，確實記錄 workspace-policy 測試先失敗、再通過；其餘項目依 committed review 紀錄描述，不補成今天重新執行的結果。

本文主要核對 `docs/discussion/20260922-05-the-flow-and-the-first-run.md`、sessions-loop brief、目前的 `adoption-plan.md`，以及 Sessions／Adapter／CLI preflight 的 source、Station tests 與保存的 audit。也查看了當時的視窗截圖；本次文章工作沒有重跑 Jupiter tests、啟動 CLI 或消耗模型額度。

## 回到 Unity：用一件小工作驗證整條路

把這輪經驗帶回 Unity，可以先選一件範圍清楚的工作，例如修改一個 Component，補上 Edit Mode test，再請 reviewer 檢查。以下是應用構想，目前尚未實作 Jupiter 的 Unity consumer。

同一件工作應讓我們看見幾個具體結果：

| 過程 | 需要能核對的內容 |
|---|---|
| 開始工作 | 使用哪個 project、worktree 與 source revision |
| 要求核准 | 哪一筆 request、哪個操作與目標；畫面回答同一筆 ID |
| 執行工具 | 同一次編譯或測試的狀態持續更新，能找到最後結果 |
| 等待與中斷 | Agent 停止時，Editor／Build 是否仍在執行，以及由誰持有 |
| 檢查產物 | Tests 與 review 對應哪份 source，尚未驗證什麼 |
| 更新工具 | 既有 session、契約與畫面是否能繼續使用 |

今天的 Jupiter 已能承載真實工作，也能把這條路發現的問題交回同一套 Sessions 修正。接下來值得做的，是沿著實際操作補齊 request 的畫面綁定、entry 呈現與舊資料處理，讓下一件工作能更清楚地被觀察、被控制、被驗收。
