---
title: Day 022：一個 Bundle，多個生命週期——Jupiter 如何處理部分升級與混合版本
timestamp: "2026-09-22T10:17:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Plugin Architecture
---

# 一個 Bundle，多個生命週期：Jupiter 如何處理部分升級與混合版本

Day 021 留下的，是兩次額度中斷後仍可接手的工作現場：已接受的子集、未提交修改、失敗原因，以及接手者需要補上的驗證。

後續工作接了起來。B2.2 在 9 月 21 日晚間透過 `db1e9e7` 合入 main，兩種 Host 正式切換到 Bundle v2。9 月 22 日凌晨，B2.3 又由 `0c00af5` 整合，移除每個 Bundle 在單一 Host 上只能選一個 executable component 的限制。

今天從這個改變帶來的一個具體情境開始：

> 同一個 Bundle 裡有兩個元件。升級時，一個新版成功啟動，另一個新版失敗。現在這個 Bundle 到底在跑哪一版？

這個問題同時牽動 routing、lifecycle、狀態保存與畫面。只要元件能各自升級，系統就需要完整描述這個中間狀態。

## 共同交付的 Bytes，各自執行的 Component

先接回 Day 017。當時 Bundle 把 executable 與 resources 一起納入 identity，確保程式、圖片、JSON 與其他資產跟著同一份 revision 交付。

Bundle v2 往前拆了一層：`content[]` 宣告 bytes，`components[]` 宣告各個語意單位，以及它們使用的 driver、entry、content 與 permissions。Host 組合自己支援的 drivers，再接納被選取的 components。

B2.2 已把這個模型接進實際 Host，但先保留一個限制：同一 Bundle、同一 Host，最多選取一個 executable component。B2.3 才讓多個 executable components 同時成立。

因此需要把幾個身分分開：

| 身分 | 表示什麼 |
|---|---|
| Bundle revision | 一整份已接納內容的精確版本 |
| `(bundle id, component id)` | 持續存在的邏輯元件，例如某個 Bundle 的 `a` |
| `(bundle revision, component id)` | 該元件在某份交付內容中的精確身分 |
| Activation | 這一次真正啟動的執行生命週期 |

例如 `R1:a` 與 `R1:b` 共用同一份 Bundle revision，但各有自己的執行生命週期。`R2:a` 是 `a` 的新候選；它成功後，應替換的是 `R1:a`。

Framework 的替換比對因而同時檢查 bundle 與 component。另一個 component 的 in-flight call、權限範圍與 content handle，仍由它自己的身分管理。

這裡的 `R1`、`R2` 是方便閱讀的 revision 簡稱，實際保存的是完整的內容身分。

## 升級一半時，把 Serving 與 Candidate 一起留下

Station 的實際 Wasm 測試，把 Board 與 Analyzer 放進同一個 Bundle：component `a` 是 Board，component `b` 是 Analyzer。

第一份 revision 中，兩個元件都成功啟動。第二份 revision 則刻意換入啟動會失敗的 Analyzer。

結果是：

| Component | 升級前 | 安裝 R2 後提供服務的版本 | 候選狀態 |
|---|---|---|---|
| `a`：Board | `R1:a` | `R2:a` | 新版已成功接手 |
| `b`：Analyzer | `R1:b` | `R1:b` | `R2:b` 啟動失敗，保留 diagnostic |

`a` 的升級已完成，`b` 則由舊版繼續服務。這讓既有能力得以保留，同時留下新版為何失敗的資訊。

此時 `install` 可以成功回覆，因為 package 已通過 admission，失敗發生在後續 activation。對同一份 package 做靜態 `diagnose`，也可能得到空的診斷陣列；這個查詢沒有執行 activation。

所以安裝結果需要帶出 lifecycle observation，讓呼叫者知道接納之後實際發生了什麼。

B2.3 的 `BundleStatus` 由 Framework snapshot 計算，包含每個 component 的：

- `serving`：目前提供一般服務的精確 revision；
- `candidate`：仍在處理或已失敗的候選，以及失敗原因；
- `retained`：為既有 durable owner 保留的舊 revision；
- `disposition`：這個元件目前是 serving、pending、failed 或 absent。

Bundle 層另外列出 `serving_revisions`。在上面的案例，它會同時包含 R1 與 R2，並回報 `complete: false`。

這份 aggregate 一路傳到 Host observation、SDK 與 Plugins panel，讓畫面列出各元件的版本、候選錯誤，以及 `mixed` 提示。

`complete` 的含義還需要精確閱讀。目前實作條件是「serving revisions 至多一份，而且沒有被回報為 failed 的 candidate」。它沒有逐項要求所有元件都已 Active；判斷是否可執行某項工作，仍要讀取各元件的 lifecycle 與 availability。

另一個容易混淆的情況是 retained revision。假如 R2 的 `a`、`b` 都已接手，而 `R1:a` 只為舊 owner 保留，它應出現在 `retained`，不應再加入目前的 `serving_revisions`。Parent review 曾抓到這個分類錯誤，並補上修正與測試。

## 呼叫與 Stderr 都要說清楚是哪個 Component

一個 Bundle 只有一個 executable component 時，呼叫只指定 bundle 就足以找到目標。

同時存在兩個之後，原本的簡寫就需要明確規則。

B2.3 保留省略 component 的形式：當 Bundle 恰好只有一個 current executable component，可以直接解析到它；如果有多個，就在執行 effect 前回傳：

```text
component/ambiguous
candidates: a, b
```

呼叫者也可以使用明確指定 component 的入口：

```text
invoke_component(bundle, component, interface, function, params)
```

Station CLI 的 `invoke`、`invoke-in` 與 `stderr` 接受 `<bundle>:<component>`，protocol command 也有對應的 `component` 欄位。

測試裡，明確呼叫 `b` 的 Analyzer API 會成功；明確呼叫 `a`，則得到它沒有 export 該 API 的真正原因。若省略 component，即使呼叫者覺得只有 Analyzer 應該認得這個 API，Host 仍依規則回報 ambiguity。

`stderr` 也採取相同選擇規則。否則畫面可能正在顯示 `a` 的狀態，卻拿到 `b` 的錯誤輸出，讓診斷從第一步就找錯對象。

這裡還有一個 review 發現的 coverage gap：把 declarative components 也算進 executable 候選數量後，原本整套 Station tests 仍然通過。

Parent 因而新增「一個 executable，加上 declarative siblings」的測試，再植入相同錯誤，確認測試真的會失敗。Declarative component 沒有自己的 executable activation，不能讓原本唯一的 stderr 來源變成 ambiguous。

## Host 重開後，還原同一個混合狀態

升級過程中發生的事，必須進入持久化紀錄。

如果只保存「這個 Bundle 已安裝 R2」，Host 重開後就無法知道 `b` 的新版曾經失敗，也可能丟失仍在服務的 `R1:b`。

B2.3 的 host records 使用 `bearpunch.host-records/v2`，每個 component row 保存精確 identity、desired state、disposition、driver implementation，以及失敗 diagnostic。被替換的 row 還會保存精確 successor：

```text
R1:a → superseded_by R2:a
R1:b → 仍是 Current
R2:b → Failed
```

Successor 必須指向同一個邏輯 component 的後繼版本。Records validation 會拒絕退休卻沒有 successor、指向自己，或指向另一個 component 的紀錄。

Generic Host 的測試把這個情境走到 reopen：

1. 重新建立 `R2:a` 與 `R1:b` 的 serving activations。
2. 保留 `R2:b` 的 Failed 狀態與 diagnostic。
3. 確認只 instantiate 兩次，失敗候選沒有被重新執行。
4. 透過明確的 `retry_component`，才讓已可成功啟動的 `b` 再試一次。
5. 當兩者都提供 R2，aggregate 收斂到單一 serving revision。

Station 另有 in-process reopen 與真正 compiled binary 的測試，確認 `list` 仍能看到相同的混合狀態。失敗 row 的 `no_retry` 讓一般 reconciliation 保留原本的失敗，而不是把重開 Host 當成一次新的重試授權。

這裡的 explicit retry 證據來自 Framework／Host 測試；目前還沒有把 `retry_component` 暴露成 wire command 或 UI 操作。

Retained work 則更進一步要求精確版本。若某個 owner 保留 `R1:a`，`b` 的替換與退休不能消除這份依賴。兩個元件雖然各自執行，R1 的 bytes 仍共用同一個 staged package directory。

對應測試刻意移走 R1 的 staged directory，再 reopen。Host 會把缺少的 revision 記成可修復的拒絕，不拿 `R2:a` 或另一個 component 代替；放回原 package 後，再次 reopen 才恢復對應的 retained realization，並清除先前的 refusal。

至於舊格式的 host records，這次仍採只讀 preflight 拒絕，沒有自動 migration。恢復所依賴的資料形狀已改變，必須讓操作端知道自己拿的是哪一種 state。

## Driver 也要宣告如何替換

Component 的生命週期可以獨立管理，底下的執行環境卻未必支援相同的替換方式。

Wasm 或 webview module 可以走 candidate-first：先準備新候選，成功後再讓舊版退出。某些執行環境可能只能容納一個版本，另一些則要等整個 Host 重啟。

B2.3 因而讓 Driver 宣告：

| Replacement mode | 宣告的能力 |
|---|---|
| `CandidateFirst` | 可以讓候選與 incumbent 並存，先準備新版 |
| `StopStart` | 需要先停止舊版，才能啟動新版 |
| `RestartRequired` | 需要重啟 Host 或底下的執行環境 |

目前真正執行的仍是 candidate-first。當已有 serving incumbent，而新候選的 driver 宣告其他模式時，Framework 會在插入任何候選之前回 `driver/replacement-unsupported`。

這讓呼叫端能取得明確的拒絕；自動 stop-start 或 restart 的流程仍未實作。Restore 則按既有 records 還原，沒有把這項 live replacement 檢查當成重新選擇版本的機會。

每個 realization 也開始記錄 `driver_implementation`，例如包含 runtime crate 與 Wasmtime 版本的識別字串。它讓診斷能對照「相同 component revision 是由哪個 driver build 執行」，目前作為 provenance 保存，尚未被用來決定 policy。

## 驗收結果與今天仍能讀到的證據

本次盤點的 Jupiter 是乾淨的本機 `main@f038440`。B2.3 的 Framework、records、Host／SDK slices，依序由 `a0649ad`、`e580cbd`、`f314555`、`1453697`、`c67f52e` 完成；`fc75075` 加入 parent follow-up，最後由 `0c00af5` 整合。

`docs/architecture/b2-3-receipt.json` 記錄：

| 驗證範圍 | 收據中的結果 |
|---|---|
| `c67f52e` 的完整 sweep | Rust 746、JavaScript 138；29 tasks 完成 |
| Writer 的獨立測試 | Python 30 tests |
| Parent follow-up | 新增 regression 後，Station 191、conformance 15 通過 |
| `fc75075` 的 live gates | A2、M1、H1a、V1a、D3 通過 |
| 多元件的行為 | 部分升級、重開還原、精確 retention、明確呼叫與拒絕 ambiguity |

這裡保留各次執行所對應的 source，沒有把新增一個測試後的總數，寫成另一輪完整 sweep 的結果。

畫面證據也有範圍：當時的 real-window gate 顯示每個 component 的版本資訊，但第一方 app bundles 都仍是單一 module。多元件的 `mixed` 提示由 workbench 測試與 app-core bridge 測試支撐，沒有實際視窗中兩個 modules 混合升級的截圖證據。

另有一項重要的保存缺口。9 月 22 日的 receipt annotation 記錄，清理已合併 worktrees 前，原本預計複製的 artifacts 因 `robocopy` 參數轉換而失敗，後續移除卻仍繼續執行。部分 slice logs、parent reruns、controls 與 gates 原始結果因此遺失。

今天核對時，B2.3 review 與 integration worktrees 確實已不存在；main checkout 的 dispatch 目錄仍在。Code、測試、commits 與 receipt 中記錄的 counts／verdicts 可讀，但收據裡若干原始路徑已無法開啟。

所以本文的執行結果引用的是 repository-recorded evidence。本次沒有重跑 Jupiter tests，也沒有重新讀取已遺失的原始 logs 或 screenshots。

這也接回 Day 021 的交接主題：保存工作時列出證據位置之後，清理前仍要驗證那些檔案已實際搬到預定位置。

## 回到 Unity：共同交付，逐元件升級

把這個模型帶回 Unity，可以想像一個工具 Bundle 同時包含：

- 資產檢查器，產生 findings；
- Editor 面板，顯示診斷與操作；
- Build adapter，管理背景 build request；
- 三者使用的 schema、圖示與設定資產。

以上是應用構想，這次 B2.3 沒有實作 Unity consumer。

這些內容可以一起交付，同時保有不同的生命週期。新版面板可能已成功載入，Build adapter 卻因環境問題啟動失敗；此時應讓操作端看到哪個 component 使用新版、哪個仍由舊版服務，以及失敗候選的原因。

已經開始的長時間 Build，還需要它原先綁定的精確 adapter 與資產。即使新的工作開始使用 R2，舊工作使用的 `R1:build-adapter` 也必須有清楚的 owner 與保留條件。

但允許部分升級，代表產品還要處理版本共存。若新版面板只理解新的 Build API，就必須把相容性要求放進契約與 readiness 檢查；per-component replacement 本身不會替兩個任意版本保證相容。

Unity 的不同執行環境也需要各自驗證 replacement mode。需要 Editor reload 或 process restart 的部分，應明確宣告，再由 workflow 安排切換時機。

當 Agent 下一次看到「安裝成功」，它就還需要讀取各元件的 serving revision、candidate 與 readiness，才能決定下一個動作。從共同交付的一份 Bundle，走到各自可觀察、可替換、可恢復的生命週期，才讓這些決策有足夠的狀態可以依據。
