# M3：闲鱼 AI 自动回复 / 自动交付 / 事件通知

> 目标：把「客服中心」从人工面板升级成能自动接待 + 自动交付 + 主动通知的运营助手，
> 同时保持与 Hermes 一致的 9 道 AI 闸门与旁路安全边界（失败不影响收发主链路）。

## 1. 话术库（AI 的唯一事实来源）

- **位置**：`$DSH_HOME/dsh-cs/knowledge/*.md`（或 `*.txt`）；也可用环境变量 `DSH_CS_KB_DIR` 指向别处。
- **格式**：普通 Markdown，按文件名排序拼接成 prompt；建议分文件：
  `店规速查.md`（发货/退换/价格口径）、`话术.md`（基础话术/成交话术）、`产品.md`（主推品与卖点）。
- **限制**：总计 20000 字截断（整份塞 prompt，不检索）；改文件后 60s 内生效（缓存 TTL）。
- **空库行为**：内核 AI 运行时检测到 kb 为空 → **转人工**（不会凭模型瞎编发出）。
- **面板诊断**：`/dsh-cs/ai-settings?platform=xianyu` 返回 kb 字数/路径/错误，用于确认话术库是否被读到。

## 2. AI 自动回复（复用内核 9 道闸门）

开启方式：面板「AI 已关 → 开启」（二次确认）；设置落 `aiSettings.enabled=true`，
并把 `aiSettings.platforms` 设为 `["xianyu"]`（或含 `douyin-laike` 多平台）。

闸门（`lib/kernel/ai.js` `planReply`，逐条有测试）：
1. 默认关闭；2. 按消息 id 幂等；3. 人工回复后静默（`humanCooldownMs`）；4. 静默期合并连发（`silenceMs`）；
5. 最小间隔（`minGapMs`）；6. 单会话每日上限；7. 消息过旧不回（10 分钟）；
8. 失败退避（同一条 60s）；9. 本地红线 + 结构化输出解析 + 发送前复查 + 全量审计。

调用模型：`ctx.llm.stream`（provider/model 取 `aiSettings` 或 `agentDefaultModel`）；
知识库与实时数据由 `adapter.aiContext()` 提供（闲鱼：话术库）。

## 3. 自动交付（付款 → 秒发）

链路（`lib/platforms/xianyu/auto_deliver.js`，挂在 runtime 事件旁路钩子上）：

```
买家付款帧 → adapter.parseInbound → xianyuKind=delivery_trigger
  → runtime.applyEvent（落库/未读/SSE，主链路）
  → 事件钩子：产品库 getAutoDelivery(account,item)
       开启且有内容 → adapter.send 立即发给买家（定向）
       → recordOutbound(by=ai) → noteAiHandled(触发消息) → 通知 delivery_sent
       未开启/无内容/发送失败 → 只记日志，主链路与 AI 照常
```

配置：`xianyu_set_auto_deliver(item_id, enabled=true, delivery_text?)`。
交付内容 = `delivery_text` 优先，否则产品详情 `netdisk` + 标题拼装（与 Hermes 文案模板一致）。
`xianyu_deliver` 可手动补发。

## 4. 事件通知（webhook）

DSH 没有 Hermes gateway 的多平台通道，因此用「最小 webhook 出口」，不存储任何平台凭证：

`cordis.patch.yml` 的 `notify` 段：

```yaml
notify:
  enabled: true
  webhookUrl: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx   # 企微/飞书/钉钉机器人或自建
  events: [order, urge, rate, risk]
  throttleSeconds: 60
```

事件与触发点：

| event | 触发 | payload 关键字段 |
|---|---|---|
| `order` | 付款待发货（`delivery_trigger`）、买家确认收货 | accountId/buyerId/chatId/itemId/text/subtype |
| `urge` | 买家消息命中催货关键词（什么时候发货/在吗/尽快/急…） | 同上 |
| `rate` | 买家发起评价请求 | 同上 |
| `risk` | 扩展上报风控/验证码页（`risk_alert`） | detail |
| `delivery_sent` | 自动交付成功 | accountId/chatId/buyerId/itemId |

语义：`enabled && webhookUrl` 才发；同事件 + 同账号 + 同买家在 `throttleSeconds` 内只发一次；
POST `application/json`，5s 超时；失败只记 warn（**通知永不影响客服主链路**）。
WhatsApp 等 webhook 若要求特定结构，可在 `lib/kernel/notifier.js` 的 body 拼装处加适配。

## 5. 测试与边界

- 单测：`test/auto-deliver.test.mjs` 7 用例（自动交付成功/关闭/失败、通知开关/过滤/节流/失败、催词汇、话术库读取与空库原因）。
- 全量：**72/72 通过**。
- 未验证：真实闲鱼账号的付款帧字段（离线合成帧覆盖；真机首单请对照 `mtop_debug.log` 与面板事件）；
- 未做：AI 回复的真实模型调用验收（默认关闭，避免误发顾客）；话术库超过 2 万字需换检索（后续）。
