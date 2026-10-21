# M4 工具层：Hermes 31 个 tool → DSH 映射进度

> 目标：闲鱼能力不弱于 Hermes 版。Hermes `plugins/platforms/xianyu/tools.py` 共 31 个 tool；
> DSH 版按批次移植，每批带契约测试，注册进 DSH `ctx.tools`（Agent 可见）。
> 通用机制：`lib/kernel/toolkit.js`（注册/释放）+ `lib/platforms/xianyu/tools.js`（定义与执行）
> + `adapter.callApi`（mtop 归一，接口名与 `${APP}` 对齐 Hermes）。

## 批次 1（已完成 ✅，16 个工具 / 15 个 Hermes 对应 + 1 个通用 mtop）

| DSH 工具 | Hermes 对应 | 通道 / 接口 |
|---|---|---|
| `xianyu_status` | ✅ | 内核状态（桥/账号/未读） |
| `xianyu_send_message` | ✅ | 扩展 `send_text` / `send_image`（定向） |
| `xianyu_mtop` | 🆕 通用逃生口 | 任意 mtop（排障/新接口试验） |
| `xianyu_get_order` | ✅ | `mtop.idle.web.trade.order.detail` v1.0 |
| `xianyu_list_orders` | ✅ | `mtop.taobao.idle.trade.merchant.sold.get` v1.0 |
| `xianyu_confirm_ship` | ✅ | `mtop.taobao.idle.logistic.consign.dummy` v1.0 |
| `xianyu_freeshipping` | ✅ | `mtop.idle.groupon.activity.seller.freeshipping` v1.0 |
| `xianyu_rate` | ✅ | `mtop.taobao.idle.rate.create` v4.0 |
| `xianyu_close_order` | ✅ | `mtop.taobao.idle.trade.merchant.close.by.seller` v2.0 |
| `xianyu_buyer_credit` | ✅ | `mtop.idle.web.trade.rate.list` v1.0 |
| `xianyu_item_detail` | ✅ | `mtop.taobao.idle.pc.detail` v1.0（可覆盖） |
| `xianyu_refresh_item` | ✅ | `mtop.taobao.idle.item.polish` v2.0（软成功集合） |
| `xianyu_delete_item` | ✅ | `mtop.alibaba.idle.seller.pc.item.delete` v1.0 |
| `xianyu_search` | ✅ | `mtop.taobao.idlemtopsearch.pc.search` v1.0（appKey 12574478） |
| `xianyu_publish_item` | ✅ | 扩展 `publish_item`（DOM 自动化，90s） |
| `xianyu_read_page` | ✅ | 扩展 `read_page`（扁平 args，45s publish） |

**验收**：`test/xianyu-tools.test.mjs` 9 tests（清单/注册释放/mtop 透传/订单交易 api 名/data 体/找品 appKey/发消息落库/发品读页面 args 形状/失败不抛异常）；
真机：DSH `Tool.listTools` 已能看到全部 16 个工具（Agent 可调）。

## 批次 2（已完成 ✅，16 个工具 / 13 个存储类 + 退款 + 曝光）

| DSH 工具 | Hermes 对应 | 依赖 / 通道 |
|---|---|---|
| `xianyu_sync_items` / `xianyu_list_items` | ✅ | `mtop.idle.web.xyh.item.list`（`inject_unb_as=userId`）→ 产品库骨架 |
| `xianyu_get_product` / `xianyu_update_product` / `xianyu_draft_products` | ✅ | 产品库详情层（`updateDetail` 不覆盖骨架） |
| `xianyu_set_auto_deliver` / `xianyu_deliver` | ✅ | 自动交付配置 + 手动补发（复用 `adapter.send` 定向） |
| `xianyu_collect` / `xianyu_list_collected` / `xianyu_pick_collected` / `xianyu_draft_from_collected` | ✅ | 采集库（与产品库物理隔离；页间 1.2s 节流） |
| `xianyu_get_customer` / `xianyu_update_customer` / `xianyu_list_customers` | ✅ | 客户档案（按 account/buyer 分区） |
| `xianyu_refund` | ✅ | 订单 `btnList` 动态取 apiName/apiVersion/params（不猜接口） |
| `xianyu_shop_exposure` | ✅ | 逐品详情 + 通用字段扫描；命中验证码立即早停 |

**验收**：`test/xianyu-store-tools.test.mjs` 8 tests（清单/骨架同步/产品库/客户/采集/退款动态接口/曝光风控早停/真实 store 分区落盘）；
`test/xianyu-stores.test.mjs` 由存储模块自带；真机 `Tool.listTools` 已列出 **32 个** xianyu_* 工具。

存储落盘：`$DSH_HOME/dsh-cs/{products,customers/<account>/,collected}/`，原子写、按账号分区、与旧插件数据隔离。

## 批次 3（已完成 ✅：运营闭环）

- **话术沉淀**（playbook 聚合）：`lib/platforms/xianyu/playbook.js` —— 增量复盘客户档案 → 小模型提炼 →
  append/refine 写回 `knowledge/*.md`（改动前备份 `.backups/`、refine 只在唯一精确子串时替换、默认关闭、30 分钟一次）；
- **买家昵称/头像富化**：`user_info` 事件 → 客户档案/通讯录 → 面板与 AI 上下文都显示昵称（查不到回退 id）；
- **通知**：webhook（出单/催货/待评价/风控/自动交付成功），见 `docs/M3-AI-AND-NOTIFY.md`；
- **话术库模板**：`node scripts/seed-knowledge.mjs`（docs/knowledge-templates 三个模板，幂等不覆盖）。

## 与 Hermes 的行为差异（刻意/已知）

1. 工具返回值：Hermes 返回 JSON 字符串；DSH 同样返回 JSON 字符串（模型看到 `output.render` 的文本）。
2. 多账号：Hermes 有 employee/account 三级映射；DSH 用 `account_id` 参数 + 自动选已连接账号。
3. `xianyu_publish_item` 本地图片：已补 data URL 转换（≤8MB，png/jpg/webp/gif）。
4. 不可逆工具在 description 明确要求先确认（Hermes 靠 skill 约束）。
5. 曝光体检的字段扫描是「通用递归」（闲鱼详情字段名不稳定），可能漏字段；真机用 `xianyu_item_detail` 校准。
6. 话术沉淀：Hermes 分「类型目录 + skill 文件」；DSH 直接维护 `knowledge/*.md`（与 aiContext 读取口径一致），
   refine 更保守（唯一精确子串才替换），默认关闭（避免后台烧 token）。
