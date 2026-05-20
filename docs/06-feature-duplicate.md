# ③ 중복수혜 조회 (PoC)

> 일정: **2026년 10~11월**. **공개용 기능 구현이 아닌, 기술적 실현 가능성 확인이 목적**.

## 1. 목표

- 공모 선정 단계에서 신청 기업의 **최근 3년 他사업 수행 이력 및 현재 수행 중인 과제를 통합 조회**.
- **사업 이력·예산 등 핵심 정보 기반의 중복수혜 사전 조회** 기능 제공.
- 참여율 분석을 통한 **인건비 이중(초과) 수급 방지**.

## 2. 입력·출력

### 입력

```json
POST /api/duplicate-check
{
  "applicant_id":        "123-45-67890",
  "new_project_title":   "AI 기반 ...",
  "new_project_content": "(사업계획서 본문 또는 PDF file_id)",
  "new_period":          {"start": "2026-07-01", "end": "2027-06-30"},
  "new_participation_rate": 0.5
}
```

### 출력

```json
{
  "overall_risk": "medium",
  "labor_overlap": 1.3,
  "matched_projects": [
    {
      "project_id": 12345,
      "project_title": "...",
      "agency": "NIPA",
      "period_start": "2024-09-01",
      "period_end": "2025-08-31",
      "similarity": 0.87,
      "reason": "AI 기반 진단 도구라는 핵심 아이템이 동일",
      "labor_overlap_rate": 0.3
    }
  ],
  "recommendation": "유사 과제 1건 존재. 차별성 명시 필요."
}
```

## 3. 파이프라인 흐름

```
[입력: 신청자 ID + 신규 사업계획서]
    │
    ▼
[Step 1] 비정형 문서 표준화 (lib/ocr/)
   - PDF → 텍스트 (pdfplumber 류)
   - 이미지 → OCR (Cloud Vision API 또는 자체 모델)
   - 표 → 구조화 JSON
   - 최종: 정제된 텍스트 청크
    │
    ▼
[Step 2] 신청자 과거 이력 조회
   - project_history WHERE applicant_id = X
     AND period_end >= NOW() - INTERVAL '3 years'
   - period_start <= 신규 period_end (시간 겹침 후보)
    │
    ▼
[Step 3] 임베딩 기반 유사도 분석 (lib/ai/embedding.ts)
   - 신규 사업계획서 청크별 임베딩
   - project_embeddings 와 코사인 유사도 계산
   - 임계값(0.75 등) 이상만 후보
    │
    ▼
[Step 4] AI 종합 판단 (Claude Sonnet 4.6)
   - 신규 vs 매칭된 과거 사업의 핵심 아이템 비교
   - "동일 아이템 / 유사 아이템 / 무관" 판정 + 이유
    │
    ▼
[Step 5] 참여율(인건비) 분석
   - 시간 겹치는 과거 과제의 participation_rate 합산
   - 신규 참여율 합산 시 1.0(100%) 초과 여부 판단
    │
    ▼
[Step 6] 종합 위험도 산정
   - low / medium / high
   - 유사도 + 시간 겹침 + 참여율 종합
    │
    ▼
[Step 7] duplicate_check_runs INSERT
   - 감사 추적 + 향후 개선 데이터
```

## 4. 기술 결정

### 4.1 OCR

- **1순위 검토**: **Claude Vision API** (Claude Sonnet 4.6의 vision 입력) — PDF·이미지 직접 입력 가능
- **2순위**: **Google Cloud Vision OCR** — 정확도 높음, 비용 발생
- **3순위**: 오픈소스 (PaddleOCR, Tesseract) — 자체 호스팅 부담

→ Sonnet 4.6 vision으로 PoC 시도 → 정확도 부족하면 GCV 도입.

### 4.2 표 처리

- 사업계획서의 표(예산표, 참여인력표)는 OCR 후 별도 파싱
- 첫 PoC는 단순 텍스트 추출, 표 구조화는 향후 과제

### 4.3 임베딩 모델

- **Cohere embed-v4.0** (어드바이저와 동일)
- 사업계획서는 도메인 어휘가 많아 향후 fine-tuning 또는 도메인 특화 모델 검토 여지

### 4.4 유사도 판정 LLM

- **Claude Sonnet 4.6** (어드바이저와 동일)
- 프롬프트로 "동일 아이템 / 유사 / 무관" 라벨링

## 5. 데이터 모델 (요약)

| 테이블 | 핵심 컬럼 |
|---|---|
| `project_history` | applicant_id, project_title, period, budget, participation_rate, content_summary |
| `project_embeddings` | project_id, chunk_index, content, embedding(1024) |
| `duplicate_check_runs` | applicant_id, new_project_*, matched_projects(jsonb), overall_risk |

자세한 내용은 [03-data-model.md](./03-data-model.md) 참고.

## 6. 민감정보 처리

본 모듈은 **사업자 식별정보·예산·인력 정보**를 다루므로 별도 보안 조치:

- `project_history`, `project_embeddings`: **RLS로 service_role만 접근**
- API 호출 시 사용자 인증 + 권한 검증 필수 (관리자 또는 평가위원만)
- 사업계획서 원본 파일은 Supabase Storage에 암호화 저장 + 짧은 TTL signed URL
- 외부 LLM 전송 시 **개인정보 마스킹 게이트** 적용
  - 사업자등록번호, 주민등록번호, 이메일·전화번호 패턴 자동 마스킹
  - 마스킹 후 토큰으로 치환, 결과 후 역치환
- 감사 추적: `duplicate_check_runs`에 모든 실행 기록 + IP·user_id

## 7. PoC 범위 (10~11월)

| 항목 | PoC 포함 | 향후 |
|---|---|---|
| 신청자별 이력 통합 조회 | ✅ | |
| 임베딩 기반 유사도 분석 | ✅ | |
| 사업계획서 OCR (Claude Vision) | ✅ | GCV 또는 자체 모델 검토 |
| AI 종합 판정 | ✅ | |
| 참여율 합산 분석 | ✅ | |
| 표(예산·참여인력) 구조화 | △ 단순 텍스트 | 표 파싱 고도화 |
| 다국어 사업계획서 | ❌ | |
| 실시간 알림 | ❌ | |

PoC 평가 결과 → 본 운영 진입 여부 결정.

## 8. 평가 지표

| 지표 | 목표 (PoC) |
|---|---|
| 동일 아이템 적발률 (recall) | ≥ 0.80 |
| 오탐률 (false positive) | ≤ 0.20 |
| 평균 1회 분석 시간 | ≤ 60초 |
| OCR 정확도 (텍스트 일치율) | ≥ 0.90 |

## 9. 향후 확장 가능성

- 사업계획서 자동 평가 (창의성·실현 가능성 등)
- 산업계 동향 비교 (외부 데이터 결합)
- 부정수급 패턴 탐지 (시계열 이상치)
