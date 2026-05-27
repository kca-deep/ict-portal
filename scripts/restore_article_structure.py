"""HQ 변환된 마크다운에서 항(項) 표시 ①②③ 를 PDF 원문 기준으로 복원.

문제: gpt-4o 가 일부 조에서 항(①②③) 을 호(1.2.3.) 와 동일 평면으로 정규화.
해결: PyMuPDF 텍스트 덤프는 ①②③ 와 1.2.3. 를 정확히 보존하므로 이를 정답으로 사용.

알고리즘:
1. PDF 텍스트에서 조 단위로 분해 → 각 조의 항(①②③) 별 내용 추출
2. 동시에 각 항 안의 호(1.2.3.) 가 nested 인지도 파악
3. MD 에서 해당 조 찾고, 항 내용 prefix 매칭으로 "N." → ①②③ 복원
4. 호는 그대로 둠 (이미 1.2.3. 로 정확)
5. 분실된 항 intro prose 가 있으면 복원 삽입
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "ICT기금규정"
DST = ROOT / "data" / "manuals" / "parsed"

CIRCLES = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮"
CIRCLE_SET = set(CIRCLES)


@dataclass
class Paragraph:
    """조 안의 항(項). marker 가 None 이면 도입부 prose(항 번호 없음)."""
    marker: str | None        # '①' / '②' / ... 또는 None
    intro: str                # 항 시작 prose (intro 부분)
    items: list[tuple[str, str]] = field(default_factory=list)  # [(호 번호, 호 내용)]


@dataclass
class Article:
    art_id: str               # '제3조'
    art_id_full: str          # '제3조의2'
    title: str                # '용어의 정의'
    paragraphs: list[Paragraph]


def normalize(s: str) -> str:
    """공백 + 마크다운 강조 마커 제거 — 매칭용."""
    s = re.sub(r"[*_`]+", "", s)  # **, __, `` 제거
    s = re.sub(r"\s+", "", s)
    return s.strip()


def parse_pdf_text(pdf_path: Path) -> list[Article]:
    """PDF 전문에서 조 단위 + 항/호 구조 추출."""
    doc = fitz.open(str(pdf_path))
    text = "\n".join(doc.load_page(i).get_text("text") for i in range(doc.page_count))
    doc.close()

    # 조 단위 분할: '제N조' 또는 '제N조의M'
    # 헤더 패턴 잡기
    art_pat = re.compile(r"(제\d+조(?:의\d+)?)\(([^)]+)\)")
    matches = list(art_pat.finditer(text))
    articles: list[Article] = []

    for i, m in enumerate(matches):
        art_id_full = m.group(1)
        title = m.group(2)
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[body_start:body_end]

        # 항 분할: 첫 항은 헤더 직후부터, 이후 항은 ①②③... 마커로 분할
        # 보통 패턴: "제N조(타이틀) ① ... \n② ... \n③ ..."
        # body 의 첫 부분이 prose 일 수도, 바로 ① 일 수도 있음
        paragraphs = _split_paragraphs(body)
        # art_id (의 제외)
        art_id = re.match(r"제\d+조", art_id_full).group(0)
        articles.append(Article(art_id=art_id, art_id_full=art_id_full, title=title, paragraphs=paragraphs))

    return articles


def _split_paragraphs(body: str) -> list[Paragraph]:
    """조의 body 를 항 단위로 분할.

    항 마커 ①②③... 가 줄 시작 또는 공백 뒤에 오는 패턴을 찾는다.
    호(1./2./3.) 는 항 안에 nested.
    """
    paragraphs: list[Paragraph] = []
    # ①②③... 위치 모두 찾기
    marker_positions = [(i, ch) for i, ch in enumerate(body) if ch in CIRCLE_SET]

    if not marker_positions:
        # 항 마커가 없으면 전체를 하나의 prose 로 (단일 항)
        intro = body.strip()
        items = _extract_items(intro)
        # 호만 있는 경우 — intro 에서 호 분리
        if items:
            intro = _strip_items_from_intro(intro, items)
        paragraphs.append(Paragraph(marker=None, intro=intro, items=items))
        return paragraphs

    # 첫 마커 전까지 (있다면) — 헤더 직후 prose. 보통 비어 있거나 짧음
    first_marker_pos = marker_positions[0][0]
    pre = body[:first_marker_pos].strip()
    if pre:
        # 마커 전 prose 가 있으면 marker=None 의 첫 paragraph
        items = _extract_items(pre)
        intro = _strip_items_from_intro(pre, items) if items else pre
        paragraphs.append(Paragraph(marker=None, intro=intro, items=items))

    # 각 마커별 본문
    for idx, (pos, marker) in enumerate(marker_positions):
        next_pos = marker_positions[idx + 1][0] if idx + 1 < len(marker_positions) else len(body)
        seg = body[pos + 1 : next_pos].strip()
        items = _extract_items(seg)
        intro = _strip_items_from_intro(seg, items) if items else seg
        paragraphs.append(Paragraph(marker=marker, intro=intro, items=items))

    return paragraphs


_ITEM_LINE = re.compile(r"^\s*(\d+)\.\s+(.+)$", re.M)


def _extract_items(segment: str) -> list[tuple[str, str]]:
    """세그먼트에서 '1. ...' '2. ...' 호 추출."""
    items: list[tuple[str, str]] = []
    for m in _ITEM_LINE.finditer(segment):
        items.append((m.group(1), m.group(2).strip()))
    # 순서 1,2,3,... 인지 확인. 아니면 빈 리스트 (false positive 방지)
    expected = [str(i + 1) for i in range(len(items))]
    actual = [n for n, _ in items]
    if actual != expected:
        return []
    return items


def _strip_items_from_intro(segment: str, items: list[tuple[str, str]]) -> str:
    """intro 부분만 남기고 호 라인들 제거."""
    if not items:
        return segment.strip()
    first_item_start = segment.find(f"{items[0][0]}.")
    if first_item_start < 0:
        return segment.strip()
    return segment[:first_item_start].strip()


# ---- MD 처리 ----

MD_ARTICLE_HEADER = re.compile(r"^(#{2,6})\s+(제\d+조(?:의\d+)?)\s*\(([^)]+)\)\s*$", re.M)
MD_NUM_LINE = re.compile(r"^(\d+)\.\s+(.+)$")


def restore_md(md_path: Path, articles: list[Article]) -> tuple[int, int]:
    """MD 파일을 조 단위로 항 마커 복원. (변경_조_수, 전체_조_수) 반환."""
    text = md_path.read_text(encoding="utf-8")
    lines = text.split("\n")

    # MD 의 조 헤더 위치 (line index, art_id_full, title)
    md_articles: list[tuple[int, str, str]] = []
    for i, line in enumerate(lines):
        m = MD_ARTICLE_HEADER.match(line)
        if m:
            md_articles.append((i, m.group(2), m.group(3)))

    # PDF 의 (art_id_full, title) → Article 매핑 (부칙 등에서 같은 조 번호 재사용되므로 제목까지 포함)
    pdf_map = {(a.art_id_full, a.title): a for a in articles}

    changed = 0
    for j, (li, art_id_full, title) in enumerate(md_articles):
        pdf_art = pdf_map.get((art_id_full, title))
        if not pdf_art:
            # 제목 일치 안 하면 art_id_full 단독으로 fallback
            cands = [a for a in articles if a.art_id_full == art_id_full]
            pdf_art = cands[0] if len(cands) == 1 else None
        if not pdf_art:
            continue
        # 항 마커가 하나라도 있는 조만 처리
        if not any(p.marker for p in pdf_art.paragraphs):
            continue

        # MD 본문: 다음 조 헤더 직전까지
        end = md_articles[j + 1][0] if j + 1 < len(md_articles) else len(lines)
        body_lines = lines[li + 1 : end]

        new_body = _restore_article_body(body_lines, pdf_art)
        if new_body is not None:
            lines[li + 1 : end] = new_body
            changed += 1

    new_text = "\n".join(lines)
    if new_text != text:
        md_path.write_text(new_text, encoding="utf-8")
    return changed, len(md_articles)


def _restore_article_body(body_lines: list[str], pdf_art: Article) -> list[str] | None:
    """MD 본문 라인들을 PDF 항/호 구조에 맞춰 재구성.

    전략:
    1. MD 의 "N. ..." 라인들을 순서대로 모은다.
    2. PDF 의 항 prose 시작 부분과 매칭 시도.
    3. 매칭되면 "N. " → "① " 로 교체. 안 매칭되는 "N. " 는 호로 간주, 그대로 유지.
    4. 분실된 항 intro prose 는 별도 줄로 삽입.
    """
    # MD body 의 numbered 라인 인덱스 수집
    numbered = []  # [(line_idx, num, content)]
    for k, line in enumerate(body_lines):
        m = MD_NUM_LINE.match(line)
        if m:
            numbered.append((k, m.group(1), m.group(2).strip()))

    if not numbered:
        return None

    # PDF 의 각 항 intro 의 정규화된 앞부분(60자) → 매칭 키
    para_keys: list[tuple[str, Paragraph]] = []
    for p in pdf_art.paragraphs:
        if p.marker and p.intro:
            key = normalize(p.intro)[:60]
            if key:
                para_keys.append((key, p))

    if not para_keys:
        return None

    # MD numbered 라인 별로 어떤 항인지 매칭 (1:N 매칭. 매칭된 항의 키는 제거)
    new_lines = list(body_lines)
    used_paras: set[str] = set()
    for k, num, content in numbered:
        c_norm = normalize(content)[:60]
        match_p = None
        for key, p in para_keys:
            if p.marker in used_paras:
                continue
            # 양방향 prefix 비교 — MD 가 살짝 다듬어졌을 수 있어 너그럽게
            if c_norm.startswith(key[:15]) or key.startswith(c_norm[:15]):
                match_p = p
                break
        if match_p:
            # "N. " → marker + " "
            new_lines[k] = re.sub(r"^\d+\.\s+", f"{match_p.marker} ", body_lines[k])
            used_paras.add(match_p.marker)

    # 분실된 항(intro 만 있고 호로 분리됐을 가능성) 의 prose 복원
    # 첫 항(①) 의 intro 가 MD 어디에도 없으면, 첫 호 라인 앞에 삽입
    first_p = pdf_art.paragraphs[0] if pdf_art.paragraphs else None
    if first_p and first_p.marker == "①" and first_p.intro and first_p.items:
        intro_norm = normalize(first_p.intro)[:40]
        present = any(intro_norm and intro_norm in normalize(l) for l in new_lines)
        if not present:
            # 첫 numbered 라인 앞에 ① intro 삽입
            first_num_idx = numbered[0][0]
            insertion = [f"① {first_p.intro}"]
            new_lines = new_lines[:first_num_idx] + insertion + new_lines[first_num_idx:]
            used_paras.add("①")

    return new_lines


def main() -> None:
    total_changed = 0
    total_files = 0
    for md in sorted(DST.glob("*.md")):
        stem = md.stem  # 파일명에서 .md 만 제거 (원본 PDF 파일명과 동일)
        pdf = SRC / f"{stem}.pdf"
        if not pdf.exists():
            print(f"skip (no pdf): {md.name}")
            continue
        articles = parse_pdf_text(pdf)
        changed, total = restore_md(md, articles)
        total_files += 1
        total_changed += changed
        marker = "*" if changed else " "
        print(f"{marker} {md.name[:60]:60}  조 {total:3d}  복원 {changed:3d}")
    print(f"\n총 {total_files}개 MD 검사, {total_changed} 조 복원.")


if __name__ == "__main__":
    main()
