# zelusSandBoxd — 헤드리스 워커 (아웃오브트리 빌드)
#
# zelusSandBox_Cobalt 저장소는 읽기 전용이다. 이 프로젝트는 저장소 안에
# 아무것도 쓰지 않고, 소스를 절대경로로 참조해 컴파일하고 프리빌드 SDK를
# 링크한다. GUI(MainGUI)와 렌더러(Renderer2D/3D)는 제외한다 — OpenGL 계층.

cmake_minimum_required(VERSION 3.21)

project(zelusSandBoxd VERSION 0.1 LANGUAGES CXX)

# ── 회사 저장소 위치 (읽기 전용) ────────────────────────────
get_filename_component(SANDBOX_REPO_DEFAULT
    "${CMAKE_CURRENT_SOURCE_DIR}/../../zelusSandBox_Cobalt" ABSOLUTE)

set(SANDBOX_REPO "${SANDBOX_REPO_DEFAULT}" CACHE PATH
    "zelusSandBox_Cobalt 저장소 경로 (읽기 전용)")

if (NOT EXISTS "${SANDBOX_REPO}/zelusSandBox/ZestManager.h")
    message(FATAL_ERROR
        "zelusSandBox_Cobalt를 찾을 수 없음: ${SANDBOX_REPO}\n"
        "-D SANDBOX_REPO=<경로> 로 지정하십시오.")
endif()

set(APP_DIR "${SANDBOX_REPO}/zelusSandBox")

# ── 엔진 (Zest / Zelus / Lumia) ─────────────────────────────
#
# 두 가지 선택지가 있고 라이선스 요구가 갈린다:
#
#   SDK/            회사 배포 프리빌드. ZELUS_USE_LICENSING=ON 으로 빌드돼
#                   있어 시뮬레이션 시 라이선스 파일을 요구한다.
#                   (없으면 "Failed to load the license"를 무한 반복)
#
#   cmake_build_src/ 저장소에서 소스로 빌드된 것. ZELUS_USE_LICENSING=OFF
#                   이라 라이선스 없이 시뮬레이션이 돈다.
#
# 헤더는 양쪽 공통으로 SDK/include(평탄화된 트리)를 쓴다.
option(USE_SDK_ENGINE "SDK 프리빌드 엔진 사용 (라이선스 필요)" OFF)

set(ENGINE_INCLUDE_DIR "${SANDBOX_REPO}/SDK/include")

if (USE_SDK_ENGINE)
    find_package(Zest REQUIRED)
    find_package(Lumia REQUIRED)
    set(ENGINE_LIBS Zest Lumia)
    set(ENGINE_BIN_DIR "${SANDBOX_REPO}/SDK/bin/$<CONFIG>")

    # 두 빌드가 섞이지 않도록 산출물 이름을 나눈다.
    set(OUTPUT_NAME "zelusSandBoxd")
    set(REQUIRES_LICENSE 1)
else()
    set(OUTPUT_NAME "zelusSandBoxd-demo")
    set(REQUIRES_LICENSE 0)

    # 라이선스 없는 엔진은 구성에 따라 이름이 다르다 (SetupConfigs의 debug postfix).
    #
    #   Debug   → Zest_debug.lib
    #   Release → Zest.lib
    #
    # 위치는 두 곳일 수 있다. 저장소에 `cmake_build_src`가 이미 있으면 Debug는
    # 그걸 쓰고(다시 만들 이유가 없다), 없으면 우리가 `engine/CMakeLists.txt`로
    # 빌드한 engine-build를 양쪽 구성 모두에 쓴다.
    #
    # ⚠️ `cmake_build_src`는 저장소에 항상 있는 것이 아니다 — 이 워크스페이스를
    #    새 머신으로 옮기면 없다(2026-08-21에 실제로 밟았다). 그래서 없다고
    #    구성 단계에서 죽이지 않는다. Release만 필요한 경우가 대부분이고,
    #    실제로 없는 구성으로 빌드하면 링커가 그때 정확히 지목한다.
    set(ENGINE_RELEASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/engine-build")

    if (EXISTS "${SANDBOX_REPO}/cmake_build_src/lib/Debug/Zest_debug.lib")
        set(ENGINE_DEBUG_DIR "${SANDBOX_REPO}/cmake_build_src")
    else()
        set(ENGINE_DEBUG_DIR "${ENGINE_RELEASE_DIR}")
    endif()

    foreach(_cfg Debug Release)
        if (_cfg STREQUAL "Debug")
            set(_dir "${ENGINE_DEBUG_DIR}")
            set(_lib "Zest_debug.lib")
        else()
            set(_dir "${ENGINE_RELEASE_DIR}")
            set(_lib "Zest.lib")
        endif()
        if (NOT EXISTS "${_dir}/lib/${_cfg}/${_lib}")
            message(WARNING
                "${_cfg} 엔진이 없습니다: ${_dir}/lib/${_cfg}\n"
                "engine/CMakeLists.txt 로 그 구성을 먼저 빌드하십시오. "
                "다른 구성은 그대로 됩니다.")
        endif()
    endforeach()

    set(ENG_DIR "$<IF:$<CONFIG:Debug>,${ENGINE_DEBUG_DIR},${ENGINE_RELEASE_DIR}>")
    set(ENG_SUF "$<$<CONFIG:Debug>:_debug>")

    set(ENGINE_LIBS
        "${ENG_DIR}/lib/$<CONFIG>/Zest${ENG_SUF}.lib"
        "${ENG_DIR}/lib/$<CONFIG>/Zelus${ENG_SUF}.lib"
        "${ENG_DIR}/lib/$<CONFIG>/Lumia${ENG_SUF}.lib"
    )
    set(ENGINE_BIN_DIR "${ENG_DIR}/bin/$<CONFIG>")

    # find_package를 쓰지 않으므로 imported target이 주던 INTERFACE 속성을
    # 직접 재현해야 한다. 특히 ZS_OS_WINDOWS가 없으면 ztCommon.h가 GCC 분기로
    # 빠져 ZT_INLINE이 __attribute__로 확장된다.
    #
    # SDK 타깃 정의에서 ZELUS_USE_LICENSING과 ZS_USE_CUDA는 뺐다.
    # cmake_build_src는 두 옵션 모두 OFF로 빌드됐고, 정의가 어긋나면 ABI가 깨진다.
    set(ENGINE_DEFINITIONS
        ZS_OS_WINDOWS
        ZELUS_SHARED_BUILD
        ZELUS_THREADING_BACKEND_HAS_TBB
        ZS_USE_ASSERT
        ZS_USE_FAST_MATH
        ZS_USE_SSE
        ZS_USE_AVX
        _CRT_SECURE_NO_DEPRECATE
        # Zest 쪽
        ZT_ASSERT
        _DISABLE_EXTENDED_ALIGNED_STORAGE
        _CRT_SECURE_NO_WARNINGS
        _UNICODE
        ZT_LOG_ENABLE_OUTPUT_DEBUG
    )
    set(ENGINE_OPTIONS /arch:AVX /wd4244 /wd4101 /wd4099 /wd4834)
endif()

find_package(Qt5 COMPONENTS Core Xml REQUIRED)   # zwXtexParser, zwQtUtils
find_package(TBB CONFIG REQUIRED)
find_package(freeimage CONFIG REQUIRED)
find_package(draco CONFIG REQUIRED)
find_package(JsonCpp CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_path(TINYGLTF_INCLUDE_DIRS "tiny_gltf.h")

# ── 저장소에서 가져다 컴파일하는 소스 (수정하지 않음) ────────
# 제외: MainGUI, Renderer3D/2D, Seam2DRenderer, PaintInterface2D,
#       imgui_impl_glfw_gl3, main.cpp, Camera*Controlls, zwViewOptionManager
set(SANDBOX_SOURCES
    "${APP_DIR}/ZestManager.cpp"
    "${APP_DIR}/Util.cpp"

    "${APP_DIR}/core/zwFabricMaterial.cpp"
    "${APP_DIR}/core/zwMaterialManager.cpp"
    "${APP_DIR}/core/zwQtUtils.cpp"
    "${APP_DIR}/core/zwXtexParser.cpp"

    "${APP_DIR}/scene/zwDracoTriMesh.cpp"
    "${APP_DIR}/scene/zwGltfExporter.cpp"
    "${APP_DIR}/scene/zwGltfExporterImpl.cpp"
)

add_executable(${PROJECT_NAME}
    src/main.cpp
    src/protocol.h
    src/protocol.cpp          # JSON Lines 프로토콜 (게이트웨이와의 대화)
    src/stb_impl.cpp          # nanovg를 링크하지 않으므로 stb_image를 직접 제공
    ${SANDBOX_SOURCES}
)

target_include_directories(${PROJECT_NAME} PRIVATE
    "${APP_DIR}"
    "${APP_DIR}/core"
    "${APP_DIR}/scene"
    "${ENGINE_INCLUDE_DIR}"
    "${TINYGLTF_INCLUDE_DIRS}"
)

target_link_libraries(${PROJECT_NAME} PRIVATE
    ${ENGINE_LIBS}            # Lumia는 링크만 필요. GL 컨텍스트는 만들지 않는다.
    Qt5::Core Qt5::Xml
    TBB::tbb
    freeimage::FreeImage freeimage::FreeImagePlus
    draco::draco
    JsonCpp::JsonCpp
    nlohmann_json::nlohmann_json
)

target_compile_definitions(${PROJECT_NAME} PRIVATE
    NOMINMAX
    TBB_SUPPRESS_DEPRECATED_MESSAGES
    ZSBD_REQUIRES_LICENSE=${REQUIRES_LICENSE}
    ${ENGINE_DEFINITIONS}       # SDK 모드에서는 비어 있음 (imported target이 제공)
)

if (ENGINE_OPTIONS)
    target_compile_options(${PROJECT_NAME} PRIVATE ${ENGINE_OPTIONS})
endif()

set_target_properties(${PROJECT_NAME} PROPERTIES
    CXX_STANDARD 17
    OUTPUT_NAME  "${OUTPUT_NAME}"
)

message(STATUS "zelusSandBoxd 산출물: ${OUTPUT_NAME}.exe "
               "(라이선스 ${REQUIRES_LICENSE})")

if (MSVC)
    target_compile_options(${PROJECT_NAME} PRIVATE /MP)

    # 우리 소스(src/*.cpp)는 BOM 없는 UTF-8이고 한글 문자열을 담고 있다.
    # MSVC는 BOM이 없으면 시스템 코드페이지로 읽으므로, 한국어 Windows(CP949)
    # 에서는 한글 리터럴의 바이트가 깨져 "상수에 줄 바꿈 문자가 있습니다"(C2001)
    # 와 구문 오류가 수백 건 쏟아진다. 2026-08-21에 새 머신에서 밟았다.
    # BOM을 붙이는 대신 컴파일러에 인코딩을 알려 준다 — 저장소 소스도 같이
    # 컴파일하므로 파일을 건드리지 않는 쪽이 안전하다.
    target_compile_options(${PROJECT_NAME} PRIVATE /utf-8)
    # 저장소 소스가 그대로 만들어내는 경고들 (원본 CMakeLists와 동일하게 억제)
    target_compile_options(${PROJECT_NAME} PRIVATE
        /wd4201 /wd4251 /wd4324 /wd4996 /wd4127 /wd4714 /wd4984 /wd4267 /wd4828)
endif()

# ── 런타임 ──────────────────────────────────────────────────
# 엔진 DLL + 그 의존성.
add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${ENGINE_BIN_DIR}" "$<TARGET_FILE_DIR:${PROJECT_NAME}>"
    COMMENT "엔진 런타임 DLL 복사"
)

# Lumia.dll이 glew32d.dll을 하드 의존한다. GL 컨텍스트를 만들지 않아도
# DLL 로드 자체에 필요하므로 반드시 있어야 한다 (없으면 0xC0000135).
find_file(GLEW_RUNTIME_DLL
    NAMES glew32d.dll glew32.dll
    PATHS "${_VCPKG_INSTALLED_DIR}/${VCPKG_TARGET_TRIPLET}/debug/bin"
          "${_VCPKG_INSTALLED_DIR}/${VCPKG_TARGET_TRIPLET}/bin"
    NO_DEFAULT_PATH)

if (GLEW_RUNTIME_DLL)
    add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${GLEW_RUNTIME_DLL}" "$<TARGET_FILE_DIR:${PROJECT_NAME}>"
        COMMENT "glew DLL 복사 (Lumia 로드에 필요)")
else()
    message(WARNING "glew DLL을 찾지 못했습니다. 실행 시 Lumia 로드가 실패할 수 있습니다.")
endif()

# 씬 로드가 에셋 루트를 참조한다. 저장소에 쓰지 않도록 정션이 아니라 복사.
add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${APP_DIR}/appdata" "$<TARGET_FILE_DIR:${PROJECT_NAME}>/appdata"
    COMMENT "appdata 복사"
)
