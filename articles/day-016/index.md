---
title: Day 016：共用的是生命週期，不是產品——Jupiter 如何抽出 Generic Plugin Host
timestamp: "2026-09-16T10:17:00+08:00"
tags:
  - AI Agent
  - Agent Development Environment
  - Plugin Architecture
---

# 共用的是生命週期，不是產品：Jupiter 如何抽出 Generic Plugin Host

Day 015 重新打開 Jupiter 時，我先把 `main`、candidate、working draft 與 historical receipt 分開，建立一張不會混淆過去與現在的 Re-entry Baseline。

今天不再停留在 repository status，而是從 Jupiter 的 docs 與 code 裡挑一個已經進入 `main` 的架構切面：

> Station 與 frontend 都要管理 plugins；哪些流程應該只寫一次，哪些差異又絕對不能被抽象吃掉？

Jupiter 的答案不是建立一個知道所有產品行為的 `BaseHost`，而是抽出：

```rust
PluginHost<R: Runtime>
```

它只擁有兩種 Host 真正相同的 plugin lifecycle composition；Station 的 Wasm capabilities、scopes、retention 與 server，frontend 的 Station links、identity verification 與 qualified routing，仍留在各自外層。

這個 generic-host increment 已透過 `7047834` 合入目前盤點的 `main@6b3935f`。今天沒有重新執行 Jupiter 的 tests；文中驗證數字都明確來自該增量已提交的 parent receipt，不把歷史綠燈寫成本次 fresh run。

## 兩個 Host，重複的不是名稱，而是生命週期

Jupiter 有兩種不同的 Host。

第一種是 **Station**。它會真正執行 Wasm plugins，擁有：

- `WasmtimeRuntime`；
- log、store、durable、retention、timer、process 與 messaging capabilities；
- scopes 與 managed execution；
- persistent Station identity；
- protocol server。

第二種是 frontend 端的 **LinkedHost**。它管理 app 自己的 modules，並連向多個 Stations，擁有：

- links registry；
- Station identity pinning；
- `<station>/<view>` qualification；
- render、act 與 events 的遠端 routing；
- app 中的 Webview runtime seam。

兩者顯然不是同一個產品角色。

但在 generic-host refactor 以前，它們各自重寫了一遍相同流程：

1. 取得 state directory 的 exclusive lock；
2. 載入或建立 `policy.json`；
3. 依 persisted records 順序恢復 installations；
4. 驗證 staged package 是否仍與 record 相符；
5. install、diagnose、uninstall 與 desired state；
6. 保存 `state.json`；
7. 提供 snapshot、views、events 與 policy access。

重複的不是 Station 或 frontend 這個名稱，而是它們包在 plugin framework 外面的 **host lifecycle**。

如果只做函式搬移，兩份流程很快又會分岔；如果把全部行為塞進一個 superclass，則會讓 generic layer 開始知道 retention、links、identity 與 server。

Jupiter 選擇的邊界是：

```text
PluginHost = shared lifecycle and persistence
Station    = PluginHost + execution capabilities + retention + scopes + server
LinkedHost = PluginHost + Station links + identity + qualified routing
```

抽象的目的不是讓兩個 Host 看起來一樣，而是讓真正相同的部分只有一個 owner。

## 先定 Ownership，才決定哪些 Code 可以搬

`docs/architecture/layout.md` 對 `projects/plugin/host` 的描述很窄：

> open、restore、admit、observe、persist，以及 state directory、policy authority、package staging 與 install records。

它沒有宣稱 generic host 擁有所有 host behavior。

從 code 看，`PluginHost<R>` 只有四個 fields：

```rust
pub struct PluginHost<R: Runtime> {
    framework: Arc<Framework<R>>,
    records: Records,
    facet: HostFacet,
    state: StateDir,
}
```

這四個 fields 形成一個清楚的 ownership boundary：

| Field | 它負責什麼 | 它不負責什麼 |
|---|---|---|
| `framework` | plugin lifecycle、views、events、reconcile | Station capabilities 或 links routing |
| `records` | install records 與 restore order | retention owner records 或 Station link records |
| `facet` | 以 Station／Client contract admission | 決定產品角色的所有行為 |
| `state` | directory、policy authority、exclusive lock | 遠端 identity 或 protocol transport |

`R: Runtime` 讓同一份 lifecycle 能包住不同 runtime adapter；但 runtime 本身仍由外層 Host 建立後交進來。

這點很重要。Station 在建 framework 前，必須先建立 durable、retention、process、scopes 等 capabilities，綁定 callbacks、bus 與 retention index。Generic host 若自行 new 一個 framework，就會搶走 Station 的 composition authority。

因此 `PluginHost::restore` 接受的是：

```rust
state: StateDir,
facet: HostFacet,
framework: Arc<Framework<R>>,
on_restore_failure: impl FnMut(...)
```

它接手 shared lifecycle，卻不接手 framework 的產品組裝。

還有一個不顯眼但很實際的 ownership 細節：`state` 被宣告在最後。Rust 會依 field 順序 drop，讓 state lock 等 framework 與 records 都不再使用該 directory 後才釋放。Station 與 LinkedHost 也都把自己的 `PluginHost` 放在最後；Station 的 `Drop` 更會先主動 shutdown framework。

這不是為了排版整齊，而是讓 lock lifetime 成為結構的一部分。

## Restore Hook：相同流程，不同失敗語意

Restore 最容易揭露一個 abstraction 是否抽過頭。

兩種 Host 的共同流程確實相同：

```text
load persisted records in order
    -> load staged package under this facet
    -> verify bytes against the record
    -> install with the persisted desired state
    -> reconcile
```

但 package 恢復失敗時，兩者不能採用同一個答案。

對 LinkedHost 而言，損壞或不相符的 client package 應保留成 diagnostic installation，讓 operator 還能看到並移除它。它沒有 durable owner 需要因此阻止整個 profile 開啟，所以 call site 很直接：

```rust
PluginHost::restore(
    state,
    HostFacet::Client,
    framework,
    |_record, _error| Ok(()),
)?
```

`Ok(())` 的意思不是「package 沒問題」，而是「保留 failed record，讓 Host 繼續開啟」。Generic host 隨後把它放進 refused packages。

Station 的語意不同。某個 staged package 驗證失敗時，它先查 retention store：

```rust
let retained = retained_revisions
    .iter()
    .any(|(revision, _)| revision.bundle == record.bundle);

if !retained {
    return Err(error.clone());
}
Ok(())
```

若沒有 retained revision 指向該 bundle，restore error 會中止 Station open；若 durable owner 仍保留它，record 才被留下來，避免在證據不足時把 owner 需要的 revision 當成可丟棄內容。

這個 hook 很小，卻保留了真正的 product semantics：

```text
Shared mechanism:
    how records are loaded, verified and restored

Host policy:
    what one restore failure means to this product
```

如果 generic layer 寫死「永遠繼續」或「永遠中止」，其中一個 Host 一定會失去原本的安全邊界。

更細的是，`PluginHost::restore` 結束時只執行 framework reconcile，**不自行寫 `state.json`**。

因為 Station 還要先做 retention restore 與 managed revocation reconciliation；LinkedHost 則要載入 `links.json`。兩個 caller 完成自己的 open sequence 後，才呼叫 `save_state()`。

共用 restore loop，不代表共用完整 opening order。

## Install Pipeline：真正值得只寫一次的路徑

相較之下，install 是很適合完全收進 generic layer 的流程。

`PluginHost::install` 依序做：

```text
load original package with limits and facet
    -> stage immutable copy
    -> reload the staged copy
    -> framework.install_as(..., Desired::Running)
    -> create InstallRecord
    -> clear same-digest refused record
    -> preserve restore order
    -> save state
```

其中「stage 後重新 load」不是多餘 I/O。

Host 最後真正執行的應該是自己保存的 immutable bytes，而不是 caller 提供、可能在 admission 後被改動的來源目錄。Record 中同時保存 package digest、artifact digest、version、staged path 與 desired state，之後 reopen 才能重新核對。

Station 與 LinkedHost 對這段流程沒有產品差異，因此各寫一份只會增加 drift：

- 一邊忘了 reload staged copy；
- 一邊先改 records 才做 framework install；
- 一邊 refusal 後留下半筆 state；
- 一邊保存順序不同，導致 reopen 行為分岔。

抽進 `PluginHost` 後，兩個外層只需 delegate：

```rust
pub fn install(&self, package_dir: &Path) -> Result<InstallOutcome, PlatformError> {
    self.host.install(package_dir)
}
```

這才是 generic abstraction 最有價值的地方：不是減少幾行 code，而是讓一條有原子性與持久化順序要求的 pipeline 只剩一個 implementation。

## Policy 只持久化，產品排序留在外層

Policy 看似也可以全部 generic 化，但 Jupiter 刻意只抽到「更新並保存」。

```rust
pub fn update_policy(&self, f: impl FnOnce(&mut Policy)) -> Result<(), PlatformError> {
    self.state.authority().update(f);
    self.state.save_policy()
}
```

它不自動 reconcile。

LinkedHost 現在的 `grant` 只需要更新 client-side bridge authority 並持久化；Station 的 policy change 則會影響 managed processes 與 capability revocation，必須保留自己的 ordering：

```text
acquire policy_changes lock
    -> mutate and persist policy
    -> reconcile managed revocations
    -> framework reconcile
    -> save state
    -> return revocation result
```

Station 的 `after_policy_change()` 因此仍在外層。

這裡可以看到一個很實用的抽象判準：

> 共用 primitive，不一定要共用 orchestration order。

`update_policy` 是兩邊相同的 primitive；revocation、reconcile 與 error precedence 是 Station 的 product contract。

若 generic layer 為了「方便」自動 reconcile，LinkedHost 會得到沒有要求的 side effect，Station 也可能失去原本的 revocation sequencing。

## Delegation 不是消失：兩個 Outer Host 還剩下什麼

抽完後，Station 的 `Host` 仍然很大，這不是 refactor 失敗。

它保留：

- Station identity mint/read；
- Wasmtime runtime limits；
- capability construction 與 scope wrapping；
- callbacks、bus、retention binding；
- scoped render/act；
- managed revocations；
- runtime metrics 與 server-facing behavior。

LinkedHost 也保留：

- `links.json`；
- live links 與 persisted link records；
- Station identity baseline；
- link add/remove/list；
- identity-change fail-closed；
- local／remote view qualification；
- routed render、act 與 events。

如果 refactor 後外層 Host 只剩空殼，反而可能表示 generic layer 知道太多。

這次抽取的成功條件不是「Host files 越短越好」，而是：

```text
Outer hosts no longer implement generic package/state machinery.
Outer hosts still own every product-specific decision.
```

名稱也跟著這個邊界收斂。原本的 `ClientHost<R>` 改名為 `LinkedHost<R>`，因為它不是所有 client behavior 的總稱，而是「一個 PluginHost，加上連往 Stations 的 links」。名稱描述 composition，不再描述模糊角色。

## Conformance 不只檢查依賴，也防止重複長回來

一般 architecture test 常停在：「A crate 不可以依賴 B crate」。

但 generic-host 的風險不是錯誤 dependency，而是半年後有人在 outer host 裡重新寫一小段 package/state logic，讓 duplication 悄悄長回來。

Jupiter 的 conformance test 因此直接讀兩個 source files：

```text
projects/hosts/station/src/host.rs
projects/station-links/src/host.rs
```

並拒絕它們重新出現這些 generic primitives：

```text
StateLock
Records::
package::
verify_matches_record
install_as(
"policy.json"
```

只做 forbidden scan 還不夠，因為規則可能監看一組根本不存在的字串，形成永遠會綠的 vacuous test。

所以同一個 test 還有 positive control：掃描 `projects/plugin/host/src`，確認每一個 needle 都真的存在於唯一 owner 中。

這個 invariant 表達的不是「這些名字很危險」，而是：

> package/state composition 必須存在，但只能存在於 `plugin/host`。

Parent review 還真的把 `StateLock::acquire` 植回 `station-links/src/host.rs`；conformance test 失敗並指出該檔案，revert 後才恢復。

這比 architecture diagram 更接近 executable ownership rule。

## Behaviour-Preserving 不能只看 Test Count

Generic-host 是 refactor，不是新 feature。這類變更最大的風險，是 API 看起來一樣，但 persisted bytes、write order、error semantics 或 drop order已經改變。

該增量的 committed parent receipt 記錄了一次 detached fresh-worktree review：

- Rust workspace 共 331 tests；
- Vitest 共 51 tests；
- build 完成後 Git status clean；
- Station 與 LinkedHost 原有 suites 保持；
- generic `PluginHost` 自己增加 15 tests（其中 13 個 integration cases）。

但 test count 只能證明「跑了多少」，不能單獨證明 behavior preservation。

更關鍵的是 binary compatibility proof：

1. refactor 前的 Station binary 建立 state directory；
2. refactor 後的 binary 讀取並 list；
3. 方向反過來再做一次；
4. 兩邊 list 只允許 runtime instance 不同；
5. `state.json` 在兩個方向都保持同一組 bytes；
6. 任一版本建立的 deny-default policy，都由另一版本讀回 `deny`。

Receipt 還記錄四個 negative controls：

| 植入的錯誤 | 預期抓住它的 gate |
|---|---|
| `plugin/host/src` 多一個未被 model 認領的 `.rs` | source inventory conformance |
| Station restore closure 改成永遠 keep | altered staged package recovery test |
| LinkedHost 重新取得 `StateLock` | composition ownership conformance |
| app binary 植入 fixture contract identifier | binary boundary test |

這些失敗案例說明 gate 真正在監看 architecture claim，而不只是剛好全綠。

不過 claim boundary 仍要保留：這些是 `generic-host-receipt.json` 記錄的歷史 review evidence。今天撰寫文章時沒有重新跑 Jupiter tests，因此不能改寫成「目前 `main@6b3935f` 已由我 fresh verified 331 + 51」。

## 這個 Generic Host 刻意沒有做什麼

一個好的 abstraction，也可以從它拒絕擁有的東西來理解。

`PluginHost<R>` 沒有：

- Station identity；
- protocol listener；
- Tokio runtime；
- durable retention policy；
- process supervision；
- scope registry；
- Station links；
- remote identity verification；
- `<station>/<view>` routing；
- Tauri window 或 UI knowledge。

它甚至不替 caller 決定所有 restore failure，也不替所有 policy change 自動 reconcile。

這些「沒有」不是尚未完成，而是抽象邊界的成果。

Generic host 可以知道 `HostFacet`，因為 admission 必須分辨 Station package 與 client module contract；但它不應因此知道 Station 或 app 的完整產品流程。

換句話說：

```text
Generic does not mean universal.
Generic means the intersection has one owner.
```

## 回到 Unity：共用 Host Core，不等於做一個 God Manager

這個設計可以直接映射回 Unity Game Dev 的 orchestration。

假設未來有兩種執行環境：

- **Editor Host**：驅動 Unity Editor、scene、asset import、Play Mode 與 domain reload；
- **Build Host**：在 batch mode 執行 deterministic build、Player artifacts、signing 與 platform toolchain。

兩者可能共同需要：

- workspace lock；
- operation records；
- immutable input snapshot；
- policy/grant persistence；
- desired state 與 recovery order；
- diagnostics、events 與 receipts。

但它們的 failure semantics 不同：

- Editor domain reload 失敗，也許可以保留 diagnostic session 供人工修復；
- Build Host 若發現 signing input 與 recorded digest 不符，必須 fail closed；
- 某個 retained build artifact 仍被 deployment owner 引用時，cleanup 不能自動丟棄；
- policy change 影響正在執行的 native process 時，需要額外 revocation ordering。

如果把所有差異塞進 `UnityHostBase` 的 boolean flags：

```text
isEditor
isBatchMode
keepBrokenSession
hasRetainedArtifact
reconcileImmediately
```

最後得到的不是 reusable host，而是一個知道每種產品例外的 God Manager。

更好的形狀接近 Jupiter：

```text
OperationHost<TRuntime>
    owns lock, records, staging, restore loop and persistence

EditorHost
    composes OperationHost + Editor lifecycle + diagnostic recovery

BuildHost
    composes OperationHost + toolchain + signing + retained artifacts
```

共同流程只有一份；不同 failure meaning 透過窄 hook 或 caller-controlled sequence 表達；architecture test 再禁止 outer hosts 重寫 staging 與 records。

對 agent-driven development environment 而言，這個界線尤其重要。Agent 很擅長複製一段「目前能用」的 code；若 ownership 只寫在文件裡，第二份 implementation 很容易自然長出來。當 conformance gate 同時檢查唯一 owner 與 positive control，Agent 才能在修改前得到可執行的邊界。

Day 016 沒有把 Station 與 frontend 合成同一個 Host。

它做的是更精確的事：讓 lock、policy、records、restore、install 與 persistence 只有一個 owner，同時讓 retention failure、policy ordering、Station identity 與 link routing 繼續由真正理解它們的產品層負責。

**好的共用層不是容納所有差異；而是把交集寫一次，並讓差異沒有理由躲進交集裡。**
