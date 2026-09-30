import html
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, Preformatted, SimpleDocTemplate, Spacer, Table, TableStyle

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "ARCHITECTURE_BLUEPRINT.md"
OUTPUT = ROOT / "ARCHITECTURE_BLUEPRINT.pdf"
INK = colors.HexColor("#18323A")
TEAL = colors.HexColor("#147D78")
MUTED = colors.HexColor("#5B6C70")
PALE = colors.HexColor("#EAF2F0")
GRID = colors.HexColor("#C9D7D4")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="CoverTitle", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=25, leading=30, textColor=INK, alignment=1, spaceAfter=12))
styles.add(ParagraphStyle(name="CoverMeta", parent=styles["Normal"], fontSize=9, leading=13, textColor=MUTED, alignment=1, spaceAfter=18))
styles.add(ParagraphStyle(name="Section", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=16, leading=20, textColor=INK, spaceBefore=13, spaceAfter=7, keepWithNext=True))
styles.add(ParagraphStyle(name="Subsection", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=11.5, leading=15, textColor=TEAL, spaceBefore=9, spaceAfter=5, keepWithNext=True))
styles.add(ParagraphStyle(name="BodyTight", parent=styles["BodyText"], fontName="Helvetica", fontSize=9, leading=13, textColor=INK, spaceAfter=6))
styles.add(ParagraphStyle(name="ListTight", parent=styles["BodyTight"], leftIndent=12, firstLineIndent=-9, spaceAfter=3))
styles.add(ParagraphStyle(name="CodeBlock", parent=styles["Code"], fontName="Courier", fontSize=7, leading=9, textColor=INK, backColor=PALE, borderColor=GRID, borderWidth=0.5, borderPadding=7, leftIndent=5, rightIndent=5, spaceBefore=4, spaceAfter=8))
styles.add(ParagraphStyle(name="TableCell", parent=styles["BodyTight"], fontSize=7.5, leading=10, spaceAfter=0))
styles.add(ParagraphStyle(name="TableHeader", parent=styles["TableCell"], fontName="Helvetica-Bold", textColor=colors.white))


def inline_markup(text):
    text = html.escape(text, quote=False)
    text = re.sub(r"`([^`]+)`", r'<font name="Courier">\1</font>', text)
    return re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)


def table_cells(line):
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def page_chrome(canvas, document):
    canvas.saveState()
    width, _ = A4
    canvas.setStrokeColor(GRID)
    canvas.setLineWidth(0.5)
    canvas.line(18 * mm, 15 * mm, width - 18 * mm, 15 * mm)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 10 * mm, "Decentralized Trade Data Exchange | Architecture Blueprint v0.2")
    canvas.drawRightString(width - 18 * mm, 10 * mm, str(document.page))
    canvas.restoreState()


def build_story(lines):
    story = []
    paragraph_lines = []
    code_lines = []
    in_code = False
    index = 0
    title_done = False

    def flush_paragraph():
        if paragraph_lines:
            text = " ".join(part.strip() for part in paragraph_lines)
            story.append(Paragraph(inline_markup(text), styles["BodyTight"]))
            paragraph_lines.clear()

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if stripped.startswith("```"):
            flush_paragraph()
            if in_code:
                story.append(Preformatted("\n".join(code_lines), styles["CodeBlock"]))
                code_lines.clear()
                in_code = False
            else:
                in_code = True
            index += 1
            continue
        if in_code:
            code_lines.append(line.rstrip())
            index += 1
            continue
        if stripped.startswith("|") and index + 1 < len(lines) and re.match(r"\s*\|?\s*:?-{3,}", lines[index + 1]):
            flush_paragraph()
            raw_rows = [table_cells(line)]
            index += 2
            while index < len(lines) and lines[index].strip().startswith("|"):
                raw_rows.append(table_cells(lines[index]))
                index += 1
            rows = [[Paragraph(inline_markup(cell), styles["TableHeader"]) for cell in raw_rows[0]]]
            rows.extend([[Paragraph(inline_markup(cell), styles["TableCell"]) for cell in row] for row in raw_rows[1:]])
            table = Table(rows, repeatRows=1, hAlign="LEFT")
            table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), TEAL),
                ("GRID", (0, 0), (-1, -1), 0.4, GRID),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PALE]),
            ]))
            story.extend([table, Spacer(1, 7)])
            continue
        if stripped.startswith("# "):
            flush_paragraph()
            if not title_done:
                story.extend([Spacer(1, 18 * mm), Paragraph(inline_markup(stripped[2:]), styles["CoverTitle"])])
                title_done = True
            else:
                story.append(Paragraph(inline_markup(stripped[2:]), styles["Section"]))
        elif stripped.startswith("## "):
            flush_paragraph()
            story.append(Paragraph(inline_markup(stripped[3:]), styles["Section"]))
        elif stripped.startswith("### "):
            flush_paragraph()
            story.append(Paragraph(inline_markup(stripped[4:]), styles["Subsection"]))
        elif stripped.startswith("**") and "**" in stripped[2:]:
            flush_paragraph()
            story.append(Paragraph(inline_markup(stripped), styles["CoverMeta"]))
        elif re.match(r"^[-*] ", stripped):
            flush_paragraph()
            story.append(Paragraph(inline_markup(stripped[2:]), styles["ListTight"], bulletText="-"))
        elif re.match(r"^\d+\. ", stripped):
            flush_paragraph()
            marker, text = stripped.split(" ", 1)
            story.append(Paragraph(inline_markup(text), styles["ListTight"], bulletText=marker))
        elif not stripped:
            flush_paragraph()
        else:
            paragraph_lines.append(stripped)
        index += 1

    flush_paragraph()
    if code_lines:
        story.append(Preformatted("\n".join(code_lines), styles["CodeBlock"]))
    return story


def main():
    lines = SOURCE.read_text(encoding="utf-8").splitlines()
    document = SimpleDocTemplate(
        str(OUTPUT), pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm,
        topMargin=17 * mm, bottomMargin=21 * mm,
        title="Decentralized Trade Data Exchange Network - Architecture Blueprint",
        author="Architecture Blueprint",
    )
    document.build(build_story(lines), onFirstPage=page_chrome, onLaterPages=page_chrome)
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
