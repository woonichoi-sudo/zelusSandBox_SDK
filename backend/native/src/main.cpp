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

#include <ZestManager.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <iostream>
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
};

void PrintUsage()
{
    std::cerr <<
        "usage: zelusSandBoxd --load <file.zls> [options]\n"
        "\n"
        "  --load <path>      로드할 .zls (필수)\n"
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
        else if (std::strcmp(a, "--zbin") == 0)   { opt.exportZbin = true; }
        else if (std::strcmp(a, "--init") == 0)   { opt.callInitialize = true; }
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

    if (opt.loadPath.empty())
    {
        std::cerr << "[error] --load 는 필수입니다\n";
        PrintUsage();
        return false;
    }

    return true;
}

void Log(const std::string& msg)
{
    std::cerr << "[zelusSandBoxd] " << msg << std::endl;
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
                Log("  frame " + std::to_string(f));
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
