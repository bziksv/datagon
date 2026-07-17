#!/usr/bin/env python3
"""ODT from rules/ → public/legal/*.html"""
import html, re, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
TEXT_NS = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
OFFICE_NS = "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}"
TABLE_NS = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"

PAGES = [
    ("politics-p.datagon.odt", "privacy.html", "Политика обработки персональных данных"),
    ("cookies-p.datagon.odt", "cookies.html", "Политика использования cookie-файлов"),
    ("rules-recommendation-p.datagon.odt", "recommendation.html", "Правила применения рекомендательных технологий"),
]

TEMPLATE = """<!DOCTYPE html>
<html lang=\"ru\">
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>{title} — Датагон</title>
  <link rel=\"icon\" type=\"image/svg+xml\" href=\"/favicon.svg\" />
  <style>
    :root {{ --dg-ink:#0f172a; --dg-muted:#64748b; --dg-line:#e2e8f0; --dg-accent:#2f5de0; }}
    * {{ box-sizing: border-box; }}
    body {{ margin:0; font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,\"Helvetica Neue\",Arial,sans-serif;
      color:var(--dg-ink); background:#f8fafc; line-height:1.55; }}
    .dg-legal-shell {{ max-width: 860px; margin: 0 auto; padding: 28px 18px 64px; }}
    .dg-legal-top {{ display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between;
      margin-bottom: 20px; padding-bottom: 14px; border-bottom: 1px solid var(--dg-line); }}
    .dg-legal-brand {{ font-weight:600; color:var(--dg-accent); text-decoration:none; }}
    .dg-legal-nav {{ display:flex; flex-wrap:wrap; gap:10px 14px; font-size:13px; }}
    .dg-legal-nav a {{ color:var(--dg-muted); text-decoration:none; }}
    .dg-legal-nav a:hover, .dg-legal-nav a.is-active {{ color:var(--dg-accent); }}
    h1 {{ font-size:1.55rem; margin:0 0 1rem; }}
    h2 {{ font-size:1.15rem; margin:1.5rem 0 .6rem; }}
    h3,h4 {{ font-size:1.05rem; margin:1.2rem 0 .5rem; }}
    p {{ margin:0 0 .75rem; }}
    ul {{ margin:0 0 1rem; padding-left:1.25rem; }}
    li {{ margin:0 0 .35rem; }}
    .dg-legal-table-wrap {{ overflow-x:auto; margin: 1rem 0; }}
    table {{ width:100%; background:#fff; border-collapse:collapse; font-size:13px; }}
    td, th {{ border:1px solid var(--dg-line); padding:8px 10px; vertical-align:top; }}
    .dg-legal-foot {{ margin-top:2rem; padding-top:1rem; border-top:1px solid var(--dg-line);
      font-size:13px; color:var(--dg-muted); }}
  </style>
</head>
<body>
  <div class=\"dg-legal-shell\">
    <div class=\"dg-legal-top\">
      <a class=\"dg-legal-brand\" href=\"/login.html\">Датагон</a>
      <nav class=\"dg-legal-nav\" aria-label=\"Юридические документы\">
        <a href=\"/legal/privacy.html\"{a_privacy}>Политика персональных данных</a>
        <a href=\"/legal/cookies.html\"{a_cookies}>Cookie</a>
        <a href=\"/legal/recommendation.html\"{a_reco}>Рекомендательные технологии</a>
      </nav>
    </div>
    <h1>{title}</h1>
    <article class=\"dg-legal-body\">
{body}
    </article>
    <div class=\"dg-legal-foot\">© Датагон · <a href=\"/login.html\">Вход</a></div>
  </div>
</body>
</html>
"""


def text_of(el):
    parts = []
    if el.text:
        parts.append(el.text)
    for child in el:
        tag = child.tag
        if tag == TEXT_NS + "line-break":
            parts.append("\n")
        elif tag == TEXT_NS + "s":
            n = int(child.attrib.get(TEXT_NS + "c", child.attrib.get("text:c", "1")) or "1")
            parts.append(" " * n)
        elif tag == TEXT_NS + "tab":
            parts.append("\t")
        else:
            parts.append(text_of(child))
        if child.tail:
            parts.append(child.tail)
    return "".join(parts)


def render_list(el, chunks):
    chunks.append("<ul>")
    for item in el.findall(TEXT_NS + "list-item"):
        texts = []
        for p in item.findall(TEXT_NS + "p"):
            tt = re.sub(r"\s+", " ", text_of(p)).strip()
            if tt:
                texts.append(html.escape(tt))
        chunks.append("<li>" + ("<br>".join(texts) if texts else ""))
        for sub in item:
            if sub.tag == TEXT_NS + "list":
                render_list(sub, chunks)
        chunks.append("</li>")
    chunks.append("</ul>")


def odt_to_html_body(path):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("content.xml"))
    body = root.find(f".//{OFFICE_NS}text")
    chunks = []
    if body is None:
        return ""
    for el in list(body):
        if el.tag == TEXT_NS + "h":
            level = el.attrib.get(TEXT_NS + "outline-level", "2")
            try:
                level = int(level)
            except Exception:
                level = 2
            level = max(1, min(level, 4))
            t = re.sub(r"\s+", " ", text_of(el)).strip()
            if t:
                chunks.append(f"<h{level}>{html.escape(t)}</h{level}>")
        elif el.tag == TEXT_NS + "p":
            t = text_of(el)
            t = re.sub(r"[ \t\xa0]+", " ", t).strip()
            if t:
                chunks.append(f"<p>{html.escape(t)}</p>")
        elif el.tag == TEXT_NS + "list":
            render_list(el, chunks)
        elif el.tag == TABLE_NS + "table":
            chunks.append('<div class="dg-legal-table-wrap"><table>')
            for row in el.findall(TABLE_NS + "table-row"):
                chunks.append("<tr>")
                for cell in row:
                    if TABLE_NS + "table-cell" not in cell.tag:
                        continue
                    cell_bits = []
                    for p in cell.findall(TEXT_NS + "p"):
                        tt = re.sub(r"\s+", " ", text_of(p)).strip()
                        if tt:
                            cell_bits.append(html.escape(tt))
                    chunks.append("<td>" + "<br>".join(cell_bits) + "</td>")
                chunks.append("</tr>")
            chunks.append("</table></div>")
    return "\n".join(chunks)


def main():
    out_dir = ROOT / "public" / "legal"
    out_dir.mkdir(parents=True, exist_ok=True)
    src_dir = ROOT / "rules"
    for odt, fname, title in PAGES:
        body = odt_to_html_body(src_dir / odt)
        body = re.sub(r"<li>\s*</li>", "", body)
        flags = {
            "a_privacy": ' class="is-active"' if fname == "privacy.html" else "",
            "a_cookies": ' class="is-active"' if fname == "cookies.html" else "",
            "a_reco": ' class="is-active"' if fname == "recommendation.html" else "",
        }
        html_out = TEMPLATE.format(title=html.escape(title), body=body, **flags)
        (out_dir / fname).write_text(html_out, encoding="utf-8")
        print("wrote", fname, len(html_out))


if __name__ == "__main__":
    main()
