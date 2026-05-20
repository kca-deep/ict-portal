"""HWPX 파일 텍스트 전수 추출"""
import sys
import io
from hwpx import ObjectFinder

# Windows 콘솔 UTF-8 출력
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

HWPX_PATH = r"D:\workspace\ict-portal\붙임3. 사업계획서(ICT기금 사용자 서비스 구축).hwpx"

finder = ObjectFinder(HWPX_PATH)
results = finder.find_all(tag="t")

print(f"=== 총 텍스트 노드: {len(results)}개 ===\n")
for i, r in enumerate(results):
    if r.text and r.text.strip():
        print(f"[{i}] {r.text}")
