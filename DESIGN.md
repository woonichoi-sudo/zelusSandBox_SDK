# 웹 서비스 설계

> 작성일: 2026-08-06
> 대상: `zelusSandBox_Cobalt`를 헤드리스 exe + Node 백엔드 + 웹 프론트엔드로 재구성
> 표기: **[실측]** = 이 환경에서 직접 측정 · **[확인]** = 코드/실행으로 검증 · **[예정]** = 미구현 설계

전수 조사는 [`PROJECT_ANALYSIS.md`](./PROJECT_ANALYSIS.md), 빌드·함정은 [`CLAUDE.md`](./CLAUDE.md)를 참고한다.

---

## 목차

1. [목표와 현재 상태](#1-목표와-현재-상태)
2. [전체 구조](#2-전체-구조)
3. [측정된 사실](#3-측정된-사실)
4. [결정 사항과 근거](#4-결정-사항과-근거)
5. [C++ 워커](#5-c-워커)
6. [Node 백엔드](#6-node-백엔드)
7. [웹 프론트엔드](#7-웹-프론트엔드)
8. [데이터 흐름](#8-데이터-흐름)
9. [미해결 사항](#9-미해결-사항)
10. [구현 순서](#10-구현-순서)

---

## 1. 목표와 현재 상태

데스크톱 앱의 UI 기능 68개(조작 62 + 표시 6)를 브라우저에서 그대로 쓴다.

### 완료

| 계층 | 상태 |
|---|---|
| C++ 헤드리스 워커 | **완료** — GL 없이 로드·시뮬·익스포트, JSON Lines 프로토콜 |
| Node SDK | **완료** — 프로세스 관리, 프로토콜, 세션 풀 |
| Node 게이트웨이 | 미착수 |
| 웹 프론트엔드 | 미착수 |

### 하드 제약

`zelusSandBox_Cobalt`는 **읽기 전용**이다. 회사 저장소이며 수정·브랜치·커밋을 하지 않는다.
헤드리스 빌드는 아웃오브트리로, 저장소 소스를 절대경로로 참조해 컴파일한다.

---

## 2. 전체 구조

```
브라우저                    Node 백엔드                  C++ 워커
────────                    ───────────                  ────────
three.js 3D 뷰   ◄── WS ──► 세션 브리지      ◄─ stdio ─► zelusSandBoxd.exe
three.js 2D 뷰                세션 풀                      └ ZestManager
파라미터 패널     ◄─ HTTP ─► 파일 업/다운로드              └ Zest/Zelus/Lumia

  WS   : 제어(JSON) + 지오메트리(바이너리)
  HTTP : .zls 업로드, glTF 다운로드, 정적 파일
  stdio: JSON Lines (stdin 요청 / stdout 응답·이벤트 / stderr 로그)
```

```
d:\z-emotion\Cobalt\
├── PROJECT_ANALYSIS.md      전수 조사
├── CLAUDE.md                빌드 함정, 아키텍처 요약
├── DESIGN.md                이 문서
├── zelusSandBox_Cobalt\     회사 repo (읽기 전용)
├── backend\
│   ├── native\              C++ 헤드리스 워커 (아웃오브트리)
│   │   ├── CMakeLists.txt
│   │   ├── engine\          데모용 엔진(라이선스 OFF) 빌드 정의
│   │   └── src\             main.cpp, protocol.cpp
│   └── src\
│       ├── sdk\             프로세스 관리 + 프로토콜  ← 완료
│       └── server\          Express + ws              ← 예정
└── frontend\                Vite + three.js           ← 예정
```

**계층을 나누는 이유**: SDK는 서버 없이도 쓸 수 있어야 한다. 배치 작업을 CLI나 다른 서비스에서
돌릴 때 게이트웨이를 거칠 이유가 없다. 서버는 SDK의 소비자일 뿐이다.

---

## 3. 측정된 사실

설계 판단의 근거다. 모두 Release 빌드, `sample.zls`(103MB), 패턴 5개 기준.

### 기동과 로드 **[실측]**

| 구간 | 시간 |
|---|---|
| 프로세스 기동 + DLL 48개 로드 | ~110 ms |
| `Initialize()` (머티리얼 폴더) | 측정 오차 수준 |
| 씬 로드 | ~830 ms |
| **콜드 스타트 합계** | **~940 ms** |

### 메모리 **[실측]**

| 시점 | WorkingSet | Private |
|---|---|---|
| 기동 직후 | 6.6 MB | 5.3 MB |
| `init` 후 | 24.8 MB | 9.8 MB |
| `load` 후 | 247.7 MB | 257.9 MB |
| 시뮬 중 | 353.3 MB | 364.1 MB |
| **`clear` 후** | **44.2 MB** | **23.9 MB** |
| 재로드 후 | 259.4 MB | 267.9 MB |

**씬 메모리는 `clear`로 거의 전부 반납된다.** 누수 없음.

### 시뮬레이션과 지오메트리 **[실측]**

| 항목 | 값 |
|---|---|
| 20프레임 + glTF 익스포트 (Release) | 4 초 |
| 같은 작업 (Debug) | 25 초 |
| 프레임별 메시 추출 비용 | 0.03 ~ 0.10 ms |
| 정점 / 삼각형 | 3,022 / 5,472 |
| 프레임당 positions (base64) | ~49 KB |
| SDK 지오메트리 취득 (토폴로지 포함) | 18 ms |

### 좌표계 **[확인]**

`GetSimulationOutputMesh()`가 주는 메시는 **3D 드레이프**다. 헤더 주석의 "2D design space"는
실제와 다르다. 그리고 같은 메시의 `uvs`가 **cm 단위 2D 패턴 좌표**다.

| 패턴 | 3D 폭 | 2D 폭(UV) | 높이 (3D / 2D) |
|---|---|---|---|
| 앞판 | 20.5 | 27.8 | 96.4 / 96.8 |
| 옆판 | 20.2 | 40.2 | 97.3 / 99.8 |
| 허리밴드 | 32.0 | 75.2 | 11.2 / 10.7 |

2D 폭이 항상 넓다 — 평면 패턴이 몸을 감싸며 좁아지기 때문이다. 높이는 거의 일치한다.

**따라서 2D 펼침 뷰는 추가 데이터 없이 구현된다.** 같은 `indices`에 위치만 `vertices` → `uvs`로 바꾼다.

---

## 4. 결정 사항과 근거

### 4.1 세션 = 프로세스 1개 (선택 불가)

`ZestManager`의 콜백 8개와 `MainGUI`의 시뮬 상태가 전부 `static`이다. 한 프로세스에 두 세션은
구조적으로 불가능하다. 제약이 아니라 **설계 자산으로 수용한다** — 크래시 격리, 메모리 격리,
세션 종료 = 프로세스 종료.

### 4.2 프로세스는 요청 시 기동

콜드 스타트 940ms 중 **830ms가 씬 로드**다. 사용자가 어떤 `.zls`를 열지 미리 알 수 없으므로
웜 풀로도 이걸 줄이지 못한다. 웜 풀이 아끼는 건 기동 110ms뿐이고, 대가로 풀 관리·유휴 정리·
헬스 체크가 붙는다.

**기본은 요청 시 기동, 세션 종료 시 프로세스 종료.**

### 4.3 세션 수명은 하나의 축으로 노출

"항상 켜둘지 / 요청 때 켤지"는 환경마다 답이 다르다. SDK가 정책을 강제하지 않는다.

```ts
new SessionPool({ idleTimeout: 0 })         // 세션 끝나면 즉시 종료 (기본)
new SessionPool({ idleTimeout: 300_000 })   // 5분 놀면 종료
new SessionPool({ idleTimeout: Infinity })  // 계속 켜둠
```

유휴로 돌릴 때 **자동으로 `clear`**를 걸어 씬 메모리(약 340MB)를 반납한다. 유휴 프로세스는
24MB만 쓴다.

추가 노브:

| 옵션 | 목적 |
|---|---|
| `maxIdle` | 유휴 프로세스 상한 |
| `maxTotal` | 동시 인스턴스 상한 = **라이선스 인스턴스 수** |
| `maxLifetime` | 연결이 살아 있어도 강제 회수 (방치된 탭 대비) |

**메모리는 `clear`로 풀리지만 라이선스는 풀리지 않는다.** 유휴 유지의 실질 비용은 메모리가
아니라 라이선스다.

### 4.4 인터랙티브는 WebSocket, 파일은 HTTP

| | 담당 |
|---|---|
| WebSocket | 세션 제어, 파라미터, 프레임 이벤트, 지오메트리 |
| HTTP | `.zls` 업로드, glTF 다운로드, 정적 파일 |

WebSocket을 고르는 결정적 이유는 대역폭이 아니다(폴링도 같은 양이 오간다).
**연결 자체가 세션 수명 신호**라는 점이다 — 연결이 끊기면 세션 종료이므로, §4.2의
"언제 프로세스를 죽이나"가 자동으로 풀린다. 폴링이면 하트비트를 따로 만들어야 한다.

배치 작업만 필요하면 HTTP만으로도 되지만, 목표가 데스크톱 UI 재현이라 인터랙티브가 본질이다.

### 4.5 지오메트리 스트리밍 (픽셀 스트리밍 아님)

`PROJECT_ANALYSIS.md` §10.3의 비교에서 지오메트리 스트리밍을 택한다. 근거는 검증됐다:

- 서버에 **GL 컨텍스트가 불필요**하다 (Windows 서비스 배포의 최대 난제가 소멸)
- 카메라 조작이 클라이언트에서 끝난다 (마우스 조작 5개 중 3개가 서버를 안 거침)
- 2D 뷰가 원래 벡터다
- 프레임당 36 KB(raw) — 30fps에서 1.1 MB/s

**대가**: Lumia의 화질(LTC 면광원, SH irradiance, PCSS 그림자)은 재현되지 않는다. 이는
three.js든 Babylon이든 마찬가지이며 별개 프로젝트 규모다.

### 4.6 three.js

압도적 우위가 아니라 이 프로젝트에 맞는 이유가 있다:

1. **데이터가 그대로 꽂힌다** — SDK가 주는 `Float32Array`를 `BufferAttribute`에 바로 넣는다. 변환 계층 없음
2. **exe가 glTF를 뱉는다** — 배치 결과를 `GLTFLoader`로 그냥 연다. 텍스처까지 따라온다
3. **안 쓰는 걸 안 들고 온다** — 물리·애니메이션 상태머신·씬 직렬화가 필요 없다. 물리는 C++이, 씬은 `.zls`가 담당

팀에 Babylon 경험자가 있으면 그쪽이 낫다. 결정적 선택은 아니다.

### 4.7 데모용 / 배포용 빌드 분리

| 빌드 | 엔진 | 라이선스 |
|---|---|---|
| `zelusSandBoxd-demo.exe` | 소스 빌드 (`ZELUS_USE_LICENSING=OFF`) | 불필요 |
| `zelusSandBoxd.exe` | SDK 프리빌드 (`ON`) | **필요** |

`USE_SDK_ENGINE` CMake 플래그 하나로 갈린다. **C++ 소스는 동일**하다 — 이 성질을 유지해야
두 빌드가 갈라지지 않는다. 라이선스는 환경변수 `ZELUS_SDK_LICENSE_FILE`로 주입하므로
코드 변경이 없다.

⚠️ 데모용은 라이선싱을 끈 엔진이다. 사내 데모는 무방하나, 외부에 exe를 배포하는 형태라면
회사 라이선싱 정책 확인이 필요하다. 웹으로 보여주는 형태(서버는 사내)라면 문제되지 않는다.

---

## 5. C++ 워커

### 5.1 구성 **[확인]**

저장소에서 가져다 컴파일하는 소스(수정 없음):

```
zelusSandBox/ZestManager.cpp     엔진 파사드 — 유일한 경계면
zelusSandBox/Util.cpp
zelusSandBox/core/*.cpp          패브릭·u3m·xtex 파서, 머티리얼 매니저
zelusSandBox/scene/*.cpp         glTF 익스포터, Draco
```

제외: `MainGUI`, `Renderer3D/2D`, `PaintInterface2D`, `Seam2DRenderer`,
`imgui_impl_glfw_gl3`, `main.cpp`, `Camera*Controlls` — 전부 GL/ImGui 계층.

`MainGUI`는 ImGui 배선일 뿐 로직이 없으므로 **옮기지 않고 버린다.**

### 5.2 반드시 지킬 것 **[확인]**

- **`Initialize()`를 건너뛰지 말 것.** 생략하면 `LoadZls`가 세그폴트한다 (머티리얼 폴더 트리 의존)
- **`glew32d.dll`이 필요하다.** `Lumia.dll`이 하드 의존하므로 GL 컨텍스트를 안 만들어도
  DLL 로드에 필요하다. 없으면 `0xC0000135`
- **`STB_IMAGE_IMPLEMENTATION`을 직접 제공해야 한다.** 데스크톱은 nanovg가 주던 심볼이다
- **stdout을 오염시키지 말 것.** 저장소 코드가 `std::cout`으로 사람용 메시지를 찍는다.
  프로토콜 모드에서 `cout`을 stderr로 돌리고 stdout을 따로 쥔다

### 5.3 프로토콜 (JSON Lines)

```
stdin  요청 1줄 = JSON 객체 1개
stdout 응답과 이벤트. JSON만 나간다
stderr 사람이 읽는 로그
```

**요청** — `{"id":1,"op":"load","path":"..."}`

| op | 인자 | 비고 |
|---|---|---|
| `ping` | | |
| `init` | | 필수. 로드 전에 한 번 |
| `load` | `path` | |
| `clear` | | 씬 메모리 반납 |
| `start` / `pause` / `reset` / `step` | | |
| `status` | | |
| `getParams` / `setParams` | `params` | 모르는 키는 `unknown`으로 되돌려줌 |
| `meshInfo` | | 통계 + 변경 여부 |
| `meshData` | `topology` | 지오메트리 |
| `export` | `path`, `format` | `gltf` / `zbin` |
| `quit` | | |

**응답** — `{"id":1,"ok":true,"result":{...}}` 또는 `{"id":1,"ok":false,"error":"..."}`

**이벤트** (id 없음) — `ready` / `frame` / `engineMessage`

### 5.4 메시 추출 경로 **[확인]**

데스크톱 렌더러와 동일하다 (`Renderer3D.cpp:768`):

```
ztDesignClothPattern::GetSimulationOutputMesh()
  → ztChangeTracker<ztDesignTriMesh>
      .QueryForUpdate(listener)   리스너별 변경 추적 — 엔진 내장
      .Read().vertices            프레임마다 변함  ← 이것만 보내면 된다
      .Read().normals             프레임마다 변함
      .Read().indices / .uvs      토폴로지. 프레임 간 고정 — 1회만
```

⚠️ **`zsVector3`는 SIMD 정렬로 16바이트다.** float 3개(12바이트)가 아니다. 그대로 보내면
프론트엔드에서 4바이트씩 밀려 형체가 깨진다. C++에서 `float3`로 재포장해 보낸다.

### 5.5 예정 작업 **[예정]**

| 항목 | 내용 |
|---|---|
| 바이너리 채널 | base64 대신 raw 바이너리. 33% 감소 + 파싱 제거 |
| `subscribe` op | 프레임마다 메시를 밀어주는 모드. 지금은 클라이언트가 요청 |
| 디자인 2D 데이터 | `GetSurfaces`, `GetCurvesInSurface` 등을 노출 (§7.3) |
| 파라미터 확대 | 현재 22개. 솔버 튜너블은 총 81개 |

---

## 6. Node 백엔드

### 6.1 SDK (완료)

```
backend/src/sdk/
├── protocol.ts   요청/응답/이벤트 타입 + base64 → TypedArray
├── worker.ts     프로세스 spawn, 줄 프레이밍, id 상관, 크래시 처리
├── session.ts    고수준 API + 유휴/수명 추적
├── pool.ts       세션 수명 정책
└── smoke.ts      스모크 테스트 (18건 통과)
```

```ts
await pool.withSession(async (session) => {
  await session.load('sample.zls');
  await session.setParams({ gravityY: -500 });
  await session.start();
  await session.waitForFrame(100);
  const geo = await session.geometry(true);   // Float32Array
});
```

`withSession`은 예외가 나도 `finally`에서 반납하므로 프로세스가 새지 않는다.

**worker.ts가 처리하는 것**: 요청·응답 `id` 상관, 이벤트 분리, 프로세스 사망 시 대기 중인
요청 일괄 reject(조용히 매달리면 게이트웨이가 영원히 기다린다), 타임아웃.

### 6.2 게이트웨이 **[예정]**

```
backend/src/server/
├── index.ts      Express + HTTP 서버 + WS 업그레이드
├── sessions.ts   WS 연결 ↔ 세션 매핑
├── bridge.ts     메시지 라우팅, 백프레셔
└── files.ts      업로드/다운로드
```

**HTTP 엔드포인트**

| 메서드 | 경로 | 용도 |
|---|---|---|
| `POST` | `/api/scenes` | `.zls` 업로드 |
| `GET` | `/api/scenes` | 씬 목록 |
| `GET` | `/api/exports/:id` | glTF 다운로드 |
| `GET` | `/*` | 정적 파일 (프로덕션) |

**WebSocket** — `/ws`

연결 = 세션이다. 연결 시 `pool.acquire()`, 종료 시 `pool.release()`.

클라이언트 → 서버: 프로토콜 op을 그대로 중계한다(화이트리스트 검증 후).
서버 → 클라이언트:

| 종류 | 형식 |
|---|---|
| 응답·이벤트 | JSON 텍스트 프레임 |
| 지오메트리 | **바이너리 프레임** — 헤더 + `Float32Array` |

**백프레셔**: 프레임 이벤트가 브라우저보다 빠를 수 있다. `ws.bufferedAmount`가 임계값을
넘으면 중간 프레임을 버리고 **최신 것만 보낸다**(latest-wins). 시뮬 속도와 전송 속도를 분리한다.

### 6.3 설정

| 항목 | 기본값 |
|---|---|
| `exePath` | `backend/native/build/Release/zelusSandBoxd-demo.exe` |
| `idleTimeout` | `0` (즉시 종료) |
| `maxTotal` | 환경에 맞게. 라이선스 인스턴스 수와 직결 |
| `maxLifetime` | 30분 |
| `ZELUS_SDK_LICENSE_FILE` | 배포용 빌드에서만 |

---

## 7. 웹 프론트엔드 **[예정]**

```
frontend/
├── index.html
├── vite.config.ts
└── src/
    ├── protocol/    백엔드와 공유하는 타입 + WS 클라이언트
    ├── viewer3d/    three.js 드레이프 뷰
    ├── viewer2d/    펼친 패턴 뷰
    ├── panels/      데스크톱 10개 패널 대응
    └── session/     연결·상태 관리
```

### 7.1 3D 뷰

```ts
// 최초 1회 — 토폴로지
geometry.setIndex(new THREE.BufferAttribute(indices, 1));
geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

// 매 프레임 — 위치만
positionAttr.array.set(newPositions);
positionAttr.needsUpdate = true;
```

카메라 조작(회전·팬·줌)은 **전부 클라이언트에서 끝난다.** 서버 왕복이 없다.

### 7.2 2D 펼침 뷰

같은 `indices`에 위치를 `uvs`로 바꾸면 된다. 정사영 카메라를 쓴다.

`vertices`와 `uvs`를 보간하면 **3D ↔ 2D 모핑**이 나온다. 옷이 펼쳐졌다 입혀지는 연출로,
데모에서 효과가 크다.

### 7.3 디자인 기반 2D (2단계)

데스크톱 2D 뷰는 더 풍부하다 — 베지어 커브, 노치, 그레인라인, 시접, 봉제선, 버튼.
이는 메시가 아니라 디자인 엔티티라 프로토콜 확장이 필요하다(§5.5).

렌더링은 **SVG**가 자연스럽다. 원래 nanovg 벡터 드로잉이다.

참고: 데스크톱 2D는 호버·선택 렌더링이 하드코딩으로 꺼져 있고 뷰 옵션 ~130개가 컴파일
기본값에 동결돼 있다(`PROJECT_ANALYSIS.md` §5.6). **웹에서 새로 만드는 편이 낫다.**

### 7.4 패널 구성

데스크톱의 `CollapsingHeader` 10개와 1:1 대응한다.

| 패널 | 조작 수 | 비고 |
|---|---|---|
| Operation | 3 + 표시 3 | Start/Pause, Reset, Clear |
| File | 4 | Load/Save/Export |
| General | 7 | timestep, gravity, draping time |
| Solver | 8 | |
| Collision | 19 | 가장 많다 |
| DrapingBoard | 3 | |
| Avatar | 1 | |
| Pattern | 4 | |
| RenderOption | 4 | **서버에 안 보냄** — 클라이언트 토글 |
| Help | 표시 3 | |

⚠️ **`solverType` 필드 충돌에 주의.** 데스크톱은 "solver type"(적분기)과 "Collision solver"가
같은 필드에 쓴다(`PROJECT_ANALYSIS.md` §9 ①). 충돌 솔버를 노출할 때 이 버그를 옮기지 말 것.

---

## 8. 데이터 흐름

### 인터랙티브

```
브라우저          백엔드                  워커
   │                │                      │
   ├─ WS 연결 ─────►│                      │
   │                ├─ pool.acquire() ────►│  프로세스 기동 (~110ms)
   │                │                      ├─ init
   ├─ load ────────►├─────────────────────►│  씬 로드 (~830ms)
   │◄── ok ─────────┤◄─────────────────────┤
   ├─ setParams ───►├─────────────────────►│
   ├─ start ───────►├─────────────────────►│
   │                │◄── frame 이벤트 ─────┤  (~25 fps)
   │                ├─ meshData ──────────►│  추출 0.03~0.10ms
   │◄─ 바이너리 ────┤◄─────────────────────┤  36 KB/프레임
   │  (latest-wins) │                      │
   ├─ WS 종료 ─────►├─ pool.release() ────►│  프로세스 종료
```

### 배치

```
POST /api/jobs {scene, params, frames}
   → pool.withSession(...)
       load → setParams → start → waitForFrame(N) → export
   → 결과 URL 반환, 프로세스 즉시 반납
```

작업이 몇 초라 요청을 붙잡고 있어도 된다. 길어지면 job ID + 폴링으로 바꾼다.

---

## 9. 미해결 사항

| # | 항목 | 영향 |
|---|---|---|
| 1 | **라이선스 미확보** | 배포용 빌드 검증 불가. 동시 인스턴스 조건 확인 필요 — **동접 = 인스턴스 수** |
| 2 | **동시 인스턴스 미측정** | 세션 N개 동시 구동 시 CPU·메모리 실측 필요. 메모리는 세션당 360MB로 계산 가능하나 CPU가 먼저 막힐 가능성 |
| 3 | Lumia 화질 미재현 | LTC 면광원, SH irradiance, PCSS. 별개 프로젝트 규모 |
| 4 | 디자인 기반 2D | 프로토콜 확장 필요 (§5.5) |
| 5 | 그래빙 (Ctrl+드래그) | 왕복 지연 체감. v1 제외 검토 |
| 6 | 파라미터 22 / 81 | 나머지 노출은 필요에 따라 |
| 7 | GPU 솔버 | CUDA 빌드가 미완성. v1은 CPU 전용 |
| 8 | 배포 형태 | Windows 워커 필요. Linux 이식은 Zest가 작업 대상(`PROJECT_ANALYSIS.md` §11) |

---

## 10. 구현 순서

| 단계 | 내용 | 검증 |
|---|---|---|
| ~~1~~ | ~~C++ 헤드리스 워커~~ | ~~완료~~ |
| ~~2~~ | ~~Node SDK~~ | ~~완료 (스모크 18건)~~ |
| **3** | **게이트웨이** — Express + ws, 세션 브리지 | `wscat`으로 왕복 |
| 4 | 프론트엔드 골격 — Vite + three.js, WS 연결 | 3D 뷰에 옷이 뜬다 |
| 5 | 2D 펼침 뷰 + 모핑 | uv 좌표 그대로 사용 |
| 6 | 파라미터 패널 | 슬라이더 → 실시간 반영 |
| 7 | 바이너리 채널 전환 | base64 제거 |
| 8 | 배치 모드 + 동시 인스턴스 측정 | 서버 사양 확정 |

3단계까지 가면 브라우저에서 처음으로 옷이 보인다. 그 지점이 데모의 최소 형태다.
