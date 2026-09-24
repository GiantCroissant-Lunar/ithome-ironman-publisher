---
title: Day 021：額度中斷後，工作如何接手——Jupiter 的續接檢查點
timestamp: "2026-09-21T20:47:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Vibe Coding
---

# 額度中斷後，工作如何接手：Jupiter 的續接檢查點

Day 020 從 Sessions 的 Approve 按鈕，追到 Surface、Data、Intent 與真正的 Plugin 呼叫。那條路讓人能透過 Jupiter 操作 Agent；接下來，Jupiter 也被拿來協助開發自己的下一個版本。

這次工作是 B2.2：把已完成的 Bundle v2 內容模型接進兩種 Host，調整 Framework、Station 與 Client 的執行、權限及狀態保存。改動跨越多個 worktrees，實作和驗證都已經進行到一半。

然後，兩個被選定的 Provider 接連用完額度。

Day 004 曾經談過執行者中斷時的 Family Ladder。到了 Day 021，真實開發讓我看到另一個同樣重要的問題：**接手者打開工作目錄時，能否知道哪些內容已經可信、哪些還在修改，以及下一步應該先驗證什麼？**

今天的主角，是留在 repository 裡的一份續接檢查點。

## 十一分鐘內，兩個 Provider 先後停止

B2.2 原本透過 Jupiter 管理的 Agent sessions 派工：OpenCode／DeepSeek 負責實作，Kilo／GLM 負責獨立 review，parent 負責整合與最終驗收。

這裡的 parent，指負責協調整批工作的上層 Agent。

承載派工的 Jupiter Station 固定使用原本的 v1 binary 與隔離 state。候選版本在另外的 checkouts 建置、驗證，讓這批工作有一個穩定的管理端。

交接紀錄留下的時間線如下，時間均為台北時間：

| 時間 | 發生的事 |
|---|---|
| 9/20 23:44 | OpenCode 使用的 DeepSeek Provider 回傳 session usage limit |
| 9/20 23:46 | Commit `16caf11` 記錄授權，指定的 Kilo／GLM sessions 可以接續實作 |
| 9/20 23:55 | Kilo 使用的 GLM Provider 也回傳五小時額度限制 |
| 9/21 00:08 | Commit `a647b99` 保存中斷後的續接要求與驗證狀態 |

第一次中斷後，紀錄指出 parent 保存了三個實作 worktrees，透過 Jupiter 關閉原 sessions，再將剩餘工作交給已獲授權的另一組執行者。

第二次中斷後，checkpoint 記錄了取消與關閉實作 sessions、關閉 idle reviewer，以及停止隔離的派工 Station。接手工作所需的 source、patches 與檢查結果則留在原處。

Provider 回覆裡還出現一個 reset time，但沒有時區。交接文件保留這個不確定性，沒有自行換算成確定的台北時間，也沒有把它當成已安排好的重試。

這次由 parent 協調的交接，有它自己的授權、scope 與證據。Day 004 的 Family Ladder／自動 reroute 屬於另一條實作與驗收脈絡；這次真實 quota 中斷，不能直接拿來替當年的自動機制補上驗收。

## 保存 Worktree 時，也要保存它的身分

工作中斷時，磁碟上的檔案可能全部還在。真正容易遺失的是這些檔案的身分。

哪份是 main？哪份只通過部分 review？哪份包含還沒提交的修補？某次測試通過時，用的是哪個 checkout 的 source？

這次 checkpoint 把它們分開記錄：

| 層次 | 保存的位置／基線 | 當時可以主張什麼 |
|---|---|---|
| Main | `main@32b5a1c` | B2.1 與 V1a／MPS 的既有基線 |
| 已接受的部分 | `codex/bundle-hosts-integration@2220f06` | 已驗收的 Framework 與 runtime／durable identity 子集 |
| Generic Host 工作中版本 | `bundle-hosts-harness@242f5d0` 加上未提交修改 | Restore、保存狀態與 lifecycle 修補仍待獨立驗收 |
| Station 工作中版本 | `bundle-hosts-review@ec99164` 加上未提交修改 | 組裝與 startup preflight 的修補、測試仍在候選範圍 |
| Client 工作中版本 | `bundle-hosts-v2@77b6197` 加上未提交修改 | App、bridge、station-links 的轉換尚未接完 |

這裡 worktree 後面的 commit，指它底下的 committed baseline；真正的工作狀態還包含表中標出的未提交修改。

Parent 另外在 `bundle-hosts-packaging` 保存 Station 修補的 review 副本。`a647b99` 提交的是交接文件，那份尚未接受的 Station source 仍留在 working tree。

所以只傳一句「接著做 `ec99164`」會遺漏資料。接手者至少還需要：

```text
工作目標與允許修改的範圍
checkout 路徑與 branch
committed baseline
tracked diff 與 untracked files
已完成的 review 與測試所對應的 source
仍待處理的 reproduction 與驗收要求
```

今天撰文時重新查看，三個實作 worktrees 都還有未提交內容，main 也仍在 `32b5a1c`。這支持了 checkpoint 描述的分層；它沒有讓候選內容自動變成 main 的能力。

另外，Jupiter 目前沒有 remote。這次保存建立的是本機續接條件，跨機器恢復仍需要另外處理。

## 185 個 Tests 通過後，還有哪些工作

交接文件若只寫「tests passed」，接手者很容易把某一層的結果套到整個變更。

B2.2 的 checkpoint 剛好保存了一組很具體的混合狀態：

| 範圍 | 紀錄中的驗證結果 | 尚未涵蓋的部分 |
|---|---|---|
| Framework 子集 | 177 tests、15 architecture checks 通過 | Generic Host 與兩種產品 Host 的完整整合 |
| Runtime／durable identity 子集 | 52 durable tests 通過、1 ignored；9 runtime tests 與 15 architecture checks 通過 | Station／Client 的實際組裝與完整 gates |
| Parent 複製的 Station 修補 | 185 Station tests 通過 | Conformance 仍有一項失敗 |
| Client 工作中版本 | `app:check` 失敗 | 三處 activation report 的型別與接線尚未完成 |

Station 的 conformance failure 很值得保留。

Architecture model 把測試才需要的 `sha2` 與 `rusqlite` 列進 runtime dependencies；checker 依 runtime dependency tables 比對，因此回報不一致。Checkpoint 要求修正 model 的宣稱，保留 checker 的檢查能力。

Client 端則是另一種未完成：Rust 已往 numeric activation handle 移動，但 `App.tsx` 還把 scope string 傳給 `reportActivation`，`fakeBridge.ts` 與 `App.test.tsx` 也仍保留舊的形狀。

接手者因此得到一個明確起點：完成 activation report 的接線與行為測試。Provider 額度恢復，也不會讓這三處 type errors 自行消失。

還有一組測試，把 Station 的停止邊界說得更清楚：七個 startup-preflight tests 檢查遇到不支援的舊 state／database 格式時，Host 在寫入任何新狀態之前就拒絕。

Parent 刻意把 state opening 移到只讀檢查之前。結果六個拒絕案例都因為產生了寫入而失敗，current-format 的正向案例仍通過。Source 還原後，七個測試再次通過。

這個 negative control 幫交接文件留下了比數量更有用的資訊：後續改動必須保住「拒絕前沒有寫入」這個行為。若接手者只為了修 compile error 改回開啟順序，這組 regression 就應該抓到它。

以上數字與執行結果都來自既有 checkpoint；本次文章工作只核對 Git、source 與紀錄，沒有重跑 B2.2 的測試。

## 換執行者時，重新分配 Review 責任

第一次 quota 中斷後，原本用於 review 的 Kilo／GLM 被授權承接部分實作。

這個改變需要寫進交接，因為角色會影響後續證據的解讀。

如果同一個 session 開始修正 code，它接下來提供的測試結果就是 writer 的驗證。Parent 仍須安排獨立 review，原本另行指派的 read-only reviewers 也繼續維持自己的 scope。

本次紀錄對這件事有三個具體處理：

1. 明確列出哪些 Kilo sessions 可以接續實作，保留 checkout 與允許修改的範圍。
2. 對同時包含 DeepSeek 原修改與 GLM 修正的 commit，記錄兩者的貢獻。
3. 最終 review 與 acceptance 仍由 parent 負責；沒有輸出的 reviewer session，不能被記成 approval。

這也說明為什麼「換一個更有額度的模型」只解決其中一部分問題。新的執行者還要繼承同一個工作目標、source 狀態、未完成的驗證與角色界線。

執行者可以接替實作，但先前沒有完成的獨立檢查仍然要有人承擔。

## 把下一步寫成可以重新驗證的工作

一份有用的 checkpoint，應讓下一位執行者能開始工作，並讓負責驗收的人知道要看什麼。

B2.2 這次留下的順序可以整理成：

1. **先確認 source。** 對照各 checkout 的 baseline、diff 與 untracked files，保留已存在的修補；檢查有沒有後續工作改變了 checkpoint 的假設。
2. **完成 Generic Host 的 restore 驗證。** 對照六個 parent reproductions，驗證保存的 intent、拒絕後修復、retirement 與 supersession；另有六個 view-title／static-data-boundary reproductions 待核對。
3. **完成 Station 的 model 修正。** 修正 runtime dependency 宣告，保留 startup preflight 的行為與對應負向證據。
4. **完成 Client 的接線與 lifetime tests。** 除了消除型別錯誤，還要驗證 subscription 的有效期間，以及延遲抵達的 activation report 如何歸屬。
5. **對整合後的 candidate 做最終驗收。** 從 fresh target 執行完整 checks／tests、A2／M1／H1a／V1a／D3 gates，以及隔離 profile 中的 real-window proof。

第五步尤其需要新的證據。Day 020 的 V1a gates 驗證的是當時的 candidate；B2.2 已改動 identity、Host composition 與 Client bridge，這批 source 必須接受自己的整體驗證。

這份續接文件也把證據放在不同位置：branch 上的 tracked checkpoint 保存接手要求；未提交的 source 留在各 worktree；原始 patches、logs 與 process checks 放在忽略的 `build/_artifacts`。

各自用途不同。交接文件讓後續 session 可以找到方向，原始紀錄支援追查，而真正的實作仍要經過 review、commit 與 integration。若要搬到另一台機器接手，這些本機資料的保存範圍也必須另外核對。

本文主要依據 `a647b99` 版本的 `docs/briefs/20260920-b2-2-bundle-hosts.md`，以及本次讀取到的 worktree 狀態。B2.2 在這個時間點仍未完成，main 維持昨天已驗收的基線。

## 回到 Unity：把長流程留在可接手的位置

如果這次工作換成 Unity Game Dev，Agent 很可能在以下任何一個位置遇到 quota：

- 已修改 `.cs`、UXML 或 shader，還沒等待編譯結果；
- Edit Mode tests 跑完，Play Mode tests 尚未開始；
- batch-mode Build 已啟動，Agent 還沒讀取最後的 result；
- code 已提交，但 reviewer 尚未確認場景或 prefab 的變化。

這時一份續接資料可以沿用相同結構：

| 需要保存的資訊 | Unity 工作中的例子 |
|---|---|
| Source 身分 | Commit、未提交的 scripts／assets／meta files |
| 執行中的工作與 owner | 哪個 Editor／Build process 屬於這次任務、目前是否仍在執行 |
| 已驗證範圍 | 哪份 source 跑過哪組 tests、使用什麼 Unity 版本與 build target |
| 尚未完成的檢查 | Play Mode、場景操作、Build artifact 驗證或人工視覺 review |
| 下一步 | 先讀結果、等待現有 process，或在確認狀態後啟動新的工作 |

特別是 Build：Agent 停止回應時，Build process 可能仍在執行。接手者要先找到原工作的 owner 與結果，再決定後續操作，才能避免重複啟動或誤用舊 artifact。

這些是從本次交接整理出的 Unity workflow 原則，目前尚未形成 Jupiter 的 Unity consumer。

Day 021 留下的是一個可以繼續工作的現場：已接受的子集有 commit，工作中的修改有位置，失敗有可重現的原因，尚未執行的 gates 也有名字。下一位執行者拿到這些資料後，第一步就能從核對 source 與補完驗證開始。
