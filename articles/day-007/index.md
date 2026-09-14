---
title: Day 007：Plugin 不只一種——Comet 與 Blink 在驗證哪兩條邊界？
timestamp: "2026-09-07T20:47:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Plugin Architecture
---

# Plugin 不只一種：Comet 與 Blink 在驗證哪兩條邊界？

今天的開發不是從早上一路順利推進。

上午的 Agent quota 還沒有恢復，我只能先停下來。直到接近下午重新取得可用額度後，才開始把前兩天留下的 Plugin-First 問題拆成兩個更窄的實驗：`bearpunch-comet` 與 `bearpunch-blink`。

這兩個 repository 不是 Star 的 v2、v3，也不是要在一天內做出兩套新的 ADE。它們各自拿走一個仍然混在「plugin architecture」裡的假設，嘗試用可以失敗的程式與測試回答：

- 如果連 Session 都不該是 host 的內建名詞，ADE 能不能只是 plugins 的 composition？
- 如果 plugin 要在 runtime 中真正消失，service binding 與 consumer lifetime 要怎麼重新收斂？

Day 005 問「authority 應該留在哪裡」，Day 006 追「UI action 有沒有繞過同一條 authority path」。Day 007 不再重講 manifest、generation 或 capability 基礎，而是比較：**同一句 Plugin-First，放到不同的替換單位與 failure contract 上，會得到多不一樣的系統。**

## 同一句 Plugin-First，其實藏著三個問題

把 Star、Comet 與 Blink 放在一起時，最容易犯的錯是排成版本號：Star → Comet → Blink。

實際上，它們在驗證三個不同層次：

| 實驗 | 主要問題 | 目前的 plugin 形狀 | 核心不變量 |
|---|---|---|---|
| Star | contribution 與 action 如何回到 authority？ | resident process + AEP | generation、grant、session／run authority 仍由 Station 掌握 |
| Comet | host 能否完全不懂 ADE domain？ | supervised process + Zenoh services | host 只建可信 invocation context，不內建 Session／Run／Workspace |
| Blink | service provider 能否真正卸載並重新綁定？ | Wasm component + WIT service registry | 每個 generation 擁有自己的 Store，binding 由 observed state 重新收斂 |

這不是功能清單，而是三種切法：

- Star 把 **domain behavior** 移出 host，但 Station 仍掌握 domain authority。
- Comet 連 **domain nouns** 都移出 host，讓 ADE 由一組 services 組成。
- Blink 把 **service generation** 當成可卸載單位，讓 provider 出現、消失與替換成為正常狀態。

因此今天要比較的不是哪個 repository 檔案最多，而是哪一個 failure 發生時，各自承諾什麼。

## Comet：讓 ADE 成為 Plugin Composition

Comet 的起點比「host 可以載入 plugin」更激進：`comet` binary 只知道 package、instance、service、invocation、event 與 grant；它不編譯 Session、Run、Workspace、Agent 或 Approval 的 contract。

> **沒有 domain plugins 時，Comet 仍是一個完整運作的 plugin host，只是它還不是 ADE。**

這個差異可以用 `session.create` 的 vertical slice 說清楚。

同一個未重建的 host，在 `agent-domain` 尚未安裝時，呼叫 session service 會得到 typed `Unavailable`。安裝 `state-file` 與 `agent-domain` 後，consumer 送出完全相同的 request，路徑變成：

```text
Consumer plugin
    │
    ▼
Host broker
    ├─ 從 ACL 已證明的 credential slot 取得 caller
    ├─ 重查 ServiceConsume 與 operator grant
    └─ 建立 InvocationContext
    │
    ▼
agent-domain plugin
    ├─ 實作 bearpunch.session
    └─ 再以自己的 plugin identity 呼叫 bearpunch.state
          │
          ▼
      Host broker（第二次）
          │
          ▼
      state-file plugin
          └─ 以 context.caller.plugin 作 namespace
```

一次 `session.create` 會穿過 broker 兩次。`agent-domain` 既是 session provider，也是 state consumer；它不能直接 link `state-file`，也不能自行宣稱 caller identity。State request 甚至沒有讓 caller 傳 namespace 的欄位，provider 只相信 host 建立的 context。

因此跨 plugin composition 不是 host 裡的一條方便捷徑。另一個 plugin 即使猜到相同的 `sessions/<id>` key，也只會落在自己的 namespace。

Comet 還把 local call 與 federation 放在同一個 Zenoh shape 上。Provider 從 Host A 移到 Host B 時，consumer 仍呼叫同一個 service interface；Host A 只在 local route 為 `Unavailable` 且 caller 已通過 grant 後，才用 peer slot forward 到 B。HEAD 的 acceptance evidence 在同一台機器啟動兩個 host，證明 call shape 與逐 hop authorization，尚不是 production multi-machine security。

這個設計真正測試的是：**ADE 是否可以只是安裝後才出現的 domain composition，而不是 host binary 的本體。**

### Comet 目前能證明到哪裡？

Day 007 的 Comet repository 從中午到下午留下六個 committed changes，current `main` clean。最新 commit 訊息記錄 113 tests 與三次 forced `comet:ci` green；README 的 84 tests 與 roadmap 的 99 已經落後。

這次撰文沒有重新跑 CI，也沒有 committed raw console receipt，因此最安全的說法是「repository-recorded 113 tests」，不是今日由本文重新驗證的結果。

同樣重要的是尚未完成的部分：

- Milestone 0 仍是 `in progress`；
- 只有 native process runtime，沒有 generation pinning／hot replacement；
- event journal、explicit cancellation、workspace provider 與 long-running run 尚未交付；
- 八個 capability 中目前真正 enforce 的核心仍是 service provide／consume；
- plugins 與 host 使用同一個 OS user，credential dictionary 不能當 hostile-code sandbox；
- federation test 是同機雙 host，且目前每 host 只支援一個 peer；
- host 的 router、broker、identity 與 supervisor 仍是 single point of failure。

所以 Comet 是一條已穿過 domain extraction、state composition 與 federation 的 vertical slice，不是完成的 distributed ADE。

## Blink：把 Plugin 變成可卸載的 Service Generation

Blink 問的是另一件事：如果 plugin 的替換單位不是長駐 process，而是 WebAssembly component，能不能讓一個 generation 真正卸載，同時讓其他 consumer 繼續活著？

Blink 選 Wasm 的主要理由不是速度，也不是「一次編譯到處跑」，而是 **unload**。每個 generation 擁有自己的 Wasmtime `Store`；retire 時丟掉該 Store，就能回收 instance 與 linear memory，不必賭 `dlclose` 沒留下 Rust TLS destructor。

Plugin 提供與消費的是版本化 WIT interface。Consumer 只宣告「需要哪個 service」，不指定 provider；registry 在 activation 前 resolve，再把結果投影到該 consumer 的 route table。

最有辨識度的實驗，是同一份 `echo-agent.wasm` 配上兩份不同 manifest：

- `required = false`：transform provider 不存在時仍可 active，只是以 absent 狀態降級；
- `required = true`：provider 不存在時保持 `unsatisfied`；provider 消失時 suspend 並丟掉自己的 Store。

Runtime 中途安裝 provider、retire provider，再安裝 replacement 時，level-triggered `reconcile()` 會反覆讀取 observed state，直到沒有變化：

```text
沒有 provider
  ├─ optional consumer：active + absent
  └─ required consumer：unsatisfied

provider 出現
  ├─ provider activate
  ├─ required consumer instantiate
  └─ routes 投影到目前 generation

provider retire
  ├─ 清除指向它的 routes
  ├─ drop provider Store
  ├─ optional consumer 繼續 active
  └─ required consumer suspend，drop consumer Store

replacement 出現
  └─ required consumer 以原 generation id 重新 instantiate
```

這裡的關鍵不是 callback，而是 **declarative wiring**。早期 edge-triggered 版本只在 retire 時處理變化，結果 provider 可以消失，卻不能在稍後出現時讓 consumer 自動獲得 service；改成 level-triggered fixpoint 後，「出現」與「消失」才是對稱的狀態轉移。

真正的 call path也不把 provider ID capture 在 consumer closure 裡：

```text
echo-agent export
    │
    ▼
transform import trampoline
    │
    ├─ 以 consumer generation 查目前 ServiceTable
    ├─ 找到現在的 provider generation
    ├─ cycle guard + provider Store try_lock
    ▼
uppercase provider export
```

Grant 則在每次 host effect 前重新檢查。Revoke 後，下一個 effect 回 typed `denied`，generation 本身仍可保持 active；Wasm trap 才是 terminal fault，下一次 reconcile 會 demote generation、撤掉 routes 並 drop Store。

### Blink 目前能證明到哪裡？

Blink 也是 Day 007 當天下午從零建立的 repository，current `main` clean。README 記錄 workspace 114 tests，其中 34 個是以真 component 執行的 end-to-end tests；獨立 `ccusage` crate另有18個 parsing／pricing tests。三個 Wasm spike 也各自記錄在本機執行過，其中 Store isolation 的量測為每次 cross-plugin round trip 約 3.6–4.3 µs。

本文沒有重跑這些測試或 spike，因此不把它們寫成本文重新觀察到的 performance claim。

Blink 目前仍是一個 framework slice，不是完整 BearPunch replacement：

- demo Station 大多是 in-memory，不是真正 durable kernel；
- TUI、ADE 與 UI surface runtime 都不存在，只有 WIT／manifest contract；
- process tier 只有 enum 與設計，沒有 dispatcher；
- `Manifest.world` 會 parse，但 admission 尚未做 declared-world conformance；
- package 從來源 bytes hash 與 compile，尚未 immutable-promote 到 generation store；
- store capability 目前只能由 trusted native floor 提供，Wasm plugin 缺少不可偽造 tenant seam；
- C# 最後的 component link 失敗，現階段只有 Rust guest 是 first-class；
- 同步 runtime 尚無 fuel、epoch、memory limiter、async／streaming 與 cross-plugin resource handle。

Blink 證明的是 service generation 的 unload／rebind seam，不是已完成多語言、持久化、帶 UI 的 ADE。

## 兩個 Repository，不是兩個版本號

Comet 與 Blink 都在 Day 007 建立，但它們不能被合併成一張「新架構已完成」的投影片。

| 比較維度 | Comet | Blink |
|---|---|---|
| Host 知道什麼 | 只知道 platform nouns，不知道 ADE domain | Station 仍擁有 durable domain 的設計責任 |
| Plugin 邊界 | supervised process peer | Wasm component generation |
| Plugin 間通路 | Zenoh broker；host 建 invocation context | WIT service registry；per-consumer route table |
| 動態性的重點 | provider 可在另一 process／host | provider 可 unload、retire、rank 與 rebind |
| State seam | state 可以是普通 plugin，namespace 來自 attested caller | store 暫時是 trusted native provider |
| 目前最大缺口 | generation、journal、cancel、sandbox、完整 domain | durable Station、UI、process tier、package lifecycle |

Comet 比較像在問：「平台若不懂 ADE，哪些 identity 與 authorization 必須由 fabric 補回來？」

Blink 比較像在問：「provider 可以真正消失時，consumer 的 lifecycle policy能不能只由 manifest 表達？」

兩者都不是答案本身，而是讓錯誤更早出現的實驗台。

## Failure Contract 才是比較單位

如果只看 happy path，三個實驗都可以被描述成「plugin 呼叫另一個 plugin」。真正的差異出現在 provider 不存在、消失或失去權限時：

| 事件 | Star 的關注點 | Comet 的結果 | Blink 的結果 |
|---|---|---|---|
| Domain plugin 尚未安裝 | contribution／command 不存在 | host仍正常，service 回 `Unavailable` | 不適用；Station domain仍在 composition root設計內 |
| Service provider 尚未出現 | process contribution activation | registry沒有 ready provider，回 `Unavailable` | optional consumer降級；required consumer `unsatisfied` |
| Provider 死亡／retire | generation／run truth與reactivation | liveliness撤 registration與slot，不做domain recovery | drop Store、清 route，再由 reconcile決定degrade或suspend |
| Grant 被撤銷 | effect-time recheck | 下一個 broker call重新查grant | 下一個host effect回`denied`，instance不必死亡 |
| Provider移到另一host | 尚非current main主線 | 同一service call shape經peer broker forward | 尚無multi-host fabric |
| Replacement出現 | stale view／generation identity | 尚無hot-replacement generation model | consumer route重投影，required consumer可resume |

這張表也提醒我：architecture choice 不只是選 Wasm、process 或 transport。真正需要先寫清楚的是：「消失時誰繼續？誰暫停？誰記錄失敗？誰有權重新綁定？」

## Quota 限制帶來的反向好處

今天上午沒有 quota，表面上像是浪費半天。反過來看，它迫使我先把問題縮小，而不是直接叫 Agent 在 Star 上繼續堆功能。

接近下午恢復額度後，Comet先用六個 commits測「domain能否完全由plugins組成」，Blink再用十八個 commits測「service generation能否真的卸載與重綁」。數量並不代表完成度；兩個repository都還有明確缺口，而且測試數字都只來自repository紀錄，不是本文重新執行的gate。

這種做法也有風險：如果每遇到問題就建立新repository，architecture experiment很快會變成逃避integration。Day 007 合理的產出不是再維護兩個產品，而是把可以帶回主線的invariants寫清楚：

1. host是否應該知道domain nouns，必須由executable dependency boundary證明；
2. caller identity不能由plugin payload自報；
3. provider absence與replacement要由declarative policy驅動；
4. authority必須在每次effect或broker call重新檢查；
5. unload、retire、restart與remote forwarding必須留下不同的failure evidence；
6. 一次vertical slice不能冒充durable、sandboxed、multi-host product已完成。

## 回到 Unity：不是先選 Runtime，而是先選消失時怎麼辦

這個系列最終仍要回到 Unity Game Dev orchestration。Comet與Blink帶回來的不是「Unity plugin應該改用Zenoh還是Wasm」的立即答案，而是一組更好的問題：

- Unity Editor adapter 是domain plugin，還是Station必須理解的authority？
- Build、Test、Play Mode provider不在時，run應該fail、queue、degrade還是suspend？
- provider移到另一台有Unity授權的machine時，caller identity與workspace authority如何保持？
- 長時間Play Mode session是否能跟著plugin generation卸載？不能的話，哪個lifetime才是正確替換單位？
- Test evidence應由普通plugin state保存，還是必須進Station的durable journal？
- UI surface被替換時，正在執行的build action要pin哪一版contract？

這些問題目前都沒有由Unity vertical slice回答。Comet沒有Unity domain，Blink沒有TUI/ADE，Star的Unity evidence surface也仍是下一步。

但今天至少把「plugin」這個詞拆開了：

> **Comet問的是domain能否從host消失；Blink問的是provider能否從runtime消失；Star提醒我們，無論哪一種消失，authority與failure evidence都不能一起消失。**

等下一次把實驗帶回同一條Unity workflow時，真正要保留的不是repository名稱，而是這三個問題的答案。
