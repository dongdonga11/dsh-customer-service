#!/usr/bin/env python3
"""产品 Excel 导入器（抖音来客商品明细 → 资料库「产品/产品表.md」）。

用法（在 dsh-cs 目录下）：
  <python> scripts/import_products.py "D:\\下载\\商品明细_xxx.xlsx" \
      --project-dir "$DSH_HOME/dsh-cs/library/projects/default/files"

规则：
- 原 xlsx 复制到 `产品/源文件/` 保留（源文件即备份，可追溯）；
- 生成 `产品/产品表.md`：顶部价格速查表 + 每个商品一节（便于检索命中）；
- **敏感/内部列不进 md**：商促价、商家平台券ID、商品归属户、归属户名称（成本/内部口径）；
- 只做展示文案，不改任何线上价格；价格口径以平台为准。
"""
import argparse
import shutil
import sys
from datetime import datetime
from pathlib import Path

try:
    import openpyxl
except ImportError:
    sys.exit("需要 openpyxl：请用 DSH 自带 python 运行")


def cell(v):
    return "" if v is None else str(v).strip()


def md_escape(s: str) -> str:
    return s.replace("|", "\\|").replace("\n", " ")


def pick(row, headers, name, default=""):
    """按表头名取值；找不到则空。"""
    try:
        i = headers.index(name)
    except ValueError:
        return default
    if i >= len(row):
        return default
    return cell(row[i])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--project-dir", required=True, help="项目 files 目录（$DSH_HOME/dsh-cs/library/projects/<id>/files）")
    ap.add_argument("--sheet", default="")
    args = ap.parse_args()

    src = Path(args.xlsx)
    if not src.is_file():
        sys.exit(f"找不到 Excel：{src}")
    proj = Path(args.project_dir)
    if not proj.is_dir():
        sys.exit(f"项目目录不存在：{proj}")

    wb = openpyxl.load_workbook(src, data_only=True)
    ws = wb[args.sheet] if args.sheet else wb.worksheets[0]
    rows = [[cell(c) for c in r] for r in ws.iter_rows(values_only=True)]
    if not rows:
        sys.exit("Excel 是空的")
    headers, data = rows[0], rows[1:]

    name_col = "商品名称"
    products = []
    for r in data:
        name = pick(r, headers, name_col)
        if not name:
            continue
        products.append(
            {
                "name": name,
                "price": pick(r, headers, "售价"),
                "original": pick(r, headers, "商品总价（商品划线价）"),
                "type": pick(r, headers, "商品类型"),
                "coupon_type": pick(r, headers, "券码类型"),
                "status": pick(r, headers, "商品状态"),
                "channel": pick(r, headers, "投放渠道"),
                "usable": pick(r, headers, "可用日期"),
                "unusable": pick(r, headers, "不可用日期"),
                "daily": pick(r, headers, "每日可用时段"),
                "sold": pick(r, headers, "已售券数/库存"),
                "item_id": pick(r, headers, "商品ID"),
                "stores": pick(r, headers, "适用门店数"),
            }
        )
    if not products:
        sys.exit("没有读到商品行（检查表头是否有「商品名称」）")

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        "# 产品表（抖音来客）",
        "",
        f"> 来源：`{src.name}`（导入于 {now}，共 {len(products)} 个商品）",
        "> 用途：买家问「有什么团购 / 多少钱 / 含什么 / 哪天不能用」时查这里。",
        "> 口径：价格以平台展示「售价」为准；**商促价、平台券 ID、归属户 ID 属内部信息，不对外**。",
        "",
        "## 价格速查（先看这里）",
        "",
        "| 商品 | 售价 | 划线价 | 类型 | 不可用日期（要点） |",
        "|---|---|---|---|---|",
    ]
    for p in products:
        unusable = p["unusable"] or "无"
        lines.append(
            f"| {md_escape(p['name'])} | {p['price'] or '—'} | {p['original'] or '—'} | {p['type'] or '—'} | {md_escape(unusable)} |"
        )

    lines += ["", "## 商品详情", ""]
    for p in products:
        lines += [f"### {p['name']}", ""]
        if p["price"] or p["original"]:
            lines.append(f"- 售价：{p['price'] or '—'}（划线价 {p['original'] or '—'}）")
        meta = []
        if p["type"]:
            meta.append(f"类型 {p['type']}")
        if p["coupon_type"]:
            meta.append(p["coupon_type"])
        if p["status"]:
            meta.append(f"状态 {p['status']}")
        if p["channel"]:
            meta.append(f"渠道 {p['channel']}")
        if meta:
            lines.append("- " + "｜".join(meta))
        if p["usable"]:
            lines.append(f"- 可用日期：{p['usable']}")
        if p["unusable"]:
            lines.append(f"- 不可用日期：{p['unusable']}")
        if p["daily"]:
            lines.append(f"- 每日可用时段：{p['daily']}")
        if p["sold"]:
            lines.append(f"- 库存/已售：{p['sold']}")
        if p["item_id"]:
            lines.append(f"- 商品ID：{p['item_id']}（内部核对用）")
        lines.append("")

    outdir = proj / "产品"
    srcdir = outdir / "源文件"
    srcdir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, srcdir / src.name)
    out = outdir / "产品表.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"已生成：{out}（{len(products)} 个商品，{out.stat().st_size} 字节）")
    print(f"源文件已保留：{srcdir / src.name}")


if __name__ == "__main__":
    main()
