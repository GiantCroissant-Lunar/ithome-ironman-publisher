---
title: Day 008：Plugin 能跑還不夠——Dogfood 如何逼 Saturn 重畫 Worker Lifetime
timestamp: "2026-09-08T10:17:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Plugin Architecture
---

# Plugin 能跑還不夠：Dogfood 如何逼 Saturn 重畫 Worker Lifetime

昨天把 Star、Comet 與 Blink 拆成不同的 plugin architecture 實驗後，今天沒有再建立一張 runtime、transport、service replacement 的比較表。

我改看另一個問題：當 plugins 已經能載入、傳遞 typed message、提供 view 與 action，甚至真的啟動 Agent 完成工作時，這套架構還可能缺少什麼？

`bearpunch-saturn` 今天很快走過了一條看似完整的路：domain-free Wasmtime kernel、獨立建置的 product plugins、typed topic bundles、generic view/action，再接上 agent sessions 與不同 CLI adapters。從 UI 發出 prompt，到 Agent 回傳 update，整條路都可以經過 host 管理的 plugin boundary。

Dogfood 也真的成功產生了一個 bounded code change。

但正因為它成功跑得夠遠，另一個問題才變得無法忽略：**Agent worker 的邏輯 owner 是 plugin activation，實體 owner 卻仍是 Station process。Station 一消失，worker、pipes 與 protocol cursor 也會一起消失。**

留下 transcript，不等於留下 conversation。

因此 Day 008 不是要證明 Saturn 已經做完 durable Agent runtime，而是記錄一個 architecture experiment 如何被自己的 dogfood 反駁：typed plugin path 已經成立，worker lifetime 與 durable authority 還沒有。

## 從 Plugin Slice 到 Product Drift

Saturn 在 2026-09-08 從 platform slice 很快長成可操作的 ADE composition。今天的 current committed baseline 是 `main@297c51a`，當日共有十八個 commits。

它的 kernel 刻意不編譯 Session、Agent、Transcript 或 Approval 等 product nouns。Kernel 只處理 package、activation、topic、schema、view、action、ranking、selection 與 host capabilities；agent-specific behavior 則由 `agent-sessions`、`acp-agent`、`agent-clis` 等 plugins 組成。

這個方向延續前幾天的核心假設：

- plugin 之間不直接 import 或呼叫彼此；
- message contract 是 data-only typed topic bundle；
- host 驗證 payload 與 schema，選擇 handler，再送進 per-activation inbox；
- UI 只看 generic views，操作 generic actions；
- process、filesystem 等 effect 仍由 Station capability floor 掌握。

問題不是這些邊界失效。相反地，產品功能能沿著它們快速增加，才讓系統看起來比 foundation 真正能承諾的更成熟。

Session 可以出現在 TUI，prompt 可以送到 adapter，worker 可以啟動，update 可以回來，transcript 也可以寫入 store。若只看 happy path，很容易把這條 vertical slice 說成「durable plugin-first Agent runtime」。

Dogfood 迫使我把證據重新分成三層：

1. **Committed HEAD**：typed messaging、product plugins、process-tree confinement，以及 R1 exclusive state ownership 已提交。
2. **Dirty follow-up**：目前 working tree 還有 serve argument correction、ownership test 增補與未提交的 dogfood review；它們可以說明觀察，不能冒充 HEAD capability。
3. **Design-only gates**：durable event/outbox、independent worker supervisor、reattach、daemon lifecycle 等 R2–R4 尚未實作。

如果不先分層，product progress 很容易遮住 foundation drift。

## Typed Messaging 已經證明什麼？

Saturn 已經證明的，不只是「Wasm plugin 能收到一個 JSON」。一個 prompt 的 product path 會經過多個彼此不直接相依的 activation：

```text
TUI
  └─ act(view, action, input)
       ▼
agent-sessions plugin
  └─ send_pinned("saturn-ade.agents.prompt", ...)
       ▼
BusState::prepare_send
  ├─ 驗證 manifest、topic 與 payload schema
  ├─ ranking／selector 選出 handler activation
  ├─ 建立 pending command 與 generation pin
  └─ 投遞到該 activation 的 inbox
       ▼
acp-agent plugin
  ├─ 透過 process capability 啟動 protocol adapter
  └─ 將 prompt 送進受 Station 管理的 stdin／stdout pipes
       ▼
Agent CLI／app-server
  └─ publish "saturn-ade.agents.update"
       ▼
Host bus fan-out
  └─ agent-sessions 更新 transcript／store，再發出 view-changed
```

這條路徑有幾個重要成果。

首先，`agent-sessions` 不需要 link `acp-agent`。它只送出 host 已知的 typed topic；真正接收者由 manifest、grant、ranking 與 selector 決定。Adapter replacement 因此不是 Session plugin 裡的一個 hard-coded branch。

其次，host 在送出前重新驗證 topic 與 payload，不讓 sender 自己宣稱 contract 已符合。Per-activation inbox 也讓 message 的目的地不是一個模糊的 global callback。

第三，UI action 與 background update 經過同一組 product contracts。TUI 沒有偷偷繞過 plugin path 直接控制 process，adapter 也不能直接修改另一個 plugin 的 transcript。

所以這個 slice 確實證明：**typed plugin composition 足以承載一條真實的 Agent interaction。**

但它沒有證明 interaction 的 lifetime 已經獨立於承載這條 path 的 Station。Message 可以跨 plugin boundary，不代表 process 可以跨 Station restart。

## Dogfood 成功了，也因此暴露問題

今天的 dogfood 不是 mock。紀錄中的 supervising Station 是一份 staged、immutable binary，SHA-256 為 `d70dde2a5fe219e7d7e713fffd01f70f94a1e668e39a6a6006d570dcffc13e87`，process ID 是 `47776`。它透過 Codex app-server adapter 啟動 worker `48112`，讓 Agent 處理一個範圍受限的 `serve` argument parsing 問題。

Agent 產生 patch，新的 candidate binary 也以 process `14808` 啟動。這說明 prompt、worker、code change 與 candidate run 並非紙上設計。

然而，這次 run 仍由 parent 完成許多外圍工作：建立 workspace、處理 approval、排除 build-cache 問題、review、integration、verification 與 cleanup。更關鍵的是，supervising Station `47776` 從頭到尾沒有 restart 或 upgrade。

因此這份 dogfood 最多能支持以下敘述：

> 一個 bounded、受監督的開發任務，經 Saturn plugin path 並在 parent assistance 下完成。

它不能支持三個更強的敘述：

- Agent conversation 已經能跨 Station restart 延續；
- worker 已經能由新 Station reattach；
- unattended CLI development loop 已達成 R5。

如果 supervising Station 當時結束，worker `48112` 仍會被終止。Candidate process 能啟動，也不等於原 conversation 能交接給 candidate Station。

還要再加一層 provenance 限制：dogfood review 目前是 working tree 中的 untracked 文件，serve argument correction 與相關 ownership test 增補也尚未提交。它們是有價值的 follow-up evidence，但不是 `297c51a` 的 committed feature。

## Transcript 活著，不代表 Conversation 活著

目前 Saturn 中，Agent worker 有兩種 owner。

邏輯上，adapter activation 擁有這次 Agent interaction；activation teardown 時，它應該停止相關工作。實體上，child process、process tree、stdin、stdout 與 stderr handles 都由 Station 內的 `ProcessCapability` 擁有。

這個設計對 cleanup 很強。Activation teardown 或 `Host::drop` 會終止 process tree；Windows 上的 Job Object 使用 kill-on-close，連 Station 被 hard-kill 時，最後一個 Job handle 關閉也會清掉 descendants。它避免 orphan worker 留在背景繼續消耗資源。

但 cleanup guarantee 的方向，和 continuity guarantee 正好相反：

```text
Station 結束
  ├─ Job Object handle 關閉
  ├─ worker process tree 被終止
  ├─ stdin／stdout／stderr pipes 消失
  ├─ activation inbox 與 pending command 消失
  ├─ generation pin、adapter state 與 protocol cursor 消失
  └─ remote session identity 若只在 adapter memory，也無法 reattach

Station 再啟動
  └─ agent-sessions 讀到未結束的 durable session
       ├─ 將狀態標為 lost
       └─ append「host restarted: the conversation ended」
```

這個 `lost` 結果是誠實的 failure semantics。它沒有把舊 transcript 偽裝成仍可互動的 live conversation。

重啟後仍能看到的，是已寫入 store 的 session record 與 transcript。沒有存續的，則是 worker tree、pipe ownership、尚未完成的 command、inbox、pin、adapter memory、遠端 protocol session ID 與讀取 cursor。

兩者的差異可以濃縮成一句話：

> **Transcript restoration 是 reconstruction；conversation continuity 是 reattachment。**

前者只需要 durable records。後者還需要一個不隨 Station 消失的 process owner、可交接的 pipe 或 spool、controller epoch、重放規則，以及對「這個結果是否已經提交」的 durable 判斷。

## R1：先確保只有一個 Station 擁有 State

Saturn 的 foundation realignment 沒有直接跳到「讓 worker 永生」。第一個 committed gate 是更基本的 R1：同一份 Station state 在任何時刻只能有一個 owner。

`Host::open` 現在會先取得 OS-held `station.lock`，然後才開 policy、store 並執行 reconcile。這個順序很重要；若先碰 durable state 再搶 lock，第二個 Station 即使最後失敗，也可能已經留下副作用。

Client 行為也一起收緊。普通 client 若 connection 或 authentication 失敗，不再悄悄 fallback 成一個 embedded host。需要 temporary host 時，必須明確使用 `--local`。

這修掉了一個危險的便利性：使用者以為自己連不上既有 Station，實際上卻在同一份狀態旁啟動第二個 authority。若連 single writer 都不成立，後面的 journal revision、outbox ownership 或 worker handoff 都沒有可信基礎。

Committed review 記錄 ownership suite 6 tests passed，以及 full workspace 124 tests passed，其中 host 76、kernel 48。本文這次沒有重跑 Saturn tests，也沒有把 console output保存成新的 receipt，因此只稱它們為 **repository-recorded verification**。目前 dirty follow-up 將 ownership suite 增為 7 tests，但那不是 HEAD 的已提交數字。

R1 解決的是「誰可以寫 state」，不是「誰能讓 conversation 繼續」。它是 durable authority 的前置條件，不是 durable worker 的完成證明。

## R2 到 R5：現在仍只是 Acceptance Gates

Realignment 文件把後續工作拆成更強的 gates。現在最重要的是把它們當作 acceptance criteria，而不是 roadmap 上已經存在的功能。

**R2：durable state、events 與 outbox。** 系統需要明確的 exact revision owner、idempotency identity、command/result commit boundary，以及 crash 後可重放的 outbox。只把 transcript append 到 store，無法回答 prompt 是否已送達、結果是否已提交、重試會不會執行兩次。這一層目前仍是 design-only。

**R3：independent supervisor 與 reattach。** Worker 若要跨 Station restart，實體 owner 必須移出 transient Station。設計中的 supervisor 需要管理 controller epoch、owned pipes 或 spool、worker identity 與 reattach protocol；舊 controller 也必須在新 epoch 後失去寫入權。Saturn 目前沒有這個 supervisor，Windows Job Object 仍把 worker lifetime 綁在 Station 上。

**R4：daemon lifecycle。** Autostart、health、backoff、persistent logs、upgrade 與 recovery policy 都要成為可驗證的 service behavior。目前沒有 production daemon／service lifecycle 可以證明 restart loop 或 unattended recovery。

**R5：CLI development loop。** HEAD 中這個 gate仍是 open。Dirty dogfood review 提供的只是 parent-assisted partial evidence：Agent 完成 bounded patch，但 workspace setup、approval、build troubleshooting、integration 與 cleanup 仍由 parent承擔，也沒有測 Station replacement。

這四個 gate 的順序不能顛倒。先做漂亮的「reconnect」UI，而沒有 R2 的 durable commit truth，會讓新 Station 不知道應該重送還是等待；只有 R2、沒有 R3，則只是更完整地記錄 worker 已經死了。

所以 Day 008 的結果不是「R1 到 R5 完成一半」，而是：R1 已 committed；R2–R4 尚為設計；R5 只有 dirty、parent-assisted 的局部 dogfood evidence。

## Planet 證明的是 Cleanup，不是 Continuity

今天較早建立的 `bearpunch-planet` 提供了一個很有用的小型機制對照，但它不是 Saturn durable worker 的替代答案。

Planet 的 clean `main@e504878` 使用 .NET 10 domain-neutral Station，每個 plugin 放在獨立 worker process；Windows worker 在 create-time 就加入 Job Object，worker 內再用 collectible `AssemblyLoadContext` 做 generation swap。它也實驗 restricted WIT parser、separate `call:*`／`provide:*` grants、plugin → Station → provider broker path，以及 `NotStarted` 與 `Indeterminate` 的 failure distinction。

這些都是必要零件：

- create-time Job placement 能縮小 child 逃離 supervision 的 race；
- per-worker process 能隔離 crash 與 resource lifetime；
- collectible generation 能測 unload，而不必重啟整個 Station；
- call／provide 分權避免「可以提供 service」自動等於「可以呼叫 service」；
- `Indeterminate` 誠實表達 dispatch 後失聯，避免把可能已執行的 call 說成 `NotStarted`。

但 Planet 最強的 worker guarantee 仍是：Station 死亡時 Job handle 關閉，worker tree 跟著死亡。Generation swap 只發生在同一個 worker 的 `AssemblyLoadContext` 內；`UnloadStalled` 也沒有自動 recycle。WIT conformance 目前主要由 tests 顯式檢查，而不是 production 每次 call 的 guard。系統沒有 journal、durable owner、recovery、reconnect 或 state provider；idempotency key 也沒有 durable dedupe owner。

Planet README 記錄 75 tests，本文同樣沒有重跑。

因此 Planet 證明的是 containment 與 cleanup mechanism 可以被做得更精確。它沒有證明 worker continuity。把「Station 死時一定清乾淨」直接改寫成「Station 重啟後可以繼續」，會把 failure guarantee 的方向整個讀反。

## 回到 Unity：Editor Process 應該活過 Station 嗎？

這個問題最後仍要回到 Unity Game Dev orchestration。

Unity Editor 比一般 CLI worker更昂貴，也更有狀態。它可能正在 import assets、進入 Play Mode、執行長時間測試，或持有只能由那個 process 解釋的 scene 與 domain reload 狀態。若 Station upgrade 就無條件殺掉 Editor，cleanup 很乾淨，開發迴圈卻可能付出巨大成本。

反過來說，讓 Editor process 自己活著也不是答案。還需要回答：

- Editor 是由 Station activation 擁有，還是由獨立 supervisor 擁有？
- 新 Station 用什麼 worker identity、controller epoch 與 protocol cursor reattach？
- 舊 Station 或 stale plugin generation 如何被禁止繼續送 action？
- Build／Test command 的 intent、approval、progress 與 result 分別在哪一個 revision commit？
- Pipe 中斷時，重送是 safe retry、duplicate execution，還是只能回 `Indeterminate`？
- Transcript、Unity Console evidence 與 live Editor state，哪些可以 reconstruction，哪些必須 continuity？
- Editor crash、Station restart、plugin replacement 與 machine reboot，是否應該有四種不同的 recovery contract？

Saturn 目前沒有 Unity vertical slice 回答這些問題，Planet 也沒有。外部 supervisor 仍是 architecture acceptance question，不是已完成產品。

今天的 plugin experiment 因此得到一個比「Wasm 還是 process」更具體的結論：

> **Plugin architecture 至少要分開 contract lifetime、control-plane lifetime 與 worker lifetime。只要 worker 仍被 transient Station 擁有，再漂亮的 typed messaging 也只會讓工作更容易開始，不會讓它在 Station 消失後繼續。**

Dogfood 的價值不只在它完成了 patch，而在它讓這個缺口無法再被 happy path 掩蓋。下一步不是宣稱 durable Agent 已完成，而是讓 R2、R3 與 R4 各自留下可以故意殺掉 process、重新接手，仍能判定 truth 的 executable evidence。
