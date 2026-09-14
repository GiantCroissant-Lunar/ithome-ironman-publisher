---
title: Day 012：Worker 還活著，不代表 Output 可信——Partial Frame、Spool Full 與 Recovery Prefix
timestamp: "2026-09-12T10:17:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Plugin Architecture
---

# Worker 還活著，不代表 Output 可信：Partial Frame、Spool Full 與 Recovery Prefix

今天的進度確實沒有昨天那麼大。

從 Day 011 的 committed baseline 往後看，9月12日只有兩筆 commits。第一筆修補 observer replay 與 workflow scope recovery，和昨天的 stream incarnation 主題很接近；第二筆的 commit message 則直接用了 `Prove`，不是 `Build`：證明 partial output 與 spool exhaustion 能跨 Station replacement 保持正確語意。

這個措辭很重要。8 MiB spool、output cursor與independent execution runtime並不是今天才出現的新subsystem。今天新增的主要是deterministic barriers、native replacement harness、real-Wasm regression與machine-readable evidence，讓原本的policy從「程式看起來如此」變成「可以故意在最差時機切斷Station，仍得到同一個結果」。

所以Day 012不硬湊一張功能清單，而是回頭補Day 008留下的一個洞：

> **Worker process還活著，只能證明process lifetime；只有完整frame經過durable commit boundary，replacement才能誠實重播output。**

Saturn目前的committed baseline是`main@2cf6c4f`。當前working tree已經在其上出現一批未提交的durable-observation follow-up；本文會把它留在dirty candidate層，不拿來替HEAD加分。

## 今天沒有大功能，只有更難逃避的 Gate

9月12日的兩筆commits可以這樣理解：

| Commit | 真正增量 | 不應誇大的部分 |
|---|---|---|
| `971f060` | 修正observer replay ordering、same-instance gap處理，以及workflow scope recovery | 多數observer語意已是Day 011主題；不是全新的event system |
| `2cf6c4f` | 以planned／abrupt replacement、partial-frame barrier、quota flood、hash-equal replay驗收output continuity | 8 MiB quota與production spool policy原本就存在；今天主要新增proof |

這種進度很容易在日誌中顯得不夠亮眼，卻是architecture最容易欠債的地方。

只寫happy-path test時，以下三句幾乎沒有差別：

- worker沒有死；
- bytes還在某個file裡；
- replacement可以從可信cursor繼續讀完整output。

真正做故障注入後，它們其實是三個不同的承諾。

Worker可以繼續執行，但最後一段pipe bytes只寫了一半；spool檔案可以存在，但最後一筆JSONL沒有完整落盤；new Station可以打開同一個execution ID，卻不代表它知道哪些bytes已經成為可觀察的record。

今天補上的不是更多API，而是「哪一句話有證據」的邊界。

## Worker 活著，不代表 Output 可信

想像Agent或build tool正在stdout寫一個JSON frame：

```text
{"kind":"result","value":"par
```

這段prefix可能已經離開worker userspace，也可能已被pipe reader讀到，但它還不是完整的logical frame。若Station剛好在這時replacement，新observer不能因為看見bytes就發布一筆result。

至少有三層狀態需要分開：

```text
Pipe bytes received
    │
    ▼
Complete logical frame recognized
    │
    ▼
Serialized spool entry durably committed
    │
    ▼
Output cursor published to readers
```

Day 008談worker與pipe ownership時，這條path仍是未完成的acceptance question。現在Saturn已有independent execution runtime持有child process tree、stdin／stdout／stderr與spool，不會因transient Station process消失就立即丟掉reader。

但把pipe搬出Station只解決「誰持有I/O」。它沒有自動回答：

- partial frame何時可見？
- long line如何切分而不破壞UTF-8？
- cursor何時前進？
- quota用完後是丟資料、停worker，還是繼續假裝成功？
- replacement如何證明paged replay和原spool完全相同？

Continuity的可信度，取決於這些較小的commit semantics。

## 從 Pipe Bytes 到 Committed Cursor

Saturn的execution runtime把newline當作logical line boundary。Reader可以累積多次pipe read，直到看到完整line；若單一line太長，則切成連續的`continued` entries，同時避免在UTF-8 character中間截斷。

同一個logical line的entries會在一個spool lock下連續處理，避免stdout與stderr把彼此的frame穿插成無法重建的順序。

真正讓cursor有意義的，是`Spool::append`的順序：

```text
1. 檢查加入這筆entry後是否超過MAX_SPOOL
2. 序列化完整entry
3. 寫入JSON bytes與newline
4. sync_data()
5. 更新committed mark
6. publish新cursor給readers
```

Reader能看到cursor時，對應entry的完整bytes已經通過durable write boundary。Cursor不是「runtime打算寫到哪裡」，而是「目前最多能證明到哪裡」。

這也說明partial trailing frame為何不可見。只要worker仍活著、pipe尚未EOF，沒有newline的prefix會留在framing buffer，不會先佔一個cursor。Replacement Station讀output page時，只能看到已committed window。

有一個容易忽略的例外：如果pipe真的EOF，最後一段沒有newline的bytes會被視為worker實際輸出的最後一行並commit。今天測的partial frame之所以保持不可見，是因為worker仍然存活，測試明確讓pipe維持open；它不是宣稱所有沒有newline的資料永遠無效。

這個差異讓「半個frame」成為可測的狀態，而不是依賴sleep與運氣。

## Partial Frame 如何跨過兩次 Replacement？

Native continuity harness讓worker先寫出一段沒有newline的JSON prefix，再建立一個file barrier，證明prefix確實已flush到仍由execution runtime持有的pipe path。

接著測試故意做兩種Station變化：planned replacement與abrupt loss。每次replacement後，新的Station都對同一execution讀output page；預期結果仍是空的，cursor不能因重連或重新attach而前進。

只有當harness明確允許worker補完剩下bytes與newline後，runtime才commit恰好一筆完整entry：

```text
Station A
  worker寫partial prefix
  barrier證明prefix已存在
  output page仍沒有新entry

planned replacement
  Station B讀同一execution
  output page仍沒有新entry

abrupt Station loss / replacement
  replacement再次讀取
  output page仍沒有新entry

worker收到continuation signal
  補完frame + newline
  sync entry
  cursor只前進一次
```

這個test真正保護的是negative space：在frame完成前，什麼都不應該出現。

若只驗最後能看到完整result，錯誤實作也可能先發布partial entry，再補發corrected entry，最後畫面看起來仍像成功。Deterministic barrier讓測試可以在最危險的瞬間詢問system，確認它沒有提前虛構truth。

Proof使用兩份immutable staged Station。Station process、event-stream instance與controller incarnation會變；execution runtime、execution ID、worker ownership與spool則保持。它沒有重送prompt，也沒有重新launch worker。

這比「PID還在」多了一個可驗收的承諾：同一個未完成frame不會因control-plane replacement被看成兩筆output。

## Spool Full 必須 Failed，不能 Silent Drop

Output continuity不只要處理restart，也要處理容量極限。

Saturn目前每個execution spool的bound是8 MiB，也就是`8,388,608` bytes。今天的harness會先確認Station已經退出，才放行worker大量輸出，確保真正承受flood的是independent execution runtime，而不是仍在線的Station幫忙維持happy path。

當下一筆entry會超過bound時，正確結果不是：

- 丟掉最舊資料後繼續；
- 靜默截斷目前frame；
- 假裝worker仍可持續輸出；
- 讓new Station以為continuity完整。

Runtime會把shared spool failure設為terminal，終止worker process tree，並將execution記為`failed`。目前reason是`output quota or spool I/O failure`；它誠實表達失敗，但尚未把quota與底層I/O錯誤分成更細的診斷類型。

Repository-recorded proof中，spool停在`8,385,317` bytes，低於`8,388,608`上限；代表既有prefix保留完整，而下一筆無法原子加入。最後留下1,013個entries，replacement以17頁讀回，paged replay與原spool計算出的SHA-256完全一致。

這裡的「retention complete」只代表：

> **目前聲稱保留的committed prefix完整無缺。**

它不代表worker原本想輸出的所有內容都已完成。Execution已是failed，後續input也必須回`execution is not running`，不能讓caller誤以為只要再送一次就能接著寫同一條stream。

Silent truncation最危險的地方，是UI可能仍顯示一個看似正常完成的末尾。Explicit terminal failure加上exact prefix，至少讓上層plugin知道：哪些output可被信任，哪些內容從未commit。

## Replacement 保留的是哪個 Identity？

Day 011把Station EventLog的cursor寫成`(stream instance, sequence)`。Day 012的output cursor屬於另一個owner，不能混成同一種東西。

| Identity | Replacement時的行為 | 用途 |
|---|---|---|
| Station process／event-stream instance | 改變 | 識別transient control plane與notification stream |
| Controller incarnation＋epoch | replacement attach時改變 | fence effect authority，拒絕stale controller |
| Execution ID | 保持 | 找到同一項managed execution |
| Derived worker identity | 保持 | 綁定attested owner，不以PID代替 |
| Native launch identity／PID | observation，可變或分層 | 診斷process，不是durable owner |
| Spool與output cursor | 由同一execution runtime保持 | replay完整committed output prefix |

Managed effect仍要經Host重新檢查current policy、alias admission與durable owner，再以controller lease執行。Status／output則是read path；它不把controller epoch當作output cursor identity。這不代表output endpoint沒有authorization，而是effect fencing與read position不能使用同一個數字冒充。

今天的proof也留下了一個很好的反例：第一次native attempt曾把MXC launcher PID誤認成protocol worker PID。該次run沒有被算成成功，harness修正後分開追蹤兩種identity才重跑。

這正好說明為什麼「那個PID還在」不是continuity contract。Launcher、protocol worker、execution owner、controller與spool各自有不同lifetime；用一個PID統稱，只會讓test在錯的process上成功。

## 三種 Cursor 不要混在一起

連續兩天都談cursor，但它們的truth owner不同：

### Station EventLog cursor

Day 011的`(instance, seq)`屬於bounded、in-memory event stream。Station restart時instance改變，client收到`restarted`，清cache，再由product plugin重新宣布current truth。它沒有保存old stream完整history。

### Execution output cursor

今天的cursor屬於independent execution runtime持有的spool。只要runtime與execution ownership仍存續，transient Station replacement可以讀回真正落盤的committed prefix。這不是reannounce，而是replay existing bytes。

### Durable owner event cursor

同一個committed wave還加入real-Wasm regression：先保存snapshot cursor `2`，之後commit events `3`與`4`，reopen Host後再commit `5`，接著以limit `1`逐頁讀回`3`、`4`、`5`；第二次reopen仍得到相同pages，而舊snapshot仍保持原本state。

這證明durable store sequence不由Host process lifetime擁有。但它仍沒有證明durable page與transient live subscription之間存在atomic handoff，也沒有把output spool、plugin checkpoint與domain event放進同一個transaction。

目前Saturn working tree中的dirty durable-observation candidate正嘗試補這一層：讓transient event只負責wake up，durable owner log負責authoritative replay。它已有targeted test紀錄，但尚未commit，full CI與final evidence也仍pending。Day 012不把它寫成已完成能力。

## Committed HEAD 與 Dirty Follow-up

Saturn current committed HEAD是`2cf6c4faff0b398aa5be929070595a2a622d5d1e`。這個baseline包含：

- observer replay與workflow scope recovery修正；
- partial-frame、spool exhaustion與exact-prefix native proof；
- real-Wasm snapshot／page reopen regression；
- 對應scripts、staging與committed review。

但current workspace不是clean。HEAD上方目前有14個tracked modifications與14個untracked files，主要是一波durable-observation implementation、tests、architecture與planning follow-up。

這些dirty changes包含operator durable snapshot／events操作、metadata wakeup、shared client helper與fault tests等候選能力。Review記錄targeted host與client suites曾通過，但full `moon run ci:ci`尚未完成，也沒有final-evidence manifest或commit。

因此本文的證據上限停在`2cf6c4f`。Dirty docs即使寫著關閉某個bounded gate，也不能取代commit與required validation。

同樣地，`971f060`已提交的workflow scope recovery很重要：run launch會先保存scope mapping，capture或process exit不自動等於scope可關閉，只有definitive refusal、release或completed reclaim才建立retryable retirement evidence。不過這和Day 010的「revoke不等於retire」相近，因此今天不把它再擴成主線。

## Repository Evidence 到哪裡？

本文沒有重新執行Saturn build、tests、staging或native proof。以下都是repository-recorded evidence：

- `moon run ci:ci`：14 tasks、5 cached，紀錄時間4分23秒；TUI 88 tests、695 assertions、0 failures；
- `moon run saturn:stage`：建立immutable `0.1.55-main.1`，但沒有部署到persistent development Station；
- real-Wasm test：snapshot cursor跨兩次Host reopen仍逐頁重播相同events；
- native proof：從Station `0.1.50-main.2`換到`0.1.55-main.1`，同一execution runtime／worker ownership跨planned與abrupt Station replacement；
- output receipt：8,385,317-byte spool、1,013 entries、17 pages，spool與paged replay hash一致；
- terminal evidence：quota／I/O failure保留、失敗後拒絕新input、cleanup後test process不存在；
- initial PID identity判斷錯誤的attempt明確不算成功，修正後才產生final receipt。

這些證據關閉的是bounded Station-replacement output contract，不是完整G7或所有Agent adapter continuity。

仍未證明的範圍包括：

- independent execution runtime自身crash或upgrade；
- machine reboot與OS logoff；
- arbitrary Agent adapter parser checkpoint與remote session reattach；
- mid-frame protocol state、pending approval與both-client完整matrix；
- output spool、plugin durable state、domain event與consumer checkpoint的atomic transaction；
- incompatible Station／client／supervisor ABI candidate；
- independently fenced allocation consumer holds；
- R4 daemon lifecycle與R5完整durable development loop。

Ordinary `agent-sessions` conversation也沒有因這份proof自動獲得restart continuity。今天驗收的是generic managed execution output boundary，不是所有product sessions。

## 回到 Unity：Log 還在，不代表 Result 完整

Unity Build、Test或batch-mode workflow很容易重現今天的問題。

一個Unity worker可能仍在執行，Station則因upgrade被replacement。Worker正在輸出一筆JSON test result、compiler diagnostic或artifact manifest，但最後一個frame只寫到一半。

如果new Station把pipe buffer中所有bytes直接渲染成record，UI可能提早顯示不存在的failed test、殘缺asset path或錯誤artifact digest。若log quota滿時silent truncate，Build甚至可能被標成success，只是最關鍵的尾端證據消失了。

更合理的contract是：

- complete diagnostic／test result通過framing與durable append後才取得cursor；
- partial frame在worker仍live時不可見；
- quota耗盡令run明確failed，既有prefix保持可重播；
- replacement只讀committed prefix，不重送Build command；
- final artifact／test summary要由product plugin根據terminal evidence解讀，不能只看process是否仍在；
- capture與workspace reclaim仍由另一個explicit lifecycle決定。

未來Unity vertical slice還要回答：

- Unity Console的multiline stack trace，哪一層定義logical frame？
- Test Runner result與raw stdout要共用cursor，還是各自有domain journal？
- log quota滿時應cancel Editor、只cancel run，還是進入capture-only mode？
- Editor存活但adapter parser replacement時，partial protocol frame由誰持有？
- result evidence、artifact manifest與workspace snapshot能否在同一commit boundary對齊？
- runtime本身crash後，spool與private workspace如何恢復？

Saturn目前還沒有完整Unity workflow回答這些問題。但9月12日的進度至少讓一個較小的句子可以被相信：

> **在Station-only replacement下，已完整持久化的output prefix可以被exact replay；未完成frame不會被提前發布，容量不足也不會被靜默包裝成continuity。**

今天沒有一個全新的plugin subsystem。真正的進度，是讓「worker還活著」不再成為跳過I/O truth的藉口。
