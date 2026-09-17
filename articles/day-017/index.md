---
title: Day 017：Bundle 不只是一個 Wasm——Jupiter 如何讓每個 Resource Byte 進入 Identity
timestamp: "2026-09-17T10:17:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Plugin Architecture
---

# Bundle 不只是一個 Wasm：Jupiter 如何讓每個 Resource Byte 進入 Identity

Day 016 寫的是 Jupiter 如何把兩種 Host 共用的 lifecycle composition 抽成 `PluginHost<R>`，同時保留 Station 與 LinkedHost 的產品差異。

今天沿著那條 generic install path 往下看，主角從「誰擁有 lifecycle」變成「lifecycle 到底在安裝什麼」。

過去最簡單的答案是：

```text
Station package = plugin.json + plugin.wasm
App module      = plugin.json + module.js
```

但真正的 plugin 很少永遠只有一個 executable file。

它可能還需要：

- JSON data；
- icon、stylesheet 或其他 assets；
- webview 自己 instantiate 的 Wasm；
- shader source；
- 之後才會出現、但必須與同一 revision 一起移動的 sidecar bytes。

如果這些檔案只被丟進一個 `assets/` 目錄，卻沒有進入 admission、identity 與 staging，那麼 host 說「這個 bundle 已驗證」時，實際只驗證了其中一部分。

所以 Day 017 選擇今天已合入 `main` 的 B1 bundle resources：

> Bundle 不是「一個 Wasm，再附帶一些不重要的檔案」；它是一個 manifest 管理的 byte closure，每個會跟 revision 一起交付的 resource，都必須被宣告、雜湊、驗證並進入 immutable identity。

本次盤點的 Jupiter `main@e7d90dd` 是乾淨的本機 checkout，B1 經 `775d16f`、`8e0c3f7`、`c2a569e` 三階段實作，`d25664c` 記錄 parent review，最後由 `1c98cd7` merge。M1 MCP host 此刻只有 brief 在 `main`；Phase A/B 在 branch，Phase C 仍是未提交草稿，因此不拿它當成今天已交付的主線。

今天也沒有重新執行 Jupiter tests。文中的 test counts、real Station 與 gate 結果，都標示為 `bundles-receipt.json` 的歷史證據，不改寫成本次 fresh validation。

## Bundle 的定義：一個 Manifest、一個 Identity、多種 Bytes

B1 的第一個決定，不是先新增 `resource_bytes()` API，而是先定義 bundle 是什麼：

```text
one directory
one plugin.json
one bundle id
one version
one entry artifact per served facet
zero or more declared resources
```

這仍是 mixed-format bundle 的「第一種形狀」，不是任意多個 executable entry points。

Station facet 仍只有一個 `wasm-component` artifact；client `module-v1` 仍只有一個 module artifact。新增的是各 facet 自己的 `resources`：

```json
{
  "path": "assets/icon.svg",
  "sha256": "<64 lowercase hex>",
  "kind": "asset"
}
```

Jupiter 的 fixture `saturn-fixtures.board-resources` 同時帶兩個檔案：

```json
"resources": [
  {
    "path": "data/sections.json",
    "sha256": "63a95540...",
    "kind": "data"
  },
  {
    "path": "assets/icon.svg",
    "sha256": "c0cd00c5...",
    "kind": "asset"
  }
]
```

`ResourceDecl` 只有三個 fields：

```rust
pub struct ResourceDecl {
    pub path: String,
    pub sha256: String,
    pub kind: Option<String>,
}
```

簡單不代表寬鬆。Manifest parse 時會拒絕：

- 空路徑、absolute path、backslash；
- leading／trailing／double slash；
- `.` 或 `..` segment；
- `plugin.json` 或 facet 自己的 entry artifact；
- 同一 facet 重複 path；
- 不是 64 lowercase hex 的 digest；
- 不在 closed vocabulary 裡的 kind。

目前的 kind 只有：

```text
asset | data | wasm | shader
```

Host 不會依 kind 分支執行。它只保存這個型別，讓真正的 consumer 知道拿到什麼；新增 kind 必須是刻意的 schema change，而不是任意字串默默流進系統。

`kind` 缺省為 `asset`，`resources` 缺省為空，因此舊 manifest 仍維持原本語意。

這裡先守住兩個邊界：resource path 不能逃出 bundle root，resource declaration 也不能冒充 manifest 或 entry artifact。

## 一個 Resource Byte 改變，就必須是另一個 Identity

B1 最重要的實作不是 schema，而是 `Package::identity()`。

修改前，package identity 大致是：

```text
manifest bytes
    + NUL
    + entry artifact bytes
```

修改後，每個 resource 都依 manifest order 加入：

```text
manifest bytes
    + entry artifact bytes
    + for each resource:
        NUL
        resource path bytes
        NUL
        resource content bytes
```

簡化成 pseudo-code：

```rust
for resource in resources {
    identity.push(0);
    identity.extend(resource.path);
    identity.push(0);
    identity.extend(resource.bytes);
}
```

為什麼 path 與 bytes 都要進 identity？

只放 bytes，兩個內容相同但用途不同的檔案可能無法區分；只放 path，檔案內容改變時 identity 又不會跟著變。

Manifest 的 `sha256` 本來也會隨正確更新而改變，但 host 不能只相信 manifest 自己宣稱的 digest。Admission 會讀取實際 bytes、計算 observed digest，確認它與 declaration 相同，identity 再包含真正讀到的 bytes。

因此有兩種失敗或變更：

```text
bytes changed, manifest digest unchanged
    -> admission refuses resource-digest-mismatch

bytes changed, manifest digest updated correctly
    -> valid new package identity and a new staged directory
```

這讓 resource replacement 與 entry artifact replacement 使用同一個 revision model，而不是一邊 content-addressed、一邊靠檔名覆蓋。

對 plugin hot replacement 而言，這個差異很大。候選 revision 可以在新目錄完整準備；若 activation 失敗，incumbent 繼續使用自己的 immutable resource closure，不會讀到候選剛覆蓋的 icon、JSON 或 shader。

## Admission 不相信檔案大小，也不相信 Manifest 單方面說法

`package::load_resources` 對每一個 declaration 依序執行：

1. 在 bundle root 下開啟 declared path；
2. 透過 capped reader 讀取最多 `limit + 1` bytes；
3. 使用與 entry artifact 相同的 `artifact_bytes_max` 檢查該檔案；
4. 計算 observed SHA-256；
5. 比對 manifest 的 expected digest；
6. 保存 path、bytes 與 digest。

這是 per-resource bound；不是整個 package 的 aggregate byte limit。

Capped read 也不先相信 filesystem metadata。Reader 就算宣稱檔案很小，實際吐出更多 bytes，host 仍只讀到 limit 加一，用多出的那一 byte 分辨「剛好在上限」與「已超過」。

失敗會變成 structured diagnostics：

| 狀況 | Diagnostic code |
|---|---|
| Resource file 不存在 | `package/resource-missing` |
| 實際 digest 不符 | `package/resource-digest-mismatch` |
| 單檔超過 byte bound | `artifact/too-large` |

Digest mismatch 同時帶 expected 與 observed evidence，讓 `diagnose` 可以說清楚到底是哪個 path、manifest 期待什麼、磁碟上實際是什麼。

這不是安裝失敗後才補一行 log；它與 artifact admission 走同一條 bounded path。

## Facet-Aware Read：不屬於這個 Host 的 Bytes 不碰

一個 manifest 可能同時描述 Station 與 Client facets，但兩種 Host 不應因此讀取彼此的 artifacts。

B1 延續既有的 facet boundary：

```rust
resources_for(HostFacet::Station)
    -> station.resources

resources_for(HostFacet::Client)
    -> client module-v1 resources
```

`load_with` 只讀目前 `artifact_facet` 所服務的 resources。

更嚴格的是 `load_manifest_only`：它既不開 entry artifact，也不開任何 resource。這個 mode 用於只需要 manifest shape 的路徑，foreign facet 即使宣告了一個不存在或損壞的檔案，也不會被不負責它的 Host 誤讀、誤驗證或誤執行。

這個邊界可以寫成：

```text
Manifest visibility != byte ownership
```

Host 可以看見完整 manifest，卻只對自己的 facet bytes 建立 admission claim。

## Stage 不是 Copy：寫完後重讀，再原子 Rename

Resource 通過第一次 admission，還不能直接從原始 package directory 執行。

Jupiter 的 staging 路徑是：

```text
<state>/packages/<bundle>/<identity>.staging
    -> write plugin.json
    -> write entry artifact
    -> create parents and write every resource
    -> reload the entire staged package
    -> compare identity, manifest, artifact digest and resource digests
    -> rename to <identity>
```

真正的 final directory 只會在重讀驗證成功後出現。

如果 host crash 在中間，留下的是 `.staging`，不是一個看起來完整、實際缺檔的 final revision。下次 staging 會先清掉舊 temporary directory，再重做一次。

如果 final identity directory 已存在，host 也不會直接相信目錄名稱。它會重新 load，確認：

- package identity 相同；
- manifest bytes 相同；
- artifact digest 相同；
- resource paths、順序與 digests 相同。

任何差異都拒絕 `package/identity-conflict`，不覆蓋既有目錄。

這就是「immutable staged package」的實際含義：不是加一個 `readonly` 註解，而是 write、read-back、compare、rename 的完整 protocol。

## Station 沒有新增第二條 Install Path

B1 沒有在 Station `ops.rs` 另外新增 `install-with-assets`。

原本的：

```text
install <package-dir>
list
diagnose <package-dir>
```

已經會進入 generic `package::load_for` 與 `stage_for`，所以 resources 自然跟著同一條 pipeline：

- `install` 驗證並 stage；
- framework snapshot 的 `InstallationView.resources` 暴露 path、kind、digest；
- `list` 原樣顯示；
- `diagnose` 原樣回傳 structured refusal，不安裝任何東西。

`board-resources` fixture 用既有 board Wasm component，加上 `data/sections.json` 與 `assets/icon.svg`。

測試刻意證明兩件不同的事：

1. 安裝後 `list` 看得到兩個 resources 與正確 digests；
2. 它 render 出來的 findings 與原本 board 相同。

第二點表示「加入 resource support」沒有偷偷改變 plugin runtime behavior。Station 目前只負責 admission、staging、observation；Wasm guest 還沒有 resource-read capability。

另一個 test 對複製出的 `data/sections.json` 多 append 一個 byte，`diagnose` 回傳唯一一筆：

```text
package/resource-digest-mismatch
subject: data/sections.json
```

而 host snapshot 裡沒有該 installation，證明 diagnose 沒有 side effect。

## App 的 resource(path) 綁定 Activation Digest

App 端不能只提供：

```ts
resource(bundleId, path)
```

如果 module 可以任意傳 bundle id，它就能嘗試讀取其他 package 的檔案。B1 把 resource access 綁到 activation 自己已持有的 module digest。

SDK 暴露的是：

```ts
interface Host {
  resource(path: string): Promise<ArrayBuffer>;
}
```

沒有 bundle id，也沒有 digest parameter。

Digest 在 shell 建立該 module 的 Host object 時就被綁定：

```ts
bindHostResource(
  bridge.hostFor(bundle, grants),
  activationDigest,
  bridge.resourceBytes,
)
```

Module 只看得到：

```ts
host.resource("assets/icon.svg")
```

Bridge 實際收到的才是：

```text
resource_bytes(activation_digest, "assets/icon.svg")
```

Tauri core 會：

1. 從 persisted install records 找到 artifact digest 相同的 package；
2. 進入該 record 的 staged directory；
3. 以 `HostFacet::Client` 重新 `load_for`；
4. 重新 bounded-read module 與所有 declared resources，並再次核對 resource digests；
5. 只回傳 declaration 中 path 完全相符的 bytes。

Undeclared path 與 unknown digest 都回相同的：

```text
bridge/resource-undeclared
```

兩者不被區分，是因為 module 沒有理由知道「digest 不存在」還是「package 存在但沒有這個 path」；它只需要知道自己的 manifest 沒有授權這次讀取。

這裡也有一個 receipt 明確留下的缺口：目前 record lookup 以 module artifact digest 為 key。如果未來兩個 package 使用完全相同的 `module.js` bytes，卻宣告不同 resources，會選到 records 順序中的第一筆。第一方 packages 目前不會遇到；第二種 executable client runtime 或 M1 真正需要它時，scope 應改帶完整 package identity，而不只 module digest。

## Build 也不能替 Resource Digest 手寫答案

第一方 app modules 的 build path 由 `write-resources.mjs` 負責。

它會比對：

```text
dist/plugin.json 的 client.resources declarations
                vs
dist/resources/ 實際存在的 files
```

- 磁碟有、manifest 沒宣告：失敗；
- manifest 宣告、磁碟缺檔：失敗；
- 兩邊一致：從真實 build output 計算 SHA-256，再複製到 Tauri resources。

Digest 不是開發者手動貼進 generated output。

不過 B1 的第一版沒有任何 first-party module 真正 ship resource。Build code 與 tests 已存在，app lifecycle fixture 也驗證 resource access；committed `client-app.workbench` 與 `client-app.documents` 輸出仍維持原本 bytes。

這是刻意保留的 claim boundary：build machinery 已實作，不等於產品 module 已經在使用它。

## Ingress 是明確呼叫，不是 Directory Watcher

有了 mixed bundle，很容易順手加一個 watcher：看到某個檔案 timestamp 改變，就自動 reload。

Jupiter 沒有這樣做。

目前 ingress 都是明確 command：

- Station CLI 的 `install <dir>`／`diagnose <dir>`；
- app Plugins panel 的 install；
- MCP host 未來完成後的 install／diagnose tools。

原因不只是避免 filesystem complexity。Package 可能在另一台機器；local watcher 是 remote flow 無法共用的第二條、較弱的 ingress。

當第一個 remote package 真正出現時，MCP install 應增加 archive／bytes form，再落回同一條 `package::load_for` pipeline，而不是讓 host 監看另一個 magic directory。

因此 B1 新增了 resource files，卻沒有新增 watcher crate、polling thread 或 timestamp identity。

Identity 來自 bytes，不來自「最後修改時間看起來有變」。

## Receipt 證明的不只是 388 個 Tests

B1 的 committed parent receipt 記錄在 fresh detached worktree 執行：

- `moon run :check` 通過；
- `moon run :test` 通過；
- Rust workspace：388 passed、0 failed、1 ignored；
- app 在有／無 `mcp-bridge` feature 時皆為 21 tests；
- resource build output 重建後 Git status 保持一致。

Parent 也用 real Station：

1. 安裝 analysis contract、analyzer 與 `board-resources`；
2. `list` 看到 data 與 icon 的 path、kind、digest；
3. render 得到原本 board 的兩筆 findings；
4. tampered `sections.json` 的 diagnose 得到 expected／observed digest；
5. 未 tamper package diagnose 回空陣列。

四個 negative controls 分別植入：

| 人為破壞 | 被哪個 boundary 抓到 |
|---|---|
| icon append 一個 byte | fixture digest conformance |
| 移除 `.gitattributes` 的 `-text` | Git attribute 變回 `text: auto` |
| model 裡改錯 test name | evidence existence conformance |
| resource path 改成 `../escape.json` | `manifest/resource-path-invalid` |

Receipt 也記錄 app bridge gate 為 `GATE PASSED`。

但這些仍是綁定 B1 review source 的 historical evidence。本次撰寫文章沒有重跑 tests、Station 或 bridge gate，因此不能說「我今天重新驗證了 388 tests」。

## 第一版刻意沒有完成的事

B1 已完成的是：

```text
manifest declaration
    + bounded admission
    + digest verification
    + package identity
    + immutable staging
    + Station observation/diagnose
    + app module resource access
```

它沒有完成：

- Station Wasm guest 的 `resources:read` capability；
- MCP remote install 的 archive／bytes ingress；
- directory watcher；
- 在 webview 真正 instantiate `kind: wasm`；
- 真正 compile `kind: shader`；
- 跨 bundles 分享同一份 resource；
- bundle signing 與 provenance。

另外，app 每次 `host.resource(path)` 都會重新 `load_for`，也就是重讀並重 hash 該 staged package 的 module 與全部 resources。它是正確、bounded、容易稽核的第一版，但成本與 package 大小成正比。等第一個 module 在 loop 中頻繁讀 resource，再以 installation identity 建立安全 cache，而不是提前加入 invalidation machinery。

這些不是被忘記的 TODO，而是文件明確留下的 trigger-bound steps。

## 回到 Unity：Asset 也必須進入 Revision，不只是跟在 DLL 旁邊

回到 Unity Game Dev，mixed-format bundle 更容易出現：

- Editor tool 的 managed assembly；
- UXML／USS 或 icon；
- JSON schema、prompt template、localization data；
- Compute Shader；
- Addressables catalog 或小型 content pack；
- batch-mode build 需要的 platform config。

最危險的 package shape 是：DLL 有 version 與 hash，其餘 assets 只靠相對路徑「放在旁邊」。

這會產生一個假的 revision：

```text
code identity = pinned
asset identity = whatever happens to be on disk now
```

當 agent 更新 shader 或 JSON，卻沒有更新 code，host 可能仍聲稱它正在執行同一個 plugin revision；rollback code 也不會 rollback assets；兩個 worktrees 還可能用同一個 package id 讀到不同 sidecars。

更可靠的 Unity bundle 可以沿用 B1 的原則：

```text
manifest
  entry assembly / package
  resources[] { relative path, sha256, kind }

admission
  validate path
  bounded read
  verify every digest

identity
  include every declared byte

staging
  write temporary revision
  read back and verify
  atomic promote

consumption
  bind resource access to activation identity
```

Editor Host 與 Build Host 可以用不同 consumer：Editor 把 UXML 載入 tool window，Build Host 把 shader 或 config 交給 batch pipeline；但兩者不該各自發明另一套 resource identity。

也不要用 AssetDatabase watcher 直接取代 ingress。Watcher 可以提示「來源可能改了」，卻不能替 package admission 決定是哪一組 bytes、哪一個 revision、是否已完整 stage。真正的 mutation 仍應是一個明確 install／replace operation。

對 agent-driven workflow 來說，這更重要。Agent 不只會改 `.cs`；它也會改 schema、prompt、shader、icons 與 build config。只追 source code hash，等於把一半的變更排除在 evidence chain 外。

Day 017 寫的不是「Jupiter 現在可以載入所有格式」。

它完成的是更基礎的 invariant：只要某個 resource 被宣告為 bundle 的一部分，它的 path、kind、digest 與真實 bytes 就會一起進入 admission、identity 與 staging；改一個 byte，不再是假裝同一個 revision。

**Bundle 的邊界不應由副檔名決定，而應由哪些 bytes 必須一起被驗證、替換與回復決定。**
