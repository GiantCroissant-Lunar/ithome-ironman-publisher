---
title: Day 028：讓編排看得見——BearPunch 的工作區、Sessions 與活動紀錄
timestamp: "2026-09-28T20:47:00+08:00"
tags:
  - AI Agent
  - Orchestration
  - Vibe Coding
---

# 讓編排看得見：BearPunch 的工作區、Sessions 與活動紀錄

Day 027 把人與 Agent 的操作接到同一個 App 入口。命令能送到明確的 Station，接下來就要讓使用者看得懂：現在有哪些工作？各自屬於哪個專案？按下取消時，究竟會影響誰？

9 月 27 日合入的 Workspaces、Sessions 與 Activity，讓這些問題開始有了畫面上的答案。

其中一份視窗實測很具體：在同一個 Station 建立 Fantasim 與 Tools 兩個工作區，各自開啟 Session。在 Tools 裡核准請求、取消工作，再關閉 Session；每一步之後，都回頭確認 Fantasim 的 Session 仍維持 idle，而且還活著。

這比單純看見兩個分頁，更接近我想驗證的編排能力：使用者選中的工作範圍，能一路跟著操作抵達執行端。

今天從這條路徑往下看，再看看活動紀錄如何讓原本藏在背景的問題浮上來。

## 工作區的名字可以改，身分需要留下來

Day 026 已有 Station 端的 workspace policy 與 scope。這一輪，App 開始保存自己的工作區清單，提供建立、改名、分享給 Station、取消分享，以及採用 Station 既有工作區的操作。

這裡的「分享」是讓某個 Station 持有這個工作區的執行範圍與設定。它本身不會替專案搬檔案，也沒有完成 Git 同步。

理解這層關係，可以先分清楚三件事：

| 身分 | 用途 |
|---|---|
| Workspace name | 顯示給使用者看的名稱，例如 Fantasim |
| Workspace ID | App 用來辨認同一個工作區的穩定身分 |
| Station scope | 該工作區在某個 Station 上這一次開啟的執行範圍 |

App 分享工作區時，使用 Workspace ID 作為 Station scope 的 label，再把 roots、可用工具與上下文預算等設定交給 Station。使用者之後改名，不需要連同底下的身分一起更換。

既有視窗實測把 Fantasim 改成 Fantasim II，原本的 Workspace ID 與 share 仍接在一起；重開 App 後，改名結果也保留下來。

另一個情境是工作區先從 Station CLI 建立。App 會顯示它只存在於 Station，讓使用者選擇 Adopt 或 Ignore。如此，操作入口不必限定為某一個視窗，畫面也能呈現從其他入口建立的狀態。

這裡仍有生命週期差異：App 保存了工作區紀錄，不代表已關閉的 scope 會恢復。取消分享並關閉 scope 後，再分享會建立新的空範圍。Day 026 提到的 episode 隨 scope instance 分開，也沒有因為多了畫面就自動解決。

## 看不到 Session 時，畫面要說明原因

App 將本機的工作區紀錄，與各個 Station 當下回報的 scope 合併顯示。這讓「沒有工作」和「現在無法讀取工作」有了不同的呈現。

| Share 狀態 | Sessions 頁面的行為 |
|---|---|
| `open` | 在該 Station 的 scope 裡顯示 Sessions view |
| `closed` | 說明分享已關閉，再次分享會從空範圍開始 |
| `unreachable` | 顯示 Station 無法連線的原因，暫時無法取得 Sessions |
| 已開啟，但 Station 沒有提供 Sessions view | 說明缺少對應的 Bundle |

如果 Station 暫時離線，已保存的 share 仍要留在清單上。否則使用者只看到空白，很容易以為 Session 被刪除了，接著重建一份工作。

Parent review 對此做了負向驗證：刻意丟掉離線 Station 的 share，保留 share 的測試就失敗；把 closed share 畫成 open，Sessions 的測試也會失敗。

這些畫面狀態都有對應的操作意義。使用者要能判斷，接下來應該恢復連線、重新分享，還是安裝缺少的 Bundle。

## Scope 要跟著讀取、操作與更新一起走

Sessions 頁面沿用各 Station 的 `bearpunch.sessions.main` view，在每個 share 的 scope 裡取得內容。建立 Session、送訊息、核准、取消與關閉，也沿用這個 view 原有的操作。

這次需要接通的是整條路徑：

```text
選擇工作區
→ 找到該 Station 的 share 與 scope
→ 以 scope 讀取 Sessions view
→ 使用者操作帶著相同 scope 送回 Station
→ 更新事件帶回 scope
→ 畫面判斷是否需要重新讀取
```

只在讀取時過濾清單還不夠。如果畫面列的是 Tools 的 Session，送出取消時卻掉了 scope，操作就不再具備同一個工作範圍。

因此，scope 從 renderer、SDK、App bridge 到 Station link 都要保留下來。既有 real-Station test 開了兩個 scopes，確認其中一邊的 action 只改變那個 scope；刻意拿掉 action 的 scope 後，測試會失敗。

更新事件也需要相同的判斷。視窗正在顯示 workspace-2 時，workspace-1 的 `view-changed` 不應觸發這個畫面重新讀取。Station 層級、沒有 scope 的更新仍可能影響所有相關畫面，例如 Bundle 被重新載入。

輸入中的草稿也跟著 view 與 scope 分開，避免切換工作區後沿用上一邊的輸入。

開頭的 Fantasim／Tools 實測，使用的是測試用 ACP Agent。在 Tools 裡完成核准、取消與關閉後，Fantasim 的 Session 仍保持原狀。這份證據支持操作範圍的傳遞，沒有量測 coding Agent 的產出品質。

實測也留下兩個未修的問題：Sessions view 的「設定工作目錄」參數叫 `path`，被 A2UI 當成資料綁定處理，導致視窗無法送出；當次以 Station CLI 的相同 intent 設定目錄，其他操作才從視窗完成。另外，取消後，Station 端仍把已取消的請求列在 pending。

所以目前已能從視窗操作多個工作區的 Sessions，完整的日常使用流程仍有需要補上的地方。

## Activity 讓背景發生的事留下可讀紀錄

Sessions 呈現目前的工作，Activity 則補上另一個問題：剛剛發生了什麼？

這次新增的 `bearpunch.activity` Bundle 使用兩個來源：

| 來源 | 提供的內容 |
|---|---|
| Live event feed | Host 發出的即時事件，例如 Bundle 狀態與 process 的啟動、結束 |
| Ledger read | 讀取 Station 已保存的決策紀錄，例如安裝、權限變更與拒絕 |

Host 在事件發出時加上 `at_ms`，觀察者便能使用事件本身的時間。Ledger 則由 Activity 每五秒讀取一次。

即時事件透過容量 256 的佇列交給背景 worker。送不進去時增加 dropped 計數，讓發出事件的工作繼續進行；subscriber inbox 放不下的情況也會計入。

這表示即時畫面可能缺事件。`delivered` 與 `dropped` 讓使用者知道這條觀察路徑有沒有遺漏，不能把 Activity 當成所有行為都完整保存的稽核紀錄。Ledger 有自己的紀錄範圍，也不會補回每一種即時事件。

權限分開控制：取得即時通知需要 `events:observe`，讀 Ledger 需要 `ledger:read`。Topic 事件送進 feed 前會移除 payload，只留下識別、大小與接收方數量等資訊；這項縮減針對 topic 事件，不能推論所有事件資料都經過相同處理。

目前 Activity 能把 process 的啟動與結束接成同一筆紀錄，保留開始、結束時間。Session 的一輪工作，以及命令與回覆，還沒有全部接成這種期間紀錄。

在視窗實測中，安裝、政策變更與拒絕都能出現在 Activity；scope 分開的 process 紀錄則以 Station CLI 核對。Overflow 行為由測試刻意放慢 worker 驗證，當次輕量的視窗操作沒有實際塞滿佇列。

## 活動畫面也會製造活動

Activity 的第一輪 live proof 找到一個很容易誤判的狀況：畫面已有資料，卻沒有真的訂閱即時事件。當時顯示的內容全部來自 Ledger polling，Bundle 的安裝描述漏了 feed subscription。

補上 subscription 後，又出現更直接的問題：Activity 收到事件、更新畫面，接著收到自己發出的 `view-changed`，再更新一次。

```text
收到事件
→ 更新 Activity
→ 發出自己的 view-changed
→ 自己再次收到
→ 再次更新 Activity……
```

既有紀錄顯示，不到一分鐘就發生 4,983 次 deliveries。修正是在 Activity 端忽略關於自身 view 的 `view-changed`。

另一個缺口出現在 process 結束：原本自然退出會發出事件，主動 kill 的路徑卻沒有。於是關閉 Session 後，Activity 裡的 process 紀錄仍缺少結束點。補上 killed 事件後，這條路徑也能把紀錄接起來。

這幾個問題說明，驗收不能停在「畫面有東西」。還需要追問資料從哪裡來、更新是否會回饋給自己，以及每種結束方式能不能留下對應結果。

## 觀察機制的關閉，也需要有期限

Activity 合併驗收時，parent 遇到 Host 關閉或重開偶爾卡住的問題。完整測試曾停住 90 分鐘，單獨重跑也曾在五次中出現一次。

檢查發現，當時的 `EventFeed::shut_down` 會用阻塞方式送出 Stop，再無限等待 worker 的 `join`。Worker 若仍卡在 delivery，關閉流程就沒有退出的期限。

後續修正把 feed shutdown 改為非阻塞重試，並在共用的 200 毫秒等待預算內檢查 worker 是否結束；期限到了，就不再等待它。這個預算約束 feed 的關閉等待，沒有因此證明整個 Host 能在 200 毫秒內關完。

新增測試刻意讓 worker 在 delivery 裡停五秒，要求 shutdown 在一秒內返回。放回舊的阻塞行為，測試會等滿五秒並失敗；恢復修正後，既有紀錄約 0.25 秒通過。

修正後，parent 的相關測試重跑五次通過，worker 重跑十次也通過。這些結果支持這次修正，但有限次重跑本身不能證明所有併發問題都已消失。

對編排系統來說，這是一個實際的要求：用來顯示工作進展的機制，也要能在工作結束時退出。

## 把已驗證的範圍與未完成的部分一起留下

這輪三個功能合入同一棵 review tree 後，再做整合檢查。既有 receipt 記錄的基線是 `15a53d0`，包含 Sessions event fixture 的 `at_ms` 修正，以及 Activity shutdown 修正。

| 驗證層次 | 既有證據 |
|---|---|
| 視窗操作 | 工作區建立、改名與重開保留；兩個工作區各自操作 Sessions；Activity 顯示真實 Station 紀錄 |
| 範圍與權限 | 移除 action scope、隱藏離線 share、把 closed 畫成 open，或拿掉 feed 權限檢查，都有會失敗的測試 |
| 合併後檢查 | Framework、App、MCP、Sessions、Workspaces、Station links 等相關 suites 通過；Station 44 個 test binaries 在重跑通過 |
| 整合 gates | M1 與 A2 在合併基線各跑三次通過 |

第一次完整 Station 檢查因缺少 rlib 編譯產物而未能編譯，之後重跑才通過。Worker 階段也記錄 V1a 的 MPS 輸出與兩份既有 surface 檔案不一致；Sessions 的 D3 視窗 gate 在基線與分支都卡在啟動畫面的 handle 檢查。因此，上表列的是有明確範圍的通過結果，不能寫成所有 gates 全綠。

Activity 的交付範圍也比完整設計小。目前每個 scope 最多保留 500 筆；原先決定的七天或十萬筆保存目標尚未完成。Feed 紀錄依 scope 寫入，Ledger polling 則仍把讀到的項目放在 Station 層級。畫面目前使用一般結構化欄位，完整 timeline 與欄位角色仍待後續實作。

至於 Day 026、027 留下的上下文品質改善，雖然分支上已有召回進展，仍暫緩合併：新的 episode 規則會漏掉一般段落形式的工作報告，也與既有 MCP 流程測試的預期衝突。不能因為同一天有多項成果，就把它一併算成主線能力。

## 回到 Unity：先能辨認工作，才知道如何介入

假設接下來在 Fantasim 修改 Unity Component，同時在 Tools 維護開發工具，我希望畫面能提供以下協助：

| 當下的問題 | 這次進展提供的基礎 |
|---|---|
| 這份工作在哪個執行端？ | Workspace 列出各 Station 的 share 與連線狀態 |
| 這個核准請求屬於誰？ | Sessions view 與操作一起攜帶 scope |
| 為什麼剛剛沒有動作？ | 從 Activity 追查拒絕、政策變更與 process 紀錄 |
| 畫面是不是漏了什麼？ | 分辨 live feed 的 dropped 計數、保存上限與不同來源的範圍 |

這仍是 Unity 工作的應用構想。本輪沒有交付或驗證 Unity consumer，也沒有證明專案檔案、所有長期記憶或外部工具都已完整隔離；操作 Unity Editor 前仍需要確認 project identity，完成後也需要程式與測試證據。

但使用者已開始能沿著畫面辨認：哪個專案、哪個 Station、哪個 Session，以及剛才發生了哪些可觀察的事件。

從直接修改遊戲走向編排遊戲開發，我需要的不只是更多能開工的 Agent。當某一件工作等待核准、失去連線或需要停止時，我也要看得出來，並能對正確的工作採取行動。

本文核對基線為本機 `BearPunch main@e8796d8`；tracked files 在核對時無修改，既有未追蹤的 doc-trim 目錄未作為依據。主要來源為 `docs/architecture/` 的 `app-workspaces`、`app-sessions`、`activity`、`context-quality` receipts，`docs/dispatch/20260927-app-workspaces/`、`20260927-app-sessions/`、`20260927-activity/` 的 reports，以及 workspace catalog、Sessions／renderer、event feed 與 Activity 的 source／tests。整合驗收數字屬於 receipt 指定的 `15a53d0`。本文讀取既有證據，沒有重跑 BearPunch gates 或啟動 Agent sessions。
