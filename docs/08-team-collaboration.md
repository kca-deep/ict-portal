# 08. 팀 협업 운영 가이드 (PoC 라이트 버전)

> 본 문서는 작성 시점(2026-05-29)의 의사결정 결과이며, 운영 중 마찰점에 따라 점진적으로 강화한다.
> 대상: 2인 PoC 팀(소유자 `kca-deep`, 협업자 `bcchung81`)이 `kca-deep/ict-portal`에서 Claude Code + GitHub plugin + `gh` CLI로 작업.

---

## 1. 운영 철학

- **속도 우선.** PoC 단계에선 형식주의보다 빠른 반복이 중요하다.
- **최소 자동화로 phantom 충돌만 차단.** Windows 줄바꿈, 포맷 차이, 깨진 빌드 — 이 3가지만 자동으로 막는다.
- **실제 사고가 나면 그때 규칙 강화.** 선제적 규제는 PoC 비용.
- **두 Claude Code 인스턴스가 동일 규칙으로 동작.** `CLAUDE.md` 짧게 공유.

---

## 2. 팀 신원

| 역할 | GitHub 핸들 | git email | git user.name |
|---|---|---|---|
| Repo 소유자 | `kca-deep` | `kcajarvis@gmail.com` | `kca` |
| 협업자 | `bcchung81` | `bcchung81@gmail.com` | `bcchung81` |

- **Repo**: https://github.com/kca-deep/ict-portal
- **메인 브랜치**: `main`

---

## 3. 채택 / 보류 항목

### ✅ 채택 (PoC도 비용 대비 효과 큼)

1. `.gitattributes` — Windows LF/CRLF 정규화
2. `.editorconfig` + `.vscode/settings.json` — 에디터 일관성
3. `.github/workflows/ci.yml` — 빌드 + 타입체크 자동 검증 (정보용)
4. `CLAUDE.md` "Git" 짧은 섹션 — 두 Claude 일관 동작
5. **Branch Protection 최소판** — `main` 직접 push 차단, CI 통과는 권장(필수 아님)

### ⏸ 보류 (운영 확장 시점에 도입)

- `CODEOWNERS` — 2인이라 굳이 자동 지정 불필요
- PR 템플릿 — 직접 본문 작성으로 충분
- 1명 승인 강제 — 한 명 자리비움 시 작업 마비 방지
- Conversation resolution 강제
- Issue-first 워크플로우

→ 도입 시점 가이드는 §9 참조.

---

## 4. 적용 절차 (1회)

### 4.1 협업 파일 PR — `bcchung81` 담당

브랜치 `chore/team-setup`에 다음 4개 파일을 묶어 PR 생성.

#### `.gitattributes`

```
* text=auto eol=lf

*.{js,jsx,ts,tsx,json,md,yml,yaml,css,html,sql} text eol=lf
*.{png,jpg,jpeg,gif,ico,webp,pdf,woff,woff2,hwpx} binary
*.sh text eol=lf
*.ps1 text eol=crlf
```

→ 적용 후 1회 실행:
```powershell
git add --renormalize .
git commit -m "chore: normalize line endings"
```

#### `.editorconfig`

```
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false

[*.ps1]
end_of_line = crlf
```

#### `.vscode/settings.json`

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit"
  },
  "files.eol": "\n",
  "files.insertFinalNewline": true,
  "files.trimTrailingWhitespace": true,
  "[markdown]": {
    "files.trimTrailingWhitespace": false
  }
}
```

#### `.github/workflows/ci.yml`

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec tsc --noEmit
      - run: pnpm run build
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY || 'sk-dummy-for-build' }}
          DATABASE_URL: ${{ secrets.DATABASE_URL || 'postgres://dummy' }}
```

> Lint는 일부러 제외. PoC 단계엔 type/build 통과만으로 충분. 필요 시 후일 추가.

#### `CLAUDE.md`에 추가할 "Git" 섹션

````markdown
## Git

이 repo의 사용자는 Git에 익숙하지 않으며 **단축 명령**을 통해 작업한다. 사용자가 다음 표현을 쓰면 정의된 절차를 한 번에 실행한다. 단축 명령 외 일반 코드 작업은 평소대로 처리.

### 단축 명령 매핑

**"git pull해줘" / "최신화해줘" / "땡겨줘"**
1. `git status`로 현재 브랜치 확인.
2. `git fetch origin`.
3. main 브랜치면 `git pull --ff-only`.
4. 작업 브랜치면 `git merge origin/main`.
5. 충돌 발생 시 **자동 해결하지 않는다.** 충돌 파일 목록을 보고하고 사용자에게 "충돌 해결해줘"라고 시켜달라고 안내.

**"새 작업: <설명>" / "새 브랜치 <설명>"**
1. `git checkout main && git pull --ff-only`.
2. 설명에서 브랜치명 추론 (`feat/<scope>-<설명>` 등). 사용자에게 확정 받기.
3. `git checkout -b <branch>`.

**"git push해줘" / "올려줘" / "PR 올려줘"**
1. `git status` 확인.
2. 미커밋 변경이 있으면: 변경 내용 분석 후 Conventional Commits 메시지 제안. 사용자 확정 후 `git commit`.
3. `pnpm run build` 실행. **실패 시 즉시 중단**하고 오류 보고. push 강행 금지.
4. 원격 추적 브랜치 없으면 `git push -u origin HEAD`, 있으면 `git push`.
5. 같은 브랜치 PR 없으면 `gh pr create` 또는 GitHub MCP로 생성. 본문은 커밋 메시지 기반.
6. PR URL 보고.

**"충돌 해결해줘"**
1. `git status`로 충돌 파일 목록 확인.
2. 각 파일을 읽고 양쪽 변경 의도 파악 후 해결. 단순 병합으로 안 되면 사용자에게 옵션 제시.
3. `pnpm run build` 통과 확인.
4. `git add <files> && git commit -m "merge: main 반영"`.
5. **"이제 'git push해줘'라고 시키면 됩니다"** 라고 안내.

**"PR 머지해줘"**
1. PR 번호와 머지 의사 한 번 더 확인 (실수 방지).
2. `gh pr merge <#> --squash --delete-branch`.
3. `git checkout main && git pull --ff-only`로 로컬 동기화.
4. 다음 작업 가능 상태 보고.

**"CI 결과" / "빌드 상태"**
1. `gh pr checks` 또는 GitHub MCP로 현재 PR 상태 조회.
2. 실패 시 `gh run view --log-failed`로 로그 분석 후 요약 보고.

### 규칙

- 머지는 사용자가 명시 요청해야만 실행. **자동 머지 금지.**
- `git push --force`, `--no-verify`, main에 amend/rebase 금지.
- 사용자가 비전문가임을 전제로, 에러 발생 시 **다음 액션을 명확히 안내.**
- 단축 명령 중 어느 단계에서 실패해도 다음 단계로 진행 금지 — 사용자에게 즉시 보고.
- Conventional Commits (한국어 메시지 허용).
````

### 4.2 Branch Protection — `kca-deep` 담당 (1회, 웹에서)

https://github.com/kca-deep/ict-portal/settings/branches → **Add branch protection rule**

- **Branch name pattern**: `main`
- ☑ Require a pull request before merging
  - ☐ Require approvals (체크 안 함 — PoC 라이트)
- ☑ Require status checks to pass before merging
  - ☑ Require branches to be up to date before merging
  - Status check 검색 → `verify` 선택 (체크 안 해도 됨, 권장)
- ☐ Require conversation resolution (체크 안 함)
- ☑ Do not allow bypassing the above settings (선택사항)
- **Create** 클릭

→ 효과: main에 직접 push만 막힘. PR을 통한 머지는 누구든 셀프 가능.

### 4.3 `gh` CLI 설치 (양쪽 모두 권장)

```powershell
winget install --id GitHub.cli
gh auth login
# → GitHub.com → HTTPS → Login with web browser → 코드 입력 → 완료
```

---

## 5. 일상 워크플로우

### 5.0 단축 명령 — 사용자가 외울 6가지

비전문가 사용자가 외울 것은 다음뿐. 나머지(빌드 검증, 커밋, push, PR 생성, 머지, main 동기화)는 Claude가 자동 처리한다.

| 사용자 입력 (자연어) | Claude 동작 |
|---|---|
| **"git pull해줘"** / "최신화" | 현재 브랜치 기준 origin 동기화. 충돌 발견 시 보고만, 자동 해결 안 함. |
| **"새 작업: <설명>"** | main 최신화 → 브랜치명 제안 → 확정 후 생성. |
| **"git push해줘"** / "올려줘" | (필요 시 커밋) → 빌드 검증 → push → PR 생성 → URL 보고. 빌드 실패 시 즉시 중단. |
| **"충돌 해결해줘"** | 충돌 파일 분석 + 해결 + 빌드 검증 + 머지 커밋. 끝나면 "다시 'git push해줘' 시키세요" 안내. |
| **"PR 머지해줘"** | 사용자 확인 → squash merge + 브랜치 삭제 + 로컬 main 동기화. |
| **"CI 결과"** | 현재 PR의 빌드 상태 조회. 실패 시 로그 요약. |

### 5.0.1 가장 흔한 시나리오

**A. 아침에 시작**
> "git pull해줘"
> "새 작업: 챗봇 응답 인용 검증 추가"

**B. 작업 마무리**
> "git push해줘"
→ 빌드 통과하면 PR URL 받음 → "PR 머지해줘"

**C. 중간에 충돌**
"git pull해줘" 했더니 Claude가 "충돌 났습니다. 충돌 해결해줘 시키세요"라고 보고
> "충돌 해결해줘"
→ 해결 완료 보고 → "git push해줘"

### 5.1 작업 시작
```powershell
git checkout main
git pull --ff-only
git checkout -b feat/<scope>-<짧은-설명>
```

또는 Claude에 자연어로:
> "main 최신화하고 `feat/advisor-citation-check` 브랜치 만들어줘"

### 5.2 작업 중
- 한 커밋 = 한 가지 논리적 변경
- 하루 1회 이상 main 흡수:
  ```powershell
  git fetch origin && git merge origin/main
  ```

### 5.3 Push 전
```powershell
pnpm run build
```
→ 통과해야 push.

### 5.4 PR → 머지

본인의 코드면 그냥 셀프 머지:
```powershell
gh pr create
gh pr checks   # CI 결과 확인
gh pr merge --squash --delete-branch
```

동료 의견을 받고 싶으면 카톡/메모로 "PR #N 봐줘"라고 알리고 의견 반영 후 머지.

### 5.5 충돌 발생 시
```powershell
git fetch origin
git merge origin/main
# VSCode에서 충돌 파일 해결 → 저장
pnpm run build   # 검증
git add .
git commit -m "merge: main 반영 및 충돌 해결"
git push
```

→ **GitHub 웹 conflict editor 사용 금지** (빌드/테스트 불가).

---

## 6. Claude Code + GitHub Plugin 사용 패턴

### 자주 쓰는 자연어

| 상황 | Claude에 시키기 |
|---|---|
| 브랜치 생성 + 작업 시작 | "main 최신화하고 `feat/...` 브랜치 만들어줘" |
| 커밋 | "지금 변경분 커밋해줘. 메시지는 `feat(scope): ...`" |
| PR 생성 | "현재 브랜치 PR로 올려줘" |
| CI 상태 확인 | "내 PR #N CI 결과 보여줘" |
| CI 실패 분석 | "PR #N CI 실패 원인 로그 분석해줘" |
| 충돌 해결 | "main과 충돌나는 부분 해결해줘" |
| PR 머지 | "PR #N squash merge하고 브랜치 삭제해줘" |
| 동료 PR 리뷰 | "PR #N 변경사항 요약하고 우려사항 알려줘" |

### `gh` CLI 자주 쓰는 명령

```powershell
gh pr create                              # PR 생성 (대화형)
gh pr list                                # 열린 PR 목록
gh pr view                                # 현재 브랜치 PR 조회
gh pr view 1 --web                        # PR을 브라우저로 열기
gh pr checks                              # 현재 브랜치 CI 상태
gh pr merge --squash --delete-branch      # squash 머지 + 브랜치 삭제
gh pr edit 1 --add-reviewer kca-deep      # 리뷰어 추가
gh pr review 1 --approve --body "LGTM"    # 승인 (남의 PR만)
gh run list                               # 최근 Actions 실행 목록
gh run view <run-id> --log-failed         # 실패 로그 조회
```

### 인증 주체

Claude Code는 **현재 로그인된 GitHub 계정**으로 동작:
- `bcchung81` PC의 Claude → `bcchung81`로 인증 → 자기 PR approve 불가, 머지/생성/조회는 가능
- `kca-deep` PC의 Claude → `kca-deep`으로 인증 → 동일

→ 본인 PR을 본인이 승인할 일은 없으므로 실무엔 문제 없음.

---

## 7. 충돌 예방 운영 습관

1. **PR은 작게.** 100~300줄 권장. 하루 안에 머지.
2. **작업 영역 사전 공유.** 카톡으로 "지금 `lib/db/search.ts` 만집니다" 한 줄.
3. **하루 1회 main 흡수.** 충돌이 쌓이기 전 작게 해결.
4. **DB 스키마 변경은 단독 PR.** `regulation` 테이블 등 스키마 변경은 기능과 묶지 않음.
5. **`pnpm-lock.yaml` 동시 수정 회피.** 충돌 시 `pnpm install` 재실행이 빠름.

---

## 8. 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `! [rejected] main -> main (non-fast-forward)` | 원격이 앞서있음 | `git pull --rebase origin main` (force push 금지) |
| 줄바꿈만 다른데 전 파일이 변경으로 표시 | `.gitattributes` 미적용 | `git add --renormalize . && git commit` |
| Push 시 "Permission denied" | 인증 만료 또는 미초대 | `gh auth status` → 필요 시 `gh auth login` |
| GitHub Actions가 실행되지 않음 | `ci.yml`이 main에 미머지 | Phase 1 PR 먼저 머지 |
| PR 화면에 "This branch has conflicts" | 내 브랜치 ↔ main 충돌 | §5.5 절차로 로컬 해결 |
| `pnpm install` 후 lock 파일 통째 변경 | pnpm 버전 차이 | 양쪽 모두 `pnpm 9.x` 확인 (`pnpm -v`) |

---

## 9. 운영 강화 트리거

다음 상황이 실제로 발생하면, 해당 규칙을 추가한다.

| 사고 / 마찰 | 도입할 규칙 |
|---|---|
| 빌드 깨진 코드가 main에 머지됨 | CI를 **required** status check로 승격 |
| 한 명이 모르게 main이 바뀜 | Branch Protection에 **1명 승인 강제** 추가 |
| 영역이 자주 겹쳐 충돌 발생 | `CODEOWNERS` 도입으로 영역 분담 자동화 |
| PR 정보 부족으로 리뷰 어려움 | PR 템플릿 도입 |
| 누가 무엇을 하는지 모름 | Issue-first 워크플로우 도입 |
| 외부 인원 참여 | 위 모든 규칙 + 코드 사이닝 + Required reviewer |

→ 강화 후 본 문서 4장(채택 항목)을 갱신.

---

## 10. 체크리스트

### Phase 0 (완료/확인)

- [x] 본인 git user 신원: `bcchung81` / `bcchung81@gmail.com`
- [x] 동료 collaborator 초대 수락
- [ ] 양쪽 `gh auth status` 인증 확인
- [ ] 양쪽 VSCode Prettier/ESLint/EditorConfig 확장 설치 (선택)

### Phase 1 (`bcchung81` PR로 1회)

- [ ] `chore/team-setup` 브랜치 생성
- [ ] 4개 파일 작성: `.gitattributes`, `.editorconfig`, `.vscode/settings.json`, `.github/workflows/ci.yml`
- [ ] `CLAUDE.md` "Git" 섹션 추가
- [ ] PR 생성 → 머지 (셀프 머지 OK)

### Phase 2 (`kca-deep` 1회, 웹)

- [ ] Settings → Branches → Add rule
- [ ] `main`에 PR 요구 + (선택) status check `verify`
- [ ] 1명 승인 요구는 **체크 안 함**
- [ ] Create

### Phase 3 (확인)

- [ ] 더미 PR 1개로 CI가 실행되는지 확인
- [ ] 운영 시작 — 사고/마찰 발생 시 §9 트리거로 점진적 강화
