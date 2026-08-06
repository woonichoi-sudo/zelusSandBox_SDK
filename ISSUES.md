# ISSUES.md — 발견된 문제 기록부

이 문서는 **작업 중 발견됐지만 그 작업의 범위에서 고치지 않은 문제**를 누적한다. 대상은 `backend/`·`frontend/`의 우리 코드이며(회사 저장소 `zelusSandBox_Cobalt/`의 엔진 버그는 `PROJECT_ANALYSIS.md` §9 소관이다), 목적은 "지금 당장 안 고치기로 한 것"이 조용히 잊히지 않게 하는 것이다. 기록자는 **고치지 않고 적기만 한다** — 해결 방향을 여러 개 적되 어느 쪽을 택할지는 결정하지 않고, `결정` 항목에 `미결`로 남긴다. 새 이슈는 이 문단 아래에 **번호 순서대로 덧붙이고**(위에서 아래로 오래된 것 → 최신), 아래 [이슈 목록](#이슈-목록) 표에도 한 줄을 추가한다. 각 이슈는 `## ISSUE-NNN — 제목` 헤딩과 `<a id="issue-NNN"></a>` 앵커를 갖고, 아래 템플릿의 8개 항목(상태 / 발견 / 영역 / 증상 / 원인 / 영향 범위 / 검토된 해결 방향 / 결정)을 모두 채운다. 서술은 `PROJECT_ANALYSIS.md`의 표기 규약을 따라 **[코드 확인]**(파일을 읽거나 실행해 검증한 것)과 **[추론]**(분석·예측)을 구분하고, 코드 참조는 저장소 루트(`d:\z-emotion\Cobalt`) 기준 상대경로로 `backend/src/server/index.ts:112` 형태로 적는다.

## 이슈 목록

| ID | 상태 | 제목 | 발견 | 영역 |
|---|---|---|---|---|
| [ISSUE-001](#issue-001) | 열림 | `Gateway.app` 게터로 등록한 라우트가 catch-all에 가려 도달 불가 | TASKS #4 (2026-08-06) | gateway |

---

<a id="issue-001"></a>

## ISSUE-001 — `Gateway.app` 게터로 등록한 라우트가 catch-all에 가려 도달 불가

- **상태**: 열림
- **발견**: 2026-08-06, TASKS.json #4 "HTTP 골격 + /api/health + 스모크 하네스"의 Tester 검증 중. **#4의 통과 기준(`서버 기동 → GET /api/health 200`) 자체는 PASS**다. 이 이슈는 그와 별개로, #5 이후 작업을 막는 구조 결함으로 함께 발견됐다.
- **영역**: gateway — `backend/src/server/index.ts`

### 증상

**[코드 확인]** `Gateway`를 기동한 뒤 공개 `app` 게터로 라우트를 추가하면 그 라우트에 요청이 도달하지 않는다.

```ts
const gw = createServer();
await gw.start();
gw.app.get('/api/__probe', (_req, res) => res.json({ ok: true }));
// GET /api/__probe → 404 (기대: 200)
```

실측 결과 **404**. 응답 본문은 `backend/src/server/index.ts:113`의 catch-all이 만드는 `{ error: "찾을 수 없음: GET /api/__probe" }` 형태다.

### 원인

**[코드 확인]** `backend/src/server/index.ts`를 읽어 확인했다. 미들웨어 등록 순서 문제다.

1. `backend/src/server/index.ts:56-61` — `constructor`가 `express()`로 앱을 만든 직후 `this.#configure(this.#app)`을 호출한다. 즉 **생성자가 끝나는 시점에 이미 배선이 전부 끝나 있다.**
2. `backend/src/server/index.ts:92-127` — `#configure`가 한 번에 다음을 등록한다:
   - `backend/src/server/index.ts:98` — `express.json()` 본문 파서
   - `backend/src/server/index.ts:100` — `/api/health` 라우트
   - `backend/src/server/index.ts:112` — **404 catch-all** (`app.use((req, res) => …)`, 경로 지정 없음 → 모든 요청에 매치)
   - `backend/src/server/index.ts:118` — 에러 핸들러 (인자 4개)
3. Express는 미들웨어를 **등록 순서대로** 평가하고, `backend/src/server/index.ts:112`의 catch-all은 경로 제한이 없으므로 여기 도달한 모든 요청을 **응답을 보내며 종료**한다. `next()`를 부르지 않으므로 뒤 스택으로 넘어가지 않는다.

따라서 생성자가 끝난 뒤 `app` 게터로 붙인 라우트는 **구조적으로 항상 catch-all 뒤에 놓이며, 어떤 요청으로도 실행될 수 없다.** 기동 전에 붙이든(`createServer()` 직후) 기동 후에 붙이든 결과는 같다 — 결정적인 것은 `start()` 시점이 아니라 `#configure`가 생성자에서 이미 끝났다는 사실이다.

### 모순 — 주석이 동작하지 않는 사용법을 안내한다

**[코드 확인]** `backend/src/server/index.ts:63-66`:

```ts
/** 라우트를 더 얹고 싶을 때. #5 이후 단위가 여기에 붙는다 */
get app(): Express {
  return this.#app;
}
```

주석은 `app` 게터를 **후속 단위의 확장 지점으로 명시**하고 있으나, 위 원인에 따라 그 사용법은 동작하지 않는다. 이 문서가 이 이슈를 "#4는 PASS인데도" 기록하는 이유가 여기 있다: **[추론]** 그대로 두면 #5를 맡는 다음 사람이 주석을 신뢰해 라우트를 붙이고 404를 만나며, 원인이 자기가 방금 쓴 핸들러가 아니라 골격의 미들웨어 순서에 있다는 걸 찾는 데 시간을 쓴다. 증상(404)이 "라우트를 잘못 등록했다"는 흔한 실수와 구분되지 않아 오진하기 쉽다.

### 영향 범위

**라우트를 추가하는 모든 후속 작업이 영향을 받는다.**

| 작업 | 내용 | 영향 |
|---|---|---|
| TASKS #5 | 씬 업로드 + 목록 (`POST/GET /api/scenes`) | **직접 영향.** 다음에 착수하는 단위다 |
| TASKS #10 | export + glTF 다운로드 (`GET /api/exports/:id`) | **직접 영향** |
| (미할당) | 정적 파일 서빙 | **[추론]** 프런트엔드 배포를 붙일 때 같은 문제를 만난다 |

**영향받지 않는 것**: TASKS #6 (WS 연결 = 세션 수명)은 `backend/src/server/index.ts:69-71`의 `server` 게터로 `http.Server`를 직접 잡아 업그레이드를 처리하므로, Express 미들웨어 스택을 지나지 않는다.

### 검토된 해결 방향

Tester가 제시한 두 가지. **아직 채택되지 않았다.**

1. **`#configure`를 쪼개고 마감을 `start()`로 미룬다.** "라우트 등록"과 "catch-all + 에러 핸들러 설치"를 분리해, 후자를 `start()` 시점에 실행한다. → `app` 게터가 `backend/src/server/index.ts:63`의 주석대로 동작하게 되고, 주석을 고칠 필요가 없다.
   - **[추론]** 고려할 점: `start()`가 두 번 불릴 때 마감이 중복 등록되지 않도록 막아야 하고(`backend/src/server/index.ts:131`의 조기 반환이 이미 있으므로 그 뒤에 두면 된다), `start()`를 거치지 않고 `app`만 꺼내 쓰는 경로가 생기면 catch-all이 영영 설치되지 않는다.
2. **후속 라우트를 `#configure` 안, catch-all 앞에 직접 등록한다.** 확장 지점을 게터가 아니라 `#configure` 본문으로 삼는다. → 구조 변경이 없는 대신 `backend/src/server/index.ts:63`의 주석이 거짓이 되므로 **주석을 반드시 고쳐야 한다.**
   - **[추론]** 고려할 점: 라우트 모듈이 늘어날수록 `#configure`가 비대해지고, `backend/src/server/files.ts`(#5·#10의 예정 파일) 같은 외부 모듈이 `Gateway` 내부에 하드와이어된다.

### 결정

**미결.** 메인 세션과 사용자가 결정한다. 결정되면 이 항목에 선택한 방향과 근거를 적고, 반영이 끝나면 상태를 `닫힘`으로 바꾼다.
