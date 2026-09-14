---
title: Day 014：文件不是功能——Saturn 如何用 Evidence Ledger 守住 Architecture Claim Boundary
timestamp: "2026-09-14T10:17:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Plugin Architecture
---

# 文件不是功能：Saturn 如何用 Evidence Ledger 守住 Architecture Claim Boundary

今天真的沒有新的功能進展。

以Asia/Taipei日期核對Saturn，9月14日沒有任何commit。Current HEAD仍是昨晚的`main@08fc3a4`；staged與tracked working tree都是clean，只有兩份尚未追蹤的discussion notes。

如果硬要延續前幾天的節奏，很容易從那兩份討論稿挑一個漂亮架構，寫成「Saturn下一步已經是這樣」。但那會把研究筆記、決策、實作與驗證混成同一種進度。

所以Day 014不假裝今天又完成一個plugin subsystem，而是整理一件更基礎的事：**每一句architecture claim，究竟要指向哪一層證據？**

前幾天的文章一直區分committed、dirty、design-only與repository-recorded evidence。今天把這套做法正式整理成一份Architecture Evidence Ledger：

- code存在，不一定已commit；
- commit存在，不一定有required validation；
- test通過，不一定就是production capability；
- architecture文件存在，不會自動增加runtime behavior；
- local proof存在，不代表clone repository後也取得同一份receipt；
- build與commit完成，也不等於development environment已部署；
- discussion提出方向，更不等於roadmap已核准。

昨天寫「拒絕執行也是acceptance」。今天補上另一種拒絕：**拒絕讓claim跑在evidence前面。**

## 今天的進度是：沒有新 Commit

先把現在的狀態寫清楚：

```text
Date:        2026-09-14 Asia/Taipei
Saturn HEAD: 08fc3a4abaf3923e16520585c307dcf5e430b2a6
9/14 commits: 0
Staged:      0
Tracked dirty: 0
Untracked:   2 discussion notes
Deployment:  沒有新的development deployment evidence
Validation:  沒有新的9/14 CI／native proof
```

兩份untracked discussion不是沒有價值。它們在探索OmniRoute如何選agent／model，以及plugin modernization是否需要更generic的requirement／capability vocabulary。

但它們現在只屬於研究層：沒有commit、沒有approved brief、沒有acceptance matrix，也沒有production implementation。文件中的後段甚至會修正前段較大的構想，說明作者自己仍在用current code與controlling docs收斂問題。

因此今天合理的說法不是「Saturn採用了新的router」或「plugin system將改成generic resolver」，而是：

> 兩個方向正在被討論；目前沒有architecture authority將它們升格成delivery plan。

零commit不需要被包裝成另一種commit。它只是提醒我：日更文章不能反過來驅動architecture claim。

## 七分鐘後，Evidence 的身分改變了

Day 013的文章timestamp是9月13日20:47。當時Saturn有7個tracked modifications與5個untracked files，我在文章中把它們標成abrupt recovery follow-up，不算committed HEAD。

七分鐘後，20:54:54，這12個paths完整進入`dd9c87c`：

```text
Day 013 source cut      20:47:00
  └─ 7 tracked + 5 untracked：dirty candidate

dd9c87c commit          20:54:54
  └─ 同一批paths：repository history
```

這不表示Day 013寫錯。文章記錄的是當時可證明的狀態；後來的commit也不能倒流，讓20:47的dirty tree在七分鐘前自動成為HEAD。

同樣地，commit並沒有把所有內容都變成runtime feature。`dd9c87c`主要增加test harness、acceptance evidence、SQLite logical snapshot helper與文件；它擴大planned／abrupt Station recovery的證據，沒有新增product scheduler、kernel ABI或native execution engine。

這個小時間差很適合說明Evidence Ledger的目的：

- **內容身分**回答「這是code、test、docs還是discussion？」
- **Git身分**回答「它屬於哪一個baseline？」
- **驗證身分**回答「哪些source被哪一組gate測過？」
- **部署身分**回答「哪個binary／package真的在development environment運行？」

少了任何一個座標，「已完成」都可能只是把不同時間點疊在一起。

## 三筆 Commit，三種不同的進度

Day 013文章之後，同一個晚上還有三筆值得分開理解的commits：

| Commit | 類型 | 可以支持的claim | 不能支持的claim |
|---|---|---|---|
| `dd9c87c` | tests／harness／docs／build wiring | abrupt recovery與retained preparation有更強acceptance evidence | 新production runtime已增加 |
| `cc708f1` | docs-only contract／priority | F4 durable work的ownership、scope與delivery order已凍結 | work／orchestrator已可執行 |
| `08fc3a4` | runtime plugins＋tests＋docs | bounded work與orchestrator plugins已實作並通過記錄中的gates | 已部署、已完成真實provider task、完整R5／G7已關閉 |

如果只用「三筆commit、很多files changed」描述進度，三者看起來差不多。但architecture意義完全不同。

`cc708f1`最能說明文件不是功能。它修改`AGENTS.md`與foundation priorities，新增durable-work contract與implementation brief，決定先做bounded F4 reconciler，也禁止把task／model／workspace schema塞回kernel。

這些決策很重要，因為它們限制接下來能怎麼實作；但它不會讓一個Wasm component憑空出現，也不會讓任何worker開始執行。

直到`08fc3a4`，repository才真正加入`work`與`orchestrator`兩個independently installed product plugins、contracts、manifests、tests與native deterministic proof。

所以Architecture Evidence Ledger至少要把「決定做什麼」與「已經能做什麼」放在不同欄位。

## 一份文件，在 Ledger 裡扮演什麼角色？

Saturn目前有多種文件。它們不是重複寫同一份README，而是在不同時間尺度回答不同問題。

### `AGENTS.md` 與 foundation realignment：決策與順序

這一層定義delivery authority：現在優先關哪個gate、哪些invariant不能為了趕功能被繞過、哪些product nouns不能滲回platform floor。

它回答「接下來允許往哪裡走」，不是「現在已走到哪裡」。

### Architecture contract：凍結bounded語意

`durable-work.md`定義work與orchestrator的ownership、wire records、one-attempt state machine、receipt bound、pending-before-send與explicit resume。

它也同時列出automatic checks、retry、workflow materialization、unattended bootstrap與完整R5／G7仍未實作。

Architecture contract的價值不是讓未完成項目看起來完整，而是提前寫下：哪些行為一旦實作就必須符合，哪些行為明確不在本次claim內。

### Brief：工作指派與 Acceptance Intent

Brief指定要改哪些邊界、由誰持有truth、需要哪些test evidence。它是assignment，不是pass receipt。

一份漂亮brief最多能證明問題被定義；不能證明implementation存在，更不能證明failure matrix已通過。

### Review：Evidence Lineage

Review記錄baseline、working diff、tested source、focused suites、full gate、native proof、commit與remaining limits。

它是最接近實驗紀錄的文件，但仍必須保留時間語境。Review中的「目前未提交」可能在capture當下正確，之後被另一筆commit歷史化。

### Delivery status：Current Index

`delivery-status.md`把F0–F4與E1–E8收斂成current gate ledger。閱讀舊review時，應先由current index知道後來哪些candidate已提交、哪些gate仍partial或open，再回頭看當時的proof。

它不是重寫歷史，而是告訴讀者：目前該從哪一個座標進入歷史。

### Plugin README：局部實作邊界

Work README說明work plugin保存與驗證execution／check／review observations，但不spawn process。Orchestrator README則說明它沒有native managed／process permission，只透過retained typed calls操作既有execution coordinator。

這些README很適合回答「這個package負責什麼」，卻不能單獨宣稱全產品gate已完成。

### Discussion：研究，不是 Roadmap

今天的兩份untracked discussion位於最外層。它們可以比較alternatives、暴露盲點、甚至在同一份文件中推翻前半段假設。

正因如此，在被brief／decision採納前，它們不該出現在「current architecture」欄位。

## Claim Ledger：七種看起來都像「完成」的狀態

把目前材料整理後，可以得到一個更實用的claim taxonomy：

| 層級 | Saturn目前的例子 | 允許的說法 |
|---|---|---|
| Committed runtime | `08fc3a4`的work／orchestrator Wasm plugins | bounded implementation exists |
| Committed test capability | `dd9c87c` recovery harness與`08fc3a4` tests | named scenarios have repository-recorded evidence |
| Docs-only decision | `cc708f1` priority與contract | direction／claim boundary was committed |
| Historical dirty snapshot | recovery review capture當時的7＋5 | candidate existed at that baseline |
| Local ignored receipt | `build/_artifacts` proof／source snapshot | this machine recorded a run for specified source |
| Deployment | review明確寫development未升級 | capability is not yet the running development product |
| Open gate | real provider task、unattended resume、retry、G7 | design／acceptance work remains |

這七層不能用一個`done`取代。

尤其local ignored evidence很容易被高估。它可以保存binary hash、source hash、process IDs與proof JSON，對追查本機實驗非常重要；但`.gitignore`排除它，代表另一個clone不會自然取得同一份artifact。

反過來，committed review雖可隨Git追溯，也只是repository-recorded assertion；除非本文重新執行gate，不能寫成「今天再次驗證」。

今天我沒有重跑Saturn build、CI或native proof。Day 014只整理既有lineage。

## 沿著 Code 做一次 Claim Audit

文件整理不能只看文件。至少要回到code與tests，確認contract沒有超過implementation。

Current committed work plugin實作的是一個bounded one-attempt record：

- immutable request；
- attempt固定為1；
- execution observation；
- external check evidence；
- review record；
- matching execution已retired、check passing且review accepted後，才能成為completed。

它不launch worker，也不自行執行check或召喚reviewer。它保存與驗證由外部提供的evidence。

Current orchestrator則持有desired-vs-observed decision：

1. 先從durable task與coordinator snapshot計算下一個action；
2. delivery前先commit pending action；
3. 再透過retained typed call送往work或execution coordinator；
4. `status`只觀察，不偷偷schedule；
5. timer只做bounded observation；
6. Station loss後，要明確呼叫`reconcile(work)`才重新綁定retention並恢復activation-local loop。

Unknown launch不會自動呼叫recover。這延續前幾天的原則：不知道effect是否發生時，不能把「我想繼續」翻譯成「再做一次」。

Installed tests使用scripted supervisor驗single launch、unknown hold、scope isolation與reopen／reconcile；standalone proof則使用deterministic native worker。

真正的OpenCode／Kilo coding sessions是用既有Workspace runs dispatcher產生implementation，不是由新orchestrator執行真實provider task。這是目前最重要的claim boundary之一：

> **新的work／orchestrator path已通過bounded deterministic proof，但尚未承載一次真實provider coding assignment。**

文件若只寫「durable work loop implemented」，而不附上這句，讀者很容易把execution mechanism誤認成完整self-hosting development product。

## Review 是 Snapshot，不是 Current Status

`docs/reviews/20260913-recovery-boundaries.md`保留「這一波changes尚未提交」的文字。從current HEAD看，這句已經過時；但它在review capture當下是正確的。

最差的修法是回頭把舊review改成「已提交」，因為那會抹掉實驗當時的baseline。更好的做法是：

- historical review保留原本觀察；
- commit history記錄candidate何時進入repository；
- current delivery index指出今天應採用哪一個status；
- 新文章引用時同時寫出capture time與current resolution。

Evidence Ledger不是讓每份文件永遠顯示同一句「最新狀態」，而是讓不同時間點不互相冒充。

另一個措辭殘影是「explicit human review」。Current code驗證的是一份operator-supplied review JSON，並確認capture／check digest一致；native test提交的是固定review fixture。

因此可以說「review evidence record與acceptance gate已實作」，不能說「真實人工code review workflow已完成」。UI、reviewer identity、實際閱讀diff與approval authority仍不是這份proof能證明的內容。

類似地，文件若寫「byte-identical command」，較準確的實作語意其實是canonical payload結構與欄位值相同；raw JSON whitespace或key order不是identity。這不破壞dedupe設計，但提醒我們：文件的每一個形容詞也需要接受source audit。

## Contract、Implementation、Validation、Deployment 是四道門

把今天的整理再壓縮，可以得到四道最常被混在一起的門：

```text
Contract
  └─ 語意與責任已被凍結

Implementation
  └─ code真的存在於committed source

Validation
  └─ 指定source通過指定tests／CI／native proof

Deployment
  └─ 指定binary與packages成為目前運行中的development product
```

`cc708f1`通過第一道門。`08fc3a4`加入第二道，repository review記錄第三道。第四道仍未通過：文件明確寫著development Station未升級，新packages未部署。

這四道門不是線性百分比。Contract可能先凍結再被implementation反駁；implementation可能通過unit tests但敗在native proof；validation可能針對source-hashed working tree，commit後仍需要核對lineage；deployment也可能因operator policy而刻意延後。

因此「merged」不是產品狀態的同義詞。

## 9/14 的 Discussion 要放在哪裡？

今天兩份untracked文件提出了有趣方向。

第一份討論BearPunch與OmniRoute的分工：誰選agent／model，誰持有durable acceptance與process authority。文件後段已把較早的「BearPunch只選CLI」修正成：OmniRoute可以從BearPunch授權的candidates中選agent＋model，但BearPunch仍擁有execution與acceptance truth。

這個方向可能有價值，但current repository沒有一般化agent router API，也沒有對應brief、contract或acceptance tests。

第二份討論更generic的plugin requirement／capability vocabulary、rollout與supply-chain hardening。後段再次用current code修正前段：exact closure、provider semantics與make-before-break其實已有不少基礎，不需要把整個system重做成另一套framework；generic resolver目前最多是vocabulary候選，F4仍是控制順序。

這些自我修正正是discussion的功能。它允許提案在成為architecture authority前被repository現況反駁。

所以Day 014可以引用它們作為「research exists」，但不能把它們列入Saturn current features，也不能寫成approved roadmap。

## Repository Evidence 到哪裡？

今天沒有新的validation。以下都是9月13日committed reviews記錄的結果，本文未重跑。

`dd9c87c` recovery wave記錄：

- focused installed-Wasm suites共18 tests；
- planned與abrupt native modes各14個bounded assertions；
- compatible Station／runtime／worker `0.1.62-main.1`，older Station `0.1.50-main.2`；
- full `moon run ci:ci`為15 tasks、7 cached、5分37秒；
- TUI 117 tests／872 expectations；
- development Station／TUI保持原版本。

`08fc3a4` durable-work wave記錄：

- 8個work-state tests、4個controller tests、19個pure validation tests；
- full `moon run ci:ci`為15 tasks、7 cached、10分57秒；
- TUI 117 tests通過；
- standalone native proof只產生一個submission與一個native execution；
- same worker與live projection跨planned Station restart；
- explicit `reconcile(work)`後automatic capture、bounded Bun external check、fixture review與retirement／completion成立；
- duplicate submit／reconcile沒有產生第二個job；
- 第一個native attempt因release後再做durable write而失敗，失敗紀錄保留且不算pass；
- tested source lineage從`cc708f1`＋implementation diff一路記到final commit；
- development environment尚未部署這套新packages。

這些數字支持bounded implementation與named acceptance scenarios。它們不支持：

- 真實provider coding task已經走新controller；
- automatic check placement與retry已完成；
- unattended restart bootstrap已完成；
- 真實人工review UI與authority已完成；
- full R5／G7已關閉；
- 9/14 discussions已採納；
- 今天重新驗證過current HEAD。

文件整理的成果，就是讓這份「不支持清單」和pass list一樣容易被找到。

## 回到 Unity：沒有新 Build 功能，也可以避免未來說錯

把Evidence Ledger帶回Unity orchestration，會得到一個比「文件要寫完整」更具體的要求。

假設未來加入一條durable Unity Build workflow：

- architecture文件定義Build owner、Editor worker、artifact與review authority；
- brief指定需要跨Station restart、domain reload與quota failure；
- implementation加入plugins與adapter；
- tests用fake Editor驗state machine；
- native proof用batch mode產生artifact；
- development deployment才讓團隊日常使用。

這六件事不能被一句「Unity Build plugin完成」取代。

Evidence Ledger應該讓每一個claim回答：

- 這是contract、code、test、proof還是deployment？
- 對應哪一個commit與source hash？
- 使用fake、deterministic worker還是真Unity Editor？
- 測的是planned replacement、abrupt loss還是machine reboot？
- artifact是否真的被review，還是只提交fixture approval？
- current development environment是否已載入這些packages？
- 哪些failure semantics仍open？

今天沒有新增Unity capability，也沒有新增Saturn runtime capability。但整理文件讓下一篇不容易把「Build contract已寫」誤成「Build已可恢復」，也不會把「native proof通過」誤成「已在團隊工作流部署」。

這種進度不會出現在TUI，也沒有漂亮demo。它的價值是讓未來的demo只能說它真正證明的事。

> **文件不是功能；好的文件是claim的型別系統。它不替runtime執行工作，而是拒絕讓contract、test、commit、deployment與open gate被錯誤地當成同一種值。**

Day 014沒有新commit。最誠實的產出，是讓這句話本身也有證據邊界。
