# 데모용 엔진 빌드 (Zest / Zelus / Lumia, ZELUS_USE_LICENSING=OFF)
#
# 저장소의 최상위 CMakeLists를 쓰지 않는다. 그쪽은 source 모드에서
# InstallSDK를 무조건 include하는데, install(EXPORT LumiaTargets)가
# Lumia가 링크하는 Zelus를 export set에서 찾지 못해 생성 단계에서 죽는다
# (저장소가 원래 갖고 있는 문제. 우리가 고칠 수 없다 — 읽기 전용이므로).
#
# 우리에게 필요한 건 DLL과 import lib뿐이지 SDK 설치가 아니므로,
# 엔진 서브프로젝트만 직접 add_subdirectory 한다. 데스크톱 앱도 빌드하지
# 않으므로 시간도 아낀다.
#
# 산출물은 전부 이 빌드 디렉토리에 떨어진다. 저장소에는 쓰지 않는다.

cmake_minimum_required(VERSION 3.21)

project(zelus_engine)

get_filename_component(SANDBOX_REPO_DEFAULT
    "${CMAKE_CURRENT_SOURCE_DIR}/../../../zelusSandBox_Cobalt" ABSOLUTE)

set(SANDBOX_REPO "${SANDBOX_REPO_DEFAULT}" CACHE PATH
    "zelusSandBox_Cobalt 저장소 경로 (읽기 전용)")

if (NOT EXISTS "${SANDBOX_REPO}/Zest/CMakeLists.txt")
    message(FATAL_ERROR "zelusSandBox_Cobalt를 찾을 수 없음: ${SANDBOX_REPO}")
endif()

set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)

# 저장소와 동일한 구성 타입 / MSVC 런타임을 쓴다.
set(CMAKE_MODULE_PATH "${SANDBOX_REPO}/cmake" ${CMAKE_MODULE_PATH})
include(SetupConfigs)

add_subdirectory("${SANDBOX_REPO}/Zest"  Zest)
add_subdirectory("${SANDBOX_REPO}/Lumia" Lumia)
