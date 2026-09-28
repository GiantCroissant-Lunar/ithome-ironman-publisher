---
title: Day 027：讓人與 Agent 共用操作入口——Jupiter 回到 BearPunch
timestamp: "2026-09-27T20:47:00+08:00"
tags:
  - AI Agent
  - MCP
  - Vibe Coding
---

# 讓人與 Agent 共用操作入口：Jupiter 回到 BearPunch

Day 026 處理的是 Agent 開工前拿到什麼：依 workspace 配發工具與 Skills，再把記憶組成可以核對的初始上下文。

接下來，帶著這些資料的 Agent 要開始操作系統了。它應該連到哪個 Station？使用者在桌面視窗看到的狀態，和 Agent 透過 MCP 操作的對象，是否一致？如果另一個 Agent 從 BearPunch 外面加入，能不能走同一條派工流程？

9 月 26 日到 27 日的進展，開始把這幾件事接在一起：桌面 App 能管理自己的畫面 Bundles，也能管理連接的 Stations；MCP 則改由 App 提供共同入口，讓外部 Agent 經由它查詢記憶、組裝上下文與操作 Sessions。

在往下看之前，先交代今天標題裡的名字。

## Jupiter 回到原名，工作接著往前走

這個 repository 原本就叫 BearPunch。Jupiter 是這一輪實作使用的名稱；9 月 26 日，專案決定恢復 `bearpunch`，同時整理程式與文件裡的命名。

這次改名延續既有的 plugin framework、Station 與 Agent Sessions。過去幾天完成的記憶和上下文組裝，也都留在同一條開發歷程裡。

歷史紀錄仍保留當時的用字：decision rows、發布過的 receipts、派工紀錄與有日期的討論，不會因為改名就全部重寫。因此，前文寫 Jupiter，本文開始使用 BearPunch，指的是這個專案持續演進的同一輪實作。

用途也在這次整理中寫清楚了：BearPunch 是為遊戲開發打造的 Agent 開發環境，Fantasim 是第一個預定承接的遊戲 workspace；底下的 plugin framework 維持領域中立。

這讓系列一開始的方向更具體：從自己直接修改遊戲，逐步走向組織工具、工作環境與 Agent，讓它們能共同完成開發工作。

## 先讓操作介面能更新，也能恢復

App 的畫面原本就由 Bundles 提供，但「架構上可以替換」和「日常真的換得動」之間，還有不少落差。

既有實測找到幾個直接影響操作的問題：從視窗移除 Bundle 後，沒有 Install 控制可以裝回來；卸載主要畫面後，只剩恢復頁，也缺少重新載入的操作。重新建置畫面時，資源檔變動還可能觸發整個 App 重啟。

另一個問題出現在舊 profile：它記著上一版 Bundle 的 revision，新 build 卻只信任新版 digest，結果留下安裝紀錄，畫面無法啟用。當 bootstrap 只在全新 profile 執行，重開 App 也不會自動修好。

這輪補上了幾個可操作的行為：

- 在執行中的 App 安裝新版畫面 Bundle，實測以相同 process ID 看見更新。
- 啟動時讓內建 Bundles 跟隨目前 build，並保留使用者主動卸載或移除的選擇。
- 在 Bundle 管理畫面提供 Install、Diagnose，並顯示目前狀態。
- 即使某個畫面 Bundle 被卸載，仍能從外框的 Recovery 頁載入回來。

App 的畫面組成也重新整理：原本集中的 workbench 拆開，documents 改名為 renderer，各自負責以下內容：

| Bundle | 負責的內容 |
|---|---|
| `client-app.stations` | Station 連線、身分與狀態，以及各 Station 的 Bundles |
| `client-app.app-bundles` | App 自己的 Bundles |
| `client-app.station-views` | 各 Station 提供的 view 分頁 |
| `client-app.renderer` | 將 view 的內容畫到畫面上 |

外框保留導覽、頁面、命令與狀態列的插槽，畫面由 Bundles 放入。後續新增 workspace 或 session 畫面，就有自己的安裝與生命週期。

這也帶來一個值得分清楚的現象：卸載 Station 裡提供 view 的 Bundle，分頁仍在，但會顯示不可用；卸載 App 的 `station-views` 畫面 Bundle，相關分頁才會消失。兩者分別反映資料提供端與顯示端的狀態。

## MCP 透過 App，找到明確的 Station

在這之前，`station` MCP alias 直接連到單一 Station。這次改成 `bearpunch` alias，由 MCP host 連到 App 的控制入口，再經過 App 已建立的 links 到達 Station。

```text
外部 Agent
  → bearpunch MCP
  → App 控制入口
  → 指定的 Station link
  → Station 裡的 Bundle、記憶與 Session

桌面視窗
  → App 的操作介面
  → 同一組 Station links
```

App 自己的管理與 Station 的管理，各有清楚的工具名稱。例如 `app-list` 列出 App 的 Bundles；`list` 則需要指定 `station`，列出該 Station 的 Bundles。`stations` 會回傳已保存的 link 名稱、Station identity 與目前是否可用。

這裡的 `station` 參數是 App 保存的 link 名稱。送命令前，App 會取得連線狀態並核對 Station identity，再送出該命令。即使相同目錄後來被另一個 Station 使用，也不能只因為路徑相同，就把它當成原來的對象。

新入口承接現有的 Station commands，保留它們的結果與拒絕原因；這輪沒有為了轉接，再改一套 Station protocol。App 的一般 build 也會提供控制入口，不必依賴開發用的 Tauri bridge。

不過，共用入口不表示 GUI 與 MCP 的權限完全相同。GUI 有畫面 Bundle 的授權，MCP 有啟動時的工具開放設定，Station 本身也仍會檢查政策。這次共用的是連線對象與底下的操作路徑。

## 從外部 Agent 走完一次工作流程

入口接好之後，驗收需要真的穿過它。

既有 worker report 記錄，在獨立的第二個 App 與臨時 Station 裡，透過 MCP 完成了以下流程：

```text
開啟 workspace scope、設定 workspace
→ 召回記憶
→ 組裝上下文，取得 manifest，再依 ID 讀回
→ 建立 session 並送出工作
→ 收到核准請求，回覆後繼續
→ 送出工作報告，召回該 session 的 episode
→ 關閉 session，釋放 scope
```

這條測試使用 echo agent 與測試用 memory Provider，驗證的是操作能否經過真實 App、MCP host 與 Station 接通。它沒有因此證明真實 coding Agent 的產出品質，也沒有重新量測 Day 025 的語意召回品質。

另一部分驗收同時觀察視窗：透過 MCP 卸載、載入 Bundle，畫面的分頁與可用狀態隨之變化。外部 Agent 改變的，就是這個 App 所管理的對象。

整合時還把原本直接連 Station 的四個 MCP live gates，改成經過無視窗的 App 執行。這個 headless App 保存 profile、建立 links、提供控制入口，讓自動化檢查能走新的路徑，也不必占用使用者正在操作的視窗連接埠。

Headless gate 與真實視窗各自回答不同問題：前者驗證命令、連線與回覆；後者確認畫面確實跟著變化。兩份證據需要一起看。

## 測試全綠，還是可能漏掉最重要的界線

這輪最值得留下的經驗，出現在 parent review 刻意移除規則的時候。

第一個控制，是拿掉 linked Station 管理路徑的 identity check。原本 42 個 `station-links` tests 仍全部通過。一般的列出、安裝與卸載案例，都沒有模擬「連線目標已被另一個 Station 取代」。

因此，正常流程通過，還不足以支持「不會操作到別的 Station」這個承諾。後續修正補上替換 Station 的情境，也確保先更新連線觀察到的身分，再做檢查，避免拿舊連線記住的 identity 去批准新連線。

第二個控制，是移除 MCP host 在連線握手時要求的 App operation。原本 57 個 MCP tests 同樣全過：它們沒有確認，誤把 Station 的 state directory 當成 App profile 時，應該立即拒絕。這個缺口也補了專門的測試。

另外，最初擴充編排工具時，`--allow` 只管既有的安裝、載入等工具，漏了 `grant`、`revoke`、`workspace` 與 `scope-close`。結果未開放這些管理能力的 MCP client，仍可能呼叫它們。Review 後才把它們納入工具列表與呼叫兩端的檢查。

目前 App 形式的 MCP 有 14 個工具受這個啟動設定控制。但 `invoke`、`send` 等仍可呼叫，底下由 Station 與 Bundle 檢查權限；所以不能把「沒有 `--allow`」解讀成整個 MCP 連線只讀。

這幾個案例讓驗收問題變得更精準：

> 如果把我們聲稱重要的規則拿掉，哪一個測試會失敗？

驗收紀錄顯示，App MCP 合併後的 parent 檢查包含 MCP 57 tests 與 station-links 47 tests，各跑三次通過。這些數字屬於當時的合併基線；後補的控制與修正也另有紀錄，本文沒有把它們混成一次在最新 head 重跑的完整驗收。

## 同一個入口，仍有需要補上的行為

把操作接通之後，還有幾個限制需要跟著保留。

首先，外部 orchestrator 直接在 workspace scope 寫入 memory candidate，仍會被拒絕：這種 scoped durable write 需要持有確切 revision 的有效 retained owner。既有測試使用 unscoped 的候選寫入路徑完成流程，不能據此宣稱 workspace 專屬記憶已能從外部任意寫入。

其次，MCP 到 App、App 到 Station 各有一層 60 秒回覆期限。當 `send` 的等待接近 60 秒，外層可能先逾時；目前操作指引將等待限制在 50 秒以內。收到逾時，也不能直接當成底下的工作沒有發生。

控制入口還留下可用性問題：持有 endpoint token 的連線能送出 shutdown，停止控制入口，直到 App 重啟。這項 finding 仍未關閉。

桌面顯示也有自己的生命週期。今天稍晚合入的 reload 修正，處理「host 說畫面 Bundles 都 active，但重載後的頁面沒有畫面」：每個新頁面有自己的 ID，host 對新頁面重新送出啟用資料，同一頁重複發 ready 訊號則不重複處理。這項修正說明，後端仍在運作，與使用者眼前的頁面已恢復，需要分別驗證。

至於 Day 026 留下的 findings 召回問題，以及這兩天觀察到的 episode 雜訊，已有新的 context-quality 派工。Workspace、Sessions 畫面與 activity view 也在後續工作裡。截至本文核對的主線，不能把這些派工要求寫成已交付的成果。

## 回到 Unity：操作之前，先確定工作要送去哪裡

如果下一件工作是修改 Unity Component 並補 Edit Mode tests，我希望在開始之前，就能回答幾個問題：

| 要確認的事情 | 這次進展提供的基礎 |
|---|---|
| 要把工作交給哪個執行端？ | App 的 Station links 與 identity 核對 |
| 使用哪個專案的工具與背景？ | 前文的 workspace 設定、記憶與上下文 manifest |
| 外部 Agent 如何加入工作？ | 經由 MCP 操作 scope、Session 與核准回覆 |
| 使用者如何看見操作結果？ | App 的 Bundle 管理、Station views 與事件來源 |

Station 身分正確，還需要接著確認 Unity Editor 連到哪個 project；session 回覆完成，也還需要實際的程式變更與測試證據。這次尚未交付或驗證 Unity consumer。

但這條工作路徑已往前走了一步。先前我們在追問「Agent 開工前收到了什麼」，現在可以繼續追問：它經由哪個入口，把命令送給了哪個對象，又取得什麼回覆。

當人與 Agent 使用同一組可核對的連線，編排才有機會成為日常可操作、出問題也能追查的開發方式。

本文核對基線為本機 `BearPunch main@f0378dd`；tracked files 在核對時無修改，另有未追蹤的 doc-trim 目錄，未作為本文依據。主要來源為 `docs/architecture/` 的 `retire-jupiter`、`app-bundles`、`orchestration-mcp`、`app-mcp` receipts，對應的 `docs/dispatch/20260926-*`／`20260927-app-mcp/` reports 與 review，以及 MCP tools、station-links、App reload 的 source／tests。尚未完成的項目依 `20260927-context-quality`、`app-workspaces`、`app-sessions` 與 `activity` 派工紀錄區分。本文讀取既有證據，沒有重跑 BearPunch gates 或啟動 Agent sessions。
