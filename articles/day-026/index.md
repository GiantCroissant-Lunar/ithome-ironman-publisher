---
title: Day 026：找回記憶之後，如何交給 Agent——Jupiter 的上下文組裝
timestamp: "2026-09-26T20:47:00+08:00"
tags:
  - AI Agent
  - Context Engineering
  - Vibe Coding
---

# 找回記憶之後，如何交給 Agent：Jupiter 的上下文組裝

Day 025 把問題推到「長期記憶是否找得對」。但即使相關紀錄已經出現在召回結果裡，Agent 開工時也未必看得到。

Jupiter 在 9 月 25 日完成的 context assembly，正好遇到這件事。一次 live probe 找回了 20 筆紀錄，最後卻只把兩筆放進初始上下文。預算有 16,384 bytes，實際只用了 1,421 bytes；這件工作需要參考的 review findings，全部在組裝時被排除。

資料找到了，仍可能在交給 Agent 的途中消失。

今天沿著這次實作，看看 orchestrator 如何決定一件工作能取得哪些來源、如何在預算內組裝內容，以及如何留下可以核對的清單。

## 先確認這份上下文屬於哪個專案

Day 025 結尾提到，兩個不同專案目錄的 sessions，都取得了 BearPunch 的 `knowledge` alias 與 Skill。當時配發會檢查 Agent，卻還沒有依 workspace 分開。

這次在 Station policy 加入 `workspaces`，每個 entry 描述這個 workspace 在這台 Station 上能取得什麼：

| 設定 | 作用 |
|---|---|
| `roots` | 有設定時，限制工作目錄能落在哪些根目錄裡 |
| `servers` | 可配發的 MCP aliases |
| `skills` | 可提供 Skills 的 Bundle 清單 |
| `memory` | 可採用召回結果的 memory Providers |
| `budget_bytes` | 初始上下文文字的預算 |

Workspace 由操作端建立的 scope 承載，scope 的 label 對應 policy entry。Bundle 自己建立一個同名 scope，不能因此取得那個 workspace 的身分。

Server 必須同時列在 workspace 清單裡，而且原有的 `consumers.sessions` 也允許這個 Agent。Skills 則依來源 Bundle 過濾，還沒有逐 Agent 的 Skill 清單。呼叫若不在任何 scope 裡，就使用保留的 `unscoped` entry；沒有 entry 時，不配發這些來源。

Parent 的既有 live review 用兩個 workspace scopes 驗證：A 列出 `knowledge` 與 knowledge Skill，B 的清單為空。各自建立真正的 Claude Code session 後，A 取得兩者，B 沒有取得，transcript 也留下 withheld 的原因。這個 probe 沒有向 Agent 送出工作 prompt，驗證範圍是配發。

Session 結束時，Host 只移除自己曾放置、而且 bytes 仍未被修改的 Skill 檔案；同一目錄若還有其他 live session 使用，就先保留。後續 slice D 也拒絕兩個 workspace 的 roots 重疊，避免一邊結束工作時，移除另一邊仍在使用的檔案。

這些規則約束 Station 的配發與工作目錄檢查。CLI 自己的設定、原本就存在的專案檔案，以及工具連上服務後能查到哪些資料，仍有各自的控制範圍。列出一個 memory Provider，也不等於已完成它底下所有長期資料的專案分區。

## 等第一個工作訊息到達，再組裝記憶

建立 session 時，系統知道要使用哪個 Agent、在哪個目錄工作，已經可以配發 MCP 與 Skills。但它還不知道任務內容，無法判斷應找回哪些記憶。

因此 Jupiter 把流程拆在兩個時點：

```text
create
→ 依 workspace 配發 MCP servers 與 Skills

第一個工作 say
→ 以訊息文字作為 task
→ 讀取 workspace 的來源與預算
→ 召回長期紀錄，再召回短期 episodes
→ 產生 manifest 與初始上下文文字
→ Sessions 核對文字雜湊
→ 初始上下文接在使用者原文之前，送給 Agent
```

後續訊息直接送出，不會每一輪都重新組裝。若第一個訊息只是 `/usage`，則讓它單獨到達 CLI；下一個真正的工作訊息，才觸發組裝。

這也讓派工方式變得重要：第一個訊息需要帶上工作本身。若只送「請讀某個檔案」，組裝器當下能拿去查詢的，也只有這句話。

目前的 query 規則相當直接：將 task 的部分 Markdown 符號轉成空白、合併空白，再依單字順序取最多 1,000 bytes。它不會先開啟 prompt 提到的文件，也沒有先替整份長篇需求做摘要。

對有 workspace entry 的 session，assembler 缺席時會回覆 `context/unavailable`。Sessions 收到結果後，還會重新計算 `rendered` 的 SHA-256，與 `rendered_digest` 比對；不符就失敗，工作文字不送出。

這個檢查確認的是待送文字與 manifest 宣告的一致性。文字裡的紀錄是否正確、是否切合工作，仍要由來源與召回驗收支持。

## Manifest 記下選了什麼，也記下沒選的原因

Day 025 的 recall receipt 記錄一次查詢回傳哪些紀錄。今天多了一層 manifest，描述那些結果如何成為工作開始前的上下文。

| Manifest 內容 | 可以核對的問題 |
|---|---|
| Workspace、task digest、policy revision | 這是哪件工作、依哪份設定組裝？ |
| Assembler revision、budget | 使用哪版規則、多少預算？ |
| 每個 item 的來源、digest、bytes、是否納入與原因 | 哪些資料被採用，哪些被排除？ |
| Recall receipts | Provider 原本回傳了什麼？ |
| `rendered` 與其 digest | 實際準備送出的文字是什麼？ |
| `ambient` | 哪些上下文來源不在 Station 的掌握範圍？ |

預設的 16 KiB 限制，計算的是組裝器產生的 UTF-8 文字，不是模型 token 數，也不是整個 session 的 context window。

使用者 task 會記錄 bytes 與 digest，但原文接在組裝結果後方，不占這份預算。MCP 與 Skills 已在 `create` 配發，manifest 列出來源與判定，也不把它們的全部內容塞進這份文字。

目前先依分數放入長期紀錄，再處理 episodes；單筆紀錄文字最多取 2,048 bytes。放不下的 item 留在 manifest，標明 `over-budget`，因此能區分「沒找回來」和「找回來但放不下」。

Manifest ID 由輸入內容計算：workspace、task digest、預算、policy 與 assembler revision、候選內容 digest，以及 receipt 的查詢、Provider 與紀錄順序。單純的查詢時間、session ID 或 work ID 不參與位址計算。

Parent review 曾刻意把 session ID 混進位址，原本 12 個 context tests 卻全數通過，因為它們組裝時都傳入 `session: null`。補上的測試讓同一任務分別使用空 ID、兩個不同 session IDs 與 work ID，確認 manifest ID 相同；同一個破壞才被抓到。

這不表示同一句 prompt 永遠得到相同 ID。紀錄、policy 或 episode 的年齡等實際輸入變了，結果仍會改變。這裡要排除的是與內容無關的執行身分。

至於 `ambient`，目前明列 CLI 的使用者設定，以及它按慣例讀取的專案檔案，例如 `AGENTS.md`。所以這份 manifest 是 Station 組裝結果的紀錄，不能宣稱涵蓋 Agent 的全部上下文。

## 一條看似合理的篩選規則，刪掉了需要的經驗

初版 assembler 除了預算限制，還有一條相對門檻：低於本次最高分一半的紀錄，不放進初始上下文。

這條規則看起來可以去除較不相關的內容，卻有一個問題：當某筆 decision 幾乎重述任務本身，其他有用的紀錄就容易顯得分數偏低。

開頭的 live probe 正是如此。它用 slice D 的簡短主題查詢，decision 68 得到 1.35，decision 65 得到 0.78，兩筆被納入。相關 findings 的分數介於 0.39 到 0.55，都低於最高分的一半。

預算還很充足，系統卻把「之前哪裡出過問題」留在清單外。

Slice D 量測後，移除了 assembler 的相對門檻。現在依分數順序嘗試放入紀錄，放不下就記錄原因，再看下一筆；長期召回仍有 20 筆上限，也仍經過 Day 025 的 Provider relevance floor。

兩個門檻處理的是不同問題。Provider 的 floor 用來排除未達相關度要求的結果；assembler 原本那條規則，則拿同一批結果的最高分，決定其他紀錄是否有資格留下。

| 既有 dev Station live 紀錄 | 移除相對門檻前 | 安裝新版後 |
|---|---:|---:|
| 納入的長期紀錄 | 2 筆 | 20 筆，其中 8 筆是 findings |
| 短期 episode | 當次紀錄未列出 | 加入 s29 的 episode |
| 初始上下文大小 | 1,421／16,384 bytes | 11,118／16,384 bytes |

兩次 live 紀錄來自不同階段的 Station 狀態，後一次也多了 episode，不能把 bytes 差距全算成同一個變因的實驗。它們能說明的是：新版實際讓已召回的 findings 進入了初始上下文。

而「回傳什麼」與「留下什麼」之間，還有下一個容易混淆的地方。

## 驗收必須分清楚：沒召回，還是被刪掉

Parent 一開始要求 slice D 的完整派工 prompt，組裝後必須包含指定的四筆 findings。Worker 跑了三次 memory gate，這個 assertion 都失敗。

原因不是相對門檻還在。

前面的 live probe 用的是簡短主題，沿用了 findings 裡的用詞；完整 prompt 經過現有的 1,000-byte query 規則後，即使把召回上限提高到 50，也沒有找回那四筆。組裝器無法保留根本沒進入候選清單的紀錄。

Parent review 因而承認原本驗收混合了兩個問題，改成直接檢查這次修改的預算規則：候選依分數排列、不得再因 `below-cutoff` 被排除，而且每個 `over-budget` 的 bytes 與剩餘預算都必須算得對。

這組檢查套回舊門檻留下的 manifests，三份都失敗。新版的三個派工 prompt 則各納入全部 20 筆長期紀錄。

不過，這三份 prompt 都放得下全部候選，所以不能說它們驗證了超出預算的分支。小預算行為另有 Station test；gate 的預算算式也以合成 manifest 檢查。

至於「為什麼派工 prompt 找不到需要的 findings」，仍保留為 open finding。現有 kind 權重讓 decisions 與 ADRs 比 findings 更占優勢，query 又偏重 prompt 開頭；移除 assembler 的門檻，沒有一併完成這兩項召回改善。

## 長期決策之外，保存上一件工作的結果

另一種需要帶到下一件工作的資訊，是剛結束的 session 做了什麼。

這次兩個 memory Providers 都能在 Station 的 durable store 保存 episode。每個 session 維持一筆，以最新一輪結果更新，內容包括工作結果、標題、Agent、目錄、workspace，以及最後一則 Agent 訊息。

最後訊息最多保存 8 KiB，另留下完整訊息的 SHA-256。這份紀錄沒有重建整段對話，也不會進入長期知識 graph，更不會因此變成正式 decision。

Assembler 在長期紀錄之後召回最多十筆 episodes，放在 `Episodes` 段落，附上年齡。Episode 的相關度採字詞重疊，加上以整小時計算、一週減半的時間衰減；有到期設定且已過期的項目不回傳。

Station test 驗證，同一 workspace scope 裡的下一個 session 能收到前一個的 episode，另一個 workspace scope 收不到。

這裡還有明確限制：durable namespace 跟著 scope instance。關閉 scope，再以相同 workspace label 建立新的 scope，會取得新 namespace，舊 episodes 不會自動接回來。跨 session 延續已經有測試，跨 workspace scope 重建的延續仍未完成。

昨天留下的失效 fact 也在這輪處理了。Seeder 會關閉標為 `false, see F-nn` 的紀錄，保留 successor 關係與歷史查詢；F-18 不再進入預設召回。評估則追到 successor，並記錄替代關係，沒有直接改掉原本那份題目。

## 核對到哪裡，才把完成寫進文章

Slice D 最終 head `7fb27c6` 的 parent review，記錄以下驗證：

| 證據 | 結果與範圍 |
|---|---|
| Station、framework、conformance、ranking、episodes suites | 合計 612 tests 通過，包含 362 個 Station tests |
| Memory gate | 三次各 26 assertions 通過，`recall@3` 為 24／29，約 82.8% |
| 被改壞的渲染 fixture | 文字與 digest 不符時，session 失敗且沒有把工作送給 Agent |
| 負向驗證 | 放回相對門檻，預算規則檢查會失敗；把 session ID 算進位址，新增測試會失敗 |
| Dev Station live manifest | 新版納入 20 筆長期紀錄、其中 8 筆 findings，以及 s29 的 episode |

`knowledge:test` 在較早的 `cf83652` 通過；最後一次修正沒有碰 knowledge，因此 review 沒有宣稱在最終 head 重跑它。召回數字也仍是那份 29 題有答案的固定評估，沒有測 Agent 最終回答的正確率。

這輪完成的是可配發、可組裝、可核對的初始上下文。Provider 選擇仍有缺口：assembler 透過 router 選中的 Provider 查詢，再檢查結果是否來自 workspace 清單；若同時安裝多個 Providers，被選中的卻不在清單裡，就可能丟棄結果，而非自動改查清單中的另一個。

這些限制和 findings 的召回問題一起留下，才能讓下一輪工作有具體起點。

## 回到 Unity：讓 Agent 帶著適用的資料開工

假設下一件工作是修改 Unity Component，並補上 Edit Mode tests，我會希望開工前能核對這些內容：

| 工作需要 | 對應的準備 |
|---|---|
| 連到這個專案的 Editor | Workspace 允許的工具入口，加上連線後的 project identity 確認 |
| 遵循團隊的修改與測試方式 | 對應 Bundle revision 的 Skill |
| 理解既有設計 | 有來源、仍適用的決策與事實 |
| 知道上一輪停在哪裡 | 同一 scope 裡的 episode，再追查實際程式與驗證紀錄 |
| 發現該有的資料沒出現 | 比對 recall receipt、manifest 的候選與排除原因 |

這是 Unity 工作的應用構想，本次沒有交付或驗證 Jupiter 的 Unity consumer。

今天讓我更在意的是交付資料的中間過程。下一次 Agent 漏掉某段重要經驗時，可以先沿著紀錄追查：來源是否允許、是否被召回、是否被放入預算，以及實際送出了哪份文字。

如果 findings 已經被找回來，就不該在 Agent 開工前，悄悄消失在一條未經驗收的篩選規則裡。

本文核對基線為本機乾淨的 `Jupiter main@71653c6`。Context assembly 的 A、B/C、D 分別由 `fcdfd76`、`5edee2c`、`2b85d6c` 合入，live 紀錄由 `57b5e3f` 保存。主要依據為 `docs/dispatch/20260925-context-assembly/` 的 reports／reviews、`docs/architecture/context-assembly-receipt.json`，以及 workspace、assembler、Sessions 與相關 tests 的 source。本文讀取既有證據，沒有重跑 Jupiter gates 或啟動 Agent sessions。
