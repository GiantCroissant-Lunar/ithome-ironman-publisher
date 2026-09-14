---
title: Day 009：Pin 住 Generation 還不夠——Saturn 如何保存整條 Plugin Dependency Closure
timestamp: "2026-09-09T10:17:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Plugin Architecture
---

# Pin 住 Generation 還不夠：Saturn 如何保存整條 Plugin Dependency Closure

昨天寫 Saturn 的 worker lifetime 時，問題是：Station 消失後，Agent process、pipes 與 protocol cursor 還在不在？

今天 Saturn 往前走了一步，也讓另一種更隱晦的 continuity 問題浮出來。

假設一個長時間工作已經 pin 住 plugin provider A，接著系統發布 provider B。Worker 沒死、owner 沒換、第一層 provider 也確實還是 A，看起來一切安全。

但 provider A 自己還會呼叫另一個 upstream plugin。如果那一層沒有一起被固定，它就可能在執行途中接到 upstream B。最後得到的不是舊語意 `A:A`，也不是新語意 `B:B`，而是一個從來沒有被發布、測試或審核過的混合版本 `A:B`。

這次 process 全都活著，工作卻已經不是原本那個工作。

因此 Day 009 的問題不是再問一次 worker 能不能活過 restart，而是：

> **Durable owner 能不能讓一項工作跨過 plugin replacement 與 Host reopen，仍然執行原本那整條 dependency graph？**

Saturn 在今天的 clean `main@56259f1` 已經交出一條 committed partial answer：atomic durable record、exact revision retention、transitive dependency closure，以及真 Wasm A/B replacement + Host reopen 測試。更重要的是，full CI 還真的抓到一次「closure 掛得太晚」造成的語意漂移。

這讓 plugin durability 從「留住一個 generation」進一步變成「留住一整段執行語意」。

## 一個 A:A 變成 A:B 的語意漂移

先把情境縮成三個角色：

```text
Durable owner O
    │
    └─ 呼叫 topic T
          ▼
      Provider P
          │
          └─ 再呼叫 upstream topic U
                    ▼
                Provider Q
```

工作開始時，registry 中是 `P-A` 與 `Q-A`。Owner O acquire 一份 retained execution binding，然後開始執行。

稍後 operator 安裝 `P-B` 與 `Q-B`。這時合理的結果應該只有兩種：

- replacement 之後開始的新工作走 `P-B → Q-B`，得到 `B:B`；
- 已經存在的 owner O 仍走 `P-A → Q-A`，得到 `A:A`。

最危險的狀態則是：O 雖然 pin 住 `P-A`，但 `P-A` 的 nested send 又向 current registry 查詢 upstream，於是接到 `Q-B`，得到 `A:B`。

`P-A` 與 `Q-B` 可能各自都通過測試，`P-B → Q-B` 也可能是合法的新組合；但 `P-A → Q-B` 從未形成一個被 admission、review 與測試共同承認的 product revision。

這不是普通的 stale reference。它是 **semantic drift**：外層 identity 沒變，內層行為卻在執行途中換了版本。

Day 005 已經談過 invocation 與 allocation 不能只記 bundle name，必須 pin 到 generation。Day 007 的 Blink 則實驗 provider replacement 後 consumer 如何 rebind。今天的 Saturn 把問題再推一層：**對新的工作，rebind 是功能；對已存在的 durable owner，rebind 可能是違約。**

所以 retention 的單位不能只是第一個 handler。它必須是 execution dependency closure。

## Durable Owner 不是一個好看的 ID

要保留 dependency graph，首先必須有一個可信的 durable owner。它不能只是 plugin payload 自報的一段字串，也不能只存在 activation memory。

Saturn 今天提交的 durable store，以 SQLite transaction 原子寫入四種 truth：

- owner 的 opaque state revision；
- ordered events；
- outgoing intents；
- command receipt。

Guest 呼叫 `saturn:platform/durable.commit` 時，namespace 來自 kernel mint 的 `EffectContext.bundle`，不是 request body。Store 以 `(namespace, owner, command)` 識別 command，並為 normalized request 計算 digest。

這形成幾個重要的 failure semantics：

```text
相同 command + 相同 digest
  └─ replay 原本 receipt，不再建立第二次 transition

相同 command + 不同 payload digest
  └─ conflict，不接受 caller 重新解釋舊 command

expected revision 已過期
  └─ 整筆 writes nothing

transaction 中任何 event／intent／state／receipt 寫入失敗
  └─ 全部 rollback
```

這些規則沒有讓外部 effect 自動變成 exactly-once。Intent 被 durable commit，只代表 Saturn 保存了「應該做什麼」的 outbox truth，不代表另一個 CLI 或遠端服務一定沒做過或只做一次。

但它建立了 retention 所需的底座：owner、revision、command identity 與 receipt 不再依賴目前這個 Host process 的 memory。只有先知道「哪一項工作、在哪一個 revision、以哪一份 request」正在延續，後面才有資格談它應該保留哪一套 code 與 contract。

## 從第一個 Handler 擴成 Transitive Closure

Owner acquire retention 時，Saturn 不直接相信它交來一串 revision IDs。`RetentionCapability::acquire` 先取得 caller 的 exact revision，再要求 `Framework::attest` 從已 admission 的 manifests 與目前 routing state 建立 closure。

Attestation 從 owner 宣告要送出的 topic 開始：

1. 驗證 caller manifest 確實宣告該 `sends` 或 `requires` edge；
2. 依 ranking 與 selector 找出 direct handler 的 exact revision；
3. 讀取該 provider 自己的 `requires` 與 `sends`；
4. 對每個 provider 繼續解析 upstream exact revision；
5. 以 `(revision, topic)` 去除 cycle；
6. 將每條 edge 的 requirer、topic、contract descriptor 與 selected revision放入 closure。

這是一個有界的 breadth-first traversal，目前最多 32 個 bindings。Required dependency 不存在或 ambiguous 時，整次 acquire 被拒絕，不會留下半套 hold；optional send 當下沒有 handler，則不會憑空捏造一個 binding。

這裡保存的不只 executable bytes。Contract descriptor 也一起被 retained，因此不相容 replacement 不能只靠相同 topic 名稱偷換舊工作的 contract。新 generation 即使使用同一個 bundle name，也不能自動接管舊 owner；`call_retained` 會確認目前 caller revision就是 owner 最初綁定的 revision。

Retention store 先留下 mutation intent，等 closure 中每個 exact revision再次確認仍 admitted，才把它 confirm 成 held。若驗證期間 registry 已改變，流程會拒絕或重來，而不是把舊 direct edge與新 transitive edge拼成一個「大概可以」的結果。

最後形成的不是：

```text
owner O → provider P
```

而是：

```text
owner O
  ├─ owner revision
  ├─ contract descriptor
  ├─ topic T → P-A
  ├─ P-A requires U → Q-A
  └─ 其他 direct / transitive exact bindings
```

這才是 durable owner 實際承諾的 execution meaning。

## Closure 必須在 Inbox 可見之前生效

把 closure存進 database 還不夠。真正執行 message 時，那份 context 必須早於任何 observable work 生效。

Retained call 會走 `Framework::send_within`，按 closure 指定的 exact revision解析 handler，而不是查 current winner。`BusState::deliver_command` 建立 pending command後，還要把整份 closure context掛到 command ID。Provider 在處理這個 command期間若再 nested send，bus 就能沿用同一份 closure，找到 `Q-A` 而不是 current `Q-B`。

這裡曾經有一個只有並行執行才容易出現的 ordering bug。

早期實作先把 message push 進 activation inbox，然後才把 retained closure掛到 command。平常測試中兩個動作幾乎連在一起，看似沒有差別；但 inbox consumer 是另一條執行路徑，它可能在 push 後立刻醒來：

```text
錯誤順序
  1. 建立 pending command
  2. push inbox
  3. 掛上 retained closure

可能的 interleaving
  1. inbox 收到 command
  2. P-A 開始處理
  3. P-A nested send
  4. closure 尚不可見，改查 current registry
  5. 命中 Q-B
  6. 得到 A:B
```

Full parallel CI 實際抓到了這個 race。測試原本期待舊 provider與舊 upstream組合，卻觀察到類似 `P:Q2:old` 而不是 `P:Q:old` 的結果。

修正不是再加一個 retry，而是改變 happens-before relation：

```text
正確順序
  1. 建立 pending command
  2. 將 closure context 掛到 command ID
  3. push inbox
  4. provider 才可能觀察到 command
```

修正後 retention／fake-runtime suites在紀錄中又連續執行八次。本文沒有重新跑這些測試，因此這是 repository-recorded evidence，不是本篇新產生的 benchmark 或 receipt。

這個 bug 很能說明 plugin architecture 中「有 pin」和「pin 真正生效」的差別。只要工作先變得可觀察，任何稍後補上的 authority context 都可能已經太晚。

## Host Reopen 後，缺哪一版就拒絕

Dependency closure 若只存在 memory，就只能防 hot replacement，不能防 Host restart。

Saturn 的 retention store會保存 executable revision、contract descriptor與owner binding。Host reopen 時先載入 staged revisions、重建 retention index，再逐一確認 closure中的 exact revisions仍可用。

這裡最重要的 policy 不是「盡力恢復」，而是 **不 fallback 到 latest**：

- exact package bytes存在、revision可 admission、descriptor吻合，才恢復 retained owner；
- exact revision遺失、failed或disabled時，owner被標成 refused；
- current registry即使已有看似相容的新 provider，也不能代替缺少的舊 revision；
- owner release後，舊 code、contract與transitive holds才可以一起退休。

`projects/hosts/saturn/tests/retained_chain.rs` 用獨立建置的真 Wasm artifacts 驗證這個場景。Owner只命名第一個 topic，framework必須自行發現第二跳：

1. 安裝 owner、provider A、upstream A 與 contract A；
2. acquire owner retention；
3. 發布 provider B與upstream B；
4. 普通新工作得到 `B:B`；
5. retained owner仍得到 `A:A`；
6. 關閉並 reopen Host後，retained owner仍是 `A:A`；
7. release owner後，整個舊 closure才可退休。

這比「把舊 `.wasm` 檔留在硬碟」更強。真正被保存的是 code、contract與routing relation的組合；少任何一項，都應該停止，而不是默默猜一個最新版。

## Replacement 的自由，來自舊工作不被改寫

Exact retention看起來像在阻礙 upgrade，其實恰好相反。只有當舊工作不會被新版本偷偷改寫，operator才敢在它執行期間發布 replacement。

新工作可以立刻選 `B:B`。舊 owner繼續用 `A:A`。兩條路徑同時存在，直到 durable owner明確完成或release。這不是把整個 Station凍結在舊版本，而是把 replacement authority縮到正確範圍。

這也讓幾種 lifetime 可以分開：

| Lifetime | 被固定的東西 | 何時可以改變 |
|---|---|---|
| Activation lifetime | inbox、instance、短期 capability context | activation teardown／reconcile |
| Generation lifetime | 某個 admitted executable revision | 沒有 invocation／owner hold後 |
| Contract lifetime | retained topic schema與descriptor | 舊 owner release後 |
| Dependency-graph lifetime | direct + transitive selected revisions | 整個 durable owner結束後 |
| Worker lifetime | process、pipes、spool與controller lease | supervisor／recovery policy決定 |

Day 008 主要處理最後一列；Day 009 關注中間三列。Worker就算由獨立 supervisor完美保存，如果重連後 nested calls改走另一套 graph，仍然不是完整 continuity。

反過來也一樣：dependency closure保存得再完整，transient `process:spawn` worker仍可能隨 Station結束。Semantic continuity 與 process continuity 是互補條件，不能互相代替。

## 今天已經 Committed 什麼？

Saturn 目前 working tree clean，HEAD是 `56259f1c0f92eea71bbff2d2faa980c5944d2605`。9/9共有十二筆 commits；最後一筆只新增 repomix context-pack設定，沒有改 runtime behavior。

和昨天文章結尾相比，證據分界已經改變：

- Day 008 提到的 serve argument correction、ownership第7個test與dogfood review，已在昨天晚間後續 commit中提交；
- R1 exclusive state ownership仍是 committed；
- R2 已從 design-only前進到 **committed partial**：atomic state／event／intent／receipt與exact transitive retention已存在；
- R3 也已有 **committed partial** 的managed execution runtime、controller epoch fencing、spool／receipt與planned detach path；
- R4 production daemon／autostart／health／backoff仍 open；
- R5 durable task、artifact、diff、check、review與worker-side reproducible build仍 partial；
- 一般 transient ACP／Agent session沒有因此自動獲得跨 Station handover continuity，live handover紀錄仍可看到舊 session被標為 `lost`。

最新完整的 repository-recorded CI屬於 `4e9c6df` wave：Saturn tests 210 passed、0 failed、1 ignored helper；execution 91 passed；projection 21 passed；TUI 28 passed，並stage 33個packages。本文沒有重跑 Saturn tests。Exact HEAD後續只有context-pack change，但仍沒有一份明確標成 `56259f1` 的新 full-CI receipt，因此不能把上述數字寫成本文對HEAD重新驗證的結果。

尚未完成的範圍也不能被 `A:A` test掩蓋：完整schema migration／rollback、archive與pruning、external effect exactly-once、supervisor自身crash／machine reboot、R4 daemon lifecycle，以及所有Agent adapter改走managed continuity path，都仍是open acceptance work。

Saturn今天證明的是：一條bounded、可執行、跨replacement與Host reopen的semantic retention path已經存在。它不是整個ADE都已durable。

## 回到 Unity：長時間 Run 可以中途升級一半嗎？

把同一個問題放回 Unity Game Dev orchestration，`A:B` 會比抽象plugin graph更具體。

一個長時間Build或Test run可能間接依賴：

```text
Workflow plugin
  → workspace projection provider
  → Unity Editor / batch-mode adapter
  → build pipeline provider
  → platform toolchain provider
  → artifact parser / evidence provider
```

Run開始後若更新build pipeline與artifact parser，新run使用新版通常合理。但舊run若只pin Unity adapter，完成時卻用新版parser解讀舊版輸出，可能產生一份兩邊各自正確、組合起來卻從未驗證的evidence。

因此 Unity vertical slice真正要回答的不是「能不能hot reload plugin」，而是：

- 哪一個 durable owner代表這次Build／Test／Play Mode run？
- 哪些dependency edge會影響run meaning，必須進transitive closure？
- Editor、workspace、toolchain與evidence schema要pin executable revision、contract，還是外部environment digest？
- required dependency遺失時要refuse、pause還是宣告result indeterminate？
- operator撤銷capability時，retention是否仍必須讓effect-time policy立即生效？
- run結束後，誰release code、contract、workspace與worker holds？
- machine reboot後若只剩durable record、沒有exact engine或package bytes，系統能否拒絕而不是拿latest重跑？

這些問題目前沒有由完整Unity workflow回答。Saturn的retained chain是機制proof，不是Unity product completion。

但今天至少得到一個比「每個plugin有自己的version」更嚴格的invariant：

> **新工作可以選新graph；舊工作必須保留舊graph。Pin住第一個generation只保住入口，只有保存direct與transitive closure，才能保住整項工作的語意。**

昨天我擔心的是Station消失後conversation會不會結束。今天要補上的則是：即使conversation沒有結束，它醒來後說的還必須是同一種語言。
