"""ICT기금규정 폴더의 PDF 묶음 병합.

각 메인 PDF 뒤에 같은 이름의 [별지 N] / [별표 N] PDF 들을 번호 순으로 이어붙여
`merged/<메인파일명>.pdf` 로 저장한다.
"""
from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

from pypdf import PdfReader, PdfWriter

SRC = Path(r"C:\workspace\ict-portal\ICT기금규정")
DST = SRC / "merged"

# 예: "기금사업 결과 평가 등에 관한 지침 [별지 1] ...pdf"
#     -> base="기금사업 결과 평가 등에 관한 지침", num=1
SUFFIX_RE = re.compile(r"^(?P<base>.+?)\s*\[(?:별지|별표)\s*(?P<num>\d+)?\].*\.pdf$")


def classify(name: str) -> tuple[str, int | None]:
    """파일명을 (그룹 base, 첨부 번호) 로 변환. 메인 파일이면 번호는 None."""
    m = SUFFIX_RE.match(name)
    if m:
        num = int(m.group("num")) if m.group("num") else 0
        return m.group("base").strip(), num
    # 메인 파일 ("...지침.pdf")
    return Path(name).stem, None


def main() -> None:
    DST.mkdir(exist_ok=True)

    groups: dict[str, dict[str | int, Path]] = defaultdict(dict)
    for pdf in SRC.glob("*.pdf"):
        base, num = classify(pdf.name)
        key = "MAIN" if num is None else num
        groups[base][key] = pdf

    print(f"총 {len(groups)} 개 그룹 발견")
    for base, parts in sorted(groups.items()):
        if "MAIN" not in parts:
            print(f"  [SKIP] 메인 파일 없음: {base}")
            continue

        ordered: list[Path] = [parts["MAIN"]]
        attach_nums = sorted(k for k in parts.keys() if k != "MAIN")
        ordered.extend(parts[n] for n in attach_nums)

        out_path = DST / f"{base}.pdf"
        writer = PdfWriter()
        for src_path in ordered:
            reader = PdfReader(str(src_path))
            for page in reader.pages:
                writer.add_page(page)

        with out_path.open("wb") as f:
            writer.write(f)

        print(f"  [OK] {base}.pdf  ← {len(ordered)} files")


if __name__ == "__main__":
    main()
