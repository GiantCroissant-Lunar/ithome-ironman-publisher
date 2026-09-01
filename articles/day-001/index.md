---
title: Day 001：先讓 Agent 自己發文——ADE 的第一個自動化應用
timestamp: "2026-09-01T10:17:00+08:00"
tags:
  - AI Agent
  - Playwright
  - TypeScript
---

# 先讓 Agent 自己發文

這 30 天真正要打造的不是一套發文工具，而是 **Agent Development Editor/Environment（ADE）**：一個讓 Agent 能理解工作區、編輯內容與程式、呼叫工具、取得執行回饋，並在人的治理下持續完成工作的開發環境。

自動發文只會佔系列的一小部分。不過，它很適合當作 Day 001 的第一個應用，因為這個任務同時包含內容理解、檔案操作、瀏覽器控制、狀態保存、失敗診斷與安全決策。換句話說，Agent 不只是產生一段文字，而是要把工作可靠地完成。

![Agent 將 Markdown 經過安全檢查後發布](./ref-image-001.png)

## 為什麼從發文開始？

鐵人賽要求每天持續發布。若每篇文章都先由人手動搬進網站草稿，排程最後只自動完成一次點擊，並沒有形成真正的 Agent workflow。

我希望本機檔案才是 source of truth：

```text
articles/
└─ day-001/
   ├─ index.md
   └─ ref-image-001.png
```

每篇文章是一個獨立目錄。`index.md` 保存文章與 frontmatter，引用的圖片和它放在一起。Agent 可以直接在 repository 裡編輯、檢查與版本控制，不需要把網站草稿當成唯一資料來源。

```yaml
---
title: Day 001：先讓 Agent 自己發文——ADE 的第一個自動化應用
timestamp: "2026-09-01T10:17:00+08:00"
tags:
  - AI Agent
  - Playwright
  - TypeScript
---
```

## 一個可驗證的完整迴圈

這個應用以 TypeScript 和 Playwright 實作，但重點並不是「模擬按鍵」，而是建立完整的 observe–act–verify 迴圈：

1. 以 `Asia/Taipei` 計算今天應該發布 Day N。
2. 解析 frontmatter，檢查 timestamp、Markdown 與本機圖片。
3. 先讀公開頁，確認今天是否已經有同一篇文章。
4. 精準尋找 Day N 草稿；不存在就建立，存在則同步最新內容。
5. 上傳有變更的圖片，將本機路徑替換成網站託管 URL。
6. 儲存後讀回標題與 Markdown，內容一致才允許進入發布階段。
7. 發布後重新讀公開頁，確認日期與標題都正確。

每天可以安排兩次執行。第一次成功後，第二次會在公開頁檢查階段就停止，因此重試不會多發下一篇。若頁面身分、日期或草稿選擇缺乏足夠證據，流程也會安全失敗並留下 trace、截圖與 HTML。

## 文章和圖片變更怎麼追蹤？

本機內容會產生兩種 canonical SHA-256：

- `sourceHash`：標題、timestamp、排序後的標籤、Markdown，以及每張本機圖片的內容雜湊。
- `renderedHash`：圖片路徑換成網站 URL 後，實際送入 editor 的內容。

每張圖片也有自己的 SHA-256。圖片沒有改變時，可以沿用先前上傳後取得的 URL；若文章發布後本機內容又改動，目前只回報差異，不會讓背景排程偷偷改寫公開文章。

## 這和 ADE 有什麼關係？

這個小應用已經碰到 ADE 的幾個核心能力：

- **Context**：理解文章目錄、frontmatter、圖片與比賽日期。
- **Editing**：修改 Markdown、程式、設定與測試。
- **Tools**：操作檔案、Git、TypeScript toolchain 與瀏覽器。
- **State**：保存登入狀態、動態 URL、內容雜湊與圖片對應。
- **Feedback**：從 lint、測試、瀏覽器頁面及公開結果取得證據。
- **Governance**：dry-run、精準選擇、人工登入與正式發布開關。

這正是我對 ADE 的初步想像：Agent 不是躲在文字輸入框後面回答問題，而是在一個可觀察、可驗證、可治理的環境裡工作。

Day 001 先用自動發文建立第一個垂直切片。接下來會把視角拉回 ADE 本身，拆解它的工作區模型、Agent loop、工具介面，以及 Editor 與 Environment 應該如何協作。
