---
title: Day 019：Plugin 不拿 URL 與 Token——Jupiter 如何用 Named Origin 收斂 HTTP Authority
timestamp: "2026-09-19T10:17:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Plugin Architecture
---

# Plugin 不拿 URL 與 Token：Jupiter 如何用 Named Origin 收斂 HTTP Authority

Day 018 寫的是 lifecycle 的尾端：Stop 只是 intention，activation 進入 `Deactivating` 後，最後一個 in-flight call 結束時，還需要 bounded admin wait 與 weak watcher 把 teardown 真正做完。

今天往另一個方向看：plugin 活著時，如何安全地對外發出 HTTP request？

最直接的作法，是讓 Wasm guest 接收完整 URL 與 token，再由 guest 自己使用 networking library。但這等於把幾個原本不同的決策揉成一個字串：

```text
https://token@example.com/api/...
```

裡面同時藏著：

- plugin 是否有網路權限；
- 可以連到哪一個 service；
- credential 從哪裡來；
- method、path 與 headers 能否被控制；
- request 可以等待多久、接收多少 bytes；
- 事後留下哪些 audit evidence。

Jupiter 的 H1a 不把 `reqwest` 或任意 URL 直接暴露給 plugin，而是新增一個 Station host capability：plugin 只說 **origin alias**、method 與 relative path，operator policy 決定 alias 真正指向哪裡，Station process environment 才保存 credential value。

本次盤點的本機 `main@9765f6e` 是乾淨的。H1a 經 `1d9a487`、`97034fb`、`d24bb5f` 實作，`99702da` 完成 parent review，由 `c33b288` merge，之後 `a3eb9e9` 補上 development-loop receipt annotation。

Day 019 對應日期已有大量 V1a view-contract branch commits，但 main 目前只有 revised brief；實作尚無 receipt、parent review 與 merge，working tree 也仍有 Phase C 草稿。因此今天選擇已經進 main、具備 code、tracked gate 與 receipt 的 H1a，而不把 V1a 提前寫成 delivered。

Jupiter repository 沒有 remote/upstream；本次也沒有重跑 tests 或 gates。以下執行結果只引用 committed `h1a-receipt.json`，不冒充 fresh validation。

## HTTP 不是 Library Choice，而是 Authority Boundary

「選 reqwest、hyper 還是其他 client」只是 implementation detail。

真正的 architecture 問題是：誰有權決定 request 的每一部分？

如果 plugin 可以自己提供：

```text
URL
Authorization header
redirect policy
proxy behavior
cookie state
request timeout
response size
```

那麼 host 就只剩一個轉接 socket 的角色，無法對 network effect 做一致的 policy、resource bound 與 evidence。

H1a 把 outbound HTTP 留在 Station capability。Guest-facing WIT 是：

```wit
request(origin, method, path, headers, body)
stream(origin, method, path, headers, body)
cancel(handle)
```

其中沒有 raw socket，也沒有 credential parameter。

Plugin manifest 只能請求：

```text
http:request
```

是否 grant 由 operator policy 決定，而且 framework 在每一次 effect 時查 current authority，不是 activation 時拍一張永久快照。Running plugin 被 revoke 後，下一次 request 就會被拒絕。

這表示 capability 不是一個便利 API，而是一個 effect boundary：所有 network work 必須先通過同一個 authority path。

## 四個決策拆開：Permission、Origin、Secret、Bounds

H1a 把一個 HTTP call 拆成四層：

| 層 | 誰決定 | 保存什麼 |
|---|---|---|
| Permission | Manifest 請求、operator policy grant／deny | `http:request` |
| Origin | Operator policy | alias → `http://host[:port]` |
| Secret | Station process environment | bearer token value |
| Bounds／Evidence | Host policy 與 EventLog | deadline、byte bound、outcome metadata |

Operator 可以設定：

```text
origin local http://127.0.0.1:20128 SERVICE_TOKEN
```

Policy 寫入的是：

```json
{
  "origins": {
    "local": {
      "url": "http://127.0.0.1:20128",
      "bearer": "SERVICE_TOKEN"
    }
  }
}
```

`bearer` 是 environment variable 的**名稱**，不是 token value。

Plugin 只知道：

```text
origin = local
path   = /v1/items?limit=20
```

它不知道部署環境的 port、機器位置或 token configuration。相同 bundle 可以在開發機把 `local` 指向 loopback，在另一個 Station 指向不同 service，而不重打 package identity。

這也把 rotation 變成 host operation：更新 Station environment 中的 value，下次 request 重新讀取；不需修改 manifest、plugin state 或 persisted policy 中的 credential。

## Plugin 只拿 Alias，不拿 URL

`Origin` 的 persisted shape 很小：

```rust
pub struct Origin {
    pub url: String,
    pub bearer: Option<String>,
}
```

Station 在 operator 設定 origin 時先驗證 base URL：

```text
scheme: http:// only
host: required
port: optional, numeric
path/query/fragment: forbidden
```

所以 policy alias 只代表一個 origin，不偷帶 endpoint path。

Guest request 之後再提供 `/...` path。Host 以：

```text
origin.url + guest.path
```

組成 wire URL。

這個選擇有兩個效果。

第一，plugin 不會把 production hostname 或測試 port 寫死在 code 裡。

第二，operator grant 的粒度是 **origin**，不是整個 Internet；未設定的 alias 回 `denied`，不是讓 guest 自由 fallback 到任意 URL。

移除 alias 也走 policy operation：

```text
origin local
```

沒有 URL 的 command 會刪除 mapping，後續 request 立即失去目的地。

但要注意：這不是 path allowlist。拿到 `local` 的 plugin 仍可請求該 origin 下任何通過 path validation 的 endpoint。若某個 service 需要更細的 endpoint authority，應拆成不同 aliases 或增加新的 policy model，不能假設 alias 自動做到 route-level authorization。

## Request 離開 Station 前的五道 Gate

一個 request 真正交給 HTTP client 前，至少經過五層檢查。

### 1. Current permission

Capability 對 `request`、`stream`、`cancel` 都宣告同一個 permission：

```text
http:request
```

Framework 的 guarded call 先查 current policy。沒有 grant 時，request 在進入 capability 前就被拒絕，audit entry 記錄 refused。

### 2. Configured origin

Alias 必須存在於 `Policy.origins`。不存在時回 `denied`，detail 只指出哪個 alias 未設定。

### 3. Method allowlist

目前只允許：

```text
GET POST PUT PATCH DELETE HEAD
```

其他 method 是 `invalid`，不交給 reqwest 自由解析。

### 4. Relative path shape

Path 必須以 `/` 開頭，且 endpoint path 部分不得包含 `..` segment。Parent review 加入 test，確認 `/hello/../echo` 在任何 exchange 發生前被拒絕，甚至不產生 `http` event。

### 5. Reserved headers

Plugin 不能設定：

```text
Authorization
Host
Content-Length
Transfer-Encoding
```

比較是 case-insensitive，因此 `authorization`、`AUTHORIZATION` 都不能繞過。

`Authorization` 由 host 根據 origin policy 注入；`Host` 與 framing headers 則交給 HTTP stack。這避免 guest 同時控制 authority 與 wire framing。

這些 gate 不是網路 error handling。它們是 request 尚未離開 Station 前的 admission。

## Secret 只在最後一刻成為 Header

Origin 若指定 bearer variable，`HttpCapability` 每次 request 都執行：

```rust
std::env::var(variable_name)
```

Unset 或空值回 `unavailable`，錯誤只命名 variable，不包含 value。

成功時，token 只在組 wire headers 的瞬間變成：

```text
Authorization: Bearer <value>
```

Plugin 不能自行提供 Authorization header；policy 只存 variable name；`http` EventLog 也不記 request headers、response body 或 credential。

更精確地說，host 不會把 token 當 configuration parameter 交給 plugin。但遠端 service 仍可能在 response body 中反射它，例如測試用 `/echo` endpoint。Host 無法保證不可信 remote 永遠不回傳自己收到的資料；這是 remote response trust 問題，不是 secret injection boundary 可以單獨解決的。

H1a 能防守的 claim 是：

```text
token value is not persisted in policy
not placed in audit or http events
not accepted from the plugin as a request header
read fresh from the Station environment per request
```

不是「plugin 在任何可能的 server response 下絕對看不到 token」。

Receipt 的 negative control 故意把 header value 改成 environment variable 的**名稱**，bearer test 立即失敗；這證明 source 真的有區分 name 與 value，而不只是文件這樣寫。

## 同步 Framework 不直接 Block On Tokio

Plugin framework 與 Station 本身維持 synchronous API，也被 architecture check 禁止直接依賴 Tokio。

但 reqwest 是 async。

H1a 新增 `bearpunch-http` crate，把 seam 拆成兩層：

```text
Core
    async reqwest exchange

HttpClient
    synchronous facade
    dedicated OS thread
    current-thread Tokio runtime
    job channel
```

Station call `HttpClient::request()` 時，不會在自己的 caller thread 做巢狀 `block_on`。它把 job 送到名為 `bearpunch-http` 的 thread，再透過 plain channel 等待結果。

Runtime thread 收到每個 job 後用 `tokio::spawn` 建 task，而不是在 receive loop 內逐筆 await。這讓一條慢 stream 在 await points 等資料時，後來的 unrelated request 仍可啟動。

這不是多核 parallel runtime：current-thread Tokio 仍在同一條 OS thread 上協作排程。Job channel 也是 unbounded，H1a 沒有建立全域 request queue 或 concurrency quota。文章能說的是「隔離 sync/async seam 與避免一條 await 中的 stream 阻塞 job intake」，不能擴張成完整 load-shedding proof。

`HttpClient::Drop` 關閉 job sender 並 join thread。正常設計中 Station 持有一個 client 直到 host shutdown；若 client 被 drop，runtime 會中止仍在 flight 的 tasks，因此 request lifetime 依賴 host lifetime 這個 ownership 前提。

## Whole Request 與 Stream 不是同一種 Deadline

Whole request 的 deadline 包住整段 exchange：

```text
connect
send
receive headers
read bounded body
```

只要整段超過 `host_io_deadline_ms`，就回 structured `http/deadline-exceeded`。

Response body 使用 `payload_bytes` 作 bound。Reader 最多保留：

```text
bound + 1 byte
```

多出的一 byte 只用來證明超限，然後回 `http/body-too-large`；不把 partial body 交給 plugin。

Stream 的 contract 不同。

它會先回 handle，之後透過 guest export 的 `http-events` 依序送：

```text
on-status
on-body per line
on-end
```

Deadline 對 connect 與每次 read 個別重設，是 **idle deadline**，不是 whole-stream deadline。只要 server 持續在期限內送出 bytes，一條 stream 可以活得比 `host_io_deadline_ms` 久很多。

這也不是 aggregate-size bound。Receipt 特別記錄：stream 的 pending-line buffer 在每個 chunk append 後才檢查，而不是像 whole body path 一樣精確裁到 `bound + 1`；單一 oversized chunk 可能短暫進入記憶體後才被判定 TooLarge。因此不能把 request path 的 exact memory guarantee 直接套到 streaming path。

H1a 的 stream 適合 line-oriented loopback service first form，不等於任意 binary streaming substrate。

## Stream Handle 也必須有 Owner

`stream()` 回傳的不是裸 network task，而是一個 activation-owned handle。

Capability 保存：

```text
handle
activation
scope
cancel switch
status/bytes/start time
origin/method/path
```

只有建立該 stream 的 activation 可以 `cancel(handle)`。另一個 activation 猜到 handle 時，capability 會把 owner record 放回 map，回 `denied`，不碰原 stream。

更重要的是 lifecycle integration：

```rust
release(activation)
```

會找出該 activation 擁有的所有 streams，逐一：

- 設定 cancelled；
- 通知 HTTP core 停止；
- 記錄 outcome `cancelled`；
- 阻止後續 callbacks。

這正好接回 Day 018。F1 保證 activation 的最後一個 call 結束後，teardown 會走到每個 capability 的 `release(activation)`；H1a 則保證 release 會終止該 activation 的 streams。

兩篇文章拼起來才得到完整 claim：

```text
Stop withdraws new work
    -> drain existing calls
    -> teardown activation
    -> HttpCapability releases owned streams
```

如果只做 `cancel` API，plugin crash 或被 unload 時沒有人主動呼叫，就會留下 orphan stream。Ownership 必須由 host lifecycle 收尾。

## Stream Delivery 不能堵住共用 Network Runtime

`Core::stream` 的 callback 在 shared HTTP runtime thread 上發生。

但 guest 可能正在忙；Jupiter 的 `deliver` 最多會 retry 30 秒。若直接在 HTTP runtime thread 呼叫 guest callback，一個 busy plugin 就能堵住所有其他 HTTP jobs。

所以 `HttpCapability` 再加一層：每個 stream 建立自己的 delivery thread。

```text
reqwest task
    -> plain channel
        -> saturn-http-deliver-<handle> thread
            -> guest on-status/on-body/on-end
```

HTTP runtime 的 sink 只負責把 `StreamItem` 放進 channel。真正可能等待 guest 的 `deliver` 在專屬 thread 上執行。

這是 head-of-line blocking 的隔離，不是免費的 scalability：每個 active stream 都多一條 OS thread，channel 也沒有在這個 increment 建立全域 capacity control。當使用量真的需要大量 concurrent streams，必須重新量測 thread 與 queue bounds，不能只因為測試有兩條 stream 就宣稱 scale 已解決。

## Observation：記 Outcome，不記 Payload

每個完成的 request 或結束的 stream 都會留下 `http` event。

內容包含：

```text
origin alias
method
path
status or null
body/line bytes observed
elapsed ms
activation
stream handle when applicable
outcome
```

Outcome 是：

```text
ok | deadline | too-large | refused | reset | cancelled
```

Event 不包含：

- request headers；
- response headers；
- request body；
- response body；
- credential value。

這讓 usage／diagnostics 可以回答「哪個 activation 對哪個 named origin 做了什麼、耗時與結果如何」，又不把 payload 或 secret 複製進長期 event log。

Permission audit 是另一層：guarded capability call 會記 grant／deny。HTTP event 則記已進入 capability後的 transport outcome。兩者不應混成一個 boolean success。

被 path、method、header shape 在 exchange 前拒絕的 request，是否產生 transport event也有差異；parent test 對 `..` path明確要求沒有 `http` event，因為網路根本沒開始。

## Parent Review 修的是 Process Tree，不是 HTTP Semantic

H1a worker 的 direct Cargo tests 通過，但 `moon run station:test` 在 Windows 會卡住。

原因不是 HTTP client，而是 test responder 的 process ownership：

```text
Rust test
    -> proto.exe shim
        -> real node.exe responder
```

原本 `child.kill()` 只殺掉 proto shim，真正的 Node grandchild 仍在 listen。Moon 又等待自己的 descendant process tree，於是整個 task不退出。

Parent review 把 responder 改為：

- 經 `bearpunch_os::spawn_tree` 啟動；
- 用 owned Windows process tree 收斂 shim 與 grandchild；
- port 透過 temporary file 原子寫入，不依賴 shim forwarding stdout；
- 所有 failure path 與 `Drop` 都 kill tree、wait、刪 port file。

修正後，同一個 `moon run station:test` 在 receipt 中完成，且沒有殘留 responder processes。

這個故事很值得保留，因為「測試 timeout」有時不是產品 timeout。若只把 test deadline 調大，會掩蓋真正的 process ownership leak。

Parent review 同時補了三個 probes：

- `..` path 必須在 exchange 前拒絕；
- reserved header 不分大小寫都拒絕；
- 1ms deadline 即使面對 fast endpoint 也必須在 bound 內拒絕並記 outcome。

因此 main 上 HTTP suite 是原 12 個加 3 個，共 15 個 Station tests。

## Receipt 證明了什麼，也沒有證明什麼

Committed receipt 記錄 worker／parent 在對應 source 上執行過：

- `bearpunch-http` 6 tests；
- Station HTTP worker suite 12 tests；
- parent 再增加 3 tests；
- commit C 的 cold workspace：503 passed、0 failed、1 ignored；
- H1a real gate：fetch hello、五行 stream、slow deadline；
- A2 regression gate；
- bearer name/value 與 stream release negative controls；
- parent 再植入 case-insensitive reserved-header control。

Tracked H1a gate 不是只檢查「process exit 0」。它透過 M1 MCP host：

1. 安裝真實 `http-probe`；
2. `act fetch-hello` 後等 view render 出 `{"hello":"world"}`；
3. `act begin-lines` 後等 line-0 到 line-4 出現在 document；
4. `act fetch-slow` 驗證 guest-level error detail 命中 host I/O deadline；
5. 每個步驟後確認 probe 仍為 active。

但 structured diagnostic code不會完整穿過 guest ABI。Gate 能看到的是 guest `err` 的 kind/detail，不是 host 內部 `Diagnostic` 的 code、subject、evidence、fixes。Receipt 主動記錄這個 boundary，而不是硬說 MCP client 看得到 `http/deadline-exceeded` code。

本次寫 Day 019 時沒有重跑任何測試、gate、Station 或 app。能直接驗證的是 current main 的 code、receipt 與 Git ancestry；不能把歷史數字改寫成今天機器剛跑出的結果。

## Named Origin 仍不是 Network Sandbox

H1a 是 deliberately small first form。

它做到：

- current permission check；
- operator-configured origin alias；
- host-injected bearer；
- method/path/header admission；
- deadline 與 response bound；
- request／stream ownership與 evidence。

它沒有做到：

- TLS：目前只接受 `http://`；
- DNS pinning 或 IP range policy；
- 完整 SSRF sandbox；
- endpoint-level allowlist；
- binary request／response body；
- redirect handling；
- proxy support；
- cookie jar；
- global request concurrency／queue quota；
- H1b outward MCP capability。

`Core` 明確設定 no proxy、no redirect，也沒有 cookie store；response `Set-Cookie` 被過濾。這減少 ambient behavior，但不等於網路隔離。

Named origin 仍會由 OS／resolver 解析 hostname；DNS 在之後指向哪個位址，H1a 沒有 pin。Alias 也允許該 origin 下所有通過 shape check 的 paths。因此「只能連 operator 明確命名的 origin」是正確 claim，「plugin 已被完整 sandbox，無法碰內網」則不是。

Response body 以 UTF-8 lossy decode 成 string，request body也是 text；拿它傳任意 binary 會改變資料。TLS、bytes API 與更強的 network policy都應由真實 consumer 觸發自己的增量。

## 回到 Unity：讓 Extension 拿 Service Alias，而不是 API Key

Unity Editor extension 很容易直接寫：

```csharp
UnityWebRequest.Get("https://service.example/api/...")
request.SetRequestHeader("Authorization", "Bearer " + token);
```

短期方便，長期卻把 deployment、secret、network policy與plugin code綁死。

如果未來的 Unity ADE 需要 plugin 查詢 build metadata、asset registry 或 inference gateway，可以沿用 H1a 的形狀：

```text
manifest
    requests network:request

operator policy
    build-api -> base origin
    bearer -> environment variable name

plugin
    request("build-api", "GET", "/builds/latest", ...)

host capability
    checks current grant
    injects credential
    enforces deadline/byte bound
    records metadata-only event
```

這讓同一個 extension 在 developer machine、CI runner 與 isolated build agent 使用不同 endpoints與credentials，package bytes完全不變。

Streaming 也必須跟 extension lifecycle綁定。Progress feed、log tail或agent output若在 extension unload 後繼續呼叫 callback，會留下 static event、task與socket leak。Handle要歸屬 activation，teardown要自動 cancel，而不是期待 extension的 `OnDisable()` 永遠有機會主動清理。

同時要保持 claim boundary：service alias不是 firewall。Unity host若需要阻擋 loopback以外、private ranges、DNS changes或特定paths，必須在 capability policy中明確建模；不能把「URL不在plugin裡」誤當成所有network threats都消失。

Day 019 的 H1a 沒有讓 Jupiter 變成通用網路平台。

它做的是更基礎的 authority separation：plugin只提出「我要對 local 做GET /hello」，operator決定 local在哪裡，Station決定是否允許、何時讀secret、等待多久、接收多少、如何觀察，lifecycle則保證activation結束時stream一起結束。

**好的 HTTP capability 不是替 plugin 發 request；而是讓 URL、secret、permission、bounds 與 evidence 各自回到真正擁有決策權的那一層。**
