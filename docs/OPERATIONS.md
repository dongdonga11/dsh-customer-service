# 运维手册（dsh-customer-service）

> 读者：安装/运维这套客服插件的人。
> 改完 `lib/` 下的 `.js` 需要重启 DSH（已安装包换代码要重启加载新代际）；改 `knowledge/` 里的 md 不用重启（约 60s 内生效）。

## 1. 日常操作

| 想做什么 | 怎么做 |
|---|---|
| 看连接状态 | 面板「客服中心」→ 平台卡（在线/账号/未读），或问 AI（`xianyu_status`） |
| 人工回复 | 面板 → 账号工作台 → 点会话 → 底部输入框 |
| 让 AI 别管某个会话 | 会话顶栏「让 AI 别管 / 交回 AI」 |
| 开/关 AI 自动回复 | 面板「AI」按钮（二次确认后才生效） |
| 擦亮/查订单/改价等 | 在 AI 对话里直接说（工具已注册），不可逆操作会先确认 |
| 清空客服数据 | 面板「清空数据」（不要手删 state.json） |

## 2. 话术库 / 知识库

```powershell
node scripts/seed-knowledge.mjs          # 首次：从模板生成 3 个文件
node scripts/seed-knowledge.mjs --force  # 用模板覆盖（谨慎）
```

目录：`$DSH_HOME/dsh-cs/knowledge/*.md`。

- AI **只依据**这里（和「资料库」项目里的文档）回答；没写的会转人工，不瞎编。
- 建议总量 ≤2 万字；超过请拆分/精简。
- 面板「AI 设置」里能看到实际读到的字数与错误。

## 3. 通知（可选）

`cordis.patch.yml` → `notify.enabled: true`、填 `webhookUrl`（企微/飞书/钉钉机器人或自建），重启 DSH。
事件：出单/催货/待评价/风控/自动交付成功；同事件同买家 `throttleSeconds` 内只发一次。

## 4. 话术沉淀（可选，默认关）

`cordis.patch.yml` → `playbook.enabled: true`，重启 DSH。
每 30 分钟复盘「新增对话」，把可复用打法写回 `knowledge/话术.md`（改动前自动备份到 `knowledge/.backups/`）。
建议先开着观察一周、人工抽查备份文件；跑偏就关掉 `enabled` 并还原备份。

## 5. 产品表（Excel 导入）

```powershell
python scripts/import_products.py "D:\下载\商品明细_xxx.xlsx" `
  --project-dir "$env:USERPROFILE\.dsh\dsh-cs\library\projects\default\files"
```

- 生成 `产品/产品表.md`（价格速查 + 每商品一节，AI 可检索）；
- 源 xlsx 自动复制到 `产品/源文件/` 保留；
- 商促价 / 平台券 ID / 归属户 ID 这类内部列不写入 md；
- 平台改价后重新跑一次（文件更新 → 索引自动重建）。

## 6. AI 测试（沙箱）

- 客服台顶栏「AI 测试」→ 跟随当前账号 → 发买家消息，看真实回复（规则 + 项目资料 + 模型 + 红线）；
- **不发送**到抖音/闲鱼、**不落会话**、**不写审计**，关掉弹窗即清空；
- 测试账号必须**已绑定项目**（发消息才带资料）；未绑定的账号 AI 没资料，只会转人工；
- 回复下方显示：项目名、知识库字数、耗时、命中文件、实时数据、是否判定转人工；
- 点「调试信息」可看：账号平台 / kbError / stage / 判定原因 / 模型原始输出。

## 7. 店铺 MCP（可选，只读）

- 客户端：`lib/kernel/shop-mcp.js`，通用 stdio MCP 客户端；只读白名单 `shop_state` / `stock_list`，写操作永不注册给 AI。
- 启用：配置环境变量（见文件头注释）：
  - `DOUYIN_CS_SHOP_MCP_NODE`：运行 MCP 服务的 node（默认当前 node）
  - `DOUYIN_CS_SHOP_MCP_TSX`：tsx cli 路径（可选）
  - `DOUYIN_CS_SHOP_MCP_SCRIPT`：MCP 服务入口脚本
  - `DOUYIN_CS_SHOP_MCP_CWD`：工作目录
  - `DOUYIN_CS_SHOP_MCP=off`：彻底关闭
- 诊断：`/dsh-cs/diag` 的 `shopMcp.lastError`；沙箱调试信息里「店铺实时数据」。

## 8. 数据与备份

```
$DSH_HOME/dsh-cs/
  state.json                 # 账号/会话/消息/通知与AI设置/审计
  pair-code-*.txt            # 扩展配对码（不要外传）
  products/ customers/ collected/   # 产品库 / 客户档案 / 采集库
  knowledge/                 # 话术库（真源，自行备份）
  library/                   # 资料库（项目=资料+账号绑定）
  mtop_debug.log             # 接口排障（>512KB 自动轮转）
  playbook-state.json        # 话术沉淀进度
```

**备份**：定期整目录复制到别处（`state.json` + `knowledge/` + `library/` 最重要）。
**注意**：同一 `$DSH_HOME/dsh-cs` 只允许一个 DSH 实例写（无跨进程锁）。

## 9. 真机联调清单（闲鱼）

1. `node scripts/seed-knowledge.mjs`，编辑 `knowledge/*.md` 成自己店铺规则；
2. Chrome 加载 `extension/xianyu/`，填 `127.0.0.1:8765` + 配对码（`pair-code-xianyu.txt`）；
3. 打开 goofish 消息页 → 面板出现「闲鱼」账号卡与买家会话；
4. 发一条测试消息 → 面板 3s 内出现；人工回一条 → 闲鱼端收到、会话转人工接管；
5. 测自动交付：某商品 `xianyu_set_auto_deliver` 开启 → 用小号拍下 → 应秒发网盘；
6. 异常排查：`mtop_debug.log`（接口原始返回）、面板「诊断」、DSH 启动日志 `[dsh-cs]` 前缀。

## 10. 已知边界

- 扩展依赖页面结构与私有协议（如 `sendByReceiverScope`、mtop 签名）→ 平台改版会失效，需更新 `extension/*`；
- 买家昵称：消息帧不带，只有页面加载过该买家（`user_info`）才有，否则显示 id；
- 图片只支持 URL / base64 / data URL；本地路径在工具里转 data URL（≤8MB）；
- 浏览器完全退出时收不到消息（扩展能力之外）。
