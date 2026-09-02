---
title: Day 002：什麼是 Agent Development Environment？——先把 Agent 的工作站畫清楚
timestamp: "2026-09-02T19:37:00+08:00"
tags:
  - Unity
  - AI Agent
  - Agent Development Environment
---

# 什麼是 Agent Development Environment？

昨天用自動發文流程介紹了 orchestration：Agent 不只是生成內容，還要取得 context、操作工具、保存狀態，並在行動後重新驗證結果。

今天，另一個 Agent 花了不少時間實作 BearPunch。到晚上，第一個 D0 lifecycle gate 已經通過。不過第二篇如果直接從 Rust crate、CLI 動詞和測試結果開始，很容易只看見一堆零件，卻不知道我們究竟想造什麼。

所以 Day 002 先退一步，回答整個系列最重要的問題之一：**什麼是 Agent Development Environment（ADE）？它和我們熟悉的 IDE 有什麼不同？**

## 從 IDE 到 ADE，改變的是工作單位

IDE 的核心工作單位通常是檔案、專案與目前開啟的 Editor。人負責記住「我正在做什麼」，IDE 提供編輯、搜尋、執行、除錯與版本控制工具。

Agent 加入後，這個假設開始不夠用。一次工作可能持續幾十分鐘，途中會呼叫不同工具、建立子程序、等待編譯或測試、要求人工核准，也可能在使用者關閉視窗後繼續執行。若同時使用 Claude Code、Codex、OpenCode 或其他 provider，每一家又有不同的輸出格式、生命週期與用量資訊。

這時真正需要管理的工作單位，不再只是「正在編輯哪一個檔案」，而是一個完整的 **Agent session**：

- 它在哪個 workspace 工作，能看見哪些檔案？
- 它由哪個 provider 啟動，使用哪個帳號與模型？
- 它目前在執行、等待、完成、失敗，還是已取消？
- 它做過哪些動作，留下哪些 event、output 與驗證證據？
- 誰可以核准高風險操作？誰有權取消它？
- 原本的視窗關掉後，另一個 Client 能不能重新接回同一個 session？

因此，我對 ADE 的暫定義是：

> **ADE 是讓 Agent 的開發工作可以持續、重連、觀察、驗證與治理的環境。**

它可以有很好的 Editor 與聊天介面，但「IDE 加上一個聊天側欄」還不等於 ADE。

## BearPunch 的基本模型：Client → Protocol → Station

BearPunch 目前採用的心智模型很簡單：

```text
GUI / Web / Mobile / TUI / CLI
              │
              ▼
      BearPunch Protocol
              │
              ▼
           Station
  Agent / Process / Workspace / State
```

**Client** 是人或其他 Agent 看見並操作系統的入口。GUI、Web、Mobile、TUI 與 CLI 都只是不同 Client；它們可以顯示不同介面，但不擁有 Agent 的生命週期。

**Station** 才是執行節點。它負責啟動與監督 process、保存 session 與 event、管理 workspace、credential、sandbox 及其他具有作業系統權限的能力。

兩者之間透過共同的 **Protocol** 溝通，而不是讓每一種 UI 各自發明一套控制方式。長期目標是一個 Client 可以連多個 Station，一個 Station 也能同時被多個 Client attach。

這個切法最重要的結果是：**Client 的生命週期不等於 Agent 的生命週期。**

桌面 ADE 關閉時，Station 上的 Agent 不應跟著消失。之後可以從 CLI、TUI，甚至另一台裝置重新接回來，讀到同一份狀態與事件歷史。這更接近一台持續運作的 Agent workstation，而不是一個必須一直開著的聊天視窗。

## ADE 至少要承接哪些責任？

若把畫面與品牌拿掉，一個 ADE 至少要處理幾類基礎責任：

| 責任 | 要回答的問題 |
|---|---|
| Workspace 與 context | Agent 實際在哪裡工作？看到的是哪個版本與哪些檔案？ |
| Execution | 誰啟動 Agent 與工具？子程序失控時誰能完整回收？ |
| Session 與 persistence | Client 離線後，狀態、輸出與事件是否還存在？ |
| Provider abstraction | 不同 Agent CLI 的訊息與生命週期如何轉成共同語彙？ |
| Permission 與 sandbox | Agent 可以讀、寫、執行什麼？credential 如何交付而不外洩？ |
| Observation 與 verification | 系統如何證明工作真的發生，而且結果符合預期？ |
| Usage 與 quota | token 用量與帳號額度從哪裡來？資料不完整時是否誠實標示？ |

這也是為什麼 BearPunch 先做 Station、結構化 session、provider profile、plugin boundary、durable event 與 process cancellation，而不是先畫一個華麗的 Agent dashboard。

另外，**PTY 不等於 Agent**。Terminal 是一種執行與呈現方式；Agent 則有自己的 identity、session、provider event、tool use、usage 與治理狀態。若一開始把兩者綁死，未來要接 API 型 Agent、背景工作或不同 Client 時就會很痛苦。

## 今天做到哪裡：D0 不是產品完成，而是核心假設成立

今天通過的 D0，驗證的是最小 lifecycle，而不是完整 ADE：

1. 一個本機 Station 可以獨立啟動，Client 結束後仍繼續存在。
2. provider 以資料 profile 描述，目前能列出 mock、Claude、Codex、OpenCode 與 Kiro CLI。
3. Client 啟動 mock session 後先離開，另一個 Client 可以等待、重連並讀到相同事件。
4. 事件不只放在記憶體；新的 Client 與 SQLite 讀到的 sequence、event identity 和內容雜湊一致。
5. 取消 session 時，必須等 root process 與 child process 都被回收，才回報 cancelled。
6. 除了可重現的 mock，D0 也實際跑過一次 Claude CLI session，並把 completion 與 usage 正規化成共同事件。

這些結果證明「Station 擁有執行、Client 可以離開、session 能重新接回」的骨架已經成立。

同樣重要的是沒有完成的部分：目前仍是 CLI-first 的本機垂直切片，還沒有 ADE GUI；sandbox 狀態明確回報為 `unavailable`；遠端連線、多 Station、完整 protocol projection、用量整合與 Unity workflow 也都還在後面。Planning、task graph 與多模型 routing 更是刻意延後，避免在 execution、state 和 cancellation 尚未可靠前，就先堆出一個看起來很聰明的規劃器。

## 這和 Unity Game Dev 有什麼關係？

回到這個系列的起點，Unity 開發不是只改 C#。一個真實工作迴圈可能包含修改 Scene 或 Prefab、等待資產匯入與編譯、查看 Console、跑 Edit Mode 或 Play Mode tests、進入 Play Mode 驗證行為，再建立 Build。

把它交給 Agent 時，ADE 的每一項責任都會出現：

| ADE 能力 | Unity 工作中的意義 |
|---|---|
| Workspace boundary | 確認 Agent 修改的是哪個專案、worktree 與資產集合 |
| Structured session | 把編譯、測試、Play Mode、Build 視為可追蹤的工作 |
| Station-owned process | 統一啟動、監督與取消 Unity、測試器及 Build 工具 |
| Durable events | 保存 Console、測試、Build 與 Agent 決策的證據 |
| Approval gate | 在大量資產變更、破壞性操作或發布前交還人工決定 |
| Multiple Clients | 在桌面工作，離開後仍可從其他介面觀察或接手 |

所以 ADE 不是 Unity Editor 的替代品。比較合理的方向，是讓 Unity Editor、CLI、測試與 Build pipeline 都成為 Station 可以協調的工具，而人透過合適的 Client 觀察、批准與修正 Agent 的工作。

Day 002 先把這張地圖畫出來。下一篇會回到 Unity Game Dev 的基準流程，從「修改 → 編譯 → 測試 → Play Mode → Build」逐步拆解：哪些是工具操作、哪些應該成為 session 與 event、哪些地方一定要保留人工 gate。
