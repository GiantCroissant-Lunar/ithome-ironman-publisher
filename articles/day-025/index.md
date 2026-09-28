---
title: Day 025：Agent 記得，不代表找得對——Jupiter 長期記憶的召回驗收
timestamp: "2026-09-25T20:47:00+08:00"
tags:
  - AI Agent
  - Agent Memory
  - Vibe Coding
---

# Agent 記得，不代表找得對：Jupiter 長期記憶的召回驗收

Day 024 把 MCP servers 與 Skills 帶到 Agent 開工的現場。接下來，很自然會想替它接上長期記憶：專案已經做過的決定，下一個 Agent 應該找得到。

例如問它：

> 平台的持久化紀錄，應該放在哪一種資料庫？

Jupiter 已經有明確決定：平台的 durable store 使用 SQLite，SurrealDB 用在知識層。這件事寫在 decision 54 與 ADR-0025 裡。但換一種問法，先前的召回卻沒有把預期紀錄排到前面。

這讓今天的問題變得具體：資料已保存、工具也能回覆，我們要如何確認 Agent 在需要時拿到適用的紀錄？

9 月 24 日到 25 日，Jupiter 完成 knowledge sidecar、記憶契約，以及一輪召回品質修正。本文沿著這條路，從「接得上」走到「找得對」，也看測試通過後仍留下什麼問題。

## 先把做過的決定，變成能查詢的紀錄

Knowledge sidecar 是在 Station 外執行的知識服務，以 Semantica 的 ContextGraph 搭配 SurrealDB 保存資料，透過 MCP 提供查詢。資料庫放在 checkout 外，讓知識不隨某個 worktree 的移除而消失。

Day 024 建立的工具與 Skill 配發，在這裡有了實際用途：Session 收到 `knowledge` alias，並取得 `bearpunch-knowledge` Skill，知道在提出設計前先查已有決定。

既有 live review 記錄，一個 scratch workspace 裡的真實 Claude Code session 載入了這份 Skill，呼叫 `find_precedents` 與 `query_decisions`，正確找出「topic shape 改變時要使用新 ID」的 decision 31。

另一條入口則提供給 Station 裡的 Bundles。它們透過共同的 memory contract，向記憶 Provider 提出要求：

```text
Git 裡的決策、ADR、事實與 review findings
→ seed 到 knowledge sidecar
→ memory-semantica Provider 經由 Host 的 MCP capability 查詢
→ 透過 memory contract 回傳紀錄與召回收據
```

CLI 直接呼叫知識工具，和 Bundle 使用 memory contract，是兩條入口。這次評估主要驗證後者。最新版 Provider 的召回使用 `search_graph` 的語意查詢；`find_precedents` 仍是 Agent 可用的工具，但已不是 Provider 內部的召回路徑。

收進知識層的內容也有選擇。現在以有來源的結構化紀錄為主，包括決策、ADR、事實、歷史沿革與 review findings。Brief、討論全文與 source code 沒有整批索引；紀錄透過 `source` 指回需要閱讀的文件。

例如「某次 worker 等待背景測試回呼，結果一直沒有完成」，原本藏在 review 裡。把它整理為 finding，後續 Agent 才能用問題的意思找回這段經驗，再追到原始證據。

## Agent 的新觀察，先保存成候選

能寫入記憶之後，下一個問題是：Agent 說的一句話，會不會在下一次工作時變成專案規則？

Memory contract 將這個界線放進行為裡。長期記憶的 `record` 會建立 `candidate`，保存提出者的 bundle、session、work 等來源。即使要求的 kind 是 `decision`，也不會直接取得正式決策的身分。

正式採納需要回到 Git 裡的來源文件，由負責 review 與整合的 parent 更新，再重新 seed。對於由檔案維護的決策或事實，`revise`、`forget` 會回覆 `memory/file-backed`，指出應修改的來源。

預設召回只接受 `accepted` 與 `unverified` 狀態；候選、已取代與歷史紀錄，必須明確要求才會進入對應查詢。這能避免剛記下的猜想自動成為下一次工作的預設依據。

每次召回還會回傳 receipt，包含正規化查詢的雜湊、依順序回傳的紀錄 ID、Provider 與其 revision 欄位，以及時間。呼叫端可以保存它，之後核對這次工作實際收到哪些紀錄。

這份收據描述的是一次召回，還不能代表 Agent 的完整上下文，也不能證明 Agent 已閱讀或採納每一筆結果。

## 用會換句話說的問題，測試召回

工具可以回覆，不代表排序已經有用。這輪工作先固定一份 32 題的評估集，題目刻意使用 Agent 可能提出的問法，而非照抄原始紀錄。

例如：

- Bundle 的訊息想多加一個欄位，可以直接加嗎？
- 開發服務升級後讀不到舊狀態，該怎麼辦？
- Agent session 如何取得工具 servers 與 Skills？

實際測試使用英文題目。29 題有指定的預期紀錄；另外三題問麵包食譜、吉他調音與股價預測，知識庫都沒有答案，用來確認系統會不會硬塞不相干的紀錄。

這裡使用的 `recall@3`，計算方式是：在有答案的 29 題中，有幾題能在前三筆找到至少一個預期紀錄。它是這份專案評估集的命中比例，沒有測 Agent 最後生成的回答是否正確，也還沒有驗證中文問法。

評估經過真正的 Station、memory contract、Provider 與 sidecar，在獨立的測試資料庫與 graph 執行。測試替身負責驗證契約行為，真實 sidecar 的 gate 才提供這組召回品質數字。

第一份 baseline 的結果很清楚：前三筆命中 18／29 題，約 62.1%。更值得注意的是，三題沒有答案的問題，竟然各回傳了十筆紀錄。

如果 Agent 把這些結果當成「相關的專案背景」，長期記憶就開始往工作裡加入噪音。

## 先讓相似度有意義，再乘上紀錄權重

這次修正分成幾步，沒有只換一個模型就結束。

第一步是補上查詢指令。BGE 的官方模型卡對查詢相關段落的用途，建議在 query 前加入 retrieval instruction，段落本身不需要加入。[BGE 模型卡](https://huggingface.co/BAAI/bge-base-en-v1.5#model-list)

本次設定依照這個用法。既有 worker 的實測紀錄也確認，當時使用的 fastembed 0.8.1 路徑沒有自動補上這段指令，因此由 sidecar 明確加入。

第二步是讓不同 kind 的紀錄都能依語意查詢。先前 decisions 與其他紀錄走不同的比較方式，現在 facts、findings、candidates 等也建立向量，Provider 使用同一套相似度來源。

第三步才是排序前的校準。

契約會依 kind 與 status 給權重，例如 decision／ADR 是 2.0，已驗證 fact 是 1.7，candidate 是 0.8。但如果連不相關紀錄的原始相似度都偏高，乘上權重之後，較不相關的決策也可能擠掉更貼近問題的候選紀錄。

因此這次為每個模型量測一條 no-match floor：先用另外 20 題知識庫無法回答的問題做探測，取最高 cosine，向上取到小數點後兩位。評估集原本的三題無答案問題保留作檢查，沒有拿來設定這條線。

目前採用的模型，floor 是 0.51。Provider 使用的規則是：

```text
relevance = clamp((cosine - floor) / (1 - floor), 0, 1)
score = relevance × kind/status weight

cosine 在 floor 以下或等於 floor：不回傳
```

這是本次模型與資料上的經驗校準，分數沒有「答案正確機率」的含義。更換模型或查詢指令後，需要重新量測 floor。

模型、revision、維度與 query／passage instructions 也一起納入向量身分檢查。既有 graph 與設定不符時，sidecar 會拒絕使用，要求重新建立向量，避免新查詢與舊向量悄悄混在一起。

## 同一份題目，逐步看見改善

以下數字來自已提交的量測 JSON，全部是經過 Provider 的結果：

| 設定 | 第一筆命中 | 前三筆命中 | 三題無答案各回傳幾筆 |
|---|---:|---:|---|
| Baseline：bge-small，原有召回方式 | 44.8% | 62.1% | 10、10、10 |
| 補 query instruction、各 kind 都建立向量 | 51.7% | 62.1% | 10、10、10 |
| 再加入 bge-small 的 floor 校準 | 65.5% | 72.4% | 0、0、1 |
| 改用 bge-base 與其 floor 校準 | 69.0% | 82.8% | 0、0、0 |

前兩列也提醒我：把資料都轉成向量之後，第一筆變準了，前三筆命中率卻沒有增加，無答案問題仍然塞滿結果。每一步的效益需要分開量，才知道還缺什麼。

最後固定的設定是 `BAAI/bge-base-en-v1.5`，768 維，搭配 query instruction 與 0.51 的 floor。模型比較中，gte-base 的前三筆命中率也達到相同水準；bge-base 的預期答案整體排名較前，模型下載量約為其一半，因此被選用。這是當時的本機比較，不能延伸成對所有資料集的模型排名。

最終結果是 24／29 題在前三筆命中，三題無答案都回傳零筆。開頭那題資料庫問題，decision 54 排到第一。

驗收線是 80%，所以這次只多過了一題：如果再少命中一題，就會變成 23／29，約 79.3%。紀錄增加、問題換了說法或模型改版，都有重新評估的理由。

## 測試要能抓到被拿掉的規則

Memory contract 有 fake 與 Semantica 兩個 Provider 共用的契約測試，驗證候選、狀態、排序與 receipt 等行為。Semantica 那一半使用 sidecar 替身；召回 gate 再接上真實服務。

9 月 25 日的 parent review 記錄，在合併後的獨立 checkout 與 fresh target，Station 323 tests、conformance 20 tests 通過，knowledge 的六組測試與 memory gate 都各跑了三次。Memory gate 每次通過 17 項 assertions，召回數字一致。

Negative controls 則故意移除規則，確認測試會失敗：

| 刻意改壞的地方 | 既有紀錄中的結果 |
|---|---|
| 不加 query instruction | 前三筆命中降到 79.3%，一題無答案又回傳紀錄 |
| 不做 floor 校準，直接使用相似度 | 六項 gate assertions 失敗 |
| Parent 將設定裡的 floor 從 0.51 改成 0.01 | 六項 assertions 失敗，三題無答案各回傳十筆 |

還有一個和檢索演算法無關的發現：worker 修改了 gate 裡評估集副本的一個 byte，conformance 卻重播快取的通過結果。檢查雖會比對兩份題目，執行它的 moon task 卻沒有把這個副本納入輸入雜湊。

修正後，這個檔案也成為 task 的 input。題目被改動時，檢查才會真正重跑並失敗。這次修補針對該檔案，其他跨出 task inputs 的讀檔仍須各自檢查。

## 找回正確答案，仍可能夾帶已失效的事實

把新版裝回日常使用的 Station 後，live recall 同樣把 decision 54 排在第一。它卻也找回 F-18：那筆描述早期召回失敗、現在已標為 `false, see F-29` 的事實。

原因在另一條路上。Seeder 沒有關閉已判定為 false 的 fact node，Provider 又將 `verified` 以外的 fact 狀態一律讀成 `unverified`。而預設召回本來就包含 `unverified`。

因此，排序改善與資料有效性是兩項需要分別驗證的行為。系統已經能找到新的正確決定，也仍可能把被推翻的舊敘述一起交給 Agent。

截至本文核對的基線，這個問題已記入 context assembly brief，修正仍待後續工作完成。評估集也保留了當時的標籤；處理失效紀錄後，相關題目的預期答案需要重新 review，不能為了維持漂亮的分數，讓已失效的紀錄繼續算成成功。

另外五題仍未在前三筆命中，其中包括「Bundle 訊息能否直接加欄位」與「Session 如何取得工具和 Skills」。即使這兩題正好是前幾天實作過的功能，召回也沒有因此自動可靠。

下一步的初始上下文組裝，還要回答工作範圍的問題。9 月 25 日的探測發現，兩個不同專案目錄的 sessions 都取得 BearPunch 的 knowledge alias 與 Skill；目前配發依 Agent 過濾，尚未依 workspace 隔開。

讓每件工作先取得屬於自己 workspace 的紀錄、在預算內組成初始上下文，是接下來的工作。長期記憶已能查詢，這份初始上下文還沒有完成。

## 回到 Unity：讓下一件工作找回適用的理由

如果把這條路帶回 Unity，下一位 Agent 接到修改 Component 的工作時，可能需要找回三種紀錄：

| 工作中的問題 | 希望找回的資料 |
|---|---|
| 為什麼這個狀態由特定系統持有？ | 已接受的架構決定與理由 |
| 上次這類測試為什麼看似通過，實際卻漏測？ | Review finding 與對應驗證 |
| 這個限制現在還存在嗎？ | 有驗證時間、適用版本與取代關係的事實 |

這仍是應用構想，本次沒有交付 Jupiter 的 Unity consumer，也沒有用 Unity 專案驗證這份召回數字。

但今天的工作已提供一個可用的起點：先用實際會問的問題建立評估集，確認預期紀錄排在哪裡，再檢查沒有答案時能否保持空白，以及失效資料是否確實退出預設結果。

下一次 Agent 問「這裡為什麼這樣設計」，希望交到它手上的，是能追溯來源、仍然適用的理由。這也是接下來組裝工作上下文時，必須繼續驗收的內容。

本文核對基線為本機乾淨的 `Jupiter main@313e499`；memory contract 由 `4d66f17` 合入，recall quality 由 `b021ef9` 合入。主要依據為 `docs/dispatch/20260925-recall-quality/` 的 report、review 與 `measurements/*.out.json`，以及 memory Provider／ranking source、memory gate、`recall-quality-receipt.json` 和 `20260925-context-assembly.md`。本文重新讀取既有證據，沒有重跑 Jupiter gates 或啟動 Agent sessions。
