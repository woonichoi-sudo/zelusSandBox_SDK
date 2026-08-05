# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 이 워크스페이스의 목적

`zelusSandBox_Cobalt`(Windows 데스크톱 의류 물리 시뮬레이션 SDK 데모 앱)를 **헤드리스 exe + Go 게이트웨이/SDK + 웹 UI**로 재구성해, 데스크톱 UI의 기능 68개를 브라우저에서 그대로 쓰는 것이 목표다.

현재 상태: **조사 완료, 구현 미착수.** 헤드리스 실행이 아직 검증되지 않았다(§12.7).

```
d:\z-emotion\Cobalt\
├── CLAUDE.md
├── PROJECT_ANALYSIS.md      전수 조사 보고서 (2,178줄) — 아래 "참조" 참고
├── zelusSandBox_Cobalt\     회사 repo — 읽기 전용
├── gateway\                 (예정) Go: 워커 수퍼비전 + WebSocket + SDK
└── web\                     (예정) TS: three.js 3D + SVG 2D
```

## ⛔ 하드 제약 — `zelusSandBox_Cobalt`는 읽기 전용

**이 디렉토리 안의 파일을 수정하거나, 브랜치를 만들거나, 커밋하지 말 것.** `z-emotion/zelusSandBox_Cobalt`(master, 커밋 1개)인 회사 저장소이고 서브모듈 3개(Zest, Lumia, vcpkg)를 물고 있다. 사용자가 명시적으로 지시했다.

따라서 헤드리스 빌드는 **아웃오브트리**여야 한다 — 저장소 밖의 CMake 프로젝트에서 소스를 절대경로로 참조해 컴파일하고 프리빌드 SDK를 링크한다. 저장소 안에는 아무것도 쓰지 않는다.

**대가**: `PROJECT_ANALYSIS.md` §12.5가 제안한 GL 3줄 우회([core/zwMaterialManager.cpp:2088](zelusSandBox_Cobalt/zelusSandBox/core/zwMaterialManager.cpp#L2088))를 적용할 수 없다. 유일하게 살아있는 GL 호출이 그대로 남으므로 런타임에서 우회해야 한다(아래 참고).

## 빌드

전제(README): Visual Studio 2022, **CMake ≤ 3.31**, Git LFS.

### CMake 버전 함정

PATH의 CMake는 4.3.2인데 이걸 쓰면 vcpkg 포트(baseline `acffd148`, 2025-03-04)가 `Compatibility with CMake < 3.5 has been removed`로 깨진다. **VS 번들 3.31.6을 전체 경로로 호출해야 한다:**

```
C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe
```

vcpkg가 포트를 빌드할 때 PATH에서 cmake를 다시 찾으므로, PATH 앞에도 3.31.6 디렉토리를 붙여야 한다.

### `build/run_cmake_vs_2022_x64_SDK.bat`은 쓰지 말 것

두 가지 이유로 반드시 실패한다: (1) `mklink /j C:\zsb_vcpkg` 정션이 vcpkg 서브모듈의 상대경로 gitdir를 깨뜨림, (2) vcpkg 루트(C:)와 install 루트(D:)가 다른 드라이브가 되어 harfbuzz가 죽음. CMake를 직접 호출한다.

### 빌드 캐시가 전부 무효 (중요)

저장소가 `D:\z-emotion\zelusSandBox_Cobalt` → 현재 위치로 **이동**했다. `cmake_build`, `cmake_build_src`, `cmake_build_cuda` 세 캐시 모두 `CMAKE_HOME_DIRECTORY`에 옛 경로가 박혀 있어 **제자리 재구성이 불가능하다.** 새 빌드 디렉토리를 쓸 것.

### vcpkg 재빌드(~12분) 회피

`cmake_build/vcpkg_installed`에 의존성이 이미 빌드돼 있다(include 106개). 새 구성에서 재사용:

```
-D VCPKG_INSTALLED_DIR=d:/z-emotion/Cobalt/zelusSandBox_Cobalt/cmake_build/vcpkg_installed
```

### 두 가지 빌드 모드

최상위 `CMakeLists.txt:15-23`의 `ZELUS_SANDBOX_USE_SDK`가 전체를 가른다.

| 모드 | 설정 | 용도 |
|---|---|---|
| SDK | `USE_SDK=ON` + `Zest_DIR`/`Lumia_DIR` → `SDK/lib/cmake/` | 빠름. 헤드리스 아웃오브트리에 적합 |
| 소스 | `USE_SDK=OFF` → `add_subdirectory(Zest)`, `add_subdirectory(Lumia)` | 엔진까지 디버깅할 때 |

SDK 모드에서는 서브모듈 중 `vcpkg`만 있으면 된다.

### 가용 자산

- `SDK/bin/Release/` — DLL 47개 (Zest, Zelus, Lumia + USD 20개 포함)
- `SDK/lib/cmake/{Zest,Lumia}/` — `find_package` 설정
- `cmake_build_src/bin/Debug/zelusSandBox.exe` — 데스크톱 앱 (옛 경로에서 빌드됨)
- `Zest/testing/sdk/sample.zls` — **103MB 실파일**, 검증용 씬
- `Zest/testing/sdk/{main.cpp.in,CMakeLists.txt.in}` — GL 없이 `.zls`를 여는 최소 예제. **헤드리스의 레퍼런스**

### 테스트

`ZEST_TESTING`, `ZELUS_TESTING` 모두 OFF이고 `zelusSandBox` 앱에는 테스트 타깃 자체가 없다. 실행 가능한 테스트 명령이 현재 없다.

### 라이선스

현재 모든 빌드가 `ZELUS_USE_LICENSING=OFF`라 라이선스 없이 시뮬레이션이 돈다. ON으로 바뀌면 환경변수 `ZELUS_SDK_LICENSE_FILE` 또는 `zsSimulationWorld::SetLicenseFilePath`가 필요하다(README).

## 아키텍처

```
zelusSandBox (앱)     GLFW + ImGui + OpenGL, 2D/3D 듀얼 뷰포트
   ├── Zest  (미들웨어)  씬 데이터모델, .zls I/O, 시뮬 오케스트레이션
   │     └── Zelus     물리 솔버 (Zest 안의 중첩 서브모듈)
   └── Lumia (렌더러)   PBR 렌더링 (OptiX/V-Ray 옵션, 둘 다 빌드 OFF)
```

**`ZestManager`가 앱↔엔진의 유일한 경계면이다** ([ZestManager.h](zelusSandBox_Cobalt/zelusSandBox/ZestManager.h), 공개 메서드 35개). 로드/저장/익스포트/시뮬제어/그래빙/라이브에디팅이 전부 여기를 지난다. 헤드리스는 프로토콜 → `ZestManager` 직결이면 된다.

`MainGUI`는 ImGui 배선일 뿐 로직이 없다 — 헤드리스로 **옮기지 말고 버릴 것**. 단일 창 구조라서 `ImGui::Begin("Operation")`이 하나뿐이고 나머지 9개 "패널"은 그 안의 `CollapsingHeader`다.

## 단일 파일로는 안 보이는 사실들

이 항목들은 여러 파일을 교차 확인해야 드러나고, 설계 판단을 바꾼다.

**시뮬레이션은 GL-free지만 머티리얼 초기화는 아니다.** `ZestManager`·`core/`·`scene/`에 GL 직접 호출이 0건이고 SDK 샘플은 `Zest TBB::tbb`만 링크해 `.zls`를 연다. 그러나 `ZestManager::Initialize()` → `InitMaterialFolders()` → … → [zwMaterialManager.cpp:2075](zelusSandBox_Cobalt/zelusSandBox/core/zwMaterialManager.cpp#L2075)에서 `zsTexture::createAndLoadTexture`(GL)에 도달한다. 3중 방어(크기 메타데이터가 있으면 skip / 파일 없으면 early return / `!texture->isPrepared()` 시 return)가 걸려 있어 무사통과할 수도, GLEW 함수 포인터가 NULL이라 죽을 수도 있다 — **실행해야 답이 나온다.** 첫 검증에서는 `Initialize()`를 건너뛰고 로드→시뮬→익스포트만 확인해 관심사를 분리할 것.

**세션 = 프로세스 1개가 구조적으로 강제된다.** `ZestManager`의 콜백 8개(`ZestManager.h:93-100`)와 `MainGUI`의 시뮬 상태가 전부 `static`이다. 한 프로세스에 두 세션은 불가능하며, 이는 웹 서비스의 워커 모델을 결정한다(크래시·메모리 격리를 공짜로 얻음).

**`solverType` 필드 충돌 (버그).** `MainGUI.cpp:471`의 "solver type"과 `:643`의 "Collision solver"가 **같은 필드에 쓴다.** 충돌 솔버를 바꾸면 적분기가 조용히 손상되고, 정작 충돌 솔버는 설정되지 않는다. 파라미터 매핑을 새로 만들 때 이 충돌을 그대로 옮기지 말 것.

**익스포트 옵션이 전부 하드코딩이다.** GLB, Draco 압축, 외부 URI, `.zsgltf` zip이 **구현은 완료돼 있고** `ZestManager::ExportGltf`(`ZestManager.cpp:910-929`)의 리터럴 상수로만 막혀 있다. 헤드리스에서 프로토콜 파라미터로 열면 된다 — 공짜로 얻는 기능.

**`.zbin`은 쓰기 전용이다.** `zsDeserializeBinary*`가 어디서도 호출되지 않아 앱이 자기가 쓴 파일을 읽지 못한다.

**타임라인 프레임 캐시가 잠들어 있다.** `ztSimulationManager::StepSync`/`LoadCache`/`SaveCache`가 구현돼 있고 앱이 안 쓴다. 웹의 "배치 모드"(N프레임 시뮬 → 캐시 → 클라이언트가 스크럽)를 가능하게 하는 핵심이며, 서버 비용 구조를 바꾼다.

**뷰 옵션 ~130개가 동결돼 있다.** `zwViewOptionManager::ReLoad()`에 호출자가 없어 `viewOption.txt`를 읽지도 쓰지도 않는다. 2D 호버/선택 렌더링은 하드코딩으로 꺼져 있다 — 웹에서 새로 만드는 편이 낫다.

**CUDA 빌드는 미완성이다.** `cmake_build_cuda`는 서드파티 lib 3개만 빌드되고 중단됐다(CMake 3.31.6 ↔ CUDA 13.3 세대 격차 추정). GPU 솔버는 현재 선택지가 아니다 — v1은 CPU 솔버만.

**엔진 표면의 대부분이 미사용이다.** 샌드박스는 `ztSceneQueryInterface`의 공개 메서드 ~330개 중 37개만 쓴다(Zest 전체의 10–15%). 2D CAD 저작, 아바타 조형, 그레이딩, 컬러웨이, Undo/Redo가 통째로 도달 불가다. "이 기능이 없다"고 결론짓기 전에 `PROJECT_ANALYSIS.md` §6–8을 먼저 볼 것 — 대개 있는데 UI가 없을 뿐이다.

## 참조: `PROJECT_ANALYSIS.md`

2,178줄이라 통독하지 말고 필요한 장만 볼 것. 표기는 **[코드 확인]**(검증됨) / **[추론]**(분석)으로 구분돼 있다. 본문의 `file:line`은 `zelusSandBox_Cobalt/` 기준 상대경로다.

| 장 | 내용 |
|---|---|
| §1–3 | 구조, 빌드 구성, 의존성 |
| §4 | **UI 기능 68개 전수** — 위젯별 동작·필드·`file:line`. 웹 UI 재현의 명세서 |
| §5 | zelusSandBox 비UI 계층 + 데드코드 |
| §6–8 | Zest / Zelus / Lumia 인벤토리와 미사용 표면 (§7.2에 솔버 튜너블 81개 전체 목록) |
| §9 | 발견된 버그 15건 |
| §10 | **웹 서비스화 설계 검토** — 기능 4분류, 픽셀 vs 지오메트리 스트리밍, 아키텍처 |
| §11 | Linux 이식성 (Zest가 작업 대상, `ztString`이 최대 미지수) |
| §12 | **헤드리스 실현 가능성** — §12.7에 미실행 검증 계획 |

## 다음 단계

`PROJECT_ANALYSIS.md` §12.7의 검증이 아직 실행되지 않았고, 여기서 링크가 실패하면 이후 설계가 전부 달라진다. 목표 커맨드:

```
zelusSandBoxd.exe --headless --load sample.zls --frames 100 --export out.gltf
```

이 한 줄로 확정되는 것: GL 없이 링크·실행되는가 / 시뮬이 윈도우 없이 도는가 / 익스포트가 GL 없이 완결되는가 / 라이선스가 필요한가.

확정되지 않는 것: 파라미터 40개 실제 반영, 프레임별 메시 추출, 세션 재사용, 메모리·속도 실측, 동시 인스턴스.
