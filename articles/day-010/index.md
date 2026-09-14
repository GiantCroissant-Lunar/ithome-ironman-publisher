---
title: Day 010：Pin 住 Code，不等於凍結權限——Saturn 如何把 Revoke 送進 Durable Worker
timestamp: "2026-09-10T10:17:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Plugin Architecture
---

# Pin 住 Code，不等於凍結權限：Saturn 如何把 Revoke 送進 Durable Worker

昨天寫到 Saturn 如何替 durable owner 保存 exact direct／transitive dependency closure：新工作可以使用 `B:B`，舊工作仍維持 `A:A`，不能在 replacement 後悄悄混成 `A:B`。

那篇文章最後留下了一個刻意沒有回答的問題：**如果 operator 在舊工作還活著時撤銷 capability，retention 會不會連舊權限也一起凍結？**

如果答案是會，那麼 durable worker 就可能把昨天取得的 grant 當成永久通行證。Plugin generation雖然沒有漂移，authority卻再也收不回來。

如果答案是不會，問題又變成：worker已經不在 Wasm activation裡，而是由獨立 native supervisor擁有；Station甚至可能在撤權途中斷線。這份 deny要怎麼找到正確worker、跨Host reopen重試，又不誤殺碰巧使用同一alias的另一個runtime？

Saturn在9月10日的十一筆commits中同時推進了output replay、managed input queue、receipt retirement、private environment、MCP adapter、TUI與NT object namespace準備。但最適合延續昨天主題的，是最後提交的managed permission propagation。

今天的核心不變量可以濃縮成一句話：

> **Retention freezes interpretation, not permission. 舊工作可以保留舊code來被正確理解與收尾，但不能靠durability保留已被撤銷的effect authority。**

## Retention 固定語意，不固定權限

一個managed工作至少同時有兩條不同的軸：

| 軸 | 回答的問題 | Saturn保存的identity |
|---|---|---|
| Interpretation continuity | 這項工作應該用哪套code、contract與provider graph解讀？ | durable owner、exact executable revision、contract descriptor、transitive closure |
| Current authority | 這項工作現在還被允許做下一個effect嗎？ | attested bundle namespace下的current policy，例如`managed:use` |

Day 009處理第一條軸。Owner已經綁到Revision A時，replacement不能把它偷換成Revision B。

Day 010則刻意證明第二條軸沒有被第一條凍住。即使Revision A與worker resource仍被retained，下一次managed effect仍要服從現在的policy。

假設一項工作目前是：

```text
Owner O
  ├─ exact code / contract closure：Revision A
  ├─ managed resource：held
  ├─ worker W：running
  └─ current managed:use：granted
```

Operator撤權後，正確結果不是立刻刪掉所有舊資料，也不是讓O拿著舊grant繼續跑，而是：

```text
Owner O
  ├─ exact code / contract closure：仍是 Revision A
  ├─ managed resource：仍 held，等待capture與收尾
  ├─ worker W：revoke後cancelled
  └─ current managed:use：denied
```

這個區分很重要。若撤權時順便unload舊plugin、刪掉workspace或退休owner，系統可能連partial output都無法用原本的contract解讀；若只保留資源卻不重查authority，durability又會變成繞過operator control的方法。

所以 retained generation與current permission不是同一份狀態，也不能由同一個「active／inactive」布林值代替。

## 一次 Revoke 要跨過哪些 Boundary？

普通Wasm effect的撤權相對直接：下一個host call重新檢查grant，回typed denied即可。

Managed worker比較麻煩。它的process tree與pipes已經交給獨立execution runtime，feature plugin甚至可能暫時無法load。Revoke不能只改Station memory，也不能依賴原plugin activation收到callback。

Saturn目前的路徑是：

```text
Operator / CLI revoke
    │
    ▼
Host::revoke
    ├─ 更新 managed:use = deny
    ├─ 先持久化 policy
    └─ after_policy_change()
          │
          ▼
ManagedCapability::reconcile_revocations
    ├─ 從retention逐頁尋找 held / intent workers
    ├─ 以attested bundle namespace重查current policy
    ├─ 驗證immutable alias / state path / profile / worker binding
    ├─ 向supervisor查詢exact worker status
    └─ 取得新controller lease，送出reserved revoke command
          │
          ▼
Native Controller
    ├─ 驗證incarnation + epoch fence
    ├─ 以owner + command + payload digest做replay / conflict判斷
    └─ 只執行一次cancel / revoke effect
          │
          ▼
Execution Runtime
    ├─ 設定cancel flag
    ├─ 終止worker process tree
    ├─ 將record標成cancelled
    └─ 拒絕後續input
```

第一個關鍵是 **先保存deny，再嘗試transport**。`Host::revoke`在policy change lock內更新並寫入policy，之後才reconcile native resources。Supervisor暫時不可達，不會讓deny回滾成grant。

第二個關鍵是 **不依賴guest告訴Host有哪些worker**。`RetentionCapability::visit_workers`從durable owner records尋找trusted managed resources；即使負責產品功能的Wasm plugin壞掉，operator recovery仍能找到native process ownership。

第三個關鍵是 **alias名稱不等於worker identity**。Retention binding還固定runtime state path、profile與worker digest。若operator把同名alias改指另一個runtime，reconcile會fail closed，不會把舊owner的revoke送給不相關的worker。

Worker identity也不是PID。它由attested bundle與durable owner導出；controller lease則另外使用incarnation與monotonic epoch。這讓replacement Station可以取得新的控制epoch，舊controller即使仍持有socket也不能再執行effect。

最後，Station送出的reserved command使用固定identity `station-policy-revoke-1`，但receipt scope包含worker owner；不同worker可以安全使用相同reserved名稱，同一worker的lost reply則能replay原結果。Guest command會被hash成另一種grammar，不會與operator reserved command碰撞。

## Deny 本身就是 Durable Retry Record

分散式撤權最危險的句子是：「我送過revoke，所以它應該已經停了。」

送出request不等於supervisor收到；收到不等於result回到Station；Station失去reply也不能因此盲目送一個語意不同的新command。

Saturn把幾種結果分開：

- supervisor確認同一command已完成：replay既有receipt；
- reply遺失：保持同一owner／command／digest，之後重查或重送；
- runtime不可達：policy仍是deny，狀態回`revocation pending`；
- controller epoch過期：stale controller被fence，不執行callback；
- alias／profile／state path不吻合：拒絕操作，不猜測target；
- receipt quota或controller fault：仍是pending，不能宣稱worker已停。

Host reopen時會先恢復retention index，再對denied resources執行reconcile。因此deny不需要依賴原本那個Station process繼續活著。

這也反過來限制regrant。若operator很快把`managed:use`改回grant，而前一份revoke其實仍在網路另一端等待，可能出現以下危險順序：

```text
Station A：persist deny
Station A：送出 revoke，但reply遺失
Station B：直接寫回 grant
Supervisor：稍後處理舊 revoke，殺掉已被重新授權的工作
```

目前`grant`、整份policy replacement與default restoration在改回允許前，都要先reconcile尚未settle的deny。Pending revoke不能被一筆方便的regrant擦掉。

同時，這不是retroactive transaction。已經在同一control mutex內完成admission的effect可以先完成；程式沒有宣稱撤權能把過去的effect rollback。Revoke保證的是deny持久化之後，新的managed calls不能再穿過current permission check，既有native worker則進入可重試的termination path。

這種failure contract比「revoke API回200」更保守，也更接近真正的authority semantics。

## Revoke 不是 Retire

Worker被cancel後，最直覺的清理方式是立刻release所有東西。但對durable工作來說，這可能讓failure evidence一起消失。

一個被撤權的Build、Agent run或workspace operation仍可能留下：

- 已經寫入spool但尚未capture的stdout／stderr；
- private workspace中的合法修改、partial artifact或tombstone；
- 用來解讀output的舊contract與exact plugin revision；
- pending／uncertain receipts；
- operator需要review的termination reason與cursor。

因此managed revoke只做兩件事：撤銷未來effect authority，並要求native runtime停止worker。它**不會**自動release retained code、workspace或resource hold。

合理的lifecycle是：

```text
GRANTED + RUNNING + HELD
    │ persist deny
    ▼
DENIED + REVOKE PENDING + HELD
    │ fenced idempotent revoke
    ▼
DENIED + CANCELLED + HELD
    │ capture / inspect / reconcile
    ▼
explicit release or abandon
    │ terminal proof
    ▼
RETIRED + TOMBSTONE
```

今天另一組commits正好補強最後一步。Controller journal不再永遠保存每一張completed receipt；只有`release`或`abandon`明確成功時，terminal effect才會在同一durable write中退休該owner的其他completed receipts，留下terminal receipt、所有uncertain receipts與bounded tombstone。

若terminal result寫入失敗，已移除的receipt會被restore，這次command轉成uncertain。系統不能在「effect可能已發生」時，為了節省quota就把history刪掉。

Journal接近容量上限時也為terminal commands保留空間。普通工作不能把journal塞滿到連release都進不去；但revoke目前仍屬ordinary admission，沒有使用terminal reserve。這代表journal pressure仍可能讓revoke維持pending，是current committed limitation之一。

這個設計把三件事分開：

- **cancelled**：worker不再執行；
- **held**：舊code與resource仍被保留供capture／解讀；
- **retired**：terminal evidence已寫入，可以釋放hold。

只用一個「stopped」狀態，無法同時表達這三層truth。

## Receipt 只證明它承諾的那一層

今天Saturn也把managed input從blocking pipe write改成有receipt的bounded queue。

Station提交input時，controller先以command identity建立durable `Pending`，runtime接受bytes後回傳enqueue sequence，再由supervisor-owned writer依序寫入pipe。Slow reader只會讓queue達到bound並回definitive refusal，不再長時間持有controller fence，也不會因單次pipe timeout直接kill worker。

但這張receipt只證明：

```text
enqueued
  = supervisor接受bytes與sequence

delivered
  = writer完成pipe write

不等於
  = Agent protocol已parse
  = prompt / approval已套用
  = domain effect已完成
```

Input queue本身目前仍在runtime memory；native runtime死亡時，queue與pipe仍會一起消失。真正的Agent protocol acknowledgement、external session ID、pending decision與parse cursor仍是adapter責任。

這和revoke的原則相同：每一層只對自己能證明的事負責。Supervisor receipt不能冒充conversation-level success，Station送出deny也不能在沒有receipt／status evidence時冒充worker已終止。

Plugin architecture若把所有結果都壓成「success／failed」，就會在最需要recovery時失去判斷依據。

## 今天的 Progress 為什麼選 Revoke 當主線？

Saturn目前working tree clean，current HEAD是`b30f0e31997aa5ae502a05928490d09c110a6aed`。9月10日共有十一筆commits。

其他進度並不是不重要：

- output replay加入committed marks、sparse cursor index與scan accounting；
- runs plugin與TUI可以觀察多個runtime aliases並live follow；
- one-shot run可以取得只存在transient sandbox policy中的private environment，durable policy保持redacted；
- projection record固定provider ID與exact revision，recovery缺implementation時拒絕fallback；
- MCP只是既有Station與TUI endpoints上的adapter，沒有建立第二套authority；
- NT object namespace已有inspect／grant／revoke與launch preflight機制，但本次evidence沒有實際套用machine ACL grant；
- receipt retirement、terminal reserve與input queue讓native continuity更有界。

我選managed revocation，是因為它把前幾天分開的問題接在一起：Day 008問誰擁有worker，Day 009問工作使用哪一套plugin graph，Day 010則問那個owner即使仍存在，現在還有沒有權做下一個effect。

這也是plugin architecture很容易漏掉的第三條軸。Load、pin、reattach都成功，不代表authority可以不再變動。

## Repository Evidence 到哪裡？

Current source沒有dirty follow-up；相關code、tests與review都已提交。Local ignored evidence主要在`build/_artifacts/agent-readiness-20260910/`與retained-station proof目錄，不能當成Git-tracked source。

Committed continuation review記錄：

- `moon run ci:ci`通過，13個tasks完成、6個cached；
- managed lifecycle suite包含5個tests，涵蓋revoke送達並保留resource、lost／unavailable跨reopen、pending deny阻止regrant、alias redirect fail-closed與planned handover；
- native continuity proof共有9組assertions，其中包括permission revoke終止owned worker、late input被拒絕、regrant不會復活舊worker；
- TUI記錄為56 tests、433 assertions；
- real-agent readiness另記錄三種one-shot profiles與一條installed-plugin run完成exact edit、correlated check、capture與release。

本文沒有重跑Saturn build、tests或native proofs。

還有一個重要provenance限制：final validation發生在`aabf203`加working changes的source-hashed tree，staged manifest因此記為`dirty: true`；那些changes之後提交成clean `b30f0e3`。Repository沒有一份明確標成clean `b30f0e3` post-commit rerun的full-CI receipt。所以最準確的說法是 **repository-recorded pre-commit source-hashed evidence，後續已提交**，不是本文重新驗證current HEAD。

Acceptance狀態也仍需保守：

- R2有exact provider identity、receipt retirement與tombstone增量，但完整migration／rollback、archive與external exactly-once仍open；
- R3的bounded managed permission propagation已committed，但supervisor crash／upgrade、machine reboot、durable input queue、完整adapter recovery與both-client matrix仍open；
- R4 daemon、health、backoff與autostart仍open；
- R5 real-agent evidence增強，但durable task／artifact／diff／check／review contract與worker-side reproducible build仍未完成；
- 普通`agent-sessions` conversation仍不跨Host，restart後會標成`lost`並保留transcript。

因此今天完成的是一條bounded managed revocation path，不是所有Agent conversation都已獲得durable、revocable control。

## 回到 Unity：撤權後，舊 Run 要怎麼收尾？

把今天的問題帶回Unity orchestration，場景會更具體。

一個長時間Build或Test run可能已retained舊版workflow、workspace projection、Unity adapter、build pipeline與evidence parser。這能確保結果不會因plugin replacement變成昨天談的`A:B`混合語意。

但run執行途中，operator仍可能撤銷：

- 對某個workspace的寫入權；
- network或package registry access；
- Unity Editor／license worker使用權；
- artifact upload capability；
- secret或platform signing authority。

正確行為不能是「因為run durable，所以繼續做完」。下一個effect必須看到current deny；已經在執行的effect則要留下completed、refused或uncertain的真實結果。

同時，也不能一撤權就刪掉舊workspace與parser。系統仍需要用原本的Revision A解讀partial output、capture private changes、標記artifact incomplete，最後由明確的release／abandon退休resource。

這會產生一組仍待Unity vertical slice回答的acceptance questions：

- 哪些capability能只阻止新effect，哪些必須立即終止Editor process tree？
- revoke reply遺失時，Build UI要顯示pending、cancelled還是indeterminate？
- 已送進Unity pipe但尚未由Editor protocol ack的command，要如何reconcile？
- Signing或upload權限撤銷後，local artifact是否仍可capture與review？
- Workspace alias被重新配置時，如何確保舊run的revoke不會碰到新project？
- Machine reboot後，deny、owner、exact code與terminal evidence能恢復到哪一層？

Saturn目前還沒有完整Unity workflow證明這些答案。但今天至少把一條原則做成了可執行路徑：

> **Durable owner保存的是工作identity與收尾所需的舊語意，不是永久權限。Authority可以被撤銷；而撤銷本身也必須有identity、fencing、receipt與retry。**

昨天確保舊工作醒來後仍說同一種語言。今天則補上：即使它還記得怎麼說，也不代表它仍被允許繼續說下去。
