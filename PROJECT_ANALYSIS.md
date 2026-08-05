# zelusSandBox_Cobalt 프로젝트 분석

> 조사일: 2026-08-05
> 방법: 저장소 전체 코드 정독 + 서브에이전트 5개 병렬 조사 + 교차 검증
> 표기: **[코드 확인]** = 실제 코드/빌드산출물에서 검증 · **[추론]** = 분석·추정

---

## 목차

1. [프로젝트 정체와 아키텍처](#1-프로젝트-정체와-아키텍처)
2. [빌드 구성](#2-빌드-구성)
3. [의존성](#3-의존성)
4. [UI에서 실행되는 기능 전체 (68개)](#4-ui에서-실행되는-기능-전체-68개)
5. [zelusSandBox 비UI 계층 + 데드코드](#5-zelussandbox-비ui-계층--데드코드)
6. [Zest 미들웨어 인벤토리](#6-zest-미들웨어-인벤토리)
7. [Zelus 솔버 엔진 인벤토리](#7-zelus-솔버-엔진-인벤토리)
8. [Lumia 렌더러 인벤토리](#8-lumia-렌더러-인벤토리)
9. [발견된 버그](#9-발견된-버그)
10. [웹 서비스화 설계 검토](#10-웹-서비스화-설계-검토)
11. [Linux 이식성](#11-linux-이식성)
12. [헤드리스 실행파일 실현 가능성](#12-헤드리스-실행파일-실현-가능성)

---

## 1. 프로젝트 정체와 아키텍처

### 정체

**[공식문서/README]** `.zls` 파일(z-emotion의 의류 디자인 씬 포맷)을 로드해 **의류 물리 시뮬레이션**을 돌리고 렌더링하는 **SDK 데모/샌드박스 앱**. 외부 SDK 사용자에게 "Zelus + Zest + Lumia를 이렇게 쓴다"를 보여주는 레퍼런스 구현이자, 사내 엔진 개발용 테스트베드.

### 4계층 구조

```
zelusSandBox (앱)        GLFW + ImGui + OpenGL 데스크톱 앱, 2D/3D 듀얼 뷰포트
   │
   ├── Zest   (미들웨어)  씬/디자인 데이터 모델, .zls I/O, 시뮬레이션 오케스트레이션
   │     └── Zelus (코어) 물리 솔버 — Zest 안의 중첩 서브모듈
   │
   └── Lumia  (렌더러)    PBR 렌더링 백엔드 (OptiX/V-Ray 옵션)
```

| 모듈 | 위치 | 버전 | 규모 | 역할 |
|---|---|---|---|---|
| **zelusSandBox** | `zelusSandBox/` | 1.0 | ~50 파일 | GUI, 카메라, 2D/3D 렌더러, glTF/zbin 익스포터 |
| **Zest** | `Zest/` | `zt1.82-77-gcb78252b` | ~700 파일 | 씬·디자인 데이터모델, 패턴/시밍/아바타, 시뮬 제어 |
| **Zelus** | `Zest/Zelus/` | — | ~470 파일 | 솔버, 충돌, GPU 커널, ML |
| **Lumia** | `Lumia/` | `v3.0-149-gdf97de6` | ~170 파일 | 렌더 그래프, 라이트, 머티리얼, 텍스처 |

**[코드 확인]** 서브모듈 상태:
```
df97de67ab301e33975368419b058dfea4517e66 Lumia (v3.0-149-gdf97de6)
cb78252b105d55805ee119aed05654b8a8b5207f Zest  (zt1.82-77-gcb78252b)
acffd1489131eca26628cd33070f74be10c47531 vcpkg (2025-03-04)
```

### 핵심 엔트리 포인트

| 지점 | 위치 | 설명 |
|---|---|---|
| 메인 루프 | `zelusSandBox/main.cpp:141-190` | 클래식 게임 루프. 마우스 입력 → 카메라 → 3D 렌더 → 2D 렌더 → GUI 순차 실행 |
| 앱↔엔진 파사드 | `zelusSandBox/ZestManager.h:13` | **유일한 경계면.** LoadZls/SaveZls, SetAnimationMode, 그래빙, 라이브에디팅, 익스포트 전부 위임 |
| 엔진 공개 API | `Zest/Zelus/zsSimulationWorld.h:80` | 헤더 주석에 완결된 사용 예제 포함 (문서 품질 양호) |
| 씬 관리 | `Zest/simulation/ztSceneManager.h:18` | `.zls` 로드/저장, 씬 모드(DESIGN/SIMULATION) 전환 |
| 시뮬 제어 | `Zest/simulation/ztSimulationManager.h:20` | Start/Step/Pause/Reset + 타임라인 캐시 |

### 계층별 디렉토리 구성

**Zest** (`Zest/`)
| 디렉토리 | 파일 수 | 내용 |
|---|---|---|
| `Zelus/` | 469 | 중첩 서브모듈 — 물리 엔진 |
| `external/` | 310 | 외부 라이브러리 |
| `common/` | 102 | 공용 유틸, 메시 처리, 아카이브 |
| `scene/` | 76 | 씬 데이터, 파서/라이터, 편집 액션 |
| `design/` | 61 | 디자인 엔티티 데이터 모델 |
| `vcpkg/` | 47 | 포트 오버레이 |
| `avatar/` | 26 | 아바타 모핑·측정·스키닝 |
| `misc/` | 17 | 바이너리 직렬화, 서명 |
| `simulation/` | 15 | 시뮬 오케스트레이션 |
| `geometry/` | 11 | 메시 생성·리메시 |

**Lumia** (`Lumia/`)
| 디렉토리 | 파일 수 | 내용 |
|---|---|---|
| `optix/` | 34 | OptiX GPU 패스트레이서 (빌드 OFF) |
| `external/` | 19 | 외부 라이브러리 |
| `core/` | 18 | 렌더러 본체, 렌더타깃, 패스 |
| `renderable/` | 16 | 렌더 가능 프리미티브 |
| `graph/` | 14 | 씬 그래프, 트래버설 |
| `texture/` | 13 | 텍스처, 비동기 로딩, 베이킹 |
| `shader/` | 11 | 셰이더 시스템 |
| `materials/` | 10 | PBR 머티리얼 |
| `lights/` | 10 | 라이트, 그림자 |
| `camera/` | 8 | 카메라 모델 |
| `vertex/` | 6 | 정점 포맷 |
| `util/` | 6 | SH, 탄젠트, GL 유틸 |
| `v-ray/` | 2 | V-Ray 백엔드 (빌드 OFF) |

**Zelus** (`Zest/Zelus/`)
| 디렉토리 | 내용 |
|---|---|
| `solver/` | 적분기 + 선형솔버 (CPU/GPU) |
| `collision/` | 충돌 검출/해결, ISD 언탱글링 |
| `constraints/` | 스프링·제약 25종 |
| `components/` | 시뮬 엔티티 (cloth, simMesh, simStructure) |
| `primitives/` | 강체, 사면체, 정점버퍼, GPU 정렬 |
| `math/` | SIMD 벡터/행렬/쿼터니언 |
| `gpu/` | CUDA 인프라 |
| `machinelearning/` | MLP, PCA, Torch 백엔드 |
| `serialize/` | zbin 포맷 |
| `threading/` | TBB/OpenMP/Serial 백엔드 |
| `licensing/` | 라이선스 게이팅 |
| `utils/` | 로거, 프로파일러, 양자화, 상태기록 |

---

## 2. 빌드 구성

### 최상위 스위치

**[코드 확인]** `CMakeLists.txt:15-23`의 `ZELUS_SANDBOX_USE_SDK`가 전체를 가름:

```cmake
if (ZELUS_SANDBOX_USE_SDK)
    find_package(Zest REQUIRED)      # SDK/lib/cmake/ 의 프리빌드 사용
    find_package(Lumia REQUIRED)
else()
    add_subdirectory(Zest)            # 소스에서 빌드
    add_subdirectory(Lumia)
    include(InstallSDK)
endif()
```

### 세 갈래 빌드 디렉토리

| 디렉토리 | 모드 | 상태 |
|---|---|---|
| `cmake_build` | SDK 모드 (`USE_SDK=ON`) | ✅ Debug exe 존재 (2026-08-04 18:33) |
| `cmake_build_src` | 소스 모드 (`USE_SDK=OFF`, CUDA=OFF) | ✅ Debug exe 존재 (2026-08-04 18:51) |
| `cmake_build_cuda` | 소스 모드 + **CUDA=ON** | ⚠️ **미완성** |

### CUDA 빌드 중단 상태

**[코드 확인]** `cmake_build_cuda`는 2026-08-05 09:26에 컴파일 시작됐으나:

- **빌드된 것**: `dxflib.lib`, `triMesher.lib`, `zipper.lib` — 서드파티 정적 라이브러리 3개뿐
- **없는 것**: `Zelus.dll`, `Zest.dll`, `Lumia.dll`, `zelusSandBox.exe` — 전부 없음
- **설정**: CUDA **13.3**, `CMAKE_CUDA_ARCHITECTURES=75` (Turing), CMake 3.31.6, VS 2022

**[추론]** 의존성 순서상 dxflib/triMesher/zipper는 Zelus보다 먼저 빌드되는 리프 타깃. 즉 **Zelus의 `.cu` 파일 컴파일 진입 직후 중단**된 것으로 보임. 유력 원인 2가지:

1. **CMake 3.31.6 ↔ CUDA 13.3 세대 격차** — CMake 3.31은 2024-11, CUDA 13은 2025-08 릴리스. CUDA 13에서 툴킷 라이브러리 배치가 변경됨. 실제로 캐시에 `CUDA_culibos_LIBRARY-NOTFOUND`, `CUDA_nvToolsExt_LIBRARY-NOTFOUND` 존재. CMake 3.31은 프로젝트 요구사항(README: `CMake <= 3.31`)이라 올릴 수도 없는 딜레마.
2. **nvcc의 MSVC 버전 검사** — CUDA 13.3 nvcc가 지원 범위 밖 MSVC 툴셋을 만나면 `unsupported Microsoft Visual Studio version`으로 즉시 실패.

### 빌드 옵션 실측값

**[코드 확인]** `cmake_build_cuda/CMakeCache.txt` 및 `cmake_build_src/CMakeCache.txt`:

| 옵션 | cmake_build_src | cmake_build_cuda |
|---|---|---|
| `ZELUS_SANDBOX_USE_SDK` | OFF | OFF |
| `ZELUS_USE_CUDA` | OFF | **ON** |
| `ZELUS_USE_TBB` | ON | ON |
| `ZELUS_USE_SIMD_SSE` / `AVX` | ON / ON | ON / ON |
| `ZELUS_USE_FAST_MATH` | ON | ON |
| `ZELUS_USE_ASSERT` | ON | ON |
| `ZELUS_SHARED_BUILD` | ON | ON |
| `ZELUS_DOUBLE_PRECISION` | OFF | OFF |
| `ZELUS_USE_LICENSING` | **OFF** | **OFF** |
| `ZELUS_USE_TORCH` | OFF | OFF |
| `ZELUS_USE_MKL` | OFF | OFF |
| `ZELUS_USE_OPENBLAS` | OFF | OFF |
| `ZELUS_USE_CUBLAS` | — | OFF |
| `ZELUS_USE_ZLIB` | OFF | OFF |
| `ZELUS_USE_OPENMP` | OFF | OFF |
| `ZELUS_USE_PROFILER` | OFF | OFF |
| `ZELUS_USE_MEMORY_TRACKER` | OFF | OFF |
| `ZELUS_TESTING` | **OFF** | **OFF** |
| `ZEST_TESTING` | **OFF** | **OFF** |
| `ZEST_SHARED_BUILD` | ON | ON |
| `ZEST_INSTALL_SDK` | ON | ON |
| `ZEST_ASSERT` | ON | ON |
| `LUMIA_SHARED_BUILD` | ON | ON |
| `LUMIA_BACKEND_ENABLE_OPTIX` | OFF | **OFF** |
| `LUMIA_BACKEND_ENABLE_VRAY` | OFF | OFF |
| `LUMIA_STRICT_BUILD` | OFF | OFF |
| `VCPKG_TARGET_TRIPLET` | x64-windows | x64-windows |

### 빌드 절차 (검증됨)

**[코드 확인]** 저장소의 `build/run_cmake_vs_2022_x64_SDK.bat`은 **사용 불가**. 두 가지 이유로 반드시 실패:

1. bat이 `mklink /j C:\zsb_vcpkg`로 정션 생성 → vcpkg는 git 서브모듈이라 `vcpkg/.git`이 `gitdir: ../.git/modules/vcpkg`(상대경로)를 담은 파일. 정션 통해 접근하면 `C:\.git\modules\vcpkg`로 풀려 `fatal: not a git repository` 발생, vcpkg 버전 고정 전부 붕괴.
2. 정션을 살려도 vcpkg 루트(C:)와 install root(D:)가 다른 드라이브가 되어 harfbuzz의 `gen-harfbuzzcc.py`가 `ValueError: path is on mount 'C:', start on mount 'D:'`로 사망.

**대안 — CMake 직접 호출** (2026-08-04 검증, 총 12분):

```powershell
cd D:\z-emotion\zelusSandBox_Cobalt
& "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" `
  -S . -B cmake_build -G "Visual Studio 17 2022" `
  -D CMAKE_TOOLCHAIN_FILE="D:/z-emotion/zelusSandBox_Cobalt/vcpkg/scripts/buildsystems/vcpkg.cmake" `
  -D VCPKG_TARGET_TRIPLET=x64-windows `
  -D ZELUS_SANDBOX_USE_SDK=ON `
  -D Zest_DIR="D:/z-emotion/zelusSandBox_Cobalt/SDK/lib/cmake/Zest" `
  -D Lumia_DIR="D:/z-emotion/zelusSandBox_Cobalt/SDK/lib/cmake/Lumia"
```

**CMake 버전이 중요**: PATH의 CMake는 4.3.2인데 이걸 쓰면 vcpkg 포트(baseline 2025-03-04, CMake 4.0 출시 직전)가 깨짐. VS 번들 3.31.6을 전체 경로로 호출해야 함.

서브모듈은 `vcpkg`만 받으면 됨 (`git submodule update --init vcpkg`). SDK 모드에서는 `Zest`/`Lumia`가 `SDK/lib/cmake/`의 프리빌드를 쓰므로 불필요.

### VSCode 설정

**[코드 확인]** `.vscode/settings.json`:

```json
{
  "cmake.generator": "Visual Studio 17 2022",
  "cmake.buildDirectory": "${workspaceFolder}/cmake_build_src",
  "cmake.cmakePath": "C:/Program Files/Microsoft Visual Studio/2022/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe",
  "cmake.environment": {
    "PATH": "C:\\Program Files\\...\\CMake\\bin;${env:PATH}"
  },
  "cmake.configureArgs": [ ... "-DZELUS_USE_CUDA=OFF" ... ]
}
```

주석에 명시된 이유: *"vcpkg가 포트를 빌드할 때 PATH에서 cmake를 다시 찾는다. 여기서 3.31.6을 앞에 붙여두지 않으면 PATH의 CMake 4.3.2가 잡혀 cryptopp 등 옛 포트가 'Compatibility with CMake < 3.5 has been removed'로 실패한다."*

⚠️ `cmake.buildDirectory`가 `cmake_build_src`를 가리키고 `ZELUS_USE_CUDA=OFF`이므로, **VSCode에서 빌드해도 CUDA 빌드는 건드려지지 않음.**

### SetupConfigs.cmake

**[코드 확인]** `cmake/SetupConfigs.cmake`:
- SDK 모드: 구성 타입을 `Debug;Release`로 제한
- 소스 모드: `Debug;Release;RelWithDebInfo`
- MSVC 런타임: `MultiThreaded$<$<CONFIG:Debug>:Debug>DLL` (/MD, /MDd)

---

## 3. 의존성

### vcpkg 매니페스트

**[코드 확인]** `vcpkg.json` — baseline `acffd1489131eca26628cd33070f74be10c47531` (**2025-03-04**)

**의존 패키지**: tbb, alembic, freeimage, jsoncpp, minizip-ng, polyclipping, earcut-hpp, tinyobjloader, tinygltf, usd, licensepp, cryptopp, nlohmann-json, draco, glew, libxml2, nanovg, glfw3, imgui, qt5-base, opensubdiv(opengl+tbb)

### 발목 잡힌 버전 고정 3건

| 패키지 | 고정 버전 | 이유 |
|---|---|---|
| **imgui** | **1.53** | 2018년 버전. 8년 가까이 묶여 있음. 앱이 `imgui_impl_glfw_gl3.cpp`를 **직접 벤더링**(현대 ImGui는 backend가 업스트림 포함). 업그레이드 시 이 파일 폐기 + `MainGUI.cpp`(32KB) 전면 수정 필요 |
| **cryptopp** | **8.6.0** (port 2) | 매니페스트 주석: *"cryptopp 8.7+ uses a new repository which does not support pem-pack feature used by licensepp"* |
| **tinyobjloader** | **1.0.7** | — |

### 앱 계층 링크 대상

**[코드 확인]** `zelusSandBox/CMakeLists.txt:72-93`:

```cmake
find_package(OpenGL REQUIRED)
find_package(GLEW CONFIG REQUIRED)
find_package(imgui CONFIG REQUIRED)
find_package(nanovg CONFIG REQUIRED)
find_package(glfw3 CONFIG REQUIRED)
find_package(Qt5 COMPONENTS Core Xml REQUIRED)
find_package(draco CONFIG REQUIRED)
find_package(JsonCpp CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(TBB CONFIG REQUIRED)
find_package(freeimage CONFIG REQUIRED)
find_path(TINYGLTF_INCLUDE_DIRS "tiny_gltf.h")

target_link_libraries(${PROJECT_NAME} PRIVATE ${OPENGL_LIBRARIES} GLEW::GLEW imgui::imgui glfw)
target_link_libraries(${PROJECT_NAME} PRIVATE nanovg::nanovg)
target_link_libraries(${PROJECT_NAME} PRIVATE Qt5::Core Qt5::Xml)
target_link_libraries(${PROJECT_NAME} PRIVATE draco::draco)
target_link_libraries(${PROJECT_NAME} PRIVATE nlohmann_json::nlohmann_json JsonCpp::JsonCpp)
target_link_libraries(${PROJECT_NAME} PRIVATE TBB::tbb)
target_link_libraries(${PROJECT_NAME} PRIVATE freeimage::FreeImage freeimage::FreeImagePlus)
target_link_libraries(${PROJECT_NAME} PRIVATE Zest Lumia)
```

### SDK 런타임 DLL 목록

**[코드 확인]** `SDK/bin/Release/` — 45개:

```
Alembic.dll, bz2.dll, deflate.dll, FreeImage.dll, Iex-3_3.dll, IlmThread-3_3.dll,
Imath-3_1.dll, jpeg62.dll, jsoncpp.dll, lcms2-2.dll, libfbxsdk.dll, liblzma.dll,
libpng16.dll, libsharpyuv.dll, libwebp.dll, libwebpdecoder.dll, libwebpmux.dll,
Lumia.dll, OpenEXR-3_3.dll, OpenEXRCore-3_3.dll, openjp2.dll, raw.dll, tbb12.dll,
tiff.dll, usd_ar.dll, usd_arch.dll, usd_gf.dll, usd_js.dll, usd_kind.dll,
usd_ndr.dll, usd_pcp.dll, usd_plug.dll, usd_sdf.dll, usd_sdr.dll, usd_tf.dll,
usd_trace.dll, usd_ts.dll, usd_usd.dll, usd_usdGeom.dll, usd_usdShade.dll,
usd_usdUtils.dll, usd_vt.dll, usd_work.dll, Zelus.dll, Zest.dll, zlib1.dll, zstd.dll
```

**[추론]** USD(Pixar Universal Scene Description) DLL만 20개. Qt5는 Core/Xml만 쓰는데 `qt5-base` 전체를 vcpkg로 빌드하는 것이 빌드 시간(12분)의 상당 부분을 차지. XML 파싱(`zwXtexParser`, `zwU3mParser` — 패브릭 머티리얼 포맷)만을 위한 것이라면 Qt를 떼어낼 여지 있음.

---

## 4. UI에서 실행되는 기능 전체 (68개)

**[코드 확인]** 전부 `zelusSandBox/MainGUI.cpp` / `main.cpp` 기준. 조작 가능 **62개** + 읽기 전용 표시 **6개**.

### 구조 주의사항

**단일 창 구조.** `ImGui::Begin("Operation")`이 `MainGUI.cpp:210`에 **하나뿐**이고 대응하는 `ImGui::End()`는 `:850`. 나머지 9개 "패널"은 전부 그 안의 `CollapsingHeader`. `Render*Property` 함수명 때문에 별도 창처럼 보이지만 아님.

**그리기 순서** (`MainGUI.cpp:839-848`): Operation → File → General → Solver → Collision → DrapingBoard → Avatar → Pattern → RenderOption → Help

### 4.1 Operation

| # | 위젯 | 레이블 | 동작 | 위치 |
|---|---|---|---|---|
| 1 | Text | `framerate %.3f ms/frame (%.1f FPS)` | 읽기전용. `ImGui::GetIO().Framerate` | :211 |
| 2 | Text | `simulation frame : %d` | 읽기전용. static `mSimulationCurFrame` (콜백 :867에서 갱신, 등록 :89) | :212 |
| 3 | Text | `simulation state : %s` | 읽기전용. static `mSimulationMessage` (콜백 :872) | :213 |
| 4 | Button | Start / Pause | `GetAnimationMode()==PLAY` 여부로 레이블 토글(:219-220) → `SetAnimationMode(PLAY\|PAUSE)` (:857) | :222 |
| 5 | Button | Reset | `SetAnimationMode(RESET)` | :234 |
| 6 | Button | Clear | `MainGUI::Clear()` (:970) → `ZestManager::Clear` + `Renderer3D::ClearRenderMesh` + `Renderer2D::ClearRenderMesh` + `UpdateUIData()` | :242 |

### 4.2 File

| # | 위젯 | 레이블 | 동작 | 위치 |
|---|---|---|---|---|
| 7 | Button | Load zls | `LoadZLS()` (:978): `SetAnimationMode(RESET)` → `OpenDlg(L"ZLS Files (*.zls)...")` → `Clear()` → `ZestManager::LoadZls` → `UpdateUIData()` | :254 |
| 8 | Button | Save zls | `SaveZLS()` (:994): `GetSaveFileName` → `!IsLoadedZls()` 가드 → PAUSE → `ZestManager::SaveZls` | :259 |
| 9 | Button | Export zbin | `ExportZbin()` (:877): 필터 `*.zbin` → 가드 → PAUSE → `ZestManager::ExportZbin` | :264 |
| 10 | Button | Export gltf | `ExportGLTF()` (:914): 필터는 `mIsExportGltfGlb`로 결정(:921) → 가드 → PAUSE → `ZestManager::ExportGltf` | :269 |

### 4.3 General (DefaultOpen, :388) — 전부 `ztSceneDataSimulationParams`에 씀 (`:390`)

| # | 위젯 | 레이블 | 범위 | 쓰는 필드 | 위치 |
|---|---|---|---|---|---|
| 11 | SliderInt | timestep(Hz) | 1–300 | `timeStep`의 int 사본. **매 프레임 무조건 write-back**(:395) | :394 |
| 12 | SliderInt | sub-steps | 1–20 | `subStep` (직접 포인터) | :398 |
| 13 | SliderFloat | gravity(cm/s^2) | −1000–0 | `gravity.y` | :401 |
| 14 | SliderFloat | draping time | 0–10 | `drapingTime` | :404 |
| 15 | Checkbox | ground plane | — | `groundPlane` | :407 |
| 16 | Combo | stretch spring | Linear / Non-linear | 변경 시 `UpdateLiveEditing(UpdateClothPhysicsParameters)` 후 `useLinearStretch = (idx==0)` | :422-426 |
| 17 | Combo | bend spring | Linear / Angular / Quadratic | 변경 시 `UpdateLiveEditing(...)` 후 `bendSpringType = bendMap[idx]` (LINEAR/ANGULAR/QUADRATIC_BEND) | :432-436 |

### 4.4 Solver (DefaultOpen, :443, ItemWidth 180 :447)

| # | 위젯 | 레이블 | 선택지 | 쓰는 필드 | 조건 | 위치 |
|---|---|---|---|---|---|---|
| 18 | Combo | solver type | Implicit 1st order / Implicit 2nd order / XPBD | `solverType = solverMap[idx]`, 무조건 write(:471) | **`!IsSimulationInitialized()`** (:459) | :470 |
| 19 | Checkbox | GPU | — | `gpuSolver` | **`mGPUDeviceCount > 0`** (:478-480). count는 `zsGpuManager::Instance()->GetDeviceCount()` (`ZS_USE_CUDA` 시), 아니면 0 (:118-122) | :482 |
| 20 | Checkbox | Quasi-static | — | `useIEQS` | — | :487 |
| 21 | InputText | CG tolerance | 지수표기 | 버퍼 초기값 `sprintf("%e", max(solverTolerance,1e-10))` (:490-493), 편집 시 `solverTolerance = atof(buf)` | — | :495 |
| 22 | Combo | preconditioner | Identity / Diagonal / Block-Diagonal | `preconditioner = (ZS_LINEAR_SOLVER_PRECONDITIONER)idx`, 무조건 write(:506) | — | :505 |
| 23 | SliderInt | non-linear iterations | 1–200 | `nonlinearIterations` | — | :509 |
| 24 | Combo | static Coupling | None / Implicit contact / Implicit contact dir / Penalty / Projective Constraints | `staticCouplingMethod` (:519) | — | :518 |
| 25 | Combo | dynamic Coupling | (동일 5종) | `dynamicCouplingMethod` (:524) | — | :523 |

### 4.5 Collision (DefaultOpen 아님, :532)

| # | 위젯 | 레이블 | 쓰는 필드 / 비트 | 조건 | 위치 |
|---|---|---|---|---|---|
| 26 | Checkbox | untangling cloth | `collisionType` 비트 `USE_UNTANGLING_DYNAMIC_TRIANGLE_VS_EDGE` (write :548/:550) | — | :545 |
| 27 | Checkbox | untangling avatar | 비트 `USE_KINEMATIC_COLLISION_NORMAL` | — | :556 |
| 28 | Checkbox | ISD untangling cloth | 비트 `USE_UNTANGLING_CLOTH_ISD` | — | :567 |
| 29 | Checkbox | ISD untangling avatar | 비트 `USE_UNTANGLING_AVATAR_ISD` | — | :578 |
| 30 | Checkbox | ISD pinch stabilization | `pinchStabilizationMethod` = `PINCH_STABILIZATION_ISD` 또는 `NO_PINCH_STABILIZATION`, 무조건 write(:591) | — | :589 |
| 31 | Checkbox | vertex-vs-triangle | 비트 `VERTEX_VS_TRIANGLE_COLLISION` | — | :601 |
| 32 | Checkbox | edge-vs-edge | 비트 `EDGE_VS_EDGE_COLLISION` | — | :612 |
| 33 | SliderInt | Full DCD | `fullDCDIteration` (1–20) | — | :625 |
| 34 | SliderInt | Partial DCD | `partialDCDIteration` (1–20) | — | :626 |
| 35 | SliderInt | Full CCD | `fullCCDIteration` (1–20) | — | :627 |
| 36 | SliderInt | Partial CCD | `partialCCDIteration` (1–20) | — | :628 |
| 37 | SliderFloat | Thickness scaling | `thicknessScaling` (0.01–1.0) | — | :629 |
| 38 | Combo | Collision solver | Gauss-Seidel / Jacobi / GS atomic / ICA → **`solverType` 읽고 씀**(:641,:643) ⚠️ #18과 같은 필드 | `!simInitialized` (:636) | :642 |
| 39 | Combo | Bounding volumes | AABB / KDop16 / KDop24 → `boundingVolumeType` (:666-678) | `!simInitialized` (:651) | :664 |
| 40 | Combo | Broadphase methods | BVH Tree / Spatial Hashing / LBVH GPU / Spatial Hashing GPU → `broadPhaseType` + `gpuCollisionResolver` (:702-728) | `!simInitialized` (:685) | :700 |
| 41 | SliderFloat | Dynamic Penalty Stiffness | `dynCouplingStiffness` (0–20000) | — | :736 |
| 42 | SliderFloat | Dynamic Penalty Damping | `dynCouplingDamping` (0–500) | — | :737 |
| 43 | SliderFloat | Untangling Penalty Stiffness | `untanglingStiffness` (0–20000) | — | :738 |
| 44 | SliderFloat | Untangling Penalty Damping | `untanglingDamping` (0–500) | — | :739 |

### 4.6 DrapingBoard (:160)

| # | 위젯 | 레이블 | 동작 | 위치 |
|---|---|---|---|---|
| 45 | ListBoxHeader/Footer | Items (Uuid / Name 2열) | `ZestManager::GetDrapingItems()` (:163)로 채움 | :172 |
| 46 | Selectable | (uuid 문자열, SpanAllColumns) | 행 레이블 = `ztUuidSaver::Convert(uuid)`. 함수 static `selectedItemIndex`만 설정 | :185-188 |
| 47 | Button | Apply | `ZestManager::LoadDrapingItem(uuid, name)` → `UpdateUIData()`. **`!drapingItems.empty()`일 때만 표시**(:197) | :199 |

### 4.7 Avatar (:278)

| # | 위젯 | 레이블 | 동작 | 위치 |
|---|---|---|---|---|
| 48 | Combo | End Pose | 항목은 `UpdateUIData()`(:1053-1088)에서 구성 — `ztAvatarSubType::Zeta`, custom, 또는 아바타 타입 일치만 필터하고 `ztAvatarBuilder::DEFAULT_POSE_NAME` 제외. 변경 시 `ZestManager::SetEndPose(uuid)`. **커스텀 `Combo()` 헬퍼(:49-56)는 이름 벡터가 비면 false 반환하고 아무것도 그리지 않음** | :280-287 |

### 4.8 Pattern (DefaultOpen, :294)

| # | 위젯 | 레이블 | 동작 | 위치 |
|---|---|---|---|---|
| 49 | Combo | Name | `ZestManager::GetSurfaceInfos()`(:1037-1045)에서 항목 구성. `mComSurfaceDatasForPattern.selectIdx`만 씀 (#50-52의 대상 지정) | :296 |
| 50 | Combo | Fabric | `zwMaterialManager::GetFabricRootFolder()`의 preset/in-file 폴더(:1092-1105). 변경 시 `LoadIntoMaterial(&materialData, *zfmData)` → `ZestManager::SetFabricMaterial(surfaceUuid, materialData)` | :298-312 |
| 51 | InputFloat | Width (step 1.0/0.1) | `mSurfaceSizes[uuid].x` → `UpdateSizeSurface(uuid, size)`. **선택 uuid가 `mSurfaceSizes`에 있을 때만**(:318) | :320 (호출 :325) |
| 52 | InputFloat | Height | `mSurfaceSizes[uuid].y` → 동일 | :321 |

### 4.9 RenderOption (:333)

| # | 위젯 | 레이블 | 동작 | 초기화 | 위치 |
|---|---|---|---|---|---|
| 53 | Checkbox | Show avatar | `mShowAvatar` → `Renderer3D::SetShowAvatar` | `IsShowAvatar()` :107 | :335-337 |
| 54 | Checkbox | Show pattern | `mShowPattern` → `SetShowPattern` | :108 | :340-342 |
| 55 | Checkbox | Show sewing | `mShowSewing` → `SetShowSewing` | :109 | :345-347 |
| 56 | Checkbox | Show wire frame | `mShowWireFrame` → `SetShowWireFrame` | ⚠️ **초기화 없음** | :350-352 |

### 4.10 Help (:359) — 전부 읽기전용

| # | 위젯 | 내용 | 위치 |
|---|---|---|---|
| 57 | Text | 키/마우스 치트시트 | :361-369 |
| 58 | Text | `"Zelus: " + ZELUS::GetZelusFullVersionString()` | :373-375 |
| 59 | Text | `"Lumia: " + GetLumiaFullVersionString()` | :379-381 |

### 4.11 키보드 (GLFW → `OnKeyPress` main.cpp:51 → `MainGUI::OnKeyEvent` :759, PRESS만 main.cpp:58-61)

| # | 키 | 동작 | 위치 |
|---|---|---|---|
| 60 | `S` | PLAY ↔ PAUSE 토글 | :766-775 |
| 61 | `R` | `SetAnimationMode(RESET)` | :763 |
| 62 | `C` | `Clear()` | :776 |
| 63 | `SPACE` | `SetAnimationMode(STEP)` | :779 |

### 4.12 마우스

| # | 입력 | 동작 | 위치 |
|---|---|---|---|
| 64 | 좌 드래그 (뷰포트 내) | 카메라 회전 — `gCamera3D/2D.HandleInputEvent`. 그래빙이 이벤트를 소비하지 않았을 때만 | main.cpp:161-165 |
| 65 | 우 드래그 | 카메라 팬 — 동일 디스패치 (버튼 상태 캡처 main.cpp:85-87) | main.cpp:163-164 |
| 66 | 휠 | 줌 — `OnMouseScroll`이 `bZoom`/`zoomDelta` 설정 → 카메라 | main.cpp:104-108 |
| 67 | **Ctrl + 좌 드래그** (3D뷰) | 패턴 그래빙 — `UpdateGrabbingInputEvent`(:785): `StartGrabbing(rayOrigin,rayDir)`(:810) / `OnGrabbing`(:822) / `EndGrabbing`(:816). 레이는 `camera3D.mCamera->GetPickRay`(:805). **차단 조건**: 모드==RESET(:788), Ctrl 미입력 & 미그래빙(:797), 뷰 드래그 중(:801) | 호출 main.cpp:158 |
| 68 | 윈도우 리사이즈 | `OnWindowResized`가 WindowWidth/Height 설정(main.cpp:45-49). GUI 패널 380px 고정(`GUIWindowWidth` main.cpp:15), 뷰포트는 `GetRenderWindowWidth()`로 분할(main.cpp:111-114) | main.cpp:45 |

### 패널별 분포

| 패널 | 조작 | 표시 | 계 |
|---|---|---|---|
| Collision | 19 | 0 | 19 |
| Solver | 8 | 0 | 8 |
| General | 7 | 0 | 7 |
| Operation | 3 | 3 | 6 |
| 마우스 | 5 | 0 | 5 |
| File | 4 | 0 | 4 |
| Pattern | 4 | 0 | 4 |
| RenderOption | 4 | 0 | 4 |
| 키보드 | 4 | 0 | 4 |
| DrapingBoard | 3 | 0 | 3 |
| Help | 0 | 3 | 3 |
| Avatar | 1 | 0 | 1 |
| **합계** | **62** | **6** | **68** |

---

## 5. zelusSandBox 비UI 계층 + 데드코드

**[코드 확인]** 도달성 범례: **UI** = `MainGUI.cpp`에서 호출 · **INT** = 다른 비UI 코드에서만 호출 · **DEAD** = `zelusSandBox\` 어디서도 호출 없음 · **NOT-BUILT** = `CMakeLists.txt`에 없음

기준 경로: `zelusSandBox/`

### 5.1 SimControl

| 기능 | 위치 | 동작 | 도달 | 근거 |
|---|---|---|---|---|
| 애니메이션 모드 설정 | `ZestManager::SetAnimationMode` ZestManager.cpp:935 | 시작/일시정지/리셋/스텝 | UI | MainGUI.cpp:225,227,236,764,780,859,907,944,981,1024 |
| 모드 조회 | `GetAnimationMode` :870 | | UI | MainGUI.cpp:219,767,788 |
| 시뮬 초기화 여부 | `IsSimulationInitialized` :168 | 솔버 UI 게이팅 | UI | MainGUI.cpp:459,534 |
| 시뮬 파라미터 접근자 | `GetSimulationParam` :141 | `ztSceneDataSimulationParams` 전체 노출 | UI | MainGUI.cpp:390,445,535 |
| 라이브에디팅 트리거 | `UpdateLiveEditing` :524 + `UpdateFrame` :515 | 다음 프레임에 물성 재적용 예약 | UI | MainGUI.cpp:424,434 / UpdateFrame은 MainGUI.cpp:756 ← main.cpp:180 |
| 프레임 콜백 | `CallBackSimulationFrame` :459 | 프레임 번호 전달 | UI | 등록 :952, 사용자 함수 MainGUI.cpp:89 |
| 상태메시지 콜백 | `CallBackMainStatusMessage` :507 | | INT | 등록 :828 |
| **on/off/status/avatar/3D뷰 콜백 5종** | `CallBackSimulationOn/Off/StatusChanged/AvatarUpdate/CallBack3DViewUpdate` :467,475,483,491,499 | 콜백 트램폴린 | **DEAD** | :828이 이 슬롯들에 전부 `nullptr` 전달. 백킹 필드 `mCallbackStart` 등이 할당되지 않음 |
| **아바타 모핑 종료 콜백** | `EndMorpingAvatarCallback` ZestManager.h:11 / `mEndMorpingAvatarcallback` :38 | | **DEAD** | 할당 없음. 핸들러 `MainGUI::CallbackEndMorpingAvatar` :862도 참조 없음 |

### 5.2 SceneIO

| 기능 | 위치 | 동작 | 도달 |
|---|---|---|---|
| .zls 로드 | `LoadZls` :799 | 열기, 버전 체크, in-file 머티리얼 트리 재구성 | UI (MainGUI.cpp:989) |
| .zls 저장 | `SaveZls` :854 | | UI (:1027) |
| 씬 클리어 | `Clear` :793 | reset + NewScene | UI (:972) |
| 드레이핑 아이템 열거 | `GetDrapingItems` :399 | uuid+name 목록 | UI (:163) |
| 드레이핑 아이템 로드 | `LoadDrapingItem` :425 | 활성 드레이핑 씬 전환, 시뮬 재로드 | UI (:201) |
| **ZLS 로드 시 머티리얼 경로 재배선** | `UpdateMaterialTexturePath` :529 | fabric/logo/stitch/buttonhole + 구버전 컬러에셋 마이그레이션. 대규모 패스 | INT (:829) |
| 씬 매니저 조회 | `GetSceneManager` :389 | | UI (:103,104) |
| ZLS 로드 여부 | `IsLoadedZls` :394 | | UI (:904,941,1021) |
| **CLI 배치 인자 `-i`/`-o`** | `GetArgumentInfo` Util.cpp:3, `AargumentInfo` Util.h:5 | 헤드리스 입출력 경로 파싱 | **DEAD** — `main()`이 `argc/argv`를 받지만(main.cpp:128) 호출하지 않음. `Util.h`는 include만 됨(main.cpp:8) |

### 5.3 Export

| 기능 | 위치 | 동작 | 도달 |
|---|---|---|---|
| .zbin 익스포트 | `ExportZbin` :891 | `zsSerializeBinary(STANDARD_BINARY)` | UI (:910) |
| glTF/GLB 파일 익스포트 | `ExportGltf` :908 → `zwGltfExporter::Save` :16 → `zwGltfExporterImpl::Save` :230 | | UI (:947) |
| 클로스 지오메트리 | `ExportCloth` :325 | front/back/side 분할 또는 단일 메시 + crease angle | INT (:193) |
| 아바타 (Zeta 바디+액세서리, Mannequin) | `ExportMannequins` :484 | | INT (:198), `options.exportAvatar` 게이트 (하드코딩 true) |
| 버튼/버튼홀/로고/스티치/지퍼 | `ExportButton` :598, `ExportButtonHole` :665, `ExportLogo` :803, `ExportStitch` :937, `ExportZipper` :1108 | | INT (:201-205) |
| 텍스처 베이킹 | `MakeBaseColorImage` :1929, `MakeMetallicRoughnessImage` :1977, `MakeMaterialImage` :2046 | basecolor+alpha 합성, metallic/roughness 팩, normal | INT (:1288-1298, :1443-1470) |
| 알파모드 자동감지 | `GetBlendType` :2233 | 이미지 투명도 스캔 → OPAQUE/BLEND | INT (:1394, :1521) |
| DDS BGR→RGB 스위즐 | `ConvertDDSRGB` :1203 | | INT (:1289,1295,1299) |
| ZLS zip에서 텍스처 읽기 | `GetMaterialTexture` :2170 | | INT (:1288 등) |
| zip 텍스처 추출 | `ExtractTextureFromZip` :1544 | | **DEAD** |

#### 익스포트 플래그 — 전부 하드코딩, UI 도달 불가

**[코드 확인]** `ZestManager::ExportGltf` ZestManager.cpp:910-929가 매 호출마다 리터럴로 `zwExport3DOption`을 구성:

| 플래그 | 세터 | 하드코딩 값 | 도달 |
|---|---|---|---|
| `mIsExportGltfGlb` (GLB vs glTF) | `SetExportGltfGlb` :347 | `false` (:53) | **세터 DEAD**. 게터 :352는 MainGUI.cpp:113(초기화), :921(파일다이얼로그 필터)에서만 읽힘. **UI 토글 없음** |
| `mIsEmbeddedResource` | `SetEmbeddedResource` :373 | `true` (:55) | **세터 DEAD**. 게터 :357은 MainGUI.cpp:114에서 한 번 읽고 **이후 미사용** |
| `mIsExportGLTF` | `SetExportGLTF` :378 | `true` (:54) | **세터 DEAD**. 게터 :342는 MainGUI.cpp:112에서 읽고 **미사용**. 이 플래그는 어떤 코드경로에도 영향 없음 |
| `options.compress` (Draco) | 세터 없음 | `false` :921 | **런타임 도달불가** |
| `options.smooth` | — | `false` :912 | 도달불가 |
| `options.thickness` | — | `true` :913 | 도달불가 |
| `options.splitMesh` | — | `true` :916 | 도달불가 |
| `options.maxTextureSize` | ctor 인자 | `4294967295` :919 | 도달불가 |
| `options.texturesPowerOfTwo` | ctor 인자 | `false` :920 | 도달불가 |
| `options.exportAvatar` | — | `true` :914 | 도달불가 |
| `useZip` (`.zsgltf` 아카이브) | ctor 인자 zwGltfExporter.h:15 | `false` :931 | **런타임 도달불가**. 구현은 존재 zwGltfExporterImpl.cpp:236-257 |
| `options.scaleUVIntoUnitSquare` | zwExport3DOption.h:8 | `false` :915 | **익스포터가 이 필드를 아예 읽지 않음** |
| `startAfterDrapingTime`/`startFrame`/`duration`/`stopAfterAvatarAnimation`/`frameRate` | zwExport3DOption.h:17-21 | :924-928에서 설정 | **애니메이션 익스포트 블록을 익스포터가 읽지 않음 — glTF 애니메이션 익스포트 미구현** |

#### 호출되지 않는 익스포트 API

| 기능 | 위치 | 도달 |
|---|---|---|
| **메모리 문자열로 glTF/GLB 익스포트** | `zwGltfExporter::SaveBuffer` :21 → `zwGltfExporterImpl::SaveBuffer` :221 | **DEAD** — 선언/정의만 존재 (zwGltfExporter.h:20, zwGltfExporterImpl.h:52) |
| **glTF 임포트/Load** | `zwGltfExporter::Load` :26 → `zwGltfExporterImpl::Load` :261 | **DEAD** — 호출자 없음. 본문은 `ZS_UNUSED(path);` 빈 스텁 |
| **Draco 메시 압축** (양자화 POSITION 11 / NORMAL 8 / TEX_COORD 10 / tangent 8, speed 0=최대압축) | `zwDracoTriMesh::Compress` :29, `GetNumPoints` :14 | **런타임 도달불가** — 유일 호출이 zwGltfExporterImpl.cpp:1662의 `if (compress)` 안이고 `compress`는 하드코딩 `false`. `KHR_draco_mesh_compression` 확장 라이터 :1735-1783도 동일. `draco::draco`는 여전히 링크됨 (CMakeLists.txt:89) |
| **외부 URI 머티리얼 익스포트** (.gltf 옆에 BaseColor/MetallicRoughness/Normal .png 기록, zip 엔트리 맵 채움) | `ExtractMaterialWithUri` :1399 & :1405 | **런타임 도달불가** — :1534의 `if (mUseURI)`; `mUseURI = !embeddedResource` = 항상 `false` |
| 압축 전 정점 중복제거 | `RemoveUnusedVertices` :1565 | **런타임 도달불가** — :1613의 `if (compress)` 안 |
| UV셋2 / details-normal 익스포트 경로 | `ExportGeometry(..., detailsMatrix)` :1601 | **런타임 도달불가** — 모든 호출자가 `detailsMatrix` 생략(기본 Identity) → `hasUvSet2` 항상 false (:1643) |
| 2의 거듭제곱 / 최대크기 텍스처 리스케일 | `RescaleTextureSize` :2098 | INT (호출 :2093, :2228) 이지만 두 노브 모두 고정(PoT=false, max=UINT_MAX) → **무동작** |

### 5.4 Material/Texture

| 기능 | 위치 | 동작 | 도달 |
|---|---|---|---|
| 서페이스에 패브릭 적용 | `ZestManager::SetFabricMaterial` :298 | 씬에 머티리얼 기록, 재동기화 | UI (MainGUI.cpp:310) |
| 패브릭 → 엔진 머티리얼 데이터 | `zwMaterialManager::LoadIntoMaterial` :2598 | | UI (:309) + INT (Renderer3D.cpp:1510,1609,1873) |
| 에셋 uuid로 머티리얼 조회 | `LoadWithAssetUuid` :2603 | | INT (Renderer3D.cpp:284; zwGltfExporterImpl.cpp:379) |
| 에셋 uuid+타입으로 패브릭 조회 | `GetFabricMaterialDataFromAssetUuid` :3197 | | INT (Renderer3D.cpp:1505,1592,1857; exporter:703,825,974) |
| 패브릭 루트 폴더 트리 | `GetFabricRootFolder` :1274 | | **UI (:1092) — 유일한 UI 도달 머티리얼 브라우징** |
| 전체 에셋 폴더 트리 초기화 | `InitMaterialFolders` :1280 | | UI 체인 (ZestManager.cpp:57 ← MainGUI.cpp:88) |
| **u3m v1.0 파싱** | `zwU3mParser::Parse<zwU3mData>` zwU3mParser.h:25 + `zwFabricMaterial::FromU3m` :696 | | INT (zwFabricMaterial.cpp:1044; zwMaterialManager.cpp:2239) |
| **u3m v1.1 파싱** (mm→cm 변환, 프리뷰, physics 필드) | `FromU3mV11` :891 | | INT (:1033; :2229) |
| .u3m 로드 | `LoadFromU3m` :1026 | | INT — 13개 호출처 (ZestManager.cpp:659,725; zwMaterialManager.cpp:301,1099,2187,2832,2895,3283,3489,3659) |
| .u3m 기록 (v1.1/v1.0 자동선택) | `SaveToU3m` :996 → `ToU3mV11` :964 / `ToU3m` :934 | | INT — 10개 호출처 |
| **.xtex (Vizoo XML) 파싱** — 텍스처, 크기, 셰이딩(roughness/bump/disp/diffuse/specular/emissive/refraction/anisotropy/fresnel/SSS) | `zwXtexParser::Parse` zwXtexParser.cpp:100 + `FromXTex` :659 | | INT (:1059; :316,2351) |
| .xtex 로드 | `LoadFromXtex` :1054 | | INT (:2891) — 단일 호출처 |
| **.xtex 직렬화(쓰기)** | `ToXTex` :678 | zfm → zwXtexData | INT이지만 실질 무의미 — 파일존재 검증(:2319)에만 쓰이고 **디스크에 기록되지 않음** |
| .sbsar (Substance) 패브릭 폴더 | `ParseFile` :2062 (isSbsarExist 분기 :2180) | | INT |
| 패브릭 파일타입 판별 (U3M/U3MA/XTEX/JSON/JPEG/JPG/PNG/BMP/TIFF/SBSAR) | `GetFabricFileType` :608 | | INT (via `IsFabricImageFileType` :622) — **`IsFabricImageFileType` 자체는 호출자 없음 → DEAD** |
| Substance 런타임 `zsPBRMaterial` 패스스루 | `GetFabricMaterialUsingMaterialPtr` :1125 | | INT (Renderer3D.cpp:250) |
| 커스텀 컬러로 액세서리 에셋 복사 | `CopyFilesToCustomFolderWithColor` :3518 | | INT (ZestManager.cpp:605) |
| in-file 폴더 구성/갱신, uuid 재매핑, 이름 중복제거 | `MakeInFileMaterialFolder` :3102, `UpdateInFileFolder` :1933, `GetInFileUuidList` :3713, `SetInFileMaterialNames` :3075, `GetInFileMaterialNames` :3055, `GetInFileMaterialUuidList` :3048, `GetInFileEmptyFabricList` :3095 | | INT (ZestManager.cpp:544,746-782) |
| 액세서리 in-file 폴더 | `CreateInFileAccessoriesFolder` :3905, `AddAccessoriesFolder` :3931, `InitLogoFolders` :3225, `InitStitchFolders` :3237, `InitButtonHoleFolders` :3247 | | INT (ZestManager.cpp:756-789) |
| Qt 문자열 헬퍼 | `zwQtUtils::ToQString` ×3 :5,10,15 | | INT (~25개 사용처) |
| `ztUuid` Qt 메타타입 등록 | zwUuidVariant.h:7 | | **DEAD** — CMakeLists.txt:60에 등재됐으나 아무도 `#include` 안 함 |

#### Material/Texture — DEAD (호출자 없음)

| 기능 | 위치 |
|---|---|
| 완료 콜백 있는 비동기 머티리얼 목록 초기화 | `zwMaterialManager::Initialize(InitializeCallback)` :1494 (선언 .h:65) |
| **.xtex에서 Lumia `zsPBRMaterial` 직접 생성** | `CreateMaterial(const zwXtexData&)` :2469 |
| **`zwFabricMaterial`에서 Lumia `zsPBRMaterial` 직접 생성** | `CreateMaterial(const zwFabricMaterial&)` :2546 |
| xtex → zwFabricMaterial 변환기 (스텁, 본문 주석처리) | `ConvertToFabricMaterial(const zwXtexData&)` :2674 |
| u3m → zwFabricMaterial 변환기 (스텁, 본문 주석처리) | `ConvertToFabricMaterial(const U3M::zwU3mData&)` :2716 |
| **.u3ma (zip된 u3m 아카이브) 로드 + temp 추출** | `zwFabricMaterial::LoadFromU3ma` :1017 (헬퍼 `ExtractU3mFromZipFile` :1084도 여기서만 호출) |
| **u3m↔xtex 왕복 헬퍼 / 테스트 하네스** | `zsParseHelper::U2X/X2U/U3M_Write/Test` zwFabricMaterial.h:315,327,336,346 |
| XML에서 그룹화된 Substance 입력 익스포트 | `ExportGroupedInputs` .h:299 — **선언만, 정의 없음** |
| 런타임 머티리얼포인터 모드 토글 | `setUseMaterialPtr` .h:304 — **선언만, 정의 없음** |
| 원시 파일 로더 | `LoadFile` .h:310 — **선언만, 정의 없음** |
| Substance in-file 머티리얼 초기화 | `InitSubstanceInFileMaterials` .h:152 — **선언만, 정의 없음** |
| 런타임 커스텀 머티리얼 추가/제거 | `AddItemToCustomMaterials` :1305, `AddCustomMaterialList` :1316, `RemoveItemOfCustomMaterials` :1332, `UpdateCustomMaterials` :1297, `UpdateCustomMaterialAssets` :4003, `UpdateFolderMaterialOnly` :1999 |
| 프리셋 uuid 목록 | `GetPresetMaterialUuids` :1500, `GetPresetLogoUuids` :1512, `GetPresetStitchUuids` :1532, `GetPresetButtonHoleUuids` :1552, `GetPresetButtonUuids` :1572 |
| 이름/중복 유틸 | `GetCustomMaterialNameList` :1606, `IsInCurrentFolderList` :1613, `MakeCopyFileFrom` :2954, `GetNewMaterialNameInFile` :3038, `GetNewMaterialUuidInFile` :3024 |
| 폴더 범위 판별 | `IsInsideCustomFolder` :1919, `IsInsideInFileFolder` :1926 |
| 경로 헬퍼 | `getRelativePath` :2639, `GetRelativePath_CustomFabric` :2667, `GetRelativePath_InFileFabric` :3112, `GetInFileFolderName` :2770, `GetMaterialEntryNameInZipFile` :1864, `GetMaterialMapFileName` :3278 |
| 정리 | `CleanUp` :2758, `CleanUp_InFileFolder` :3119, `InitializeResultFolders` :3014 |
| 독립 에셋 JSON 생성 | `CreateJson` :2394 |
| U3M 하위항목 복사 | `CopyU3MSubItems` :2775 |
| 패브릭을 in-file로 등록 | `SetInFileFabric` :2937 |

### 5.5 Render3D

| 기능 | 위치 | 동작 | 도달 |
|---|---|---|---|
| 전체 3D 프레임 렌더 | `Renderer3D::Render` :2799 | | UI (MainGUI.cpp:746 ← main.cpp:173) |
| 드로우 리스트 구성 | `ComputeNodesToDraw` :927 | | INT (:2816) |
| 씬 디스크립터 구성 | `ComputeSceneDescriptor` :1290 | | INT (:2805) |
| 아바타 표시 | `SetShowAvatar` :44 / `IsShowAvatar` :87 | | **UI** (MainGUI.cpp:337 / 107) |
| 패턴 표시 | `SetShowPattern` :49 / `IsShowPattern` :92 | | **UI** (:342 / 108) |
| 봉제선 표시 | `SetShowSewing` :77 / `IsShowSewing` :82 | | **UI** (:347 / 109) |
| 와이어프레임 오버레이 | `SetShowWireFrame` :54 | | **UI** (:352). 게터 `IsShowWireFrame` :72는 **DEAD**, `MainGUI::mShowWireFrame`은 **초기화 없음** |
| 전체 렌더메시 클리어 | `ClearRenderMesh` :388 | | UI (:973) |
| HDRI 환경 + SH irradiance + 프리필터드 스페큘러 | `loadHDRI` :2142 | | INT (:113) |
| 방향광 2개 + 2048 섀도우맵 | `AddLights` :2172 | | INT (:115) |
| 아바타 렌더 (Mannequin 메시파트 / Zeta 바디+액세서리, 헤어 알파) | `GetNodeForAvatar` :440 | | INT (:976) |
| 클로스 패턴 메시 (+hold/harden/collision용 hide-color) | `GetNodesForClothPatternMesh` :637 | | INT (:1048) |
| 버튼 메시 + 앵커/오프셋 라인 | `GetNodeForButton` :1945, `ShowHideNodeForButtonAnchorAndLine` :2011, `CalculateButtonLine` :2194 | | INT (:1103, :1040/:2006) |
| 버튼홀 메시 + 앵커 라인 | `GetNodeForButtonHole` :1794, `ShowHideNodeForButtonHoleAnchorAndLine` :2076 | | INT (:1128, :1043) |
| 지퍼 핸들/스토퍼 메시 | `GetNodeForZipperHandle` :1698, `GetNodeForZipperStopper` :1745 | | INT (:1160, :1180) |
| 스티치 메시 | `GetNodeForStitch` :1559 | | INT (:1205) |
| 로고 메시 (메탈릭 포함) | `GetNodeForLogo` :1416 | | INT (:1224) |
| 봉제선 3D 라인 지오메트리 + 봉제각 윙 | `UpdateSewingDrawInfo` :2278 | | INT (:2813) |
| **솔기 details-normal 맵 베이킹** (테셀레이트→압출→1024px 베이크→UV2 행렬) | `UpdateDetailsNormal` :2551 | | INT (:2810) |
| 씬 AABB (섀도우용 ±1000 클램프) | `GetSceneAABB` :2254 | | INT (:2817) |
| AABB 와이어박스 노드 빌더 | `GetSceneNodeFromAABB` :2733 | | INT (:2538) — **결과 노드는 그려지지 않음** |
| 시뮬 상태 조회 | `IsSimulation` :97 | | INT (:932,1947,2086,2196,2299) |

#### Render3D — 구현됐으나 UI 진입점 없음

| 기능 | 위치 | 도달불가 사유 |
|---|---|---|
| **스무딩(세분화) 클로스 메시** | `mShowSmoothingMesh` Renderer3D.h:137 | :33에서 하드코딩 `false`, **세터 없음**. :771 `GenerateSmoothInputMesh`, :843/:848/:868, 로고 :1548, 스티치 :1664/:1686, 버튼홀 :1934 구동 |
| **두께 메시** (front/back/side 분할 + 백페이스 컬링) | `mbShowThicknessMesh` .h:138 | :34 하드코딩 `false`, **세터 없음**. :754, :843-865(3메시 분할), :879, :1097 구동 |
| **뒷면 어둡게** | `zw3DGraphicOption::darkenBackside` zwViewOptionManager.h:71 | 기본 `false`. `GetNameBoolPair()`(:36-45)에도 없고 `ReLoad`가 호출되지 않아 설정 불가. 읽는 곳 :1007, :1349 |
| **턴테이블 / VR 아바타 회전** | `avatarAngleVR` .h:59 | 기본 `0.0f`, 설정 불가. 읽는 곳 :937, 전체 변환 코드 :941-951 |
| **AABB 디버그 시각화** | `showAxisAlignedBoundingBox` .h:66 | 로컬 `bShowBoundingbox`로 읽히지만(:1295) **그 변수가 이후 미사용**. `mBoundingBoxesSceneNodes`는 :2538에서 채워지나 **드로우 호출 없음** |
| **아바타 본/스켈레톤 시각화** | `UpdateMannequinBone` :173 (본별 구/박스) | `renderData->bones`를 채우지만(:521) `mAvatarBonesSceneNode`로 전달되지 않음. 그 벡터는 `clear()`(:954)와 드로우 순회(:1306)만 됨 → 항상 비어있음 |
| **아바타 측정 라벨** | `mMeasurementsGeomNode` .h:162 | 클리어(:955)와 드로우(:1308)만, **채워지지 않음** |
| **핀 / 택 3D 마커** | `mPinsSceneNode` .h:168, `mTacksSceneNode` .h:169 | 클리어(:961,:962)와 드로우(:1377,:1380)만, **채워지지 않음** |
| **아웃라인 / 선택 하이라이트 패스** | `mRenderer.SetOutlineColor` :931 | `outlined` 하드코딩 `false` :1050. 모든 노드가 `setVisibleOnPass(outline, false)` 호출(:629,1116,1137,1175,1193,1233,2073,2493,2782) → 패스가 아무것도 렌더 안 함 |
| **반투명 back-to-front 정렬** | `sortTranslucentObjects` :1248 | 하드코딩 `false`. 정렬 블록 :1255-1282 도달불가 |
| **SSAO** | :119-125 | `ssaoEnabled = false` 하드코딩. 커널 크기/반경/바이어스는 로컬 상수 |
| **안티앨리어싱 모드** | `antialiasingIndex` :117 | `MSAA4` 하드코딩. :2804에서도 고정 |
| **3D 봉제선 토글** | `zw2DGraphicOption::show3DSewing` .h:417 | 기본 `true`, 설정 불가(ReLoad 미호출). 읽는 곳 :1999 |
| 클로스 메시 crease angle | `dataClothPattern.enableCreaseAngle` :827 | 씬 데이터에서만 옴. 120° 하드코딩 :831 |
| 바닥 투명도 | `transparentFloor` :141 | 하드코딩 `true` |

### 5.6 Render2D

| 기능 | 위치 | 도달 |
|---|---|---|
| 전체 2D 프레임 렌더 | `Renderer2D::Render(camera,w,h)` :1201 → `Render(params)` :1240 | UI (MainGUI.cpp:751 ← main.cpp:178) |
| 렌더메시 클리어 | `ClearRenderMesh` :1196 | UI (:974) |
| 배경 쿼드 | `DrawBackground` :90 | INT (:1275) |
| 가이드라인 (수직/수평/2점) | `DrawGuidelines` :28 | INT (:1188, :1276) |
| 적응형 그리드 + 축 (줌 6단계) | `DrawGrid` :98 | INT (:1189, :1277) |
| 서페이스 (미러 경계, 면적 채움, 커브, 노치, 핀, 버튼, 버튼홀, 로고, 스티치) | `DrawSurfaces` :141 | INT (:1278) |
| 버튼 연결 | `DrawButtonConnections` :295 | INT (:1279) |
| 택 포인트 | `DrawTackPoints` :341 | INT (:1280) |
| 솔기 (normal/selected/hovered 3단계 정렬 + 파티션) | `DrawSeams` :378 | INT (:1281) |
| 지퍼 밴드 경계 | `DrawZippers` :242 | INT (:1282) |
| cm 라벨 있는 스케일바 | `DrawScaleBar` :197 | INT (:1283) |
| 2D 아바타 실루엣 메시 | `GetNodesForAvatar` :1295 | INT (:1223) |
| 노치 글리프 렌더러 — I / V / L / T / U / 드릴홀 (ASTM 레이어) | `DrawNotchPoints` :541 | INT (:176) |
| 그레인라인 화살표 | 람다 `DrawGrainLine` :993 (in `DrawSurfaceCurves` :930) | INT (:1055) |
| 로고 도트패턴 텍스처 채움 | `DrawLogos` :856 | INT (:188) |

#### Render2D — 구현됐으나 UI 진입점 없음

| 기능 | 위치 | 도달불가 사유 |
|---|---|---|
| **"씬 미로드" 폴백 렌더 경로** | `RenderDefault` :1177 | :1291의 `if (params.sceneLoaded)` else에서만 호출되는데 `Render()`가 :1204에서 `sceneLoaded = true` 하드코딩 → **DEAD** |
| **2D 스티치 드로잉** | `DrawStitches` :921 | 본문이 **빈 스텁** — `opt` 읽고(:927) 리턴. 호출은 :191 |
| **그레이딩 표시** | `DrawSurfaces(params, showGrading)` :141 | 호출자가 `false` 전달(:1278)하고 파라미터를 **본문에서 읽지 않음**. `showGrading` 옵션(.h:430)은 시접 드로잉을 게이팅(:1059,:1097)하지만 설정 불가 |
| **2D 텍스처 채움 모드** | `showTexture` .h:407 | 기본 `false`, 설정 불가. PaintInterface2D.cpp:525-529(폴리곤 이미지 채움), Renderer2D.cpp:316,911,1048,1075 게이팅 |
| **정점 / 컨트롤 핸들 표시** | `showVertex` .h:405 + 로컬 `drawHandle` :1119 | `showVertex` 설정 불가(기본 true); `drawHandle`은 **하드코딩 `false`** → 커브 핸들이 절대 안 그려짐(:1124,1135,1164) |
| **2D 호버 / 선택 하이라이트** | :263-264, 304-305, 418-421, 772-773, 803-804, 875-876 | `isHovered`/`isSelected`/`selected` 전부 **하드코딩 `false`**; 파티션 람다 :418, :421이 무조건 `return false` → selected/hovered 계층이 항상 빔. `zw2DGraphicOption`의 호버/선택 색상·굵기 ~40개 필드가 전부 도달불가 |
| **가이드라인 호버/선택 색상** | :46-47 | 주석 처리됨 |
| 토글 17종 (`showGrainLine`, `showSeamAllowance`, `showNotch`, `showSewing`, `showGrid`, `showMeasure2D`, `showColorway`, `snapMode`, `snapToGrid`, `showUVEditor`, `show3DAvatar`, `show3DAvatarBone`, `show3DStitch`, `showDesignVertex/Curve/Boundary/Surface`, `showBrokenMirror`) | zwViewOptionManager.h | **`ReLoad()` (.cpp:163)에 호출자가 없어 `viewOption.txt`를 읽지도 쓰지도 않음** → `SaveToMap` :16 / `LoadFromMap` :83도 DEAD, 모든 옵션이 컴파일 기본값에 동결 |
| 3D 전용 옵션 (`showMannequinMeasure` .h:60, `showWireFrame` :61, `showCollisionAvatar` :62, `hoverSewing3D` :64, `showCornerVertices` :67, `showSeamVertices` :68, `showSelfSewingVertices` :69, `showAllVertices` :70) | zwViewOptionManager.h | **어떤 렌더러도 읽지 않음** — 순수 죽은 데이터 |

### 5.7 PatternEdit

| 기능 | 위치 | 동작 | 도달 |
|---|---|---|---|
| 패턴 서페이스 W×H 리사이즈 | `UpdateSizeSurface` ZestManager.cpp:60 | `CommandScaleSurface` + 메시 토폴로지 라이브에디트로 스케일 | UI (MainGUI.cpp:325) |
| 서페이스 크기 조회 | `GetSurfaceSize` :152 | | UI (:1044) |
| 서페이스 열거 | `GetSurfaceInfos` :130 | | UI (:1037) |
| 아바타 엔드포즈 설정 (Zeta) + 애니메이션 재실행 | `SetEndPose` :83 | | UI (:286) |
| 아바타 데이터 조회 | `GetAvatarData` :324 | | UI (:1055) |
| **클로스 패턴 데이터 열거** | `GetClothPatternInfos` :120 | uuid + `ztDesignClothPatternData` | **DEAD** — 호출처 없음 |

### 5.8 Interaction

| 기능 | 위치 | 동작 | 도달 |
|---|---|---|---|
| 클로스 마우스 그래빙 시작 (레이/AABB 브로드페이즈 → 클로스별 교차 → 최근접 정점 → `CreateMouseGrabbingConstraint`) | `StartGrabbing` ZestManager.cpp:181 | | UI (MainGUI.cpp:810) |
| 그랩 지점 드래그 | `OnGrabbing` :269 | | UI (:822) |
| 그랩 해제 | `EndGrabbing` :287 | | UI (:816) |
| 그래빙 여부 | `IsGrabbing` :362 | | UI (:792) |
| 키보드 s/space/r/c | `MainGUI::OnKeyEvent` :759 | | UI (main.cpp:60) |

### 5.9 PaintInterface2D — 미사용 프리미티브 20종

**[코드 확인]** 전부 `PaintInterface2D.cpp`, 호출자 없음:

| 분류 | 항목 |
|---|---|
| 도형 | `DrawArc` :193, `DrawFixedSizeArc` :203, `DrawCircleArc` ×2 :208/:213, `DrawTriangle` :265, `DrawDashedBezier` :308, `DrawDashedCircle` :395, `DrawAABB` :132, `DrawFixedSizeRectangle` :658, `DrawFixedSizeSolidRectangle` :678 |
| 텍스트 | `SetFontAlignment` :717, `DrawStringBox` :779, `DrawMeasurementsStringBox` :795 |
| **이미지/텍스처 변환 API** | `CreateImage` :858, `DeleteImage(int)` :869, `DeleteImage(vector<int>)` (.h:143 **선언만, 정의 없음**), `DrawRectImage` :881 (회전/앵커중심 텍스처 쿼드) |
| 변환/투영 | `ResetTransform` :919, `SetScaleFactor` :931 / `GetScaleFactor` :936, `SetViewProjectionMatrix` :941 / `GetViewProjection` :946 (3D→2D 화면 투영) |
| 종료 | `Shutdown` :73 — **호출되지 않음 → nanovg 컨텍스트 + 모든 로드된 이미지가 종료 시 누수** |

### 5.10 빌드에서 제외된 파일 (CMakeLists.txt에 없음)

| 기능 | 위치 | 상태 |
|---|---|---|
| **HDRI 환경 매니저** — 상대경로 env 로드, SH 로딩, 바닥맵 설정(basecolor/normal/roughness/specular + repeat), 배경타입(skybox / radiance / irradiance / proceduralSky / white / black), 바닥 dirty 플래그 | `EnvironmentManager` EnvironmentManager.h:42 / .cpp:19-172; `Environment` .h:21 | **NOT-BUILT** — `.h`도 `.cpp`도 CMakeLists.txt SOURCE_FILES(:10-38)에 없음. 아무도 `#include` 안 함. Renderer3D는 대신 자체 HDRI 경로를 :111에 하드코딩 |
| **씬 뷰 생명주기 베이스** (OnSceneLoaded/Unloaded/Unloading, OnHistoryChanged/Reset, OnSceneModeChanging/Changed) | `zwBaseSceneView` scene/zwBaseSceneView.h:10 / .cpp:5-81 | **NOT-BUILT** — SCENE_FILES(:40-48)에 없음. 게다가 이 저장소에 존재하지 않는 `scene/zwSceneManagerProxy.h`를 `#include`하므로 **컴파일조차 불가** |

### 5.11 기타 DEAD 항목

| 기능 | 위치 |
|---|---|
| `Renderer3D::IsShowWireFrame` | Renderer3D.cpp:72 |
| `Renderer2D::RenderDefault` | Renderer2D.cpp:1177 (도달불가 분기) |
| `Seam2DRenderer::GetCurveSegmentEndpoints` | Seam2DRenderer.cpp:251 |
| `ZestManager::GetClothPatternInfos` | ZestManager.cpp:120 |
| `MainGUI::CallbackEndMorpingAvatar` | MainGUI.cpp:862 |
| `MainGUI::eventMetarialColorChanged` | MainGUI.h:25 (ctor에서 nullptr :78, 호출 없음) |
| `MainGUI::mComSurfaceDatasForClothes` | MainGUI.h:122 (:1048에서 할당, 읽히지 않음) |
| `MainGUI::GetOpenFilePahts()` | MainGUI.cpp:125-151 — 다중선택 OFN 버퍼 파싱. 호출 없음 → 다중파일 로드 도달불가 |
| `MainGUI::GetNumberPrecision<T>()` | MainGUI.cpp:23-29 |
| `MainGUI::GetItemIndex<T>()` | MainGUI.cpp:31-37 |
| `ComboUIData<T>::eventChanged` | MainGUI.h:87 + `Clear()`의 리셋(.h:64) — 4개 콤보 인스턴스 어디에도 할당/호출 없음 |
| `zwViewOptionManager::ReLoad` | .cpp:163 + `zw2DGraphicOption::SaveToMap` :16 / `LoadFromMap` :83 — `viewOption.txt` 영속화가 전혀 실행되지 않음 |
| **뷰 옵션 접근자 전체** | `zw3DGraphicOption::GetNameColorPair` .h:11, `GetNameSizePair` :29, `GetNameBoolPair` :36; `zw2DGraphicOption::GetNameColorPair` :77, `GetNameSizePair` :146, `GetNameBoolPair` :211, `GetFabricPhysicalPropPairs` :235 — 옵션 UI가 바인딩할 label→reference 테이블. 호출자 없음 → 이들이 열거하는 모든 라벨(3D 색상, 2D 색상 ~45, 2D 크기/불투명도 ~50, 2D 불리언 17, 패브릭 물성 min/max 15)이 도달불가 |
| 주석 처리 코드 | zwViewOptionManager.h:468 `// auto Get2DEditorOption()`, .h:473 `// static zw2DEditorOption mEditorOption2D;`, .cpp:14, .cpp:220-223. `struct zw2DEditorOption`(.h:456-458)은 비어있고 아무데서도 참조 안 됨 |

### 5.12 실제로 렌더러가 소비하는 뷰 옵션 (전부 읽기전용, 쓰는 곳 없음)

**[코드 확인]** ~130개 옵션 중 실사용은 이것뿐:

| 옵션 | 읽는 곳 |
|---|---|
| `Get2DViewOption().curveSelected` | Renderer3D.cpp:930 |
| `show3DSewing` | Renderer3D.cpp:1999 |
| `seamColor` / `seamH` / `seamS` | Renderer3D.cpp:1385-1387, 2051, 2119 |
| `showTexture` | PaintInterface2D.cpp:525 |
| `showNotch` / `showGrainLine` / `showGrading` / `showSeamAllowance` | Renderer2D.cpp:549, 1031, 1059, 1097 |
| `Get3DViewOption().avatarAngleVR` | Renderer3D.cpp:937 |
| `darkenBackside` | Renderer3D.cpp:1007, 1349 |
| `showAxisAlignedBoundingBox` | Renderer3D.cpp:1295 |

전부 struct 기본값에 고정됨.

---

## 6. Zest 미들웨어 인벤토리

**[코드 확인]** 대상: `Zest/` (`Zelus/`, `external/`, `vcpkg/`, `build/`, `.github/` 제외)
판정 방법: 샌드박스의 모든 `zt*` 식별자 빈도 추출(`grep -rhoE '\bzt[A-Za-z0-9_]+'`) + 메서드별 호출처 grep. 출현 0회 = 앱에서 도달 불가 확정.

### 6.1 simulation\ (15 파일) — 시뮬레이션 제어면

| 기능 | 클래스 / 위치 | 동작 | 상태 |
|---|---|---|---|
| 씬 생명주기 소유자 | `ztSceneManager` simulation/ztSceneManager.h:18 | 현재 씬 + 시뮬매니저 + 히스토리 소유 | **USED** ZestManager.cpp:44, RendererBase.h:13 |
| 새 씬 | `NewScene` :30 | 빈 씬으로 리셋 | **USED** :796 |
| .zls 로드 | `LoadScene` :33 | drapingboard+colorway 플래그와 함께 로드 | **USED** :812 |
| .zls 저장 | `SaveScene` :36 | temp/drapingboard/colorway/allInfile 옵션 | **USED** :864 (기본 인자만) |
| **씬 병합 (2번째 zls)** | `AppendScene` :37 | 다른 zls를 현재에 병합 | UNUSED |
| 스레드풀 주입 | `SetThreadPool` :35 | 시뮬 스레드풀 교체 | 직접 UNUSED; ctor 기본 `async=true`라 ztSceneManager.cpp:63,98에서 `new ztThreadPoolImplSTL` 자동 호출 |
| 씬 모드 전환 | `SetSceneMode` :57 | DESIGN ⇄ SIMULATION | **USED** :446,951,958 |
| 히스토리 훅 | `OnHistoryChanged`/`OnNewSnapshot`/`OnHistoryReset` :44,46,48 | undo/redo 반응 | UNUSED |
| 씬모드 변경 훅 | `OnSceneModeChanging`/`Changed` :51,54 | virtual 알림 지점 | UNUSED |
| 고아 택 복구 | `DeleteOrphanTacks` :70 | | UNUSED |
| 잘못된 핀 복구 | `DeleteInvalidPins` :71 | | UNUSED |
| 제품 정보 | `SetProductInfo` :74 | zls에 제품타입 태그(zweave) | UNUSED |
| 검증 경고 콜백 | `SetVerificationAlert` :68 | 로드 시 사용자 경고 훅 | UNUSED |
| 임시 zls 자동저장 | `GetTempZlsFile`/`RemoveTempZlsFile` :64,86 | 크래시 복구 임시파일 | UNUSED |
| Alvanon 복호기 접근자 | `GetAlvanonDecryptor` :89 | 서드파티 아바타 복호화 훅 | UNUSED |
| 씬 옵션 | `SetSceneOption` :59 | 액세서리 충돌 토글 | UNUSED |
| 선택 클리어 / 서페이스ID 리셋 | `ClearSelection` :83, `ResetSurfaceId` :84 | | UNUSED |
| **시뮬레이션 매니저** | `ztSimulationManager` ztSimulationManager.h:20 | 시뮬 실행 루프 구동 | **USED** ZestManager.cpp 12곳, Renderer3D.cpp:99 |
| Start (비동기 실행) | `Start(cb)` :37 | 시작/재개, 프레임별 콜백 | **USED** :952 |
| Step | `Step(bImmediately)` :38 | 1프레임 진행 | **USED** :963 (`bImmediately=false`만) |
| Pause | `Pause()` :40 | | **USED** :946 |
| Reset | `Reset()` :39 | 프레임 -1로 되감기 | **USED** :437,803,957 |
| 상태 조회 | `IsSimRunning`/`IsSimPaused`/`IsSimRunningOrPaused`/`IsReset` :43-46 | | **USED** :317,874,878,882; Renderer3D.cpp:101 |
| 상태 콜백 (7슬롯) | `SetStatusCallBackFunctions` :60 | start/pause/statusChanged/avatarChanged/view3dChanged/mainStatus/runStep | **PARTIAL** :828 — `mainStatus`만 연결, 나머지 6개 `nullptr` |
| 에너지 계산 | `SetEnergyCalc`/`GetEnergyCalc` :52,53 | 프레임별 변형에너지 계산 | UNUSED |
| 시뮬월드 스냅샷 | `SaveSimWorldData` :67 | zsSimulationWorld → 바이트 | UNUSED |
| **드레이핑 아이템 로드** | `LoadDrapingItem` :68 | 저장된 드레이핑 스냅샷 복원 | UNUSED |
| 라이브 에디팅 | `UpdateLiveEditing` :69 | 시뮬 중 대기 편집 적용 | 직접 UNUSED (앱은 `ztUpdateLiveEditing` RAII 사용: :64,519) |
| **타임라인: 동기 스텝** | `StepSync(ztTimelineMode)` :73 | 타임라인 모드 블로킹 스텝 | UNUSED |
| **타임라인: 동기 리셋** | `ResetSync()` :74 | | UNUSED |
| **타임라인: 프레임 캐시** | `LoadCache(frameNo)` :75, `SaveCache()` :76 | 임의 캐시 프레임으로 스크럽 | UNUSED |
| 명시적 executor 초기화 | `InitializeExecutor()` :72 | 시작 없이 executor 구성 | UNUSED |
| 프레임 카운터 | `GetFrame()` :78 | | UNUSED |
| 라이브에디트 필요 체크 | `CheckIfNeedToLiveEditing` :79 | 버전 인지 dirty 체크 | UNUSED |
| **Executor 베이스** | `ztSimulationExecutor` ztSimulationExecutor.h:25 | 추상 시뮬 백엔드 | **USED** :172,249,273,291,366,897 |
| 시뮬월드 접근 | `GetSimWorld()` :47 | 원시 `zsSimulationWorld*` | **USED** :174,252,899 |
| 마우스 그래빙 (패턴 히트) | `CreateMouseGrabbingConstraint(clothPattern,…)` :41 | 스프링으로 클로스 정점 잡기 | **USED** :259 |
| 마우스 그래빙 (레이) | `CreateMouseGrabbingConstraint(model, rayDir, rayOrigin)` :43 | 레이픽 오버로드 | UNUSED |
| 그랩 타겟/클리어/조회 | `SetTargetGrabbingPoint` :45, `ClearMouseGrabbingConstraint` :44, `GetMouseGrabbingConstraint` :46 | | **USED** :281,293,275,366 |
| 프레임 get/set | `SetFrame`/`GetFrame` :50,51 | | UNUSED |
| **라이브에디트 큐 API 12종** | `SetLiveEditType` :56, `AddLiveEditTransform` :57, `AddLiveEditSculpt` :58, `AddScissorClothes` :60, `AddSimClothMeshes` :61, `AddMergeClothes` :62, `AddUpdatedObjects` :63, `AddInitClothMeshes` :64, `AddInitButtons` :65, `SetAvatarAnimationInfos` :66, `ClearLiveEdit` :67, `GetLiveEditInfo` :68 | 전체 재시작 없이 토폴로지/변환/스컬프트 편집 큐잉 | **전부 UNUSED** |
| 타임라인 캐시 (virtual) | `LoadCache` :71, `SaveCache` :72 | | UNUSED |
| **CPU executor 구현체** | `ztSimulationStandardCPUExecutor` :12 | 전체 CPU/GPU플래그 시뮬 백엔드 (유일 구현) | 이름으로는 UNUSED (내부 생성 ztSimulationManager.cpp:201,298,503) |
| 클로스 파라미터 초기화 | `InitializeClothParameter` :40 | | UNUSED |
| **시뮬 데이터모델** | `ztSimulationDataModel` :24 | 씬→zsSimulationWorld 브리지 (~55 메서드) | **PARTIAL**: `GetGlobalVertexIndex` :85 @ :252; `GetScene` :59 @ :257. 나머지 ~53개 UNUSED |
| — 봉제/와이어 스프링 | `ConstructSewingSprings` :31, `ConstructWireSprings` :32 | | UNUSED |
| — 택 제약 5종 | `UpdateTackClothToAvatar` :35, `UpdateFixedTackClothToCloth` :37, `UpdateFixedTackClothToAvatar` :38, `UpdateTackClothToCloth` :39, `UpdatePinConstraints` :40 | | UNUSED |
| — 버튼 스프링 | `UpdateButtonConnectSprings` :36, `UpdateButtonSprings` :41, `UpdateButtonTransform` :44 | | UNUSED |
| — 에너지 | `UpdateEnergies` :42 | | UNUSED |
| — **라이브 토폴로지 변경** | `UpdateClothMeshTopology` :46, `MergeClothes` :50, `UpdateClothObject` :51, `RemoveCloth` :83, `RemoveAllClothes` :84, `CreateCloth` :87 | 시뮬 중 클로스 추가/제거/병합/리토포 | UNUSED |
| — **스컬프팅** | `Sculpt` :48 | 시뮬 중 정점 델타 스컬프트 | UNUSED |
| — 드레이핑 프레임 수학 | `GetTotalDrapingFrame` :67, `GetTimelineDrapingFrame` :70, `SetTimelineDrapingFrame` :71, `GetActivationIntervalFrame` :75 | | UNUSED |
| — 지퍼 UV / 아바타 uuid | `UpdateZipperUVS` :81, `UpdateAvatarUuids` :82 | | UNUSED |
| — 패턴 검증 | `ValidateSimulationPattern` :88 | | UNUSED |
| 타임라인 모드 enum | `ztTimelineMode` ztTimelineMode.h:3 | NONE / ACTIVE | UNUSED |
| Runnable 인터페이스 | `ztRunnableBase` :6, `ztRunnableSTL` :8 | 태스크 추상화 | UNUSED |
| 스레드풀 인터페이스 / STL 구현 | `ztThreadPoolBase` :8, `ztThreadPoolImplSTL` :10 | 비동기 시뮬 구동 detached 스레드풀 | 이름으로는 UNUSED; ztSceneManager.cpp:63에서 기본 생성 |

### 6.2 scene\ — 파일 포맷

| 기능 | 클래스 / 위치 | 동작 | 상태 |
|---|---|---|---|
| 파서 팩토리 + 버전 프로브 | `ztSceneParser::CreateInstance` scene/ztSceneParser.h:24, `GetFileVersion` :42, `IsZipFile` :22 | 파일 시그니처로 파서 선택 | UNUSED (헤더는 ZestManager.cpp:21에서 include하나 호출 없음) |
| 파서 옵션 | `SetAppend` :27, `SetAppendDrapingItemMode` :28, `SetOption` :29, `SetProductInfo` :30, `SetRunSync` :31, `SetCallback` :38 | | UNUSED |
| **V10 zls 파서** | `ztSceneParserV10` :5 | 메인 .zls 리더 | UNUSED (`ztScene::LoadZls`가 내부 구동) |
| — zip/text/drapingboard/colorway 리더 | `ReadScene` :14, `ReadText` :22, `ReadZip` :23, `ReadDrapingBoard` :25, `ReadColorway` :26 | | UNUSED |
| — 그레이드차트 리더 | `ReadGradeChart` :53,54 | zls에서 그레이딩 패널 읽기 | UNUSED |
| — zls 히스토리 리더 | `ReadZlsInfoHistory` :51,52 | | UNUSED |
| — **레거시 포맷 마이그레이터 21종** | `CorrectCurveAndSeamAngle` :57, `CorrectBoundaryType` :61, `ConvertDrapingTimeRelatedData` :65, `CorrectSurfaceWinding` :69, `CorrectSurfaceSeam` :72, `CorrectLegacySurfaceData` :83, `CorrectClothPatternMaterialData` :88, `CorrectPin` :93, `CorrectNotch` :95, `CorrectTack` :99, `CorrectPatternSimParams` :102, `CorrectLegacyLogoButton` :106, `CorrectDanglingZipper` :109, `CorrectSeam` :110, `CorrectButton` :112, `CorrectInvalidPattern` :116, `CorrectMaterials` :118, `CorrectAvatar` :119, `CorrectSimulationParams` :121 (+drapingBoard 변종) | 씬모델 버전별 하위호환 복구 | UNUSED |
| — in-file 에셋 추출 | `ExtractCustomLeftAccessories` :129, `ExtractZetaAsset` :130, `ExtractZeta` :131, `ExtractZetaCustomTextures` :132, `ExtractCustomAsset` :141, `ExtractCustomAccessory` :147 | zls zip에서 임베드 에셋 언팩 | UNUSED |
| **Rozy 포맷 파서** | `ztSceneParserRozy` :5 | 대체(Rozy) 씬 JSON 리더 | UNUSED |
| **Blank 파서** | `ztSceneParserBlank` :5 | 빈 씬 스텁 파서 | UNUSED |
| **씬 라이터** | `ztSceneWriter` :59 | 전체 zls zip 라이터 | UNUSED (`ztScene::Save`가 내부 호출) |
| — 문자열로 쓰기 | `WriteToString` :69 | 씬→JSON 문자열 | UNUSED |
| — **Rozy 익스포트** | `WriteRozy` :72 | Rozy 포맷으로 씬 내보내기 | UNUSED |
| — 저장 진행 콜백 (30단계) | `SetSceneSaveCallback` :67 + `ztSceneSaveStatus` enum :21 | 세밀한 저장 진행 UI | UNUSED |
| — in-file 패커 12종 | `AddCustomMaterialsToZipFile` :76, `AddCustomLogosToZipFile` :78, `AddCustomStitchesToZipFile` :80, `AddCustomButtonHolesToZipFile` :82, `AddCustomButtonToZipFile` :83, `AddCustomZipperHandleToZipFile` :84, `AddCustomZipperStopperToZipFile` :85, `AddCustomAvatarToZipFile` :99, `AddZetaPoseToZipFile` :101, `AddZetaToZipFile` :105, `AddDrapingBoardToZipFile` :94, `AddColorwayToZipFile` :97 | zls에 커스텀 에셋 임베드 | UNUSED |
| JSON 리더 | `ztJSONReader` :12 | 40+ 타입별 `Read` 오버로드, 섹션 스택, 배열 접근 | **USED (클래스만)** zwMaterialManager.cpp:15, .h:27 |
| JSON 라이터 | `ztJSONWriter` :14 | 40+ 타입별 `Write` 오버로드 + `WriteFileReserve` :43 / `WriteFromMemoryReserve` :46 | **USED (클래스만)** zwMaterialManager.cpp:16, ZestManager.cpp:13 |
| **DXF 데이터 모델** | `ztDxfDataStore` ztDxfDataStore.h:196 + `ztDxfLayer` :25, `ztDxfInsert` :35, `ztDxfPoint` :42, `ztDxfVertex` :58, `ztDxfSpline` :111, `ztDxfText` :89, `ztDxfLine` :98, `ztDxfPolyline` :129, `ztDxfPatternPiece` :143 | DXF 패턴피스 엔티티 모델 + rule-id/turn-point 태깅 + 2D 변환 | UNUSED. **Zest 안에 임포터/익스포터가 존재하지 않음** — 데이터 구조뿐. `ztScene.h:18`이 전방선언만 하고 이 저장소에서 소비하는 곳 없음 |
| **DXF 그레이딩 테이블** | `ztGradingTable` :157, `ztGradingRule` :167 | DXF 룰 파일에서 사이즈별 포인트 델타 그레이딩 규칙 | UNUSED |
| 직렬화 헬퍼 | `ztUtilityForSerialize` :7 | zsTransform ⇄ float 배열 (구/신 레이아웃) | UNUSED |

### 6.3 scene\ — 편집 액션 (전체 기능군이 앱에서 도달 불가)

| 기능 | 클래스 / 위치 | 동작 |
|---|---|---|
| **가위 / 패턴 절단** | `ztScissorAction` ztScissorAction.h:20 | 베지어 "attacker" 커브로 서페이스 절단 |
| — 전체 절단 | `CutAll` :27 | 일괄 절단, old→new 서페이스 맵 반환 |
| — 단일 절단 | `Cut` :30 | 서페이스 1개를 N개로 분할 |
| — 미러 인지 절단 | `DivideCurveIntersectMirror` :77, `RecomputePatternTransform` :106 | 절단 시 미러 쌍 동기 유지 |
| — 절단 간격 | `ComputeScissorGap` :99 | 절단면 자동 분리 |
| — 절단 후 자동 봉제 | ctor 인자 `sew` :23, `mCurvesToBeSewed` :150 | 절단선 재봉제 |
| **두 패턴 병합** | `ztMergeAction` ztMergeAction.h:17 | 매칭된 커브를 따라 소스 서페이스를 타겟에 접합 |
| — 커브쌍 병합 | `Execute(srcCurves,tgtCurves,deltaTrs)` :25 | 주 API |
| — 서페이스-서페이스 병합 | `Execute(uuidSurface0,uuidSurface1)` :28 | 주석상 미완성 |
| — 로고/버튼/핀 이관 | `CopySourceLogosToTarget` :52, `CopySourceButtonsToTarget` :54, `CopySourcePinTackPointsToTarget` :56, `AdjustSeamConnection` :58 | |
| **커브 연장/트림** | `ztCurveExtendAction` :10 | 서페이스 외곽까지 커브 연장/트림 |
| — 수직 vs 연장 모드 | `methodType` :13, `SetMethodType` :22, `SetExtendDir` :21, `SetSourceTrim` :23 | |
| — 실행 (서페이스 / 자유 지오메트리) | `Execute` :27, :31 | |
| — 커브 트림 | `TrimCurves` :34 | 불리언 방식 트림 |
| **커브 집합 필터/불리언** | `ztCurveFilterAction` :16 | 커브 선택 분류 + 집합연산 |
| — 경계타입별 | `GetCurves(ztBoundaryType)` :21, `GetCurves(ztBoundaryDetailType)` :22, `GetOuterCurves` :23, `GetInnerCurves` :24, `GetStitchCurves` :25, `GetHoleCurves` :26 | |
| — 서페이스별 그룹 | `GetSurfaces` :27, `Classify` :28 | |
| — 집합 대수 | `Union` :30, `Intersection` :31, `Subtraction` :32, `Difference` :33 | |
| **커브 오프셋 (시접)** | `ztCurveOffsetAction` :15 | N개 평행 오프셋, 수직/연장/미러 끝단 처리, 옵션 사이드커브 |
| — 실행 | `Execute(dist,count,nType,bSideCurve)` :53 | |
| — 결과 접근 | `GetSurfaceSet` :56, `GetExtraGeomCurve` :58, `ztOffsetSection` :25 / `ztOffsetSlice` :18 | |
| **커브 분할** | `ztSplitCurveAction` :42 | 교차점에서 커브 분할, 7개 오버로드 |
| — 타입 마스크 | `ztSplitCurveType` :19, `SetTargetCurveType` :58 | inner/outer/stitch/시접 타겟팅 |
| — 분할 변종 | `Execute` :62,65,68,71,74,77,78 | geom-vs-surface, uuid-vs-uuid, 자기분할 |
| — 드라이런 모드 | `SetExplicitSplit` :86, `GetCurve2SplitTimes` :89, `GetSplitTimes` :92, `GetSourceSplitTimes` :80 | 변경 없이 분할 파라미터만 계산 |
| **3D 폴드** | `ztFoldIn3D` :14 | 표시된 폴드 커브를 따라 의류 메시 접기 |
| — 폴드 경계/체인 찾기 | `FindBoundaryFoldIn3D` :20, `FindConnectedCurvesFoldIn3D` :23 | |
| — 단일/다중/평행 폴드 | `FoldWithSingleCurve` :29, `FoldWithMultipleCurves` :30, `FoldWithParallelCurves` :34, `FoldWithGeneralCurves` :35 | 미러 인지, 라운드니스 제어 |
| **버튼 스냅** | `ztButtonSnapAction` :11 | 이탈한 버튼을 서페이스로 복귀 |
| — 전체 스냅 / 정점 갱신 | `SnapAllButtonOfSurface` :18, `UpdateVertex` :17 (static) | |
| **버튼홀 스냅** | `ztButtonHoleSnapAction` :8 | `SnapAllButtonHolesOfSurface` :13, `SnapButtonHoleToSurface` :15 |
| **로고 스냅 / 재부모화** | `ztLogoSnapAction` :9 | `SnapAllLogosOfSurface` :14, `SnapLogoToSurface` :16, `SnapLogoToAllSurfacesByCenter` :18, `ChangeLogoPattern` :19 |
| **커브 삽입 커맨드셋** | `ztInsertCurveCommand` :16 | 자동 서페이스 탐색과 함께 커브 삽입 |
| — 서페이스에 삽입 | `InsertCurveToSurface` :24, `InsertConnectedCurvesToSurface` :25 | |
| — 서페이스 탐색 | `FindCandidateSurfacesByCurveAABB` :28, `FindClosedSurfaceWithCurvePosition` :29, `FindSurface` :30, `GetMirroredSurface` :42 | |
| — 복사/미러/언폴드/이전 | `CopyCurve` :32, `MirrorCurve` :33, `UnfoldCurve` :34, `TransCurveS1toS2` :35 (+복수형 :37-40) | |
| — **커브로 새 패턴 생성** | `CreatePatternWithCurves` :45 | 커브에서 새 패턴 도려내기 |
| **봉제 커맨드셋** | `ztSewingCommand` :13 | 솔기 세그먼트 분할 + 봉제점 생성 |
| — 쌍/메인/커브 분할 | `DividePair` :20, `DivideMain` :21, `DivideJustCurve` :22, `DivideMatchConnection` :27 | |
| — 세그먼트 조회 | `GetSegmentsInPart` :24, `GetSegmentsCopyInPart` :25 | |
| — **봉제쌍 해석** | `CalculateSewingSegmentsPair` :29, `GetSewingPositions` :31 | 솔기 양면 매칭 + 테셀레이트된 봉제점 생성 |
| — 거리 조회 | `FindNearestPointOnSeamCurves` :34, `GetSquaredDistanceFromSeamCurves` :35, `GetSquaredDistanceFromSewingLines` :36, `GetSquaredDistance` :37 | |

### 6.4 scene\ — 관리자, 검증, 쿼리

| 기능 | 클래스 / 위치 | 동작 | 상태 |
|---|---|---|---|
| **Undo/Redo 히스토리** | `ztHistoryManager` ztHistoryManager.h:81 | 전체 `ztSceneData` 위의 스냅샷 스택 | **UNUSED** — `ztSceneManager` ctor(:26)가 `historyManager=nullptr` 기본, ZestManager.cpp:44가 아무것도 전달 안 함 → **구조적으로 비활성** |
| — undo/redo | `Undo` :109, `Redo` :110, `CanUndo` :106, `CanRedo` :107 | `ResultType`에 `NoSnapshotInSimulationMode` 포함 | UNUSED |
| — 스냅샷 | `TakeSnapshot` :114, `PopSnapShot` :122, `RestoreSnapshot` :135, `GetSnapshotIndex` :120 | | UNUSED |
| — redo 가지치기 | `FlushRedos` :132,133 | | UNUSED |
| — 잠금 | `LockUndoRedo` :124, `UnlockUndoRedo` :125 | | UNUSED |
| — 히스토리 디스크 영속화 | `Save` :127, `Load` :128 | undo 스택 전체 아카이브 | UNUSED |
| — dirty 추적 | `HasUnsavedChanges` :112, `OnSceneLoaded` :116, `OnSceneSaved` :117 | | UNUSED |
| — 스냅샷 내 시뮬메시 | `SaveSimMesh` :136 | | UNUSED |
| — 캡처 상태 + 라이브에디트 페이로드 | `ztCapturedState` :14, `LiveEditInfo` :29, `AvatarAnimationInfos` :17 | 스냅샷이 가위/병합/스컬프트/버튼 델타 + 아바타 애니 상태 보유 | UNUSED |
| — 아카이브 연산자 22개 | :155-194 | 모든 디자인 데이터 구조의 바이너리 ser/de | UNUSED |
| **선택 관리자** | `ztSelectionManager` ztSelectionManager.h:19 | 서브인덱스 포함 다중선택, 스레드세이프 | UNUSED (앱은 `Renderer3D`에서 자체 피킹) |
| — 선택 연산 | `Select` :52, `ToggleSelect` :53,54, `SelectAdditional` :55,56, `SelectMultiple` :57,58, `ClearSelection` :50 | | UNUSED |
| — 타입별 조회 | `GetSelection(ztSceneDataType,…)` :62, `GetSelectionUuids` :61, `GetLatestSelection` :75, `IsAllSameObjectType` :65 | | UNUSED |
| — **간접 선택** | `SetIndirectSelected` :44, `GetIndirectSelected` :45, `IsIndirectSelected` :47, `RemoveIndirectSelected` :48, RAII `ztSelectionIndirect` :98 | 파생/암시 선택 추적 | UNUSED |
| — **그레이딩 포인트 선택** | `AddGradingPointSelected` :39, `GetGradingPointsSelected` :40 | | UNUSED |
| — 서페이스 필터 | `FilterSurface` :67, `FilterSurfaceWithZipperTape` :72 | | UNUSED |
| — 변경 추적 / 콜백 | `GetTrackedSelection` :64, `SetSelectionChangeCallback` :77 | | UNUSED |
| **에셋 관리자** | `ztAssetManager` ztAssetManager.h:178 | 20개 에셋 타입에 대한 정적 레지스트리 | **USED 다량** |
| — 에셋 루트 | `GetAssetRoot` :185 (7×), `GetAppdataRoot` :186 (8×), `GetAssetRootByType` :192 (9×), `GetFabricRoot` :193 (3×) | | **USED** zwMaterialManager.cpp, Renderer3D.cpp, ztSceneManager.cpp:40 |
| — 에셋 조회 | `GetAssetInfo` :198,200,203 (14×), `GetAssetInfoList` :189 (8×) | | **USED** |
| — 캐시 리셋 | `ResetCache` :214 (4×) | | **USED** |
| — 폴더 트리 | `GetAssetFolders` :195, `GetAssetList` :196, `GetAssetIndex` :197 | | UNUSED |
| — 필드 프로브 | `GetFieldDataAsBool` :205, `GetFieldDataAsFloat` :206, `IsCustom` :207, `IsDefault` :208, `IsInFile` :209, `GetAssetJsonFullpath` :210 | | UNUSED |
| — **에셋 저작** | `CreateAssetJson` :219, `GetCopyName` :217, `GetCustomFolderPath` :218, `FindAssetInfoFromDir` :216 | 디스크에 새 커스텀 에셋 생성 | UNUSED |
| — **Alvanon in-file 아바타** | `GetAvatarAssetInfoInFile` :215 | zls에 임베드된 `.avaz` 아바타 목록 | UNUSED |
| — 에셋 정보 | `ztAssetInfo` :103 — `Read` :128, `GetMaterialPath` :131, `GetDataAsBool/Float/Int` :133-135, `IsDevmodeModel` :125 | | **PARTIAL** — struct는 사용(30×)되나 이 메서드들은 UNUSED |
| **데이터 의존성 감시자** | `ztDataDependency` :11, `ztDataMemberDependencyImpl<T>` :28 | 씬 데이터 멤버 변경 시 콜백 발화 | UNUSED |
| **컬러웨이 시스템** | `ztColorway` ztColorway.h:96 + `ztColorwayItem` :70, `ztColorwayFabric` :13, `ztColorwayStitch` :21, `ztColorwayLogo` :27, `ztColorwayButton` :33, `ztColorwayButtonHole` :39, `ztColorwayZipper` :45, `ztColorwayVisibility` :51 | 한 벌의 명명된 색상/소재 변형 + 프리뷰 이미지 + 오브젝트별 가시성 | **UNUSED** (0회) |
| **제품 정보** | `ztProductInfo` :14 | zls 제품타입 태그("zweave") | UNUSED |
| **Alvanon 복호기 인터페이스** | `ztAlvanonDecryptorInterface` :12 | 서드파티 암호화 아바타용 순수가상 훅: `SetAPFPath` :15, `SetUserId` :16, `GetMeasurement` :20, `GetFBXBuffer` :21, `IsValidAPF` :23, `IsValidAVAZ` :24 | **UNUSED** — 이 저장소에 구현체도 없음 |
| **경계 연결성 복구** | `ztBoundaryConnectivityChecker` :10, `Run` :15 | 끊어진/빈 경계 수정, 외곽 CCW 강제, 길이 0 커브 제거 | UNUSED |
| **고아 오브젝트 GC** | `ztDanglingObjectEraser` :9, `Execute` :14 | 고아 서페이스/로고/경계/커브/정점/솔기 삭제 | UNUSED |
| **솔기 연결성 탐색기** | `ztSeamConnectivityFinder` :19 | 봉제/측정용 연결 커브 체인 순회 | **UNUSED** — 헤더는 `Seam2DRenderer.cpp:11`에서 include하나 심볼 참조 없음 |
| — 연결 솔기 파트 | `FindConnectedSeamPart` :31, `FindConnectedSeamPartForMultiSewing` :35, `FindConnectedSeamPartForMeasure` :39 | | UNUSED |
| — 근접 | `FindNearCurvesTo` :42,44, `FindCurve` :54 | | UNUSED |
| — 솔기 길이 | `ztSeamUtils::ComputeSeamPartLength` :113 | | UNUSED |
| **커브 체인 탐색기** | `ztConnectionFinder` :17 — `IsExistConnectedToMe` :20, `FindChain` :21,23, `FindChainList` :24, `SimpleFindChains` :26 | 커브 위상 체인 순회 | UNUSED |
| **서페이스별 체인 탐색기** | `ztCurveChainFinder` :14, `Find` :19 | uuid 식별 인지 체인 그룹화 | UNUSED |
| **편집 시 봉제 유지** | `MaintainSewingProcessor` ztSceneUtility.h:14 — `Divide` :48, `Merge` :51 | 커브 분할/병합 시 솔기 세그먼트 유효성 유지 | UNUSED |
| **씬** | `ztScene` ztScene.h:28 | 씬 루트 | **USED** (19×) Renderer2D.cpp:392-397,1249,1305; Renderer3D.cpp:151 |
| — 쿼리 인터페이스 | `GetQueryInterface` :54 | | **USED** |
| — 선택 관리자 접근 | `GetSelectionManager` :55 | | UNUSED |
| — 로드/저장 | `Load` :72, `Save` :76, `LoadZls` :82, `Append` :86, `LoadZlsForInFile` :84 | | UNUSED (앱은 `ztSceneManager` 경유) |
| — **Rozy I/O** | `SaveRozy` :75, `LoadRozy` :81 | | UNUSED |
| — 서명 확인 | `SignatureInfo` :66 (`Load` 인자) | 라이선스/서명 관리 | UNUSED |
| — 아바타 로드 | `LoadAvatar` :90,91, `ChangeMannequinBody` :92 | | UNUSED |
| — 레이아웃 | `TransformSurfacesToOrigin` :102, `GetAABB` :105 | | UNUSED |
| **씬 쿼리 인터페이스** | `ztSceneQueryInterface` :115 | 씬 데이터 위의 ~330 메서드 CRUD+커맨드 파사드 | **PARTIAL — 앱이 ~330개 중 37개 사용** |

#### `ztSceneQueryInterface` — 앱이 실제 사용하는 37개

`Get<T>` :147 (49×), `GetClothPatterns` :502, `GetAvatars` :505, `GetSurfaces` :500, `GetSeams` :504, `GetStitches` :510, `GetButtons` :506, `GetButtonHoles` :507, `GetZippers` :512, `GetMaterials` :499, `GetLogos` :509, `Synchronize` :554, `SetSyncFlag` :552, `GetSceneData` :130, `GetZipperData` :460, `GetClothPatternBySurface` :355, `GetSurfaceByBezierCurve` :247, `GetSurfaceByVertex` :245, `GetSurfaceByButtonHole` :282, `GetCurvesInSurface` :205, `GetAvatarData` :342, `GetNotchDataByVertex` :488, `GetButtonConnectionsByButton` :399, `GetSeamsInCloth` :548, `GetSeamInfo` :549, `GetAllClothPatternData` :362, `DeleteSeam` :375, `CommandScaleSurface` :250, `GetDrapingItem` :568, `GetAllDrapingItemUuids` :566, `SetActiveDrapingItem` :572, `Update*UuidsInFile` :579,581,582,583, `SaveDefaultColorAssetMap` :645, `GetDefaultColorAssetMap` :646, `ClearDefaultColorAssetMap` :647

#### `ztSceneQueryInterface` — 미사용 ~290개 중 주요 항목

| 분류 | 메서드 |
|---|---|
| **2D 정점 편집** | `AddVertex` :159, `CommandMoveVertices` :170, `CommandVertexSmooth` :161, `CommandVertexSmoothBothSides` :162, `CommandControlVertexSmooth` :160, `MergeVertex` :173, `UpdateVertexWithWorldPosition` :164,165, `DeleteVertex` :166 |
| **커브 편집** | `AddBezierCurve` :184, `DivideCurve` :199,203, `CommandMoveCurve` :198, `CommandFitCurves` :200, `FindCurvesToFit` :201, `ModifyCurveType` :193, `CommandModifyCurveShape` :523, `DeleteCurves` :195 |
| **패턴 변환** | `CommandRotateSurface` :249, `CommandMirrorSurface` :252, `CommandFlipSurface` :253, `CommandDisconnectMirror` :254, `CommandBreakUnfold` :255, `CommandCopySelected` :256, `CommandMoveSelected` :258, `CommandReLocateSurfaceIn3D` :259, `CommandMakeSurfaceFromCurves` :260, `CommandMakeHoleWithSurface` :261, `CommandToggleActivationSurfaces` :262, `CommandAddRectangle` :520 — (`CommandScaleSurface`만 사용됨) |
| **미러 / 언폴드 엔진** | `GetMirrorVertexMapInSurface` :290, `GetMirrorCurveMapInSurface` :292, `GetMirrorBoundaryMapInSurface` :294, `SyncMirroredSurface` :276, `IsMirrorPairInSync` :275, `GetUnfoldVertexMapInSurface` :298, `GetUnfoldCurveMapInSurface` :299, `GetUnfoldMapWithClosestCenter` :301, `ExtendCurveListWithUnfold` :304 |
| **봉제 생성** | `CommandAddSeam` :369, `CommandAddSeamMN` :370, `CommandReverseSeam` :372, `GenerateSeamPartsFrom` :388, `GenerateCurveIntersectInfo` :533, `GenerateSegmentsForSewing` :539, `UpdateSewingInformation` :644, `ClearAllSewingResult` :541, `FindPairMirrorSeam` :377, `TransferToCorrespondMirrorInfo` :378 |
| **그레이딩 (28개)** | `CopyGradePanel` :601, `ApplyGradeChart` :605, `AddGrade` :610, `AddGradePoint` :617,618, `UpdateGradePointOffset` :621, `SetBaseGrade` :607, `GetGrades` :612, `RemoveGrades` :616, `AddUnfoldGradePoint` :629, `AppendSurfaceToGradeChart` :630, `CopyGradePoint` :632, `EraseBrokenMirrorPointsInGradeCharts` :633 … (:601-633) |
| **컬러웨이 (12개)** | `AddColorwayItem` :587, `UpdateColorwayItem` :588, `DeleteColorwayItem` :589, `GetColorwayItem` :590, `GetAllColorwayItems` :591, `ResetColorway` :592, `GetColorwayVisibility` :593, `SetColorwayVisibility` :594, `CanAddObjectToColorwayItem` :595, `MoveColorwayItem` :598 |
| **드레이핑보드 (쓰기)** | `AddDrapingItem` :560, `UpdateDrapingItem` :562, `DeleteDrapingItem` :564 — 앱은 읽기만 |
| 버튼/로고/스티치/지퍼/그룹/가이드라인 CRUD | `AddButton` :392, `SwitchButtonType` :395, `MirrorButtonType` :396, `ReformToButtonHole` :394, `CommandMoveButtons` :401, `CommandMoveLogos` :421, `CommandShareLogoOnSeamline` :424, `AddStitch` :432, `AddZipper` :455, `CommandCreateGroup` :445, `CommandSetDynamicGroup` :448, `CommandOffsetGuideline` :333, `AddTack` :464, `AddPin` :475, `AddNotch` :486 |
| 변경 리스너 | `SetChangeListener` :137, `SetChangeObjectListener` :140, `SetNotifyUICallback` :134 |

### 6.5 design\ — 엔티티 모델 (24 타입)

**[코드 확인]** 엔티티 데이터 struct는 모두 동일 형태(`XData` + `Serialize`/`Deserialize`/`operator==`/`IsDirectlyDependentOn`)와 `ztDesignObjectTemplate<Derived,Data>` (design/ztDesignObjectTemplate.h:9)를 따름.

| 엔티티 | 위치 | 상태 |
|---|---|---|
| `ztDesignVertex` | design/ztDesignVertex.h:50 | **USED** Renderer3D.cpp (`Get<>` 경유) |
| `ztDesignCubicBezierCurve` | :136 | **USED** (26×) Renderer2D.cpp:615, Seam2DRenderer.cpp:117,198,282 |
| `ztDesignBoundaryCurve` | :111 | **USED** (3×) |
| `ztDesignSurface` | :89 | **USED** (42×) |
| `ztDesignMaterial` | :123 | **USED** (14×) |
| `ztDesignClothPattern` | :388 | **USED** (33×) |
| `ztDesignSeam` | :122 | **USED** (20×) Renderer2D.cpp:393-397 |
| `ztDesignButton` | :72 | **USED** (13×) Renderer3D.cpp:1948,2013 |
| `ztDesignButtonHole` | :71 | **USED** (11×) Renderer3D.cpp:781,1817,2078 |
| `ztDesignButtonConnection` | :29 | **USED** (5×) Renderer2D.cpp:303,323,325 |
| `ztDesignLogo` | :48 | **USED** (7×) Renderer3D.cpp:790,1439 |
| `ztDesignStitch` | :47 | **USED** (5×) Renderer3D.cpp:799,1566 |
| `ztDesignZipper` | :52 | **USED** (7×) Renderer3D.cpp:1149,1700,1747 |
| `ztDesignAvatar` (베이스) | :121 | **USED** (4×) Renderer2D.cpp:1305, Renderer3D.cpp:442 |
| `ztDesignMannequin` | :19 | **USED** (10×) Renderer3D.cpp:173,493, exporter:553 |
| `ztDesignZeta` | :17 | **USED** (9×) Renderer3D.cpp:549, ZestManager.cpp:91, exporter:506 |
| `ztDesignGuideline` | :35 | **DATA만** — `ztDesignGuidelineType`/`Data`가 Renderer2D.cpp:56,61,66에서 사용. 클래스는 UNUSED |
| `ztDesignNotch` | :29 | **DATA만** — `ztDesignNotchData` @ Renderer2D.cpp:588. 클래스는 UNUSED |
| `ztDesignTack` | :42 | **DATA만** — `ztDesignTackData` @ Renderer2D.cpp:349,351. 클래스는 UNUSED |
| `ztDesignPin` | :25 | **UNUSED** (0회) |
| `ztDesignGroup` | :25 | **UNUSED** (0회) — 패턴 그룹화 + 시뮬 스테이징 |
| `ztDesignClothMesh` | :90 | **UNUSED** (0회) — 자유메시(비패턴) 클로스 오브젝트. ClothPattern과 완전 병렬 API, `InitCollisionMesh` :108, `GetCollisionMesh` :109, `UpdateMesh` :112 포함 |
| `ztDesignObjectManager` | :37 | UNUSED (QI 내부용) |
| `ztDesignUpdateManager` | :68 | 이름으로는 UNUSED; `ztUpdateFlag` :21 / `ztUpdatePreset` :9는 **USED** (4×/2×) |

#### 엔티티별 미도달 주요 기능

| 기능 | 위치 |
|---|---|
| 패턴 스무딩/세분화 메시 생성 | `ztDesignClothPattern::GenerateSmoothInputMesh` :492, `GetSmoothingInputMesh` :484, `GenerateSmoothingConstraints` :511 |
| 두꺼운(3레이어) 패턴 메시 | `GetThickClothPatternMeshes` :481, `GenerateBordersForDoubleSideMesh` :449 |
| 재테셀레이션 / 리메싱 | `Tessellate` :516, `Tessellate_Triangulate` :518, `Tessellate_Remeshing` :522, `RecomputeTessellation` :434 |
| UV 생성 | `GenerateUVs` :506, `GenerateUVsInUnitSquare` :509, `GenerateZipperUVs` :523, `Tessellate_CalculateUV` :519 |
| **탄성 (스트레치 원단)** | `IsElasticityExist` :413, `ApplyElasticity` :414, `UpdateEdgeAngleElastics` :577 |
| **곡률 변형 / 스컬프트 / 패턴 3D 폴드** | `ExecuteCurvatureDeform` :557, `ExecuteSculpting` :558, `ExecuteFoldIn3D` :559, `ValidateFoldEdges` :560 |
| 자기봉제 정점 맵 | `GenerateSelfSewingVerticesMap` :467, `GetSelfSewingVerticesMap` :466, `GetExtSewingVertices` :463, `GetCornerVertices` :464, `GetFoldingLineVertices` :471 |
| 오버레이 메시 서브메시 | `GetStitchMesh` :453, `GetLogoMesh` :454, `GetButtonHoleMesh` :455 |
| 패턴 면적 | `GetApproximateArea` :489, `CalculateArea` :542 |
| 시뮬 출력 메시 | `GetSimulationOutputMesh` :410 — **USED** Renderer3D.cpp:768 |
| 솔기 재계산/세그먼트 | `ztDesignSeam::RecomputeSegments` :168, `GetSegmentsPair` :163, `ReplaceSegments` :170, `SetSeamVertexIndexOfCurve` :155 |
| 지퍼 모델 로드 | `ztDesignZipper::LoadModel` :65, `GetHandleMesh` :67, `GetStopperMesh` :70 |
| **Zeta 포즈 CRUD** | `ApplyPose` :70, `DeletePose` :71, `DuplicatePose` :72, `SetEndPose` :73, `AddPose` :74, `ExportPose` :78, `ImportPose` :79, `GetCurrentPoseUuid` :68 |
| **Zeta 바디 모핑** | `SetBodyParam` :90, `UpdateBodyParams` :91, `SetJointParam` :92, `IsVaildBodyParam` :86, `GetJointRange` :98 |
| **Zeta 측정 기반 사이징** | `SetMeasurementParam` :93,94, `GetMeasurement` :89, `UpdateMeasurements` :51, `GetInitialMeasure` :99 |
| Zeta 바디 프리셋 | `ApplyBodyPreset` :80, `ReadBodyPresetFile` :59, `ExportBodyPreset` :60 |
| Zeta 신발/액세서리 | `SetShoes` :95, `EnableAccessory` :96, `GetAccessoryFileNames` :88 |
| Zeta 렌더 메시 | `GetRenderAccessoryMeshes` :65, `GetBodySubMeshs` :62 — **USED** Renderer3D.cpp:566,569; exporter:530 |
| 마네킹 동적바디 블렌딩 | `UpdateDynamicBody` :64, `BlendBodyMeshes` :92, `PrepareDynamicBodyMeshes` :90, `GetDynamicBodyParams` :66 |
| 마네킹 측정 커브 | `GetMeasurementCurves` :59, `UpdateMeasurements` :65 |
| 마네킹 애니메이션 | `IsAnimation` :68, `IsAnimationFinished` :69, `GetAnimationTime` :74, `SetCurAnimationTime` :48, `Tick` :46, `GetFrameInfo` :61 |
| 마네킹 베이스 모델 | `GetBaseBodyModel` :77 — **USED** Renderer3D.cpp:496 |
| 머티리얼 커스텀 패브릭 저장 | `ztDesignMaterialData::SaveCustomFabric` :92, `GetPresetEntryName` :93, `GetCustomTextureEntryName` :94, `ConvertToInFilePath` :101, `ReplaceTexturesPath` :116 |
| 지오메트리 헬퍼 라이브러리 | `ztGeomHelper` ztDesignGeomHelper.h:11 — static 20+개 (선 교차, 폴리곤 내부/면적, 방향, 미러, 이산각 스냅) |
| Earcut 삼각분할 | `ztGeomTriangulate::Triangulate` ztDesignGeomTriangulate.h:11 |
| 2D 변환 수학 | `ztDesign2DPoint` ztDesign2DTransform.h:9, `ztDesign2DTransform` :88 — **USED** (137×/20×) |
| Reader/Writer 인터페이스 | `ztDesignReaderInterface.h`, `ztDesignWriterInterface.h` — 이름으로는 UNUSED (JSON 리더/라이터가 구현) |

### 6.6 geometry\ (11 파일)

| 기능 | 클래스 / 위치 | 동작 | 상태 |
|---|---|---|---|
| 3차 베지어 지오메트리 코어 | `ztGeomCubicBezierCurve` geometry/ztGeomCubicBezierCurve.h:25 | 평가/도함수/길이/AABB | **USED** (15×) PaintInterface2D.cpp:311, Renderer2D.cpp:615,993, Renderer3D.cpp:2617, Seam2DRenderer.cpp:98,117,198,282 |
| — 테셀레이션 (5모드) | `Tessellate` :67,68, `TessellateBySegmentCount` :69,70,71, `TessellateByArcDistance` :72,73, `SmartTessellation` :76 | 적응형/평탄도 기반 | UNUSED (앱은 ctor/`GetGeom`/`Evaluate`만 호출) |
| — 분할/절단/연장/병합 | `Split` :78,80, `Cut` :82, `Extend` :81, `Merge` :59 | | UNUSED |
| — **오프셋** | `Offset` :101 | 평행 커브 오프셋 | UNUSED |
| — **교차** | `GetIntersectionPoints` :103,104, `GetIntersection` :107,109, `CollideAABBox` :62 | | UNUSED |
| — 근 찾기 | `FindRootsXAxis` :85, `FindRootsYAxis` :86, `FindInflection` :87, `FindSelfIntersection` :88, `FindRootsAll` :89 | 극값/변곡/자기교차 | UNUSED |
| — **커브 피팅** | `FitCurve` :97 (static), `FitToGeom` :99 (static), `Fit` :95 | 점군 → 베지어 | UNUSED |
| — 최근접점 / t 파라미터 | `FindClosestOn` :133,135, `FindTimeParam` :118,120, `FindTimeParams` :116 | | UNUSED |
| — 호 생성 | `CreateArc` :37 | | UNUSED |
| — 연속성 / 겹침 | `Continuity` :54, `CheckEqualityWith` :138, `CheckOverlapping` :139 | | UNUSED |
| 베지어 프리미티브 라이브러리 | `bezier::` 네임스페이스 ztBezierPrimer.h:16 — `bezier3` :198, `getABC` :209, `cubicFromPoints` :287, `ztBezierPrimer::split` :387, `makeArc` :324, `length` :73 | 헤더 온리 베지어 수학 (Pomax 포팅) | UNUSED |
| **2D 제약 삼각분할기** | `ztMesher2D::Triangulate` ztMesher2D.h:31,36 | 홀 있는 서페이스 → 목표 엣지길이 삼각메시. 입출력 프루닝 | UNUSED |
| **등방 리메셔** | `ztRemesh::DoRemesh` ztRemesh.h:16 | split/collapse/flip/relax로 균일 엣지길이 | UNUSED |
| **오버레이 메시 (데칼 클리핑)** | `ztOverlayMesh` ztOverlayMesh.h:41 — `Generate` :55, `GetPseudoVertices` :56, `GetIndices` :59, `GetUV` :62, `Serialize` :65 / `Deserialize` :66 | 로고/스티치/버튼홀 폴리곤을 의류 메시에 클리핑해 무게중심 서브메시로 | UNUSED |
| **곡률 변형 (3D 모프)** | `ztCurvatureDeform` ztCurvatureDeform.h:10 — `Execute` :16-20, `ComputeTransformByDeform` :21 | 패턴 메시의 토로이달/나선 x+y 곡률 모프 (소매/칼라 셰이핑) | UNUSED |

### 6.7 common\ + misc\

**USED-BY-APP:**
`ztString` (common/ztString.h:22, **374×**), `ztUuid`/`ztUuidSaver` (misc/ztUuid.h:9,55, **247×**), `ztColor` (common/ztColor.h:19, **240×**), `ztDir` (common/ztDir.h:27, 40×), `ztFileSystem` (common/ztFileSystem.h:14, 26×), `ztZipFile` (common/ztZipFile.h:12, 18×), `ztZipHelper` (common/ztZipHelper.h:14), `ztLog`/`ztLoggableClass` (common/ztLog.h:190,167), `ztSimulMesh` (common/ztSimulMesh.h:7 @ Renderer2D.cpp:1307), `ztChangeTracker` (common/ztChangeTracker.h:32 @ Renderer3D.cpp:768), `ztLiveEditType` (common/ztLiveEditUtil.h:8), `ztUpdateLiveEditing` (common/ztUpdateLiveEditing.h:12 @ ZestManager.cpp:64,519), `ztGlobalMutex` (common/ztMutex.h:24 @ Renderer3D.cpp:2801,2820), `ztZAnimationInterface` (common/ztZAnimationInterface.h:22 @ Renderer3D.cpp:496,498), `ZT_ASTM_*` (misc/ztASTM.h:6-30 @ Renderer2D.cpp:629-701)

**사소하다고 판단해 건너뛴 헤더:** common/ztCommon.h, ztNonCopyable.h, ztStringUtil.h, ztDeclareObject.h, ztErrorCode.h, misc/ztDeclareClassId.h

### 6.8 avatar\ (26 파일)

**USED-BY-APP — 단 3개:**
- `ztAccessoryMeshData` avatar/ztAvatarManager.h:15 (+`IsEnableMesh` :20, `type` :25, `name` :26, `simulMeshes` :27, `image` :29, `imageAlpha` :30) — Renderer3D.cpp:566,569,571,580,581; exporter:530,532,535,540,541,544
- `ztAccessoryType` avatar/ztAvatarCommon.h:129 — Renderer3D.cpp:567,576,593; Renderer3D.h:30
- `ztAvatarBuilder::DEFAULT_POSE_NAME` avatar/ztAvatarBuilder.h:315 — MainGUI.cpp:1075

**나머지 `avatar/` 전체가 UNUSED.**

### 6.9 ⚠️ Zest — 앱이 안 쓰는 기능, 중요도 순

#### Tier 1 — 전체 기능군, 앱 도달 0

**1. 패턴 편집 액션 기능군 (12 클래스, 헤더 ~1,000줄)**
`ztScissorAction` :20, `ztMergeAction` :17, `ztSplitCurveAction` :42, `ztCurveOffsetAction` :15, `ztCurveExtendAction` :10, `ztCurveFilterAction` :16, `ztInsertCurveCommand` :16, `ztSewingCommand` :13, `ztFoldIn3D` :14, `ztButtonSnapAction` :11, `ztButtonHoleSnapAction` :8, `ztLogoSnapAction` :9.
**2D CAD 저작 계층 전체** — 절단, 병합, 분할, 오프셋(시접), 연장/트림, 불리언 커브 선택, 봉제 생성, 3D 폴드, 부자재 스냅. **샌드박스에 이 이름들이 0회 등장.** 앱은 뷰어/시뮬레이터이지 에디터가 아님.

**2. 아바타 시스템 (헤더 ~2,900줄, 13 헤더)**
`ztAvatarManager` :73, `ztAvatarBuilder` :176, `ztAvatarShaperEx` ztAvatarShaper.h:159, `ztAvatarMeasurement` :16, `ztAvatarMarker` :11 (~80개 인체계측 랜드마크), `ztSkinnedMesh` :352, `ztAnimationData`/`ztAnimationState` ztSkinnedMesh.h:96,134, `ztMeshSdf` ztMeshTopology.h:470, `ztMeshOctree` :283, `ztEyeRoller` :10, `ztAvatarSimulator` :15, `ztBoneModifier` :5.
바디 모핑(`ztAvatarBodyParam` ztAvatarCommon.h:141), 명명 포즈 CRUD, 측정 8종 + `AccurateMeasure` 역해석, 측정→체형파라미터 솔버, 스켈레탈 스키닝, 시선 애니메이션, SDF 충돌. 원리상 `ztDesignZeta` 경유로 도달 가능하나 앱은 `GetRenderAccessoryMeshes`만 호출.

**3. 그레이딩 / 사이징 엔진 (QI 메서드 ~30 + 저장소 + DXF 규칙)**
`ztSceneQueryInterface.h:601-633`, `ztGradingPanel`/`ztGradeChart`/`ztGradeItem` ztSceneData.h:366,348,340, `ztGradingRule`/`ztGradingTable` ztDxfDataStore.h:167,157, `ztSceneParserV10::ReadGradeChart` :53, `ztSceneWriter::Write(ztGradingPanel)` :125. 미러포인트 처리 + DXF 규칙 임포트 포함 멀티사이즈 패턴 그레이딩. **앱 참조 0.**

**4. Undo/Redo 히스토리**
`ztHistoryManager` :81 + `ztCapturedState` :14 + 아카이브 연산자 22개 :155-194.
앱이 `ztSceneManager`를 `historyManager=nullptr`로 생성(ZestManager.cpp:44 vs 기본값 ztSceneManager.h:26) → **단순 미사용이 아니라 구조적으로 비활성.**

**5. 컬러웨이 시스템**
`ztColorway` :96 (8개 서브struct) + QI 메서드 12개 :587-598 + `ztSceneWriter::AddColorwayToZipFile` :97 + `ztSceneParserV10::ReadColorway` :26. 프리뷰 썸네일과 오브젝트별 가시성을 갖는 명명 소재/색상 변형. 앱 참조 0.

#### Tier 2 — 상당한 규모의 서브시스템

**6. `ztSimulationExecutor`의 라이브 편집 / 증분 재시뮬**
`SetLiveEditType` :56, `AddLiveEditTransform` :57, `AddLiveEditSculpt` :58, `AddScissorClothes` :60, `AddMergeClothes` :62, `AddInitClothMeshes` :64, `AddInitButtons` :65, `AddSimClothMeshes` :61, `AddUpdatedObjects` :63 — 뒷받침: `ztSimulationDataModel::MergeClothes` :50, `UpdateClothMeshTopology` :46, `Sculpt` :48, `CreateCloth` :87, `RemoveCloth` :83.
**시뮬레이션이 도는 중에** 클로스를 절단/병합/스컬프팅 가능. 앱은 메시 품질 변경용 거친 `ztUpdateLiveEditing` RAII만 연결.

**7. 타임라인 / 프레임 캐시 스크러빙**
`ztSimulationManager::StepSync` :73, `ResetSync` :74, `LoadCache` :75, `SaveCache` :76, `ztSimulationExecutor::LoadCache` :71/`SaveCache` :72, `ztTimelineMode` :3, `ztSimulationDataModel::GetTimelineDrapingFrame` :70. 시뮬레이션 랜덤액세스 재생. 앱 참조 0.

**8. 드레이핑 보드 (스냅샷 라이브러리)**
쓰기 측: `AddDrapingItem` :560, `UpdateDrapingItem` :562, `DeleteDrapingItem` :564; `ztSimulationManager::LoadDrapingItem` :68, `SaveSimWorldData` :67; `ztDrapingItem`/`ztDrapingBoard`/`ztDrapingInitState` ztSceneData.h:392,422,379; `ztSceneWriter::AddDrapingBoardToZipFile` :94. 앱은 **읽기만** (`GetDrapingItem`, `SetActiveDrapingItem`).

**9. 씬 파일포맷 다양성**
`ztSceneParserRozy` :5 + `ztSceneWriter::WriteRozy` :72 + `ztScene::SaveRozy` :75/`LoadRozy` :81 (완전한 대체 교환포맷); `ztSceneParserBlank` :5; `ztSceneParserV10.h:57-122`의 레거시 마이그레이터 21종; `ztScene::Append` :86/`ztSceneManager::AppendScene` :37 (다중파일 병합). 전부 도달 불가.

**10. DXF 패턴 교환**
`ztDxfDataStore` :196과 엔티티 struct 9종. **중요 발견: Zest는 DXF 데이터 모델만 제공하고 리더/라이터가 없음.** `ztScene.h:18`이 전방선언하고 저장소 내 다른 어떤 것도 건드리지 않음 → 이 저장소 관점에서는 죽은/스텁 기능 (DXF 코덱은 `Zest/` 외부에 있어야 함).

**11. 패턴 메시 파이프라인 내부**
`ztMesher2D::Triangulate` :31, `ztRemesh::DoRemesh` :16, `ztOverlayMesh::Generate` :55, `ztCurvatureDeform::Execute` :16, `ztLoopSubdivisionEx` common/ztLoopSubdivisionEx.h:15, `ztOpensubdivLoopSubdivision` :13, `ztDoubleSideMeshGenerator` :10, `ztNormalEstimator` :18, `ztUVMaker` :10, `ztTriHalfEdgeEx` :14. 앱은 이미 만들어진 메시만 소비하고 재구축하지 않음.

**12. 3D 에셋 임포트 포맷 8종**
`ztFBXAnimation` common/ztFBXAnimation.h:11, `ztGLTFAnimation` :6, `ztUSDAnimation` :9 (+`CopyUSDToUSDZ`), `ztAlembicAnimation` :5, `ztOBJAnimation` :7, `ztZMesh` :11, `ztObjMesh` :15, `ztZAnimationKeyFrame` :10. 앱은 자체 glTF **익스포터**만 있고 Zest의 임포터를 쓰지 않음.

**13. 선택 관리자**
`ztSelectionManager` :19 — 간접선택 RAII(`ztSelectionIndirect` :98)와 그레이딩 포인트 선택 포함. 앱은 자체 히트테스팅 수행.

#### Tier 3 — 작지만 실재

| # | 기능 | 위치 |
|---|---|---|
| 14 | **씬 검증/복구** | `ztBoundaryConnectivityChecker::Run` :15, `ztDanglingObjectEraser::Execute` :14, `ztSceneManager::DeleteOrphanTacks` :70/`DeleteInvalidPins` :71, `CommandDeleteInnerCurvesOverlapingOuters` :522 |
| 15 | **커브/솔기 위상 탐색기** | `ztSeamConnectivityFinder` :19 (헤더는 Seam2DRenderer.cpp:11에서 include되나 미참조), `ztConnectionFinder` :17, `ztCurveChainFinder` :14, `MaintainSewingProcessor` ztSceneUtility.h:14 |
| 16 | **Alvanon 암호화 아바타 훅** | `ztAlvanonDecryptorInterface` :12 + `SetAlvanonDecryptorInterface` :635 + `ztAssetManager::GetAvatarAssetInfoInFile` :215. 순수 인터페이스, **이 저장소에 구현 없음** |
| 17 | **자유메시 클로스 오브젝트** | `ztDesignClothMesh` design/ztDesignClothMesh.h:90 (`ztDesignClothPattern`과 병렬인 270줄 API, 충돌메시 초기화 포함). 완전 도달불가 |
| 18 | **패턴 그룹화 / 시뮬 스테이징** | `ztDesignGroup` :25 + `CommandCreateGroup` :445, `CommandSetDynamicGroup` :448, `CommandShowHideGroup` :447 |
| 19 | **원단 탄성** | `ztDesignClothPattern::IsElasticityExist` :413, `ApplyElasticity` :414, `UpdateEdgeAngleElastics` :577, `ztDesignBoundaryCurve::GenerateAngleElasticCurvesOffset` :153 |
| 20 | **데이터 의존성 변경 감시자** | `ztDataDependency` :11 / `ztDataMemberDependencyImpl<T>` :28 |
| 21 | **시뮬레이션 에너지 판독** | `ztSimulationManager::SetEnergyCalc` :52, `ztSimulationDataModel::UpdateEnergies` :42, `ztSimulationExecutor::SetUpdateEnergy` :54 |
| 22 | **메시 위 체형 측정** | `ztZMeasurements`/`ztMeasurementCurve` common/ztZMeasurements.h:146,30, `ztAvatarPreprocessor` misc/ztAvatarPreprocessor.h:14, `ztOutlineAction` common/ztOutlineAction.h:29 |
| 23 | **바이너리 직렬화 + 서명/라이선싱** | `ztBinaryReader`/`ztBinaryWriter` misc/ztBinaryReader.h:9/ztBinaryWriter.h:9, `ztArchiveIn`/`Out` common/ztArchive.h:318,235, `ztArchiveHelper` misc/ztArchiveHelper.h:18,62, `ztSignatureUtils` misc/ztSignature.h:14, `ztScene::SignatureInfo` :66 |
| 24 | **베지어 수학 심화** | 오프셋(`Offset` :101), 피팅(`FitCurve` :97), 교차(`GetIntersectionPoints` :103), 근/변곡/자기교차 찾기(:85-89), 테셀레이션 5모드(:67-76) on `ztGeomCubicBezierCurve`; `bezier::` 네임스페이스 전체 |
| 25 | **기타 유틸** | `ztASTM` 레이어 테이블은 사용되나, `ztLengthUnit` misc/ztLengthUnit.h:9, `ztSewingColorTable` :8, `ztCSVParser` common/ztCSVParser.h:54, `ztDateTime` :12, `ztTimer` :5, `ztTimeChecker` :7, `ztSystemInformation` :13, `ztBase64` common/ztUtilBase64.h:5, `ztFlag` :8, `ztErrorTracker` :10은 전부 미사용 |

#### 격차 규모

**[코드 확인]** `ztSceneQueryInterface` 단독으로 공개 메서드 ~330개 중 샌드박스는 **37개** 호출. 액션 기능군, 아바타 시스템, 그레이딩, 컬러웨이, 히스토리, 타임라인을 더하면 샌드박스는 Zest 공개 표면의 **대략 10–15%** 만 사용 — 본질적으로 읽기/렌더/시뮬 경로만이고, 저작·사이징·버저닝·아바타 조형 절반은 손대지 않음.

---

## 7. Zelus 솔버 엔진 인벤토리

**[코드 확인]** 엔진 루트: `Zest/Zelus/` (이하 `<Z>/`)

### 7.1 빌드 게이트 (`<Z>/CMakeLists.txt`)

| CMake 옵션 | 줄 | 컴파일 정의 | 게이팅 대상 |
|---|---|---|---|
| `ZELUS_USE_CUDA` | 15 | `ZS_USE_CUDA` (858) | 모든 `gpu/` 디렉토리, GPU 솔버, GPU 브로드페이즈, `zsNeuralNetworkGPU` |
| `ZELUS_USE_CUBLAS` | 16 | `ZS_USE_CUBLAS` (705) | `zsGEMM` 디바이스 경로 (machinelearning/zsDenseMatrix.cpp:59) |
| `ZELUS_USE_TORCH` | 17 | `ZELUS_USE_TORCH` (828) | `zsFeedForwardModule`, `zsNeuralNetworkTorch`, `zsTrainingDataset`, `zsTorchUtils` — **없으면 신경망 학습 불가** |
| `ZELUS_USE_TBB` | 18 | `ZELUS_THREADING_BACKEND_HAS_TBB` (724) | parallel-for 백엔드 |
| `ZELUS_USE_OPENMP` | 19 | `ZELUS_THREADING_BACKEND_HAS_OPENMP` (749) | 대체 백엔드 |
| `ZELUS_USE_MKL` | 20 | `ZELUS_USE_MKL` (741) | **Pardiso 직접솔버 전용** (solver/zsLinearSolverPardiso.h:8, 없으면 :55에서 `#error`) |
| `ZELUS_USE_OPENBLAS` | 21 | `ZELUS_USE_OPENBLAS` (756) | 호스트 `zsGEMM` |
| `ZELUS_USE_ZLIB` | 22 | `ZELUS_USE_ZLIB` (731) | **압축 .zbin I/O** (serialize/zsDeserializeBinary.cpp:11,50) |
| `ZELUS_USE_LICENSING` | 760 | `ZELUS_USE_LICENSING` (765) | 모든 기능 게이팅 |
| `ZELUS_DOUBLE_PRECISION` | 779 | `ZS_USE_DOUBLE_PRECISION` (791) | `zsReal`=double; **SSE/AVX 비활성화**(780-781) |
| `ZELUS_USE_SIMD_SSE/AVX/NEON` | 780-782 | `ZS_USE_SSE`/`ZS_USE_AVX`/`ZS_USE_NEON` | 벡터 수학 |
| `ZELUS_USE_PROFILER` | 852 | `ZELUS_USE_PROFILER` | utils/zsProfiler.h |
| `ZELUS_USE_MEMORY_TRACKER` | 846 | `ZS_USE_MEMORY_TRACKER` | common/zsMemory.h:26 |

**SDK 경계**: `PUBLIC_HEADERS` (CMakeLists.txt:877-996)는 ~105개 헤더만 배포.
**SDK에서 완전 제외**: `machinelearning/` 전체, 모든 구체 솔버 클래스, 모든 구체 충돌월드/리졸버, `zsISD.h`, `zsLevelSet*.h`, `zsDensityVolume.h`, `zsConvexHull*.h`, `zsMassProperties.h`, `zsQuantizer.h`, `serialize/zsSimWorld*Binary.h` 전부.

### 7.2 튜너블 디스크립터 (완전 목록)

#### `zsSimPhysicsDesc` (`<Z>/zsSimulationDesc.h:20`) — `Update()` 전 언제든 변경 가능

| # | 필드 | 타입 | 기본값 | 의미 |
|---|---|---|---|---|
| 1 | `gravity` :24 | `zsVector3` | `(0,-980,0)` | 중력 방향+크기 (cm/s²) |
| 2 | `wind` :25 | `zsVector3` | `Zero()` | 바람 방향+크기 |
| 3 | `useWind` :26 | `bool` | `false` | 바람 활성화 |
| 4 | `useAirResistance` :27 | `bool` | `false` | 공기저항 활성화 |
| 5 | `timestep` :28 | `zsReal` | `30.` | **Hz** 단위 레이트; dt = 1/timestep |
| 6 | `subSteps` :29 | `zsInt` | `1` | 프레임당 서브스텝 |
| 7 | `adaptiveTimeType` :30 | `zsChar` (`ZS_SOLVER_ADAPTIVE_TIME`) | `SOLVER_ADAPTIVE_NONE` | 적응형 타임스텝 모드 (비트마스크: MAXDISTANCE / COLLISION / STRAIN / ALL) |
| 8 | `adaptiveMaxDistance` :31 | `zsReal` | `0.` | 적응형 스테핑 최대 이동거리 |
| 9 | `adaptiveMinDeltaTime` :32 | `zsReal` | `0.006` | 적응형 dt 하한 |

#### `zsSimWorldDesc` (`:42`) — **`Initialize()` 전에** 설정해야 함

| # | 필드 | 타입 | 기본값 | 의미 |
|---|---|---|---|---|
| 1 | `stretchSpringMethod` :46 | `ZS_SPRING_TYPE` | `LINEAR_STRETCH_SPRING` | 스트레치 모델 |
| 2 | `bendSpringMethod` :47 | `ZS_SPRING_TYPE` | `ANGULAR_BEND_SPRING` | 벤드 모델 |
| 3 | `useGroundPlane` :48 | `bool` | `false` | 지면 충돌 |
| 4 | `staticCouplingMethod` :49 | `ZS_SOLVER_COUPLING_METHOD` | `COUPLING_PROJECTIVE_CONSTRAINTS` | 정적 콜라이더 커플링 |
| 5 | `dynamicCouplingMethod` :50 | `ZS_SOLVER_COUPLING_METHOD` | `COUPLING_PENALTY` | 자기충돌 커플링 |
| 6 | `useParallelCollisionResolver` :51 | `bool` | `false` | **죽은 필드, 문서상 무시하라고 명시** |
| 7 | `useClampDynVertexSpeed` :52 | `bool` | `false` | 동적 정점속도 클램프 (봉제 충격 감쇠) |
| 8 | `deterministic` :53 | `bool` | `true` | 결정성 vs 속도 |
| 9 | `updateColliders` :54 | `bool` | `true` | 매 스텝 BVH 리핏 / 키네매틱 이동 |
| 10 | `useISDPinchCulling` :56 | `bool` | `false` | **실험적**; ISD 핀치 영역 접촉 컬링. 공유정점 아바타 필요 |
| 11 | `pinchStabilizationMethod` :58 | `ZS_PINCHING_STABILIZATION_METHOD` | `NO_PINCH_STABILIZATION` | 핀치 안정화 (`PINCH_STABILIZATION_ISD`) |
| 12 | `broadphaseType` :59 | `ZS_BROADPHASE_TYPE` | `BVH_TREE` | BVH_TREE / SPATIAL_HASHING / LBVH_GPU / SPATIAL_HASHING_GPU / BASIC_SPATIAL_HASHING_GPU |
| 13 | `gpuCollisionResolver` :60 | `bool` | `false` | GPU 접촉 해결 |
| 14 | `solverType` :62 | `ZS_SOLVER_TYPE` | `SOLVER_IMPLICIT_EULER_FIRST_ORDER` | 적분기 |
| 15 | `gpuSolver` :63 | `bool` | `false` | GPU 솔버 변종 |
| 16 | `gpuDevice` :64 | `int` | `0` | CUDA 디바이스 인덱스 |
| 17 | `linearSolverType` :65 | `ZS_LINEAR_SOLVER_TYPE` | `CONJUGATE_GRADIENT` | CG / PARDISO(MKL) / CHOLESKY (문서: "Cholesky 느림, 비권장") |
| 18 | `solverConvergenceType` :67 | `ZS_SOLVER_CONVERGENCE_TOLERANCE_TYPE` | `RELATIVE_TOLERANCE` | RELATIVE / ABSOLUTE / MIXED |
| 19 | `linearSolverPreconditioner` :68 | `ZS_LINEAR_SOLVER_PRECONDITIONER` | `BLOCK_JACOBI` | IDENTITY / JACOBI / BLOCK_JACOBI |
| 20 | `warmStartType` :81 | `ZS_SOLVER_WARM_START_TYPE` | `SOLVER_WARM_START_ZERO` | ZERO / PREVIOUS_RESULT / DAMPING (근거 설명 :70-80) |
| 21 | `warmStartScale` :83 | `zsReal` | `0.0` | 0-1 스케일 또는 감쇠 계수 |
| 22 | `groundPlaneNormal` :85 | `zsVector3` | `UnitY()` | 지면 법선 |
| 23 | `groundPlanePoint` :86 | `zsVector3` | `Zero()` | 지면 원점 |
| 24 | `groundMargin` :87 | `zsReal` | `0.5` | 지면 충돌 마진 |
| 25 | `groundCollisionRelaxation` :88 | `zsReal` | `0.2` | 지면 임펄스 완화 |
| 26 | `groundFriction` :89 | `zsReal` | `0.2` | 지면 마찰계수 |
| 27 | `maxClampDynVertexSpeed` :91 | `zsReal` | `ZS_REAL_MAX` | 속도 상한 (#7 필요) |
| 28 | `fitmapType` :93 | `ZS_FITMAP_TYPE` | `STRETCH_SPRING_TENSION_FITMAP` | 핏맵 에너지 모드 (또는 `PRESSURE_FITMAP`) |
| 29 | `gpuThicknessScale` :95 | `zsReal` | `0.5` | XPBD-GPU: 법선방향 두께 감소 |
| 30 | `gpuParticleRadiusScale` :96 | `zsReal` | `0.55` | XPBD-GPU: 파티클 반경 / 평균 엣지길이 |
| 31 | `gpuMaxAttachments` :97 | `zsInt` | `2` | XPBD-GPU: 아바타 장거리 부착 앵커 최대 수 (0..4) |
| 32 | `gpuEarlyTerminationCheckFreq` :98 | `zsInt` | `20` | XPBD-GPU: 종료체크 간 반복 수 |
| 33 | `gpuEarlyTerminationThreshold` :99 | `zsReal` | `0.03` | XPBD-GPU: 상대변화 종료 임계값 |
| 34 | `gpuPinchHandling` :100 | `bool` | `true` | XPBD-GPU: 아바타 표면 사이에 낀 옷감 안정화 |
| 35 | `reorderingType` :210 | `ZS_SOLVER_REORDERING_METHOD` | `REVERSE_CUTHILL_MCKEE` | 행렬 재정렬 (캐시 지역성 + fill-in) |
| 36 | `solverStopCriterion` :213 (private, 접근자 :105/:113) | `ZS_SOLVER_STOP_CRITERION` | `SOLVER_MAX_TOLERANCE` | NUM_ITERATIONS vs MAX_TOLERANCE |
| 37 | `solverTolerance` :214 (:122/:131) | `zsReal` | `1e-4` | 상대 CG 허용오차 |
| 38 | `absoluteSolverTolerance` :215 (:140/:149) | `zsReal` | `1e-3` | 절대 CG 허용오차 |
| 39 | `solverNumIterations` :216 (:157/:165) | `zsInt` | `600` | 선형솔버 최대 반복 |

파생 조회: `IsGPUIESolver()` :173, `IsGPUCollisionDetection()` :181, `IsGPUCollisionResolver()` :189

#### `zsCollisionSolverDesc` (`:225`)

| # | 필드 | 타입 | 기본값 | 의미 |
|---|---|---|---|---|
| 1 | `collisionMethod` :227 | `zsChar` 마스크 | `DCD\|CCD` | 이산/연속 |
| 2 | `collisionType` :230 | `zsUShort` 마스크 | `VERTEX_VS_TRIANGLE \| EDGE_VS_EDGE \| USE_KINEMATIC_COLLISION_NORMAL \| USE_UNTANGLING_DYNAMIC_TRIANGLE_VS_EDGE \| SEWING_EDGE_COLLISION` | 검출 타입. `USE_UNTANGLING_CLOTH_ISD`(1<<7), `USE_UNTANGLING_AVATAR_ISD`(1<<8)도 존재 |
| 3 | `boundingVolumes` :233 | `zsChar` (`ZS_BOUNDING_VOLUMES`) | `KDOP24` | AABB / KDOP16 / KDOP24 |
| 4 | `pairFlag` :234 | `zsUShort` | `FEATURE_PAIR_FLAG_ALL` (0x7fff) | 14개 개별 피처쌍 플래그 (모든 강체 변종 포함) |
| 5 | `colliderRepresentation` :235 | `zsChar` | `TRIANGLE_MESH` | 또는 `LEVEL_SET` |
| 6 | `solverType` :236 | `zsChar` (`ZS_COLLISION_RESOLVER_TYPE`) | `GAUSS_SEIDEL` | GS / JACOBI / GS_ATOMIC / ICA |
| 7 | `numIterationsFullDCD` :247 | `zsInt` | `1` | 전체 DCD 패스 (BVH 리핏 + 검출 + 해결) |
| 8 | `numIterationsOuterDCD` :248 | `zsInt` | `1` | 외부 DCD 루프 |
| 9 | `numIterationsPartialDCD` :249 | `zsInt` | `7` | 해결 전용 DCD 패스 |
| 10 | `numIterationsPartialDCDRigid` :250 | `zsInt` | `50` | 강체 부분 DCD |
| 11 | `numIterationsFullCCD` :251 | `zsInt` | `1` | 전체 CCD 패스 |
| 12 | `numIterationsOuterCCD` :252 | `zsInt` | `1` | 외부 CCD 루프 |
| 13 | `numIterationsPartialCCD` :253 | `zsInt` | `7` | 해결 전용 CCD 패스 |
| 14 | `numIterationsPartialCCDRigid` :254 | `zsInt` | `1` | 강체 부분 CCD |
| 15 | `convergenceThresholdDCD` :257 | `zsReal` | `0.1` | 조기종료 임펄스 임계값 |
| 16 | `convergenceThresholdDCDRigid` :258 | `zsReal` | `0.01` | 강체 조기종료 임계값 |
| 17 | `thicknessScaling` :260 | `zsReal` | `0.4` | 리졸버 내 두께 스케일 [0..1] (PC/Penalty 커플링은 미스케일 사용) |

#### `zsPolylineDynamicsSolverDesc` (`:269`) — 로드/헤어 시뮬

| # | 필드 | 타입 | 기본값 | 의미 |
|---|---|---|---|---|
| 1 | `stretchStiffness` :271 | `float` | `0.0` | 로드 스트레치 |
| 2 | `bendStiffness` :272 | `float` | `0.0` | 로드 벤드 |
| 3 | `twistStiffness` :273 | `float` | `0.0` | 로드 트위스트 |
| 4 | `maxInternalForce` :274 | `float` | `0.0` | 내력 클램프 |
| 5 | `staticCouplingMethod` :276 | `ZS_SOLVER_COUPLING_METHOD` | `COUPLING_IMPLICIT` | 정적 콜라이더 대응 |
| 6 | `dynamicCouplingMethod` :277 | `ZS_SOLVER_COUPLING_METHOD` | `COUPLING_IMPLICIT` | 자기충돌 |
| 7 | `useWind` :279 | `bool` | `false` | 로드에 바람 |
| 8 | `useAirResistance` :280 | `bool` | `false` | 로드에 공기저항 |
| 9 | `mass` :281 | `zsReal` | `0.005` | 로드 파티클 질량 |

#### `zsPolylineCollisionSolverDesc` (`:290`)

| # | 필드 | 타입 | 기본값 | 의미 |
|---|---|---|---|---|
| 1 | `pairFlag` :292 | `zsChar` | `DYNAMIC_VERTEX_VS_STATIC \| DYNAMIC_EDGE_VS_STATIC` | 쌍 타입 |
| 2 | `collisionType` :295 | `zsUShort` | `VT \| EE \| USE_KINEMATIC_COLLISION_NORMAL` | 검출 타입 |
| 3 | `densityForce` :297 | `bool` | `true` | 밀도장 자기충돌 (Pixar 헤어 기법) |
| 4 | `selfRepulsion` :298 | `zsReal` | `30.0` | 반발 크기 |
| 5 | `selfFriction` :299 | `zsReal` | `0.2` | 마찰 크기 |
| 6 | `numBodyIterations` :301 | `zsInt` | `1` | 바디충돌 반복 |
| 7 | `numSelfIterations` :302 | `zsInt` | `1` | 자기충돌 반복 |

#### 디스크립터 밖 런타임 파라미터

- `zsSimSolverInterface::CouplingParams` `<Z>/solver/zsSolverInterface.h:38-46`: `staticFrictionPenaltyStiffness`=1500, `staticCollisionPenaltyStiffness`=7500, `dynamicCollisionPenaltyStiffness`=7500, `staticCollisionPenaltyDamping`=0.1, `dynamicCollisionPenaltyDamping`=10.0, `shapeMatchingPenaltyStiffness`=1.0
- `UntanglingParams` `:48-54`: `penaltyStiffness`=7500, `penaltyDamping`=100, `penaltyDistanceScale`=2.0, `smoothingFactor`=1.5
- 피처쌍 타입별 충돌 완화 16종 + CCD 허용오차: `collision/zsCollisionResolverInterface.h:68-201, 214-250`
- `zsISD` 파라미터 `collision/zsISD.h:252-254, 354-374`: 핀치컬링 거리, 핀치검출 경로/접촉 거리, 언탱글링 최대보정 0.4, `Configure()` :333

**총 튜너블: 81개** (9 + 39 + 17 + 9 + 7)

### 7.3 솔버

| 기능 | 클래스 @ 위치 | 내용 | CPU/GPU | 게이트 |
|---|---|---|---|---|
| 솔버 베이스 계약 | `zsSimSolverInterface` solver/zsSolverInterface.h:33 | 비선형 루프 + 상태 저장/복원, 준정적, 커플링/언탱글링 파라미터 | 양쪽 | — |
| 암시적 MLCP 드라이버 | `zsSolverImplicitMLCP` :19 | 적분 + 혼합 LCP로 충돌 해결; incidence 구성; GS vs Jacobi 어셈블리(:32) | CPU | — |
| **암시적 오일러 (1차/2차)** | `zsSolverImplicitEulerT<T>` :39 | 희소 암시적 적분기; 스프링+FEM, 웜스타트, 준정적, 행렬 덤프 | CPU | — |
| **암시적 오일러 GPU** | `zsSolverImplicitEulerGPU` solver/gpu/:27 | 디바이스 CRS 어셈블리, transient triplet, 강체/페널티 스프링 스트림 14종(:232-245) | GPU | `ZS_USE_CUDA` |
| **PBD/XPBD (CPU)** | `zsSolverPBD` :18 | XPBD 투영: 스트레치, 봉제 집합, 외부, 선형/각/솔기 벤드, 레벨셋, 커플링, 속도 패스(:43-54) | CPU | — |
| **XPBD GPU** | `zsSolverXPBDGPU` solver/gpu/:24 | 조기종료, 접촉 재사용, 타입별 해결빈도+완화 포함 GPU XPBD | GPU | `ZS_USE_CUDA` |
| **장거리 부착** | `zsLongRangeAttachments` solver/gpu/:21 | 클로스→아바타 택으로부터 측지거리 기반 안티스트레치 제약, 봉제 가로지름; 집합당 앵커 ≤4 (:48) | GPU (XPBD만) | `ZS_USE_CUDA` |
| **프리필터링 (CPU)** | `zsSolverPrefilteringT<T>` :21, 모드 enum :13 (`NONE`/`DIAGONAL_ONLY`/`FULL`) | Baraff-Witkin 제약 필터링 (A, B, Z) | CPU | — |
| **프리필터링 GPU** | `zsSolverPrefilteringGPU` solver/gpu/:17 | 동일 기능 디바이스 버전 | GPU | `ZS_USE_CUDA` |
| 강체 형상매칭 | `zsRigidShapeUtils` :15 (`mUseShapeMatching` zsSolverImplicitEuler.h:99) | 강체 클로스용 형상매칭 페널티 | CPU | — |
| 준정적 모드 | `SetQuasiStatic` zsSolverInterface.h:105 | 관성 제거 | 양쪽 | — |
| 솔버 상태 저장/복원 | `SaveState`/`LoadState` :90-91, `zsSolverCacheImplicitEuler` :25 | 라이브 편집 롤백 | CPU | — |
| 협력적 취소 | `zsStoppable` common/zsStoppable.h:22 | 다른 스레드에서 solve 중단 | 양쪽 | — |

솔버 선택: `<Z>/zsSimulationWorld.cpp:180-215` (GPU 경로는 `#ifdef ZS_USE_CUDA` + 라이선스 체크).
`ZS_SOLVER_TYPE` `<Z>/zsSimulation.h:14-22`에는 `..._FIRST_ORDER_DOUBLE_PRECISION` / `..._SECOND_ORDER_DOUBLE_PRECISION` 혼합정밀 슬롯도 선언됨.

### 7.4 선형 솔버

| 기능 | 클래스 @ 위치 | CPU/GPU | 게이트 |
|---|---|---|---|
| 인터페이스 + 전처리기 enum | `zsLinearSolverInterface` solver/zsLinearSolverInterface.h:39, `LinearSolverPreconditioner` :25, `LinearSolverConvergenceToleranceType` :32 | 양쪽 | — |
| **블록 촐레스키 직접법 (LDLᵀ)** | `zsLinearSolverCholeskyT<T>` :15 | CPU | — |
| **PCG** | `zsLinearSolverPCGT<T>` :16 (커스텀 SpMV 훅 :39) | CPU | — |
| CG 커널 | `zsConjugateGradientT<T>` :18 | CPU | — |
| **Pardiso 직접법** | `zsLinearSolverPardiso` :16; 단계 :30-35 | CPU | **`ZELUS_USE_MKL`** (`#error` :55) |
| **GPU CG + PCG** | `zsLinearSolverGpuCG` solver/gpu/:16 (`Solve` :23, `SolvePCG` :101) | GPU | `ZS_USE_CUDA` |
| **PCG GPU 래퍼** | `zsLinearSolverPCGGPUT<T>` solver/gpu/:17 | GPU | `ZS_USE_CUDA` |
| **삼중대각 직접법** | `zsTridiagonalSolverT<T>` :14 + `zsTridiagonalMatrixT` :21 | CPU | — |
| **거듭제곱법 (최대고유값)** | `zsPowerMethod<T>` :15, `ComputeLargestEigenValue` :39 | CPU (병렬) | — |
| CRS 희소행렬 | `zsCRSSparseMatrixT` :19 | 양쪽 | — |
| Transient 희소행렬 | `zsTransientSparseMatrix` math/ | 양쪽 | — |
| 디바이스 SpMV | solver/gpu/zsSpMVGPU.h | GPU | `ZS_USE_CUDA` |
| RCM 재정렬 | `zsReordering` utils/:17 | CPU | — |

### 7.5 충돌

#### 브로드페이즈 구조

| 기능 | 클래스 @ 위치 | CPU/GPU | 게이트 |
|---|---|---|---|
| 병렬 BVH 트리 | `zsBvhTreeParallel<zsBV>` collision/:20; 마스터 `zsBvhMasterTreeParallel` :13; 노드 `zsBvhNodeParallel.h:12` | CPU | — |
| **BVH 프론트 리스트** (시간적 일관성) | `zsBvhTreeFrontList` :52, `zsFrontNodePair` :14 | CPU | — |
| 공간 해시 | `zsSpatialHash` :52, `zsSpatialHashTable` :127, 키 :33 | CPU | — |
| 파티클 공간해시 | `zsSpatialParticleHash` :69 | CPU | — |
| 균일 그리드 | `zsUniformGrid<Cell>` :15 | 양쪽 | — |
| **LBVH (선형 BVH)** | collision/gpu/zsCollisionLBVH.h:9 (`zsLVBHNode`) | GPU | `ZS_USE_CUDA` |
| 공간해시 GPU | `zsSpatialHashGPU<zsBV>` :27; 커널 gpu/zsCollisionSpatialHashGPU.h | GPU | `ZS_USE_CUDA` |
| 기본 공간해시 GPU | collision/gpu/zsCollisionBasicSpatialHashGPU.h | GPU | `ZS_USE_CUDA` |
| 바운딩 볼륨 | `zsAABBox` :20, `zsAABB2D.h:13`, `zsKDop16.h:15`, `zsKDop24.h:15` | 양쪽 | — |

#### 충돌 월드 (브로드페이즈 드라이버)

`zsCollisionWorldInterface` collision/zsCollisionWorldInterface.h:22 (통합 API; `RefitType` enum :27에 `SWEPT_VOLUME`, `CELL` 포함) → 구현체:
`zsCollisionWorldImpl<zsBV>` :76 → `zsCollisionWorldBVHTree` :20 / `zsCollisionWorldSpatialHash` :20; `zsCollisionWorldImplGPU` :28 → `zsCollisionWorldLBVH` :16 / `zsCollisionWorldSpatialHashGPU` :25; 독립형 `zsCollisionWorldBasicSpatialHashGPU` :32

#### 검출 기능 (전부 `zsCollisionWorldInterface.h`)

`CheckDCD` :46 · `CheckCCD` :47 · `CheckEdgeTriangleIntersect` :48 · **`CheckTriTriIntersect` :63** · **`CheckVertexCellIntersect` :69** ("Dynamic Deformables"의 평면셀 엔벨로프; `SetCellOuterEnvelope`/`SetCellInnerEnvelope` :149-152) · **`RayIntersection` ×2 :77,:79** (삼각형 & 엣지, 허용오차 변종) · `BuildLevelSet` :72 · `SetConvexHullTransform` :74 · **충돌 제외**: `AddNoCollisionTriangle` :83, `AddNoCollisionClothPair(s)` :87-89

내로우페이즈 프리미티브: collision/zsCollisionDetections.h — 점/엣지/엣지-엣지/점-삼각형/선분-삼각형/삼각형-삼각형/레이-삼각형/레이-구/**점-사면체**(:72), 2D 무게중심 좌표(:75-77)
**견고한 위상 엣지-삼각형 교차**: collision/zsRobustTopologyIntersection.h, zsRobustTopologyHostDeviceFunctions.h
**CCD**: `zsContinuousCollisionDetection` :18 — 보수적 전진

#### 콜라이더

CRTP 베이스 `zsCollider<Derived>` collision/zsCollider.h:26 (+`zsColliderDistanceMethod` :12, `GetCenterOfMass` :34, `GetInertiaTensor` :36) →
**`zsSphere`** :14 · **`zsCapsule`** :14 · **`zsPlaneCollider`** :14 · **`zsConvexHull`** :15 (빌더: `zsConvexHullBuilder.h:14`, quickhull) · **`zsMeshCollider<zsBV>`** :20 · **`zsLevelSet`** :20 / **`zsLevelSetGPU`** :22 (베이스 `zsLevelSetBase<Derived>` :20, `Cell` :52)

GJK 서포트: `zsSimplexSolver` :13
집합 씬: `zsCollisionScene<zsBV>` :25 (`AddCollSphere`/`AddCollCapsule`/`AddCollMesh`)
`zsMeshMassProperties` collision/zsMassProperties.h:15 — Mirtich/Tonon 정확 다면체 질량+관성
`zsDensityVolume` :13 — Petrovic 2005 헤어 밀도장, 삼선형 평가
`zsRepTriangles` :17, `zsRTriangle.h:12` — 대표 삼각형 중복제거

#### 충돌 리졸버

| 기능 | 클래스 @ 위치 | CPU/GPU |
|---|---|---|
| 인터페이스 + 통계 | `zsCollisionResolverInterface` :51, `zsCollisionSolverStats` :20 (타입별 DCD/CCD 해결 카운트, 반복 카운트) | 양쪽 |
| 베이스 + 임펄스 수학 | `zsCollisionResolver` :18, 병합질량 수학 :26 | 양쪽 |
| **Gauss-Seidel** | `zsCollisionResolverGaussSeidel` :13 | CPU |
| **Gauss-Seidel Atomic** (병렬 GS) | `zsCollisionResolverGaussSeidelAtomic` :12 | CPU |
| **Jacobi** | `zsCollisionResolverJacobi` :15 | CPU |
| **ICA** (Iterative Constraint Anticipation) | `zsCollisionResolverICA` :14; 역대입 GS/Jacobi :28; `zsSolverImplicitEuler` 필요 | CPU |
| **Gauss-Seidel GPU** | `zsCollisionResolverGaussSeidelGPU` :16 (베이스 zsCollisionResolverGPU.h:18) | GPU / `ZS_USE_CUDA` |

선택: `<Z>/zsSimulationWorld.cpp:310-318`

#### 언탱글링 & 핀치

| 기능 | 위치 | 비고 |
|---|---|---|
| **ISD (Interpenetrating Surface Determination)** — Pixar "Untangling Cloth" | `zsISD` collision/zsISD.h:81 (250줄 설계 주석 :31-79) | 컨투어 추적, 플러드필, 흑/백/적/청 영역 채색, 경계경로 폐합 확장 |
| `FindAllIntersections` | :265 | 컨투어 + 색상 구성 |
| `AddUntanglingContacts` | :304 | 컨투어 따라 언탱글링 접촉 주입 |
| `IsTangledContactDCD/CCD` | :283/:286 | 언탱글링 허용을 위해 접촉 뒤집기/비활성화 |
| **`DetectPinchedVertices`** | :297 | 정점-셀 + ISD 근접 → 핀치 제약 |
| `IsPinchedContactDCD/CCD` | :291/:293 | 핀치 접촉 거부 |
| 핀치 접촉 컬링 모드 | `PinchContactCullingType` :139 (NONE / TRIANGLES / PATHS) | |
| 언탱글링 모드 enum | `ZS_UNTANGLING_MODE` zsSimulation.h:323 — NONE/CLOTH/AVATAR/ALL | 클로스별 `zsSimulationWorld::SetUntangling` :376, 저장 `zsCloth::mUntanglingMode` :285 |
| ICM 방식 언탱글링 (엣지-트라이) | `USE_UNTANGLING_DYNAMIC_TRIANGLE_VS_EDGE` zsSimulation.h:129 | 기본 ON, ISD 보완 |
| 경계 병합 (비공유정점 아바타) | `zsBoundaryMergeInfo` :19 | 매 프레임 근접 일치 정점 접합 |

### 7.6 제약 / 힘 (`<Z>/constraints/`)

베이스: `zsSimSpring<N>` :20 · `zsSimGenericIsotropicSpring<N>` :21 · `zsAngularSpring<N>` :19 · `zsSimConstraint` zsConstraint.h:16
enum `ZS_SPRING_TYPE` zsSimulation.h:243-271 (**25개 항목**). 전부 CPU+GPU (`zsSimStructure`에 디바이스 배열), 별도 표기 없으면 빌드 게이트 없음.

| 분류 | 항목 |
|---|---|
| **스트레치** | `zsSimLinearSpring` :24 · `zsSimNonlinearSpring` :25 (3노드 이방성) · `zsSimDataDrivenSpring` :26 (실측 곡선, "호환성용") |
| **벤드** | `zsSimLinearBendSpring` :23 · `zsAngularBendSpring` :49 · **`zsQuadraticBendSpring`** :26 (Bergou 2차 등거리) · `zsAngularBendSeamSpring` :57 (6노드, 솔기 가로지름) |
| **감쇠** | `zsDampSpring` :23 |
| **봉제** | `zsSimSewingSpring` :18; 매니저 `zsSewing` :31 (엣지쌍, 병합집합, 분리, z-fight 바이어스 오프셋 :158, 버전관리 병합상태) |
| **부착/택** | `zsSimLinearExternalSpring` :23 · `zsSimExternalBarycentricSpring` :25 · `zsSimFixedExternalBarycentricSpring` :18 · `zsSimInternalBarycentricSpring` :24 · **`zsSimLongRangeAttachment`** :25 |
| **접촉/페널티** | `zsSimPenaltySpring<N>` :19 (접촉 + 언탱글링 인스턴스화) · `zsSimContactConstraint` 계열 :18 — Static :65, SelfET :78, SelfVT :86, SelfEE :101, SelfVV :116, RigidRigid :130, RigidVT :148, RigidEE :159, RigidStatic :170, RigidVertex :197, RigidTriangle :208, RigidEdge :219, RigidDynamic :230 |
| **강체 / 조인트** | `zsSimRigidContactSpring` :22 · `zsSimRigidDynamicContactSpring` :22 · `zsSimRigidExternalBarycentricSpring` :22 · `zsSimRigidDynamicExternalBarycentricSpring` :21 · **`zsSimRigidExternalHingeSpring`** :21 · **`zsSimRigidJoint`** :21 · **`zsSimRigidDynamic6DOFSpring`** :27 |
| **볼류메트릭 FEM (소프트바디)** | **`zsSimVolumetricForce`** :23 (사면체) · **`zsSimStableNeoHookeanForce`** :19 · **`zsSimCorotationalForce`** :16 |
| **로드 / 와이어** | **`zsElasticRod`** :28 (동적 크기, 스트레치/벤드/트위스트) · `zsSimWireBendSpring` :16 · **`zsSimWireSpringNetwork`**: `zsSimWireAltitudeBendSpring` :28, `zsSimWireAltitudeVolumeSpring` :187, `zsSimWireStretchSpring` :431, 매니저 `zsWireSprings` :605 |
| **투영 제약** | `zsProjectiveConstraint` :42 → `zsPointConstraint` :74, `zsVelocityConstraint` :91 (핀치), `zsLineConstraint` :109, `zsPlaneConstraint` :126, `zsCollisionConstraint` :146 |
| **기타** | `zsUniSingleDistConstraint` zsConstraint.h:170 (지면/바닥) · `zsSimIntersectionEdgeTriangle` :40 · `zsSimIntersectionVertexCell` :123 · **`zsForceEvaluator`** :103 + `zsLinearDataSource` :13 / `zsInterpolatedDataSource` :30 (실측 응력-변형 곡선) |

레지스트리: `zsSimStructure` components/zsSimStructure.h:67 — 타입별 스프링 배열 25개(:390-581), 그래프 채색 배치(`GenerateBatches` :643), `ModelAll`/`ModelActivesOnly` (:96/:132), Gauss-Seidel 러너 :352

### 7.7 컴포넌트 / 시뮬 가능 엔티티

| 엔티티 | 클래스 @ 위치 | 비고 |
|---|---|---|
| **클로스** (동적/키네매틱/정적/강체) | `zsCloth` components/zsCloth.h:81; `ZS_SIMULATION_OBJECT_TYPE` zsSimulation.h:230 | 클로스별: 활성화, 충돌 on/off, 자기충돌 on/off, **레이어**(:204), **UUID**, **활성화 시각**(:223 — 시점 등장), **밀도**(:238), **볼록껍질 프록시**(:213), **동결**(:198), 언탱글링 모드, 사용자 데이터 |
| **공기역학 속성** | `zsClothProp::zsAeroProp` :26 | 풍압 양력(0.3), 풍압 항력(0.3), **공기압**(0.0 → 팽창체) |
| **강체** | `zsRigidBodies` primitives/zsRigidBodies.h:20 | 완전 6-DOF 상태: 선/각속도 ×3 히스토리, 위치/방향 ×4, 질량, 관성 + 이동 관성, 연결 암 |
| **소프트바디 (사면체)** | `zsClothTetra` :22; `simMesh.tetras` zsSimMesh.h:212, `tetraProps` :224 | 볼류메트릭 FEM 지원 |
| **폴리라인 / 로드** (헤어, 끈) | `zsElasticRod` constraints/:28; `zsPolylineRoot` 전방선언 :20; `UpdatePolylineEndVertexNormals` zsSimMesh.h:65 | |
| **가상 강체 클로스** (관절체 구성요소) | `AddVirtualRigidCloth(uuid)` zsSimulationWorld.h:159 | 문서: "**관절체** 구성에 사용" — 조인트/힌지/6DOF 스프링이 관절화 프리미티브 |
| 정점 버퍼 | `zsClothVertices` primitives/:21 | uv, 속도 히스토리 3개, 위치 4개, 분할 동적/키네매틱 델타속도, **정점별 정지/동적 마찰**, **rigidDamping**, **shapeMatching**, invMass, **filteredInverseMasses**, 에너지, **경계까지 거리**, 두께, **핀치 플래그 + pinchVelocity** |
| 삼각형 / 엣지 | `zsClothTriangle.h`, `zsClothEdge.h` | |
| 집합 시뮬 메시 | `zsSimMesh` components/:43 | 피처별 법선, 엣지 최소면적, **엣지별 평면 법선**, 경계까지 거리, **충돌 필터 목록**(정점/엣지/삼각형별 및 VT/EE 쌍, :122-146), `ClampMaxSpeed` :155 |
| DOF 매핑 | `zsSimMapping` components/ | 전역↔지역; 강체 = 2 DOF 튜플 (6-DOF) |
| 측지 경로 | `zsSimMeshShortestPaths` :15 | 엣지 그래프 최단경로 (장거리 부착, ISD에서 사용) |
| 메시 변환 유틸 | `zsSimMeshTransform` :19 | |
| 클로스별 메시 정보 | `zsSimMeshInfoInCloth` | |

**Zelus에 없는 것**: 버튼, 지퍼, 고수준 관절체 타입 — `components/`, `constraints/`, `primitives/` 어디에도 `utton`/`ipper`/`rticulat` 히트 없음. 버튼/지퍼는 **Zest 레벨의 머티리얼/렌더 개념일 뿐**.

**월드 레벨 연산** (`<Z>/zsSimulationWorld.h`): `AddCloth` :121 · **`AddDeformedCloth`** :135/:150 (UV 변환 경유로 2D 패턴 교체하면서 3D 드레이프 보존) · `ReplaceCloth` :165 · `RemoveCloth` :171-172 · **`StartLiveEditing`/`EndLiveEditing`** :180/:185 · `FreezeCloth` :366 · `ApplyTransform` :371 (봉제 끊음) · **로컬 프레임 시뮬레이션** `Update(localFrame)` :108 · `ClearEnergies`/`UpdateEnergies` :335/:340 · `SetTime` :350

### 7.8 머신러닝 (`<Z>/machinelearning/`)

**목적** (`zsNeuralNetworkInterface.h:19-21`): *"실시간으로 클로스 메시를 추론하는 데 사용되는 신경망"*. 즉 **학습된 드레이프/의류 회귀기 — 물리 솔버 실행의 대체재.**

`zsNeuralNetworkBase.h:29-36` 확인: 입력 = 프레임 *t*의 스켈레톤 조인트, 선택적으로 *t-1*, *t-2*의 압축된 클로스; 출력 = 압축(PCA 기저) 클로스 형상. `zsLinearTransform`이 PCA 압축/복원 (`zsGEMM(mMatrix, input - mMean, …)` :150, 역변환 :160). `inertia` 모드(`CreationOptions::inertia` :62)는 이전 프레임 블렌딩 — 애니메이션용 시간적 평활화.

| 기능 | 클래스 @ 위치 | CPU/GPU | 게이트 |
|---|---|---|---|
| NN 파사드 + 팩토리 | `zsNeuralNetworkInterface` :26; `Backend{Torch,CPU,GPU}` :48; `create` :94, `load(stream)` :99, `load(.znf 파일)` :104 | — | — |
| **CreationOptions** :58 | `factorSizeLayer`=2.5, `nbLayers`=10, `inertia`=false, `activationFunc`="ReLU", `initMethod`="xavier_uniform", `standardize`=false | — | — |
| **TrainingOptions** :71 | `batchSize`=1, `numWorkers`=4, `learningRate`=1e-4, `patience`=50, `learningRateDecayRatio`=1.0, `windowSize`=32, `windowStride`=1, `nbEpochs`=1000, `addNoise`=true, `valdFreq`=100, `trainFreq`=10, `standardize`=true, `trainedNbEpochs`=0, `dirModel`="" | — | — |
| **MLP 가중치 컨테이너** | `zsMultiLayerPerceptronT<Alloc>` :10; `ActivationFunc{ReLU,Sigmoid,Tanh,LeakyReLU}` :13; 호스트+디바이스 별칭 :109-110 | 양쪽 | — |
| 추론 엔진 | `zsNeuralNetworkBase<Alloc>::predictImpl` :37 | 양쪽 | — |
| **CPU 백엔드** | `zsNeuralNetworkCPU` :9 | CPU | — |
| **GPU 백엔드** | `zsNeuralNetworkGPU` :12 | GPU | `ZELUS_USE_CUDA` (CMakeLists:466-470) |
| **Torch 백엔드 (유일하게 학습 가능)** | `zsNeuralNetworkTorch` :10; `train` :118은 *"Torch 백엔드에서만 동작"* 명시 :116 | libtorch 경유 CPU/GPU | **`ZELUS_USE_TORCH`** (CMakeLists:473-483) |
| Torch 모듈 | `zsFeedForwardModuleImpl` :11 (`torch::nn::Sequential`) | — | `ZELUS_USE_TORCH` |
| **학습 데이터셋** | `zsTrainingDataset` :9 — `torch::data::datasets::Dataset`, 슬라이딩 윈도우(`windowSize`/`windowStride`), α/β 관성계수 + 평균/표준편차 계산 | — | `ZELUS_USE_TORCH` |
| 진행 콜백 / 조기중단 | `zsTrainingProgressState` (콜백이 `bool` 반환 → 중단) | — | `ZELUS_USE_TORCH` |
| 조밀행렬 + GEMM | `zsDenseMatrix<T,Alloc>`, `zsGEMM` :225/:228 | 양쪽 | OpenBLAS / cuBLAS 가속 (:22,59) |
| GPU 행렬 커널 | machinelearning/gpu/zsDenseMatrixKernels.h | GPU | `ZS_USE_CUDA` |
| 모델 파일 포맷 | **`.znf`** (:102) | — | — |

### 7.9 직렬화 (`<Z>/serialize/`)

`ZS_SERIALIZE_FORMAT_TYPE` zsSerializeBinary.h:12: **STANDARD_BINARY**, **COMPACT_BINARY**, **COMPACT_PER_FRAME_BINARY**. 매직 시그니처 zsSignatureReaderWriterBinary.h:10-16

| 기능 | 심볼 @ 위치 | 게이트 |
|---|---|---|
| 월드 → 파일/벡터/문자열 저장 | `zsSerializeBinary` :19, `zsSerializeBinaryBuffer` :20, `zsSerializeBinaryString` :21 | — |
| 파일/버퍼/문자열 → 월드 로드 | `zsDeserializeBinary` :12, `…Buffer` :14, `…String` :15 | — |
| **zlib 압축 .zbin 로드** | `zsDeserializeCompressedBinary` :13 | **`ZELUS_USE_ZLIB`** (.cpp:11,50) |
| 전체 라이터 (2752/1656줄) | `zsSimWorldWriterBinary` :11 / `zsSimWorldReaderBinary.h` | — |
| **양자화 압축 라이터** | `zsSimWorldWriterCompactBinary` :12 (`zsQuantizer` + AABB 사용) | — |
| **프레임별 스트리밍 라이터** (애니메이션 캐시) | `zsSimWorldWriterCompactPerFrameBinary` :14 / 리더 zsSimWorldReaderCompactPerFrameBinary.h | — |
| 버전 스탬핑 | zsVersionReaderWriterBinary.h | — |
| 양자화기 | `zsQuantizer` / `zsQuantizer3` utils/zsQuantizer.h:15/:80 | — |

**저장 내용**: `zsSimulationWorld` 그래프 전체 — 모든 클로스 + 메시 + `zsSimStructure` 스프링 배열 + `zsSewing` + `zsSimMapping` + 5개 디스크립터 전부

**라이브 상태 기록기** (`<Z>/utils/`): `zsStateRecordInterface` :14 → `zsStateRecordVTK` :16 (속도, 질량, 두께, 정점타입, 에너지, 다음위치, 임펄스, 법선, uv, 경계거리, 충돌제약, ISD 색상 덤프 — 완전한 디버그 텔레메트리) 및 `zsStateRecordZBIN` :12
**환경변수로 활성화**: `ZELUS_EXPORT_FORMAT` = `"VTK"` | `"ZBIN"` — `<Z>/zsSimulationWorld.cpp:321-329`

### 7.10 라이선싱 (`<Z>/licensing/`)

- `zsLicensing` :15 — 싱글톤; `ValidateLicense(content)` :28, **`Supports(feature)` :30** (문자열→bool 피처맵 :36)
- `zsLicenseManager` :45 — licensepp RSA+AES; 헤더에 **"DO NOT EXPOSE THIS CLASS TO THE CLIENT"** 명시(:4-8), **RSA 개인키 임베드**(:26-41). `PUBLIC_HEADERS`에 없음
- 진입점: `zsSimulationWorld::SetLicenseFilePath` :382, `SetLicenseBase64` :387, 또는 환경변수 **`ZELUS_SDK_LICENSE_FILE`** (:380)
- **게이트되는 피처 문자열 3개** (`<Z>/zsSimulationWorld.cpp`): `"gpu"` :58, `"rigid-body"` :67, `"soft-body"` :76
  - `"gpu"`는 솔버 생성 시 강제 :187, :211 → 오류 `"GPU solvers are not supported"`
  - `"rigid-body"`는 `AddCloth` :908에서 `RIGID` 타입에 강제
  - **`"soft-body"` 게이트(`LicenseSupportsSoftBody()` :73)는 정의만 되고 절대 호출되지 않음** — 모든 `.cpp` grep으로 확인. 볼류메트릭 FEM / 사면체 소프트바디는 실질적으로 게이트 없음
  - 전역 `ValidateLicense()`가 :495에서 `Update()` 차단
- **`ZELUS_USE_LICENSING=OFF`(현재 빌드)에서는 모든 게이트가 무조건 `true` 반환**

### 7.11 GPU 인프라 & 병렬 프리미티브 (전부 `ZS_USE_CUDA`)

`zsGpuManager` gpu/:15 (싱글톤, `ContextStatus{READY, INITIALIZATION_ERROR, INSUFFICIENT_DRIVER, NO_DEVICE}` :26, `GetDeviceCount` :63, `SetActiveDevice` :70) · `zsGpuProperties.h` · `zsGpuMemoryManager.h` · `zsGpuStream.h` · `zsGpuKernel.h` (런치 설정 래퍼) · `zsGpuBlasContext.h` (cuBLAS 핸들, `ZS_USE_CUBLAS`)

디바이스 프리미티브 `<Z>/primitives/gpu/`: **radix sort**, **merge sort**, **segmented sort**, **prefix scan**, **reduce**, **stream compaction** (`zsRadixSortGPU.h`, `zsMergeSortGPU.h`, `zsSegmentedSortGPU.h`, `zsPrefixScanGPU.h`, `zsReduceGPU.h`, `zsCompactArrayGPU.h`)

### 7.12 math / threading / utils / common

**`math/` (26 파일)** — 읽음: `zsReal.h`(정밀도 스위치), `zsVector3.h`, `zsTransientSparseMatrix.h`. **건너뜀(정형적)**: `zsVector2i/3i/4/4i.h`, `zsMatrix33.h`, `zsMatrix33SkewSym.h`, `zsMatrix44.h`, `zsSymMatrix33.h`, `zsUniformMatrix33.h`, `zsQuaternion.h/.inl`, `zsTransform.h`, `zsMathUtil.h`, `cudaMathHelper.h`. 그룹: SIMD 기반 vec/mat/quat/transform, `zsTransform2D`, SoA 친화 `zsUniformMatrix33`, `ZS_INLINE_HOST_DEVICE` 경유 호스트-디바이스 공유 수학

**`threading/` (4 파일)** — `zsThreading.h` 전체 읽음. 컴파일 타임 선택 플러그형 백엔드: **TBB** → **OpenMP** → **Serial** (:21-27). 프리미티브: `zsParallelFor` (:29,:35), `zsRangeParallelFor` :41, `zsStepParallelFor` :47, `zsParallelReduce` :53, `zsGetCurrentThreadId` :59, `zsConcurrentArray` :65, `zsCombinable` :72

**`utils/` (~44 파일)** — 읽음: `zsMeshLoader.h`, `zsQuantizer.h`, `zsProfiler.h`, `zsLogger.h`, `zsUnit.h`, `zsReordering.h`, `zsBase64.h`, `zsMergeSets.h`, `zsStateRecord*.h`. **건너뜀(컨테이너/배관)**: `zsArray/zsBatchArray/zsBatchArrayBuilder/zsFlattenedArray/zsFlattenedMapArray/zsDisjointSetArray(+Builder)/zsHashmap/zsStack/zsUniquePtr/zsSpinLock/zsAtomic*/zsBitCast/zsRadixSort/zsStringTokenizer/zsTransformTrianglesUtil/zsTriHalfEdge/zsTriMesh`. 기능 그룹:
- **OBJ 임포트**: `zsTriMeshLoader::LoadObj` :135, `GenerateEdges` :138, `Verify` :141
- **심각도 + 사용자 콜백 로깅**: `zsLogger` :22, `zsLogInfo/Warn/Err` :73-83
- **계층적 프로파일러**: `zsProfileManager` :217 (`ZELUS_USE_PROFILER`)
- **단위 변환**: `UNIT_LENGTH`/`UNIT_WEIGHT` :13/:19, 변환기 :89-158
- **Base64 + Base64URL**: :14/:126 (라이선스 전송)
- **Union-find 병합집합**: `zsMergeSets` :19 (호스트 + 디바이스)
- **RCM 재정렬**: :17
- 호스트/디바이스 동기 배열: `zsSyncArray`/`zsSyncBatchArray`/`zsSyncDisjointSetArray`

**`common/` (6 파일)** — 전부 읽음. `zsCPUFeatures::CheckMinimalSpec()` :14 (SIMD 능력 체크) · `zsMemoryTracker` zsMemory.h:26 (`ZS_USE_MEMORY_TRACKER`) + 정렬 할당 · `zsStoppable` :22 (전역 취소/중단/대기, `Stop` :27 / `WaitForStop` :59) · `zsObject.h` · `zsMacroFunctions.h` · `zsMemoryAlignment.h` · `zsCommon.cpp:14-33` (`zsGetEnv`)

### 7.13 ⛔ Zelus — 샌드박스가 노출하지 않는 기능, 중요도 순

**방법**: `zelusSandBox/` 트리 전체(22 .cpp, 26 .h, 15 .json) 대소문자 구분/무시 grep. 샌드박스는 원시 Zelus 디스크립터를 전혀 건드리지 않음 — 전부 Zest 레벨 `ztSceneDataSimulationParams`(ZestManager.cpp:141-150) 경유, ImGui 패널 3개에서 편집(MainGUI.cpp `RenderGeneralProperty` :386-439, `RenderSolverProperty` :441-528, `RenderCollisionProperty` :530-742).
앱이 직접 만지는 Zelus API: `GetZelusFullVersionString`, `RayAABBIntersection`, `zsSimExternalBarycentricSpring`(마우스 그랩), `zsSimulationWorld`, `zsSerializeBinary`, `zsGpuManager`, 그리고 소수의 `ZS_*` enum.

#### Tier 1 — 앱에 통째로 안 보이는 서브시스템

| # | 기능 | 내용 |
|---|---|---|
| 1 | **머신러닝 서브시스템 전체** | `NeuralNetwork`, `MultiLayerPerceptron`, `FeedForward`, `TrainingDataset`, `zsDenseMatrix`, `Torch`, `machinelearning` — **히트 0**. PCA 압축 + MLP + 관성 + Torch 학습루프 + `.znf` 모델포맷 + CPU/GPU/Torch 추론백엔드로 이루어진 완전한 learn-to-drape 파이프라인. SDK에도 미포함 |
| 2 | **폴리라인 / 탄성로드 시뮬** (헤어, 끈, 드로스트링) | `GetPolylineDynamicsDescriptor`, `GetPolylineCollisionDescriptor`, `zsElasticRod`, `ELASTIC_ROD`, 모든 `WIRE_*` 스프링 타입, `zsDensityVolume` — **전부 미발견**. 디스크립터 struct 2개(튜너블 16개) + `zsSimWireSpringNetwork`(스프링 3종 + 매니저) + Pixar 밀도장 자기충돌이 전부 어둠. 샌드박스의 `Polyline` 히트는 Lumia 로고/버튼홀 *렌더링*뿐(Renderer3D.cpp:1455-1458) |
| 3 | **강체 & 관절체 시뮬** | `zsRigidBodies`, `zsSimRigidJoint`, `zsSimRigidDynamic6DOF`, `RIGID_JOINT`, `RIGID_CONTACT_SPRING`, `AddVirtualRigidCloth`, `Articulated` — **전부 미발견**. 6-DOF 바디, 힌지, 조인트, 강체 접촉스프링 4종, 강체 피처쌍 플래그 8개, 전용 강체 반복횟수(`numIterationsPartialDCDRigid`=50, `convergenceThresholdDCDRigid`)가 완전히 구현돼 있으나 완전 도달불가 |
| 4 | **볼류메트릭 FEM / 소프트바디** | `VOLUMETRIC_FORCE`, `StableNeoHookean`, `Corotational` — **미발견**. Stable Neo-Hookean과 corotational 힘을 갖춘 사면체 소프트바디 존재. `zsClothTetra`와 `simMesh.tetras`도 살아있음. 라이선스 게이트(`"soft-body"`)도 죽은 코드 |
| 5 | **압축 & 프레임별 직렬화 + 상태기록** | 샌드박스는 **STANDARD_BINARY만** 익스포트(ZestManager.cpp:899-901). `COMPACT_BINARY`, `COMPACT_PER_FRAME_BINARY`(양자화 + 스트리밍 애니메이션 캐시, ~3,400줄), `zsDeserializeCompressedBinary`, `zsStateRecordVTK`, `zsStateRecordZBIN` — 전부 미발견. **임포트 경로 자체가 전무**: `zsDeserializeBinary*`가 절대 호출되지 않음 — 앱은 .zbin을 쓸 수만 있고 읽을 수 없음 |
| 6 | **레벨셋 콜라이더** | `LEVEL_SET`, `zsLevelSet`, `colliderRepresentation` — 미발견. `zsLevelSet`/`zsLevelSetGPU` + `BuildLevelSet()`이 완전히 배선(zsSimulationWorld.cpp:334-337)돼 있으나 앱이 `ZS_COLLIDER_REPRESENTATION::LEVEL_SET`을 선택할 수 없음 |

#### Tier 2 — 주요 개별 기능

| # | 기능 | 내용 |
|---|---|---|
| 7 | **바람 & 공기역학** | `wind`, `useWind`, `useAirResistance` — 미발견(`GLFWwindow` 오탐만). 추가로 `zsClothProp::zsAeroProp`(풍압 양력, 항력, **공기압/팽창체**)가 완전 도달불가 |
| 8 | **적응형 타임스테핑** | `adaptiveTimeType`, `adaptiveMaxDistance`, `adaptiveMinDeltaTime`, `SOLVER_ADAPTIVE_MAXDISTANCE/COLLISION/STRAIN` — 미발견. 독립적 적응 전략 3가지가 어둠 |
| 9 | **선형솔버 선택** | `linearSolverType`, `CONJUGATE_GRADIENT`, `PARDISO`, `CHOLESKY` — 미발견. 항상 CG. Pardiso(MKL 직접법)와 블록 촐레스키 도달불가. MKL도 빌드 OFF |
| 10 | **웜 스타팅** | `warmStartType`, `warmStartScale`, `SOLVER_WARM_START` — 미발견. 문서화된 수렴 트레이드오프를 가진 3모드(ZERO / PREVIOUS_RESULT / DAMPING)를 선택 불가 |
| 11 | **GPU/XPBD 튜닝 노브 6개 전부** | `gpuThicknessScale`, `gpuParticleRadiusScale`, `gpuMaxAttachments`, `gpuEarlyTerminationCheckFreq`, `gpuEarlyTerminationThreshold`, `gpuPinchHandling` — 미발견. XPBD-GPU 경로는 선택 가능하나 **완전히 튜닝 불가**; **장거리 부착**은 앵커 2개로 조용히 고정 |
| 12 | **지면 지오메트리 & 마찰** | `groundPlaneNormal`, `groundPlanePoint`, `groundMargin`, `groundCollisionRelaxation`, `groundFriction` — 미발견. on/off 체크박스만 노출; 평면은 원점 통과 Y-up 고정, 마진/마찰 하드코딩 |
| 13 | **클로스별 언탱글링 제어** | `SetUntangling`, `ZS_UNTANGLING_MODE` — 미발견. 앱에 전역 ISD 클로스/아바타 체크박스는 있으나 의류별 언탱글링 모드 설정 불가 |
| 14 | **피처쌍 필터링** | `pairFlag`, `collisionMethod` — 미발견. 개별 쌍 플래그 14개와 DCD-vs-CCD 선택이 기본값에 하드락 |
| 15 | **행렬 재정렬** | `reorderingType`, `REVERSE_CUTHILL_MCKEE` — 미발견 |
| 16 | **핏맵** | `fitmapType`, `STRETCH_SPRING_TENSION_FITMAP`, `PRESSURE_FITMAP` — 미발견. 의류 착용감 시각화 에너지 모드 도달불가 |
| 17 | **변형 클로스 교체 & 라이브 토폴로지 편집** | `AddDeformedCloth`, `ReplaceCloth`, `FreezeCloth` — 미발견. "2D 패턴 교체하고 3D 드레이프 유지"(zsSimulationWorld.h:126-151)는 간판급 저작 기능인데 UI 없음 |
| 18 | **라이선싱** | `SetLicenseFilePath`, `SetLicenseBase64`, `zsLicenseManager` — 미발견. 앱에 라이선스 경로가 전혀 없음 (`ZELUS_USE_LICENSING=OFF`와 일관) |

#### Tier 3 — 튜닝 / 진단 격차

| # | 기능 |
|---|---|
| 19 | `deterministic`, `updateColliders`, `useClampDynVertexSpeed` + `maxClampDynVertexSpeed`, `useISDPinchCulling` — 미발견 |
| 20 | `solverConvergenceType`(RELATIVE/ABSOLUTE/MIXED), `SetSolverStopCriterion`, `SetAbsoluteSolverTolerance` — 미발견. 상대 허용오차만 편집 가능 |
| 21 | 강체 반복횟수 + 외부 루프: `numIterationsOuterDCD/CCD`, `numIterationsPartialDCDRigid/CCDRigid`, `convergenceThresholdDCD`, `convergenceThresholdDCDRigid` — 미발견 |
| 22 | `GAUSS_SEIDEL_ATOMIC` enum, `ZS_EXECUTION_POLICY`(SERIAL / 채색 병렬 / NAIVE_PARALLEL) — 미발견; 충돌솔버 4종은 원시 int 인덱스로만 선택되고 심볼로는 안 됨 |
| 23 | `zsProfiler`, `zsQuantizer`, `zsConvexHull`, `zsMassProperties`, `zsISD`, `PowerMethod`, `TridiagonalSolver`, `zsSimMeshShortestPaths` — 미발견. 특히 **`zsConvexHull` 프록시 콜라이더**(`zsCloth::UseConvexHull` :213)와 **정확 질량/관성 계산**이 도달불가 |
| 24 | **`BASIC_SPATIAL_HASHING_GPU`가 UI에서 죽어 있음**: `bpMethods[]`(MainGUI.cpp:687)는 레이블 4개인데 switch는 5 케이스 처리(:693-697, :704-727) — 케이스 4 도달불가 |
| 25 | **`ZELUS_EXPORT_FORMAT` 환경변수**(zsSimulationWorld.cpp:323) — VTK/ZBIN 프레임별 텔레메트리 덤프를 켜는 유일한 방법. 앱에서 발견 불가능 |

---

## 8. Lumia 렌더러 인벤토리

**[코드 확인]** 루트: `Lumia/` (이하 경로는 상대)

### 8.1 빌드 옵션 (`Lumia/CMakeLists.txt`)

| 옵션 | 줄 | 현재값 | 게이팅 대상 |
|---|---|---|---|
| `LUMIA_BACKEND_ENABLE_VRAY` | 165 (`cmake_dependent_option`, Win32+x64면 ON) | **OFF** | `v-ray/*` 소스(167-172); `find_package(VRay)` + **PUBLIC** 정의(528-531) |
| `LUMIA_BACKEND_ENABLE_OPTIX` | 174 (`ZELUS_USE_CUDA`에 종속) | **OFF** | `optix/*` + `optix/cuda/*.cu`→`.optixir` 오브젝트 라이브러리(176-229); CUDA 링크 + **PRIVATE** 정의(534-545) |
| `LUMIA_SHARED_BUILD` | 381 | **ON** | SHARED vs STATIC; `LUMIA_API` dllexport 구동(393-396) |
| `LUMIA_STRICT_BUILD` | 549 | OFF | `/WX` / `-Werror` |
| `LUMIA_FREEIMAGE_IS_STATIC` | 511-513 | 자동 | Lumia.cpp:21,28의 `FreeImage_Initialise()` |
| `ZELUS_USE_LICENSING` (Zelus에서) | — | OFF | Lumia.cpp:15,48; core/zs3DOpenGLRenderer.cpp:27,35가 "rendering" 라이선스 없으면 `Render()` 차단 |

**GLSL 소스는 구성 시점에 바이너리에 임베드됨** (CMakeLists 231-308 → 생성된 `zsShaderDatabase.h`). 추가로 바이너리 에셋 5개 임베드(311-336): `precomputed_brdf.dds`, `ltc_amp.dds`, `ltc_mat.dds`, `rgbNoise.png`, `seamNormal.png`

### 8.2 엔트리 포인트

| 기능 | 클래스 : 위치 | 내용 |
|---|---|---|
| 싱글톤 파사드 | `Lumia` : Lumia.h:7, .cpp:33 | 전역 초기화/종료 |
| 앱 통합 (unzip 콜백, 로그 콜백, 바이너리/temp 경로, 라이선스) | Lumia.h:21, .cpp:39 | **`glewInit()`도 여기서 호출 (.cpp:58)** |
| `setupRendering()` | Lumia.h:19, .cpp:66 | util/glutils.h:9 경유 GL 디버그 콜백 |
| `updateBeforeRendering()` | Lumia.h:27, .cpp:71 | `zsTextureRegistry::fetchAsyncResults()` 펌프 |
| `updateLightsAndShadows(scene, aabb)` | Lumia.h:28, .cpp:76 | |
| `shutdownRendering()` | Lumia.h:30, .cpp:82 | 텍스처/셰이더/캐시/전역입력 해제 |
| 심각도 태그 로깅 | `zsRenderingObject` : core/:33-47; enum `zsRenderingMessageSeverity` :22-31 (fatal/assert/error/warn/info/spam) | |
| 리소스 생명주기 베이스 | `zsPreparedObject` : core/:21-73 (use/unuse/release/prepare, RAII 스코프) | |

### 8.3 세 가지 백엔드

추상: `zs3DRenderer` : core/zs3DRenderer.h:26 — `Render()` :34 + `Draw()` 오버로드 4개 :35-38 (environment / zsRenderMesh / zsGeomNode / zsSceneNode)

#### (a) 기본 OpenGL 래스터 — `zs3DOpenGLRenderer` : core/:8 — **항상 빌드됨**

| 기능 | 위치 | 내용 |
|---|---|---|
| `enum AntialiasingType` — `None, FXAA, MSAA2, MSAA4, MSAA8, MSAA16` | .h:14-22 | |
| `Initialize(fboFormat, aaType)` / `UpdateFBOs` | .h:26, :32 | |
| 고정 멀티패스 파이프라인 | .cpp:33-219 | background → transparent-ground → opaque(+SSAO) → 4× depth-peel translucent → widgets → outline → post-process → FXAA |
| 뎁스 필링 4레이어 | .h:67, .cpp:155-171; glsl/depth_peeling.inc, merge_peels.fs | 순서 독립 투명도 |
| `SetEnableDepthPeeling` | .h:44, .cpp:644 | |
| SSAO (커널 반경/바이어스/크기) | .h:48, .cpp:657; glsl/ssao.fs | opaque 패스만 |
| 분리형 가우시안 블러 (SSAO 디노이즈) | .h:49, .cpp:675/680; glsl/gaussianBlur.fs | |
| 보케 DOF, 2패스 양방향 | .h:51, .cpp:668; glsl/bokeh_blur_pass1/2.fs, directional_blur.inc | 배경만 |
| 비네트 | .h:47, .cpp:649 | 강도/크기/오프셋 |
| 아웃라인 (색상 + 은폐색) | .h:42, .cpp:632; glsl/post_process.fs:20-23 | |
| FXAA | .cpp:204-211, :579; glsl/fxaa.fs | MSAA 대안 |
| MSAA 리졸브 | .cpp:399; glsl/resolveMS.fs, ms_utils.inc | |
| 슈퍼샘플링 배율 | .h:43, .cpp:639; `zsRenderTarget::setSupersamplingRate` core/:93 | |
| GPU 프로파일링 / FPS | .h:54-55, .cpp:688/693 (`zsGPUTimerQuery` core/zsTimerQuery.h:13) | |
| `GetMaxSampleCount` | .h:53, .cpp:283 | |
| `GetMainFBO` / `BlitMainFBO` | .h:29-30, .cpp:244/249 | |
| 전역 IBL/LTC/솔기 LUT 업로드 | .cpp:596-630 | BRDF LUT, LTC amp+mat (면광원), 솔기 노멀 |

**렌더 타깃**: `zsRenderTarget` : core/:14 — 어태치먼트 7개(`depth`,`color`,`aux0..aux4`) :34-43; `zsBufferBit` :45-49; `depthBufferMode{none, renderbuffer, renderToTexture}` :55-60; clear 색상/깊이 :65-73; 멀티샘플 :87; 슈퍼샘플 :90-94; 알파블렌딩 src/dst :96-103; blit :114-115

**렌더 패스**: `enum class zsRenderPass` : core/zsRenderPass.h:5-37 — `background` 8, `opaque` 12, `translucent` 15, `widgets` 18, `shadow` 21, `preview_2d` 24, `outline` 27, `postfx` 30, `transparent_ground` 33, `bake_details` 36

**오클루전 컬링**: `zsOcclusionQuery` : core/:8 — `startConditionalRendering` :16, `endConditionalRendering` :17, `queryPassed` :19

#### (b) OptiX GPU 패스트레이서 — `zs3DOptixRenderer` : optix/:5 — **`LUMIA_BACKEND_ENABLE_OPTIX` OFF**

베이스 `zs3DHQRenderer` : core/:55; 팩토리 `CreateRenderer(backend)` .cpp:13 (`#ifdef` 가드, 둘 다 OFF면 `nullptr` 반환); `HQEnabled()` .cpp:47은 이 빌드에서 **false** 반환.
설정 struct `zs3DHQRendererSettings` .h:26-42 (previewMode, qualityLevel, denoiser, envIntensity/rotation/type, threads, epsilon, transparentBackground).
enum: `zs3DHQRendererMode{CPU, Optix, Cuda}` :5-10; `zs3DHQRendererBackend{None, VRay, OptiX}` :12-17; `zs3DHQRendererThreadPriority` :19-24

| 기능 | 위치 |
|---|---|
| 2단계 가속: 메시당 GAS + IAS 인스턴싱 | optix/zsOptixMesh.h:16,24,30-37; zsOptixInstances.h:17,27-31,35,49 |
| **삼각형 메시 전용** (커브/구/커스텀 IS 없음) | optix/zsOptixPrimitive.cpp:85; cuda/geometry_data.h:37-49 |
| SBT 레코드 | optix/zsOptixRecord.h:37,43,50-56 |
| 레이 타입 `TYPE_RAY_RADIANCE`, `TYPE_RAY_SHADOW` | cuda/function_indices.h:34-40 |
| BSDF 로브: `LOBE_DIFFUSE_REFLECTION`, `SPECULAR_TRANSMISSION`, `SPECULAR_REFLECTION`, `METAL_REFLECTION`, `SHEEN_REFLECTION`, `CLEARCOAT_REFLECTION` | cuda/hit.cu:52-62 |
| `BsdfEventType` (13개 값) | cuda/per_ray_data.h:41-60 |
| glTF 확장 플래그: SPECULAR, TRANSMISSION, VOLUME, CLEARCOAT, ANISOTROPY, SHEEN, IRIDESCENCE | cuda/material_data.h:36-42; 파라미터 :70-163 (IOR :108, 감쇠 :124-127, 박막 :155-160, unlit :163) |
| 박막 이리데선스 (16-bin CIE) | cuda/bxdf_common.h:388-487 |
| 이방성 GGX VNDF 샘플/평가 | cuda/bxdf_common.h:180,217 |
| 라이트 타입: `ENV_CONST, ENV_SPHERE, POINT, SPOT, DIRECTIONAL, RECTANGULAR` | cuda/function_indices.h:42-55; struct cuda/light_definition.h:36-79; callable cuda/light_sample.cu:45,65,132,169,210,227. **호스트는 env/directional/rect만 배선** (.cpp:745,799,838) |
| HDRI 2D-CDF 중요도 샘플링 + MIS | optix/zsOptixHDRITexture.h:5,16,18-20; .cpp:110-186; MIS cuda/miss.cu:105,152 |
| 디노이저 (`OPTIX_DENOISER_MODEL_KIND_AOV`, albedo+normal 가이드) | optix/zsOptixDenoiser.h:12,20,22,24; .cpp:8-12,49,71-74 |
| 프로그레시브 누적 / 멀티런치 (MAX 12) | cuda/launch_parameters.h:64; cuda/raygen.cu:256-269; .cpp:41,1016-1044 |
| 경로 깊이 (RR-after-2, 최대 6), 러시안 룰렛 | .cpp:710; cuda/raygen.cu:142,176-186 |
| UDIM 텍스처 (8타일) + KHR_texture_transform | cuda/material_data.h:44,60,63-64; optix/zsOptixTexture.cpp:99 |
| **CUDA↔OpenGL interop** (GL 텍스처 서페이스에 기록) | .h:25, .cpp:963,1049-1069; `SetupInteropTexture` |
| 직접조명 / AO / 강제 unlit 토글 | .h:60-69 |
| 벤치마크 모드 `{OFF, FPS, SAMPLES_PER_SECOND}` | .h:11-16,71-79 |
| **없는 것**: 모션블러, DOF/조리개, 볼류메트릭(죽은 코드), 사용자 AOV | cuda/raygen.cu:157; per_ray_data.h:69-72 |

#### (c) V-Ray 오프라인 — `zs3DVRayRenderer` : v-ray/:6 — **`LUMIA_BACKEND_ENABLE_VRAY` OFF**

실제 구현 존재, 1492줄 / 코드 ~1123줄. `BRDFVRayMtl` + `MtlSingleBRDF` .cpp:677-833; 유리 :834; 피부/SSS :841-882; `GeomStaticMesh` :942; `LightDirect` :1058, `LightRectangle` :1085; 인터랙티브 vs 프로덕션 :228,275; `SettingsRTEngine/ImageSampler/GI` :233-299; `RenderChannelDenoiser` :238; `.vrscene` 익스포트 :1465; **AOV 19종** (diffuse/reflect/refract/specular/GI/lighting/totallight/shadow + raw 변종/normals/bumpnormals/zdepth) :166-209

⚠️ **비트로트됨**: 순수가상 `zs3DHQRenderer::SetupInteropTexture`(core/:67, OptiX용으로 추가됨)를 구현하지 않음 → 플래그를 ON으로 켜면 core/zs3DHQRenderer.cpp:20의 `make_shared<zs3DVRayRenderer>()`가 **컴파일되지 않음**. 추가로 베이스 virtual 10개를 no-op 기본값으로 방치(core/:82-104)

### 8.4 라이트 (`lights/`)

| 기능 | 위치 |
|---|---|
| `zsLight` 베이스; `enum lightType{directional, rectangular}` | zsLight.h:8, :13-17 |
| 색상 / 강도(루멘) / shadowsEnabled | :25-26 / :29-30 / :35-36 |
| `renderShadows()`, `updateBeforeRendering()`, `invalidateShadowSource()` | :40, :38, :33 |
| `zsDirectionalLight` + 직교좌표 & 구면좌표(θ,φ) 방향 | :13; :20-26; struct `zsSphericalCoordinate` :7-11 |
| `zsRectangularLight` (면광원): position, dirX, dirY, width, height | :7; :14-27 |
| 면광원 셰이딩 = **LTC** (linearly transformed cosines) | glsl/rect_lighting.inc:126,175; LUT core/zs3DOpenGLRenderer.cpp:608-619 |
| `zsLightManager` 싱글톤, add/remove/removeAll | :10,17,20-22 |
| 전역 그림자 토글 + 섀도우맵 해상도(기본 512) | :24, 26-27, 34 |
| 상한: 방향광 5 + 면광원 5 = 10 | :6-8; glsl/pbr.inc:7-9 |
| 레이어드 섀도우 아틀라스 `R16F`, 10 레이어, border=1e10, nearest | zsLightManager.cpp:80-81 |
| `zsShadowSource` — **직교 투영, 씬 AABB 맞춤만** | :8,13,16,18,19,21 |
| 그림자 필터링: Poisson 그리드 PCF + **PCSS** (blocker search) | glsl/shadows.inc:107,129,157,162 |
| 그림자 튜너블: 필터 반경, PCSS 배율, 고정/법선/기울기 바이어스 | glsl/shadows.inc:4-9; 이름 shader/zsShaderInputNames.h:98-104 |
| 그림자 패스 셰이더 | `position_only.vs/.fs` (materials/zsPBRMaterial.cpp:662) |

**없는 것**: 점광원, 스폿광, IES, 캐스케이드 섀도우맵, 큐브 섀도우, VSM/ESM

### 8.5 머티리얼 (`materials/`)

`zsMaterialInterface` : :23. `enum class zsMaterialType` :13-21 — `PBR_General` 15, `PBR_Glass` 16, `PBR_Skin` 17, `TransparentGround` 18, `Shader` 19, `PostFX` 20. (Glass/Skin은 **V-Ray만** 소비: v-ray/:986,990.) 패스별 셰이더 디스패치 `getShaderForPass()` :36. **셰이더 퍼뮤테이션 시스템**: `_shaderDefines` 집합 :49 → GLSL `#define` 주입(shader/zsShaderPreprocessor.cpp:81-99). 팩토리 `makePBRMaterial` :31, `makeDielectric` :32, `makeMetallic` :33

`zsPBRMaterial` : :33. 파라미터 세트(세터 줄번호):
basecolor 47-48 · roughness 49 · specular 50 · metallic 51 · **sheen 색상 52-53 / 가중치 54** · normalIntensity 55 · invertNormalMapY 56 · displacementIntensity 57 · **tessellationFactor 58**(1..64 클램프, .cpp:596-606) · occlusionFactor 59 · **anisotropy 값 60 / 각도 61** · alpha 62 · uvScaleX/Y 63-64 · roughnessType 65 · colorProfile 46 (`zsRGBProfile{Linear, SRGB}` core/zsRGB.h:5) · `resetParameters()` 86

`enum class zsComponentType` :12-25 — **텍스처 슬롯 11개**: BaseColor, Roughness, Specular, Normal, Alpha, Displacement, Metallic, Occlusion, Anisotropy, **Subspace**, DetailsNormal. `enum class zsRoughnessType{Perceptual, Linear}` :27-31
**UDIM / 인메모리 / 원시데이터 / 비동기콜백 / flip** 지원 범용 로더 :92. 슬롯별 set/get/clear :98-132. `isTranslucent()` :141 (.cpp:896)이 opaque-vs-peeled 라우팅 구동

**BRDF (GLSL)**: Lambert + Burley 디퓨즈 glsl/direct_lighting.inc:11,15; GGX + **이방성 GGX** :27,34; **Charlie sheen** :44 + Neubelt 가시성 :69, `sheenLobe` :74; 높이상관 Smith :53,61; Schlick 프레넬 :4. IBL: SH irradiance + 프리필터드 스페큘러 + BRDF LUT glsl/indirect_lighting.inc:13,29,34. 머티리얼 struct(슬롯별 `#ifdef` 퍼뮤테이션 + UDIM `sampler2DArray` 변종): glsl/material_struct.inc:1-62

**PBR 파라미터에 없는 것**: emissive, clearcoat, transmission/refraction, IOR, subsurface, 박막, alpha-mode enum / cutoff. (이들은 OptiX 쪽에만 존재)

기타 머티리얼: `zsPostFXMaterial` :5 (단일 셰이더, 임의 패스); `zsShaderMaterial` :9 (패스별 셰이더 맵, 런타임 리바인드 :18)
`zsMaterialDatabase` :7-16 — 빌트인 10개: makeLine 7, makeColoredLine 8, makePreview2D 9, makeNormalDebug 10, makeSkybox 11, **makeWidget 12**, makeBakeDetails 13, makeTransparentGround 14, **makeUnlit 15**, **makeMask 16**

### 8.6 텍스처 (`texture/`)

`zsTexture` : :21
- 타입 `enum textureType` :31-38: buffer, 2D, **2DArray**, **3D**, **cubemap** (+2D/2DArray 멀티샘플 변종, .cpp:1824-1832)
- Min 필터 6종 :41-49; mag 2종 :52-56; wrap 4종(repeat/mirroredRepeat/clamp/borderColor) :59-66 + 축별 U/V/W :122-130; border 색상 :141
- **이방성 필터링** `setMaxAnisotropy` :138 (.cpp:337-341, 2D 비MS만)
- 밉맵: `calculateMipmapCount` :186, `setExplicitMaxLevel` :188, `regenerateMipmapsIfEnabled` :158, 자동생성 .cpp:347-366
- 멀티샘플링 :149-151
- 큐브맵 면 enum :69-77; 저장 포맷 `PNG/JPEG/TARGA` :80-85
- **비동기 로딩**: 텍스처당 `std::async` 스레드 1개(.cpp:1310,1356,1406,1512,1874), 결과 struct :87-96, 로딩 중 16×16 더미 플레이스홀더 :234-235(.cpp:1273-1294), 논블로킹 소비 `prepareIfLoaded` :192(.cpp:417-493 — GL 업로드는 GL 스레드에서), `waitForAsyncResult` :190, 로드별 콜백 :193(`asyncCallback` :98), 디버그 `SIMULATE_SLOW_DISK` 게이트(.cpp:1315 등)
- 팩토리 :161-184: 자동감지, 2D, 메모리(zip)에서 2D, DDS, 메모리에서 DDS, 동기 변종, **UDIM (`<UDIM>` 토큰 → 2D 배열)**, 원시데이터에서
- 경로 + 메모리 캐시 :289,292; `ClearCache` :197, `RemoveFromCache` :198; `estimateVRamUsageBytes` :195
- 저장 :200-201; 스카이박스 로드/저장/썸네일 :203-205; 프리필터드 스페큘러 디스크 캐시 :207-208
- `ConvertDDSToSmallFloatFormat` :168 (RGBA16F→R11G11B10F)

`zsTextureRegistry` : :10 — `registerTexture` :17, `deregisterTexture` :18, `getRegisteredTextureCount` :20, `getPendingAsyncResults` :21, `getEstimatedVRAMUsageBytes` :22, **`fetchAsyncResults()` :24** (프레임별 펌프), `freeAllTextures` :26

`zsTextureFormatDatabase` : :8 — **포맷 28종**: SRGB8 :17, SRGB_ALPHA_8 :18, RGBA8 :13, RGB8 :14, BGRA :15, RG32F :10, RGB32F :11, RGBA32F :12, RGBA16 :20, RGBA16F :21, RGB16 :23, RGB16F :24, RG16F :25, R16F :26, R32F :27, DEPTH_COMPONENT_32F :29, R8 :31, R16 :32, **DXT1/BC1 :35, DXT3/BC2 :43, DXT5/BC3 :39, BC6H_U :46, BC6H_S :47**, R11G11B10F :50, RGB9E5 :51
압축은 **디코드/업로드 전용** (DDS는 external/nv_dds 경유); 런타임 인코더 없음, KTX/ASTC/ETC/BC7 없음. 로더: **FreeImage** (.cpp:1123,988), **stb_image** (:1156,1018)

`zsTextureRamImage` : :12 — CPU 밉×면 저장소 :62, 연산 :38-54
`zsTextureLoader` : :5 + `LoadParam` :8-37 (UDIM/인메모리/원시/노멀/flip/콜백), `Load` :39
`zsBakeTexture` : :6 — `prefilterSpecular(skybox,res,levels)` :12 (IBL 큐브맵, glsl/spec_prefilter.fs), `projectSphere` :15 (glsl/proj_sphere.fs), `bakeDetailsNormal(meshes2D, transform, res)` :18 (glsl/bake_details.*)

### 8.7 렌더러블 (`renderable/`)

| 프리미티브 | 위치 |
|---|---|
| 풀스크린 삼각형 | zsFullscreenTriangle.h:5 |
| 박스: geom / node / scene node | zsRenderBox.h:7,8,9 |
| 구 (UV, 12×12 밴드) | zsRenderSphere.h:9,10,11 |
| 평면: 세분 그리드 + 단일 쿼드 | zsRenderPlane.h:7-8, 9, 10, 11, 12 |
| 두꺼운 선 (리본 압출) | zsRenderLine.h:11,12,13 |
| 범용 팩토리 `CreateObject`, `enum ObjectType{Sphere, Cube, Plane}` | zsRenderObject.h:14, :7-12 |
| **메시** `zsRenderMesh` | zsRenderMesh.h:11 |
| — 전체 동적 갱신 (pos/nrm/tangent/uv/attrib/index, 분할 또는 인덱스) | :18-19 |
| — `allocate` / `unsafeTopoUpdate` / `unsafeUpdate` (고속 시뮬 경로) | :22, :25, :28 |
| — 디버그 정점법선 지오메트리 | :31, .cpp:44-58,344-366 |
| — **레이 피킹** `IsIntersected` + `RayHittingObject` (거리, 점, 삼각형 인덱스, 무게중심, 법선) | :48, :37-46 |
| — 월드 AABB | :50 |
| — 와이어프레임용 무게중심 속성 | .cpp:265,274 |
| **환경** `zs3DBaseEnvironment` | zs3DBaseEnvironment.h:5 |
| — 스카이박스 (카메라 고정 풀스크린 삼각형) | :11,19; .cpp:17,56-67 |
| — UV 반복 있는 지면 | :14; .cpp:69-81 (1500×1500) |
| — **투명 지면 / 그림자 캐처** | :15; .cpp:38-44; glsl/transparent_ground.fs (`vec4(0,0,0,shadow)` 출력) |
| — HDRI/스카이박스 텍스처 get/set | :16-17 |
| 배경 모드 (skybox.fs 안) | glsl/skybox.fs:89 skybox, :95 irradiance, :99 radiance, :103 절차적 하늘, :108 white, :110 black |
| **하늘 지면 투영** (돔 재투영) | glsl/skybox.fs:60-74,83; 입력 shader/zsShaderInputNames.h:108-110 |
| 환경맵 회전 / 스케일 / 강도 | zsShaderInputNames.h:80, 107, 82 |

**`zsRenderMesh`에 없는 것**: 서브메시, LOD, 모프 타깃, 스키닝 API, GPU 인스턴싱, BVH 가속 피킹, 캐시된 AABB

### 8.8 카메라 (`camera/`)

`zsCamera` : :16 — 뷰 행렬 :21, 투영 :22, VP :23, `SetPositionAndRotation` :25, `SetLookAt` ×2 :26-27, `SetViewMatrix` :29, `ComputeDirection` :33, `ComputePosition` :34, `ComputeFOV` :35, `SetNearFar` :37, 뷰포트 :38-40, **`GetPickRay` :43**, `ToWorldSpace`(언프로젝트) :47, `ToScreenSpace` :48, `RatioWorldToScreen` :50 (화면 고정 스케일), **자동 near/far 맞춤 `UpdateClippingRange`** :51-52

모델: `zsPerspectiveCamera` :6 (fov :11, 크기에서 종횡비 :13, 역투영 동작 .cpp:42); `zsOrthographicCamera` :5 (필름 크기 :10, **필름 오프셋 / 축이탈 시프트** :11) — ⚠️ `ComputeInverseProjectionMatrix`가 미구현 assert(.cpp:20-25)라 **직교에서 피킹이 깨짐**; `zsMatrixCamera` :6 (외부 공급 행렬) — 동일하게 역투영 미구현(.cpp:14-19)

**없는 것**: 오빗/팬/달리 헬퍼, 초점거리/센서 API, **TAA 지터**

### 8.9 그래프 (`graph/`)

아키텍처는 리테인드 렌더그래프가 아니라 **콜백 구동 평면 순회**: `using zsSceneDescriptor = std::function<void(zsTraverserData)>` zsTraverserData.h:48. 렌더러가 패스별 `zsTraverserData`와 함께 앱의 디스크립터를 패스당 1회 호출하고, 앱이 오브젝트마다 `renderer->Draw(...)`를 호출.

| 기능 | 위치 |
|---|---|
| `zsTraverserData` 팩토리: `MakeFromCamera(cam,pass)`, `MakePostFX()`, `MakeBakeDetails(mat33)`, `makeTransformedCopy` | :14,15,16,18 |
| 패스별 오버라이드 플래그: disableDepthTest / DepthWrite / Culling / ColorWrite / depthPeelingEnabled | :33-40 |
| `zsNode` — 머티리얼, **패브릭 행렬**, **디테일 행렬**, 렌더 상태, 패스별 가시성 | zsNode.h:9,23-28,30-31,33-34 |
| `enum class RenderFlag{BACKGROUND, OPAQUE_NODE, TRANSLUCENT_NODE, WIDGETS, TRANSPARENT_GROUND, NONE}` | :36-44, 세터 :50 |
| `zsGeomNode` — 다중 geom 컨테이너 (서브메시에 가장 가까운 것) | :9,16-18 |
| `zsGeom` — 정점데이터 래퍼 1개 | :11,19-24 |
| `zsSceneNode` — 실제 씬그래프: 자식, 부모, 월드변환, 가시성 | :16,42-47,48,61-63 |
| — `enum State{Normal, Highlighted}` | :21-25 |
| — `enum TransformConstraint{None, SimulatedVertex}` + `SetTransformConstraint` | :27-31, :52 |
| — `SetupAsLineNode(width, widthHighlighted)` | :55 |
| — **화면공간 고정 스케일** | :60 |
| `zsRenderState` — 노드별 GL 상태 | :23 |
| — `depthComparisonMode` (8개 값) | :30-40 |
| — `cullFaceMode{none, back, front, backAndFront}` | :42-48 |
| — writeColor/writeDepth/depthTest/**wireframe** | :55-65 |
| — `enableTwoSided()` | :84 |
| — 노드별 + **정적 전역** 셰이더 입력 | :77, :80, :82 |
| `zsTransformable` — pos/scale/쿼터니언 회전, 행렬, `setExtraTransform(seq, mat)` | :15,20-44 |

### 8.10 셰이더 + GLSL

`zsShader` : shader/:48 — **6개 스테이지 전부** `enum class shaderType` :61-68 (vertex, fragment, geometry, tesscontrol, tesseval, **compute**); 파일 확장자 9종(.cpp:27-31). define 키 프로그램 캐시 :27-45, :137. **핫 리로드** `reload()` :102. 유니폼 리플렉션 + `.`→`_` struct명 재작성 :117 (.cpp:368-398). 어트리뷰트 바인딩 :116. `loadPostFX` :86, 가변인자 `loadFromMultipleFiles` :90/:93

`zsShaderRegistry` : :15 — `ReloadAll()` :29, `ActiveShaderCount()` :28, `freeAllShaders()` :31
`zsShaderPreprocessor` : :10 — 중복제거 포함 재귀 `#include` :26, `#version` 뒤 `#define` 주입(.cpp:81-99), `#line` 재매핑, GL 오류메시지 재매핑 :20; 소스는 **임베드된** `zsShaderDatabase.h`에서(.cpp:6,37,71)
`zsShaderInput` : :19 — `enum class inputType` :27-62, **25종** (sampler2D/2DArray/2DMS/Cube/3D, `tSSBO` 포함); 대규모 세터 오버로드 :74-118; 샘플러 유닛 할당 + SSBO용 `glBindBufferBase` (.cpp:663-697)
`zsSSBO` : :7 — 셰이더 스토리지 버퍼
`zsShaderInputNames.h` — X-매크로 레지스트리, **유니폼 148개** (:8-157). 그룹: 머티리얼 struct `zs_Material_*` 25개(:130-154), 변환/카메라 11개(:119-129), 전역 `g_*` 44개(:75-118), 포스트FX/AA/SSAO/블러/필/아웃라인/비네트/스키닝 ~48개(:9-74), 기타 3개(:155-156)

**GLSL 파일 (`glsl/` 48개)**:
`main.vs`, `opaque.fs`, `translucent.fs` (코어 PBR 포워드) · `pbr.inc`, `compile_material.inc`, `material_struct.inc`, `pbr_remapping.inc`, `direct_lighting.inc`, `indirect_lighting.inc`, `rect_lighting.inc`(LTC 면광원), `normal_mapping.inc`, `shadows.inc`(PCF+PCSS), `defines.inc`, `utils.inc`, `colorSpaces.inc` · `skybox.fs/.vs` · `transparent_ground.fs`(그림자 캐처) · `depth_peeling.inc`, `merge_peels.fs` · `post_process.fs`, `postfx_standard.vs`, `blit_texture.fs` · `fxaa.fs` · `ssao.fs`, `gaussianBlur.fs` · `bokeh_blur_pass1.fs`, `bokeh_blur_pass2.fs`, `directional_blur.inc` · `resolveMS.fs`, `ms_utils.inc` · **`tonemap.inc`**(오퍼레이터 5종: exponential/filmic-Uncharted2/Hejl/ACES/KHR-Neutral + 채도) · `wireframe.inc`(무게중심 솔리드 와이어프레임) · `position_only.vs/.fs`(그림자+아웃라인) · `line.vs/.fs`, `colored_line.vs/.fs` · `preview_2d.vs/.fs` · `bake_details.vs/.fs` · `spec_prefilter.fs`(IBL) · `proj_sphere.fs` · `normals.vs/.fs` · `unlit.fs` · `mask.fs`(MRT 마스크 4종: face/background/generic/floor-depth) · `gui_widget.vs/.fs` · `zsShaderDatabase.h.in`

특히 `main.vs`는 **GPU 스키닝**(`SkinningEnabled`, `jointMatrices[128]`, `zs_Weights`/`zs_Bones`, :29-30)과 **모프/서브스페이스 블렌딩**(`subspaceTex`, `bases[128]`, `activeBases`, :33-35)을 선언

### 8.11 정점 + 유틸

`zsVertexFormat` : vertex/:53; 고정 슬롯 시맨틱 9종 :11-39 — Position 0, Normal 1, Color 2, Texcoord 3, Attribute 4, Tangent 5, **Weights 6**, **Bones 7 (uint)**, **Barycenter 8**
`zsVertexFormatDatabase` : :232 — 레이아웃 11종: V2N2T2 :55, V3 :71, V3N3 :85, V3T2 :100, V3N3T2 :115, V3N3T2B3 :131, V3N3C4 :148, V3C4 :164, V3N3C4T2 :179, **V3N3T2G4B3A3** :196 (완전 PBR+와이어프레임), **V3N3S4** :215 (스키닝)
`zsVertexData` : :10 — `vertexIndexType{none, ubyte, ushort, uint}` :24-30; `usageHintType`(GL 힌트 9종) :33-46; `primitiveType{triangle, triangleStrip, line, lineStrip, lineLoop, point, **patches**}` :49-58; `convertToTriMesh()` :87. **인스턴싱 전무** (`glVertexAttribDivisor` 없음, `*Instanced` 없음)
`util/zsSphericalHarmonics.h:9` — RAM 이미지 :13 또는 파일 :16에서 L2 SH(3×9 계수), `saveFile` :18
`util/zsTangentSpace.h:10` — MikkTSpace 탄젠트 생성 (external/mikktspace.c)
`util/glutils.h:3,5,7,9` — GL 오류 체크, 벤더, 정보 덤프, 디버그 콜백 설정

### 8.12 ⛔ Lumia — 샌드박스가 안 쓰는 기능

**[코드 확인]** 아래 항목 전부 대소문자 무시 전체단어 grep에서 **히트 0**.

#### Tier 1 — 전체 서브시스템, 중요도 높음

| # | 기능 | 내용 |
|---|---|---|
| 1 | **OptiX GPU 패스트레이싱 백엔드** | optix/ 34파일. `zs3DOptixRenderer` :5 → **0 히트**. `zs3DHQRenderer`(core/:55)도 **0 히트**, `CreateRenderer`/`HQEnabled`도 미호출. 빌드 게이트 OFF라 HQ/오프라인 렌더 기능(프로그레시브 PT, 디노이저, clearcoat/transmission/iridescence 포함 완전 glTF BSDF, HDRI 중요도 샘플링, CUDA-GL interop) 전체가 도달불가 |
| 2 | **V-Ray 백엔드** | v-ray/:6 → **0 히트**. 빌드 OFF + 베이스 클래스에 대해 깨져 있음 |
| 3 | **포스트프로세싱 체인 (SSAO 끄기 빼고 전부)** | 샌드박스는 `Initialize`, `UpdateFBOs`, `SetSSAOShaderInputs(false, …)`, `SetOutlineColor`, `Render`, `BlitMainFBO`만 호출(Renderer3D.cpp:124,125,931,2804,2818). 미호출: `SetVignetteShaderInputs` :47, `SetBokehBlurInputs`(DOF) :51, `SetGaussianBlurRadius` :49, `SetSuperSamplingRate` :43, `SetEnableDepthPeeling` :44, `GetMaxSampleCount` :53, `SetEnableGPUProfiling` :54, `GetGPUFramePerSeconds` :55, `GetMainFBO` :29. **SSAO는 Renderer3D.cpp:119에서 명시적으로 비활성**. AA는 MSAA4 하드코딩(:117,2804) — **FXAA, MSAA2/8/16, None 전부 미선택** |
| 4 | **톤매핑** | glsl/tonemap.inc:6-9의 오퍼레이터 5종 + C++ 입력 4개(zsShaderInputNames.h:111-114: `g_ToneMappingMethod/Enabled/Intensity/Saturation`) → **0 히트**. **Lumia 내부에서도 아무도 설정 안 함** — HDR 그레이딩 단계 전체가 어둠 |
| 5 | **GPU 스키닝 + 모프/서브스페이스 블렌딩** | main.vs:29-35(`SkinningEnabled`, `jointMatrices[128]`, `bases[128]`, `activeBases`), 정점 시맨틱 `zs_Weights`/`zs_Bones`(vertex/:31-35), 포맷 `V3N3S4`(:215), 셰이더 입력(:31-34) → **저장소 전체에서 0 히트**. 샌드박스는 CPU 스키닝 후 베이크된 정점 업로드 |
| 6 | **하늘 지면 투영** | glsl/skybox.fs:60-74, 입력 zsShaderInputNames.h:108-110 → **0 히트** |

#### Tier 2 — 주목할 개별 기능

| # | 기능 | 내용 |
|---|---|---|
| 7 | **면광원 + LTC 셰이딩** | `zsRectangularLight` :7 → **0 히트**. LTC 경로 전체(glsl/rect_lighting.inc, 임베드된 ltc_amp.dds/ltc_mat.dds, 셰이더 유니폼 10개 :87-93)가 **매 프레임 로드되지만 한 번도 사용 안 됨**(core/zs3DOpenGLRenderer.cpp:608-619). 샌드박스는 방향광 2개만(Renderer3D.cpp:2184,2191) |
| 8 | **그림자 튜닝 API** | `g_ShadowFilterRadius`, `g_ShadowPCSSScale`, `g_ShadowFixedBiasOffset`, `g_ShadowNormalBias`, `g_ShadowSlopeBias`(:98-104, glsl/shadows.inc:4-9) → **0 히트**; PCSS 소프트섀도우가 셰이더 기본값으로 동작. 추가 미사용: `zsShadowSource` 직접(:8), `zsLight::invalidateShadowSource`(:33), `zsLightManager::setShadowsEnabled` 전역 토글(:24) |
| 9 | **와이어프레임 렌더링** | `zsRenderState::setRenderModeWireframe`(graph/:61)와 무게중심 솔리드 와이어프레임 셰이더(glsl/wireframe.inc, `g_WireframeColor/Width/Feather` :116-118) → **0 히트**. 샌드박스는 `g_Show3DWireframe`만 설정하고 스타일 입력과 폴리곤 모드 상태는 안 건드림 |
| 10 | **그림자 캐처 / 투명 지면** | `zs3DBaseEnvironment::SetupTransparentFloor`(:15) → **0 히트**. 샌드박스는 `SetupFloor(…, transparentFloor)`(Renderer3D.cpp:142)를 쓰지만 `GetBottomPlane` :12나 `GetSkybox` :11은 안 씀 |
| 11 | **텍스처 스트리밍 제어** | `addCallbackForAsyncLoad`(:193), `waitForAsyncResult` :190, `isWaitingForAsyncResult` :191 → **0 히트**. 샌드박스는 `fetchAsyncResults()`(main.cpp:143)만 호출. 레지스트리 진단 `getRegisteredTextureCount`/`getPendingAsyncResults`/`getEstimatedVRAMUsageBytes`(:20-22) → **0 히트** (VRAM/로딩 HUD 없음) |
| 12 | **UDIM 텍스처** | `createAndLoadUDIMTexture`/`_Memory`(:175-176), `<UDIM>` 토큰 경로, `BASECOLOR_UDIM`/`ROUGHNESS_UDIM`/`NORMAL_UDIM`/`OCCLUSION_UDIM` 셰이더 퍼뮤테이션(glsl/material_struct.inc:20,34,42,50) → **0 히트** |
| 13 | **고급 텍스처 설정** | `setup3DTexture` :102, `setupCubemap` :103, `setup2DTextureArray` :104, `setMaxAnisotropy` :138, `setBorderColor` :141, `setMultisamples` :150, `setExplicitMaxLevel` :188, `estimateVRamUsageBytes` :195, `ClearCache` :197, `RemoveFromCache` :198, `ConvertDDSToSmallFloatFormat` :168, `createAndLoadDDSTextureSync` :173, `SaveMemory` :201, `LoadSkybox`/`SaveSkybox`/`SaveSkyboxThumbnail` :203-205, `LoadPrefilterSpecular`/`SavePrefilterSpecular` :207-208 → 전부 **0 히트**. (샌드박스는 디스크 캐시 대신 런타임에 `prefilterSpecular`를 재베이크, Renderer3D.cpp:2160) |
| 14 | **GPU 압축 포맷** | DXT1/DXT3/DXT5/BC6H_S/BC6H_U(:35,39,43,46,47) → **0 히트**. 샌드박스는 RGBA8/RGB8/R8/RGB32F만 |
| 15 | **셰이더 시스템 API** | `zsShader`(:48), `zsShaderRegistry` :15 (**핫리로드 `ReloadAll()`** :29 포함), `zsShaderPreprocessor` :10, `zsShaderInput` :19, `zsSSBO`(:7) → 전부 **0 히트**. 커스텀/컴퓨트/지오메트리/테셀레이션 셰이더가 앱에서 완전 도달불가; 샌드박스는 Renderer3D.cpp:183의 `zsShaderMaterial`을 통해 간접적으로만 셰이더를 건드림 |
| 16 | **GPU 쿼리** | `zsOcclusionQuery`(core/:8, 조건부 렌더링)와 `zsGPUTimerQuery`(core/zsTimerQuery.h:13) → **0 히트** |
| 17 | **미사용 PBR 머티리얼 기능** | `setRoughnessType`/`zsRoughnessType::Linear`(:65,27-31), `resetParameters` :86, `getTex` :94, `makeMetallic`(:33), `getDefaultBasecolorTexture` :42, 슬롯별 텍스처 세터 **`setRoughnessTex` :99, `setSpecularTex` :100, `setMetallicTex` :101, `setOcclusionTex` :105, `setAnisotropyAngleTex` :106, `setSubspaceTex` :107, `setDisplacementTex` :104** → 전부 **0 히트**. 샌드박스는 basecolor/normal/alpha/detailsNormal만 바인딩; roughness/metallic/specular/AO/anisotropy는 스칼라 전용 |
| 18 | **머티리얼 타입 `PBR_Glass` / `PBR_Skin`** | :16-17 → **0 히트** (어차피 V-Ray만 소비) |
| 19 | **죽은 빌트인 머티리얼** | `zsMaterialDatabase::makeWidget` :12, `makeUnlit` :15, `makeMask` :16 → **저장소 전체(샌드박스+Lumia)에서 호출자 0**. glsl/unlit.fs, mask.fs, gui_widget.vs/.fs가 컴파일되지만 인스턴스화 안 됨. `makeNormalDebug` :10과 정점법선 디버그 지오메트리 전체(`getVertexNormals` :31, `draw(..., drawVertexNormals=true)` :35)도 샌드박스가 트리거 안 함 |
| 20 | **카메라 모델** | `zsMatrixCamera`(:6) → **0 히트**. `zsOrthographicCamera`의 **필름 오프셋**(축이탈/시프트 투영, :11) → 0 히트. `zsCamera::UpdateClippingRange`(자동 near/far, :51-52), `ToScreenSpace` :48, `RatioWorldToScreen` :50 → 0 히트 |
| 21 | **프리미티브** | `zsRenderPlane` 계열(`createPlaneGeom` :7, `createSingleQuadPlaneGeom` :9, `createQuad` :10, `createPlane` :11, `createPlaneNode` :12), `createFullscreenTriangle`(:5), `createBoxGeom`/`createBox`(:7,8), `createSphereGeom`/`createSphere`(:9,10), `CreateObject` + `enum ObjectType`(:14,7-12) → **0 히트**. 샌드박스는 `create*Node` 래퍼 3개(box/sphere/line)만 사용 |
| 22 | **메시 고속 경로** | `zsRenderMesh::allocate` :22, `unsafeTopoUpdate` :25, `unsafeUpdate` :28 → **0 히트**. 샌드박스는 시뮬 출력에도 항상 검증하는 `update()`를 사용. `zsVertexData::convertToTriMesh`(:87)도 미사용 |
| 23 | **씬그래프 기능** | `zsSceneNode::SetTransformConstraint` + `TransformConstraint::SimulatedVertex`(:52,27-31), `SetState`/`State::Highlighted` :49,21-25, `AddChild` :42, `SetParent` :47, `GetChildAt` :56-57, `SetLocalTransform` :61, `GetWorldTransform` :63, `SetupAsLineNode` :55 → **0 히트** |
| 24 | **렌더 상태** | `setDepthComparisonMode` + 8값 `depthComparisonMode` enum(:67,30-40), `setWriteColor` :55, `cullFaceMode::backAndFront` :47 → **0 히트** |
| 25 | **텍스처 베이킹** | `zsBakeTexture::projectSphere`(:15) → **저장소 전체에서 0 히트** (죽음). `bakeDetailsNormal` :18과 `prefilterSpecular` :12는 *사용됨* |
| 26 | **렌더 타깃** | `zsRenderTarget` aux1-aux4 어태치먼트(:39-42), `depthBufferMode::renderbuffer` :57, `setAlphaBlendingSrc/Dst` :99-102, `clearAttachmentColor` :109, `blitToDefaultFrameBuffer` :115 → **0 히트** (샌드박스는 Renderer3D.cpp:2818에서 `zsBufferBit::color`만 사용) |
| 27 | **기타** | `outlineIntensity`(:51)는 Lumia 내부에서 1.0 고정(core/zs3DOpenGLRenderer.cpp:559)이고 오버라이드 안 됨; `zsTextureLoader`(:5) → 0 히트 (샌드박스는 `zsTexture::createAndLoad*` 직접 호출); `zsTextureRamImage`는 `getRamImage()`(Renderer3D.cpp:2148) 경유로만 간접 사용 |

### 8.13 샌드박스의 실제 Lumia 사용 범위 (대조용)

**참조하는 클래스:** `zs3DOpenGLRenderer`, `zs3DBaseEnvironment`, `zsRenderMesh`, `zsSceneNode`, `zsGeomNode`, `zsGeom`, `zsNode`, `zsRenderState`, `zsRenderTarget`, `zsTexture`, `zsTextureRegistry`, `zsTextureFormatDatabase`, `zsBakeTexture`, `zsPBRMaterial`, `zsShaderMaterial`, `zsMaterialDatabase`(10개 팩토리 중 4개), `zsMaterialInterface`, `zsLight`, `zsLightManager`, `zsDirectionalLight`, `zsCamera`, `zsPerspectiveCamera`, `zsOrthographicCamera`, `zsVertexData`, `zsVertexFormatDatabase`, `zsSphericalHarmonics`, `zsTangentSpace`, `zsRGB`, `zsRenderPass`, `zsTraverserData`, `zsSceneDescriptor`, `createBoxNode`/`createSphereNode`/`createLineNode`

**설정하는 셰이더 입력: 148개 중 17개** — `Brightness`, `IsLinear`, `IsOverlayMesh`, `color`, `g_BackgroundType`, `g_EnvmapIntensity`, `g_EnvmapRotation`, `g_EnvmapScale`, `g_EnvmapSpecular`, `g_Show3DWireframe`, `g_ShowAttributes`, `g_Skybox`, `lineColor`, `lineWidth`, `mesh2DColor`, `sphericalHarmonics`, `zs_DetailsMatrix`

**명시적으로 지정하는 패스**(`setVisibleOnPass` 경유): `outline`, `preview_2d`, `shadow`, `translucent` — 10개 패스 전부 실행되지만 `bake_details`, `widgets`, `transparent_ground`는 암시적으로만 구동됨

---

## 9. 발견된 버그

**[코드 확인]** 조사 중 발견. ①은 독립된 두 에이전트가 각각 발견.

| # | 위치 | 내용 | 심각도 |
|---|---|---|---|
| **①** | MainGUI.cpp:471 vs :643 | **"solver type"과 "Collision solver" 콤보가 `simulationParam.solverType` 동일 필드에 씀.** Collision solver를 바꾸면 적분기가 조용히 손상됨. 반대로 실제 충돌솔버 필드는 설정되지 않아 "Collision solver" 선택이 사실상 무동작 | 높음 |
| ② | MainGUI.cpp:687, :693-697, :704-727 | broadphase 레이블 배열은 4개인데 switch는 5케이스 처리. `BASIC_SPATIAL_HASHING_GPU`(인덱스 4)는 콤보에서 도달불가이고, 씬이 그 enum을 담고 있으면 콤보에 범위 밖 인덱스가 유입됨 | 중간 |
| ③ | MainGUI.h:114 | `mShowWireFrame` **초기화 누락**. `Initialize()`가 avatar/pattern/sewing(:107-109)은 seed하는데 wireframe만 빠짐 → 체크박스가 미정의 값으로 시작 | 중간 |
| ④ | MainGUI.cpp:458-459, :636, :651, :685 | 주석은 "Enable the following UI during simulation"인데 가드는 `if (!IsSimulationInitialized())` — 실제로는 시뮬 초기화 시 위젯 4개(#18,#38,#39,#40)가 **비활성이 아니라 사라짐** | 중간 |
| ⑤ | MainGUI.cpp:419 | `stretchMap` 선언 후 인덱싱 없음 — bool `useLinearStretch`로 처리해서 stretch 모델 3종 중 **2종만 도달 가능** | 중간 |
| ⑥ | PaintInterface2D.cpp:73 | `Shutdown()` 미호출 → nanovg GL3 컨텍스트와 모든 이미지 핸들이 종료 시 누수 | 낮음 |
| ⑦ | MainGUI.cpp:953-965 | `OpenDlg`: `SHGetKnownFolderPath(FOLDERID_Desktop, …)` 결과를 가져와서 `lpstrInitialDir`에 대입하지 않고(하드코딩 `L"."` :963) 해제 → 죽은 호출. 또한 `OFN.nMaxFile = 100`(:962)인데 호출자는 `MAX_PATH_SIZE`(2000) 버퍼 전달(:984) → 긴 경로 잘림 | 낮음 |
| ⑧ | main.cpp:206 | `glEnable(GL_DEBUG_OUTPUT)`이 `glfwCreateWindow`(:207)·`glfwMakeContextCurrent`(:214)·`glewInit`(:222)보다 **먼저** 호출됨. current context가 없어 조용히 무시 → 디버그 출력이 켜진 적 없음 | 낮음 |
| ⑨ | PaintInterface2D.cpp:875 | `ClearImages`가 nvg 이미지를 삭제하지만 `mLoadedImageHandles`를 비우지 않음 (`DeleteImage` :871은 `remove` 수행 — 비일관) | 낮음 |
| ⑩ | zwGltfExporterImpl.h:112 | `mUseRootNode`가 :170에서 `true`로 초기화되고 **한 번도 읽히지 않음** | 낮음 |
| ⑪ | zelusSandBox/CMakeLists.txt:142 | `set(CMAKE_CXX_FLAGS_RELWITHDEBINFO "... -Od")` — MSVC에서 `-Od`(최적화 끄기)가 기존 `/O2`와 충돌. 게다가 `add_executable`(:65) **뒤에** 나와서 이 타깃에 적용되는지 불확실. RelWithDebInfo로 물리 성능 측정 시 결과 무의미 | 낮음 |
| ⑫ | MainGUI.cpp:210 / :850 | `RenderOperationProperty`가 `ImGui::Begin`을 호출하지만 그 함수 안에 대응하는 `End`가 없음. 유일한 `ImGui::End()`가 `Render*Property()` 10개 호출 뒤 :850에 위치 — Begin/End 짝이 나머지 9개가 `CollapsingHeader` 전용이라는 데 의존 | 낮음(설계) |
| ⑬ | Zelus zsSimulationWorld.cpp:73 | `LicenseSupportsSoftBody()`가 정의만 되고 **어디서도 호출되지 않음** → 볼류메트릭 FEM / 사면체 소프트바디가 실질적으로 라이선스 게이트 없음 | 낮음(정책) |
| ⑭ | camera/zsOrthographicCamera.cpp:20-25, zsMatrixCamera.cpp:14-19 | `ComputeInverseProjectionMatrix`가 미구현 assert → **직교 카메라에서 피킹 불가** | 낮음 |
| ⑮ | v-ray/zs3DVRayRenderer | 순수가상 `zs3DHQRenderer::SetupInteropTexture`(core/:67) 미구현 → `LUMIA_BACKEND_ENABLE_VRAY=ON`으로 켜면 **컴파일 실패** | 낮음(비활성 코드) |

### 구조적 관찰 (버그는 아니나 설계 제약)

- **`ZestManager`의 콜백 8개가 전부 `static`** (ZestManager.h:93-100). `MainGUI`의 시뮬 상태도 static(`mSimulationCurFrame`, `mSimulationMessage`). → **한 프로세스에 세션 1개**가 구조적으로 강제됨
- **Undo/Redo가 구조적으로 비활성**: 앱이 `ztSceneManager`를 `historyManager=nullptr`로 생성 (ZestManager.cpp:44)
- **`zwViewOptionManager::ReLoad()` 미호출** → `viewOption.txt`를 읽지도 쓰지도 않아 뷰 옵션 ~130개가 컴파일 기본값에 동결
- **테스트 전무**: Zest·Zelus 모두 GTest 기반 유닛테스트 + 기능테스트(zbin 베이스라인 비교) 인프라를 갖췄으나 세 빌드 모두 `ZEST_TESTING=OFF`, `ZELUS_TESTING=OFF`. `zelusSandBox` 앱 자체에는 테스트 타깃이 아예 없음

---

## 10. 웹 서비스화 설계 검토

### 10.1 요구사항

**[사용자 제시]** UI에서 쓰는 기능들을 웹에서 동일하게 사용. 아이디어: 프로젝트를 헤드리스 exe로 만들어 실행하고, Node나 Go로 SDK를 만들어 요청을 보내고 결과를 받아 웹 UI에 표현.

### 10.2 62개 기능의 4분류 — 프로토콜 형태를 결정

**[코드 확인]**

| 종류 | 개수 | 성격 | 프로토콜 함의 |
|---|---|---|---|
| **파라미터 쓰기** | ~40 | 슬라이더/체크박스/콤보 → `ztSceneDataSimulationParams` 필드. 멱등, 즉시 반환 | RPC 40개가 아니라 **`patchParams(부분 객체)` 하나** |
| **명령** | ~10 | Load/Save/Export/Clear/Start/Pause/Reset/Step/Apply | 장시간 소요 → **job ID + 진행률**, 동기 반환 금지 |
| **뷰 상태** | 4 | Show avatar/pattern/sewing/wireframe | **서버에 보낼 필요 없음** — 클라이언트 토글 |
| **연속 인터랙션** | 1 | Ctrl+드래그 그래빙 (레이 60Hz) | 별도 저지연 채널 |

카메라 조작(마우스 5개 중 3개)도 서버 왕복이 불필요.

### 10.3 핵심 결정 — 무엇이 선을 넘어가는가

| | **A. 픽셀 스트리밍** | **B. 지오메트리 스트리밍** |
|---|---|---|
| 서버가 보내는 것 | 렌더된 프레임 (H.264/WebRTC) | 메시 정점 + 재질 참조 |
| 브라우저 | 씬 클라이언트 | three.js/WebGL로 직접 렌더 |
| 카메라 조작 | **매 프레임 왕복** | **로컬 60fps, 서버 부하 0** |
| 화질 일치도 | 데스크톱과 픽셀 단위 동일 | Lumia PBR 재현 필요 (LTC 면광원, SH irradiance, PCSS) |
| 서버 비용 | 세션당 GPU 인코더 | 세션당 CPU만 |
| 2D 패턴 뷰 | 비디오 | **SVG/Canvas가 자연스러움** (원래 nanovg 벡터 드로잉) |
| **GL 컨텍스트 필요** | **필요** | **불필요** (§12 참조) |

#### 권장: B (지오메트리 스트리밍)

1. **카메라가 공짜** — 마우스 인터랙션 5개 중 3개(회전/팬/줌)가 서버를 안 거침
2. **2D 뷰는 원래 벡터** — `Renderer2D`가 nanovg로 커브·노치·시접·그레인라인 드로잉. SVG로 보내면 확대·선택·호버가 로컬에서 처리. (참고: **호버/선택 렌더링은 데스크톱에서 하드코딩으로 꺼져 있음** — 웹에서 오히려 더 잘 만들 여지)
3. **직렬화 경로 존재** — `zwGltfExporter`가 클로스·아바타·버튼·로고·스티치를 전부 glTF로 내보냄
4. **서버에서 OpenGL 불필요** — §12에서 검증됨. Windows 컨테이너/서비스 배포의 최대 난제(데스크톱 세션 필요)가 소멸

**A안이 이기는 조건**: 데스크톱과 화질이 픽셀 단위로 같아야 하는 경우. Lumia의 LTC 면광원·프리필터드 스페큘러·PCSS 그림자를 three.js로 재현하는 것은 별개 프로젝트.

### 10.4 제안 아키텍처 (B안 기준)

```
브라우저                Go 게이트웨이              워커 프로세스 (C++)
────────                ─────────────              ──────────────────
three.js 3D뷰   ◄─────  세션 라우팅          ◄───  zelusSandBoxd.exe
SVG 2D뷰        ◄─────  백프레셔·throttle    ◄───   └ ZestManager 1개
파라미터 패널    ─────►  프로세스 풀 관리      ───►   └ Zest/Zelus (+Lumia 링크)
                        job 큐·진행률
        WebSocket                 제어: JSON lines
        (제어) + 바이너리(메시)     데이터: 공유메모리 링버퍼
```

**원칙 3가지:**

**① 세션 = 프로세스 1개 (강제)**
`ZestManager`의 콜백 8개가 전부 `static`이고 `MainGUI`의 시뮬 상태도 static → 한 프로세스에 두 세션은 구조적으로 불가능. 제약이 아니라 **설계 자산으로** 수용: 크래시 격리, 메모리 격리, 세션 종료 = 프로세스 kill.

**② 제어와 데이터 분리**
파라미터/명령은 JSON으로 충분하나 **정점 버퍼를 JSON에 넣으면 안 됨** (의류 한 벌이 프레임당 수 MB). 제어는 JSON lines, 메시는 공유메모리 링버퍼나 바이너리 프레이밍.

**③ 시뮬 속도와 전송 속도 분리**

### 10.5 Zest의 잠자던 타임라인 기능이 결정적

**[코드 확인]** 데스크톱 앱은 "가능한 한 빨리 시뮬+렌더" 루프. 웹 클라이언트는 초당 60개의 수 MB 메시를 소화 불가. 그런데 Zest에 **이미 프레임 캐시가 있고 앱이 안 씀**:

- `ztSimulationManager::StepSync` / `ResetSync` / `LoadCache` / `SaveCache`
- `ztSimulationExecutor::LoadCache` / `SaveCache`
- `ztTimelineMode`
- `ztSimulationDataModel::GetTimelineDrapingFrame`

**[추론]** 이를 살리면 두 모드를 명확히 분리 가능:

| 모드 | 동작 | 적합 케이스 | 비용 |
|---|---|---|---|
| **인터랙티브** | 라이브 시뮬, 최신 프레임만 전송(latest-wins), 나머지 드롭 | 파라미터 튜닝, 그래빙 | 세션당 코어 점유 |
| **배치** | N프레임 시뮬 → 캐시 → 클라이언트가 스크럽/재생 | 드레이핑 결과 확인, 리뷰 공유 | **끝나면 프로세스 해제** |

웹 서비스에서는 **배치 모드가 압도적으로 경제적**. 사용자 대부분은 "파라미터 바꾸고 → 돌리고 → 결과 본다"인데, 결과 보는 동안 서버를 붙잡을 이유가 없음. 데스크톱 UX를 그대로 옮기면 이 최적화를 놓침.

### 10.6 C++ 쪽 필요 변경

```
zelusSandBoxCore  (신규 static lib)  ← ZestManager, core/, scene/, (Renderer*는 데스크톱만)
├── zelusSandBox.exe   (기존 데스크톱)  ← main.cpp + MainGUI + Renderer*
└── zelusSandBoxd.exe  (신규 헤드리스)  ← 프로토콜 루프
```

`MainGUI`는 **옮기지 말고 버리는 것이 맞음.** 62개 액션의 실제 로직은 전부 `ZestManager`와 `Renderer3D` 세터에 있고 `MainGUI`는 ImGui 배선일 뿐. 헤드리스는 프로토콜 → `ZestManager` 직결이 깨끗함.

### 10.7 Node vs Go

**[추론]** 게이트웨이가 하는 일은 프로세스 수퍼비전 + 바이너리 프레이밍 + 백프레셔 + 세션 풀링 — 정확히 **Go의 강점**이고 단일 바이너리 배포도 유리. 브라우저 클라이언트는 TypeScript로 하되, **스키마 하나에서 Go 서버 코드와 TS 클라이언트를 같이 생성**하는 것이 좋음 (파라미터 40개가 한 곳에서 관리돼야 드리프트 방지).
팀이 Node에 익숙하면 Node도 무방 — **어려운 부분은 게이트웨이가 아니라 C++ 경계와 프로토콜 설계**.

### 10.8 리스크

| 리스크 | 내용 |
|---|---|
| **라이선스** | 서버에서 시뮬(`Play`)을 돌리려면 라이선스 필요. 현재 미확보이고, **동시 인스턴스 N개**에 대한 라이선스 조건 확인 필요 — 세션당 프로세스 모델이라 인스턴스 수 = 동접 |
| **GPU 솔버** | `gpuSolver` 노출 시 세션당 GPU 필요 → 비용 급증. 그리고 **CUDA 빌드가 현재 컴파일 안 됨** — v1은 CPU 솔버만 노출이 현실적 |
| **메모리** | 세션당 씬 전체 + 시뮬 월드 상주. 동접 산정 전 실측 필요 |
| **의존성** | Qt5(Core/Xml), USD DLL 20개가 헤드리스 서버에도 동반 → 컨테이너 이미지 비대 |
| **그래빙 지연** | Ctrl+드래그는 왕복 지연을 체감. 소프트바디라 어느 정도 관대하나 **v1에서 제외도 합리적** |

*(참고: Zelus를 WASM으로 컴파일해 브라우저에서 직접 실행하는 안도 있으나 CUDA/TBB/AVX/USD/Qt 의존성 때문에 현실성 낮음. 프리뷰 품질의 축소판이라면 불가능하진 않음.)*

---

## 11. Linux 이식성

### 11.1 exe는 Linux에서 실행되지 않음

**[사실]** PE 바이너리라 네이티브 실행 불가. Wine으로 억지 실행은 가능하나 GL/CUDA/서비스화가 얽혀 프로덕션 부적합.

### 11.2 계층별 Linux 빌드 가능성

**[코드 확인]**

| 계층 | 상태 | 근거 |
|---|---|---|
| **Zelus** | ✅ **이미 크로스플랫폼** | `ZS_OS_LINUX` 정의 (CMakeLists.txt:1065), GCC 분기 + `-ffast-math` + `stdc++fs` 링크(:1044-1050), Apple/ARM NEON 경로(:780-782, :1032). `zsCPUFeatures.cpp`는 `#if _MSC_VER`로 가드 |
| **Lumia** | 🟡 **거의 됨** | `if(UNIX AND LUMIA_SHARED_BUILD)` :389, APPLE 분기 :524,:575. Win32 헤더는 `glutils.cpp` 하나뿐이고 `#ifdef WIN32` 가드. V-Ray만 Win32 전용인데 어차피 OFF |
| **Zest** | 🔴 **작업 대상** | Win32 헤더 7개 파일 중 **5개가 가드 없이 무조건 include** |
| **zelusSandBox** | ✅ **해당 없음** | Win32 의존이 `MainGUI.cpp`(`shlobj_core.h`) + `MainGUI.h`(`tchar.h`) **2개뿐** — 헤드리스에서 버릴 층 |

### 11.3 Zest의 실제 걸림돌

| 파일 | 문제 |
|---|---|
| `common/ztDir.cpp` | `Windows.h` + `ShlObj.h`, **플랫폼 가드 0개** |
| `common/ztLog.cpp` | `Windows.h`, **가드 0개** |
| `common/ztString.cpp` | `tchar.h`, **가드 0개** |
| `common/ztSystemInformation.cpp` | `Windows.h` |
| `design/ztDesignObjectManager.cpp` | `Windows.h` |
| `common/ztFileSystem.cpp` | 🟡 이미 `#elif defined(__linux) \|\| defined(__linux__) \|\| defined(linux)` 분기 존재 (:296) — **부분 포팅됨** |

**Zest CMake 플랫폼 분기**: MSVC ×4 (:362,395,445,643), APPLE ×3 (:659,683,699), WIN32 ×1 (:704), MSVC+SHARED ×1 (:742)

**[추론]** `if(APPLE)` 분기 3개와 `ztFileSystem.cpp`의 리눅스 분기를 보면 **과거 macOS 포팅 시도 흔적**이 있음. POSIX 경로가 완전 백지는 아니며, 파일시스템·경로·로깅·문자열 다섯 군데를 `#ifdef`로 감싸는 수준으로 보임.

### 11.4 미확인 사항

`#include` 스캔만 수행. 별도 확인 필요:
- 헤더 통해 간접 유입된 Win32 API 사용 (`HANDLE`, `CreateFile`, `_stat` 등)
- `TCHAR`/`wchar_t` 문자열 처리 — **`ztString`이 TCHAR 기반이면 파급 범위가 훨씬 큼. 가장 중요한 미지수**
- 경로 구분자(`\`) 하드코딩
- vcpkg `x64-linux` 트리플렛에서 Qt5 + USD + FBX SDK 조합 빌드 가능 여부

### 11.5 선택지

| | **A. Linux 포팅 후 시작** | **B. Windows 워커로 먼저 시작** |
|---|---|---|
| 워커 실행 환경 | Linux 컨테이너 | Windows 컨테이너 / VM |
| 게이트웨이 | Linux (Go 단일 바이너리) | Linux (동일) |
| 선행 작업 | Zest 포팅 + 의존성 검증 | 없음 |
| 리스크 | 미지수(`ztString`)가 앞에 위치 | 이미지 크고 비쌈, 오케스트레이션 선택지 좁음 |

**권장: B로 시작해 A로 이전.** 프로토콜과 워커 상태머신 설계는 OS 무관이고 그것이 진짜 어려운 부분. Windows 워커로 아키텍처를 먼저 검증한 뒤 Linux 포팅을 별도 트랙으로 돌리면 포팅 리스크가 전체 일정을 막지 않음. **게이트웨이는 처음부터 Linux**여도 무방.

---

## 12. 헤드리스 실행파일 실현 가능성

### 12.1 결론

**[코드 확인]** **Windows 헤드리스 exe 생성 가능.** GUI(`MainGUI`)와 렌더러(`Renderer2D/3D`)를 제외한 타깃을 만들면 됨.

### 12.2 검증 결과 — 시뮬레이션 경로에 OpenGL 없음

| 검사 항목 | 결과 |
|---|---|
| Zest가 OpenGL/GLEW에 링크하는가 | **아니오** — `Zest/CMakeLists.txt`에 0건 |
| Zelus가 OpenGL에 링크하는가 | **아니오** — 0건 |
| Zest 안에 GL 호출이 있는가 | **0건** (대소문자 구분 `\bgl[A-Z][a-zA-Z]+\s*\(` 검사) |
| `ZestManager`가 GL/Lumia 심볼을 쓰는가 | **0건** (대소문자 구분) |
| glTF 익스포터가 GL을 쓰는가 | **아니오** — FreeImage(`FreeimagePlus.h`) 기반. `zsTexture.h`를 include하지만 **실사용 0건** (잔여 include로 보임) |

**결정적 근거**: `Zest/testing/sdk/CMakeLists.txt.in`의 SDK 샘플이 **`Zest TBB::tbb`만 링크**해서 `.zls`를 로드함 (`main.cpp.in`: `ztSceneManager sceneManager; sceneManager.LoadScene(file, ztString(), dummyInfo)`). Lumia도 GL도 없음.

### 12.3 계층 분리

| 헤드리스에 **필요** | 헤드리스에서 **제외** |
|---|---|
| `ZestManager` | `MainGUI.{h,cpp}` — ImGui + Win32 다이얼로그 |
| `core/` — 패브릭·u3m·xtex 파서, 머티리얼 매니저 | `Renderer3D` / `Renderer2D` — GL 필수 |
| `scene/` — glTF 익스포터, Draco | `PaintInterface2D` / `Seam2DRenderer` — nanovg |
| `Util` | `imgui_impl_glfw_gl3` |
| Zest / Zelus | `main.cpp` — GLFW 윈도우 + 루프 |
| Qt5::Core, Qt5::Xml, TBB, FreeImage, draco, jsoncpp, nlohmann_json | OpenGL, GLEW, imgui, glfw, nanovg |

익스포트 옵션(GLB, Draco 압축, 외부 URI, `.zsgltf` zip)은 **이미 구현돼 있고 하드코딩 상수로만 막혀 있으므로**, 헤드리스에서 프로토콜 파라미터로 개방하면 됨.

### 12.4 ⚠️ 걸림돌 — `core/`는 Lumia에 결합됨

**[코드 확인]** `ZestManager`는 GL-free이지만 `core/`는 아님:

| 위치 | 결합 |
|---|---|
| `core/zwMaterialManager.h:16` | `#include <zsPBRMaterial.h>` (Lumia) |
| `core/zwFabricMaterial.h:14` | `#include <Lumia.h>` (Lumia) |
| `core/zwFabricMaterial.h:189` | 헤더 안에서 `zsPBRMaterial::ptr materialPtr = std::make_shared<zsPBRMaterial>();` — **기본 멤버 초기화자**이므로 모든 `zwFabricMaterialData` 생성 시 실행 |
| `core/zwMaterialManager.h:101,104` | `CreateMaterial(...) -> zsPBRMaterial::ptr` ×2 (데드 코드지만 컴파일됨) |
| **`core/zwMaterialManager.cpp:2075`** | **`zsTexture::createAndLoadTexture(..., sync=true)`** ← GL 텍스처 |

#### 문제의 호출 체인

```
ZestManager::Initialize()                          ZestManager.cpp:57
└─ zwMaterialManager::InitMaterialFolders()        zwMaterialManager.cpp:1280
   └─ GetPresetMaterialInfo(root)                  :1285 → :1418
      └─ GetClothMaterialsRecursive(presetPath)    :1428
         └─ ParseCurrentFolder()                   :1144 → :1149
            └─ ParseFile()                         :1157
               └─ InitTextureOriginalSize()        :2215 / :2306 / :2374
                  └─ zsTexture::createAndLoadTexture(..., sync=true)   :2075  ← GL
```

즉 **`ZestManager::Initialize()`가 GL 텍스처 생성에 도달**함. (앞선 "시뮬레이션 경로 전체가 GL-free"라는 서술은 범위가 과했음 — 정확히는 **시뮬레이션은 GL-free지만 머티리얼 초기화는 아님**.)

#### 다만 3중 방어가 걸려 있음

`InitTextureOriginalSize` (zwMaterialManager.cpp:2064-2089):
1. `capturedWidth == -1.0f || capturedHeight == -1.0f` 일 때만 실행 (패브릭 메타데이터에 크기가 없을 때만)
2. 텍스처 파일이 없으면 early return
3. **`if (!texture->isPrepared()) return;`** ← GL 업로드 실패 시 우아하게 빠짐

**[추론]** `glewInit()`은 `Lumia::setupAppIntegration`(Lumia.cpp:58)에서만 호출됨. 이를 호출하지 않으면 GLEW 함수 포인터가 NULL이라 **크래시** 가능성이 있고, 반대로 `createAndLoadTexture`가 CPU 로딩만 하고 `isPrepared()=false`로 반환하면 **무사 통과**. 헤더만으로는 확정 불가 — **런타임 테스트가 답할 질문**.

### 12.5 쉬운 우회로

`zwMaterialManager.cpp:2084-2089`:

```cpp
fipImage fbm;                                    // ← 이미 FreeImage로 같은 파일을 로드 중
if (fbm.load(baseColorTexPath.toStdString().c_str()))
{
    pzfm->capturedWidth  = static_cast<double>(texture->getWidth())  / fbm.getHorizontalResolution();
    pzfm->capturedHeight = static_cast<double>(texture->getHeight()) / fbm.getVerticalResolution();
```

**픽셀 크기를 얻으려고 `zsTexture`(GL)를 쓰는데, 같은 파일을 FreeImage로도 이미 열고 있음.** `fbm.getWidth()`/`getHeight()`로 대체하면 `core/`의 **유일한 실사용 GL 의존이 소멸**. 약 3줄 수정.

그러면 남는 Lumia 결합은 헤더 include와 데드 코드(`CreateMaterial` ×2)뿐이고, 이는 **링크만 되면 되지 GL 컨텍스트는 불필요**.

### 12.6 남은 미검증 사항

| # | 항목 | 내용 |
|---|---|---|
| 1 | Lumia DLL 정적 초기화 | Lumia.dll 로드 시점의 정적 초기화가 GL을 건드리지 않는지는 **실행해봐야 확정**. 건드리지 않을 가능성이 높으나 장담 불가. 문제 시 해당 함수 2개를 `#ifdef`로 제외하고 Lumia를 완전히 분리 |
| 2 | Qt5 모듈 범위 | `zwXtexParser`(Vizoo XML)와 `zwQtUtils`가 Qt5 Core/Xml 사용. `zelusSandBox/CMakeLists.txt:77`이 이미 `COMPONENTS Core Xml`이라 문제없어 보이나 확인 필요 |
| 3 | 라이선스 필요 여부 | 현재 `ZELUS_USE_LICENSING=OFF`라 불필요할 것으로 보이나 미검증 |

### 12.7 검증 계획 (미실행)

**아직 빌드/실행하지 않음.** 다음 순서로 진행 예정:

1. `server_main.cpp` 작성 — load → N프레임 → export
2. `zelusSandBox/CMakeLists.txt`에 GUI/렌더러 제외 타깃 추가
3. `cmake_build_src`에 재구성 후 Debug 빌드
4. `Zest/testing/sdk/sample.zls`(107MB, 실파일)로 실행

목표 커맨드:
```
zelusSandBoxd.exe --headless --load sample.zls --frames 100 --export out.gltf
```

**이 한 줄로 확정되는 것**: GL 없이 링크·실행되는가 (Lumia 정적 초기화 포함) / 시뮬레이션이 윈도우 없이 도는가 / 익스포트 경로가 GL 없이 완결되는가 / 라이선스가 필요한가

**이 한 줄로 확정되지 않는 것**: 파라미터 40개 실제 반영, 프레임별 메시 추출(익스포트는 종료 시 1회뿐), 세션 재사용(load→clear→load), 패브릭/드레이핑/포즈 적용, 메모리·속도 실측, 동시 인스턴스 — 프로토콜 설계 후 2차 검증 대상

3~4번에서 링크 에러가 나면 그 자체가 결과 — 어떤 심볼이 GL을 끌고 오는지 드러남.

---

## 부록: 조사 방법론

**[방법]**

| 단계 | 내용 |
|---|---|
| 1차 | 저장소 구조, 빌드 설정, 최상위 CMake, 주요 헤더 직접 정독 |
| 2차 | 서브에이전트 5개 병렬 조사 — ① MainGUI UI 인벤토리 ② zelusSandBox 비UI ③ Zest ④ Zelus ⑤ Lumia. 각 에이전트에 "전체 정독, 샘플링 금지, file:line 명시, 도달성을 grep으로 검증" 지시 |
| 3차 | 교차 검증 — 버그 ①은 에이전트 2개가 독립 발견 |
| 4차 | 헤드리스/Linux 관련 추가 타깃 조사 (대소문자 구분 grep, 호출체인 추적) |

**서브에이전트 토큰 사용량**: 약 97만 토큰 (①92.5K ②436K ③217K ④228K ⑤ Zest 51KB 출력)

**한계**:
- Lumia·Zelus는 주로 **공개 헤더** 기준. 일부 `.cpp` 본문은 미정독
- Zest `common/`·`misc/`는 사소한 헤더 일부를 의도적으로 건너뜀 (§6.7에 명시)
- Win32 의존성은 `#include` 스캔 기준 — 간접 유입 API는 미확인 (§11.4)
- **헤드리스 실행은 미검증** (§12.7)

---

## 대상 프로젝트

**자세한 내용은 [`zelusSandBox_Cobalt/`](./zelusSandBox_Cobalt/) 프로젝트를 보면 된다.**

이 문서에 나오는 모든 경로와 `file:line` 참조는 해당 디렉토리를 루트로 한 상대 경로다.
예: `zelusSandBox/MainGUI.cpp:471` → `zelusSandBox_Cobalt/zelusSandBox/MainGUI.cpp:471`

