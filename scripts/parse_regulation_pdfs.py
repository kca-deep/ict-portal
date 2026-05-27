"""ICT기금규정 PDF → Markdown (OpenAI gpt-4o vision 기반).

각 PDF를 페이지별 PNG로 렌더링한 뒤 OpenAI vision API로 표/조문 구조를
보존한 마크다운으로 변환한다. 결과는 `data/manuals/parsed/` 에 원본 PDF
베이스명으로 저장한다. 정렬/관계 정보는 YAML frontmatter 에 남긴다.

사용법:
  python scripts/parse_regulation_pdfs.py          # 전체 30 파일
  python scripts/parse_regulation_pdfs.py g01      # 그룹 1만 (group_idx 필터)
  python scripts/parse_regulation_pdfs.py "방송통신"  # 파일명 부분일치 필터
  python scripts/parse_regulation_pdfs.py "별표 1" --hq  # 고정밀: 페이지별 + 직전 페이지 컨텍스트
"""
from __future__ import annotations

import base64
import io
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import fitz  # PyMuPDF
from dotenv import load_dotenv
from openai import OpenAI
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "ICT기금규정"
DST_DIR = ROOT / "data" / "manuals" / "parsed"
TMP_DIR = ROOT / "data" / "manuals" / "_tmp_png"

MODEL = "gpt-4o"
MAX_OUTPUT_TOKENS = 16000
RENDER_SCALE = 2.2

# 고정밀 모드 (다단 표/별표류): 페이지별 + 직전 페이지 컨텍스트 + 더 큰 렌더링
HQ_RENDER_SCALE = 3.0
HQ_MAX_SIDE = 2400

GROUP_ORDER = [
    "(과학기술정보통신부) 방송통신발전기금 운용·관리규정",
    "기금사업 결과 평가 등에 관한 지침",
    "기금사업 성과관리 및 활용 등에 관한 지침",
    "기금사업 수행상황 및 정산 보고 등에 관한 지침",
    "기금사업 점검계획 등에 관한 지침",
    "기금사업 협약체결 및 사업비 관리 등에 관한 지침",
    "기금사업비 산정 및 정산 등에 관한 지침",
    "정보통신진흥기금 운용·관리규정",
]

SUFFIX_RE = re.compile(r"^(?P<base>.+?)\s*\[(?P<kind>별지|별표)\s*(?P<num>\d+)?\]\s*(?P<atitle>.+?)\.pdf$")

PROMPT = """다음 이미지들은 한국 ICT 기금 규정 문서의 페이지입니다. 검색(RAG)에 활용할 수 있도록 깔끔한 마크다운으로 변환해주세요.

규칙:
- 조문 구조는 마크다운 헤더로 (예: "## 제1조 (목적)")
- 항(①②③) 과 호(1. 2. 3.) 는 본문 그대로 유지 (헤더로 만들지 말 것)
- 표(table)는 마크다운 파이프 테이블로 보존. 두 페이지에 걸친 표는 한 표로 합침
- 양식/서식의 기입란은 "____" 또는 "(작성)" 으로 표기
- 페이지 번호·머리말·꼬리말은 무시
- [별지], [별표] 표시는 최상단 H1 헤더로 보존
- 한자 병기는 원문 그대로 유지
- 출력은 마크다운 본문만 — 코드블록(```)으로 감싸지 말 것
- 설명·사과·메타 코멘트 없이 변환 결과만 출력
"""

HQ_PROMPT_FIRST = """다음은 한국 ICT 기금 규정 문서의 첫 페이지입니다.
- 이미지: 정확한 레이아웃·표 구조 파악용
- 텍스트 덤프(PyMuPDF 추출): 글자 자체는 정확하지만 공백/줄바꿈/표 구조가 깨져 있음 (참고용 정답 글자)

두 정보를 결합하여 검색(RAG)에 활용 가능한 정밀 마크다운으로 변환하세요.

규칙:
- 글자는 텍스트 덤프를 우선 신뢰 (이미지 OCR 환각 방지). 한자·전문용어·전문기관명·항목명을 추측하지 말 것
- 표 구조·셀 경계는 이미지에서 판단
- 표는 마크다운 파이프 테이블. 셀 안 줄바꿈은 <br>
- 표의 모든 행은 비목/세목이 완전한 정보를 갖도록 작성
- 한자 병기·각주(*,**,※)·원형 번호(①②③④⑤⑥⑦⑧) 원문 그대로
- 페이지 번호·머리말·꼬리말 무시
- 출력은 마크다운 본문만 (코드블록 금지, 메타 코멘트 금지)
"""

HQ_PROMPT_CONT = """두 이미지 + 현재 페이지 텍스트 덤프가 제공됩니다.
- 첫 번째 이미지: 직전 페이지 (컨텍스트 참고용 — 변환 대상 아님)
- 두 번째 이미지: 현재 페이지 (변환 대상)
- 텍스트 덤프: 현재 페이지의 PyMuPDF 추출 텍스트 (글자 정확, 레이아웃 깨짐)

규칙:
- 현재 페이지만 마크다운으로 출력
- 글자는 텍스트 덤프를 우선 신뢰. 이미지 OCR 환각을 텍스트로 교정
- 현재 페이지 표의 첫/둘째 열(비목/세목)이 비어 있으면, 직전 페이지 같은 열 마지막 값으로 forward-fill 하여 모든 행이 완전한 정보를 갖도록 함
- 표가 직전 페이지에서 이어지는 것이면 표 헤더는 다시 출력하지 말고 데이터 행만 이어서 출력
- 새 표/새 섹션이 시작되면 자체 헤더와 함께 출력
- 한자 병기·각주·원형 번호 원문 그대로
- 페이지 번호·머리말·꼬리말 무시
- 출력은 마크다운 본문만 (코드블록 금지)
"""


@dataclass
class GroupItem:
    group_idx: int
    order: int
    kind: str
    attach_num: int | None
    attach_title: str | None
    src_pdf: Path
    base: str


def classify(pdf: Path) -> GroupItem | None:
    name = pdf.name
    m = SUFFIX_RE.match(name)
    if m:
        base = m.group("base").strip()
        kind = m.group("kind")
        num = int(m.group("num")) if m.group("num") else 0
        atitle = m.group("atitle").strip()
    else:
        base = pdf.stem
        kind = "main"
        num = None
        atitle = None

    if base not in GROUP_ORDER:
        return None

    group_idx = GROUP_ORDER.index(base) + 1
    order = 0 if kind == "main" else (num or 0)
    return GroupItem(
        group_idx=group_idx,
        order=order,
        kind=kind,
        attach_num=num if kind != "main" else None,
        attach_title=atitle,
        src_pdf=pdf,
        base=base,
    )


def render_pages(pdf: Path, out_dir: Path, scale: float = RENDER_SCALE) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(str(pdf))
    paths = []
    mat = fitz.Matrix(scale, scale)
    suffix = f"s{int(scale*10)}"
    for i in range(doc.page_count):
        png = out_dir / f"{pdf.stem}__p{i+1:02d}_{suffix}.png"
        pix = doc.load_page(i).get_pixmap(matrix=mat)
        pix.save(str(png))
        paths.append(png)
    doc.close()
    return paths


def png_to_data_url(p: Path, max_side: int = 2000) -> str:
    img = Image.open(p)
    w, h = img.size
    if max(w, h) > max_side:
        ratio = max_side / max(w, h)
        img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _strip_codeblock(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:markdown|md)?\s*\n", "", text)
        text = re.sub(r"\n```\s*$", "", text)
    return text.strip()


def parse_via_openai(client: OpenAI, png_paths: list[Path]) -> str:
    content: list[dict] = []
    for p in png_paths:
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": png_to_data_url(p), "detail": "high"},
            }
        )
    content.append({"type": "text", "text": PROMPT})

    resp = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": content}],
        max_tokens=MAX_OUTPUT_TOKENS,
        temperature=0,
    )
    return _strip_codeblock(resp.choices[0].message.content or "")


def extract_page_texts(pdf: Path) -> list[str]:
    """페이지별 raw 텍스트 덤프 (PyMuPDF). 글자는 정확, 레이아웃은 깨짐."""
    doc = fitz.open(str(pdf))
    texts = [doc.load_page(i).get_text("text") for i in range(doc.page_count)]
    doc.close()
    return texts


def parse_via_openai_hq(client: OpenAI, png_paths: list[Path], page_texts: list[str]) -> str:
    """페이지별 1장 + 직전 페이지 이미지 + 현재 페이지 텍스트 덤프. 다단 표/별표류 고정밀."""
    chunks: list[str] = []
    for i, current in enumerate(png_paths):
        content: list[dict] = []
        if i > 0:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": png_to_data_url(png_paths[i - 1], max_side=HQ_MAX_SIDE),
                        "detail": "high",
                    },
                }
            )
        content.append(
            {
                "type": "image_url",
                "image_url": {
                    "url": png_to_data_url(current, max_side=HQ_MAX_SIDE),
                    "detail": "high",
                },
            }
        )
        prompt = HQ_PROMPT_FIRST if i == 0 else HQ_PROMPT_CONT
        dump = page_texts[i] if i < len(page_texts) else ""
        content.append(
            {
                "type": "text",
                "text": f"{prompt}\n\n[현재 페이지 텍스트 덤프 — 글자 정답, 레이아웃 깨짐]\n```\n{dump}\n```",
            }
        )

        resp = client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": content}],
            max_tokens=MAX_OUTPUT_TOKENS,
            temperature=0,
        )
        chunks.append(_strip_codeblock(resp.choices[0].message.content or ""))
        print(f"     · page {i+1}/{len(png_paths)} done")

    return "\n\n".join(chunks)


def build_frontmatter(item: GroupItem) -> str:
    lines = [
        "---",
        f"group: {item.group_idx}",
        f'group_title: "{item.base}"',
        f"order: {item.order}",
        f"attachment_type: {item.kind}",
    ]
    if item.attach_num is not None:
        lines.append(f"attachment_number: {item.attach_num}")
    if item.attach_title:
        lines.append(f'attachment_title: "{item.attach_title}"')
    lines.append(f'source_pdf: "{item.src_pdf.name}"')
    lines.append("---")
    return "\n".join(lines)


def output_filename(item: GroupItem) -> str:
    # 원본 PDF 베이스명 그대로 (정렬 정보는 frontmatter 의 group/order 에 보존)
    return item.src_pdf.stem + ".md"


def match_filter(item: GroupItem, flt: str) -> bool:
    if not flt:
        return True
    if re.fullmatch(r"g\d{1,2}", flt):
        return item.group_idx == int(flt[1:])
    return flt in item.src_pdf.name


def main() -> None:
    load_dotenv(ROOT / ".env.local")

    client = OpenAI()
    DST_DIR.mkdir(parents=True, exist_ok=True)

    pdfs = sorted(SRC_DIR.glob("*.pdf"))
    items = [it for it in (classify(p) for p in pdfs) if it]
    items.sort(key=lambda i: (i.group_idx, i.order))

    args = [a for a in sys.argv[1:] if a]
    hq = "--hq" in args
    args = [a for a in args if a != "--hq"]
    flt = args[0] if args else ""
    selected = [it for it in items if match_filter(it, flt)]

    total_pages = 0
    for it in selected:
        d = fitz.open(str(it.src_pdf))
        total_pages += d.page_count
        d.close()

    print(f"대상: {len(selected)} 파일 / {total_pages} 페이지  (filter={flt!r}, hq={hq})")
    print()

    ok, fail, skipped = 0, 0, 0
    for idx, item in enumerate(selected, start=1):
        out_name = output_filename(item)
        out_path = DST_DIR / out_name
        tag = f"[{idx:02d}/{len(selected)}] g{item.group_idx:02d}-{item.order:02d}"

        if out_path.exists():
            print(f"{tag} exists, skip → {out_name}")
            skipped += 1
            continue

        print(f"{tag} {item.src_pdf.name}")
        try:
            t0 = time.time()
            scale = HQ_RENDER_SCALE if hq else RENDER_SCALE
            pngs = render_pages(item.src_pdf, TMP_DIR / item.src_pdf.stem, scale=scale)
            if hq:
                texts = extract_page_texts(item.src_pdf)
                md = parse_via_openai_hq(client, pngs, texts)
            else:
                md = parse_via_openai(client, pngs)
            body = f"{build_frontmatter(item)}\n\n{md}\n"
            out_path.write_text(body, encoding="utf-8")
            dt = time.time() - t0
            print(f"     OK  {len(pngs)}p  {dt:.1f}s  → {out_name}")
            ok += 1
        except Exception as e:
            print(f"     FAIL  {type(e).__name__}: {e}")
            fail += 1

    print()
    print(f"완료. ok={ok}  fail={fail}  skipped={skipped}")


if __name__ == "__main__":
    main()
