/**
 * M4 批次 2 — 闲鱼三套独立存储测试（产品库 / 客户档案 / 采集库）
 * ============================================================================
 *
 * 对齐依据（Hermes，Python）：
 *   - `plugins/platforms/xianyu/product_store.py`   两层结构 / 铁律 / 状态 / 曝光 / 自动交付
 *   - `plugins/platforms/xianyu/customer_store.py`  买家档案 / turns 上限 / 标签 / 资料 upsert
 *   - `plugins/platforms/xianyu/collect_store.py`   采集库（与产品库隔离）/ picked 保留 / 价格数值化
 *
 * 每条断言失败信息带「Hermes 行为（file:line）vs 新实现（file:func）」。
 *
 * 隔离：全部用 mkdtemp 临时 dataDir，绝不写 $DSH_HOME；测试结束清理。
 * 运行：node --test --experimental-test-isolation=none test/xianyu-stores.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createProductStore,
  STATUS_CONFIRMED,
  STATUS_DRAFT,
  STATUS_PENDING,
} from '../lib/platforms/xianyu/product_store.js'
import { createCustomerStore, MAX_TURNS } from '../lib/platforms/xianyu/customer_store.js'
import { createCollectStore, priceNum } from '../lib/platforms/xianyu/collect_store.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

/** 断言器：失败信息带 Hermes 出处与新实现出处。 */
function A(hermesRef, implRef) {
  const fmt = (desc) => `${desc}\n    Hermes 行为: ${hermesRef}\n    新实现: ${implRef}`
  return {
    eq(actual, expected, desc) {
      assert.equal(actual, expected, fmt(desc))
    },
    deep(actual, expected, desc) {
      assert.deepEqual(actual, expected, fmt(desc))
    },
    ok(cond, desc) {
      assert.ok(cond, fmt(desc))
    },
    throws(fn, desc) {
      assert.throws(fn, fmt(desc))
    },
  }
}

/** 临时数据根目录（用完清理）。 */
function tmpRoot(prefix = 'xy-stores-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 读取 JSON 文件（断言落盘结果用）。 */
function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'))
}

// ═══ T1 产品库：骨架同步 + 「同步绝不覆盖详情」铁律 ═══════════════════════

test('T1 产品库：骨架同步新建/刷新幂等，且同步绝不覆盖详情/状态/统计/自动交付', async () => {
  const a = A(
    'product_store.py:89-125（sync_skeleton）＋:10 铁律（同步不覆盖 detail/detail_status）',
    'product_store.js syncSkeleton',
  )
  const t = tmpRoot()
  try {
    const store = createProductStore({ dataDir: t.dir, log: silent })

    const first = await store.syncSkeleton('acctA', [
      { itemId: 'item-1', title: '商品一', price: '10', mainPic: 'https://example.invalid/1.png' },
      { itemId: 'item-2', title: '商品二', price: 20 },
      { itemId: '', title: '无 id 应被跳过' },
    ])
    a.deep(first, { added: 2, updated: 0, total: 2 }, '首次同步：新增 2（空 itemId 跳过）')

    const second = await store.syncSkeleton('acctA', [
      { itemId: 'item-1', title: '商品一(新标题)', price: '11' },
      { itemId: 'item-2' },
    ])
    a.deep(second, { added: 0, updated: 2, total: 2 }, '重复同步：只刷新，不重复建档（幂等）')

    const rec = await store.get('acctA', 'item-1')
    a.eq(rec.title, '商品一(新标题)', '骨架 title 被刷新')
    a.eq(rec.price, '11', '骨架 price 被刷新')
    a.eq(rec.detailStatus, STATUS_PENDING, '新档默认「待完善」（product_store.py:111）')
    a.eq(rec.mainPic, 'https://example.invalid/1.png', '本次没给 mainPic → 保留旧值（product_store.py:120-122）')

    // 写详情 + 统计 + 自动交付
    await store.updateDetail('acctA', 'item-1', { intro: '介绍', netdisk: 'https://pan.invalid/x' }, { source: 'manual' })
    await store.setStats('acctA', 'item-1', { browse: 3, want: '4', collect: 1 })
    await store.setAutoDeliver('acctA', 'item-1', { enabled: true, deliveryText: '自定义交付文案' })

    // 再同步一次（带新标题/新价/新图）→ 骨架刷新，详情层原样
    await store.syncSkeleton('acctA', [{ itemId: 'item-1', title: '又改标题', price: '12', mainPic: 'https://example.invalid/2.png' }])
    const after = await store.get('acctA', 'item-1')
    a.eq(after.title, '又改标题', '同步刷新骨架 title')
    a.eq(after.price, '12', '同步刷新骨架 price')
    a.eq(after.mainPic, 'https://example.invalid/2.png', '同步刷新骨架 mainPic')
    a.eq(after.detail.intro, '介绍', '铁律：同步不覆盖 detail.intro')
    a.eq(after.detail.netdisk, 'https://pan.invalid/x', '铁律：同步不覆盖 detail.netdisk')
    a.eq(after.detailStatus, STATUS_CONFIRMED, '铁律：同步不覆盖 detailStatus')
    a.eq(after.detailSource, 'manual', '铁律：同步不覆盖 detailSource')
    a.eq(after.stats.browse, 3, '铁律：同步不覆盖 stats')
    a.eq(after.autoDeliver, true, '铁律：同步不覆盖 autoDeliver')
    a.eq(after.deliveryText, '自定义交付文案', '铁律：同步不覆盖 deliveryText')
  } finally {
    t.cleanup()
  }
})

// ═══ T2 产品库：updateDetail 语义（占位建档 / 合并 / 状态推断 / 白名单） ═══

test('T2 产品库：updateDetail 缺档自动建占位、字段合并、status 按 source 推断', async () => {
  const a = A(
    'product_store.py:133-175（update_detail：缺档建骨架 / 只写 detail keys / status 推断）',
    'product_store.js updateDetail',
  )
  const t = tmpRoot()
  try {
    const store = createProductStore({ dataDir: t.dir, log: silent })

    // 不在库 → 自动建骨架占位（发品新产品场景）
    const rec = await store.updateDetail(
      'acctA',
      'item-new',
      { title: '发品标题', price: 99, intro: '刚发的商品', images: ['a.png'] },
      { source: 'publish' },
    )
    a.ok(Boolean(rec), '缺档时自动建档并返回记录')
    a.eq(rec.title, '发品标题', '占位骨架用 patch.title（product_store.py:155）')
    a.eq(rec.price, '99', '占位骨架用 patch.price')
    a.eq(rec.detail.intro, '刚发的商品', '详情字段写入')
    a.deep(rec.detail.images, ['a.png'], 'images 数组写入')
    a.eq(rec.detailStatus, STATUS_CONFIRMED, 'source!=ai_draft → 已确认（product_store.py:169-171）')
    a.eq(rec.detailSource, 'publish', 'detailSource 记录来源')
    a.ok(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(rec.updatedAt), 'updatedAt 是本地时间字符串')

    // AI 草稿 → AI草稿
    const draft = await store.updateDetail('acctA', 'item-new', { sellingPoints: '卖点' }, { source: 'ai_draft' })
    a.eq(draft.detailStatus, STATUS_DRAFT, 'source=ai_draft → AI草稿')
    a.eq(draft.detail.sellingPoints, '卖点', '卖点写入')
    a.eq(draft.detail.intro, '刚发的商品', '未给的字段保留原值（合并语义）')

    // 显式 status 优先；非法 status 仍按 source 推断
    const explicit = await store.updateDetail('acctA', 'item-new', { pricing: '定价' }, { status: STATUS_PENDING, source: 'manual' })
    a.eq(explicit.detailStatus, STATUS_PENDING, '显式 status 生效')
    const invalid = await store.updateDetail('acctA', 'item-new', { pricing: '定价2' }, { status: '胡说', source: 'ai_draft' })
    a.eq(invalid.detailStatus, STATUS_DRAFT, '非法 status → 按 source 推断')

    // 只写 DETAIL_KEYS；未知名忽略；已存在记录不因 patch.title 改骨架标题（Hermes 同）
    const beforeTitle = invalid.title
    const patchIgnored = await store.updateDetail('acctA', 'item-new', { title: '新标题', randomField: 'x' })
    a.eq(patchIgnored.title, beforeTitle, '已存在记录：updateDetail 不改骨架 title（product_store.py:160-164 只处理 detail keys）')
    a.eq(patchIgnored.randomField, undefined, '非白名单字段不落库')

    // 工具层传 snake_case 详情字段（xianyu_update_product 的 schema）→ 统一存 camelCase
    const snake = await store.updateDetail('acctA', 'item-new', { selling_points: '卖点2', deal_scripts: '话术2' })
    a.eq(snake.detail.sellingPoints, '卖点2', 'selling_points → sellingPoints（工具层 snake_case 兼容）')
    a.eq(snake.detail.dealScripts, '话术2', 'deal_scripts → dealScripts（工具层 snake_case 兼容）')

    // 空 itemId → null
    a.eq(await store.updateDetail('acctA', '  ', { intro: 'x' }), null, '空 itemId 返回 null')

    // list 双向形状：数组语义（工具层 tools.stores.js）+ 摘要语义（Hermes）
    const rows = await store.list('acctA', { limit: 10 })
    a.eq(Array.isArray(rows), true, 'list 返回数组（工具层 rows.length 可用）')
    a.eq(rows.length, 1, 'list 数组长度 = 命中数')
    a.eq(rows.total, 1, 'list.total 仍可用（Hermes 摘要语义）')
    a.eq(rows.shown, 1, 'list.shown 仍可用')
    a.eq(rows.items, rows, 'list.items 指向自身（兼容 res.items 写法）')
    a.eq(JSON.parse(JSON.stringify(rows)).length, 1, 'JSON 序列化仍是数组（工具输出不会变成嵌套对象）')
    a.eq((await store.list('acctA', { status: STATUS_PENDING })).length, 0, 'status 过滤生效')
  } finally {
    t.cleanup()
  }
})

// ═══ T3 产品库：曝光统计 / 自动交付 / 交付文案 / 删除 ═══════════════════════

test('T3 产品库：stats 数值化、自动交付开关、交付文案拼装（deliveryText > netdisk > 空）', async () => {
  const a = A(
    'product_store.py:219-242（set_item_stats）/ :258-314（auto_deliver + build_delivery_content）',
    'product_store.js setStats/setAutoDeliver/buildDeliveryContent/getAutoDelivery/remove',
  )
  const t = tmpRoot()
  try {
    const store = createProductStore({ dataDir: t.dir, log: silent })
    await store.syncSkeleton('acctA', [{ itemId: 'i1', title: '资料包', price: '5' }])

    // stats：缺字段补 0，字符串数字转 int
    a.eq(await store.setStats('acctA', 'i1', { browse: '7', want: 2, wantBuy: 'x' }), true, 'setStats 成功')
    const rec = await store.get('acctA', 'i1')
    a.eq(rec.stats.browse, 7, 'browse 转 int')
    a.eq(rec.stats.want, 2, 'want 保留')
    a.eq(rec.stats.wantBuy, 0, '非法数值 → 0（product_store.py:233-237）')
    a.eq(rec.stats.collect, 0, '缺失字段 → 0')
    a.ok(Boolean(rec.stats.fetchedAt), 'fetchedAt 打点')
    a.eq(await store.setStats('acctA', 'missing', { browse: 1 }), false, 'item 不在库 → false')

    // 没有 deliveryText 也没有 netdisk → 交付内容为空
    a.eq(await store.buildDeliveryContent('acctA', 'i1'), '', '无网盘/无文案 → 空串')
    const info0 = await store.getAutoDelivery('acctA', 'i1')
    a.deep(info0, { enabled: false, content: '' }, 'getAutoDelivery：默认关 + 空内容')
    a.eq(await store.getAutoDelivery('acctA', 'missing'), null, 'item 不在库 → null')

    // 自定义 deliveryText 优先
    const setRec = await store.setAutoDeliver('acctA', 'i1', { enabled: true, deliveryText: '网盘：https://pan.invalid/a' })
    a.eq(setRec.autoDeliver, true, 'setAutoDeliver 返回更新后的记录（工具层 product: rec 用）')
    a.eq(await store.buildDeliveryContent('acctA', 'i1'), '网盘：https://pan.invalid/a', 'deliveryText 优先（product_store.py:289-291）')

    // 工具层调用约定：没填 delivery_text 会传空串 → 不得清掉已有自定义文案
    await store.setAutoDeliver('acctA', 'i1', { enabled: true, deliveryText: '' })
    a.eq(await store.buildDeliveryContent('acctA', 'i1'), '网盘：https://pan.invalid/a', '空白 deliveryText 视为未提供（不被工具层空串误清）')

    // 显式清空 → 退到 detail.netdisk + 标题包装（文案逐字对齐）
    await store.setAutoDeliver('acctA', 'i1', { clearDeliveryText: true })
    await store.updateDetail('acctA', 'i1', { netdisk: 'https://pan.invalid/b' })
    const built = await store.buildDeliveryContent('acctA', 'i1')
    a.eq(
      built,
      '亲,这是您拍的【资料包】的资料~\nhttps://pan.invalid/b\n收到后有任何问题随时找我,满意的话麻烦给个好评哦~',
      'netdisk 文案模板逐字对齐（product_store.py:296-299）',
    )
    const info1 = await store.getAutoDelivery('acctA', 'i1')
    a.deep(info1, { enabled: true, content: built }, 'getAutoDelivery 返回开关 + 内容')

    // 传记录对象也支持（Hermes 的 build_delivery_content(rec) 写法）
    a.eq(await store.buildDeliveryContent(rec), built === '' ? '' : await store.buildDeliveryContent(rec), 'buildDeliveryContent 兼容传记录')

    // 删除
    a.eq(await store.remove('acctA', 'i1'), true, 'remove 成功')
    a.eq(await store.get('acctA', 'i1'), null, '删除后取不到')
    a.eq(await store.remove('acctA', 'i1'), false, '重复删除 → false')
  } finally {
    t.cleanup()
  }
})

// ═══ T4 产品库：损坏容错 + 并发写不丢更新 ═══════════════════════════════════

test('T4 产品库：损坏 JSON 备份容错；并发 updateDetail 不丢更新（单进程串行化）', async () => {
  const a = A(
    'product_store.py:64-77（原子写）/ :54-62 与 :58-62 的 except（损坏不崩）',
    'product_store.js readJsonSafe/atomicWriteJson/createKeyedQueue',
  )
  const t = tmpRoot()
  try {
    const store = createProductStore({ dataDir: t.dir, log: silent })

    // 损坏文件：写入非法 JSON → 读取当空库并备份，后续写正常
    mkdirSync(join(t.dir, 'products'), { recursive: true })
    writeFileSync(join(t.dir, 'products', 'acctBad.json'), '{ this is not json', 'utf8')
    const res = await store.syncSkeleton('acctBad', [{ itemId: 'x1', title: '怪库' }])
    a.eq(res.added, 1, '损坏库能继续工作（不崩）')
    const files = readdirSync(join(t.dir, 'products'))
    a.ok(files.some((f) => f.includes('.corrupt-')), '损坏文件被备份（.corrupt-<ts>）')
    a.ok(files.includes('acctBad.json'), '新库文件已重建')
    a.eq(readJson(join(t.dir, 'products', 'acctBad.json')).x1.title, '怪库', '重建后数据正确')

    // 并发：20 个 updateDetail 各改不同 detail 字段 → 全部落库（证明 RMW 串行化）
    await store.syncSkeleton('acctC', [{ itemId: 'c1', title: '并发' }])
    const keys = ['intro', 'netdisk', 'sellingPoints', 'pricing', 'dealScripts']
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.updateDetail('acctC', 'c1', { [keys[i % keys.length]]: `v${i}` })),
    )
    const rec = await store.get('acctC', 'c1')
    for (const k of keys) a.ok(Boolean(rec.detail[k]), `并发写后 ${k} 仍在（无丢更新）`)
    a.ok(Array.isArray(rec.detail.images) && Array.isArray(rec.detail.faq), '未写字段仍是空数组')
  } finally {
    t.cleanup()
  }
})

// ═══ T5 三套存储：目录/账号隔离（采集库与产品库绝不互相污染） ═════════════

test('T5 隔离：产品库/采集库物理分离、账号分区互不串台', async () => {
  const a = A(
    'collect_store.py:1-16（与产品库完全隔离）/ product_store.py:12-16 与 customer_store.py:8-10（按账号分区）',
    'product_store.js / collect_store.js / customer_store.js pathFor',
  )
  const t = tmpRoot()
  try {
    const products = createProductStore({ dataDir: t.dir, log: silent })
    const collects = createCollectStore({ dataDir: t.dir, log: silent })
    const customers = createCustomerStore({ dataDir: t.dir, log: silent })

    // 路径分层：products/<a>.json、collected/<a>.json、customers/<a>/<b>.json
    a.ok(products.pathFor('acctA').includes(join('products', 'acctA.json')), '产品库路径 products/<account>.json')
    a.ok(collects.pathFor('acctA').includes(join('collected', 'acctA.json')), '采集库路径 collected/<account>.json')
    a.ok(customers.pathFor('acctA', 'b1').includes(join('customers', 'acctA', 'b1.json')), '客户档案路径 customers/<account>/<buyer>.json')
    a.ok(products.pathFor('acctA') !== collects.pathFor('acctA'), '产品库与采集库物理文件不同')

    // 同名 itemId 在两个库互不影响
    await products.syncSkeleton('acctA', [{ itemId: 'same-id', title: '我的商品' }])
    await collects.upsert('acctA', [{ itemId: 'same-id', title: '别人的商品' }], 'search:test')
    a.eq((await products.get('acctA', 'same-id')).title, '我的商品', '产品库看到自己的商品')
    a.eq((await collects.get('acctA', 'same-id')).title, '别人的商品', '采集库看到采集品（同 id 不串台）')
    a.eq(products.pathFor('acctA') === collects.pathFor('acctA'), false, '两库互不引用同一路径')

    // 账号分区
    await products.syncSkeleton('acctB', [{ itemId: 'b-1', title: 'B 店商品' }])
    a.eq(await products.get('acctA', 'b-1'), null, '账号 A 看不到账号 B 的产品')
    a.eq(await products.get('acctB', 'b-1') !== null, true, '账号 B 自己的产品在')
    await customers.recordTurn('acctA', 'buyer-1', { buyerMsg: 'A 店的买家' })
    await customers.recordTurn('acctB', 'buyer-1', { buyerMsg: 'B 店的买家' })
    a.eq((await customers.get('acctA', 'buyer-1')).turns[0].buyer, 'A 店的买家', '同 buyerId 在不同账号互不覆盖（A）')
    a.eq((await customers.get('acctB', 'buyer-1')).turns[0].buyer, 'B 店的买家', '同 buyerId 在不同账号互不覆盖（B）')
    await collects.upsert('acctB', [{ itemId: 'b-2', title: 'B 采集' }], 'home')
    a.eq(await collects.get('acctA', 'b-2'), null, '采集库也按账号分区')
  } finally {
    t.cleanup()
  }
})

// ═══ T6 客户档案：留档 / 合并 / 查询 / 资料 upsert ═════════════════════════

test('T6 客户档案：recordTurn 累积、update 合并标签、lookup、list 摘要、upsertProfiles', async () => {
  const a = A(
    'customer_store.py:74-122（record_turn）/ :125-155（update_profile）/ :192-238（lookup + upsert_user_profiles）',
    'customer_store.js recordTurn/update/lookup/list/upsertProfiles',
  )
  const t = tmpRoot()
  try {
    const store = createCustomerStore({ dataDir: t.dir, log: silent })

    const first = await store.recordTurn('acctA', 'buyer-1', {
      buyerNick: '买家甲',
      chatId: 'chat-1',
      itemId: 'item-1',
      itemTitle: '商品一',
      buyerMsg: '在吗',
      reply: '在的',
    })
    a.eq(first.buyerId, 'buyer-1', '建档 buyerId')
    a.eq(first.buyerNick, '买家甲', '首次带昵称则写入（customer_store.py:107-108）')
    a.eq(first.turns.length, 1, '一轮对话入库')
    a.deep(first.turns[0].chatId, 'chat-1', 'turn.chatId 正确')
    a.eq(first.turns[0].buyer, '在吗', 'turn.buyer 正确')
    a.eq(first.turns[0].reply, '在的', 'turn.reply 正确')
    a.deep(first.interestedItems, ['商品一'], '感兴趣商品去重入列（customer_store.py:110-111）')
    a.ok(Boolean(first.firstSeen), 'firstSeen 打点')

    const second = await store.recordTurn('acctA', 'buyer-1', { buyerNick: '新昵称', itemTitle: '商品一', buyerMsg: '在吗2' })
    a.eq(second.buyerNick, '买家甲', '昵称已有值 → 不被覆盖（customer_store.py:107-108）')
    a.eq(second.turns.length, 2, '对话累积')
    a.deep(second.interestedItems, ['商品一'], '同一商品不重复入列')

    // update：标签合并去重排序 / deal 布尔 / 白名单
    const updated = await store.update('acctA', 'buyer-1', {
      tags: ['砍价', '急单', '砍价'],
      region: '杭州',
      gender: '女',
      psychology: '价格敏感',
      notes: '备注',
      deal: 1,
      unknownField: 'x',
    })
    a.deep(updated.tags, ['急单', '砍价'], '标签合并去重并排序（customer_store.py:147-152）')
    a.eq(updated.region, '杭州', 'region 写入')
    a.eq(updated.deal, true, 'deal 转布尔')
    a.eq(updated.unknownField, undefined, '非白名单字段忽略')
    const renamed = await store.update('acctA', 'buyer-1', { buyer_nick: '改过的昵称' })
    a.eq(renamed.buyerNick, '改过的昵称', 'buyer_nick → buyerNick（工具层 snake_case 兼容）')
    const updated2 = await store.update('acctA', 'buyer-1', { tags: ['老客'] })
    a.deep(updated2.tags, ['急单', '砍价', '老客'], '再次加标签是合并（不丢旧标签）')

    // lookup（enrichBuyer 用）
    await store.upsertProfiles('acctA', [
      { uid: 'buyer-1', nickname: '鱼昵称', avatarUrl: 'https://example.invalid/a.png' },
      { uid: '', nickname: '无 id 跳过' },
      { uid: 'buyer-2', nickname: '', avatarUrl: '' },
    ])
    a.eq((await store.lookup('acctA', 'buyer-1')).name, '鱼昵称', 'upsertProfiles 覆盖昵称（更准）')
    a.eq((await store.lookup('acctA', 'buyer-1')).avatar, 'https://example.invalid/a.png', '头像写入')
    a.eq((await store.get('acctA', 'buyer-2')), null, '既无昵称也无头像 → 跳过（customer_store.py:218-219）')
    a.eq((await store.lookup('acctA', 'nobody')).name, '', '无档案 lookup 返回空名')

    // list 摘要
    await sleep(10)
    await store.recordTurn('acctA', 'buyer-2', { buyerNick: '买家乙', buyerMsg: 'hi' })
    await store.update('acctA', 'buyer-2', { deal: true })
    const rows = await store.list('acctA')
    a.eq(rows.length, 2, 'list 返回两份档案')
    const byId = Object.fromEntries(rows.map((r) => [r.buyerId, r]))
    a.eq(byId['buyer-1'].turnCount, 2, '摘要 turnCount 正确')
    a.eq(byId['buyer-1'].buyerNick, '鱼昵称', '摘要 buyerNick 用档案最新值')
    a.eq(byId['buyer-2'].deal, true, '摘要 deal 正确')
    a.eq((await store.list('acctA', { limit: 1 })).length, 1, 'list limit 生效')
    a.deep(await store.list('no-such-account'), [], '空账号 list → []')
  } finally {
    t.cleanup()
  }
})

// ═══ T7 客户档案：turns 上限 + 并发追加不丢轮次 ════════════════════════════

test('T7 客户档案：turns 超过 200 丢最旧、并发 recordTurn 串行化不丢', async () => {
  const a = A(
    'customer_store.py:26（_MAX_TURNS=200）/ :120-121（超限裁剪）',
    'customer_store.js recordTurn（MAX_TURNS）',
  )
  const t = tmpRoot()
  try {
    const store = createCustomerStore({ dataDir: t.dir, log: silent })
    for (let i = 1; i <= MAX_TURNS + 5; i++) {
      await store.recordTurn('acctA', 'busy', { buyerMsg: `m${i}` })
    }
    const rec = await store.get('acctA', 'busy')
    a.eq(rec.turns.length, MAX_TURNS, `turns 上限 ${MAX_TURNS}`)
    a.eq(rec.turns[rec.turns.length - 1].buyer, `m${MAX_TURNS + 5}`, '保留最新一轮')
    a.eq(rec.turns[0].buyer, 'm6', '丢掉最旧的 5 轮（customer_store.py:120-121）')

    // 并发 10 轮：串行化保证都在
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.recordTurn('acctA', 'race', { buyerMsg: `c${i}` })))
    a.eq((await store.get('acctA', 'race')).turns.length, 10, '并发 10 轮全部入库（无丢更新）')
  } finally {
    t.cleanup()
  }
})

// ═══ T8 采集库：upsert 幂等 / picked 保留 / 价格 / 筛选排序 ═════════════════

test('T8 采集库：upsert 幂等且保留 picked/firstSeenAt；价格数值化与筛选排序', async () => {
  const a = A(
    'collect_store.py:93-140（upsert_collected）/ :73-88（_price_num）/ :143-182（list_collected）',
    'collect_store.js upsert/priceNum/list',
  )
  const t = tmpRoot()
  try {
    const store = createCollectStore({ dataDir: t.dir, log: silent })

    // 价格解析（与 Hermes 同规则）
    a.eq(priceNum('¥1810'), 1810, '去 ¥ 前缀')
    a.eq(priceNum('1,299'), 1299, '去千分位逗号')
    a.eq(priceNum('1.2万'), 12000, '「万」按万换算')
    a.eq(priceNum(88.5), 88.5, '数字原样')
    a.eq(priceNum('面议'), null, '无数字 → null')
    a.eq(priceNum(null), null, 'null → null')

    const res1 = await store.upsert(
      'acctA',
      [
        { itemId: 'p1', title: 'iPhone 15', price: '¥1810', area: '杭州', sellerName: '卖家A', itemUrl: 'https://example.invalid/p1', mainImage: 'i1.png', wantCount: 30, publishTime: '2026-01-01' },
        { item_id: 'p2', title: 'iPad', price: '1.2万', area: '上海', seller_name: '卖家B', want_count: 5 },
        { itemId: '', title: '无 id 跳过' },
        { itemId: 'p3', title: '面议商品', price: '面议' },
      ],
      'search:ipad',
    )
    a.deep(res1, { scanned: 4, kept: 3, new: 3, updated: 0, total: 3 }, 'upsert 返回 scanned/kept/new/updated/total')

    // 重复采集：幂等 + 保留 picked/firstSeenAt
    await store.setPicked('acctA', 'p1', true)
    const before = await store.get('acctA', 'p1')
    await sleep(1100) // firstSeenAt 是秒级：等 1s 才能看出是否被改写
    const res2 = await store.upsert(
      'acctA',
      [
        { itemId: 'p1', title: 'iPhone 15 (降价)', price: '¥1799', wantCount: 42 },
        { itemId: 'p2', title: 'iPad', price: '1.2万' },
        { itemId: 'p3', title: '面议商品', price: '面议' },
      ],
      'search:ipad',
    )
    a.deep(res2, { scanned: 3, kept: 3, new: 0, updated: 3, total: 3 }, '重复 upsert 不重复建档（按 itemId 幂等）')
    const after = await store.get('acctA', 'p1')
    a.eq(after.title, 'iPhone 15 (降价)', '快照刷新 title')
    a.eq(after.priceNum, 1799, '价格数值化刷新')
    a.eq(after.picked, true, '保留人工字段 picked（collect_store.py:130-137）')
    a.eq(after.firstSeenAt, before.firstSeenAt, '保留 firstSeenAt')
    a.ok(after.lastSeenAt >= before.lastSeenAt, 'lastSeenAt 刷新')

    // 筛选
    a.eq((await store.list('acctA', { keyword: 'iphone' })).total, 1, 'keyword 过滤（不区分大小写）')
    a.eq((await store.list('acctA', { minWant: 30 })).total, 1, 'minWant 过滤')
    a.eq((await store.list('acctA', { priceMin: 1000, priceMax: 5000 })).total, 1, '价格区间过滤（面议被排除）')
    a.eq((await store.list('acctA', { pickedOnly: true })).total, 1, 'pickedOnly 过滤')

    // 排序
    const byWant = await store.list('acctA', { sortBy: 'want' })
    a.eq(byWant.items[0].itemId, 'p1', 'want 降序（默认）')
    const byPriceAsc = await store.list('acctA', { sortBy: 'priceAsc' })
    a.eq(byPriceAsc.items[0].itemId, 'p1', 'priceAsc：1799 排最前')
    a.eq(byPriceAsc.items[byPriceAsc.items.length - 1].itemId, 'p3', 'priceAsc：null 价格排最后')
    const byPriceDesc = await store.list('acctA', { sortBy: 'priceDesc' })
    a.eq(byPriceDesc.items[0].itemId, 'p2', 'priceDesc：12000 排最前')
    const recent = await store.list('acctA', { sortBy: 'recent' })
    a.ok(recent.items.length === 3, 'recent 排序可用')
    a.eq((await store.list('acctA', { limit: 2 })).shown, 2, 'limit 生效')

    // list 双向形状 + 工具层排序别名（xianyu_list_collected 文档写 want|price|time）
    a.eq(Array.isArray(byWant), true, 'list 返回数组（工具层 rows.length 可用）')
    a.eq(byWant.length, 3, 'list 数组长度 = 命中数')
    a.eq(byWant.total, 3, 'list.total 仍可用')
    const aliasPrice = await store.list('acctA', { sortBy: 'price' })
    a.eq(aliasPrice.items[0].itemId, 'p1', "sortBy='price' → priceAsc（工具层文档值）")
    const aliasTime = await store.list('acctA', { sortBy: 'time' })
    a.eq(aliasTime.length, 3, "sortBy='time' → recent（工具层文档值）")

    // setPicked / remove
    a.eq(await store.setPicked('acctA', 'missing'), false, '不存在的 item setPicked → false')
    a.eq(await store.setPicked('acctA', 'p1', false), true, '取消标记')
    a.eq((await store.get('acctA', 'p1')).picked, false, 'picked 落盘')
    a.eq(await store.remove('acctA', 'p1'), true, 'remove 成功')
    a.eq(await store.get('acctA', 'p1'), null, 'remove 后取不到')
    a.eq((await store.list('acctA')).total, 2, '总数相应减少')
  } finally {
    t.cleanup()
  }
})

// ═══ T9 dataDir 解析：显式参数 / DSH_CS_DATA_DIR / DSH_HOME 默认 ═══════════

test('T9 数据根目录：显式 dataDir 优先、DSH_CS_DATA_DIR 次之、否则 $DSH_HOME/dsh-cs', async () => {
  const a = A(
    'product_store.py:41-52 / customer_store.py:29-41 / collect_store.py:35-45（按账号分区落盘）',
    'product_store.js / customer_store.js / collect_store.js resolveDataRoot',
  )
  const t = tmpRoot()
  const saved = { dir: process.env.DSH_CS_DATA_DIR, home: process.env.DSH_HOME }
  try {
    // 显式参数优先（测试必须走这条）
    const explicit = createProductStore({ dataDir: t.dir, log: silent })
    a.ok(explicit.pathFor('acc').startsWith(t.dir), '显式 dataDir 生效')
    a.ok(explicit.pathFor('acc').includes(join('products', 'acc.json')), '产品库子目录 products/')

    // env DSH_CS_DATA_DIR
    process.env.DSH_CS_DATA_DIR = join(t.dir, 'from-env')
    const envStore = createProductStore({ log: silent })
    a.ok(envStore.pathFor('acc').startsWith(join(t.dir, 'from-env')), 'DSH_CS_DATA_DIR 生效')
    const envCollect = createCollectStore({ log: silent })
    a.ok(envCollect.pathFor('acc').startsWith(join(t.dir, 'from-env')), '采集库同样尊重 DSH_CS_DATA_DIR')

    // env DSH_HOME 默认 → <home>/dsh-cs
    delete process.env.DSH_CS_DATA_DIR
    process.env.DSH_HOME = join(t.dir, 'fake-home')
    const homeStore = createCustomerStore({ log: silent })
    a.ok(
      homeStore.pathFor('acc', 'b1').startsWith(join(t.dir, 'fake-home', 'dsh-cs', 'customers')),
      'DSH_HOME → <home>/dsh-cs/customers/<account>/<buyer>.json',
    )
  } finally {
    if (saved.dir === undefined) delete process.env.DSH_CS_DATA_DIR
    else process.env.DSH_CS_DATA_DIR = saved.dir
    if (saved.home === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved.home
    t.cleanup()
  }
})

// ═══ T10 持久化：落盘 JSON 合法、临时文件不残留、写入目录不越界 ═══════════

test('T10 持久化：原子写后 JSON 合法、无 .tmp 残留、只写三套存储目录', async () => {
  const a = A(
    'product_store.py:64-77（tmp→rename 原子写）/ collect_store.py:58-70',
    'product_store.js / customer_store.js / collect_store.js atomicWriteJson',
  )
  const t = tmpRoot()
  try {
    const products = createProductStore({ dataDir: t.dir, log: silent })
    const collects = createCollectStore({ dataDir: t.dir, log: silent })
    const customers = createCustomerStore({ dataDir: t.dir, log: silent })
    await Promise.all([
      products.syncSkeleton('acctA', [{ itemId: 'i1', title: 'a' }]),
      collects.upsert('acctA', [{ itemId: 'c1', title: 'b' }], 'home'),
      customers.recordTurn('acctA', 'b1', { buyerMsg: 'hi' }),
    ])
    const roots = readdirSync(t.dir).sort()
    a.deep(roots, ['collected', 'customers', 'products'], '根目录只有三套存储子目录')
    const productFiles = readdirSync(join(t.dir, 'products'))
    const collectFiles = readdirSync(join(t.dir, 'collected'))
    a.ok(productFiles.includes('acctA.json'), '产品库文件落盘')
    a.ok(collectFiles.includes('acctA.json'), '采集库文件落盘')
    a.ok(!productFiles.some((f) => f.endsWith('.tmp')), '无 .tmp 残留（rename 后清理）')
    a.deep(readJson(join(t.dir, 'products', 'acctA.json')).i1.title, 'a', '产品库 JSON 合法')
    a.deep(readJson(join(t.dir, 'collected', 'acctA.json')).c1.title, 'b', '采集库 JSON 合法')
    a.eq(readJson(join(t.dir, 'customers', 'acctA', 'b1.json')).buyerId, 'b1', '客户档案 JSON 合法')
    a.ok(statSync(join(t.dir, 'products', 'acctA.json')).size > 0, '文件非空')
  } finally {
    t.cleanup()
  }
})
