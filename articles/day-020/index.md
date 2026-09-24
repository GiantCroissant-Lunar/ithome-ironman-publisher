---
title: Day 020：畫面也要有契約——Jupiter 如何串起 Surface、Data 與 Intent
timestamp: "2026-09-20T20:47:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Plugin Architecture
---

# 畫面也要有契約：Jupiter 如何串起 Surface、Data 與 Intent

Day 019 把 HTTP request 的決策拆開：Plugin 提出需求，Operator 決定目的地，Station 檢查權限並處理 credential。今天把同一個問題帶回畫面。

當使用者在 Sessions 面板按下「Approve」，Host 必須知道：這是哪個 Surface 的操作、參數是否符合契約，以及它最後會呼叫哪個 Service。V1a 要串起來的，就是從畫面到執行的這條路。

Day 016 到 Day 019 已經逐步處理 Host composition、Bundle identity、停止與清理，以及對外 HTTP。現在，這些能力開始需要一個讓人與 Agent 都能理解的操作介面。

今天選擇一顆批准按鈕，沿著它把 V1a 的 Surface、Data 與 Intent 走完。

## 從 Sessions 的一顆 Approve 按鈕開始

想像 Sessions 裡有一個 Agent 正在工作。它遇到需要批准的操作，狀態變成 `needs-approval`，畫面顯示 pending request，使用者按下 `Approve`。

這個互動至少包含三件需要對齊的事：

- 畫面上是哪一個 session；
- `Approve` 帶回哪些參數；
- Station 收到操作後，會執行哪個已宣告的函式。

Jupiter 的 Sessions surface 把 `approve` 宣告成一個 intent。它指定 session ID 的型別為 `string`，把 `allow` 固定為 `true`，目標則是：

```text
bearpunch:agents/control@0.1.0#respond
```

點擊後的路徑可以先畫成：

```text
Sessions 的 Approve
    → UserAction：intent 名稱與 context
    → Station：核對 surfaceId
    → Framework：查已驗證的 intent、解碼參數
    → Sessions：respond(session, allow)
    → 更新狀態與 transcript、發出 view-changed
    → 前端重新取得 surface 並呈現
```

這條路已出現在本次 V1a 的 parent acceptance receipt：透過實際 Tauri app bridge，確認 Sessions title 與 transcript，點擊 Approve，收到 `view-changed`，再看到 permission result 更新到畫面。

文章撰寫時我核對的是 repository 裡的 code 與這份驗收紀錄；本次沒有重新操作視窗。這個區分會一路保留到後面的測試數字。

## Surface、Data 與 Intent 各自負責什麼

同一個 Sessions 面板裡，有些內容會隨每一個 Agent turn 改變，有些則應跟著 Plugin revision 一起交付。

V1a 將它們分成三個部分：

| 部分 | 回答的問題 | Sessions 的例子 |
|---|---|---|
| Surface | 這個畫面有哪些資料欄位、型別與可用操作？ | session collection、status、pending、transcript、approve |
| Data | 現在有哪些內容？ | 某個 session 正在等待批准、目前累積的 transcript |
| Intent | 這個操作需要什麼參數，會呼叫什麼？ | `approve` 接收 session ID，呼叫 `respond` |

Surface 是 bundle 攜帶的 `*.surface.json`。這裡的 surface 是語意描述：section、field、type、intent，以及它們的關係。畫面元件的安排由後面的轉換與 renderer 承接。

下面節錄實際 `approve` 宣告，省略說明用的 `meaning`：

```json
{
  "approve": {
    "label": "Approve",
    "context": [
      { "name": "id", "type": "string" },
      { "name": "allow", "type": "bool", "value": true }
    ],
    "call": "bearpunch:agents/control@0.1.0#respond"
  }
}
```

`id` 對應 session item 的欄位，因此產生的按鈕會綁定該 item 的 ID。`allow` 是 surface 裡的 constant，Framework 執行 intent 時從已安裝的宣告取得它。

對這個 intent，前端提供的 context 可以理解為：

```json
{ "id": "s1" }
```

其中 `s1` 只是示意 session ID。呼叫所需的第二個參數 `true` 由 Framework 補入；前端若額外塞進未要求的 context key，也會被拒絕。

其他 intent 還可以要求使用者輸入參數。例如 `say` 的文字由輸入欄位提供。V1a 因而有三種參數來源：surface 固定值、目前 item 綁定值，以及使用者輸入值。

這些來源最後都必須符合宣告的型別。按鈕的 label 負責讓人理解操作，intent contract 則負責讓執行路徑知道參數與目標。

同時，Data 也有契約。Guest 的 `render` 回傳 JSON 資料後，Framework 會依 Surface 推導出的型別解碼；資料不符合時，回傳包含原因的錯誤。這讓錯誤在進入 renderer 前就有可以定位的位置。

## 從 MPS 到 A2UI：每一份產物都有對照

V1a 將 Surface 的撰寫放在 JetBrains MPS。這裡 MPS 承擔的是 authoring：讓語言模型中的結構產生 Jupiter 的 surface JSON，也就是中介表示 IR。

這條路徑有兩個時間點：

```text
撰寫與交付
    MPS model
        → version 2 surface JSON
        → declared bundle resource
        → admission 與 intent call 檢查

執行與呈現
    admitted surface + guest render data
        → Framework 驗證 data
        → Station 轉成 A2UI messages
        → 前端 processor 與 renderer
```

Surface 作為 declared resource，沿用 Day 017 的資產處理方式：它的 bytes 進入驗證與 bundle identity。調整 intent 的目標或參數，也會改變交付的內容。

安裝時還會核對 intent 的 `call`：對應 interface 與 function 必須由 owner export，參數的數量、順序及型別也必須吻合。若 function 不存在，view 會帶著原因呈現為 unavailable，讓問題在使用者操作之前就能被觀察。

MPS Phase M 留下的關鍵證據是九份 surface 的 byte comparison。Board 系列、HTTP probe、Intent probe、Welcome、Agent CLIs，以及 Sessions 的 main／usage，都能從 MPS 重新產生與 committed JSON 完全相同的 bytes；另外還有四個語言測試。

Byte gate 讓 reviewer 能回答一個具體問題：repository 交付的這份 surface，是否確實由目前的 authoring model 產生？它只涵蓋這九份受驗證的產物，語言的其他行為仍需要各自的測試。

到了 runtime，Station 的 `surface()` 固定產生三個 A2UI v0.9 messages：

```text
createSurface
updateComponents
updateDataModel
```

前端使用 `@a2ui/web_core` 的 processor、catalog 與 resolver 解析，再由目前的 `SurfaceView` 畫出元件。Plugin 提供的是受驗證的 surface 與 data；A2UI wire messages 由 Host 這條路徑產生。

目前更新的方式也很明確：前端收到相符的 `view-changed` 後，再呼叫 `surface()` 取得完整內容。這個增量完成的是 snapshot 與操作的契約；逐段 data update、斷線重同步和 AG-UI session events，留在 V1b。

## 把錯誤操作擋在 Guest 呼叫之前

畫面呈現正確，只走完了前半段。使用者送回來的 UserAction 還要通過另一段驗證。

Station 先解析 action，確認它的 `surfaceId` 與本次指定的 view 一致。Framework 再從目前 owner 已驗證的 surface 找到 intent，依宣告解析 context，最後走既有的 invocation 路徑。

各階段負責的問題可以分開看：

| 階段 | 檢查內容 |
|---|---|
| Surface admission | 結構有效、引用的 intent 存在、call 與 export 相符 |
| Render | Guest 回傳資料符合 Surface 的資料型別 |
| UserAction | `surfaceId` 相符、intent 存在、context 參數與型別有效 |
| Invocation | Owner 正在服務，呼叫遵循 Framework 的執行與權限路徑 |
| Plugin domain | 當下 session 狀態是否允許這個操作 |

Station 的 `intent-probe` 測試專門送入三種錯誤：

1. action 指向另一個 surface；
2. `say` 缺少必要的 `text`；
3. `text` 傳入數字，宣告卻要求字串。

三次都回 `invalid`。測試再確認 event cursor 未前進，而且 guest 的呼叫計數仍是 `0`。這給了拒絕行為更完整的證據：可以同時看到錯誤回覆與未執行的結果。

錯誤訊息也要幫得上忙。例如型別錯誤會指出 intent、context 參數 `text`，以及期待的 `string`。前端對 Host 層的 action rejection 會保留 surface，並在旁邊顯示原因，使用者才知道要修正哪裡。

Intent 執行時直接讀取安裝時已驗證的 surface，省去一次額外的 guest render。固定參數的操作可以獨立於資料讀取執行，也避免暫時的 render failure 阻斷原本有效的操作。

回到 Approve，最後仍有 Sessions 自己的 domain check。`respond(session, allow)` 會載入 session、確認它可操作，並查詢目前 pending request；沒有待回覆的 request 時，回 `no-pending-request`。

這裡也有一個需要說清楚的界線：目前 `respond` 回覆的是該 session **當下**的 pending request，action 沒有攜帶特定 request ID 或 revision。若未來要保證「我批准的就是剛才畫面上那一筆」，還需要將 request identity 與過期檢查加入契約。型別正確和狀態仍然新鮮，是兩個要分別驗證的條件。

## Review 如何補齊契約

V1a 的 review 很有價值，因為它把「各層都有 validator」往前推到「各層對同一份資料的理解一致」。

第一個例子是 JSON 的 `null`。

Surface 的 context parameter 可以帶固定的 `value`。對 option 型別而言，下面兩種寫法代表不同來源：

```json
{ "name": "target", "type": { "option": "string" }, "value": null }
```

```json
{ "name": "target", "type": { "option": "string" } }
```

第一個明確宣告固定值為 none；第二個沒有固定值，參數要由其他來源提供。

原本 Rust 以一般 `Option<Json>` 反序列化時，會把明確的 `null` 和缺少 `value` 都讀成 `None`。JavaScript validator 則依 key 是否存在判斷，因此兩端對同一份 surface 有不同理解。

修正後，Rust 保留「有 value，內容是 JSON null」與「沒有 value」的差異，並加入 shared corpus 與 round-trip／lowering 測試。同一波也修正 payloadless variant／result 的接受條件，讓 JavaScript 對齊 Rust decoder。至於 JavaScript number 與 Rust 64-bit integer 的精度差異，receipt 仍保留為限制。

第二個例子是測試的輸入範圍。

`surfaces:test` 會讀取其他 project 的 shared corpus 與 Rust 產生的 A2UI golden。若這些檔案沒有進入 moon task 的 inputs，它們改變後，測試仍可能沿用舊的 cached result。

修正將外部 corpus、交付的 surfaces 與 golden 都列為 inputs，並要求 golden 必須存在。驗證時刻意只修改外部 golden，在沒有 `--force` 的情況下重跑，測試確實重新執行並失敗；還原後通過。

這與 Day 017 的 bundle identity 有相同要求：**結果依賴哪些 bytes，驗證就必須把那些 bytes 算進去。**

本次撰寫核對到的 Jupiter 基線是本機 `main@32b5a1c`。Tracked tree 沒有修改，另有一份 untracked discussion；repository 仍沒有 remote。V1a 的驗收 code 記錄在 `1758fb5`，由 `e0df743` 補上 acceptance 文件，再由 `32b5a1c` 整合。

Committed `docs/architecture/v1a-parent-review-receipt.json` 記錄的證據包括：

| 證據 | Receipt 記錄的結果 |
|---|---|
| Rust tests | 586 passed、0 failed、1 ignored subprocess helper |
| JavaScript tests | 132 passed、0 failed |
| MPS | 九份 surface byte-identical、四個語言測試通過 |
| Live gates | A2、M1、H1a、V1a、D3 通過 |
| Mutation controls | 移除 wrong-surface 或 missing-intent 檢查，對應測試／gate 失敗 |
| Real window | Sessions Approve、事件與結果重新呈現 |

這些是既有驗收紀錄，本次文章工作沒有重跑 Jupiter tests 或 gates。Receipt 也明確說明，獨立 review 的早期 findings 已由 parent 驗證與處理，最後一輪 Kilo／GLM review 沒有產出完成結果；最終接受由 parent 承擔。

範圍也停在這裡：V1a 與 MPS 已整合；B2.1 的 bundle v2 content APIs 已存在但尚未啟用，兩種 Host 仍走 v1 bundle path。現有 renderer 的欄位間距、長操作列，以及後續增量更新，都由新的 V1b brief 承接。

## 回到 Unity：讓 Agent 與人理解同一份操作契約

把這個設計帶回 Unity，可以先從一個編譯診斷面板想起。

以下是應用構想，Jupiter 的 V1a 尚未實作這個 Unity consumer：

| 部分 | Unity 編譯診斷面板的可能內容 |
|---|---|
| Surface | diagnostics collection、file／line／severity／message 欄位 |
| Data | 這次編譯得到的錯誤與警告 |
| Intent | 開啟檔案、重新編譯、提出 Build request |
| Host | 驗證參數、檢查目前可用能力、執行操作並發布更新 |

人從面板看到一筆錯誤，按下「開啟檔案」；Agent 從同一份契約知道這個操作需要 path 與 line。兩者都能對照相同的參數定義與拒絕原因。至於 Agent 是經 MCP、CLI 還是其他 adapter 進入，仍要由 Unity Host 實際接通並驗證。

這也讓角色分工更清楚。Surface 描述能顯示與提出哪些操作；Host 決定如何把操作帶進執行環境；編譯與 Build service 檢查自己的 domain 狀態。編譯尚未完成、project 已切換，或目標平台不可用，都應從真正掌握狀態的那一層回答。

對需要人工批准的 Build，更應把前面發現的 freshness 問題帶進設計：批准應綁定哪一次 request、哪份 source revision，以及哪個 build target，都需要明確的 identity。使用者看到的內容與最後執行的工作，才有可以核對的依據。

Day 020 走到這裡，Sessions 的一顆按鈕已經能一路追到宣告、資料、參數解碼、Plugin 呼叫與畫面更新。接下來 V1b 要處理的，是資料持續流動時如何維持這份契約：輸入到一半遇到更新怎麼辦、事件遺失後如何重新同步，以及畫面如何呈現取消與完成。
