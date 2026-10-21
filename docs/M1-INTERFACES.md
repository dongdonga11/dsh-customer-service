# M1 接口与拆分规格（施工用）

目标：把 `lib/_legacy/index.js`（1197 行，抖音专用）拆成「内核」与「抖音平台适配器」，行为完全不变。
验收：抖音功能逐项对等 + `node --check` 全绿 + 内核里不出现平台专有字符串（注释除外）。

## 0. 已经完成、不要改动的文件

- `lib/kernel/bridge.js`：`CsBridge`（已参数化 `defaultPlatform` / `label`）
- `lib/kernel/store.js`：`Store`（已参数化 `dataDir` / `sessionSlug` / `defaultPlatform` / `label`）
- `lib/kernel/ai.js`：原样（纯函数）
- `lib/platforms/douyin/protobuf.js`：原样
- `lib/_legacy/index.js`：只读参考，不要修改（它是行为基线）
- `lib/client.js`：由 Lead 改，不要动

## 1. 要创建的文件（只有这 4 个）

### 1.1 `lib/platforms/douyin/adapter.js`

```js
export function createDouyinAdapter({ store, kb, shopMcp, log, host }) {
  return {
    spec,                    // 见 §3
    accountIdOf(handshakeMsg) -> string,
    identifySelf(msg, accountId) -> { selfUid?, selfSecUid?, accountNickname? },
    parseInbound(msg, io) -> CsEvent[],          // 同步，纯解析；不落库、不发送
    async send(thread, text, io) -> { ok, error?, serverMessageId?, detail? },
    canSend(thread, io) -> { ok, reason? },
    enrichBuyer(thread, io) -> { name, avatar, buyerId, nameKnown },
    // 抖音专有：模板持久化（send_template 帧写入 templates/<account>.json）
    async captureSendTemplate(accountId, bodyB64) -> boolean,
    hasSendTemplate(accountId) -> boolean,
    // 来客轮询型平台的入站帧由扩展上报（laike_sync），不需要 poll()
    poll: null,
  }
}
```

来源映射（`_legacy/index.js` 行号）：

| 内容 | 行号 | 归属 |
|---|---|---|
| KB 解析 `resolveKbDir` | 31–75 | adapter（抖音业务知识库） |
| `persistTemplate` / `loadTemplate` | 155–190 | adapter |
| 入站 `switch` 的抖音分支：`frame` / `send_template` / `user_info` / `account_detected` / `platform_account` / `laike_sync` / `laike_probe` / `account_identity` / `ws_hooked` | 219–390 | adapter.parseInbound / captureSendTemplate |
| 发送通道 A（模板改写 `send_raw`） | 1033–1127 中抖音分支 + 1066–1074 | adapter.send |
| 发送通道 B（`laike_send`） | 1140–1186 | adapter.send |
| 平台账号/自身识别 | 301–390 + `content.js` 协议 | adapter.identifySelf/accountIdOf |

`parseInbound` 返回事件（内核只认这些）：

```js
{ kind:'message', platform, accountId, conversationId, conversationShortId?, buyerUid?, buyerSecUid?,
  buyerName?, buyerAvatar?, text, serverMessageId?, at }
{ kind:'send_template', platform, accountId, bodyB64 }
{ kind:'account', platform, accountId, nickname?, detectedId?, identity? }  // platform_account / account_detected / account_identity
{ kind:'batch', platform, accountId, threads:[…] }                          // laike_sync
{ kind:'probe', platform, accountId, data }                                 // laike_probe / ws_hooked
```

### 1.2 `lib/kernel/desk.js`

纯聚合（不碰网络、不碰 ctx）：`listPlatforms(adapters, bridge)`、`listAccounts(store, adapters, bridges)`、`listThreads(store, platform)`、`getThreadView(store, threadId, adapter)`、`markRead`、`unreadTotal`、`renameThread`、`clearAll`。
来源：`_legacy/index.js` 698–741（账号卡/会话聚合）、`client.js` 消费的 `/state` 字段形状（必须保持字段名不变，client 才能不改）。

### 1.3 `lib/kernel/routes.js`

`mountRoutes({ webServer, prefix, auth, runtime })`：把 legacy 662–1187 的路由迁过来，路径与语义保持不变：
`/state`、`/thread`、`/send`、`/rename`、`/mark-read`、`/ai/get|set|test|log`、`/clear`、`/diag`、`/events`(SSE) 等。
要求：
- 复用 `runtime` 的 desk/adapter/send 方法；
- 统一鉴权：`auth.check(req)` → 失败 401（Origin/配对码 token，Lead 提供 `auth`）；
- JSON body 限 1MB；异常统一 500 + 结构化错误。

### 1.4 `lib/kernel/runtime.js`

`createRuntime({ ctx, config, store, adapters, bus, log })`：
- `apply(msg, accountId)`：处理内核事件 `_paired` / `_disconnected` / `api_result` / `cmd_result` 内建类型；其余交给对应 adapter 的 `parseInbound` → `applyEvent`（落库/未读/回声抑制/去重/SSE 通知）。
- 回声抑制 `rememberOutbound/isOwnEcho`、去重 `isDuplicate`：从 legacy 106–154 迁移（通用）。
- AI 运行时（legacy 407–649）：提示词由 adapter 提供 `buildSystemPrompt`? —— **不，保持现状**：AI 运行时是内核的，知识库/业务数据通过 `adapter.aiContext()` 提供（抖音返回 KB + 实时数据一行；闲鱼后续返回话术库）。请新增 adapter 可选方法 `aiContext()`，并在 adapter 中实现抖音版本（把 legacy 的 KB/实时数据逻辑搬进去）。
- `sendToThread(thread, text)`：按 `thread.platform` 找 adapter → `adapter.send` → 成功后 `adapter.noteOutbound`（若实现）→ 广播 SSE。
- `bus`：`{ emit(event, payload), subscribe(fn) }`，供 SSE；
- `mountRoutes` 时传入自身。

## 2. 内核/平台边界（硬规则）

- `lib/kernel/*.js` 里**不允许**出现 `douyin` / `laike` / `protobuf` 等平台字样（注释除外）。
- 平台专有逻辑一律在 `lib/platforms/<name>/` 下。
- 所有平台差异通过 adapter 方法与 `spec.capabilities` 表达，内核不写 `if (platform === ...)`。
- 数据形状与现有 `state.json` 完全兼容（字段名不改、不新增必填字段）。

## 3. 平台 spec（`lib/platforms/*/adapter.js` 导出）

```js
const spec = {
  name: 'douyin', label: '抖音', sessionSlug: 'dy',
  defaultPort: 8766, loginUrl: 'https://www.douyin.com/',
  extensionDir: 'extension/douyin', tabGlob: '*://*.douyin.com/*',
  capabilities: { sendMode: 'template', requiresSendTemplate: true, supportsImages: false, supportsPolling: false },
  platforms: ['douyin', 'douyin-laike'],   // 该 adapter 负责的 thread.platform 值
}
```

## 4. 验收清单

1. `node --check` 全部新文件通过。
2. `node -e "import('./lib/kernel/runtime.js')"` 与 `import('./lib/platforms/douyin/adapter.js')` 可加载（无顶层副作用、无缺失依赖）。
3. 内核文件 grep 无平台字样（注释白名单）。
4. 行为对等自查表（写进 `docs/M1-PARITY-CHECK.md`）：
   - 收消息：frame → 会话/消息/未读/SSE
   - 发消息：模板存在 → 发；模板缺失 → 明确报错
   - 来客：batch 入库、未读幂等、DOM 发送回读
   - 账号：platform_account / account_detected / account_identity
   - 面板：`/state` 字段与旧版逐字段一致（用旧 `state.json` 样本比对）
   - AI：开关/闸门/接管/审计日志与旧版一致
