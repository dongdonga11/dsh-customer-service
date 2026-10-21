# DSH 闲鱼客服（Chrome 扩展 · MV3）

把用户已登录的闲鱼网页版（`goofish.com`）"寄生"成 DSH 客服中心的闲鱼通道：
页面自己的消息长连接负责收买家消息，DSH 通过本地 WebSocket 桥下发回复/查询动作。
**所有请求都由真人浏览器页面发出**（cookie / IP / 指纹都是真人的），因此不需要
DSH 处理登录、续期、滑块。

## 目录

```
extension/xianyu/
├── manifest.json      # MV3 清单：双 content_scripts（MAIN + ISOLATED）
├── injected.js        # 主世界：hook 页面 window.WebSocket，截帧 / 定向发消息
├── content.js         # 隔离世界：桥接页面与 background，执行 DOM / mtop 动作
├── background.js      # Service Worker：连 DSH 本地桥（ws://127.0.0.1:8765/ws）
├── popup/             # 配对码 / 桥地址 / 状态徽标
└── README.md
```

## 安装

1. 打开 Chrome → `chrome://extensions` → 右上角开启「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本目录（`dsh-cs/extension/xianyu`）。
3. 在**同一个 Chrome** 里打开 <https://www.goofish.com> 并登录要接管的闲鱼账号。
4. 点扩展图标，确认：
   - 桥地址 `127.0.0.1`、端口 `8765`（DSH 桥默认值，可改）；
   - 配对码：从 **DSH 客服中心面板/启动日志** 里复制；
5. 点「保存并连接」。扩展图标徽标变成 `ON`、popup 显示「已连接 DSH 客服中心」即成功。
6. 打开闲鱼消息页（或交给扩展自动开后台保活页）即可开始收消息。

## 连接与账号

- 握手：扩展连上 `ws://127.0.0.1:8765/ws` 后发送
  `{type:'hello', pair_code, account_id, ext_version, features, platform:'xianyu'}`，
  收到 `hello_ack ok=true` 才算连接成功。
- `account_id` 自动从页面 cookie 的 `unb` 读取，无需手填；多开 Chrome Profile
  各自登录不同闲鱼号时，每个 Profile 会各报各的账号。
- 未配对/未填配对码时不会反复重连刷日志；配对码被桥拒绝后会停止自动重连，
  改对配对码点「保存并连接」即可恢复。
- 浏览器完全退出时收不到消息（这是"不用一直盯着网页"而非"关浏览器也收"）；
  扩展会自动保持一个后台 `goofish.com/im` 标签页维持页面长连接。

## 注意事项

- **改了扩展代码后，在 `chrome://extensions` 点该扩展的「重新加载」（刷新图标），
  不要「移除」再加载**——移除会清空 `chrome.storage` 里的配对码/端口配置。
- 重新加载扩展后，已打开的闲鱼页面需要刷新一次（页面里的 content script 上下文
  已失效；扩展一般会自动刷新一次，也可手动刷新）。
- 扩展会读取页面 cookie 里的 `unb` 作为账号标识，并复用页面登录态调 mtop /
  上传图片；不接管登录、不保存 cookie。
- 本扩展只申请 `goofish.com / taobao.com / alicdn.com` 的 host 权限；桥只监听
  本机回环 `127.0.0.1`。

## 与 DSH 桥的协议（摘要）

扩展 → 桥：

| type | 载荷 | 说明 |
|---|---|---|
| `hello` | `pair_code, account_id, ext_version, features, platform:'xianyu'` | 握手 |
| `frame` | `raw` | 页面收到的原始 WS 帧（JSON 对象） |
| `user_info` | `users:[{uid, nickname, avatar_url}]` | 买家昵称/头像 |
| `risk_alert` | `detail` | 风控/验证页告警 |
| `current_chat` | `chat_id, buyer_id` | 页面当前打开的会话 |
| `platform_account` | `platform:'xianyu', account_id, nickname` | 账号注册（昵称暂空） |
| `api_result` | `req_id, data` | `call_api` 应答 |
| `cmd_result` | `req_id, ok, error` | 带 ack 指令应答 |

桥 → 扩展：

| type | 载荷 | 回执 |
|---|---|---|
| `hello_ack` | `ok` | — |
| `send_text` | `chat_id, buyer_id?, seller_id?, text` | 无（fire-and-forget） |
| `send_image` | `chat_id, buyer_id?, seller_id?, image_url, req_id, ack:true` | `cmd_result` |
| `call_api` | `req_id, action:'mtop'\|'publish_item'\|'read_page', args` | `api_result` |

## 已知限制 / 风险

- **依赖闲鱼页面结构与私有 WS 协议**：消息输入框/发送按钮/发布页选择器、以及
  `sendByReceiverScope` 的 LWP 帧字段（`cid@goofish`、`contentType:101`、base64
  custom data 等）都是按现网版本适配的，闲鱼改版可能失效。扩展只监听字符串帧，
  二进制帧会被忽略。
- 发布商品（`publish_item`）与 `read_page` 的 DOM 流程同样依赖页面文案/类名，
  改版后可能需要更新 `content.js` 里的选择器。
- MV3 Service Worker 会休眠：靠 `chrome.alarms`（约 24–30s）唤醒 + 后台保活页
  维持；Chrome 完全退出、或用户手动关闭所有 goofish 页后短暂空窗属正常。
- 多标签页时指令发给「active 且 content script 可达」的 goofish 页；同一 Profile
  只应登录一个闲鱼账号（多账号请用多 Profile）。
- `platform_account` 的昵称暂为空（页面未暴露卖家昵称），面板可先用账号 id 显示。
