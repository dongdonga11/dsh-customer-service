# 资料库（Knowledge Library）设计稿

> 目标：给客服中心加一套**共享资料库**——一个「项目」拥有自己的文档/文件夹，绑定具体的闲鱼号/抖音号；
> AI 回复时只读「当前账号所属项目」的资料，做到「项目隔离 + 按项目配置资料」。
> 状态：**P1 后端已实现并上线**（2026-10-20）；面板「资料库」视图同批完成基础版。

## 0. 已确认的决策（运营者拍板）

1. **一个账号只属于一个项目**（改绑会自动从旧项目移除）；
2. 文件格式：Markdown/文本/JSON/CSV 先支持；图片**可存**（AI 看图后续接视觉模型，已预留 dataUrl 读取）；
3. 检索：**先关键词 + 必读置顶**，接口留好，后续再加向量检索；
4. MCP 走**项目级**；资料库入口 = **与「客服中心」平级的独立侧栏面板**（运营者 2026-10-20 追加要求：方便手动维护资料）。

---

## 1. 需求复述（确认理解）

- 现在知识库是**全局一份**（`$DSH_HOME/dsh-cs/knowledge/*.md`），所有平台/账号共用 → 接第二个项目就串味。
- 需要：「项目」为单位组织资料库；资料库里有**文件夹 + 文档**；资料库**绑定账号**（抖音号、闲鱼客服号）。
- 例：
  - 项目「示例店铺」：资料（店规、话术、产品）+ MCP（店铺数据服务）→ 绑定 抖音号A + 闲鱼号甲
  - 项目「高报」：另一套资料 → 绑定 闲鱼号乙
  - 其它项目同理，可继续加。
- AI 回复时必须**只依据当前会话账号所属项目的资料**（可扩展到 MCP 查询），查不到就转人工。

一句话：**项目 = 资料库 +（可选）MCP + 账号绑定**；AI 按「账号 → 项目 → 资料」取上下文。

---

## 2. 数据模型

```jsonc
// $DSH_HOME/dsh-cs/library/projects.json
{
  "version": 1,
  "projects": [
    {
      "id": "demo-shop",                    // 稳定 id（小写字母数字-；用作目录名）
      "name": "示例店铺",
      "description": "示例店铺 DIY 店铺客服",
      "enabled": true,
      "pinned": ["店规速查.md", "话术/接待.md"],   // 每次都给 AI 的必读文件（相对路径）
      "accounts": [                       // 账号绑定（一个账号只能属于一个项目；见 §9-Q1）
        { "platform": "douyin", "accountId": "default", "label": "DSH抖音号" },
        { "platform": "xianyu", "accountId": "100000001", "label": "闲鱼-示例店铺客服" }
      ],
      "mcp": [                            // 可选：项目级 MCP（示例店铺的店铺数据服务）
        { "id": "shop", "label": "门店店铺", "transport": "stdio",
          "command": "node", "args": ["..."], "env": {}, "readOnlyTools": ["shop_state", "stock_list"] }
      ],
      "retrieval": { "mode": "keyword", "maxChars": 6000, "maxChunks": 5, "topFiles": 3 },
      "createdAt": "...", "updatedAt": "..."
    }
  ]
}
```

磁盘布局（文件即真相，索引可重建）：

```
$DSH_HOME/dsh-cs/library/
  projects.json
  projects/<projectId>/
    files/                      # 用户文件树（保留文件夹结构；md/txt/json/csv/图片）
      店规速查.md
      话术/接待.md
      产品/主推.md
    meta.json                   # 每文件 tags/summary/pinned/updatedAt（可选编辑）
    index.json                  # 检索索引（chunk → 文件/标题/词频），可随时重建
```

为什么文件树在磁盘：运营者/运营可以直接用资源管理器整理、备份、用 git 管；插件只做索引与读取。

---

## 3. 账号 → 项目解析（AI 上下文的入口）

```
入站消息 → thread.accountId + thread.platform
  → 查 projects.json 的 accounts 绑定 → projectId
  → 没有绑定 → 用「平台默认项目」（可配）或退回全局旧 knowledge（兼容）
  → aiContext({ accountId, platform, query })
      = pinned 文档全文（必读）
      + 检索命中 chunks（按当前买家最后几条消息做 query）
      + （可选）项目 MCP 的实时数据（如店铺数）
```

- 绑定是**账号级**的：同一个抖音号/闲鱼号只会属于一个项目（避免串料）。
- 平台默认项目：用于「新账号刚接入、还没分配」的过渡期，避免直接没有资料；未绑定时面板会提示「该账号尚未分配项目」。
- 面板上「平台卡 → 账号卡」会显示所属项目名，可一键改绑。

---

## 4. AI 检索策略（先做便宜可靠的）

**P1：关键词检索 + 必读置顶**（无 embedding、无外部服务）

1. 建索引：按 Markdown 标题切 chunk（≈400–600 字），记录 `file / heading / tokens / length`；
2. 查询：取当前买家最后 3 条消息 + 当前消息，做分词（中文按 2-gram + 英文单词），去停用词；
3. 打分：`词命中 × idf + 标题命中加成 + tags 加成 + 文件名命中加成`；同一文件最多取 2 个 chunk；
4. 组装：`pinned 全文（截断）` + `topN chunks（≤ maxChars）`，带来源标注（文件名），方便 AI 说「按店规第 X 条」；
5. 没命中且没有 pinned → 返回空 kb → 内核转人工（绝不瞎编）。

**P2（可选）**：向量检索（需 embedding 模型 + 本地索引），或「大文档摘要 → 按需展开」。

**AI 可见的工具**（只读，安全）：
- `cs_library_list(project?)`：目录树（项目/文件夹/文件 + 大小/更新时间）
- `cs_library_search(query, project?, limit?)`：返回命中片段 + 文件路径
- `cs_library_read(path, project?)`：读整篇（>8000 字截断并提示分段读）

---

## 5. HTTP 路由（面板用）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/dsh-cs/library/projects` | GET/POST | 列表 / 新建（name/id/desc） |
| `/dsh-cs/library/projects/<id>` | PATCH/DELETE | 改名/描述/启用/删除（删除需确认） |
| `/dsh-cs/library/projects/<id>/bind` | POST | 绑定账号 `{platform, accountId}` / 解绑 |
| `/dsh-cs/library/projects/<id>/tree` | GET | 文件夹树 |
| `/dsh-cs/library/projects/<id>/file` | GET/PUT/DELETE | 读/写（文本）/删；`?path=` |
| `/dsh-cs/library/projects/<id>/folder` | POST/DELETE | 建/删文件夹 |
| `/dsh-cs/library/projects/<id>/move` | POST | 移动/重命名 `{from,to}` |
| `/dsh-cs/library/projects/<id>/search` | GET | `?q=` 返回命中片段（调试/预览） |
| `/dsh-cs/library/projects/<id>/reindex` | POST | 重建索引 |
| `/dsh-cs/library/context-preview` | POST | `{accountId, platform, text}` → 返回「AI 实际会读到的内容」（验收神器） |

上传：文本类走 JSON PUT；图片/附件走 multipart（P2）。

---

## 6. 面板 UI

在「客服中心」内新增第三层视图 **资料库**（与「平台/账号工作台」并列，通过顶部 tab 切换；保留两层结构不变）：

```
资料库
├─ 左侧：项目列表（示例店铺 / 高报 / …）  [+ 新建项目]
│    每个项目显示：绑定账号数、文档数、最后更新
└─ 右侧：选中项目的详情
   ├─ 绑定账号：多选（抖音号 / 闲鱼号，显示在线状态与当前绑定）
   ├─ 文件树：文件夹/文档（点击预览/编辑 markdown；拖拽移动 P2）
   ├─ 必读（pinned）：勾选「每次都给 AI 的文档」
   ├─ MCP（可选）：示例店铺项目 → 店铺数据服务（只读工具白名单）
   └─ 调试：输入一句买家话 →「AI 会读到的内容」预览 + 命中打分
```

账号卡上显示「项目：示例店铺」，点一下可跳到资料库对应的绑定项。

---

## 7. 与现有代码的改动点

| 模块 | 改动 |
|---|---|
| 新增 `lib/kernel/library.js` | 项目/文件/索引/检索/绑定的核心实现（零平台字样） |
| 新增 `lib/kernel/library_tools.js` | AI 只读工具（list/search/read），注册进 `ctx.tools` |
| `runtime.js` | `aiContext` 调用改为带 `{accountId, platform, thread, query}`；`/state` 增加项目信息 |
| `xianyu/adapter.js` | `aiContext` 改为「解析项目 → library 取上下文」；没有项目时退回当前全局 knowledge（兼容） |
| `douyin/adapter.js` | 同上；把写死的 `客服知识库` 路径改为「项目资料库」（旧路径仅作兜底）；`shopMcp` 改为项目 MCP 注入 |
| `index.js` | 初始化 library（建目录/空 projects.json）、注册工具、挂路由、账号改绑后失效 AI 上下文缓存 |
| `routes.js` | 新增 §5 路由（鉴权沿用现有） |
| `client.js` | 顶部 tab + 资料库视图 + 账号卡显示项目 |
| 迁移 | 现有 `knowledge/*.md` → 自动建「默认项目」并复制进去（不删原件，可回退） |

MCP 说明：DSH 插件可以在 Host 进程里 spawn 本地 MCP 客户端（抖音适配器已有 `shop-mcp.js` 先例）。
项目级 MCP 的配置存 projects.json，读取时用「项目 → MCP 列表」构造客户端；P1 先把「示例店铺的店铺数据服务」作为项目 MCP 接上，通用远程 MCP（URL+token）放 P2。

---

## 8. 验收标准

1. 建两个项目（示例店铺/高报），各自放不同文档，分别绑不同闲鱼号；
2. 用假扩展分别以两个账号发消息 → `context-preview` 显示各自项目的资料，互不串；
3. 未绑定账号发消息 → 走默认项目（或转人工），面板有「未分配项目」提示；
4. AI 自动回复只依据本项目资料；命中不到 → 转人工；
5. AI 可调用 `cs_library_search/read` 查资料，返回带文件路径；
6. 删除/改绑项目后，AI 上下文立即变化（缓存失效）；
7. 旧 `knowledge/*.md` 自动迁入默认项目，旧行为不丢；测试覆盖：绑定解析、检索打分、上下文截断、路径穿越防护（`../`）、项目删除。

---

## 9. 需要拍板的 5 个点

1. **一个账号能否绑多个项目？** 建议「一个账号 = 一个项目」（简单、不会串）；如果闲鱼号要同时服务两个项目，需要「多项目 + 会话级切换」。
2. **资料文件类型**：P1 只做 Markdown/文本/JSON/CSV（在线编辑 + 上传），图片附件 P2？还是现在就要 PDF/Word/Excel？（PDF/Word 要抽文本，成本高一些）
3. **检索方式**：先做关键词 + 必读置顶（零成本、可解释、当天可用），向量检索放后面？还是直接上 embedding？
4. **MCP 归属**：示例店铺的店铺数据服务按「项目级 MCP」配（推荐，换项目换 MCP）；还是继续挂在抖音适配器上？
5. **资料库入口**：放「客服中心」里的第三个视图（推荐，和账号/会话在一起），还是 DSH 侧边栏独立入口？

---

## 10. 实施顺序（确认后开工）

- **P1（核心闭环，1–2 天）**：library 内核 + 项目/绑定/文件树 + 关键词检索 + AI 上下文接入（两个适配器）+ 3 个只读工具 + 迁移 + 测试；
- **P2（1 天）**：面板资料库视图（增删改/上传/绑定/必读/预览调试）+ 账号卡显示项目；
- **P3（1–2 天）**：项目级 MCP（店铺数据服务迁入）+ 远程 MCP + 图片/附件 + 索引优化。

## 11. P1 实际落地（2026-10-20）

已实现：

| 模块 | 文件 | 说明 |
|---|---|---|
| 资料库内核 | `lib/kernel/library.js` | 项目 CRUD、账号绑定（一账号一项目）、文件树/读写/移动/删除、索引与关键词检索、上下文组装、迁移、路径穿越防护 |
| AI 工具 | `lib/kernel/library_tools.js` | `cs_library_projects / list / search / read`（只读，已真机注册） |
| HTTP 路由 | `lib/kernel/routes.js` | 9 条：projects/project/bind/tree/file/file-get/search/reindex/context-preview |
| 适配器接入 | `lib/platforms/{xianyu,douyin}/adapter.js` | `aiContext({accountId,platform,query})` 按项目取资料；无项目时闲鱼退回全局 knowledge，抖音诊断/实时数据保留 |
| 装配 | `lib/index.js` | 首启自动建「默认项目」并迁移旧 `knowledge/*.md`、绑定现有账号；注册工具；传 library 给适配器/路由 |
| 面板 | `lib/client.js` | **独立侧栏面板「资料库」**（与「客服中心」平级，order 31）：项目列表/新建/改名/删除、绑定/解绑账号、文件树、Markdown 编辑保存、重命名/移动、必读 ★、删除、AI 上下文预览、重建索引 |

验证：`83/83` 测试通过（新增 `test/library.test.mjs` 6 例 + `test/library-routes.test.mjs` 1 例）；
真机：默认项目 + 3 篇旧文档 + 4 个账号已迁移绑定，`cs_library_search` 实际命中。

待办（P2/P3）：面板细化为「每文件标签/重命名拖拽」、图片上传（当前 API 支持存图，UI 未做上传入口）、
项目级 MCP（示例店铺店铺数据服务从抖音适配器迁到项目配置）、向量检索。

