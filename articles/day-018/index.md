---
title: Day 018：Stop 不是 Dispose——Jupiter 如何讓 Drain 在最後一個 Call 後自行完成
timestamp: "2026-09-18T10:17:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Plugin Architecture
---

# Stop 不是 Dispose：Jupiter 如何讓 Drain 在最後一個 Call 後自行完成

Day 017 把 Jupiter 的 bundle 從「一個 executable file」擴成完整的 byte closure：manifest、entry artifact 與每個 resource 都進入 admission、identity 和 immutable staging。

但 package 被安全地安裝，只回答了生命週期的前半段。

當 plugin 已經啟用、正在處理 call、甚至擁有 host 代管的 process 時，另一個更難的問題才出現：

> Operator 按下 Stop 或 Uninstall 後，什麼時候才可以說這個 activation 真的結束了？

今天 Jupiter 的 `main` 有多條進展：M1 MCP host 已收斂、A2 agent sessions first form 已合入、U1 建立 UI token pipeline；H1a HTTP capability 則仍停在 branch 與 working draft。Day 018 不打算把它們全部寫成 commit 流水帳，而是選擇 A2 真正暴露、F1 正面修掉的一個 lifecycle defect：

> 一個 activation 已被撤下，但最後一個 in-flight call 尚未結束時，誰負責在 call 結束後再推進一次 teardown？

F1 經 `de31e37`、`6ba9749` 實作，`0f8554d` 完成 parent review，最後由 `78b4ff0` 合入本次盤點的本機 `main@fb862cc`。

這個 repository 沒有 remote/upstream；今天也沒有重新執行 Jupiter tests。文中的測試數、load loop 與 gate 都是 `f1-receipt.json` 的 historical evidence，不是本次 fresh run。

## Bug 不是 Uninstall 失敗，而是成功得太早

F1 的問題最早由 A2 agent sessions 的測試放大。

A2 的 adapter plugin 可以透過 Station 的 process capability 啟動一個 agent process。這個 process 不是 plugin 自己任意 spawn 後丟著不管，而是 host-owned resource：activation 結束時，capability 的 `release(activation)` 應該回收它。

測試原本希望這件事成立：

```rust
host.uninstall(&adapter).unwrap();
assert!(host.processes().is_empty());
```

但在 agent stdout 剛好有一行正在送進 adapter 時，`uninstall()` 可能先回 `Ok`，process 卻仍存在。

表面上像 process cleanup 太慢，真正缺口在 framework reconcile：

```text
uninstall records intent
    -> reconcile withdraws activation
    -> one call is still in flight
    -> activation stays Deactivating
    -> reconcile converges and returns
    -> uninstall answers Ok
    -> call later finishes
    -> nobody schedules another reconcile
```

每一步單獨看都合理：

- 不能在 call 執行中強制 dispose activation；
- 已要求 stop，就不應再接受新 eligible calls；
- reconcile 沒有可立即執行的變更，可以結束這一輪。

問題是最後一個 call 結束本身，不會自動再觸發一次 reconcile。

所以這不是「uninstall 回傳 error」的顯性失敗，而是更危險的半完成狀態：command 成功、publication 已撤下，activation 與它擁有的 resources 卻可能一直留在 `Deactivating`。

## 一次 Reconcile 為什麼不夠

Jupiter 的 lifecycle 核心仍是 desired state reconciliation。

當 installation 正在 `Active`，但出現以下任一條件：

- `desired == Stopped`；
- `remove == true`；
- 已有新的 revision supersede 它；

`apply_stops` 會先：

```text
unpublish activation from registry
    -> live.withdraw()
    -> published = false
    -> state = Deactivating
```

這個順序保證新 work 不再選到它，但舊 work 仍可完成。

下一個 reconcile pass 看見 `Deactivating` 時，會查 runtime adapter 回報的 `in_flight()`：

```rust
if in_flight == 0 {
    tear_down(...);
}
```

如果仍是 1，這一 pass 不做任何 mutation。當其他步驟也沒有變化，reconcile 便達成它自己的正確結論：**目前 observed state 已經盡可能靠近 desired state。**

這裡要區分兩種「完成」：

```text
reconcile pass completed
    != lifecycle transition completed
```

Reconcile 是一次狀態推進，不是永遠存活的 scheduler。

而 `Snapshot` 只讀 state，不會偷偷 reconcile。最後一個 call 即使在一秒後結束，若沒有另一個 command、event path 或 host shutdown 再呼叫 `reconcile()`，舊 activation 就沒有第二次被檢查的機會。

F1 修的不是 `in_flight` 計數，而是**完成 drain 的觸發責任**。

## Stop、Uninstall 與 Replacement 需要不同承諾

最直覺的修法，是讓所有 lifecycle operations 都等到舊 activation 消失。

但這會破壞 hot replacement。

假設 A 正在處理一個長 call，同時安裝 B：

```text
A serves old call
B prepares and activates
B becomes current for new calls
A drains old call
A is disposed
```

`install(B)` 必須在 B 成功 publication 後盡快回答。它不能因為 A 的舊 call 卡住五秒、三十秒甚至更久，否則「candidate 先準備、成功後切換、incumbent 只 drain 已接 work」的價值就消失了。

相反地，直接呼叫：

```text
uninstall(A)
stop(A)
```

通常帶有更強的同步期待：command 回覆時，operator 希望 A 已不再執行，而且 host-owned resources 已釋放。

因此 F1 沒有用一個全域 `awaitDrain` flag，而是分成兩層：

| Caller | 回覆承諾 | Drain 如何完成 |
|---|---|---|
| `uninstall` | 在 bound 內等待 dispose；超時仍回覆 | admin wait，剩餘部分交 watcher |
| `set_desired(Stopped)` | 在 bound 內等待 stop；超時仍回覆 | admin wait，剩餘部分交 watcher |
| `install`／`install_as` | 不等待被替換的舊 revision | watcher |
| `set_desired(Running)` | 沒有 drain，不等待 | ordinary reconcile |
| `shutdown(grace)` | 保留原有 grace loop | shutdown 自己負責 |

這個切分保留了兩種不同的產品語意：管理命令要 bounded confirmation，replacement 要 non-blocking handoff。

## 第一層：管理命令做 Bounded Wait

`uninstall` 與 `set_desired(..., Stopped)` 在第一次 `reconcile()` 後，會進入共用的 `wait_for_drain(bundle)`。

Policy 新增：

```rust
drain_wait_ms: 5_000
```

這個 default 是 reasoned，不是精密量測得出的 SLA：

- 高於 Station 原有 2 秒 shutdown grace；
- 低於 10 秒 `host_io_deadline_ms`；
- 遠低於 protocol client 60 秒 reply deadline。

Wait loop 每次只做三件事：

1. 找出該 bundle 仍為 `Deactivating` 的 installations；
2. 若其中有 activation 已降到 `in_flight == 0`，跑一次 reconcile；
3. 否則 sleep 共用的 20ms poll interval。

它不在兩次 poll 之間持 framework lock，也不在 call 還沒 ready 時每 20ms 重跑完整 reconcile。

後者很重要。每一個 reconcile pass 都會詢問 retention index、更新 registry facts、routing 與 events；等待中的 call 沒有變化時，重做整套工作只是在 busy polling。

若 drain 在五秒內結束：

- `uninstall` 回覆時 installation 已 retire，runtime 已 drop，capabilities 已 release；
- `stop` 回覆時 installation 留在 `Installed`，activation 與 resources 已釋放，可再切回 `Running`。

這才恢復 A2 測試原本想表達的語意：

```rust
host.uninstall(&adapter).unwrap();
assert!(host.processes().is_empty());
```

不是「通常過一下就會空」，而是 normal bound 內 command 回覆時就已經空。

## 超過 Bound：Ok 不代表已 Dispose

如果 call 超過 `drain_wait_ms`，F1 不會把它 kill，也不會把 stop intention rollback。

管理命令仍回 `Ok`，但 installation 保持：

```text
state: Deactivating
in_flight: N
diagnostic: Draining: N call(s) still in flight after M ms;
            disposal follows the last one
```

Framework 還會再跑一個 pass，讓帶有 diagnostic 的 `installation` event 在 command 回覆前已進入 event log。

這裡的 `Ok` 精確表示：

> Stop／uninstall intention 已接受並記錄，新的 eligible work 已撤下；同步等待額度已用完，dispose 尚未完成。

它不表示「process 一定已消失」。

這比 timeout error 更符合目前 contract，因為 operation 不會放棄 stop；但 caller 若需要區分 synchronous completion，必須看 snapshot/event 的 `Deactivating` 與 diagnostic，而不能只看 command success。

當 drain 最後完成，`tear_down` 會把 diagnostic 清掉。Diagnostic 描述的是當時狀態，不應像永久錯誤黏在已停止的 installation 上。

## 第二層：Weak Watcher 讓最後一個 Call 成為觸發點

Bounded wait 只解決管理命令的體驗，無法處理兩種情況：

- replacement 從一開始就不等待舊 revision；
- stop/uninstall 已超過 bound 並回覆。

F1 因此加入 `Framework::watch_drains()`。

它不直接常駐一個強引用 thread，而是先把 `Weak<Framework>` 綁進 framework。每次 reconcile 結束時，`ensure_drain_watcher` 檢查：

```text
not shutting down
and at least one installation is Deactivating
and no drain watcher is already running
and watch_drains was bound
```

條件成立才啟動唯一的 `plugin-drain` thread。

Watcher 每一 tick：

1. 暫時 upgrade weak reference；
2. 在 lock 內檢查是否還有 drain，以及是否有 activation 已 ready；
3. 離開 block，drop lock 與這次 upgrade 的 `Arc`；
4. ready 才重新 upgrade 並跑一次 reconcile；
5. 尚未 ready 就 sleep 20ms，sleep 期間不持強引用。

用 `Weak` 的原因不是微小最佳化，而是 ownership：

> 負責清理 framework 的 watcher，不能反過來成為 framework 永遠無法被 drop 的最後一個 owner。

Self-review 曾發現初版在整個 tick、包括 sleep 期間持有 upgraded `Arc`；正式 commit 前已改成每次只在檢查或 reconcile 時短暫持有。

當沒有任何 `Deactivating` installation，或 framework 進入 shutdown，watcher 會在 lock 內清除 `drain_watcher_running` 並結束。若之後又產生新 drain，下一次 reconcile 可以安全啟動新的 watcher。

## 為什麼 Watcher 不直接每 20ms Reconcile

Watcher 的目的不是建立第二個 reconciliation scheduler。

Call 還在執行時，完整 reconcile 不可能完成 teardown；它只會重讀同樣的 `in_flight > 0`。所以 watcher 的 idle path只檢查 live handles 的計數，不跑 pass。

Parent review 專門增加一個 pinning test：把 retention index 包成 counting probe。Stop wait 與 watcher 同時觀察 held call，跨過十五個以上 poll intervals，`holders()` 問詢數不應增加；直到 call release、真正 disposing pass 執行，count 才再變。

這守住的是 cost model：

```text
poll readiness cheaply
reconcile once when progress is possible
```

而不是：

```text
reconcile repeatedly and hope state eventually changes
```

Negative control 把 watcher 改成每 tick 都 reconcile 時，原本五個功能測試仍會通過；只有這個 counting test 會失敗。它證明 performance／architecture rule 若沒有直接 evidence，很容易被「結果還是對的」掩蓋。

## Shared Composition：兩種 Host 都不能忘記綁 Watcher

只提供 `watch_drains()` API 還不夠。如果 Station 記得呼叫，LinkedHost 忘記，兩種 Host 的 lifecycle semantics 又會分岔。

Day 016 寫過的 `PluginHost<R>` 在這裡再次成為關鍵邊界。

兩種 Host 都透過：

```rust
PluginHost::restore(...)
```

把自己建立的 `Arc<Framework<R>>` 交給 shared composition。F1 在這個入口先呼叫：

```rust
framework.watch_drains();
```

所以：

- Station 的 Wasmtime framework 自動有 watcher；
- app／frontend 的 Webview framework 自動有 watcher；
- `NoRuntime` host 也走同一條路；
- outer Host 不需各自記住 lifecycle plumbing。

Plugin-host suite 還直接驗證 open 後 `drains_watched() == true`。

一個直接使用裸 `Framework`、從未呼叫 `watch_drains()` 的 caller，仍保留舊行為：最後一個 call 結束後，必須等下一次顯式 `reconcile()` 才 dispose。這是 API boundary，不應誤寫成所有 framework instance 都有 background completion。

## Tear Down：最後釋放的是什麼

Watcher 發現 `in_flight == 0` 後，只觸發既有 reconcile；真正的 disposal order 沒有被 F1 另寫一套。

`tear_down` 會依序：

1. unpublish activation；
2. 從 live map 移除並 `withdraw()`；
3. 在適用時呼叫 cooperative `deactivate` hook；
4. 關閉 inbox 並 join worker；
5. fail 尚未回答的 handler calls；
6. forget sender 與雙向 pins；
7. 清除 handler observations；
8. 對每個 host capability 呼叫 `release(activation)`；
9. 清除舊 diagnostic，進入 `Installed` 或 `Retired`。

A2 agent process 就是在第八步由 process capability 回收。

這也解釋為什麼不能在 call 還 in-flight 時直接跳到 `cap.release`：該 call 可能正在使用 process、store、message pin 或其他由 activation 擁有的 capability state。強制釋放會把「bounded administrative response」變成「破壞執行中 work」。

F1 不取消 call。它保證的是：**只要最後一個 call 確實結束，cleanup 不再依賴下一個無關 command。**

如果 call 永遠不結束，watcher也不會越權 dispose；in-flight cancellation 仍是另一個需要獨立 contract 的問題。

## Replacement 仍然不等舊 Code

F1 特別保留一條既有 test：A 正處理 held call 時安裝 B。

正確結果是：

```text
install(B) returns quickly
B is current and serves new calls
A remains Deactivating
held call completes on A
watcher disposes A
```

不是：

```text
install(B) waits up to drain_wait_ms for A
```

Parent review 甚至植入一個 negative control，讓 install 也等待。舊 replacement assertion 因為等五秒後仍看見相同狀態，未必能直接抓到 latency regression；F1 的新 test 因此明確要求 `install` 在遠低於 `drain_wait_ms` 的時間內回覆。

這提醒一件事：state assertions 相同，不代表 temporal contract 相同。

Plugin system 的 correctness 不只包含最後有哪些 installations，也包含：

- 新 revision 何時開始服務；
- 舊 call 是否仍由舊 code 完成；
- 管理命令何時回覆；
- resource release 發生在回覆前還是之後。

## Receipt：從 483 到 485，新增的是兩個被 Review 找到的證據

F1 worker 先記錄：

- framework 123 tests；
- plugin-host 24；
- Station 148；
- workspace 483 passed、0 failed、1 ignored；
- A2 gate `GATE PASSED`；
- 原本容易出錯的 agent process case 連跑 10 次皆通過。

Parent review 又找到兩個未被原測試 pin 住的行為：

1. wait／watcher 不應在每個 poll 都跑 reconcile；
2. disposal 後不應留下 `Draining:` 或舊 `unready:` diagnostic。

加入兩個 tests 後，merge follow-up 記錄：

```text
framework: 125
workspace: 485 passed, 0 failed, 1 ignored
```

更有辨識力的是 load loop：

- 正式 fix：agents suite 在相同 load 下 6/6 無 failure；
- 只移除 admin waits、保留 watcher：6/6 都在 process-release assertions 失敗。

這證明 watcher alone 雖能 eventual cleanup，卻不能滿足「uninstall／stop 回覆時 process 已釋放」的同步 contract。

Negative controls 也分別移除：

- watcher spawn；
- uninstall wait；
- stop wait；
- diagnostic unconditional clear；
- cheap readiness polling；
- replacement 的 non-wait rule。

它們不是本次重跑結果，而是 committed receipt 的 historical evidence。今天只能說 current main 包含這些 code 與 receipts，不能說我重新驗證了 485 tests 或 live window。

## 一個尚未關閉的 Persistence Gap

F1 關閉的是 framework lifecycle gap，但 receipt 明確留下 host persistence gap。

`PluginHost::uninstall` 的順序是：

```text
framework.uninstall(bundle)
    -> save_state()
```

若 drain 在 `drain_wait_ms` 內完成，framework 已移除 installation，save 會把 record 一起刪掉。

但若 timeout：

1. framework uninstall 回 `Ok` 時，installation 仍在 `Deactivating`；
2. `PluginHost::save_state()` 仍把它視為 live record；
3. watcher 之後完成 framework teardown；
4. watcher 不知道 host records，也不會再寫 `state.json`；
5. 若 host 在下一次 save 前被終止，reopen 可能重新 restore 該 bundle。

所以 F1 不能宣稱「timeout 後 framework 與 persisted install records 已原子收斂」。

可能的後續需要 host-side subscriber，或在 framework call 前先記錄 removal intent；但兩者都會改 persistence ordering，必須有自己的 tests，不能順手塞進 F1。

另一個 review boundary 是 Weak ownership：code 明確不在 sleep 期間持 `Arc`，既有 drop tests 也通過；但沒有直接 test「framework 正在 drain 且 watcher 正在 sleep 時，所有外部 Arcs 被 drop」。這部分仍是 source review 加鄰近 evidence，不應誇大為完整 proof。

## 回到 Unity：Disable Component 不等於背景工作已停止

同一個問題在 Unity tooling 很常見。

想像一個 Editor extension 正在：

- 執行 AssetDatabase scan；
- 等待 UnityWebRequest；
- 讀取一個大 texture importer result；
- 驅動 batch-mode build child process；
- 回傳 agent command 的最後一段 output。

此時 operator disable 或 replace extension。

安全的 lifecycle 不是立刻 destroy everything：

```text
withdraw from new command routing
    -> mark Deactivating
    -> let admitted callbacks finish
    -> release editor hooks, processes and temp resources
    -> mark Stopped or Retired
```

但只把狀態設成 `Stopping` 也不夠。最後一個 callback 結束後，必須有人再推進 cleanup。

可以沿用 F1 的雙層模型：

```text
Editor command path
    bounded wait for ordinary stop/uninstall

Lifecycle watcher
    observes in-flight count
    runs one cleanup pass when progress becomes possible
```

Replacement 則不能跟 stop command 共用相同等待語意。新版 importer 或 build plugin 應在 ready 後接新 work，舊版只完成自己已接的 callback；安裝新版不應被舊 callback 的 drain deadline 阻塞。

Unity 端也要避免 watcher 自己變成 leak：若 `EditorApplication.update` callback、static event 或 background task 持有 extension 的最後一個 strong reference，原本為了清理而建立的 watcher，反而會讓 domain／assembly 永遠無法卸載。使用 weak ownership、明確 unsubscribe 與 single-watcher guard，都是同一個問題的不同語言版本。

最後，timeout success 必須保持誠實。UI 可以顯示「Stop accepted, 1 callback draining」，不能只把按鈕變成綠色 Done；persisted project state 也不能在 runtime cleanup 尚未完成時假裝已完全移除。

Day 018 的 F1 沒有發明新的 plugin state machine，也沒有強制取消執行中的 work。

它補上的是 lifecycle 最容易遺失的一個觸發點：第一次 reconcile 已經做完能做的事，而最後一個 call 稍後才結束時，framework 仍會在正確時機再跑一次，而且只跑需要的那一次。

**Stop 是 intention，Deactivating 是承諾，而 Dispose 必須有一條不依賴下一個偶然 command 的完成路徑。**
