# RAG·법령 라우팅 안정화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 같은 의도의 질의가 토큰 하나로 규정↔법령을 오가는 라우팅 버그를 없애고, 법령 분기 시 올바른 법령이 표시되도록 한다.

**Architecture:** 두 트랙. **트랙1**은 불안정한 `isRegulationSufficient` LLM 게이트를 안정적 점수 임계값으로 교체하고 표시·인용을 정합화한다. **트랙2**는 레퍼런스 `korean-law-mcp`(MIT)의 결정론 레이어(query 정제·별칭·법령명 정합·법률우선)를 aiSearch+Cohere 경로에 결합해 법령 검색 품질을 올린다.

**Tech Stack:** Next.js 15 App Router · TypeScript · Supabase RPC · OpenAI 임베딩 · Cohere rerank · Anthropic Claude · 법제처 OpenAPI. 패키지 매니저 pnpm.

## Global Constraints

- **테스트 프레임워크 없음** (CLAUDE.md). 모든 검증은 `pnpm typecheck` + `pnpm build` + 8질의 curl 회귀(`scripts/chat-smoke.mjs`, Task 0)로 한다. pytest/jest 류 금지.
- **DB 스키마 변경 금지** — 본 계획은 전부 애플리케이션 로직/설정. 마이그레이션 신규 추가 없음.
- **커밋 분할**: 한 태스크 = 한 커밋. 기능 변경과 설정 변경을 섞지 않는다.
- **레퍼런스 코드 이식 시** 해당 함수 위 주석에 `// 출처: chrisryugj/korean-law-mcp (MIT)` 표기.
- **임베딩/LLM 공급자 변경 금지** — Cohere(재정렬)·OpenAI(임베딩)·Claude(답변) 고정.
- **커밋·push는 사용자 요청 시에만**. 각 태스크는 로컬 커밋까지만; push 안 함.
- 변경 후 dev 서버는 사용자가 3000 포트에 기동한다(에이전트가 임의 기동 금지). 회귀는 서버 가동 상태에서 실행.

**라우팅 분류 기준 (acceptance):**
- A. 규정관련 → `route=regulation`, 규정 출처만
- B. 규정외 in-scope 법령 → `route=law`, 법령 출처만, `hasHallucination=false`
- C. 무관 → 거절(routing 이벤트 없음), 출처 0

**8질의 고정 회귀 셋:**
- A: `중간보고서 진행 절차와 시기는?` / `ict기금 전담기관이란` / `ict 전담기관이란`
- B: `기업회생 절차와 관련 법령대로 내가 진행해야 하는 내용을 알려줘` / `육아휴직은 며칠까지 쓸 수 있나요?` / `하도급 대금을 받지 못했을 때 어떻게 대응하나요?` / `개인정보가 유출되면 며칠 안에 신고해야 하나요?`
- C: `오늘 날씨는 어때?`

**현행 baseline (변경 전):** A `ict 전담기관이란`=law(버그), B `기업회생` 법령순위 조세특례(77%)>독점규제(62%)>채무자회생(34%), B `기업회생`·`개인정보` `hasHallucination=true`(거짓).

---

## File Structure

| 파일 | 책임 | 트랙 |
|---|---|---|
| `scripts/chat-smoke.mjs` | 8질의 회귀 하네스 (신규) | 0 |
| `lib/env.ts` | `RELEVANCE_THRESHOLD` 기본값 | 1 |
| `app/api/chat/route.ts` | 라우팅 결정·답변문서·인용 score·표시 | 1·9 |
| `lib/law/verify.ts` | 인용 추출 정규식(규정 제외) | 1 |
| `prompts/prompts.md` | advisor 프롬프트 라벨 규칙 | 1 |
| `lib/law/search.ts` | query 정제·별칭·결정론 결합점수 | 2 |

---

## Task 0: 회귀 하네스 (`scripts/chat-smoke.mjs`)

**Files:**
- Create: `scripts/chat-smoke.mjs`

**Interfaces:**
- Produces: CLI `node scripts/chat-smoke.mjs [A|B|C|all] [질의...]` — 각 질의에 대해 `route`, `regMaxScore`, `laws`, 표시 소스 kind, `hasHallucination`을 한 줄로 출력. 후속 모든 태스크의 검증 도구.

- [ ] **Step 1: 하네스 작성**

```js
// scripts/chat-smoke.mjs — 채팅 라우팅 회귀 하네스 (테스트 프레임워크 부재 대체).
// 사용: node scripts/chat-smoke.mjs            → 8질의 고정 셋
//       node scripts/chat-smoke.mjs "임의 질의"  → 단건
const BASE = process.env.CHAT_BASE ?? "http://localhost:3000";
const FIXED = {
  A: ["중간보고서 진행 절차와 시기는?", "ict기금 전담기관이란", "ict 전담기관이란"],
  B: ["기업회생 절차와 관련 법령대로 내가 진행해야 하는 내용을 알려줘",
      "육아휴직은 며칠까지 쓸 수 있나요?",
      "하도급 대금을 받지 못했을 때 어떻게 대응하나요?",
      "개인정보가 유출되면 며칠 안에 신고해야 하나요?"],
  C: ["오늘 날씨는 어때?"],
};

async function ask(q) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: q }] }),
  });
  const text = await res.text();
  const ev = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const r = ev.find((e) => e.type === "routing");
  const s = ev.find((e) => e.type === "sources");
  const c = ev.find((e) => e.type === "citations");
  const kinds = (s?.data ?? []).map((x) => `${x.metadata?.kind ?? "reg"}:${typeof x.score === "number" ? x.score.toFixed(2) : x.score}`);
  return {
    q,
    route: r?.route ?? "(refuse)",
    score: r?.score?.toFixed?.(3) ?? "-",
    laws: (r?.laws ?? []).map((l) => l.name).join(" | "),
    sources: kinds.join(", ") || "0",
    halluc: c?.hasHallucination ?? false,
  };
}

const args = process.argv.slice(2);
const queries = args.length === 0 || ["A", "B", "C", "all"].includes(args[0])
  ? (args[0] && args[0] !== "all" ? FIXED[args[0]] : [...FIXED.A, ...FIXED.B, ...FIXED.C])
  : args;

for (const q of queries) {
  const r = await ask(q);
  console.log(`[${r.route}] score=${r.score} halluc=${r.halluc} | src=${r.sources} | laws=${r.laws} | ${q}`);
}
```

- [ ] **Step 2: typecheck (스크립트는 .mjs라 tsc 비대상이나 전체 점검)**

Run: `pnpm typecheck`
Expected: 에러 0 (스크립트는 빌드 비포함).

- [ ] **Step 3: baseline 캡처 (서버 가동 상태에서)**

Run: `node scripts/chat-smoke.mjs > /tmp/baseline.txt; cat /tmp/baseline.txt`
Expected: 8줄 출력. `ict 전담기관이란`이 `[law]`로 (버그 재현), `기업회생`/`개인정보`가 `halluc=true`. 이 파일을 변경 전 기준선으로 보관.

- [ ] **Step 4: Commit**

```bash
git add scripts/chat-smoke.mjs
git commit -m "chore(chat): 라우팅 회귀 하네스 추가 (8질의 스모크)"
```

---

## Task 1: 라우팅 — 안정 임계값으로 교체 (트랙1, 필수)

**Files:**
- Modify: `lib/env.ts:39`
- Modify: `app/api/chat/route.ts:4`(import), `:211-216`(분기), `:258-263`(로그)

**Interfaces:**
- Consumes: `env.RELEVANCE_THRESHOLD`, `belowThreshold`, `outOfScope`(기존)
- Produces: `routedToLaw: boolean` (= `!outOfScope && belowThreshold`)

- [ ] **Step 1: 임계값 기본값 상향** — `lib/env.ts:39`

```ts
  RELEVANCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.33),
```

- [ ] **Step 2: sufficiency 게이트 라우팅 제거** — `app/api/chat/route.ts:211-216` 전체를 교체

```ts
        // 규정 관련도가 기준치 미만일 때만 법령으로 분기한다. 구 sufficiency 게이트
        // (isRegulationSufficient)는 top-K 재정렬 청크에 민감해 같은 질의가 토큰 하나로
        // 규정↔법령을 오가게 만들었다 — 제거하고 안정적 점수 신호만 사용.
        const routedToLaw = !outOfScope && belowThreshold;
```

- [ ] **Step 3: 미사용 import·로그 정리**

`route.ts:4` import에서 `isRegulationSufficient,` 제거. 그리고 로그(`:258-263`)의 `gateSufficient=${gateSufficient} ` 토막 삭제:

```ts
        console.log(
          `[chat] route=${outOfScope ? "out_of_scope" : routedToLaw ? "law" : "regulation"} maxScore=${maxScore.toFixed(3)} ` +
            `threshold=${env.RELEVANCE_THRESHOLD} belowThreshold=${belowThreshold} ` +
            `hits=${hits.length}` +
            (routedToLaw ? ` laws=[${lawRefs.map((r) => r.name).join(", ")}]` : " (법제처 미호출)"),
        );
```

- [ ] **Step 4: typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: 에러 0. (`isRegulationSufficient` 함수는 `llm-router.ts`에 남겨둠 — 데드코드 정리는 본 계획 범위 밖.)

- [ ] **Step 5: 회귀 (A·C 직격)**

Run: `node scripts/chat-smoke.mjs A; node scripts/chat-smoke.mjs C`
Expected: A 3건 모두 `[regulation]` (특히 `ict 전담기관이란`이 law→regulation으로 교정), C `(refuse)`. B는 다음 단계에서 점검.

- [ ] **Step 6: 회귀 (B 라우팅 유지 확인)**

Run: `node scripts/chat-smoke.mjs B`
Expected: B 4건 모두 `[law]` 유지. (육아휴직 0.034·하도급 0.057·개인정보 0.105·기업회생 0.19~0.30 < 0.33.)

- [ ] **Step 7: Commit**

```bash
git add lib/env.ts app/api/chat/route.ts
git commit -m "fix(chat): 불안정 sufficiency 게이트 제거, 임계값 0.33로 규정↔법령 분기 안정화"
```

---

## Task 2: 인용 검증 — 규정명 오인 제거 (트랙1)

**Files:**
- Modify: `lib/law/verify.ts:46`

**Interfaces:**
- Consumes: 답변 텍스트
- Produces: `extractCitations`가 내부 행정규칙명(`○○규정`)을 법령으로 추출하지 않음 → 거짓 `not_found`/`hasHallucination` 제거.

- [ ] **Step 1: 정규식에서 `규정` 접미사 제거** — `lib/law/verify.ts:46`

`(?:법률|법|령|규칙|규정|조례)` → `(?:법률|법|령|규칙|조례)`. 변경 후 라인:

```ts
  /(?<law>같은\s*법(?:\s*시행(?:령|규칙))?|동법(?:\s*시행(?:령|규칙))?|(?:[가-힣A-Za-z0-9·()]+\s+)*[가-힣A-Za-z0-9·()]*(?:법률|법|령|규칙|조례))\s*[」』】"']?\s*제(?<no>\d+)조(?:의(?<branch>\d+))?/g;
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 에러 0.

- [ ] **Step 3: 회귀 (거짓 환각 해소 확인)**

Run: `node scripts/chat-smoke.mjs "기업회생 절차와 관련 법령대로 내가 진행해야 하는 내용을 알려줘"; node scripts/chat-smoke.mjs "개인정보가 유출되면 며칠 안에 신고해야 하나요?"`
Expected: 두 건 모두 `halluc=false`. (앞서 `정보통신진흥기금 운용·관리규정/not_found`·`방송통신발전기금 운용·관리규정/not_found`로 떴던 거짓 플래그 사라짐.)

- [ ] **Step 4: Commit**

```bash
git add lib/law/verify.ts
git commit -m "fix(law): 인용 검증이 내부 규정명을 법령으로 오인하던 거짓 환각 제거"
```

---

## Task 3: 진짜 이분법 — law 분기 규정 청크 미주입 (트랙1)

**Files:**
- Modify: `app/api/chat/route.ts:268`

**Interfaces:**
- Consumes: `outOfScope`, `routedToLaw`, `retrievedDocs`, `lawContext`
- Produces: `answerDocs` — 규정 분기에서만 규정 청크 주입, law 분기는 빈 배열.

- [ ] **Step 1: answerDocs 분기 수정** — `route.ts:268`

```ts
        // law 분기에선 규정 청크를 주입하지 않는다(진짜 이분법). 규정 본문이 답변에
        // 섞이면서 출처는 법령만 표시되던 "표시≠사용" 불일치를 제거.
        const answerDocs = outOfScope || routedToLaw ? [] : retrievedDocs;
```

- [ ] **Step 2: typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: 에러 0.

- [ ] **Step 3: 회귀 (혼합 제거 확인)**

Run: `node scripts/chat-smoke.mjs B`
Expected: B 4건 `[law]`, 표시 소스 전부 `law:`/`precedent:` (규정 kind 없음). 답변 본문에 규정 인용이 사라지고 법령 근거만 남는지 육안 확인(`node scripts/chat-smoke.mjs "기업회생..."` 후 dev 콘솔/응답 확인).

- [ ] **Step 4: Commit**

```bash
git add app/api/chat/route.ts
git commit -m "fix(chat): law 분기에서 규정 청크 미주입 — 표시=사용 이분법 정합"
```

---

## Task 4: 프롬프트 — 규정을 [법령]으로 라벨링 금지 (트랙1)

**Files:**
- Modify: `prompts/prompts.md` (`<!-- prompt:advisor -->` 섹션, `[근거 사용 원칙]`)

- [ ] **Step 1: 라벨 규칙 한 줄 추가** — advisor 섹션 `[근거 사용 원칙]` 마지막 불릿 뒤에 추가

```md
- 내부 규정·지침·예규(예: 「○○운용·관리규정」, 「○○지침」)은 **[내부 규정]** 으로만 표기하고 **[법령]** 으로 라벨링하지 않습니다. [법령]은 법제처 법률·시행령·시행규칙·판례에만 사용합니다.
```

- [ ] **Step 2: 로더 정상성 확인 (typecheck + build)**

Run: `pnpm typecheck && pnpm build`
Expected: 에러 0. (프롬프트는 `lib/ai/prompts.ts`가 마커로 파싱 — 섹션 누락 시 부팅 실패하므로 빌드가 가드.)

- [ ] **Step 3: 회귀 (라벨 정합)**

Run: `node scripts/chat-smoke.mjs "중간보고서 진행 절차와 시기는?"`
Expected: `[regulation]`. 응답 본문에서 「정보통신진흥기금 운용·관리규정」이 `[법령]`이 아니라 `[내부 규정]`으로 표기되는지 육안 확인.

- [ ] **Step 4: Commit**

```bash
git add prompts/prompts.md
git commit -m "fix(prompt): 내부 규정을 [법령]으로 라벨링하지 않도록 명문화"
```

---

## Task 5: 판례 scope creep — 관련도 컷 (트랙1)

**Files:**
- Modify: `app/api/chat/route.ts:241-251` (판례 본문 회수 직후 필터 추가)

**Interfaces:**
- Consumes: `precRefs`, 회수한 판례 `texts`, `query`, `rerank`(이미 `lib/ai/rerank`에서 import 가능)
- Produces: `precedentSources` — 질의 관련도가 낮은 판례 제외.

- [ ] **Step 1: rerank import 확인/추가** — `route.ts` 상단 import에 `rerank`가 없으면 추가

```ts
import { rerank } from "@/lib/ai/rerank";
```

(이미 `topRerankedSources`에서 쓰므로 존재할 것 — 중복 추가 금지.)

- [ ] **Step 2: 판례 회수 후 관련도 필터** — `route.ts:242-251`의 `if (precRefs.length > 0) { ... }` 블록을 교체

```ts
          if (precRefs.length > 0) {
            const texts = await Promise.all(
              precRefs.map((r) => getDecisionText(r.serial, r.domain)),
            );
            // 판례 scope creep 방지: 판시·판결요지를 질의로 재정렬해 관련도 낮은 판례 제외.
            // 무관 판례(예: "전담기관"에 공직선거법위반)가 참조문서로 새는 것을 차단.
            const judged = await rerank(
              query,
              precRefs.map((r, i) => ({
                id: i,
                text: `${r.caseName}\n${texts[i]?.summary ?? ""}\n${texts[i]?.holding ?? ""}`,
              })),
              precRefs.length,
            ).catch(() => precRefs.map((_, i) => ({ id: i, score: 1 }))); // 재정렬 실패 시 보존
            const keep = new Set(
              judged.filter((j) => j.score >= env.RELEVANCE_THRESHOLD).map((j) => j.id as number),
            );
            const keptRefs = precRefs.filter((_, i) => keep.has(i));
            const keptTexts = texts.filter((_, i) => keep.has(i));
            precedentSources = keptRefs.map((r, i) => toPrecedentSource(r, keptTexts[i], i));
            if (keptRefs.length > 0) {
              const precBlock = buildPrecedentContext(keptRefs, keptTexts);
              lawContext = [lawContext, precBlock].filter(Boolean).join("\n\n");
            }
          }
```

- [ ] **Step 3: typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: 에러 0.

- [ ] **Step 4: 회귀 (B 전반 — 판례 노이즈 감소)**

Run: `node scripts/chat-smoke.mjs B`
Expected: B 4건 `[law]` 유지. 표시 소스에서 무관 `precedent:` 항목 감소(특히 0건이거나 질의 관련 판례만). 라우트·환각 회귀 없음.

- [ ] **Step 5: Commit**

```bash
git add app/api/chat/route.ts
git commit -m "fix(law): 판례를 질의 관련도로 필터 — 무관 판례 scope creep 차단"
```

---

## Task 6: 측정 게이트 — 정제 query가 aiSearch 후보를 개선하는가 (트랙2 선행)

> 트랙2 구현 전, 스펙 §5의 미검증 추론을 실측으로 닫는다. **코드 변경 없음** — 일회성 측정.

**Files:**
- (없음 — 측정 전용)

- [ ] **Step 1: 정제 전/후 후보 비교 측정**

dev 서버 콘솔에는 이미 `[law] aiSearch: 후보 N건 → 법령=[...(NN%)]`가 찍힌다(`search.ts:443`). 기업회생 원문과 수동 정제본을 각각 던져 콘솔 로그를 비교:

```bash
node scripts/chat-smoke.mjs "기업회생 절차와 관련 법령대로 내가 진행해야 하는 내용을 알려줘"
node scripts/chat-smoke.mjs "기업회생"
```

dev 서버 터미널의 두 `[law] aiSearch:` 줄에서 채무자회생법의 순위·%를 비교 기록.

- [ ] **Step 2: 판정 분기**

- **정제본에서 채무자회생법이 상위로 올라오면** → Task 8의 결정론 보정은 약한 타이브레이커로 충분. 그대로 진행.
- **정제본에서도 채무자회생법이 하위면** → aiSearch 후보 자체가 빈약 → Task 8에 **개념 가점 강화 + 시행령 감점**을 더 크게 잡거나, `display`를 50→100으로 늘려 후보 풀 확대(`searchAiLaw` 기본 `display` 인자). 측정 결과를 Task 8 Step 5(튜닝)에 반영.

- [ ] **Step 3: 측정 결과 기록 (커밋 없음)**

측정 수치를 스펙 §7 리스크 항목 또는 PR 설명에 한 줄로 남긴다(코드 변경 없으므로 커밋 불필요).

---

## Task 7: 법령 query 정제 + 별칭 (트랙2)

**Files:**
- Modify: `lib/law/search.ts` (상단 헬퍼 추가, `searchAiLaw` 본문)

**Interfaces:**
- Produces: `distillLawQuery(query: string): string` — 필러 제거된 검색어. `searchAiLaw`가 법제처 aiSearch·Cohere 재정렬에 정제·별칭확장된 query 사용.

- [ ] **Step 1: 정제 헬퍼 추가** — `lib/law/search.ts`의 `LAW_NAME_RE`(line 41) 정의 아래에 추가

```ts
// 출처: chrisryugj/korean-law-mcp (MIT) src/lib/law-search.ts NON_LAW_NAME_RE 이식 + 대화체 필러 추가.
// 법령'명'이 아닌 행위·절차·결과어와 대화 필러를 제거해 aiSearch/재정렬 query를 정제한다.
// 개념 토큰(기업회생·육아휴직 등)은 보존한다.
const NON_LAW_NAME_RE =
  /\s*(과태료|절차|비용|처벌|기준|허가|신청|부과|근거|위반|방법|요건|조건|처분|수수료|신고|등록|면허|인가|승인|취소|정지|벌칙|벌금|과징금|이행강제금|시정명령|체계|구조|판례|해석|개정|별표|서식|반환|납부|감면|면제|제한|금지|의무|권리|자격|종류|기간|대상|범위|적용|감경|영향|분석|위임|현황|처리|민원|매뉴얼|업무|담당|내용|알려|알려줘|진행|관련|어떻게|무엇|뭐|싶|해야|하는)\s*/g;

// 자연어 질의를 법령 검색어로 정제. 과잉 제거 시 원문으로 폴백.
export function distillLawQuery(query: string): string {
  const stripped = query.replace(NON_LAW_NAME_RE, " ").replace(/\s+/g, " ").trim();
  return stripped.length >= 2 ? stripped : query;
}
```

- [ ] **Step 2: `searchAiLaw`가 정제·별칭 query 사용** — `search.ts:397-406` 구간

`buildSearchUrl`의 `query`와 `rerankAiHits`의 인자를 정제본으로 교체. `expandLawAbbreviation`은 이미 `import`되어 있음(line 2).

```ts
  // 자연어 원문을 법령 검색어로 정제(필러 제거) 후 약칭→정식명 확장.
  const distilled = expandLawAbbreviation(distillLawQuery(query));

  const json = await cachedGetJson(
    buildSearchUrl({ oc, target: "aiSearch", query: distilled, display, search: 0 }),
    "search_ai_law",
    TTL_SEARCH,
  );
  const hits = parseAiSearchList(json);
  if (hits.length === 0) return { refs: [], context: "", articles: [] };

  // 질의 기준 재정렬(내림차순)도 정제 query로 — 필러가 곁가지 조문을 띄우는 것 방지.
  const ordered = await rerankAiHits(distilled, hits);
```

- [ ] **Step 3: typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: 에러 0.

- [ ] **Step 4: 회귀 (정제가 라우팅·환각 회귀 없는지)**

Run: `node scripts/chat-smoke.mjs`
Expected: A 3건 `[regulation]`, B 4건 `[law]`·`halluc=false`, C `(refuse)`. 정제로 인해 B 법령 표시가 baseline 대비 개선(또는 동일). 라우팅 회귀 0.

- [ ] **Step 5: Commit**

```bash
git add lib/law/search.ts
git commit -m "feat(law): aiSearch query 정제(필러 제거)+약칭 확장 — 후보·재정렬 입력 정합 (ref: korean-law-mcp MIT)"
```

---

## Task 8: 결정론 결합점수 — 법령명 정합 + 법률우선 (트랙2)

**Files:**
- Modify: `lib/law/search.ts` (`searchAiLaw` 내 `ordered` 직후, grouping 전)

**Interfaces:**
- Consumes: `ordered`(rerank 결과), `distilled`(Task 7)
- Produces: `adjusted` — Cohere 점수에 법령명-키워드 정합·법률우선을 결합해 재정렬한 리스트. 이후 grouping·minScore는 `adjusted` 사용.

- [ ] **Step 1: 결합점수 계산 삽입** — `search.ts`에서 `const ordered = await rerankAiHits(distilled, hits);` 와 minScore 체크 사이에 추가하고, 이후 `ordered`를 `adjusted`로 치환

```ts
  // 출처 취지: chrisryugj/korean-law-mcp (MIT) scoreLawRelevance.
  // Cohere 의미점수에 결정론 신호를 결합한다 — 법령'명'이 정제 키워드를 포함하면 가점
  // (개념-법령 정합), 시행령/시행규칙은 본법 우선 위해 약한 감점(형제 타이브레이커).
  const kw = distilled.split(/\s+/).filter((w) => w.length >= 2);
  const adjusted = ordered
    .map(({ hit, score }) => {
      let s = score;
      if (kw.some((w) => hit.name.includes(w) || w.includes(hit.name.replace(/(법률|법|시행령|시행규칙)$/, "")))) {
        s += 0.15;
      }
      if (/시행령|시행규칙/.test(hit.name)) s -= 0.05;
      return { hit, score: s };
    })
    .sort((a, b) => b.score - a.score);
```

그리고 직후 minScore 체크와 grouping 루프의 `ordered`를 `adjusted`로 교체:

```ts
  if (adjusted.length === 0 || adjusted[0].score < minScore) {
    return { refs: [], context: "", articles: [] };
  }
  ...
  for (const { hit: h, score } of adjusted) {  // 기존 `of ordered`
```

- [ ] **Step 2: `minScore` 기본값 재설정** — `searchAiLaw` 시그니처(`search.ts:392`)

결합점수에 최대 +0.15가 더해지므로 floor를 소폭 올린다(노이즈 컷). 기본 `minScore = 0.02` → `minScore = 0.05`.

```ts
  minScore = 0.05,
```

- [ ] **Step 3: typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: 에러 0.

- [ ] **Step 4: 회귀 (기업회생 법령순위 역전 확인 — 핵심)**

Run: `node scripts/chat-smoke.mjs "기업회생 절차와 관련 법령대로 내가 진행해야 하는 내용을 알려줘"`
Expected: `[law]`, 표시 소스 1위가 **채무자 회생 및 파산에 관한 법률** (시행령 노이즈 조세특례·독점규제가 그 아래로). dev 콘솔 `[law] aiSearch:` 줄에서 채무자회생법이 최상위.

- [ ] **Step 5: 튜닝 (Task 6 측정 반영)** — 만약 Step 4에서 역전이 안 되면

- 개념 가점 `+0.15` → `+0.25`로 상향, 시행령 감점 `-0.05` → `-0.10`.
- 그래도 안 되면 `searchAiLaw` 호출부(`route.ts:224`)에서 `display`를 명시적으로 늘림: `searchAiLaw(query, 100)` (후보 풀 확대). Task 6 측정이 "후보 빈약"이었다면 이 쪽.
- 변경 후 Step 4 재실행. 8질의 전체 회귀(`node scripts/chat-smoke.mjs`)로 다른 B 질의(육아휴직·하도급·개인정보)가 퇴행하지 않는지 확인 — 특히 **정답이 시행령인 경우**(개인정보보호법 시행령) 부당 감점으로 본법만 남지 않는지.

- [ ] **Step 6: 전체 회귀**

Run: `node scripts/chat-smoke.mjs`
Expected: A 3 `[regulation]`, B 4 `[law]`·`halluc=false`, C refuse. 회귀 0.

- [ ] **Step 7: Commit**

```bash
git add lib/law/search.ts
git commit -m "feat(law): Cohere 점수에 법령명 정합+법률우선 결정론 결합 — 동음 시행령 노이즈 역전 (ref: korean-law-mcp MIT)"
```

---

## Task 9: 인용 score 하드코딩 제거 (M11, 트랙2 마무리)

**Files:**
- Modify: `app/api/chat/route.ts:288-298` (citationSources 구성)

**Interfaces:**
- Consumes: `citationCheck.verdicts`, `lawSources`(검색 관련도 보유)
- Produces: `citationSources[].score` — 하드코딩 1 대신 검색 관련도(없으면 0).

- [ ] **Step 1: lawId→검색관련도 맵으로 score 대체** — `route.ts:288-298`

`citationSources` 구성 직전에 맵을 만들고, `score: 1`을 맵 조회로 교체.

```ts
        // 인용 조문의 표시 관련도는 검색(lawSources)에서 끌어온다. 검색에 없던(모델이
        // 기억으로 인용한) 조문은 0 — "검증된 실존"과 "검색 근거"를 구분(과표기 방지, M11).
        const lawScoreById = new Map(
          lawSources.map((s) => [String((s.metadata as { lawId?: string }).lawId ?? ""), s.score]),
        );
        const citationSources: SourceChunk[] = (citationCheck?.verdicts ?? [])
          .filter((v) => v.status === "verified" && v.body)
          .map((v, i) => ({
            id: -(200 + i),
            title: v.lawName,
            source_ref: `법제처 국가법령정보 · 법령ID ${v.lawId ?? ""}`,
            content: formatArticle(v.article, v.articleTitle ?? "", v.body!),
            metadata: { kind: "law", lawId: v.lawId, article: v.article, cited: true },
            score: lawScoreById.get(String(v.lawId ?? "")) ?? 0,
          }));
```

- [ ] **Step 2: typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: 에러 0.

- [ ] **Step 3: 회귀 (과표기 해소)**

Run: `node scripts/chat-smoke.mjs B`
Expected: B 4건 `[law]`. 표시 소스 score가 더 이상 일괄 `1.00`이 아니라 실 관련도(또는 0). 라우트·환각 회귀 0.

- [ ] **Step 4: Commit**

```bash
git add app/api/chat/route.ts
git commit -m "fix(chat): 인용 참조문서 score 하드코딩(1.0) 제거 — 실 검색 관련도 표시 (M11)"
```

---

## 최종 검증 (전체 acceptance)

- [ ] **A: 전체 8질의 회귀**

Run: `node scripts/chat-smoke.mjs`
Expected:
- A 3건 → `[regulation]`, `src`에 `reg:`만
- B 4건 → `[law]`, `src`에 `law:`/관련 `precedent:`만, `halluc=false`, 기업회생 1위=채무자회생법
- C 1건 → `(refuse)`, `src=0`

- [ ] **B: baseline 대비 diff**

Run: `node scripts/chat-smoke.mjs > /tmp/after.txt; diff /tmp/baseline.txt /tmp/after.txt`
Expected: `ict 전담기관이란` law→regulation, 기업회생 법령순위 역전, 거짓 halluc 해소가 diff에 드러남.

- [ ] **C: 빌드 최종**

Run: `pnpm typecheck && pnpm build`
Expected: 에러 0.

---

## Self-Review (작성자 체크)

- **스펙 커버리지**: 4.1→Task1, 4.2→Task3, 4.3→Task2, 4.4→Task6·7·8, 4.5→Task4, 4.6→Task5, 4.7/M11→Task9, §5 측정게이트→Task6. 누락 없음.
- **타입 일관성**: `distillLawQuery`(Task7) ↔ `searchAiLaw`(Task7·8) 사용 일치. `adjusted`(Task8)가 `ordered`(Task7) 치환. `lawScoreById`(Task9)는 기존 `lawSources` 타입 사용.
- **플레이스홀더**: 없음. Task8 Step5는 "튜닝"이나 구체적 수치·조건·대안을 명시(측정 의존 항목은 의도적·근거 있음).
- **비결정 항목 1건**: Task8 가중치(±0.15/0.05)는 Task6 측정·Task8 Step4 회귀로 확정 — 플레이스홀더 아님, 실측 게이트로 닫음.
