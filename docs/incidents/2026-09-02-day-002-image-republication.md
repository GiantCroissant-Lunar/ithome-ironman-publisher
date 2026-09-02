# 2026-09-02 Day 002 圖片遺失與同日重發事故紀錄

## 摘要

- 日期：2026-09-02（Asia/Taipei）
- 影響範圍：Day 002 已公開文章缺少預定的 hero 與 inline 圖片，後續需要刪除原文並在同日帶圖重發。
- 原文章：ID `10406802`，`https://ithelp.ithome.com.tw/articles/10406802`（已刪除，現在為 404）
- 替代文章：ID `10407080`，`https://ithelp.ithome.com.tw/articles/10407080`（已驗證公開）
- 最終結果：替代文章標題、系列、日期、正文與兩張圖片均已驗證；原始發布收據保留，另以 `articles/day-002/republication.json` 記錄新舊文章關係。

這次事故不是單一 selector 壞掉，而是三個問題疊加：發佈前沒有把「圖片已完成」列為硬門檻；操作過程曾選錯 Edge 工作階段；iThome 已公開文章的更新路徑雖回傳成功，卻會移除後加的圖片標記。修復的核心是把圖片完稿、草稿讀回與公開頁圖片驗證前移到發布之前。

## 使用者可見影響

Day 001 在首次發布時已包含圖片；Day 002 則先公開純文字版本，約 38 分鐘後才完成圖片。這造成 Day 002 與系列既有呈現不一致。嘗試直接更新已公開文章時，文字可以保存，但新增圖片在儲存後消失，因此不能用一般編輯完成修復。

## 時間線

時間均為台北時間；UTC 原始時間保留在 publication／republication receipt 與 diagnostics 中。

| 時間 | 事件 | 結果 |
|---|---|---|
| 19:50 | Day 002 原始文章發布 | 文章 `10406802` 公開，但當時來源尚未包含後來要求的兩張圖片。 |
| 20:28–20:29 | 完成 Leonardo hero 與 inline 圖片 | 圖片已下載、promote、建立 manifest，並加入本機文章。 |
| 21:13–21:24 | 多次測試已公開文章更新 | POST + `_method=PUT` 回傳 302；文字保存，但圖片語法在 editor readback 與公開頁都消失。 |
| 21:13–21:24 | 驗證多種圖片寫法 | 兩張 JPG、兩張 PNG、單張 PNG、長短 alt、`![URL](URL)`、raw `<img>` 全部被移除。 |
| 約 21:24 | 完成網路證據複查 | hosted image 最終回應為 200；先前從局部 trace 推測「圖片短暫 404」屬錯誤假設。 |
| 約 21:34 | 經明確授權刪除原文 | 只刪除 `10406802` 一次；舊 URL 成為 404，系列當日不再出現同標題。 |
| 約 21:35 | 發現刪文 tombstone 影響草稿列表 | 個人文章列表保留 `title-badge--delete` 卡片；修正辨識邏輯，避免把「有卡片但零草稿」當成未知頁面。 |
| 21:39 | 建立並發布替代文章 | 建立 draft `10407080/draft`，沿用已驗證 hosted assets，`uploadedImages: 0`，發布一次。 |
| 21:40 | 公開頁驗證完成 | 新 URL 回應 200；標題、系列、正文與兩個精確圖片 URL 均存在。 |
| 完成後 | 恢復安全鎖與保存紀錄 | `PUBLISH_DRY_RUN=true`；新增 `republication.json`；tests、lint、typecheck、build 全部通過。 |

## 已證實的根因

### 1. 發布前缺少「視覺內容已完稿」硬門檻

原流程會驗證當下文章內已有的圖片，但沒有要求先確認「這篇文章是否還需要生成圖片」。因此技術上的發布 preflight 可以通過，編輯上的文章卻尚未完稿。圖片在首次發布後才生成，是本次重工的起點。

防再發決策：需要圖片的文章，必須依序完成 image plan、生成／選圖、promotion、Markdown placement、manifest／SHA 驗證、草稿讀回，才可進入 live publish。不得把「先發純文字、稍後補圖」當作正常流程。

### 2. 已公開文章的更新路徑不保留後加圖片

實測顯示，已公開文章的更新請求可以保存文字，也會回傳 302，但新增的圖片 Markdown 或 HTML 在重新讀取 editor 時已不存在，公開頁同樣沒有圖片。遠端圖片本身可正常取得，且不同張數、格式、alt text 與語法都得到相同結果。

可以確定的是「目前這條已公開文章更新路徑無法保留新增圖片」；不能僅憑現有證據斷言 iThome 內部是哪個 sanitizer 或規則造成。後續遇到相同證據時應停止格式排列組合，不再以重複儲存碰運氣。

### 3. 瀏覽器工作階段選擇錯誤

操作時曾開啟非專案預期的 Edge window，干擾使用者既有瀏覽器工作。正確做法是只使用 repository 由 `task auth`／Playwright 維護的 headed Edge storage state：`infra/.auth/storage-state.json`。不得使用或操作個人日常 Edge profile；看到 headless Edge 403 也不代表登入失效。

## 曾走錯的路與停止規則

| 嘗試或判斷 | 為何不成立 | 下次的停止規則 |
|---|---|---|
| 先發布，之後再補圖片 | 公開後新增圖片無法由目前更新路徑保存。 | 所有必要圖片必須在 live publish 前完成並在草稿讀回中出現。 |
| 使用錯的 Edge window | 專案已有隔離的已登入 Playwright session，不應碰個人瀏覽器。 | 只啟動 repo task 管理的 headed session；發現視窗不符立即停止。 |
| 使用 runtime 的 `/articles/10406802/draft` | 已公開文章的舊 draft URL 會轉到無關的 `/api/itplus/bottom`。 | 從公開文章頁發現實際 `/articles/ID/edit` 連結，不猜 URL。 |
| 看到 save 302 就視為成功 | 302 只表示請求被接受，不代表正文完整保存。 | 必須比較 submitted Markdown、editor readback 與公開頁。 |
| 反覆換圖片格式／語法 | JPG、PNG、單雙圖、alt、Markdown、HTML 都被移除，問題類別已相同。 | hosted URL 為 200 且所有語法均在 readback 消失時，停止重試格式。 |
| 從局部 trace 推測遠端圖為 404 | 完整 redirect chain 顯示 302 後由 CloudFront 回 200。 | 必須看完整 network chain 與最終狀態，不依單一片段下結論。 |
| 刪文後把 tombstone 當草稿 | 個人文章頁會保留帶 `title-badge--delete` 的已刪除卡片。 | tombstone 不是公開文章也不是草稿；草稿列表可合法為空。 |
| receipt conflict 後再發布一次 | exit code 10 可能代表文章已成功公開，只是不可變 receipt 衝突。 | 先查公開頁；成功就建立 lineage／sync receipt，絕不再次 publish。 |

## 實際恢復流程

1. 保存原文章 ID、URL、title、hash 與公開狀態，不修改不可變的 `publication.json`。
2. 從公開文章的真實 edit link 確認更新路徑，完成 media stripping 證據收集。
3. 經使用者明確授權，確認刪除 form 精確指向 `10406802`，只提交一次刪除。
4. 同時驗證舊 URL 為 404，以及註冊系列當日沒有同標題文章。
5. 只清除 ignored runtime state 中指向已刪文章／草稿的欄位；保留已驗證圖片 SHA 與 hosted URL。
6. 修正文章列表在「只有公開／刪除卡片、沒有草稿」時的辨識，fixture E2E 覆蓋此狀況。
7. `task publish:dry` 必須得到精確 Day／title 與 `would-create`，才執行一次 live publish。
8. 新 draft 沿用兩張已驗證 hosted images，不重新上傳；發布後直接驗證新公開頁與兩張圖片。
9. 保留原 `publication.json`，另建 `republication.json` 記錄 `10406802 → 10407080`。
10. 將 `PUBLISH_DRY_RUN` 恢復為 `true`，確認 Git clean／synced 與完整 quality gate。

## 明日發文前的強制檢查清單

以下任一項未通過就不得 live publish：

- [ ] 在寫作階段先決定是否需要 hero／inline 圖；需要就先完成 visual plan。
- [ ] 所有必要圖片已生成、人工選定、promote 到 `articles/day-NNN/images/generated/`。
- [ ] `index.md` 已在正確位置引用圖片，alt text 完整；manifest 的 path、SHA-256 與 provenance 相符。
- [ ] `task images:check DAY=N` 通過。
- [ ] `task content:check` 通過。
- [ ] `task draft:preview DAY=N` 回報正確的 Day、title、series 與預期 action。
- [ ] `task draft:sync DAY=N` 完成；editor readback 包含完整正文與每一個 hosted image URL。
- [ ] 每個 hosted image URL 的最終回應成功，且不是登入頁、錯誤頁或中途 redirect 的誤判。
- [ ] `task publish:dry` 在 `PUBLISH_DRY_RUN=true` 下通過，沒有 identity mismatch、stale URL 或不明 draft。
- [ ] Git branch clean、已同步 upstream，preflight fetch／push dry-run 成功。
- [ ] 只執行一次 live publish。
- [ ] 公開頁驗證 exact title、account、series、台北日期、正文，以及預期圖片數量與精確 URL。
- [ ] publication receipt 已 commit／push；若為 exit 10，先驗證公開狀態，不得重發。
- [ ] 有人監看的 run 結束後將 `PUBLISH_DRY_RUN=true`。

## 快速判斷表

| 訊號 | 安全的下一步 |
|---|---|
| Headless Edge 回 403 | 改用 repo 維護的 headed Playwright session；不要開個人 Edge。 |
| 已公開文章的 `/draft` 轉到無關 URL | 從 public article 發現 `/edit`，不要猜 route。 |
| Save 回 302 | 讀回 editor，再查 public body；尚不能宣告成功。 |
| Remote image 最終 200，但 readback 無任何圖片語法 | 停止格式重試；走 diagnostics，必要時評估經授權的同日重發。 |
| Exit code 8 | 網站狀態不明；先做 public idempotency check，禁止再按 publish。 |
| Exit code 10 | 文章可能已公開；驗證後修復 receipt／lineage，禁止再發布。 |
| 列表只有 `title-badge--delete` | 視為 tombstone，不算 draft，也不算目前公開文章。 |

## 已完成的防再發措施

- 發布程式可從公開頁發現已公開文章的 `/edit` route，並用語意控制保存後讀回驗證。
- 草稿列表可以辨識「非空列表但零草稿」與 deleted tombstone，fixture E2E 已覆蓋。
- 新增 `ithome-republish-recovery` skill，限制刪除／重發的授權、次數、驗證與 lineage。
- 更新 `ithome-article-illustrator`、`ithome-draft-sync`、`ithome-publish` 與 `ithome-publish-diagnostics`，加入圖片完稿、讀回、公開頁與正確 Edge session 硬門檻。
- 原始發布與替代發布的 ID、URL、hash、圖片 URL 與驗證結果保存在 `articles/day-002/publication.json` 和 `articles/day-002/republication.json`。
- 敏感的 auth state、trace、HTML 與 screenshot 保持在 ignored `infra/` 路徑，不進入 Git。

## 驗證證據

- 替代公開頁：`https://ithelp.ithome.com.tw/articles/10407080`
- Hero：`https://ithelp.ithome.com.tw/upload/images/20260902/201075193IXi2vXYnV.jpg`
- Inline：`https://ithelp.ithome.com.tw/upload/images/20260902/20107519PQKWzFX8zL.jpg`
- 發布 lineage：`articles/day-002/republication.json`
- 完整 code quality gate：49/49 tests、lint、typecheck、build 通過。

## 後續原則

這份紀錄提供「相同證據該如何判斷」與「發布前必須有哪些證據」，但不構成未來刪文授權。任何刪除或重發仍必須逐篇確認 exact Day、title、ID、URL，並取得當次明確授權。
