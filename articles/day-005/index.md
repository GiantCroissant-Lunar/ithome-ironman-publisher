---
title: Day 005：重寫不是歸零——從 Plugin-First 重新畫 BearPunch 的邊界
timestamp: "2026-09-05T21:26:03+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Plugin Architecture
---

# 重寫不是歸零：從 Plugin-First 重新畫邊界

![Star-shaped Station 保有 state、policy 與 resource authority，多個獨立 plugin artifact 只能經標準化入口與 scoped broker 存取各自 workspace](./images/generated/hero.jpg)

昨天談的是 BearPunch 如何在 Agent provider 額度中斷時，以 Family Ladder 保留 run lineage 並更換執行者。

今天沒有新的功能可以接著往下列。相反地，我沒有繼續在原本的 `bearpunch-onepack` 上疊加能力，而是回到另一個 repository：`bearpunch-star`，重新決定 Station、kernel、host 與 plugin 之間的邊界。

這不代表 Onepack 的最終版本已經被證明失敗，也不是把先前做過的事全部歸零。舊實作留下了 lifecycle、workspace、sandbox、provider 與 UI 的 regression cases；這次重寫要做的，是不直接搬進整套 runtime，而是先回答一個更小、也更難在後面補救的問題：

> **哪些責任必須由 Station 掌握，哪些 behavior 應該以獨立 plugin 進出系統？**

Day 005 不把重寫包裝成進度，而是記錄這次 Plugin-First 起點所選擇的 architecture boundary。

## 今天沒有新功能，只有一次重新劃線

`bearpunch-star` 的 committed `main` 目前只有兩筆 foundation／provider commit。裡面的 contracts、VFS、kernel、Wasm 與 native runtime、Claude ACP provider 都是這一輪重寫的既有 baseline，不是今天剛完成的 changelog。

今天真正發生的是重新確認：哪些經驗值得帶過來，哪些東西不能因為舊專案已經存在，就整包匯入新的 composition root。

| 保留為設計證據 | 不直接搬進 Star |
|---|---|
| Station 擁有 canonical state、grant 與 execution lifetime | Onepack 的整套 runtime 與大型 service modules |
| immutable base、private delta、tombstone 與 lease | archived roadmap、scheduler、work DAG 與廣泛 integrations |
| generation、invocation、allocation 是不同 lifetime | 由 host 替 example plugin 補 behavior 或 mock fallback |
| Wasm explicit imports 與 per-store resource limits | 把 Wasm 當成所有 plugin 的唯一實作形狀 |
| 舊事故與測試作為 regression cases | 把舊 UI、CLI collector 或 domain lowering 當成 Star 已有能力 |

這個區分很重要。重寫若只是換 repository 名稱，卻把原本所有 coupling 一起複製過來，就沒有重新開始；但若連已經學到的失敗模式都丟掉，也只是昂貴地再犯一次。

## Plugin-First 不是把一切都做成外掛

Plugin-First 很容易被理解成「所有東西都可以自由插拔」。Star 的方向反而更嚴格：先固定不可外包的 authority，再讓 behavior 透過有限 contract 進入。

```text
CLI／未來的 TUI
        │
        ▼
Host：control service、trusted adapters、composition
        │
        ▼
Kernel：registry、policy、generation、invocation lifecycle
        │
        ▼
Runtime adapter：Wasm component／confined process
        │
        ▼
Separately built plugin
        │
        ▼
Allocation-scoped VFS／mediated trusted services
```

**Host** 是 composition root。它啟動 Station、接上 VFS、runtime adapter、toolchain 與 trusted service，但不應知道 `workspace-report` 或其他 example plugin 的 domain behavior。

**Kernel** 掌握 plugin publication、current route、generation pinning、grant policy 與 invocation lifecycle。它決定某個 artifact 能不能被接納，不負責實作 plugin command 的內容。

**Runtime adapter** 把共同 contract 投影到實際執行環境。目前已實作 Wasmtime component，以及 Windows AppContainer + Job Object process。`.NET` 只保留了 runtime kind，尚無 adapter，因此必須拒絕而不是偷偷降級成普通 process。

**Plugin** 才保存可替換的 behavior。`workspace-report`、native workspace tool、Rust builder 與 Claude ACP provider 都是 separately built artifacts，不連結進 Station host 的 Cargo workspace。

所以 Plugin-First 的重點不是「核心越小越好」，而是：**核心只保留 authority、policy 與 lifecycle；新增 behavior 不能因為方便，就重新長回 host。**

## 一份 Manifest 先說清楚什麼？

Star 的 plugin 不是 host 裡的一個 Rust trait implementation。它先是一份獨立 artifact，以及描述 artifact 如何被接納的 manifest。

目前 `workspace-report` 的 package template 長這樣：

```json
{
  "api_version": 1,
  "id": "workspace-report",
  "version": "0.1.0",
  "runtime": "wasm-component",
  "artifact": "plugin.wasm",
  "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "commands": [
    "workspace.report",
    "workspace.note",
    "workspace.remove",
    "workspace.read",
    "diagnostic.spin"
  ],
  "capabilities": ["workspace-read", "workspace-write"]
}
```

這裡的全零 SHA-256 是 checked-in packaging template placeholder。`station package` 會依真正 artifact bytes 產生 digest，正式 admission 時還會再次核對；它不是可以跳過驗證的萬用值。

Manifest 至少把幾個原本容易藏在 host 裡的假設變成資料：

- `api_version`：目前只接受 exact version 1，尚不是完整的 SemVer compatibility solver。
- `runtime`：決定必須由哪一個已實作且可 confinement 的 adapter 接手。
- `commands`：package 宣告的 commands 必須和 artifact 自我描述完全一致。
- `capabilities`：plugin 想使用的能力；這只是 request，不是 operator 已經授權。
- `sha256`：route 指向的是哪一份 exact bytes，而不只是同名檔案。

目前 capability vocabulary 只有 `workspace-read`、`workspace-write`、`toolchain-use` 與 `service-call`。它刻意很小，因為每多一種 capability，就多一種需要定義授權、revoke、resource scope 與 failure behavior 的 effect。

## 一個 Plugin 從 Package 到 Invocation

Star 目前沒有掃描某個 plugins 目錄後自動載入所有東西。Plugin 要透過明確的 `plugin-publish` 進入 Station；publish 成功並切換 current route，就是現階段的 activation，沒有另一個隱藏的 `activate()` callback。

整條路徑大致分成七步：

1. **讀取 package**：限制 manifest／artifact 大小、canonicalize path，阻止 artifact 逃出 package，並核對 SHA-256。
2. **驗證 contract**：檢查 API version、plugin ID、version、commands、runtime 與 capability 格式。
3. **核對 policy**：manifest 要求的 capability 必須是 operator grant 的 subset；重新發布同一 plugin ID 不能順便偷改 policy。
4. **準備 candidate**：在 registry lock 外讓 runtime adapter compile／describe artifact。Wasm 會核對 `api_version` 與 commands；native executable 則在 AppContainer 裡執行 describe handshake。
5. **持久化後切 route**：exact artifact bytes、manifest、grant 與 source receipt 先寫入 SQLite，成功後才讓新 generation 成為 current。
6. **開始 invocation**：kernel 選定 current generation，驗 command 與 sandbox，建立 allocation lease，並把 generation、allocation、artifact digest 與 policy revision 綁成 invocation record。
7. **執行 mediated effects**：plugin 只能透過綁定該 allocation 的 broker 存取能力；結果或錯誤最後寫回 durable invocation history。

這裡最重要的順序是「先完整驗 candidate，再改 route」。如果新 artifact 的 hash、ABI、command set、runtime 或 sandbox 不成立，既有 plugin route 與已保存 package 都不能被破壞。

## Hot Replacement 不是覆蓋檔案

![舊 generation 被既有 invocation pin 住繼續完成，新 invocation 改走新 generation，錯誤 candidate 不會破壞目前 route](./images/generated/inline-03.jpg)

如果把更新想成覆蓋 `plugin.wasm`，正在執行的工作就會突然失去它原本使用的 code identity。Star 用 generation 把「目前接新工作的是誰」和「已經開始的工作使用誰」分開：

```text
Generation A 是 current
        │
        ├─ Invocation 17 pin 住 A
        │
Publish Generation B
        │
        ├─ 新 invocation 改走 B
        └─ Invocation 17 仍用 A 完成
```

Invocation 持有確切 generation 與 allocation lease。最後一個 pin 釋放前，retired generation 仍然存在；之後才可以被回收。

這也表示幾個 lifetime 不能混成一個布林值：

- **Generation lifetime**：某一份已接納的 code、manifest 與 policy binding。
- **Invocation lifetime**：一次 command 執行與它的 durable outcome。
- **Allocation lifetime**：該工作可見的 canonical base、private changes 與 tombstones。
- **Materialization lifetime**：native process 暫時看到的 exclusive directory view。

`unpublish` 會停止新的 admission route，但已經 admitted 的 invocation 仍可完成。反過來，錯誤 candidate 連 current generation 都不應取代。Hot replacement 的核心不是「不用重啟」，而是 replacement 發生時仍能回答：**每一個 effect 到底由哪一份 code、哪一版 policy、對哪一個 allocation 產生？**

## Capability 宣告不等於權限

Manifest 寫了 `workspace-write`，不代表 plugin 從此可以寫所有 workspace。

首先，operator grant 必須允許該 capability。接著，kernel 在每次 mediated effect 發生時重新檢查 manifest request 與 current grant，並扣除 host-call 與 byte budget。最後，broker 已經綁定 invocation 的 allocation，guest 不能換一個 allocation ID 去讀寫別人的資源。

不同 runtime 用不同方式落實同一個 extension contract：

- **Wasm component** 只取得明確 link 的 workspace imports，沒有 WASI、network、environment、stdio 或 process imports，並受 fuel 與 memory limit 約束。
- **Native process** 取得 allocation 的 exclusive full-copy directory view，在 Windows 上由 AppContainer ACL 與 Job Object 限制；建立 process 時就要原子地帶入 sandbox 與 job attributes，沒有 normal-process fallback。
- **Trusted services** 可以持有真正 credential，但 plugin 只拿到 scoped service capability與 opaque handle，不取得 credential bytes、control token 或 database handle。

Grant 被縮減時，Wasm 的下一次 broker effect 會被拒絕；native process 可能已經持有 OS file handle，因此必須取消並回收整棵 process tree。

這些機制不等於 hostile-code security audit 已經完成。它們只表示目前的 architecture 願意對「權限在哪裡檢查、如何撤銷、失敗後誰收尾」提出可以測試的答案。

## 失敗時，架構才真的出現

Plugin architecture 不能只描述 happy path。Star 的 foundation tests 特別把失敗後的外部世界也列入 contract：

| 失敗情境 | 應有結果 |
|---|---|
| artifact 被竄改、ABI 或 command set 不符 | 拒絕 candidate，current route 維持不變 |
| Wasm guest 耗盡 fuel 或 trap | invocation 失敗，但 Station 繼續服務 |
| native timeout、cancel 或 revoke | 先回收 root 與 descendants，再 capture 可接受的變更 |
| Station crash／restart | 原本 running 的 invocation 標記為 `interrupted`，canonical state 恢復 |
| native capture 無效或過大 | 不用空 root 覆蓋 canonical state，保留 materialization 並 fence allocation |
| invocation 執行途中失敗 | durable record 必須保存失敗；已逐筆提交的 edit 不假裝全部 rollback |

最後一列尤其重要。Star 目前沒有「整次 invocation transaction rollback」保證。Plugin 寫入的 effect 可以已經成為 canonical change；失敗記錄必須誠實，而不是把 workspace 偽裝成從未發生任何事。

## 現在真的完成什麼，還沒完成什麼？

截至目前，最安全的說法是把 committed `main`、working-tree implementation 與 design proposal 分開。

### Committed main baseline

- runtime-neutral contracts、SQLite VFS、kernel、Wasm、Windows native 與 host composition root；
- explicit plugin publication、exact digest／API／commands validation、generation replacement 與 pinning；
- operator grants、effect-time recheck、allocation isolation 與 durable invocation records；
- immutable shared base、private deltas、tombstones、lease 與 native materialization recovery；
- Wasmtime component，以及 AppContainer + Job Object 的 Windows process adapter；
- separately built workspace、builder plugins與 Claude ACP process plugin；
- repository-recorded baseline gate：37 個 Rust tests、2 個 Node compatibility tests。

這次撰文只核對 source、receipts 與既有 evidence，沒有在今天重新跑完整 build gate，所以不能把這些數字寫成今日新增成果。

### 還不能算 main 能力

- working tree 裡的 detached invocation、parallel agents、額外 provider file tools，以及 47／6 tests 敘述；
- Station TUI、managed background launcher 與 attach／operate／detach workflow；
- plugin-contributed view／action contract；
- OpenTUI renderer、MPS authoring、A2UI view projection 與 AG-UI event projection；
- `.NET` admission、non-Windows native confinement、remote authentication 與 multi-user transport；
- 完整 provider conversation resume，以及 Wasm linker compatibility 的未解問題。

特別是 UI：目前只有 working-tree design、Pencil 與 token seeds，沒有可執行 TUI，也沒有 `PluginManifest` 的 view contribution 欄位。把設計素材稱為 plugin UI 已完成，會重複這次重寫正想避免的問題——讓「看起來存在」取代「contract 與 gate 已成立」。

## 這次重寫的 Definition of Done

Day 005 沒有交付新功能，但可以留下往後判斷新能力是否符合 Plugin-First 的檢查表：

1. behavior 能否以 separately built artifact 交付，而不是加回 host switch？
2. manifest 是否明確宣告 version、commands、runtime、digest 與最小 capabilities？
3. candidate 驗證失敗時，現有 route 是否完全不受影響？
4. invocation 是否 pin 住 exact generation、policy revision 與 allocation？
5. replacement、revocation、cancel 與 restart 是否都有 deterministic outcome？
6. effect 與最終結果是否留下 durable、可追溯的 record？
7. 客戶端關閉時，execution lifetime 是否仍由 Station 擁有？

接下來規劃中的 Station TUI 與第一個 plugin-contributed view，也必須通過相同問題：domain view 不能寫成 TUI 裡的 plugin-ID switch；action 必須綁定已接納 generation 與 current grants；替換或撤銷 plugin 時，舊畫面不能繼續假裝自己有權操作。

在那個 vertical slice 通過 gate 前，TUI 與 UI contribution 都仍只是 planned direction。

重寫不是進度，也不是失敗證明。它的價值取決於是否真的建立了比上一輪更難被繞過的邊界。對 `bearpunch-star` 而言，這次起點可以濃縮成一句話：

> **Behavior 可以替換，但 authority、identity、lifetime 與 failure evidence 不能跟著漂移。**
