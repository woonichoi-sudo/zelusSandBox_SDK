// zelusSandBoxd — 헤드리스 워커
//
// 1단계 목표는 딱 하나다: OpenGL 컨텍스트 없이 링크되고 실행되는가?
//   .zls 로드 → N프레임 시뮬 → glTF 익스포트
//
// ZestManager::Initialize()는 기본적으로 호출하지 않는다. 그 4줄 중
// zwMaterialManager::InitMaterialFolders()가 결국 GL 텍스처 생성
// (zwMaterialManager.cpp:2075)에 도달하기 때문이다. 나머지 3줄은 공개
// 세터로 대체 가능하므로, 이렇게 하면 "로드·시뮬·익스포트가 GL-free인가"만
// 순수하게 검증할 수 있다. --init 플래그로 GL 경로를 따로 실험한다.

#include "protocol.h"

#include <ZestManager.h>

#include <ztDesignClothPattern.h>
#include <ztDesignTriMesh.h>
#include <ztScene.h>
#include <ztSceneQueryInterface.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>

namespace
{

struct Options
{
    std::string loadPath;
    std::string exportPath;
    int         frames        = 100;
    int         timeoutSec    = 300;
    bool        callInitialize = false;  // --init : GL 경로를 일부러 밟아본다
    bool        exportZbin    = false;
    bool        dumpFrames    = false;  // --dump-frames : 프레임별 메시 추출 측정
    bool        serve         = false;  // --serve : JSON Lines 프로토콜 루프
};

void PrintUsage()
{
    std::cerr <<
        "usage: zelusSandBoxd --load <file.zls> [options]\n"
        "       zelusSandBoxd --serve            (JSON Lines 프로토콜)\n"
        "\n"
        "  --serve            stdin/stdout으로 JSON Lines 프로토콜을 돌린다.\n"
        "                     게이트웨이가 자식 프로세스로 띄우는 모드.\n"
        "  --load <path>      로드할 .zls (--serve 아니면 필수)\n"
        "  --frames <n>       시뮬레이션할 프레임 수 (기본 100, 0이면 시뮬 안 함)\n"
        "  --export <path>    결과를 glTF로 익스포트\n"
        "  --zbin             glTF 대신 .zbin으로 익스포트\n"
        "  --timeout <sec>    시뮬레이션 대기 상한 (기본 300)\n"
        "  --init             ZestManager::Initialize() 호출 (GL 경로 검증용)\n";
}

bool ParseArgs(int argc, char** argv, Options& opt)
{
    for (int i = 1; i < argc; ++i)
    {
        const char* a = argv[i];
        auto next = [&](const char* name) -> const char* {
            if (i + 1 >= argc)
            {
                std::cerr << "[error] " << name << " 에 값이 없습니다\n";
                return nullptr;
            }
            return argv[++i];
        };

        if (std::strcmp(a, "--load") == 0)
        {
            const char* v = next("--load");
            if (!v) return false;
            opt.loadPath = v;
        }
        else if (std::strcmp(a, "--export") == 0)
        {
            const char* v = next("--export");
            if (!v) return false;
            opt.exportPath = v;
        }
        else if (std::strcmp(a, "--frames") == 0)
        {
            const char* v = next("--frames");
            if (!v) return false;
            opt.frames = std::atoi(v);
        }
        else if (std::strcmp(a, "--timeout") == 0)
        {
            const char* v = next("--timeout");
            if (!v) return false;
            opt.timeoutSec = std::atoi(v);
        }
        else if (std::strcmp(a, "--zbin") == 0)       { opt.exportZbin = true; }
        else if (std::strcmp(a, "--init") == 0)       { opt.callInitialize = true; }
        else if (std::strcmp(a, "--dump-frames") == 0){ opt.dumpFrames = true; }
        else if (std::strcmp(a, "--serve") == 0)      { opt.serve = true; }
        else if (std::strcmp(a, "--help") == 0 || std::strcmp(a, "-h") == 0)
        {
            PrintUsage();
            return false;
        }
        else
        {
            std::cerr << "[error] 알 수 없는 인자: " << a << "\n";
            PrintUsage();
            return false;
        }
    }

    // --serve 는 씬을 프로토콜로 받으므로 --load가 필요 없다.
    if (!opt.serve && opt.loadPath.empty())
    {
        std::cerr << "[error] --load 는 필수입니다 (--serve 사용 시 제외)\n";
        PrintUsage();
        return false;
    }

    return true;
}

void Log(const std::string& msg)
{
    std::cerr << "[zelusSandBoxd] " << msg << std::endl;
}

// ── 프레임별 메시 추출 ───────────────────────────────────────
//
// 웹으로 지오메트리를 스트리밍하려면 프레임마다 메시를 꺼낼 수 있어야 한다.
// 데스크톱 렌더러가 쓰는 경로를 그대로 쓴다 (Renderer3D.cpp:768):
//
//   clothPattern->GetSimulationOutputMesh()  -> ztChangeTracker<ztDesignTriMesh>
//     .QueryForUpdate(listener)  변경 여부 (리스너별로 추적)
//     .Read()                    실제 메시
//       .vertices / .normals     프레임마다 변함  ← 이것만 보내면 된다
//       .indices  / .uvs         토폴로지. 프레임 간 고정
//
// 여기서는 추출이 되는지, 값이 실제로 변하는지, 비용이 얼마인지만 잰다.
struct FrameMeshStats
{
    std::size_t patterns   = 0;
    std::size_t changed    = 0;
    std::size_t vertices   = 0;
    std::size_t triangles  = 0;
    double      checksum   = 0.0;   // 위치가 실제로 변하는지 확인용
    double      elapsedMs  = 0.0;

    // 헤더 주석은 "sim output mesh is in 2D design space"라고 하는데
    // 데스크톱 3D 렌더러가 이걸 그대로 쓴다. 좌표 범위로 실제를 확인한다.
    float minX = 0, maxX = 0, minY = 0, maxY = 0, minZ = 0, maxZ = 0;
    bool  hasBounds = false;
};

FrameMeshStats ExtractFrameMeshes(ZestManager& manager, void* listener)
{
    FrameMeshStats st;

    const auto start = std::chrono::steady_clock::now();

    ztScene* scene = manager.GetSceneManager()->GetCurrentScene();
    if (!scene)
    {
        return st;
    }

    ztSceneQueryInterface* qi = scene->GetQueryInterface();
    if (!qi)
    {
        return st;
    }

    for (const auto& entry : qi->GetClothPatterns())
    {
        const ztDesignClothPattern* pattern = entry.second.get();
        if (!pattern)
        {
            continue;
        }

        const ztChangeTracker<ztDesignTriMesh>& tracker = pattern->GetSimulationOutputMesh();

        ++st.patterns;
        if (tracker.QueryForUpdate(listener))
        {
            ++st.changed;
        }

        const ztDesignTriMesh& mesh = tracker.Read();

        st.vertices  += mesh.vertices.size();
        st.triangles += mesh.indices.size() / 3;

        for (std::size_t i = 0; i < mesh.vertices.size(); ++i)
        {
            const ZELUS::zsVector3& v = mesh.vertices[i];
            st.checksum += v.x + v.y + v.z;

            if (!st.hasBounds)
            {
                st.minX = st.maxX = v.x;
                st.minY = st.maxY = v.y;
                st.minZ = st.maxZ = v.z;
                st.hasBounds = true;
            }
            else
            {
                st.minX = (std::min)(st.minX, v.x);  st.maxX = (std::max)(st.maxX, v.x);
                st.minY = (std::min)(st.minY, v.y);  st.maxY = (std::max)(st.maxY, v.y);
                st.minZ = (std::min)(st.minZ, v.z);  st.maxZ = (std::max)(st.maxZ, v.z);
            }
        }
    }

    st.elapsedMs = std::chrono::duration<double, std::milli>(
                       std::chrono::steady_clock::now() - start).count();

    return st;
}

// 어느 엔진과 링크됐는지. 빌드가 두 종류라 실행 파일만 보고는 알 수 없어서
// 시작할 때 반드시 남긴다 (잘못된 빌드를 돌리는 사고를 줄인다).
const char* EngineVariant()
{
#if ZSBD_REQUIRES_LICENSE
    return "SDK 프리빌드 — 라이선스 필요 (ZELUS_SDK_LICENSE_FILE)";
#else
    return "소스 빌드 — 라이선스 불필요 (데모용)";
#endif
}

} // namespace

int main(int argc, char** argv)
{
    Options opt;
    if (!ParseArgs(argc, argv, opt))
    {
        return 1;
    }

    Log("시작 — 이 시점까지 왔다면 링크와 정적 초기화(Lumia DLL 포함)가 통과한 것");
    Log(std::string("엔진: ") + EngineVariant());

#if ZSBD_REQUIRES_LICENSE
    if (const char* lic = std::getenv("ZELUS_SDK_LICENSE_FILE"))
    {
        Log(std::string("라이선스 파일: ") + lic);
    }
    else
    {
        Log("경고 — ZELUS_SDK_LICENSE_FILE 이 설정되지 않았습니다. "
            "시뮬레이션이 시작되지 않을 수 있습니다.");
    }
#endif

    ZestManager manager;

    // ── 익스포트 플래그 ──────────────────────────────────────
    // Initialize()가 하는 일 중 GL과 무관한 3줄을 공개 세터로 대체한다.
    manager.SetExportGLTF(true);
    manager.SetExportGltfGlb(false);      // .gltf (GLB 아님)
    manager.SetEmbeddedResource(true);

    if (opt.callInitialize)
    {
        // GL 도달 경로를 의도적으로 밟는다. 죽으면 그 자체가 결과다.
        Log("Initialize() 호출 — InitMaterialFolders()가 GL 텍스처 생성에 도달할 수 있음");
        manager.Initialize();
        Log("Initialize() 통과 — GL 없이 머티리얼 폴더 초기화 성공");
    }

    // ── 프로토콜 모드 ────────────────────────────────────────
    // 여기부터는 stdout이 프로토콜 전용이 되므로 CLI 경로와 섞이지 않는다.
    if (opt.serve)
    {
        Log("프로토콜 모드 (JSON Lines). stdin으로 요청, stdout으로 응답.");
        return RunProtocolLoop(manager);
    }

    // ── 콜백 등록 ────────────────────────────────────────────
    // curFrame만으로는 부족하다. SetAnimationMode(PAUSE)가 콜백을 -1로 다시
    // 불러서 진행 상황을 지워버린다. 도달한 최대 프레임을 따로 기록한다.
    std::atomic<int> curFrame{ -1 };
    std::atomic<int> maxFrame{ -1 };

    manager.SetSimulationCallBackFunctions(
        [&curFrame, &maxFrame](int frame) {
            curFrame.store(frame);

            int prev = maxFrame.load();
            while (frame > prev && !maxFrame.compare_exchange_weak(prev, frame))
            {
                // prev는 compare_exchange_weak가 갱신해 준다
            }
        },
        [](const std::string& message) { Log("engine: " + message); });

    // ── 로드 ─────────────────────────────────────────────────
    // 주의: LoadZls는 진행 상황을 std::cout으로 찍는다. 2단계에서 stdout을
    //       JSON 프로토콜 채널로 쓸 때는 이 출력을 stderr로 돌려야 한다.
    Log("로드: " + opt.loadPath);

    if (!manager.LoadZls(ztString(opt.loadPath)))
    {
        Log("실패 — .zls 로드 실패");
        return 2;
    }

    Log("로드 완료");

    // ── 시뮬레이션 ───────────────────────────────────────────
    if (opt.frames > 0)
    {
        Log("시뮬레이션 시작 — 목표 " + std::to_string(opt.frames) + " 프레임");

        manager.SetAnimationMode(ZestManager::AnimationMode::PLAY);

        const auto deadline =
            std::chrono::steady_clock::now() + std::chrono::seconds(opt.timeoutSec);

        int lastReported = -1;

        while (maxFrame.load() < opt.frames)
        {
            if (std::chrono::steady_clock::now() > deadline)
            {
                Log("실패 — 타임아웃 (" + std::to_string(opt.timeoutSec) + "초). "
                    "도달 프레임 " + std::to_string(maxFrame.load()));
                manager.SetAnimationMode(ZestManager::AnimationMode::PAUSE);
                return 3;
            }

            const int f = maxFrame.load();
            if (f > lastReported)
            {
                lastReported = f;

                if (opt.dumpFrames)
                {
                    // 리스너 주소는 안정적이기만 하면 된다.
                    static int listenerToken = 0;
                    const FrameMeshStats st = ExtractFrameMeshes(manager, &listenerToken);

                    std::ostringstream os;
                    os << "  frame " << f
                       << " | 패턴 " << st.patterns << " (변경 " << st.changed << ")"
                       << " | 정점 " << st.vertices
                       << " | 삼각형 " << st.triangles
                       << " | 추출 " << std::fixed << std::setprecision(2) << st.elapsedMs << "ms"
                       << " | bbox X[" << std::setprecision(1) << st.minX << ".." << st.maxX
                       << "] Y[" << st.minY << ".." << st.maxY
                       << "] Z[" << st.minZ << ".." << st.maxZ << "]";
                    Log(os.str());
                }
                else
                {
                    Log("  frame " + std::to_string(f));
                }
            }

            manager.UpdateFrame();   // 대기 중인 라이브에디팅 반영
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }

        manager.SetAnimationMode(ZestManager::AnimationMode::PAUSE);

        Log("시뮬레이션 완료 — 도달 프레임 " + std::to_string(maxFrame.load()) +
            " (목표 " + std::to_string(opt.frames) + ")");
        Log(std::string("시뮬 월드 초기화됨: ") +
            (manager.IsSimulationInitialized() ? "예" : "아니오"));
    }

    // ── 익스포트 ─────────────────────────────────────────────
    if (!opt.exportPath.empty())
    {
        Log("익스포트: " + opt.exportPath);

        if (opt.exportZbin)
        {
            if (!manager.ExportZbin(ztString(opt.exportPath)))
            {
                Log("실패 — .zbin 익스포트 실패");
                return 4;
            }
        }
        else
        {
            // 텍스처 베이킹이 들어있다. GL 없이 완결되는지가 여기서 드러난다.
            manager.ExportGltf(ztString(opt.exportPath));
        }

        Log("익스포트 완료");
    }

    Log("정상 종료");
    return 0;
}
