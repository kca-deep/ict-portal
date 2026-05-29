# 08. 팀 협업 운영 가이드 (Git/GitHub + Claude Code)

> 본 문서는 작성 시점(2026-05-29)의 의사결정 결과이며, 운영 중 발견되는 개선점에 따라 갱신한다.
> 대상: 2인 개발팀(소유자 `kca-deep`, 협업자 `bcchung81`)이 단일 repo `kca-deep/ict-portal`에서 Claude Code + GitHub plugin으로 작업.

---

## 1. 목표와 원칙

- **충돌 0이 목표가 아니다.** "작고 자주" 만나서 빠르게 해결하는 흐름을 만든다.
- **자동화로 인적 실수를 차단한다.** 빌드 깨진 코드, 리뷰 안 받은 코드는 자동으로 막힌다.
- **두 Claude Code 인스턴스가 동일 규칙으로 동작한다.** 규칙은 사람이 외우는 게 아니라 `CLAUDE.md`에 기록한다.
- **로컬에서 충돌을 해결한다.** GitHub 웹 UI의 conflict editor는 빌드/테스트가 불가능하므로 사용하지 않는다.

---

## 2. 팀 구성 및 신원

| 역할 | GitHub 핸들 | git user.email | git user.name | 비고 |
|---|---|---|---|---|
| Repo 소유자 | `kca-deep` | `kcajarvis@gmail.com` | `kca` | Branch Protection 설정 권한 보유 |
| 협업자 | `bcchung81` | `bcchung81@gmail.com` | `bcchung81` | Collaborator 초대 필요 |

- **Repo URL**: https://github.com/kca-deep/ict-portal
- **Origin remote**: `https://github.com/kca-deep/ict-portal.git`
- **메인 브랜치**: `main`

---

## 3. Phase 0 — 사전 준비 (각자 1회만)

### 3.1 Git 신원 설정

**본인 (`bcchung81`)** — 완료 ✅

```powershell
git config --global user.name "bcchung81"
git config --global user.email "bcchung81@gmail.com"
```

**동료 (`kca-deep`)** — 확인 필요

```powershell
git config --global user.name
git config --global user.email
```

→ `kca` / `kcajarvis@gmail.com` 이면 그대로 유지. 다른 값이면 위 명령으로 통일.

### 3.2 Repo 접근 권한

1. **동료가 본인을 collaborator로 초대**
   - https://github.com/kca-deep/ict-portal/settings/access
   - "Add people" → `bcchung81` 입력 → "Add bcchung81 to this repository"
2. **본인이 초대 수락**
   - `bcchung81@gmail.com`으로 도착한 GitHub 초대 메일 → "Accept invitation"
3. **본인 로컬 repo 동기화**
   ```powershell
   git fetch origin
   git status
   ```

### 3.3 Claude Code + GitHub plugin

양쪽 모두 다음을 1회 확인:

```
/plugin
```

→ GitHub plugin이 설치 상태로 표시되면 OK. `gh` CLI 인증도 함께 확인:

```powershell
gh auth status
```

→ 미인증 상태면 `gh auth login` 실행.

### 3.4 VSCode 권장 확장

두 사람 모두 동일하게 설치 (포맷/린트 결과 일치를 위해):

- **Prettier - Code formatter** (`esbenp.prettier-vscode`)
- **ESLint** (`dbaeumer.vscode-eslint`)
- **EditorConfig for VS Code** (`EditorConfig.EditorConfig`)
- **GitLens** (선택, 충돌 시 시각화에 유용)

---

## 4. Phase 1 — 협업 파일 세팅 (협업자가 1회 PR로)

**담당**: `bcchung81`이 PR 생성 → `kca-deep`이 리뷰/머지
**브랜치명**: `chore/team-collaboration-setup`

다음 7개 파일을 한 PR에 묶어 생성/수정한다.

### 4.1 `.gitattributes` — Windows 줄바꿈 정규화 ⭐ 최우선

```
* text=auto eol=lf

*.{js,jsx,ts,tsx,json,md,yml,yaml,css,html,sql} text eol=lf
*.{png,jpg,jpeg,gif,ico,webp,pdf,woff,woff2,hwpx} binary
*.sh text eol=lf
*.ps1 text eol=crlf
```

**효과**: 두 Windows PC 사이에서 CRLF/LF 차이로 발생하는 phantom 충돌을 차단한다.

적용 후 1회 실행 (각자 로컬에서):

```powershell
git add --renormalize .
git commit -m "chore: normalize line endings"
```

### 4.2 `.editorconfig` — 에디터 일관성

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

### 4.3 `.vscode/settings.json` — 워크스페이스 공통 설정

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
  },
  "typescript.tsdk": "node_modules/typescript/lib",
  "eslint.workingDirectories": [{ "mode": "auto" }]
}
```

### 4.4 `.github/workflows/ci.yml` — PR 자동 검증

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
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile

      - name: Lint
        run: pnpm run lint

      - name: Type check
        run: pnpm exec tsc --noEmit

      - name: Build
        run: pnpm run build
        env:
          # 빌드 시점 환경변수가 필요하면 여기에 더미값 또는 GitHub Secret 주입
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY || 'sk-dummy-for-build' }}
          DATABASE_URL: ${{ secrets.DATABASE_URL || 'postgres://dummy' }}
```

> **참고**: 실제 환경변수 매핑은 빌드 실패 메시지를 보고 최소한으로 추가. 비밀값은 Repo Settings → Secrets and variables → Actions 에 등록.

### 4.5 `.github/CODEOWNERS` — 자동 리뷰어 지정

```
# 전체 변경은 두 사람 모두에게 리뷰 요청
*  @kca-deep @bcchung81

# 영역 분담 예시 (실제 분담은 협의 후 조정)
# /app/**            @bcchung81
# /lib/db/**         @kca-deep
# /lib/ai/**         @bcchung81
# /python/**         @kca-deep
# /docs/**           @kca-deep @bcchung81
```

### 4.6 `.github/pull_request_template.md` — PR 템플릿

```markdown
## 변경 사항
-

## 변경 의도 / 배경
-

## 테스트 방법
- [ ] 로컬에서 어떻게 검증했는가
- [ ] 영향 받는 화면/엔드포인트는 무엇인가

## 체크리스트
- [ ] `pnpm run lint` 통과
- [ ] `pnpm exec tsc --noEmit` 통과
- [ ] `pnpm run build` 통과
- [ ] `main` 최신 상태 머지 완료
- [ ] 새 환경변수가 있다면 `.env.example` 업데이트
- [ ] DB 스키마 변경이 있다면 단독 PR로 분리했는가

## 관련 이슈
Closes #
```

### 4.7 `CLAUDE.md`에 "Git 협업 규칙" 섹션 추가

`CLAUDE.md` 끝부분에 아래 섹션을 추가한다. 두 Claude Code 인스턴스가 동일하게 동작하도록 만드는 핵심.

````markdown
## Git 협업 규칙

이 repo는 2인 협업(`kca-deep`, `bcchung81`)이며 main 브랜치는 보호되어 있다. 아래 규칙을 반드시 따른다.

### 브랜치 전략

- `main`에 직접 push 금지. 모든 작업은 feature 브랜치에서.
- 브랜치 네이밍:
  - `feat/<scope>-<짧은-설명>` — 새 기능
  - `fix/<scope>-<짧은-설명>` — 버그 수정
  - `chore/<짧은-설명>` — 빌드/설정/잡일
  - `docs/<짧은-설명>` — 문서만 변경
  - `refactor/<scope>-<짧은-설명>` — 동작 변화 없는 리팩토링
- 예: `feat/advisor-citation-check`, `fix/crawler-encoding`
- 작업 시작 전 항상: `git checkout main && git pull --ff-only && git checkout -b <new-branch>`
- 브랜치 수명 최대 2일. 그 이상이면 작업을 더 잘게 쪼갠다.

### 커밋

- Conventional Commits (한국어 메시지 허용).
- 한 커밋 = 한 가지 논리적 변경.
- 형식: `type(scope): 메시지`
  - 예: `feat(advisor): 인용 검증 모듈 추가`
  - 예: `fix(rag): 임베딩 차원 불일치 수정`

### Push 전 검증 (필수)

```powershell
pnpm run lint
pnpm exec tsc --noEmit
pnpm run build
```

세 명령 모두 통과한 뒤에만 push. 실패 시 push 보류.

### PR 생성

- GitHub plugin 또는 `gh pr create`로 생성.
- 본문은 `.github/pull_request_template.md`를 따른다.
- Reviewer는 CODEOWNERS가 자동 지정 — 별도 지정 불필요.
- **사용자가 명시적으로 요청하기 전에는 PR을 merge하지 않는다.**

### main 동기화

- 매일 작업 시작 시: `git fetch origin && git merge origin/main`
- PR 올리기 직전: 동일하게 실행 후 충돌 해결.
- 충돌 발생 시 로컬에서 해결 → 빌드 3종 통과 확인 → push.

### 금지 사항

- `git push --force` (사용자가 명시적으로 요청한 경우에만).
- `main`에 amend / rebase.
- `--no-verify`로 hook 우회.
- `node_modules/`, `.env`, `.env.local`, `.DS_Store`, `*.log` 커밋.

### 작업 시작 전 권장 절차

1. GitHub Issue로 작업 항목 등록 (assignee를 본인으로 지정).
2. 같은 영역을 동료가 만지고 있는지 Issue 목록으로 확인.
3. 브랜치 생성 후 작업 시작.
````

### 4.8 PR 절차

1. 본인이 위 7개 변경을 `chore/team-collaboration-setup` 브랜치에 커밋.
2. `gh pr create` 또는 Claude Code에서 "이 변경을 PR로 올려줘" 요청.
3. 동료가 리뷰 → Merge (Squash and merge 권장).
4. 머지 후 Phase 2로 진행.

---

## 5. Phase 2 — Branch Protection Rule (소유자 `kca-deep`이 1회)

웹에서만 설정 가능. **소유자(`kca-deep`)가 진행**.

### 5.1 경로

https://github.com/kca-deep/ict-portal/settings/branches → **"Add branch protection rule"**

### 5.2 옵션

- **Branch name pattern**: `main`
- ☑ **Require a pull request before merging**
  - ☑ Require approvals: **1**
  - ☑ Dismiss stale pull request approvals when new commits are pushed
  - ☑ Require review from Code Owners
- ☑ **Require status checks to pass before merging**
  - ☑ Require branches to be up to date before merging
  - Status check 검색 → `verify` 선택 (Phase 1의 CI job 이름)
- ☑ **Require conversation resolution before merging**
- ☑ **Do not allow bypassing the above settings**
- ☐ Allow force pushes — **체크 해제** (기본)
- ☐ Allow deletions — **체크 해제** (기본)

→ **Create** 클릭.

### 5.3 효과

- 누구도 main에 직접 push 불가 (소유자 포함).
- CI 깨진 PR은 merge 버튼 비활성화.
- 리뷰 1명 승인 없으면 merge 불가.
- 리뷰 코멘트가 미해결 상태면 merge 불가.

---

## 6. 일상 워크플로우

### 6.1 작업 시작 시 (매일)

```powershell
git checkout main
git pull --ff-only
git checkout -b feat/<scope>-<설명>
```

또는 Claude Code에 자연어로:
> "main 최신화하고 `feat/advisor-citation-check` 브랜치 만들어줘"

### 6.2 코딩 중

- 한 가지 논리적 변경이 끝날 때마다 커밋.
- 하루 1회 이상 main 흡수:
  ```powershell
  git fetch origin
  git merge origin/main
  ```

### 6.3 Push 전

```powershell
pnpm run lint
pnpm exec tsc --noEmit
pnpm run build
```

세 명령 모두 통과해야 push.

### 6.4 PR 생성 → 리뷰 → Merge

1. **PR 생성**
   ```powershell
   gh pr create
   ```
   또는 Claude에 "현재 브랜치 PR로 올려줘".
2. **CI 결과 확인** — PR 화면에 `verify ✅` 떠야 함.
3. **동료 리뷰 요청** — CODEOWNERS가 자동 지정. 별도 메시지/카톡으로 알려도 좋음.
4. **리뷰 코멘트 반영** — 추가 커밋 push하면 PR에 자동 반영.
5. **Merge** — 사용자가 직접 "merge" 클릭 (Squash and merge 권장).
6. **로컬 정리**
   ```powershell
   git checkout main
   git pull --ff-only
   git branch -d feat/<scope>-<설명>
   ```

### 6.5 충돌 발생 시 절차

```powershell
# 1. 자기 브랜치에서 main 흡수 시도
git fetch origin
git merge origin/main

# 2. 충돌 파일 확인
git status

# 3. VSCode에서 충돌 파일 열기 → "Accept Current" / "Accept Incoming" / "Accept Both" 또는 수동 편집
#    Claude에 "충돌 해결해줘"라고 요청해도 됨

# 4. 해결 후 빌드 3종 검증
pnpm run lint
pnpm exec tsc --noEmit
pnpm run build

# 5. 해결 커밋 후 push
git add .
git commit -m "merge: main 반영 및 충돌 해결"
git push
```

**충돌은 GitHub 웹에서 해결하지 않는다.** 빌드/테스트 불가하기 때문.

---

## 7. Claude Code + GitHub Plugin 활용 패턴

GitHub plugin 설치 후 사용 가능한 자연어 요청 예시:

| 상황 | 자연어 예시 |
|---|---|
| PR 생성 | "현재 브랜치 PR로 올려줘. 본문은 PR 템플릿 따라줘" |
| PR 조회 | "지금 열린 PR 목록 보여줘" |
| PR 상태 확인 | "내가 올린 PR #12의 CI 결과 알려줘" |
| CI 실패 분석 | "PR #12 CI가 왜 실패했는지 로그 확인해줘" |
| 리뷰 코멘트 | "PR #12의 `app/page.tsx:42`에 변수명 이슈로 리뷰 코멘트 달아줘" |
| 이슈 작성 | "공모사업 크롤러 인코딩 이슈로 GitHub Issue 만들어줘. 내가 assignee" |
| 작업 분배 확인 | "지금 동료가 작업 중인 이슈/PR 알려줘" |
| 최근 변경 추적 | "최근 main에 머지된 PR 5개 요약해줘" |
| 충돌 해결 | "현재 브랜치 main과 충돌나는 부분 해결해줘" |

### 주의

- **Claude가 merge를 자동 수행하지 않도록** CLAUDE.md에 명시되어 있다. 사용자가 직접 merge 클릭.
- **민감 정보(토큰/키)는 plugin을 통해서도 노출 금지**. PR 본문이나 Issue에 절대 적지 않는다.

---

## 8. 충돌 예방 운영 습관

1. **PR은 작게, 빨리.** 100~300줄 이하, 가능하면 하루 안에 머지.
2. **작업 시작 전 영역 공유.** GitHub Issue로 자기 작업을 등록하고 assignee 지정. 같은 파일을 동시에 만지지 않도록.
3. **하루 1회 main 흡수.** 자기 브랜치에서 `git merge origin/main`. 충돌이 쌓이기 전에 작게 해결.
4. **DB 스키마 변경은 단독 PR.** ICT기금 RAG의 `regulation` 테이블, 향후 공모사업 테이블 등 스키마 변경은 절대 기능과 같이 묶지 않는다.
5. **대규모 리팩토링은 사전 합의.** 100파일 이상 변경되는 작업은 Issue로 먼저 논의.
6. **`pnpm-lock.yaml` 동시 수정 회피.** lock 파일은 충돌 시 처음부터 다시 만드는 게 빠르다 (`pnpm install` 재실행).

---

## 9. 트러블슈팅

### 9.1 `! [rejected] main -> main (non-fast-forward)`

원인: 원격 main이 내 로컬보다 앞서있음.
해결: 절대 force push하지 말 것. 보호된 main에선 어차피 막힘.

```powershell
git pull --rebase origin main
```

### 9.2 PR 화면에 "This branch has conflicts that must be resolved"

원인: 내 브랜치와 main 충돌.
해결: 로컬에서 6.5 절차로 해결.

### 9.3 `pnpm install` 후 lock 파일이 통째로 바뀜

원인: pnpm 버전 차이 또는 registry 차이.
해결: 양쪽 모두 `pnpm` 9.x 사용 확인 (`pnpm -v`). CI도 동일 버전.

### 9.4 "Permission denied" / push 실패

원인: collaborator 초대 미수락 또는 GitHub 인증 만료.
해결:
```powershell
gh auth status
gh auth login   # 만료된 경우
```

### 9.5 줄바꿈만 다른데 파일 전체가 변경으로 표시

원인: `.gitattributes` 미적용 상태에서 작업.
해결:
```powershell
git rm --cached -r .
git reset --hard
git add --renormalize .
git commit -m "chore: renormalize line endings"
```

### 9.6 GitHub Actions가 실행되지 않음

원인: `.github/workflows/ci.yml`이 main에 아직 머지 안 됨 (Actions는 머지된 워크플로우만 실행).
해결: Phase 1 PR을 먼저 머지.

---

## 10. 단계별 체크리스트

### Phase 0 — 사전 준비

- [x] 본인 git user.name / user.email 설정 (`bcchung81` / `bcchung81@gmail.com`)
- [ ] 동료 git user.name / user.email 확인
- [ ] 동료가 본인을 collaborator로 초대
- [ ] 본인이 초대 수락
- [ ] 양쪽 GitHub plugin 설치 확인 (`/plugin`)
- [ ] 양쪽 `gh auth status` 인증 확인
- [ ] 양쪽 VSCode 권장 확장 설치

### Phase 1 — 협업 파일 PR (`bcchung81` 담당)

- [ ] `chore/team-collaboration-setup` 브랜치 생성
- [ ] `.gitattributes` 작성
- [ ] `.editorconfig` 작성
- [ ] `.vscode/settings.json` 작성
- [ ] `.github/workflows/ci.yml` 작성
- [ ] `.github/CODEOWNERS` 작성
- [ ] `.github/pull_request_template.md` 작성
- [ ] `CLAUDE.md`에 "Git 협업 규칙" 섹션 추가
- [ ] PR 생성 + 동료 리뷰 + Squash Merge

### Phase 2 — Branch Protection (`kca-deep` 담당)

- [ ] Settings → Branches → Add rule
- [ ] Branch pattern `main`
- [ ] Required PR + 1 approval + Code Owners + status check `verify` + conversation resolution + no bypass
- [ ] Create 클릭

### Phase 3 — 안정화 확인

- [ ] 더미 PR 1개 만들어 CI 통과 확인
- [ ] 충돌 시뮬레이션 1회 (양쪽이 같은 파일 동시 수정 → 해결)
- [ ] 일주일 운영 후 본 문서 업데이트

---

## 11. 다음 단계

- 본 가이드를 두 사람 모두 1회 정독.
- Phase 0의 collaborator 초대부터 시작.
- Phase 1 PR이 머지되면 즉시 Phase 2 진행.
- 운영 중 발견되는 마찰점은 본 문서에 추가하여 다음 회차 협업에 반영.
