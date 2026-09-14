---
title: Day 013：拒絕也是 Plugin Acceptance——舊 Station 不懂新 ABI 時，為何不能偷換 Handler
timestamp: "2026-09-13T20:47:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Plugin Architecture
---

# 拒絕也是 Plugin Acceptance：舊 Station 不懂新 ABI 時，為何不能偷換 Handler

今天的Saturn不是沒有進度。

從Day 012的committed baseline往後看，9月13日共有十筆commits。昨天仍在working tree裡的durable-observation wave已經提交，接著又長出typed mutation outcomes、execution service、retained coordinator與workspace-runs durable facade，再用A／B publication、missing package、corrupt package與actual older Station做負向acceptance。

功能數量很多，但Day 013最值得寫的畫面不是「新plugin成功執行」。

而是這個：

> **舊Station可以正常啟動，generic recovery也還能操作；但三個product plugins因為Station不懂新ABI而全部拒絕載入。Worker、data與durable owners保持原狀，系統既不fallback到另一版handler，也不重新launch。**

這看起來像一場失敗，實際上卻是plugin architecture很難得的成功證據。

如果平台缺少required ABI時仍「盡力執行」，durable work可能被一套從未承諾相容的host重新解釋；如果retained A不見就自動換B，exact generation只剩文件上的裝飾；如果看不到launch receipt便再launch一次，recovery就可能製造第二個worker。

Day 013因此不問「plugin能不能跑」，而問：**當它不應該跑時，整個系統能不能誠實拒絕，同時保住稍後恢復所需的ownership與evidence？**

## 十筆 Commits，主角卻是一次拒絕

Saturn目前的committed HEAD是`main@fb12d87`。Day 012之後的十筆commits全部發生在2026年9月13日，可以分成四段：

1. 把原本dirty的durable observation提交，並補上typed mutation outcomes；
2. 建立independently installed execution service與retained coordinator；
3. 讓workspace-runs成為第三層durable facade；
4. 用crash、A／B publication、missing／corrupt exact package與older Station ABI逐步打穿recovery假設。

最後四筆尤其不是再加更多product功能，而是讓負向矩陣更接近真實部署：

- old owner繼續綁A，新operation才選B；
- retained A artifact缺失時拒絕，不借用B；
- retained package bytes損壞時拒絕，等exact repair；
- old Station缺required platform ABI時，product packages incompatible，但generic operator floor仍可用。

這條時間線也改變了Day 012的證據分界。昨天那批durable-observation changes不再只是dirty candidate，已由`42d5360`提交，後續interface又演進成`durable-outcomes`。但current workspace上仍有另一波7個tracked modifications與5個untracked files，主要是abrupt recovery acceptance follow-up；本文不把它算進HEAD。

## Platform ABI 與 Product Plugin 是兩層

Saturn的Host刻意只提供generic platform floor：

- host-minted scope；
- durable state、events、intents與receipts；
- typed durable outcomes；
- exact revision retention；
- managed execution；
- generic messaging。

Execution、workspace run、capture、finish與product recovery state machine則留在independently built plugins。

今天的關鍵ABI是`durable-outcomes`。它沒有把execution schema塞進Host，而是在generic durable `commit`／`ack`之外，提供typed outcome：

```text
commit
  ├─ committed
  ├─ conflict
  └─ incompatible

ack
  ├─ acknowledged
  ├─ conflict
  └─ incompatible
```

舊Station `0.1.50-main.2`不提供這份新platform ABI。對依賴它的execution service、coordinator與workspace-runs facade來說，正確結果就是incompatible。

Host不能偷偷用legacy durable call猜出等價behavior，因為typed outcome正是product plugin用來區分「成功提交」、「同identity不同payload」與「stored state／contract不相容」的依據。把三種結果壓回一個generic error，可能改變recovery decision。

這裡的拒絕不是Host知道execution domain；相反地，它只知道自己無法滿足package宣告的required import。Product behavior仍在plugins，platform只誠實承認ABI floor不足。

## 一個 Operation，三個 Durable Owners

今天的durable execution path不是一個巨大plugin，而是三層product composition：

```text
workspace-runs durable facade
        │
        ▼
execution-coordinator
        │
        ▼
execution-service
        │
        ▼
generic managed execution runtime
```

三層共享同一個canonical operation request，但不是共用一份可任意修改的state。

### 第一層：workspace-runs facade

`durable-control.submit`只接受Host提供的current scope。Caller不能在payload裡自報另一個scope，把work綁到不屬於自己的resource namespace。

Operation ID受限為穩定、短小的ASCII identity；request則正規化成`execution-request-v1`並計算SHA-256 digest。

Facade先用retention pin coordinator的exact topics與contract descriptors，再以durable outcome原子保存：

- facade state；
- domain event；
- pending action intent；
- `runs-lifetime` resource intent。

這些truth成立後，才retained-call coordinator。

### 第二層：execution-coordinator

Coordinator不直接spawn process。它再pin execution-service的submit、observe、capture、recover與finish routes，保存自己的pending action、child snapshot與`execution-lifetime` intent。

它的transient correlation map只追蹤目前這次live reply，不能充當delivery或completion evidence。Station restart後，真正能恢復的是durable pending action，不是記憶體裡曾經有一個callback。

### 第三層：execution-service

Execution service先retain自己的exact executable，再commit launch intent，最後才呼叫generic managed capability。

因此同一個operation會形成三份不同的durable owner records：

| Owner | Attested namespace | 保留的主要truth |
|---|---|---|
| workspace-runs | facade bundle + scope | product run、coordinator route、runs lifetime |
| coordinator | coordinator bundle + scope | child request、pending action、execution route |
| execution-service | service bundle + scope | launch intent、managed receipt、worker resource |

它們可以有相同request digest，卻有不同namespace、revision與lifetime responsibility。Payload不能只拿著operation字串就跨層接管另一個owner。

這也是為什麼older Station refusal不能只「跳過中間plugin」直接操作worker。三層ownership不是decorator chain，而是三個可獨立settle的durable boundary。

## Unknown 不等於 Retry

Execution service把launch outcome分成`accepted`、`refused`與`unknown`。

這三種狀態不能合併成「成功／失敗」：

- `accepted`：有receipt證明launch已被supervisor接受；
- `refused`：有definitive pre-effect evidence證明沒有launch；
- `unknown`：effect可能已發生，但reply、inventory或receipt不足以判定。

`observe()`只能讀receipt與status。Healthy inventory暫時缺少worker、runtime unavailable或reply malformed，都不能直接推論effect未發生，更不能自動重新launch。

只有caller明確送出：

```text
recover {
  operation,
  request-digest
}
```

而且digest和原request完全一致時，service才可重送相同的`launch-v1` identity與payload。Native controller若已有Completed receipt就replay；Pending／Uncertain保持unknown；retired identity也不能被recover復活。

這和Day 012的output replay是兩件不同的事：

- committed spool bytes可依cursor安全重播；
- external mutation outcome未知時，不能因timeout盲目重做effect。

Capture與finish也採同樣紀律。Capture需要terminal worker、matching identity、完整manifest與有界change count；finish還要exact capture digest、再次確認capture、commit finish intent，並確認native response同時是`released=true`與`data_retained=true`。

Process terminal、output captured、leases retired與work accepted是不同狀態。目前實作甚至明確保留「work acceptance需要另一層verification」；它沒有把CLI exit 0直接升格成coding task完成。

## 舊 Station 啟動成功，Product Plugins 全部拒絕

Committed acceptance會先讓一項operation經新版Station建立三層owners、exact retained routes與managed worker。接著planned shutdown這個compatible Station，再啟動實際的舊版Station `0.1.50-main.2`。

舊Station本身可以open同一份state，generic operator recovery也仍存在。它不是整個process立即crash。

但因為缺少`durable-outcomes` ABI，三個product packages都不能admit：

```text
Old Station
  ├─ generic state ownership：可用
  ├─ operator recovery floor：可用
  ├─ workspace-runs facade：incompatible
  ├─ execution-coordinator：incompatible
  └─ execution-service：incompatible
```

這段期間，正確的不變量是：

- 原worker不被第二次launch；
- 三個durable owners仍存在；
- exact revision／contract bindings不改變；
- private data與managed resource不被釋放；
- scope close仍因live ownership而busy；
- generic recovery不假裝自己能解讀product state machine；
- B版handler即使已發布，也不能替代retained A。

換句話說，舊Station能做的，是保護它理解的generic invariants；它不能假裝理解一份較新的product contract。

這個failure mode比「服務暫時Unavailable」更強。Unavailable通常代表目前沒有ready provider；incompatible則代表Host連required ABI語意都無法建立。兩者若都fallback latest，durable owner就失去exact meaning。

## 為什麼不能偷換 Handler B？

Saturn在older-ABI proof之前，先建立兩層較小的負向矩陣。

### A／B 同時發布

Existing owner retain coordinator A與execution A的exact descriptors。發布B後，新operation可以選B；舊operation仍必須走A。兩個workers可以同時存在，但route不能混版。

這延續Day 009的closure invariant，今天的新意是它跨越了三層product ownership，而不只是一個provider的nested call。

### A package遺失或損壞

若retained coordinator A artifact缺失，或execution A bytes corrupt，系統會反覆refuse。B即使完整、ready、排名更高，也不能接管A owner。

只有exact A bytes repair後，compatible Station才恢復原route，而且不二次launch。

如果missing A時改用B，表面上availability更好，實際上卻把「同一個operation」換成另一套未經owner同意的state machine。旧worker、pending action與capture format未必能被B正確解讀。

### Platform ABI也一樣

Old Station缺新ABI時，不能藉由換一版plugin掩蓋platform floor不足。Package selection與Host ABI compatibility是兩個gate；兩者都要通過，retained call才有意義。

所以refusal不是消極地什麼都不做。它主動保護了以下事實：**目前沒有任何被證明相容的execution interpretation可以接管這項work。**

## Compatible Station 回來後，接的是同一項 Work

當compatible Station再次啟動，它會重新admit exact retained packages、restore三層owner records，並觀察原managed worker／receipt，而不是建立一個看似相同的新operation。

Recovery必須保持：

- same operation ID；
- same immutable request digest；
- same scoped namespaces；
- same retained topic descriptors；
- same managed worker identity；
- no second launch；
- pending action依原command identitysettle。

之後產品層仍要明確走capture與finish。

Capture保存output與private workspace evidence；finish確認capture digest、native release與data retention，再讓execution service、coordinator與facade各自完成lifetime settlement。三把owner locks不是同一瞬間被Host強制清空，而是依各層已提交的terminal evidence釋放。

即使如此，work仍不等於accepted。目前尚未有完整的coding task／attempt／check／review product loop。Compatible recovery只能證明同一execution被接回並安全收尾，不能證明patch已通過測試、review或integration。

這個限制讓文章不會把F1 execution recovery誤寫成F4 development workflow完成。

## Committed HEAD 與 Dirty Abrupt Follow-up

Saturn current committed HEAD是`fb12d87c73cc45cdb94adb23bc01b4106a7aacd0`。上述older-Station ABI acceptance屬於HEAD，但主案例是planned replacement。

Current workspace仍有7個tracked unstaged changes與5個untracked files，主要修改test harness、Rust acceptance tests、Moon proof task與recovery-boundaries docs。它沒有新增一套production product runtime。

這批dirty follow-up把同一矩陣擴到更尖銳的情境：

- 精確kill Station child，保留runtime／worker／projection；
- old Station仍只提供generic recovery並拒絕三個packages；
- compatible Station以較新的controller epoch接回；
- SQLite crash後不用physical file bytes判定data是否改變，而比較完整logical schema、PRAGMA metadata與typed rows；
- 在retention acquire後撤銷`durable:write`，驗證first domain commit被拒後owner與exact binding仍可恢復。

Local review與ignored artifacts記錄focused tests、planned／abrupt cells與full CI結果，但這些changes尚未commit。Day 013因此只把它們列為follow-up direction，不把abrupt older-ABI case寫成committed acceptance。

這個分界也說明ignored proof、tracked review與Git commit不是同一層證據。Local machine曾跑過，不等於clone HEAD就擁有相同test source；review寫了結果，也不能替未提交patch建立release identity。

## Repository Evidence 到哪裡？

本文沒有重跑Saturn tests、CI、staging或native proofs。以下都是repository-recorded evidence。

和Day 013主線最直接相關的紀錄包括：

- durable observation wave：4個real-Wasm host tests、27個focused client tests／144 assertions；full CI中host／kernel 254、execution 157、projection 21、provider 3、TUI／MCP 115 tests／839 assertions；
- coordinator wave：focused pure snapshot、real-Wasm caller與execution regressions；full CI 14 tasks、7 cached，並有endpoint absence、explicit recovery與finish proof；
- workspace recovery／publication：focused 25 tests，full CI 14 tasks、5 cached；native A／B proof建立兩個workers並驗10個cells；
- missing／corrupt exact package：focused 13 tests，full CI 14 tasks、7 cached；native proof 12 assertions；
- committed older-ABI wave：五個native proofs共45個bounded cells；full CI 14 tasks、10 cached，紀錄時間5分05秒；TUI 117 tests／872 expectations。

這些證據支持planned older-ABI refusal與compatible recovery。它們不關閉：

- current dirty abrupt ABI case；
- incompatible client／supervisor完整matrix；
- automatic recovery policy；
- arbitrary parser checkpoint與pending decision recovery；
- multiple independently fenced allocation consumers；
- R4 daemon lifecycle；
- R5／F4 durable task、attempt、check、review與acceptance loop；
- ADE＋TUI兩個required renderers；
- game-scale storage、cache與derived-state measurements。

因此Day 013證明的是「拒絕與保留ownership」這條bounded contract，不是完整durable ADE已經完成。

## 回到 Unity：舊 Orchestrator 不懂新 Build ABI 時

把同一問題放回Unity orchestration，會遇到更高風險的版本差異。

假設一個Build run已經由新版plugins建立：

```text
Unity workflow facade
  → build coordinator
  → Unity execution service
  → Editor / batch-mode worker
```

中途control plane換成舊版Station。舊Station也許仍能打開state directory、看見worker與workspace，卻不理解新版build outcome ABI、artifact manifest或capture settlement。

這時最糟的「恢復」方式包括：

- 把新版outcome壓成legacy success／error；
- 因A package不相容就改用B解讀old run；
- 看不到receipt便重啟第二個Unity batch process；
- 因plugin載不進去就釋放workspace drive；
- 把process exit當成build accepted；
- 讓generic operator path直接修改product state。

更安全的contract是：

- old Station只維持它懂的exclusive state與generic resource invariants；
- dependent plugins明確incompatible；
- exact packages、worker與data繼續被held；
- new work可以等待compatible control plane，而不是猜測fallback；
- compatible Station回來後接回同一operation與worker；
- capture、artifact verification、checks與review各自留下durable evidence；
- 最後才由product workflow宣告work accepted。

未來Unity vertical slice仍要回答：

- Build contract升版時，哪些stored states可以migrate，哪些必須refuse？
- Editor還在跑，但parser／artifact schema不相容時，誰能安全capture？
- old Station要如何顯示「work仍被保留，但我無法操作」？
- operator是否能安裝exact repair package，而不破壞其他new operations？
- capture完成但checks尚未通過時，哪些leases可以release？
- compatible recovery後，TUI與ADE兩種renderer如何顯示同一份durable truth？

Saturn還沒有完整Unity workflow回答這些問題。但今天得到了一條比「舊版也能勉強跑」更可靠的原則：

> **Plugin acceptance也包括可預期的拒絕。當Host不懂required ABI，正確行為是保住identity、ownership與evidence，等exact compatible path回來；不是偷換handler，也不是把unknown變成retry。**

能跑是一種能力。知道什麼時候絕對不能跑，才是durable plugin architecture的邊界。
