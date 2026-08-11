# SDK 사용법

`zelusSandBoxd` 헤드리스 워커를 Node에서 쓰는 방법. 손으로 돌려 보며 확인하는 용도다.

관련 문서: 빌드 함정은 [CLAUDE.md](CLAUDE.md), 설계는 [DESIGN.md](DESIGN.md), 알려진 결함은 [ISSUES.md](ISSUES.md), 작업 목록은 `TASKS.json`.

---

## 0. 전제

| | 경로 |
|---|---|
| 워커 exe | `backend/native/build/Release/zelusSandBoxd-demo.exe` |
| 씬 (가벼움) | `zelusSandBox_Cobalt/Zest/testing/sdk/sample.zls` — 103MB, 패턴 5개 |
| 씬 (실물) | `backend/data/incoming/W_Bra top & Leggings.zls` — 138MB, 패턴 24개 |

**exe가 없으면** 빌드한다 (증분 ~10초):

```bash
cmake --build backend/native/build --config Release
```

⚠️ 게이트웨이가 떠 있으면 exe가 잠겨 링크가 실패한다. 빌드 전에 내릴 것.
⚠️ 재구성이 트리거되면 PATH의 CMake 4.3.2 때문에 깨진다. 그때는 VS 번들 3.31.6을 전체 경로로 부른다 ([CLAUDE.md](CLAUDE.md) 참고).

**씬 두 개의 성격이 다르다:**

| | `sample.zls` | `W_Bra top & Leggings.zls` |
|---|---|---|
| 패턴 | 5개 | 24개 |
| 색 | **전부 흰색** `[1,1,1]` | 노랑 16개 · 민트 8개 |
| 드레이프 | 안 돼 있음 (펼쳐진 상태) | 돼 있음 |

**색·2D 배치를 보려면 `W_Bra` 쪽을 써야 한다.** `sample.zls`로는 재질 확인이 안 된다.

---

## 1. 예제 스크립트 — 가장 빠른 길

```bash
cd backend
node --experimental-strip-types tools/try-sdk.ts
node --experimental-strip-types tools/try-sdk.ts --scene sample --frames 30
```

`--scene bra|sample` · `--frames <n>` (기본 `bra`, 60프레임).

한 번 돌리면 지금까지 붙인 것이 한 화면에 나온다 — 패턴별 색, 직물 그룹, 2D 배치 좌표, glTF 익스포트.

<details>
<summary>실제 출력</summary>

```
씬     bra — ...\W_Bra top & Leggings.zls
프레임  30

세션 기동   169ms
엔진        Zelus 1.94.19 / Lumia 3.0.149
로드        2015ms
파라미터    timeStep=45 gravityY=-980 drapingTime=0.4 solverType=0
시뮬        30프레임 4252ms (도달 30)

패턴 24개 · 정점 13,398

  #  정점   색 (r,g,b)              직물 uuid        2D 배치 (x, y)
  ─────────────────────────────────────────────────────────────────
   0   252      0.925,    0.812,    0.471  35692489332290       9.03,     92.08
   3  1908      0.733,    0.886,    0.816  35692511685720      68.23,    129.75

직물 2종:
  356924893322900/1500000 → 패턴 16개
  356925116857200/1500000 → 패턴 8개

익스포트    ...\backend\data\try-sdk-bra.gltf  (4454ms)
```

</details>

`tools/try-sdk.ts`는 **테스트가 아니다.** 단언으로 회귀를 잡는 것은 `smoke.ts`이고, 이건 값을 사람이 읽으라고 찍는 물건이다. 주석 처리된 `setParams` 줄을 켜면 파라미터도 만져 볼 수 있다.

---

### 1-2. 아바타 체형 · 옷 사이즈 프로브 (L-3, 2026-08-11)

```bash
cd backend
node --experimental-strip-types tools/probe-avatar.ts    # 체형 29개 · 치수 25개
node --experimental-strip-types tools/probe-surface.ts   # 서피스 24개 크기
```

`try-sdk.ts` 와 **같은 성격이다** — 테스트가 아니라 사람이 값을 읽는 스크립트다. 각각 ① 읽기 → ② 쓰기 → ③ **glTF 해시로 지오메트리가 실제로 바뀌었는지** → ④ 잘못된 입력이 거절되는지를 찍는다.

★ ③이 이 두 프로브의 핵심이다. **되읽은 값이 맞다는 것과 지오메트리가 바뀌었다는 것은 다른 사실이고, 헤더로는 그 구분이 안 보인다.** 익스포트한 glTF 의 해시를 대조하면 갈린다 — 실제로 두 기능 모두 이 방법으로 "엔진이 진짜 반영한다" 를 확인했다.

**읽어 두면 좋은 실측값:**

| | 값 |
|---|---|
| 체형 | 29개, 정규화 **0~1** (사용자 씬은 전부 0.5). cm 가 아니다 |
| 치수 | 25개, **실제 cm** — 키 175.739 · 허리 61.647 · 가슴 85.119 · 힙 88.589 |
| 서피스 | 24개 — `pattern 2` = **23.673 × 9.739cm** (데스크톱 `Pattern` 패널의 Width/Height 와 일치) |

⚠️ **프로브가 씬 상태를 바꾼다.** 워커 프로세스 안에서만이고 `.zls` 는 안 건드리므로 프로세스가 끝나면 사라진다. 다만 **떠 있는 게이트웨이에 같은 op 을 손으로 쏘면 그 세션에는 남는다** — 그때는 되돌려 놓을 것.

## 2. 직접 코드 짜기

```ts
import { Session } from './src/sdk/index.ts';

const s = await Session.create({ exePath: EXE });   // 프로세스 기동 + Initialize
await s.load(ZLS);
await s.setParams({ drapingTime: 3 });               // ⚠️ start 전에
await s.start();
await s.waitForFrame(100);
await s.pause();

const mesh = await s.meshData(true);                 // true = 토폴로지 포함
const geo  = await s.geometry(true);                 // base64를 TypedArray로 풀어서
await s.export('out.gltf', 'gltf');
await s.dispose();
```

실행: `node --experimental-strip-types <파일>.ts`

### 공개 표면

```ts
export { Worker, WorkerError, type WorkerOptions } from './worker.ts';
export { Session, type SessionOptions, type DecodedPattern } from './session.ts';
export { SessionPool, PoolExhaustedError, type PoolOptions } from './pool.ts';
export * from './protocol.ts';
```

| 메서드 | 설명 |
|---|---|
| `Session.create(opts)` | 프로세스 기동 + ready 대기. `autoInit: false`로 `Initialize()` 생략 가능 |
| `load(path)` / `clear()` | 씬 열기 / 내리기 |
| `start()` `pause()` `reset()` `step()` | 재생 제어 (⚠️ `step`은 no-op — [ISSUE-015](ISSUES.md)) |
| `subscribe()` / `unsubscribe()` | frame 이벤트에 메시를 실을지 |
| `status()` | `loaded` `simInitialized` `mode` `frame` `maxFrame` `subscribed` |
| `getParams()` / `setParams(p)` | 시뮬 파라미터 22개 |
| `meshInfo()` | 패턴 목록 + 정점·삼각형 수 |
| `meshData(topology?)` | 지오메트리. `true`면 `indices`·`uvs`·`transform`·`transform2d`·`material` 포함 |
| `geometry(topology?)` | `meshData`를 TypedArray로 디코딩 |
| `export(path, 'gltf'\|'zbin')` | 지금 포즈를 파일로 |
| `waitForFrame(n, timeoutMs?)` | n프레임 도달까지 대기 |
| `dispose()` | 프로세스 종료 |

**이벤트**: `on('frame', (n, mesh?) => …)` · `on('engineMessage', (m) => …)` · `on('exit', (code) => …)`

### 세션 하나가 프로세스 하나다

`ZestManager`의 콜백과 시뮬 상태가 전부 `static`이라 **한 프로세스에 두 세션은 구조적으로 불가능하다.** 여러 씬을 동시에 다루려면 `SessionPool`로 프로세스를 여러 개 띄운다. 세션당 메모리 ~360MB.

---

## 3. 워커를 날것으로 — 프로토콜 확인용

```bash
printf '{"id":1,"op":"ping"}\n{"id":2,"op":"version"}\n{"id":3,"op":"quit"}\n' \
  | ./backend/native/build/Release/zelusSandBoxd-demo.exe --serve
```

JSON Lines다. 한 줄에 요청 하나, 응답도 한 줄.

**op 18개**: `ping` `version` `init` `load` `clear` `start` `pause` `reset` `step` `subscribe` `unsubscribe` `status` `getParams` `setParams` `meshInfo` `meshData` `export` `quit`

CLI 모드도 있다 (프로토콜 없이 한 방에):

```bash
zelusSandBoxd-demo.exe --load scene.zls --frames 100 --export out.gltf
```

---

## 4. 웹 화면으로

```bash
cd backend  && npm run serve    # 게이트웨이 :3000
cd frontend && npm run dev      # Vite :5173
```

브라우저에서 `localhost:5173`.

- 씬 선택 → **[로드]** → **[▶ 재생]**
- 아래 가운데 **"펼침" 슬라이더** → 3D ↔ 2D 재단 도면 모핑
- **[🧍 스냅샷]** → 아바타 + 진짜 색 (⚠️ **시뮬을 돌린 뒤에** 찍어야 옷이 입혀진다)
- 왼쪽 아래 **파라미터 패널** → 슬라이더 22개

---

## 5. 테스트

| 명령 | 위치 | 건수 | GPU |
|---|---|---|---|
| `npm run smoke` | `backend` | 73 | ❌ |
| `npm run smoke:server` | `backend` | 373 | ❌ |
| `npm run smoke` | `frontend` | 702 | ❌ |
| `npm run verify:ui` | `frontend` | 200 | ✅ **필요** |
| `npm run sweep:params` | `backend` | 측정 도구 (~6분) | ❌ |

`verify:ui`는 게이트웨이(3000)와 Vite(5173)가 **떠 있어야** 한다 — 하네스가 서버를 안 띄운다.

⚠️ **한 번에 하나씩 돌릴 것.** 이 머신에서 여러 개를 몰아 돌리면 불안정하다.

---

## 6. 함정 (실측으로 확인된 것)

**⚠️ `load`가 파일 형식을 검증하지 않는다.** 14바이트짜리 아무 텍스트나 넘겨도 `loaded: true`를 준다. 없는 파일만 실패한다. 깨진 파일을 넘기면 성공 응답을 받고 빈 화면을 본다.

**⚠️ `setParams`는 `start` 전에 걸어야 하고, 22개가 다 살아 있지 않다.**

| 분류 | 수 | 필드 |
|---|---|---|
| 반영됨 | 17 | `timeStep` `drapingTime` `gravityY` `groundMargin` `useWind` `solverType` `preconditioner` `nonlinearIterations` `maxSolverIterations` `solverTolerance` `useIEQS` `staticCouplingMethod` `dynamicCouplingMethod` `dynCouplingStiffness` `dynCouplingDamping` `untanglingStiffness` `untanglingDamping` |
| 조건부 | 3 | `windMagnitude`(`useWind` 필요) · `groundPlane` `groundFriction`(바닥에 닿는 씬 필요) |
| **죽음** | 2 | **`subStep`** · **`meshingEdgeLength`** — 값은 걸리는데 물리가 안 본다 |

`getParams`는 쓴 값을 정확히 되돌려주므로 **왕복만으로는 죽은 필드를 알 수 없다.** 전수 측정 결과가 [ISSUE-014](ISSUES.md)에 있다.

**⚠️ 익스포트는 시뮬을 돌린 뒤에.** 찍는 순간의 포즈를 담는다. 로드 직후 찍으면 패턴이 펼쳐진 채로 나오고, 이걸 모르면 "익스포트가 깨졌다"고 오진한다.

**⚠️ 솔버는 결정적이지만 `reset`은 아니다.** 같은 파라미터로 **재로드**해서 돌리면 정점이 비트 단위로 같다. 그런데 같은 워커에서 `reset` 뒤 재실행하면 평균 0.50cm 어긋난다. **결과를 비교하는 실험은 [로드]로 시작할 것.**

**⚠️ `status.frame`을 화면에 쓰지 말 것.** 정지 중에는 `-1`이 온다. `maxFrame`을 쓴다.

**⚠️ `clear` 뒤에도 `status.loaded`가 `true`로 남는다.** 로드된 적 있는 세션에서는 영원히 참이다.

**⚠️ `uvs`만으로 2D 도면을 그릴 수 없다.** 패턴 로컬 좌표라 24개가 원점에 겹친다. `transform2d`(행 우선 3×3)를 곱해야 한다 — `wx = m[0]x + m[1]y + m[2]`. [ISSUE-018](ISSUES.md).

**⚠️ 3D `transform`과 2D `transform2d`는 다른 값이다.** 전자는 패턴 로컬 → 3D 월드(TRS), 후자는 패턴 로컬 → 2D 도면(3×3).

**⚠️ 프로세스가 무작위로 죽는 계열이 셋 있다** ([ISSUE-007](ISSUES.md) `0xC0000409` · [ISSUE-013](ISSUES.md) 워커 `code 4001` · [ISSUE-016](ISSUES.md) `npm run build` rollup 파서 panic). **끊긴 회차를 통과로 세지 말고 재실행할 것.**
