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

    set(SRC_BUILD "${SANDBOX_REPO}/cmake_build_src")

    if (NOT EXISTS "${SRC_BUILD}/lib/Debug/Zest_debug.lib")
        message(FATAL_ERROR
            "소스 빌드 엔진을 찾을 수 없음: ${SRC_BUILD}/lib/Debug\n"
            "라이선스가 있다면 -D USE_SDK_ENGINE=ON 으로 SDK를 쓰십시오.")
    endif()

    set(ENGINE_LIBS
        "${SRC_BUILD}/lib/$<CONFIG>/Zest_debug.lib"
        "${SRC_BUILD}/lib/$<CONFIG>/Zelus_debug.lib"
        "${SRC_BUILD}/lib/$<CONFIG>/Lumia_debug.lib"
    )
    set(ENGINE_BIN_DIR "${SRC_BUILD}/bin/$<CONFIG>")

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
