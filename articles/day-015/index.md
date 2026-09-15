---
title: Day 015：重開 Jupiter——Clean Main 不等於 Clean Project
timestamp: "2026-09-15T10:17:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Plugin Architecture
---

# 重開 Jupiter：Clean Main 不等於 Clean Project

Day 014 最後留下的結論是：**文件不是功能；好的文件是 claim 的型別系統。**

今天我沒有繼續處理 Saturn，而是重新打開另一個已經放了一段時間的 repository：`bearpunch-jupiter`。目標也不是立刻增加功能，而是先整理它。

這聽起來像行政工作，實際打開後卻先遇到一個 architecture 問題：

> `main` 的 working tree 很乾淨，能不能就說「目前狀態很清楚，可以繼續開發」？

不能。

因為 Git 的 clean 只描述**目前這個 worktree**；它不會自動把 linked worktrees、尚未合入的 candidate commit、review 後的未提交修補、歷史 receipts，以及從未重跑的 validation 一起壓成一個可信的現在式。

所以 Day 015 沒有新 Jupiter feature。今天先做的是 **Re-entry Baseline**：在重新進入一個專案時，把「已提交的基線」「候選版本」「工作中草稿」「歷史驗證」與「仍未知的狀態」重新分層。

## 從 Saturn 切回 Jupiter，不是把 Repository 打開就算接手

重新打開舊專案時，最危險的第一步通常不是改錯 code，而是太早相信自己已經知道現在在哪裡。

這次盤點 `bearpunch-jupiter` 的主 checkout，得到的是：

```text
branch: main
HEAD: 614e248d12e14300a67ff3c345453848ff928aae
working tree: clean
remote: none
upstream: none
fresh validation in this re-entry: not run
```

`614e248` 的 commit subject 是：

```text
build: merge J2c Phase C, Station identity and the hello; J2c delivered
```

這組資料至少回答了五件事：

1. 目前主 checkout 在 `main`；
2. tracked tree 沒有 staged 或 unstaged change；
3. 這個 checkout 沒有設定 remote 與 upstream；
4. `main` 的 Git history 已經走到 J2c Phase C；
5. 本次重新開啟後，還沒有新的 test/build receipt。

但它沒有回答：

- 其他 worktree 是否乾淨；
- 是否有尚未合入 `main` 的功能候選；
- ignored artifacts 是否與 current source 對得上；
- 歷史文件中的「delivered」是否仍對應目前 checkout；
- 下一步應該延續哪一條 branch。

換句話說，`git status` 是必要的起點，卻不是完整的 project status。

## 第一個快照：Main 很乾淨，但它只回答一個問題

`clean main` 的精確意思只是：

> 相對於 `main@614e248`，目前主 worktree 的 index 與 tracked files 沒有差異。

它不代表：

- 所有 local branches 都已合入；
- 所有 linked worktrees 都沒有修改；
- 所有測試都針對這個 SHA 通過；
- repository 已推送到某個 remote；
- ignored 的 `target`、`dist`、`node_modules` 或 cache 可當成 acceptance evidence；
- architecture documents 已經收斂成同一個 current status。

尤其 Jupiter 目前沒有 remote/upstream。這表示我不能把「local commit 存在」寫成「已同步、可由其他環境取得」。即使 working tree 再乾淨，也沒有 remote ref 可以替這句話背書。

這正好延續 Day 014 的 claim boundary：

```text
clean checkout
    != all worktrees clean
    != all candidates merged
    != current validation passed
    != remotely recoverable
```

如果整理的第一步就把這些狀態混在一起，後面即使 test 綠了，也很難說清楚到底驗證了哪一份 source。

## Repository 不是一條線，而是一張狀態圖

把 linked worktrees 一起納入後，Jupiter 的狀態不再是一個 `HEAD`，而是一張小型狀態圖：

| Layer | 盤點到的狀態 | 目前可以說什麼 |
|---|---|---|
| Main baseline | `main@614e248`，主 worktree clean | J1–J2c 與 J2d D1 已存在於 main history |
| J2c worktree | `j2c/two-hosts@bdb9811`，tracked tree clean | branch 已落後 main 的 merge commit，不是新的 current baseline |
| D2 candidate | `j2d/client-app@49dcd1d` | 有一筆 branch-local D2 candidate，但尚未進 main |
| D2 review draft | D2 worktree 有 16 個 unstaged tracked files | review follow-up 正在草稿狀態，尚無 commit 或新 receipt |
| D2 parent snapshot | detached `49dcd1d`，tracked tree clean | 可用來比較 candidate commit，不代表 dirty fixes 已驗收 |
| Validation | 只有既有 committed receipts | 本次 re-entry 尚未取得 fresh green result |

其中最需要小心的是 `j2d/client-app`。

它的 commit `49dcd1d`：

```text
feat(client-app): the client host drives the shell
```

確實是一個已提交的 D2 candidate；但它不是 `main` 的祖先。盤點時的 divergence 是：

```text
main-only commits:   3
branch-only commits: 1
merge base:          3e28287
```

也就是說，D2 candidate 建立在 J2c Phase B 的基線上，而 `main` 後來又納入了 Phase C 的 Station identity 與 capability hello。它不是單純「差一個 merge」而已；合入前要先回答 D2 如何吸收 Phase C 的 identity contract。

更進一步，D2 worktree 在 `49dcd1d` 之上還有 16 個 tracked files 被修改，合計約 348 insertions、98 deletions，全部尚未 stage。

所以「D2 的目前狀態」至少有三個時間切片：

```text
merge base 3e28287
    -> committed candidate 49dcd1d
        -> unstaged review fixes

main 614e248
    -> includes later J2c Phase C changes
```

任何一句「桌面 client 現在支援什麼」，都必須先指定自己說的是哪一層。

## Jupiter 不是空案：已提交的能力邊界

整理不是把 Jupiter 當成全新的空 repository。

`main` 已經有一個可執行、也有 architecture checks 與測試來源的 plugin-platform slice：

- `jupiter-plugin-framework` 提供 domain-free lifecycle、manifest/admission、typed messaging、contribution、policy、retention 與 diagnostics；
- framework 透過 `Runtime` seam 注入執行環境，而不是直接綁死 Wasm；
- `runtime-wasmtime` 是 Station 使用的 component runtime adapter；
- `durable` 提供 SQLite-backed substrate；
- `host-core` 與 `protocol` 抽出兩種 host 共用的 staging、identity 與 wire contracts；
- `jupiter` binary 是 Station/headless host；
- `jupiter-client` binary 是第二個 declarative client host；
- `conformance` 會核對 architecture model、source inventory、test evidence、crate dependency graph 與 seam direction；
- `client-app` 的 J2d D1 已有 React shell、SDK、兩個 first-party packages 與 Tauri window/tray shell。

但這份清單每一項都有邊界。

| 已存在的東西 | 不能直接推論成 |
|---|---|
| Wasmtime runtime adapter | 所有 plugin runtime 類型都已完成 |
| SQLite durable store | durable owner 與 recovery semantics 已驗收 |
| OS/process capability | native plugin runtime provider 已交付 |
| 第二個 `NoRuntime` client host | D2 desktop shell integration 已進 main |
| React/Tauri D1 shell | many-Station desktop client 已完成 |
| conformance test source | 本次 checkout 已 freshly verified green |

Jupiter 的 README 也明確保留缺口：沒有 native process runtime、沒有 durable-owner proof、沒有 orchestrator。J3、J4、J5 仍是 conditional increments，不會因為 repository 重新被打開就自動變成完成。

因此今天可以說「Jupiter 已有一段可執行平台基線」，不能說「Jupiter 產品已完成」；可以說「D2 candidate 存在」，不能說「D2 已交付」。

## Candidate 不是 Current：D2 還卡在三層時間裡

D2 candidate 的方向，是讓 client host 真正驅動 desktop shell。branch 中可以看到 `WebviewRuntime`、build-pinned first-party modules、deny-default bridge grants，以及 Rust/TypeScript goldens。

然而 parent review 又找出 bootstrap 與 restore ordering 的問題：當事件或 activation 發生時，`ClientHost` 可能還沒有掛入 `AppState`。

16-file working-tree draft 正在處理三類事情：

1. 用 bounded wait 等待 host ready；
2. 依 digest 暫存 admitted module bytes，避免 activation 反向依賴尚未開好的 host；
3. 調整 frontend listener ready 與 host-open re-query 的順序，避免第一個 activation event 或 recovery list 永久遺失。

這些都像合理修補，卻仍不能直接稱為完成。

其中一個 wait timeout 旁甚至還保留：

```rust
50ms // TEMP EXPERIMENT
```

這不是可以忽略的小字，而是非常清楚的 evidence marker：數值仍在實驗、修改尚未形成 reviewed commit、receipt 也沒有更新。

若此刻直接把 dirty diff commit，再把 branch merge 進 `main`，至少會留下三個問題：

- D2 是否正確整合 J2c Phase C identity/capability changes？
- 50ms 是經過測量的 bound，還是暫時讓測試過關的數字？
- 舊 D2 receipt 是否仍能描述 review fixes 後的 source？

所以整理不是先替 branch 取一個漂亮名字，而是先把 candidate、review draft 與 current main 的關係說清楚。

## Receipt 也有版本：昨天的綠燈不是今天的證明

Jupiter 並不缺歷史驗證紀錄。

J2c 的文件記錄過 framework、Wasmtime adapter、durable、host-core、protocol、Station host、client host 與 conformance suites；J2d D1 receipt 也記錄過 frontend tests、Tauri build 與 dev window 啟動。D2 branch 自己還有一份 branch-local receipt，記錄當時執行的 Rust/TypeScript checks 與已知 gaps。

但 receipt 是 snapshot，不是永久通行證。

```text
receipt validity
    = exact source identity
    + exact command/scope
    + captured result
    + known omissions
```

D1 receipt 不會因為後來出現 D2 就自動升級。`49dcd1d` 上的 D2 receipt，也不會自動覆蓋其後 16-file dirty diff。

盤點時還看到許多 ignored artifacts：Moon cache、Rust `target`、package `node_modules`、`dist`、Tauri generated files。它們只能說明本機過去做過某些安裝或生成，不能證明 artifact 與 current source SHA 一致。

本次也沒有重新執行 build 或 tests。因此今天最誠實的寫法是：

> source、test suites、build graph 與歷史 receipts 都存在；current main 與 D2 review draft 尚未取得本次 re-entry 的 fresh validation。

這不是降低 Jupiter 的可信度，而是避免拿舊 receipt 替新 source 作證。

## 文件漂移本身，就是第一批整理對象

重新進入專案時，文件不一致未必代表有人寫錯；它也可能只是不同時間切片被留在同一份 repository。

Jupiter 有兩個很明顯的例子：

- adoption plan 開頭仍寫著「planned; implementation not started」，後半卻已記錄 J1–J2c delivered；
- README 的 headline 只列到 J1/J2a/J2b，後段才補上 J2c 與 J2d D1。

這不是 runtime 倒退，而是 status index 沒有跟 delivery ledger 一起收斂。

同時，不同文件本來就有不同權威範圍：

| 文件類型 | 最適合回答的問題 |
|---|---|
| Source/build graph | 某個 commit 實際包含什麼 |
| Architecture model | 邊界、依賴與 evidence inventory 應長什麼樣 |
| Delivery receipt | 某個 source snapshot 跑過哪些驗證 |
| Adoption plan | 增量順序、stop condition 與 current delivery narrative |
| Brief | 當時派發的 acceptance intent |
| Discussion | 尚在演化的研究與設計輸入 |

如果 brief 寫了 D3，不代表 D3 已完成；如果 discussion 建議 remote transport，也不代表 current host 已支援；如果 receipt 曾經全綠，也不能越過 source revision 使用。

整理文件的真正目的，不是把所有檔案改成同一句話，而是讓每份文件只承擔它有能力證明的 claim。

## 整理順序：先恢復 Re-entry Baseline，再決定怎麼合

這次盤點後，Jupiter 比較安全的整理順序不是「先 merge D2」，而是：

### 0. 保存原始座標

先記下：

```text
main:        614e248
D2 commit:   49dcd1d
merge base:  3e28287
D2 draft:    16 unstaged tracked files
remote:      none
fresh tests: not run
```

在還沒決定修改前，不要讓 rebase、format 或 generated outputs改寫現場。

### 1. 指定 current authority

以 `main@614e248` 作為目前 committed baseline；D2 是 candidate，dirty diff 是 review draft。三者不能共用一個「current」標籤。

### 2. 先處理 branch divergence

理解 J2c Phase C 的 Station identity 與 capability hello，決定 D2 應 rebase、cherry-pick 還是重新整合。這一步先回答 contract，不先追求 merge button 變綠。

### 3. Review dirty fixes

逐一確認 bounded wait、module-by-digest 與 event ordering 的 failure model。尤其要移除或證明 `TEMP EXPERIMENT`，再把修補形成可 review 的 commit。

### 4. 在乾淨 source identity 上驗證

先跑受影響的 client host、Tauri core、frontend 與 conformance gates，再依 integration 範圍擴大。驗證結果必須記錄 exact SHA、是否 dirty，以及哪些 suites 沒跑。

### 5. 產生新的 revision-bound receipt

不要修改舊 receipt 來假裝它一直都描述現在。新 source 應有新的 verification record，舊紀錄保留其歷史價值。

### 6. 最後收斂 status index

更新 README headline、adoption plan 的 stale opening status，以及 D2/D3 的 current boundary。若專案準備跨機器延續，再明確設定 remote/upstream 與 CI；在那之前，不宣稱已有遠端恢復能力。

這個順序的重點，是讓每次整理都減少 ambiguity，而不是只減少檔案數量。

## 把 Project State 當成 Sum Type，而不是一個 Boolean

如果把 repository 狀態只建模成 `clean: bool`，Jupiter 現在會得到 `true`，但這個結果幾乎無法指導下一步。

更接近真實情況的型別是：

```rust
enum ReentryState {
    MainBaseline { sha: Commit },
    Candidate { sha: Commit, merge_base: Commit },
    WorkingDraft { base: Commit, changed_files: usize },
    HistoricalReceipt { source: Commit, scope: ValidationScope },
    VerificationGap { target: SourceIdentity },
}
```

這不是要真的在 Jupiter 新增這段 Rust，而是一個思考工具。

`MainBaseline` 可以被 checkout；`Candidate` 可以被比較；`WorkingDraft` 必須先保存與 review；`HistoricalReceipt` 只能替特定 source 說話；`VerificationGap` 則禁止我們使用現在式宣稱全綠。

Day 014 把 architecture claim 視為需要型別的值；Day 015 再往前一步：**重新進入專案時，project state 本身也不是 boolean，而是一組不能互相隱式轉型的狀態。**

只有把這些 variant 分開，整理才不會變成資訊抹除。

## 回到 Unity：Context Recovery 本身就是架構工作

這個問題不只存在於 Rust plugin platform。

回到 Unity Game Dev，一個長時間沒有打開的專案也可能同時存在：

- `main` 上最後一次可重現的 Player Build；
- 某個 branch 的 Addressables 或 package upgrade；
- 另一個 worktree 尚未提交的 scene/prefab migration；
- 本機 `Library/` 與 `Temp/` 留下的舊 artifacts；
- CI 上屬於上一個 commit 的 test report；
- 文件裡尚未完成的 platform rollout plan。

若只看到 Unity Editor 能開、console 沒紅字，就說「專案狀態正常」，和只看到 `main` clean 就說 Jupiter 可以直接繼續，是同一種錯誤。

可靠的 orchestration 必須先回答：

1. Source identity 是哪個 commit？
2. 有沒有 branch/worktree-local candidate？
3. generated artifacts 是否可由該 source 重建？
4. test/build receipt 綁定哪個 revision？
5. 哪些 capability 只是 plan，哪些已在 runtime 中？
6. 下一個操作會保存證據，還是覆蓋證據？

所以 context recovery 並不是開發前可省略的暖身。對 agent-driven workflow 而言，它本身就是 architecture operation：先重建狀態圖，才允許 agent 產生下一個 mutation。

Day 015 沒有新增 Jupiter 功能，也沒有把 D2 說成已交付。

今天的產出，是找回一組足以繼續工作的座標：`main` 是基線，D2 是 candidate，16-file diff 是 review draft，receipts 是歷史 snapshot，而 fresh validation 仍是一道尚未通過的 gate。

**重開專案的第一個 deliverable，不一定是 commit；有時是一張不會把過去、現在與候選未來混在一起的地圖。**
