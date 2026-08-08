#include "protocol.h"

#include <ZestManager.h>

#include <zsTransform.h>   // 패턴 → 월드 변환 (MeshData)

#include <ztDesignClothPattern.h>
#include <ztDesignTriMesh.h>
#include <ztLiveEditUtil.h>
#include <ztScene.h>
#include <ztSceneData.h>
#include <ztSceneQueryInterface.h>

// 데스크톱 앱의 About 표시(MainGUI.cpp:373-381)와 같은 출처다.
#include <LumiaVersion.h>
#include <ZelusVersion.h>

#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using json = nlohmann::json;

namespace
{

// ── 출력 채널 분리 ──────────────────────────────────────────
//
// 엔진과 저장소 코드가 std::cout으로 사람용 메시지를 찍는다
// (예: ZestManager::LoadZls의 "[Open zls] ... file loaded complete").
// 그대로 두면 프로토콜 스트림이 깨지므로, cout을 stderr로 돌리고
// 원래 stdout은 프로토콜 전용으로 따로 쥔다.
class OutputChannels
{
public:
    OutputChannels()
        : mProtocol(std::cout.rdbuf())
    {
        mSavedCout = std::cout.rdbuf(std::cerr.rdbuf());
    }

    ~OutputChannels()
    {
        std::cout.rdbuf(mSavedCout);
    }

    void Send(const json& message)
    {
        std::lock_guard<std::mutex> lock(mMutex);
        mProtocol << message.dump() << "\n";
        mProtocol.flush();
    }

private:
    std::ostream    mProtocol;
    std::streambuf* mSavedCout = nullptr;
    std::mutex      mMutex;
};

void LogLine(const std::string& msg)
{
    std::cerr << "[zelusSandBoxd] " << msg << std::endl;
}

// ── 파라미터 매핑 ───────────────────────────────────────────
//
// 표로 관리한다. MainGUI가 "solver type"과 "Collision solver"를 같은
// solverType 필드에 쓰는 버그(PROJECT_ANALYSIS.md §9 ①)를 그대로 옮기지
// 않으려면, 이름과 필드가 한 곳에서 1:1로 보여야 한다.
struct ParamBinding
{
    const char* name;
    enum class Kind { Float, Int, Bool } kind;
    std::size_t offsetHint;   // 가독성용. 실제 접근은 아래 람다가 한다.
};

json ReadParams(const ztSceneDataSimulationParams& p)
{
    return json{
        { "timeStep",              p.timeStep },
        { "subStep",               p.subStep },
        { "drapingTime",           p.drapingTime },
        { "gravityY",              p.gravity.y },
        { "groundPlane",           p.groundPlane },
        { "groundFriction",        p.groundFriction },
        { "groundMargin",          p.groundMargin },
        { "useWind",               p.useWind },
        { "windMagnitude",         p.windMagnitude },
        { "solverType",            p.solverType },
        { "preconditioner",        p.preconditioner },
        { "nonlinearIterations",   p.nonlinearIterations },
        { "maxSolverIterations",   p.maxSolverIterations },
        { "solverTolerance",       p.solverTolerance },
        { "useIEQS",               p.useIEQS },
        { "staticCouplingMethod",  p.staticCouplingMethod },
        { "dynamicCouplingMethod", p.dynamicCouplingMethod },
        { "dynCouplingStiffness",  p.dynCouplingStiffness },
        { "dynCouplingDamping",    p.dynCouplingDamping },
        { "untanglingStiffness",   p.untanglingStiffness },
        { "untanglingDamping",     p.untanglingDamping },
        { "meshingEdgeLength",     p.meshingEdgeLength },
    };
}

// 알려진 키만 반영하고, 반영한 키 목록을 돌려준다.
// 모르는 키는 조용히 무시하지 않고 unknown으로 보고한다 — 웹에서 파라미터
// 이름을 잘못 보냈을 때 조용히 먹히면 디버깅이 지옥이 된다.
void ApplyParams(ztSceneDataSimulationParams& p, const json& in,
                 std::vector<std::string>& applied,
                 std::vector<std::string>& unknown)
{
    for (auto it = in.begin(); it != in.end(); ++it)
    {
        const std::string& k = it.key();
        const json&        v = it.value();

        auto F = [&](float& dst)  { dst = v.get<float>(); applied.push_back(k); };
        auto I = [&](int& dst)    { dst = v.get<int>();   applied.push_back(k); };
        auto B = [&](bool& dst)   { dst = v.get<bool>();  applied.push_back(k); };

        if      (k == "timeStep")              F(p.timeStep);
        else if (k == "subStep")               I(p.subStep);
        else if (k == "drapingTime")           F(p.drapingTime);
        else if (k == "gravityY")              F(p.gravity.y);
        else if (k == "groundPlane")           B(p.groundPlane);
        else if (k == "groundFriction")        F(p.groundFriction);
        else if (k == "groundMargin")          F(p.groundMargin);
        else if (k == "useWind")               B(p.useWind);
        else if (k == "windMagnitude")         F(p.windMagnitude);
        else if (k == "solverType")            I(p.solverType);
        else if (k == "preconditioner")        I(p.preconditioner);
        else if (k == "nonlinearIterations")   I(p.nonlinearIterations);
        else if (k == "maxSolverIterations")   I(p.maxSolverIterations);
        else if (k == "solverTolerance")       F(p.solverTolerance);
        else if (k == "useIEQS")               B(p.useIEQS);
        else if (k == "staticCouplingMethod")  I(p.staticCouplingMethod);
        else if (k == "dynamicCouplingMethod") I(p.dynamicCouplingMethod);
        else if (k == "dynCouplingStiffness")  F(p.dynCouplingStiffness);
        else if (k == "dynCouplingDamping")    F(p.dynCouplingDamping);
        else if (k == "untanglingStiffness")   F(p.untanglingStiffness);
        else if (k == "untanglingDamping")     F(p.untanglingDamping);
        else if (k == "meshingEdgeLength")     F(p.meshingEdgeLength);
        else                                   unknown.push_back(k);
    }
}

// ── 메시 접근 ───────────────────────────────────────────────

ztSceneQueryInterface* QueryInterface(ZestManager& manager)
{
    ztScene* scene = manager.GetSceneManager()->GetCurrentScene();
    return scene ? scene->GetQueryInterface() : nullptr;
}

// base64 — 정점 버퍼를 JSON에 실어 보내기 위한 임시 수단이다.
// 프레임당 수십 KB라 v1 검증에는 충분하지만, 실서비스에서는 바이너리
// 채널로 옮겨야 한다 (JSON+base64는 약 33% 부풀고 파싱 비용도 든다).
std::string Base64(const void* data, std::size_t bytes)
{
    static const char* T =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    const unsigned char* p = static_cast<const unsigned char*>(data);
    std::string out;
    out.reserve(((bytes + 2) / 3) * 4);

    std::size_t i = 0;
    for (; i + 2 < bytes; i += 3)
    {
        const unsigned v = (p[i] << 16) | (p[i + 1] << 8) | p[i + 2];
        out += T[(v >> 18) & 0x3F];
        out += T[(v >> 12) & 0x3F];
        out += T[(v >>  6) & 0x3F];
        out += T[ v        & 0x3F];
    }

    if (i < bytes)
    {
        unsigned v = p[i] << 16;
        const bool two = (i + 1 < bytes);
        if (two) v |= p[i + 1] << 8;

        out += T[(v >> 18) & 0x3F];
        out += T[(v >> 12) & 0x3F];
        out += two ? T[(v >> 6) & 0x3F] : '=';
        out += '=';
    }

    return out;
}

json MeshInfo(ZestManager& manager, void* listener)
{
    json patterns = json::array();

    ztSceneQueryInterface* qi = QueryInterface(manager);
    if (!qi)
    {
        return json{ { "patterns", patterns } };
    }

    std::size_t totalV = 0, totalT = 0;

    for (const auto& entry : qi->GetClothPatterns())
    {
        const ztDesignClothPattern* pattern = entry.second.get();
        if (!pattern) continue;

        const ztChangeTracker<ztDesignTriMesh>& tracker = pattern->GetSimulationOutputMesh();
        const bool changed = tracker.QueryForUpdate(listener);
        const ztDesignTriMesh& mesh = tracker.Read();

        totalV += mesh.vertices.size();
        totalT += mesh.indices.size() / 3;

        patterns.push_back(json{
            { "uuid",      ztUuidSaver::Convert(entry.first) },
            { "vertices",  mesh.vertices.size() },
            { "triangles", mesh.indices.size() / 3 },
            { "changed",   changed },
        });
    }

    return json{
        { "patterns",       patterns },
        { "totalVertices",  totalV },
        { "totalTriangles", totalT },
    };
}

// 토폴로지는 프레임 간 고정이므로 최초 1회만 보내면 된다.
// 프레임마다 필요한 건 positions뿐이다.
//
// 패턴 변환(transform)도 같은 이유로 topology 쪽에 붙는다 — 실측상 프레임마다
// 바뀌지 않는다. 근거와 그 가정이 깨졌을 때의 증상은 아래 해당 블록의 주석에 있다.
//
// meshData 응답과 구독 중 frame 이벤트의 mesh 필드가 **같은 함수**를 쓴다.
// zsVector3 재포장(아래)이 두 곳에 복사되면 언젠가 갈라지고, 그때 어긋난
// 쪽은 화면이 깨져야만 드러난다.
json MeshData(ZestManager& manager, bool includeTopology)
{
    json patterns = json::array();

    ztSceneQueryInterface* qi = QueryInterface(manager);
    if (!qi)
    {
        // 씬이 없어도 모양은 같아야 한다. 호출자(응답 / 프레임 이벤트)가
        // topology 키의 유무로 분기하게 만들면 디코더가 두 갈래가 된다.
        return json{ { "patterns", patterns }, { "topology", includeTopology } };
    }

    for (const auto& entry : qi->GetClothPatterns())
    {
        const ztDesignClothPattern* pattern = entry.second.get();
        if (!pattern) continue;

        const ztDesignTriMesh& mesh = pattern->GetSimulationOutputMesh().Read();

        json p{
            { "uuid",      ztUuidSaver::Convert(entry.first) },
            { "vertices",  mesh.vertices.size() },
            { "triangles", mesh.indices.size() / 3 },
        };

        if (mesh.vertices.size() > 0)
        {
            // zsVector3는 SIMD 정렬 때문에 16바이트다 (float 3개 = 12가 아니다).
            // 그대로 보내면 프론트에서 4바이트씩 어긋나 형체가 깨진다.
            // three.js의 BufferAttribute는 촘촘한 배열을 기대하므로 여기서
            // float3로 다시 포장한다. 전송량도 25% 준다.
            const std::size_t n = mesh.vertices.size();

            std::vector<float> tight;
            tight.reserve(n * 3);

            for (std::size_t i = 0; i < n; ++i)
            {
                const ZELUS::zsVector3& v = mesh.vertices[i];
                tight.push_back(v.x);
                tight.push_back(v.y);
                tight.push_back(v.z);
            }

            p["positions"]      = Base64(tight.data(), tight.size() * sizeof(float));
            p["positionStride"] = 12;   // 재포장 후
        }

        if (includeTopology)
        {
            // ── 패턴 → 월드 변환 (ISSUE-011) ────────────────────────
            //
            // GetSimulationOutputMesh()의 정점은 **패턴 로컬 좌표**다.
            // 월드 위치는 이 변환을 곱해야 정해진다 — 회사 저장소의
            // ztDesignClothPattern::GetAABB()가 경계 상자를 구할 때
            // transform * vertices[i]를 적용하는 것이 그 근거다.
            //
            // 출처는 glTF 익스포터와 **동일**하다: 익스포터도 옷 패턴 노드마다
            // GetTransformIn3D()를 노드 변환으로 쓴다
            // (zwGltfExporterImpl.cpp:392 → :1915-1921). 따라서 여기서 나가는
            // 값과 익스포트 산출물의 노드 변환은 같아야 하고, 어긋나면
            // 둘 중 하나가 잘못된 출처를 보고 있다는 뜻이다.
            //
            // 단위는 정점과 같은 cm다(엔진 전역 단위). 익스포터가 cm→m
            // 스케일 0.01을 거는 곳은 glTF **루트 노드**이지 이 변환이 아니다.
            //
            // ★ 왜 topology:true일 때만 싣는가 — 프레임마다 바뀌지 않기 때문이다.
            //   근거는 실측이다: sample.zls를 같은 세션에서 시뮬 전과 249프레임
            //   후에 익스포트해 노드 변환 28개를 비교했고 전부 비트 단위로
            //   동일했다(정점은 확실히 움직였다 — 파일 크기가 달라졌다).
            //   **이는 씬 두 개를 249프레임 관측한 결과이지 엔진이 보장하는
            //   불변식이 아니다.** 시뮬 중 패턴 변환을 움직이는 기능(3D
            //   기즈모 이동/회전, SetTransform 계열 라이브 에디팅)이 붙으면
            //   이 가정이 깨진다.
            //
            //   깨졌을 때 어떻게 드러나는가: 클라이언트는 최초 1회 받은 변환을
            //   계속 쓰므로, **정점은 정상적으로 흔들리는데 옷 전체가 있어야 할
            //   자리에서 벗어난 채 고정된다.** 크래시도 에러도 나지 않고 화면만
            //   틀리므로 "솔버가 이상하다"로 오진하기 쉽다. 그때 할 일은 이
            //   블록을 includeTopology 밖으로 꺼내는 것이다(프레임당 +40바이트).
            const ZELUS::zsTransform  xform = pattern->GetTransformIn3D();
            const ZELUS::zsVector3&   t     = xform.GetTranslation();
            const ZELUS::zsQuaternion& r    = xform.GetRotation();
            const ZELUS::zsVector3&   s     = xform.GetScale();

            // TRS로 보낸다(4×4 행렬이 아니라). 익스포터가 glTF 노드에 쓰는 것과
            // 같은 분해이고, three.js의 position/quaternion/scale에 그대로
            // 꽂힌다. 쿼터니언은 glTF와 같은 [x, y, z, w] 순서다.
            //
            // 정점 버퍼와 달리 base64로 싸지 않는다 — 패턴당 10개 숫자뿐이라
            // 압축 이득이 없고, 사람이 읽을 수 있어야 익스포트 산출물과
            // 대조하기 쉽다.
            p["transform"] = json{
                { "translation", { t.x, t.y, t.z } },
                { "rotation",    { r.GetX(), r.GetY(), r.GetZ(), r.GetW() } },
                { "scale",       { s.x, s.y, s.z } },
            };

            if (mesh.indices.size() > 0)
            {
                p["indices"] = Base64(&mesh.indices[0],
                                      mesh.indices.size() * sizeof(ZELUS::zsInt));
                p["indexStride"] = static_cast<int>(sizeof(ZELUS::zsInt));
            }
            if (mesh.uvs.size() > 0)
            {
                p["uvs"] = Base64(&mesh.uvs[0],
                                  mesh.uvs.size() * sizeof(ZELUS::zsVector2));
            }
        }

        patterns.push_back(std::move(p));
    }

    return json{ { "patterns", patterns }, { "topology", includeTopology } };
}

const char* ModeName(ZestManager::AnimationMode m)
{
    switch (m)
    {
    case ZestManager::AnimationMode::PLAY:  return "play";
    case ZestManager::AnimationMode::PAUSE: return "pause";
    case ZestManager::AnimationMode::RESET: return "reset";
    case ZestManager::AnimationMode::STEP:  return "step";
    }
    return "unknown";
}

// ── stdin 리더 ──────────────────────────────────────────────
//
// 별도 스레드에서 읽는다. 메인 루프가 getline에 막히면 프레임 이벤트를
// 내보낼 수 없기 때문이다.
class LineReader
{
public:
    explicit LineReader(std::atomic<bool>& eof)
        : mEof(eof)
        , mThread([this] { Run(); })
    {
    }

    ~LineReader()
    {
        mThread.detach();   // stdin이 닫힐 때까지 블록될 수 있다
    }

    bool TryPop(std::string& out)
    {
        std::lock_guard<std::mutex> lock(mMutex);
        if (mQueue.empty()) return false;
        out = std::move(mQueue.front());
        mQueue.pop_front();
        return true;
    }

private:
    void Run()
    {
        std::string line;
        while (std::getline(std::cin, line))
        {
            std::lock_guard<std::mutex> lock(mMutex);
            mQueue.push_back(line);
        }
        mEof.store(true);
    }

    std::atomic<bool>&      mEof;
    std::mutex              mMutex;
    std::deque<std::string> mQueue;
    std::thread             mThread;
};

} // namespace

int RunProtocolLoop(ZestManager& manager)
{
    OutputChannels out;

    std::atomic<int>  curFrame{ -1 };
    std::atomic<int>  maxFrame{ -1 };
    std::atomic<bool> stdinClosed{ false };

    manager.SetSimulationCallBackFunctions(
        [&](int frame) {
            curFrame.store(frame);
            int prev = maxFrame.load();
            while (frame > prev && !maxFrame.compare_exchange_weak(prev, frame)) {}
        },
        [&](const std::string& message) {
            out.Send(json{ { "event", "engineMessage" }, { "message", message } });
        });

    out.Send(json{
        { "event",   "ready" },
        { "session", "single" },     // 세션 = 프로세스 1개
        { "protocol", 1 },
    });

    LineReader reader(stdinClosed);

    int  listenerToken = 0;
    int  lastEmitted   = -1;
    bool running       = true;
    int  exitCode      = 0;

    // 프레임 이벤트에 메시를 실어 보낼지.
    //
    // 씬 상태가 아니라 클라이언트의 전송 취향이므로 load/clear/reset에서
    // 건드리지 않는다. 프로세스(=세션) 수명 내내 유지된다.
    bool subscribed = false;

    while (running)
    {
        // 1) 프레임 진행 이벤트
        const int f = maxFrame.load();
        if (f != lastEmitted)
        {
            lastEmitted = f;

            json ev{ { "event", "frame" }, { "frame", f } };

            // 구독 중이면 프레임마다 왕복(meshData 요청 → 응답)을 없앤다.
            // 추출은 이 스레드에서 동기로 한다. 실측 0.03~0.10ms에 base64
            // 인코딩을 더해도 프레임 간격(~40ms) 대비 미미하고, 비동기로
            // 빼면 시뮬 스레드가 앞서 나가 어느 프레임의 정점인지 모르게
            // 된다. 병목은 추출이 아니라 stdout 대역폭이다.
            //
            // 토폴로지(indices/uvs)는 싣지 않는다 — 프레임 간 고정이라
            // 클라이언트가 meshData{topology:true}로 1회만 받으면 된다.
            // 매 프레임 실으면 대역폭이 몇 배가 된다.
            if (subscribed)
            {
                ev["mesh"] = MeshData(manager, /*includeTopology=*/false);
            }

            out.Send(ev);
        }

        // 2) 요청 처리
        std::string line;
        if (!reader.TryPop(line))
        {
            if (stdinClosed.load())
            {
                LogLine("stdin이 닫혔습니다. 종료합니다.");
                break;
            }
            manager.UpdateFrame();
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
            continue;
        }

        if (line.empty()) continue;

        json req;
        try
        {
            req = json::parse(line);
        }
        catch (const std::exception& e)
        {
            out.Send(json{ { "ok", false }, { "error", std::string("잘못된 JSON: ") + e.what() } });
            continue;
        }

        const json id = req.contains("id") ? req["id"] : json(nullptr);
        const std::string op = req.value("op", "");

        json result;
        bool ok = true;
        std::string error;

        try
        {
            if (op == "ping")
            {
                result = json{ { "pong", true } };
            }
            else if (op == "version")
            {
                // 씬 로드도 Initialize()도 필요 없다. 링크된 엔진 자체의 버전이다.
                result = json{
                    { "zelus", ZELUS::GetZelusFullVersionString() },
                    { "lumia", ZELUS::GetLumiaFullVersionString() },
                };
            }
            else if (op == "init")
            {
                // 반드시 필요하다. 건너뛰면 LoadZls가 죽는다.
                manager.Initialize();
                result = json{ { "initialized", true } };
            }
            else if (op == "load")
            {
                const std::string path = req.value("path", "");
                if (path.empty())
                {
                    ok = false; error = "path가 필요합니다";
                }
                else
                {
                    maxFrame.store(-1);
                    curFrame.store(-1);
                    lastEmitted = -1;
                    ok = manager.LoadZls(ztString(path));
                    if (!ok) error = "zls 로드 실패";
                    else     result = json{ { "loaded", true }, { "path", path } };
                }
            }
            else if (op == "clear")
            {
                manager.Clear();
                maxFrame.store(-1);
                curFrame.store(-1);
                lastEmitted = -1;
                result = json{ { "cleared", true } };
            }
            else if (op == "start")
            {
                manager.SetAnimationMode(ZestManager::AnimationMode::PLAY);
                result = json{ { "mode", "play" } };
            }
            else if (op == "pause")
            {
                manager.SetAnimationMode(ZestManager::AnimationMode::PAUSE);
                result = json{ { "mode", "pause" } };
            }
            else if (op == "reset")
            {
                manager.SetAnimationMode(ZestManager::AnimationMode::RESET);
                maxFrame.store(-1);
                lastEmitted = -1;
                result = json{ { "mode", "reset" } };
            }
            else if (op == "step")
            {
                manager.SetAnimationMode(ZestManager::AnimationMode::STEP);
                result = json{ { "mode", "step" } };
            }
            else if (op == "subscribe")
            {
                // 이후 frame 이벤트에 mesh(= meshData{topology:false}와 같은
                // 모양)가 함께 실린다. 이미 시뮬 중이면 다음 프레임부터다.
                subscribed = true;
                result = json{ { "subscribed", true } };
            }
            else if (op == "unsubscribe")
            {
                subscribed = false;
                result = json{ { "subscribed", false } };
            }
            else if (op == "status")
            {
                result = json{
                    { "loaded",       manager.IsLoadedZls() },
                    { "simInitialized", manager.IsSimulationInitialized() },
                    { "mode",         ModeName(manager.GetAnimationMode()) },
                    { "frame",        curFrame.load() },
                    { "maxFrame",     maxFrame.load() },
                    { "subscribed",   subscribed },
                };
            }
            else if (op == "getParams")
            {
                result = ReadParams(manager.GetSimulationParam());
            }
            else if (op == "setParams")
            {
                if (!manager.IsLoadedZls())
                {
                    ok = false; error = "씬이 로드되지 않았습니다";
                }
                else
                {
                    std::vector<std::string> applied, unknown;
                    ApplyParams(manager.GetSimulationParam(),
                                req.value("params", json::object()), applied, unknown);

                    // 시뮬 중이면 다음 프레임에 물성을 다시 적용시킨다.
                    manager.UpdateLiveEditing(ztLiveEditType::UpdateClothPhysicsParameters);

                    result = json{ { "applied", applied }, { "unknown", unknown } };
                }
            }
            else if (op == "meshInfo")
            {
                result = MeshInfo(manager, &listenerToken);
            }
            else if (op == "meshData")
            {
                result = MeshData(manager, req.value("topology", false));
            }
            else if (op == "export")
            {
                const std::string path = req.value("path", "");
                const std::string fmt  = req.value("format", "gltf");

                if (path.empty())
                {
                    ok = false; error = "path가 필요합니다";
                }
                else if (fmt == "zbin")
                {
                    ok = manager.ExportZbin(ztString(path));
                    if (!ok) error = "zbin 익스포트 실패";
                    else     result = json{ { "path", path }, { "format", "zbin" } };
                }
                else
                {
                    manager.ExportGltf(ztString(path));
                    result = json{ { "path", path }, { "format", "gltf" } };
                }
            }
            else if (op == "quit")
            {
                running = true;   // 응답을 보낸 뒤 빠져나간다
                result = json{ { "bye", true } };
            }
            else
            {
                ok = false;
                error = "알 수 없는 op: " + op;
            }
        }
        catch (const std::exception& e)
        {
            ok = false;
            error = std::string("예외: ") + e.what();
        }
        catch (...)
        {
            ok = false;
            error = "알 수 없는 예외";
        }

        json response{ { "ok", ok } };
        if (!id.is_null()) response["id"] = id;
        if (ok)            response["result"] = std::move(result);
        else               response["error"]  = error;

        out.Send(response);

        if (op == "quit")
        {
            break;
        }
    }

    return exitCode;
}
