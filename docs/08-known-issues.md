# 08 — 알려진 이슈 · 보강 계획 (어드바이저 ①)

2026-06-29 챗봇 3유형(규정·법령·번외) 동작 점검 중 확인된 미처리 보강건. 둘 다
오픈 전 하드닝 대상이며, PoC 정책상 **각각 단일 커밋**으로 분리해 진행한다.

진단 근거 코드: `app/api/chat/route.ts`, `lib/law/verify.ts`, `lib/law/search.ts`,
`app/page.tsx`.

---

## 이슈 A — 참조문서가 case-by-case로 사라짐 (우선순위 높음)

> **[해소 — 2026-07-13 통합 검색 개편]** 참조문서(주입분)가 스트리밍 전에 확정되는 구조가
> 되면서 `sources` 이벤트를 **delta 앞에 선발송**하도록 변경. 중간에 멈춰도 패널이 남는다.
> 아래 본문은 당시 진단 기록으로 보존.

### 증상
내부 규정 검색에서 참조문서 패널이 나올 때도, 안 나올 때도 있다. 특히 답변 도중
**'멈춤'(중단)** 을 누르면 참조문서가 사라진다.

### 원인 — `sources` 이벤트가 스트림 맨 끝에서 송출됨
- 서버는 `sources` 이벤트를 답변 delta 전부(+법령 분기는 인용검증까지) 끝난 **뒤**에
  보낸다 (`route.ts:336`).
- 클라이언트는 `sources` 이벤트를 받아야만 패널을 채운다 (`page.tsx:243-244`).
- '멈춤' → `abort()` (`page.tsx:277-278`) → reader가 `AbortError`로 끊김 → 지금까지
  받은 텍스트만 남기고 종료 (`page.tsx:255-262`). 이때 `sources`는 아직 도착 전이라
  패널이 빈 채로 끝난다.

| 상황 | sources 도달 | 패널 |
|---|---|---|
| 답변 끝까지 둠 | ✅(맨 끝) | 나옴 |
| 중간에 멈춤 | ❌ | **안 나옴** |

regulation 분기는 참조문서가 `route.ts:189`에서 **이미 확정**돼 있는데도 끝까지 들고
있다 보내는 순수 순서 낭비다.

### 보강
1. **regulation 분기**: delta 루프(`route.ts:283`) **직전**에 `routing` + `sources`
   선발송. 첫 글자 이후 언제 멈추든 참조문서는 이미 도착.
   ```ts
   if (!outOfScope && !routedToLaw) {
     send(controller, { type: "routing", route: "regulation", score: maxScore });
     send(controller, { type: "sources", data: sources });
   }
   ```
2. **법령 분기**: 검색 확정분(`lawSources + precedentSources`)을 스트리밍 전 **잠정
   선발송**하고, 인용검증 후 `citationSources`로 **2단 갱신**. 클라이언트는 마지막
   `sources`가 이전 값을 덮어쓰므로(`page.tsx:244`) 그대로 작동.

### 영향 범위
`route.ts`만 수정. 클라이언트 변경 불필요(이벤트 계약 동일, 순서만 변경).

---

## 이슈 B — 무관 법령이 인용검증에서 `verified`로 새어나옴 (비결정적)

> **[구조 변화로 소멸 — 2026-07-13 통합 검색 개편]** verified 조문을 참조 카드로 승격하던
> `citationSources` 경로 자체가 폐지됐다(참조문서 = 주입분, 인용 검증 = 경고 배지 전용).
> 무관 법령이 verified 로 판정돼도 카드로 노출되지 않으며, `resolveLaw` 의 포함관계 필터와
> 무변별 토큰 스킵으로 오검증도 축소. 아래 본문은 당시 진단 기록으로 보존.

### 증상
법령 분기에서 가끔(매번 X) 질의와 무관한 법령이 참조카드에 `verified`로 표시된다.
재현 예: "행정절차법 사전통지" 질의에 「중·저준위 방사성폐기물 처분시설의 유치지역
지원에 관한 특별법 시행령 제13조」(lawId=010041, score=0)가 verified로 노출.
2026-06-29 재실행 시에는 미재현 — **비결정적**.

### 원인 — `verified`의 의미론적 결함 + 부분매칭 폴백
`verifyCitations`의 verified 판정은 두 가지만 본다 (`verify.ts:149-172`):
(1) 법령명이 법제처의 *어떤* 법령으로 해석되는가, (2) 그 법령에 `제N조`가 실존하는가.
즉 **"조문 실존"만 보증할 뿐 "올바른 법령"은 보증하지 않는다.**

노이즈 사슬:
1. Claude가 인용을 모호하게 표기("같은 법 시행령"으로 안 묶고 `시행령 제13조`로
   풀어 씀) 또는 `CITATION_RE`(`verify.ts:46`) 과포착 → 변별력 없는 법령명 후보.
2. `resolveLaw`(`verify.ts:108-117`)가 `searchByName` 부분검색 결과에서
   **정확매칭이 없으면 1순위 부분매칭을 무조건 채택**: `return exact ?? refs[0];`
   → 무관한 「…시행령」이 1순위로 잡힘.
3. 그 무관 법령에 우연히 같은 조문번호가 실존 → `map.get(article)` 성공 → `verified`.
4. `route.ts:307-316`이 verified+body를 `citationSources`로 승격. `searchAiLaw`가
   안 끌어온 법령이라 `lawScoreById`에 없어 `score=0` — **검증결과와 검색점수가 모순**.

**비결정성**: (a) Claude의 인용 표기 모호성(생성마다 다름) + (b) 법제처 부분검색
1순위가 하필 무관 법령일 것, 두 확률이 동시에 맞을 때만 발생.

### 보강 — 검색 후보로 교차필터 + 폴백 차단
1. `verifyCitations`에 검색 확정 후보(`lawSources`의 lawId/name)를 주입.
   ```ts
   citationCheck = await verifyCitations(answerText, {
     candidateLaws: lawSources.map(s => ({
       lawId: String((s.metadata as {lawId?:string}).lawId ?? ""),
       name: s.title ?? "",
     })),
   });
   ```
2. `resolveLaw`: 후보 집합 내 이름 정합을 **먼저** 시도하고, 후보에 없으면 법제처
   이름검색을 하되 **정확매칭만 채택**(부분매칭 폴백 제거):
   ```ts
   return exact ?? null;   // 기존: exact ?? refs[0]
   ```
   정확매칭 실패는 `not_found`/`ambiguous`로 분류 → 무관 법령의 verified 둔갑 차단.
3. 표시 안전망(`route.ts:307`): 검색 후보에 없는 lawId의 인용은 참조카드에서 제외.
   ```ts
   .filter(v => v.status === "verified" && v.body
             && lawScoreById.has(String(v.lawId ?? "")))
   ```

### 영향 범위
`lib/law/verify.ts`(시그니처 + resolveLaw) + `app/api/chat/route.ts`(호출 + 표시 필터).
반환 타입 `CitationCheck`는 유지 가능.

---

## 진행 순서 제안
1. **이슈 A 먼저** — 사용자 체감 버그(참조문서 사라짐), `route.ts` 단독 변경.
2. **이슈 B** — verify.ts 교차필터, 별도 커밋.
