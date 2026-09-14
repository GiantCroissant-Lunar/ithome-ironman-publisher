---
title: Day 011：Seq 不是 Cursor——Saturn 如何讓 Observer 跨 Station Restart 不說謊
timestamp: "2026-09-11T10:17:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Plugin Architecture
---

# Seq 不是 Cursor：Saturn 如何讓 Observer 跨 Station Restart 不說謊

前幾天連續把 Saturn 的 continuity 拆成不同問題：

- Day 008：Station 消失時，worker、pipes 與 conversation 還在不在？
- Day 009：工作醒來後，是否仍使用原本那整條 plugin dependency graph？
- Day 010：retained worker 現在是否仍有權做下一個 effect？

今天輪到另一個看起來比較小，卻足以讓 client 永久等待的問題：**observer 手上的 sequence number，究竟屬於哪一次 Station event stream？**

假設 watcher 最後看到 Station A 的 `seq=752`，斷線後便等待 `753`。新的 Station B啟動，event sequence重新從`1`開始。

如果cursor只保存數字，client會把「同一條stream暫時落後」與「已經換成另一條stream」混為一談。它可能等到B累積752個events才恢復，也可能把B的`seq=752`誤認成A的下一筆歷史。

Worker可以還活著，run ID可以沒變，exact plugin revision與permission也都正確；observer仍然可能說謊。

Saturn在9月11日的進度，為這個問題加入了一個看似簡單、實際上決定recovery semantics的identity：

> **Sequence number只有在一個event-stream incarnation裡才有意義。Cursor不是`seq`，而是`(stream instance, seq)`。**

## Seq 不是 Cursor

Sequence適合回答同一條stream內的先後順序，卻不能單獨識別stream本身。

每次Station建立新的`EventLog`時，sequence都會重新從1開始。這不是bug；新的process沒有義務延續上一個transient log的counter。真正的bug是讓client看見一個裸數字，卻沒有告訴它這個數字屬於哪一次open。

因此Saturn現在為每個`EventLog::new` mint一個opaque instance。Client cursor變成：

```text
Cursor = {
  instance: "這一次 event stream 的 identity",
  sequence: "這條 stream 內的位置"
}
```

這個instance不是authorization token，也不是plugin generation、run ID、scope ID或controller epoch。它只做一件事：限定sequence在哪個namespace中可以被解讀。

幾種identity不能混用：

| Identity | 它識別什麼 | Restart後是否必然改變 |
|---|---|---|
| Run ID | 一項產品工作 | 不一定；independent runtime中的run可繼續 |
| Plugin revision | 執行與解讀工作所用的exact code | 不一定；可以重新載入同一revision |
| Controller epoch | 哪個controller目前有權操作native worker | replacement attach時改變 |
| Scope ID | 一組host-minted visibility／resource context | 依durable ownership決定 |
| Stream instance | 這一次Station EventLog incarnation | 每次新EventLog都改變 |
| Sequence | 同一stream內的相對位置 | 每個新stream重新開始 |

把stream instance誤當authority，會讓protocol identity膨脹成安全承諾；把它省略，則會讓兩條不同history的同號event發生aliasing。

Day 011處理的是後者。

## Run 由 Plugin 宣告，不由 Client Poll

先有正確cursor identity，還不代表有值得觀察的product event。

Saturn沒有把Run state machine寫進kernel。Execution runtime仍擁有process、output與status truth；`saturn-workspace.runs` plugin負責把這些truth轉成typed product announcement。

它的路徑大致是：

```text
Independent execution runtime
    │ status / output / capture / release truth
    ▼
workspace-runs plugin
    ├─ reconcile observed run
    ├─ 等output follower到正確位置
    ├─ 建立typed run announcement
    ├─ events::emit("run", payload)      → clients
    └─ messages::publish(run topic, ...) → other plugins
          │
          ▼
workspace-usage plugin
    └─ 依run ID保存latest announcement並聚合terminal usage
```

同一個payload會走兩條generic floor：client event log，以及plugin message bus。Kernel只知道event kind、data、scope、sequence與instance；usage plugin也不需要direct import runs plugin，只訂閱typed topic。

Announcement不是每次loop都重複發送。`workspace-runs`保存上一份announced snapshot，只在值得觀察的truth改變時發布：

- first sight看到live run：立即宣布current state；
- first sight已是terminal：先等output follower追到EOF；
- live轉terminal：等final output與usage summary穩定後再宣布；
- terminal後capture或release狀態改變：state雖沒變，仍重新宣布新的current truth。

這避免client自己反覆poll status、拼接output、猜terminal usage何時完整。CLI watcher與MCP `station_wait`可以等待typed announcement，而不是每秒呼叫run status。

但「runs are announced, not polled」有一個必須說清楚的範圍：`workspace-runs` plugin內部目前仍會週期性觀察independent runtime。消失的是client／orchestrator端的status loop，不是整個stack從此沒有任何polling。

還有另一個重要限制：目前`events::emit`與`messages::publish`的結果不會形成一筆durable atomic product transaction。短暫emit failure可能要等下一次transition或plugin restart，才由snapshot重新宣布current state。這是一條restart-safe observation path，不是durable exactly-once event history。

## 每次 EventLog 都要有新的 Instance

Generic event floor需要把stream identity帶到所有會產生cursor的地方。

Saturn目前會在endpoint metadata、hello、`pid`、`list`與每個subscribe reply中提供instance。Subscribe request也可以附上cursor所屬instance。

Host根據tuple判斷兩種完全不同的failure：

```text
request.instance == current.instance
  ├─ from仍在bounded retention內 → replay，再接live
  └─ from早於oldest             → lagged

request.instance != current.instance
  └─ 舊from對新stream無意義
       ├─ restarted = true
       ├─ 回current instance / oldest / latest
       └─ 從新stream oldest replay
```

Restart時不能拿舊的`from=753`直接套到新stream。Host會明確回`restarted`，忽略舊數字，從新stream可提供的oldest開始。

同一stream內因bounded deque丟掉早期event，才叫`lagged`。這時client知道自己錯過的是同一段history，應該改走snapshot或其他recovery policy，而不是假裝restart。

Server建立subscription時也先取得live receiver，再做replay，避免在「讀完舊events」與「開始聽新events」之間出現空窗；接到live event後再以sequence去除已由replay送過的項目。

Scope filter與stream reset則保持正交。Replay與live events都還要經過`visible_in(watching_scope)`；新instance不會擴大client可見範圍。

舊client若沒有傳instance，Host仍保留first-edition behavior以維持相容。但這也表示新的restart guarantee只屬於更新後、真正攜帶tuple的clients；protocol不能靠server單方面替裸seq補出它原本屬於哪一條stream。

## Restart 不是 Lag

把所有中斷都叫disconnect，會讓recovery path失去選擇依據。Saturn現在至少區分：

| Outcome | 代表什麼 | Client應做什麼 |
|---|---|---|
| `closed` | transport斷線，尚不知道Station是否換代 | 重讀endpoint並嘗試reconnect |
| `restarted` | cursor屬於另一個stream instance | 清掉舊cache／ring，從新oldest重建 |
| `lagged` | 同一stream，但bounded retention已丟掉cursor前events | 停止假裝連續，改讀snapshot或明確失敗 |
| `timeout` | 仍連線，但期限內沒有符合條件的event | 回報等待逾時，不改寫history |
| `gave_up` | reconnect budget耗盡 | 明確停止，不把未知狀態說成terminal |

CLI watcher在connection close後會重新讀取endpoint，因此token與instance都可以一起更換。它用舊`(instance, lastSeq + 1)`提出resubscribe：

- 同一instance，繼續原cursor；
- Host回`restarted`，丟棄舊cursor，將位置重設到新oldest之前；
- Host回same-stream `lagged`，以不同exit outcome停止；
- 一直沒有endpoint，直到reconnect budget耗盡才`gave_up`。

MCP adapter也維持一個shared Station link、單一subscription與bounded event ring。Stream改變時，它清掉舊ring並重設anchor。`station_wait`會先比較request cursor與目前hello的instance；即使background Watch還在resubscribe window，也不能從舊ring挑一筆看似matching的event回答。

這個細節避免一種很難察覺的錯誤：新Station已經在endpoint宣布新instance，MCP cache卻還殘留舊stream event。若只比較run ID與sequence，client可能把舊terminal result當成新觀察。

Stream identity讓cache知道何時整批失效，而不是只刪掉最後一個數字。

## Live Handover 實際發生了什麼？

Repository-recorded live proof使用兩份staged Station，觀察同一個run跨planned handover。

Station A的stream在launch前cursor已到`657`，watcher看到run `plugin-121`於`seq=721`進入running，connection最後關在`752`。

如果只保存數字，下一步會等待`753`。

Replacement Station B建立另一個instance，sequence重新從1開始。Watcher以舊tuple resubscribe後收到`restarted`，Host從新stream的oldest replay 52筆events。`workspace-runs`重新觀察仍在independent runtime中的同一run，於新stream `seq=47`宣布first-sight running，之後在`seq=263`宣布completed。

```text
Run plugin-121 / worker continuity
────────────────────────────────────────────────────▶

Station A stream IA
  cursor before launch 657
  running 721
  connection closes 752
                         ╳
Station B stream IB
  oldest 1
  replay 52 events
  first-sight running 47
  completed 263
```

Watcher最後exit 0，MCP `station_wait`取得同一筆terminal event。切換期間曾出現兩次`no endpoint` retry，但沒有client-side status polling，也沒有重送prompt或重新launch run。

這份proof最重要的不是數字很大，而是它沒有讓B數到753，也沒有把A的752接成B的753。Execution continuity是一條線；Station event streams則是兩段不同incarnations。

## Reannounce Current Truth，不是假造 Event History

Restart後看到同一個run繼續，不代表舊event log已被durable保存。

Saturn的`EventLog`目前仍是bounded、in-memory transport。Station缺席期間若runtime發生數個transition，新Station不能從不存在的old log還原每一步。

它能做的是：

1. observer明確知道舊stream已結束；
2. 新Station恢復plugins與client connection；
3. `workspace-runs`重新觀察independent runtime；
4. plugin在新stream宣布它現在能證明的current truth；
5. client清除舊stream cache，以新instance重新開始。

這是reconstruction，不是history replay。

如果run在Station缺席期間從running經過intermediate state再到completed，新observer可以看到new-stream first-sight completed，但不能聲稱自己收到所有中間transition。真正需要跨absence保存的domain history，仍應進durable store／journal，而不是要求transient notification counter假裝連續。

同樣地，run reannouncement也不是conversation reattachment。普通`agent-sessions` plugin在Host activate時仍會把未結束session標成`lost`、清除pending，並在transcript追加「host restarted: the conversation ended」。Day 011沒有改掉這份contract。

今天補上的是observer correctness：仍存續的managed run可以被重新看見，而且client不會因stale cursor永久等候。它沒有讓每一種Agent session自動跨restart存活。

## 其他 Progress 為什麼沒有成為主線？

Saturn目前working tree clean，current HEAD是`ed537e5ea7722a222c483c3b3f89274112b7b79d`。Day 010基線後共有七筆commits，其中一筆是9月10日晚間的scope setup，六筆屬於9月11日。

今天還有幾條值得保留的進度：

- D21把scope做成host-minted call context，而不是每個scope建立一個plugin activation；後續又加入scoped durable／retention／managed owner namespace core；
- `saturn-ai.provider-routing`成為獨立Wasm plugin，以persisted readiness、priority、freshness與cooldown選alias／provider／model，而不是把policy寫進Host；
- run在process完成後可自動capture，但private allocation只有explicit `finish-use`／`reclaim`才代表orchestrator真的用完；
- reclamation在刪除private root與drive lease前驗證capture，失敗時保留data與lease；
- TUI改善compact tables與filters，但沒有把run schema硬編進generic renderer。

這些題目都能獨立成篇。不過allocation scope目前仍缺guest binding、run→scope persisted mapping與完整product integration；routing plugin也尚未部署到persistent development Station，缺automatic probe、quota／capacity、reservation與launch failover；explicit finish則和Day 010的「cancel不等於retire」太接近。

相較之下，stream incarnation已經有kernel、host protocol、TypeScript client、CLI watcher、MCP與live handover的完整縱向證據，因此更適合Day 011。

## Repository Evidence 到哪裡？

Current source沒有dirty follow-up。Stream identity、run announcement、watcher／MCP reconnect與相關tests都已提交到clean `main@ed537e5`。

Repository-recorded evidence包括：

- kernel test驗證每次open都有新stream instance，且oldest隨retention移動；
- host process test真正關閉並reopen同一state，確認stale cursor收到`restarted`；
- TypeScript protocol restart test核對endpoint、hello、list與subscribe instance；
- CLI watcher restart test核對connection `closed`後出現old→new reset；
- MCP restart test核對named stale cursor、impossible unnamed future cursor與new-stream real event；
- contract checkpoint與integrated observers兩輪full CI在committed review中記錄green；
- staged live proof記錄Station A→B、同一run、watcher exit 0與MCP terminal event。

本文沒有重跑Saturn build、tests、handover或agent dispatch。

Current workspace仍有ignored local observation receipts，例如`build/_artifacts/dispatch-20260911-observation/`；它們不是Git-tracked source。另一方面，部分committed reviews引用的早期artifact directories目前已不在workspace，因此不能宣稱每一份舊bundle仍可現場重新檢查。

也沒有找到一份明確以clean `ed537e5`作source revision的machine-readable full-CI manifest。最保守的說法是：**repository-recorded integrated source evidence，後續已提交至clean HEAD**，不是本文重新驗證current HEAD。

Acceptance狀態仍要分層：

- R2新增stream identity與scoped owner core，但EventLog仍transient，完整durable transition history、migration／rollback與external exactly-once仍open；
- R3關閉了一條observer restart gap，但incompatible candidate、mid-frame、pending approval、supervisor crash／upgrade、machine reboot、durable input queue與both-client matrix仍open；
- R4 daemon、health、backoff、persistent logs與autostart仍open；
- R5的provider routing、capture／review／explicit finish更完整，但durable task／artifact／diff／check／review contract與worker-side reproducible build仍未完成；
- allocation scope是committed core，尚不是completed run integration；
- ordinary Agent conversation仍是restart後`lost`。

Day 011證明的是一條restart-aware observation path，不是完整R2／R3或產品durability已完成。

## 回到 Unity：Build 還在跑，Observer 卻換了一個世界

Unity orchestration很容易遇到同一種錯覺。

一個Build、Test或Play Mode run由獨立worker／Editor持續執行；Station因upgrade重新啟動，TUI、MCP client或CI watcher仍想等待terminal result。

若observer只保存`seq=4201`，新Station從1開始時，它可能永久等待。更糟的是，若新stream未來也到4201，client可能把不同incarnation的event誤認成連續history。

正確recovery需要分開三件事：

```text
Execution continuity
  Unity / worker / run可能持續

Observation continuity
  client辨識舊stream結束，對新streamreset

Durable history
  缺席期間真正需要保存的domain transitions進journal
```

新Station可以重新觀察Unity run的current state，宣布「這個run現在仍在執行」或「目前已完成」。它不能因此聲稱知道Station缺席期間每一次asset import、test case transition或console event。

也不能因為observer斷線就重送Build command。Reconnect的目的，是恢復觀察，不是重演effect。

未來Unity vertical slice仍要回答：

- snapshot應包含哪些Build／Test current truth，才能在`restarted`後安全重建UI？
- 哪些transition必須durable，哪些只需transient notification？
- same-stream `lagged`時，client能從哪個authoritative snapshot補回？
- Editor本身restart與Station event-stream restart，是否使用不同incarnation identities？
- 多個TUI／MCP／CI consumers能否各自持有獨立cursor與retention policy？
- terminal result若在Station缺席時產生，誰負責保存exact evidence與usage？

Saturn還沒有完整Unity workflow回答這些問題。但今天至少把一個常見錯誤從protocol中拿掉了：

> **Counter可以重新開始，identity不能靠猜。跨restart的observer必須先承認舊stream已結束，再由product plugin重建current truth；它不能把裸seq當成永續cursor，也不能把reconstruction冒充history。**

Day 008讓我們不要把transcript當conversation；Day 011則提醒：也不要把sequence當cursor。
