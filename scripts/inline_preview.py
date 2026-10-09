"""Inline the demo build (CSS + JS) into one self-contained HTML page.

    python3 scripts/inline_preview.py build/preview/dist build/preview/aeroguard-preview.html

The output has no external requests: one <style>, one module <script>, the root div.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path


def main() -> int:
    dist, out = Path(sys.argv[1]), Path(sys.argv[2])
    html = (dist / "index.html").read_text()
    css = "".join((dist / p.lstrip("/")).read_text() for p in re.findall(r'<link rel="stylesheet"[^>]*href="([^"]+)"', html))
    js = "".join((dist / p.lstrip("/")).read_text() for p in re.findall(r'<script type="module"[^>]*src="([^"]+)"', html))
    # Keep the HTML parser from ending or mis-reading the inline blocks.
    js = js.replace("</script", "<\\/script").replace("<!--", "<\\!--")
    css = css.replace("</style", "<\\/style")
    page = (
        "<title>AEROGUARD</title>\n"
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
        f"<style>\n{css}\n</style>\n"
        '<div id="root"></div>\n'
        f'<script type="module">\n{js}\n</script>\n'
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page)
    print(f"{out}: {len(page.encode()) / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
