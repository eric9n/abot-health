#!/usr/bin/env python3
"""把 pages/index.html、pages/style.css、pages/app.js 同步为 pages/worker.js 里的嵌入模板字面量。
HTML/CSS 不含反引号，直接嵌入；JS 需要转义 \\、反引号和 ${。
用法：python3 sync-pages.py [--version XXXXXXX]
  --version 会把 index.html 里的 ?v=旧值 替换为 ?v=XXXXXXX（CSS/JS 引用缓存 bust）。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORKER = ROOT / "pages" / "worker.js"


def escape_js(src: str) -> str:
    out = src.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
    # 与历史约定一致：嵌入内容去掉末尾恰好一个换行，块以 \n`; 结尾
    if out.endswith("\n"):
        out = out[:-1]
    return out


def plain(src: str) -> str:
    # HTML/CSS 原样嵌入，同样去掉末尾恰好一个换行
    if src.endswith("\n"):
        src = src[:-1]
    return src


def replace_const(text: str, name: str, value: str) -> str:
    start_marker = "const %s = `" % name
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f"未找到 {start_marker}")
    content_start = start + len(start_marker)
    # 块结束：下一个 "\n`;"（内容里 HTML/CSS 无反引号，JS 已转义，不会误判）
    end = text.find("\n`;", content_start)
    if end < 0:
        raise SystemExit(f"未找到 {name} 块的结束标记")
    return text[:content_start] + value + text[end:]


def main() -> None:
    version = None
    args = sys.argv[1:]
    if "--version" in args:
        version = args[args.index("--version") + 1]

    index_path = ROOT / "pages" / "index.html"
    index_src = index_path.read_text(encoding="utf-8")
    if version:
        index_src = re.sub(r"\?v=[0-9a-fA-F]+", f"?v={version}", index_src)
        index_path.write_text(index_src, encoding="utf-8")

    text = WORKER.read_text(encoding="utf-8")
    text = replace_const(text, "INDEX_HTML", plain((ROOT / "pages" / "index.html").read_text(encoding="utf-8")))
    text = replace_const(text, "STYLE_CSS", plain((ROOT / "pages" / "style.css").read_text(encoding="utf-8")))
    text = replace_const(text, "APP_JS", escape_js((ROOT / "pages" / "app.js").read_text(encoding="utf-8")))
    WORKER.write_text(text, encoding="utf-8")
    print("pages/worker.js 已同步" + (f"（版本 {version}）" if version else ""))


if __name__ == "__main__":
    main()
