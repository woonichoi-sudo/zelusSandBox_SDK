# 데스크톱 앱(zelusSandBox.exe) 아웃오브트리 빌드
#
# 저장소 최상위 `CMakeLists.txt` 를 쓰지 않는다. 그쪽은 소스 모드(USE_SDK=OFF)에서
# `include(InstallSDK)` 를 **무조건** 하는데, `install(EXPORT LumiaTargets)` 가
# Lumia 가 링크하는 Zelus 를 export set 에서 찾지 못해 **생성 단계에서 죽는다**:
#
#   CMake Error: install(EXPORT "LumiaTargets" ...) includes target "Lumia"
#   which requires target "Zelus" that is not in any export set.
#
# 저장소가 원래 갖고 있는 문제이고 옵션으로 끌 수 없다(최상위 CMakeLists.txt:22).
# 우리는 읽기 전용이라 고칠 수 없으므로, 최상위가 하는 일을 여기서 그대로 하되
# InstallSDK 만 뺀다. 우리에게 필요한 것은 실행 파일이지 SDK 설치가 아니다.
#
# `backend/native/engine/CMakeLists.txt` 와 같은 수법이며, 차이는 앱까지
# 함께 빌드한다는 것뿐이다. 산출물은 전부 이 빌드 디렉토리에 떨어지고
# 저장소에는 아무것도 쓰지 않는다.
#
# 구성 예 (CMake 는 VS 번들 3.31.6 을 전체 경로로 부를 것 — PATH 의 4.x 는 vcpkg
# 포트를 깨뜨린다. CLAUDE.md 참고):
#
#   cmake -S desktop -B build-desktop -G "Visual Studio 17 2022" -A x64 \
#     -D CMAKE_TOOLCHAIN_FILE=D:/vcpkg-pinned/scripts/buildsystems/vcpkg.cmake \
#     -D VCPKG_TARGET_TRIPLET=x64-windows \
#     -D VCPKG_INSTALLED_DIR=<워크스페이스>/vcpkg_installed \
#     -D VCPKG_MANIFEST_MODE=OFF \
#     -D ZELUS_SANDBOX_USE_SDK=OFF -D ZELUS_USE_LICENSING=OFF -D ZELUS_USE_CUDA=OFF \
#     -D ZELUS_SHARED_BUILD=ON -D ZEST_SHARED_BUILD=ON -D LUMIA_SHARED_BUILD=ON \
#     -D ZEST_INSTALL_SDK=OFF \
#     -D LUMIA_BACKEND_ENABLE_OPTIX=OFF -D LUMIA_BACKEND_ENABLE_VRAY=OFF \
#     -D ZELUS_DOUBLE_PRECISION=OFF -D ZELUS_USE_SIMD_SSE=ON -D ZELUS_USE_SIMD_AVX=ON \
#     -D ZELUS_USE_PROFILER=OFF
#
# 플래그는 회사 스크립트(`build/internal/run_cmake_vs_2022_x64_CUDA_internal.bat`)
# 를 따르되 둘을 뒤집었다: `ZELUS_USE_LICENSING=ON → OFF`(라이선스 없이 돌린다),
# `ZELUS_USE_CUDA=ON → OFF`(CPU 솔버만).

cmake_minimum_required(VERSION 3.21)

project(zelusSandBox_desktop)

get_filename_component(SANDBOX_REPO_DEFAULT
    "${CMAKE_CURRENT_SOURCE_DIR}/../zelusSandBox_Cobalt" ABSOLUTE)

set(SANDBOX_REPO "${SANDBOX_REPO_DEFAULT}" CACHE PATH
    "zelusSandBox_Cobalt 저장소 경로 (읽기 전용)")

if (NOT EXISTS "${SANDBOX_REPO}/zelusSandBox/CMakeLists.txt")
    message(FATAL_ERROR
        "zelusSandBox_Cobalt를 찾을 수 없음: ${SANDBOX_REPO}\n"
        "-D SANDBOX_REPO=<경로> 로 지정하십시오.")
endif()

if (NOT EXISTS "${SANDBOX_REPO}/Zest/CMakeLists.txt")
    message(FATAL_ERROR
        "서브모듈이 비어 있습니다: ${SANDBOX_REPO}/Zest\n"
        "저장소에서 `git submodule update --init --recursive` 를 먼저 하십시오.\n"
        "⚠️ --recursive 가 없으면 Zest 안의 Zelus 가 오지 않습니다.")
endif()

# 최상위와 같은 출력 배치 — 앱의 POST_BUILD 정션(appdata·media)이 이 밑에 붙는다.
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)

# 저장소와 동일한 구성 타입 / MSVC 런타임.
set(CMAKE_MODULE_PATH "${SANDBOX_REPO}/cmake" ${CMAKE_MODULE_PATH})
include(SetupConfigs)

add_subdirectory("${SANDBOX_REPO}/Zest"         Zest)
add_subdirectory("${SANDBOX_REPO}/Lumia"        Lumia)
# ⛔ include(InstallSDK) — 위 머리말 참고. 이 한 줄이 저장소 빌드를 죽인다.
add_subdirectory("${SANDBOX_REPO}/zelusSandBox" zelusSandBox)

if (MSVC)
    set_property(GLOBAL PROPERTY USE_FOLDERS ON)
    set_property(TARGET Lumia PROPERTY FOLDER "core")
    set_property(TARGET Zest  PROPERTY FOLDER "core")
endif()
