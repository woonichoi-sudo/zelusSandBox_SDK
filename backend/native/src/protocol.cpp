#include "protocol.h"

#include <ZestManager.h>

#include <zsTransform.h>   // 패턴 → 월드 변환 (MeshData)

// 서피스 이름이 std::wstring 이라 UTF-8 변환에 WideCharToMultiByte 가 필요하다.
// NOMINMAX 가 없으면 windows.h 의 min/max 매크로가 std::min/max 를 깨뜨린다.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <ztAvatarCommon.h>        // ztAvatarBodyParam·ztAvatarMeasurePart + 이름 함수
#include <ztDesignSurface.h>       // ztDesignSurfaceData::name (옷 사이즈)
#include <ztDesign2DTransform.h>   // 서피스 2D 배치 (MeshData의 transform2d)
#include <ztDesignAvatar.h>        // ztDesignAvatarData·ztDesignZetaData (체형)
#include <ztDesignBoundaryCurve.h> // ztBoundaryType (디자인 2D 커브 종류)
#include <ztDesignClothPattern.h>
#include <ztDesignSeam.h>          // ztDesignSeamData (봉제선)
#include <ztDesignStitch.h>        // ztDesignStitchData (스티치)
#include <ztGeomCubicBezierCurve.h> // 커브 세분·구간 잘라내기
#include <ztDesignMaterial.h>      // 패턴 색 (MeshData의 material)
#include <ztDesignSurface.h>       // GetTransform() — 전방선언만으론 부족하다
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

// ── 아바타 체형 (L-3a) ──────────────────────────────────────
//
// 데스크톱 앱에는 이 UI가 없다. 엔진에는 완비돼 있고 노출만 안 돼 있었다.
//
// ── 경로를 여기로 정한 이유 ─────────────────────────────────
// `ztAvatarManager` 에 SetBodyParam/SetMeasurementParam/UpdateBodyParams 가
// 전부 있지만 **그 객체를 얻는 공개 경로가 SDK 헤더에 없다** — `ztDesignAvatar`
// 는 메시·본·측정커브만 노출하고 매니저를 안 준다. 대신
// `ztSceneQueryInterface` 가 데이터 왕복을 열어 둔다:
//
//     GetCurrentAvatar() → GetAvatarData(uuid) → 복사·수정 → UpdateAvatar(uuid, 수정본)
//
// 체형은 `ztDesignAvatarData::zetaData` 안에 있다(`ztDesignZetaData`):
//   bodyParams               float 29개 — ztAvatarBodyParam 순서
//   measurementExpectedValues 목표 치수 25개 (value + isLock)
//   measurementRealValues     실측 치수 25개
//
// ⚠️ **`UpdateAvatar` 가 체형을 실제로 반영하는지는 헤더로 알 수 없다.**
//    내부에서 `UpdateBodyParams()` 를 부르는지 여부가 이 단위의 유일한
//    미지수이고, 돌려 봐야 답이 나온다. 그래서 아래 `setAvatarBody` 는
//    **쓰고 나서 다시 읽어** 응답에 실어 준다 — 값이 안 붙었으면 그 사실이
//    응답에 그대로 드러난다(요청한 값을 메아리치면 거짓말이 된다).

/** 키는 엔진이 정한 이름을 그대로 쓴다 — 우리가 발명하면 두 이름이 갈라진다 */
json ReadAvatarBody(ZestManager& manager)
{
    ztSceneQueryInterface* qi = QueryInterface(manager);
    if (!qi) return json{ { "hasAvatar", false } };

    const ztUuid uuid = qi->GetCurrentAvatar();
    const ztDesignAvatarData* data = qi->GetAvatarData(uuid);
    if (!data) return json{ { "hasAvatar", false } };

    const ztDesignZetaData& z = data->zetaData;

    json params = json::object();
    for (int i = 0; i < (int)ztAvatarBodyParam::Count; ++i)
    {
        params[ztAvatarBodyParamUtils::GetParamName((ztAvatarBodyParam)i)] = z.bodyParams[i];
    }

    json measures = json::object();
    for (int i = 0; i < (int)ztAvatarMeasurePart::Count; ++i)
    {
        const auto& want = z.measurementExpectedValues[i];
        json m = json{
            { "real",   z.measurementRealValues[i] },
            { "locked", want.isLock },
        };
        // FLT_MIN 이 "목표 없음" 의 표시다(MeasurementInfo 의 기본값). 그대로
        // 실으면 받는 쪽이 1.17e-38 을 치수로 읽는다.
        if (want.value != FLT_MIN) m["expected"] = want.value;
        // ⚠️ 이름 함수가 **두 구조체로 갈려 있다** — 체형은 ztAvatarBodyParamUtils,
        //    치수는 ztAvatarMeasureUtils 다. 한쪽에 다 있을 것으로 짐작하면 컴파일에서 걸린다.
        measures[ztAvatarMeasureUtils::GetMeasurePartName((ztAvatarMeasurePart)i)] = m;
    }

    return json{
        { "hasAvatar",    true },
        { "uuid",         uuid.GetString() },
        { "bodyParams",   params },
        { "measurements", measures },
    };
}

/**
 * 체형 값을 쓴다. `applied` / `unknown` 은 `setParams` 와 같은 규약이다.
 *
 * ⚠️ **모르는 키를 조용히 넘기지 않는다.** ISSUE-014 가 정확히 그 반대 상황이었다
 *    — 워커가 안 먹는 필드에도 "적용됨" 이라고 답해서, 화면은 값을 바꿨다고
 *    믿는데 시뮬은 그대로였다.
 */
bool WriteAvatarBody(ZestManager& manager, const json& body,
                     std::vector<std::string>& applied,
                     std::vector<std::string>& unknown)
{
    ztSceneQueryInterface* qi = QueryInterface(manager);
    if (!qi) return false;

    const ztUuid uuid = qi->GetCurrentAvatar();
    const ztDesignAvatarData* cur = qi->GetAvatarData(uuid);
    if (!cur) return false;

    // 값 복사본을 만들어 고친다. 원본은 const 이고, 부분 수정본을 넘기면
    // 나머지 필드(포즈·텍스처·액세서리)가 기본값으로 덮인다.
    ztDesignAvatarData next = *cur;

    for (auto it = body.begin(); it != body.end(); ++it)
    {
        if (!it.value().is_number()) { unknown.push_back(it.key()); continue; }

        int index = -1;
        for (int i = 0; i < (int)ztAvatarBodyParam::Count; ++i)
        {
            if (it.key() == ztAvatarBodyParamUtils::GetParamName((ztAvatarBodyParam)i))
            {
                index = i;
                break;
            }
        }

        if (index < 0) { unknown.push_back(it.key()); continue; }

        next.zetaData.bodyParams[index] = it.value().get<float>();
        applied.push_back(it.key());
    }

    if (!applied.empty()) qi->UpdateAvatar(uuid, next);
    return true;
}

// ── 옷 사이즈 (L-3b) ────────────────────────────────────────
//
// 데스크톱의 `Pattern` 패널에 있는 Width/Height 가 이것이다
// (`MainGUI.cpp`). 아바타 체형과 달리 **엔진까지 안 내려가도 된다** —
// `ZestManager` 가 셋을 다 갖고 있다:
//
//   GetSurfaceInfos()            서피스 목록 (map<ztUuid, unique_ptr<ztDesignSurface>>)
//   GetSurfaceSize(uuid)         현재 크기 (zsVector2, cm)
//   UpdateSizeSurface(uuid, 크기) 쓰기
//
// ⚠️ **uuid 문자열을 되파싱하지 않는다.** `ztUuidSaver::Convert(string)` 이
//    있지만 `ztUuid::GetString()` 과 같은 형식이라는 보장이 헤더에 없다.
//    형식이 어긋나면 "없는 서피스" 로 조용히 실패하는데, 그 증상이 화면에서는
//    "크기를 바꿨는데 아무 일도 안 일어난다" 로만 보인다. 목록을 돌며
//    `GetString()` 을 비교하면 그 위험이 원리적으로 없다 — 서피스 24개짜리
//    선형 탐색이라 비용도 없다.

/** 서피스 이름이 `std::wstring` 이라 JSON 에 실으려면 UTF-8 로 바꿔야 한다 */
std::string Utf8(const std::wstring& w)
{
    if (w.empty()) return {};
    const int need = ::WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(),
                                           nullptr, 0, nullptr, nullptr);
    if (need <= 0) return {};
    std::string out((std::size_t)need, '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), out.data(), need, nullptr, nullptr);
    return out;
}

json ReadSurfaces(ZestManager& manager)
{
    json items = json::array();

    for (const auto& entry : manager.GetSurfaceInfos())
    {
        const ztDesignSurface* surface = entry.second.get();
        if (!surface) continue;

        const zsVector2 size = manager.GetSurfaceSize(entry.first);
        items.push_back(json{
            { "uuid",   entry.first.GetString() },
            { "name",   Utf8(surface->GetData().name) },
            { "width",  size.x },
            { "height", size.y },
        });
    }

    return json{ { "surfaces", items } };
}

/**
 * 서피스 하나의 크기를 바꾼다.
 *
 * 폭·높이 중 **하나만 줘도 된다** — 안 준 쪽은 지금 값을 그대로 쓴다.
 * 데스크톱 패널이 두 칸을 따로 편집하므로 같은 감각을 유지한다. 둘 다
 * 요구하면 화면이 항상 두 값을 들고 있어야 하고, 그러면 한쪽만 고치려던
 * 사용자가 다른 쪽을 낡은 값으로 덮어쓰게 된다.
 *
 * @return 0 = 성공, 1 = 그런 uuid 없음
 */
int WriteSurfaceSize(ZestManager& manager, const std::string& uuid,
                     const json& req)
{
    for (const auto& entry : manager.GetSurfaceInfos())
    {
        if (entry.first.GetString() != uuid) continue;

        const zsVector2 cur = manager.GetSurfaceSize(entry.first);
        const float w = req.contains("width")  && req["width"].is_number()
                        ? req["width"].get<float>()  : cur.x;
        const float h = req.contains("height") && req["height"].is_number()
                        ? req["height"].get<float>() : cur.y;

        manager.UpdateSizeSurface(entry.first, zsVector2(w, h));
        return 0;
    }
    return 1;
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

// ── 디자인 기반 2D (D2-a) ───────────────────────────────────
//
// 지금 가운데 칸의 재단 도면은 **삼각형 메시뿐**이다(`uvs` + `transform2d`).
// 데스크톱 2D 뷰는 그 위에 외곽 커브·제어점·봉제선·스티치를 얹는다 — 즉
// 우리에게 없는 것은 렌더링이 아니라 **데이터**다.
//
// ── ★ 좌표계: `atWorld` 가 전치 함정을 통째로 없앤다 ─────────
//
// `.zls` 실측: 제어점 909개의 범위가 66.6×103.5cm 인데 도면 전체는
// 144.2×175.4cm 다(L-2a). **안 맞는다 = 각자 원점 근처에 겹쳐 있다** —
// `uvs` 가 그랬던 #15 와 같은 상황이다. 그때는 워커가 `transform2d` 를
// 직접 실어 보내 화면에서 곱했고, 그 과정에서 **가장 위험했던 것이 전치**
// 였다(`zsMatrix33` 은 저장이 열 우선인데 `GetElement(i,j)` 가 `e[j][i]`
// 라 (행,열) 접근이다. 전치해 읽어도 그럴듯한 도면이 나온다).
//
// 여기서는 그 위험을 **애초에 만들지 않는다.** `CreateGeomCubicBezierCurve`
// 가 `atWorld` 플래그를 받아 엔진이 직접 배치까지 끝낸 커브를 준다. 우리는
// 행렬을 만지지 않으므로 전치가 성립할 자리가 없다.
// ⚠️ 다만 **그 플래그가 정말 배치를 적용하는지는 헤더로 알 수 없다.**
//    프로브가 좌표 범위를 재서 가른다 — 로컬이면 66×103, 월드면 144×175
//    부근이어야 한다. 이 단위의 유일한 미지수다.
//
// ── 왜 폴리라인으로 내리는가 ────────────────────────────────
//
// 제어점 4개를 그대로 보내고 화면에서 베지어를 풀 수도 있다. 그러면
// **세분 규칙이 두 곳에 생긴다** — 엔진의 `Tessellate` 와 우리 것. 길이가
// 어긋나면 도면과 3D 가 미세하게 다른 모양이 되고, 그 차이는 "곡선이 좀
// 각져 보인다" 로만 보여서 원인을 못 찾는다. 엔진이 푼 결과를 그대로 쓴다.
// 제어점(`cp`)은 **그리기용으로 따로** 싣는다 — 이미지의 원들이 그것이다.
//
// ⚠️ `.zls` 에 `FLT_MAX` 센티넬 제어점이 2개 있었다. 그대로 그리면 도면이
//    무한대로 늘어나 화면이 비어 보인다. 걷어낸다.

/** 커브 하나를 월드 폴리라인 + 제어점으로 편다. 비었으면 실리지 않는다 */
json TessellateCurve(ztSceneQueryInterface* qi, const ztUuid& curveUuid,
                     const char* kind)
{
    // atWorld = true — 위 머리말 참고. 배치를 엔진이 끝내 준다
    ztGeomCubicBezierCurve geom = qi->CreateGeomCubicBezierCurve(curveUuid, true);

    const auto finite = [](const ztDesign2DPoint& p) {
        return p.x > -1e30f && p.x < 1e30f && p.y > -1e30f && p.y < 1e30f;
    };

    json cp = json::array();
    for (const ztDesign2DPoint& p : geom.CP())
    {
        if (!finite(p)) return json();   // 센티넬이 낀 커브는 통째로 버린다
        cp.push_back(p.x);
        cp.push_back(p.y);
    }

    // 직선은 세분이 무의미하다 — 양 끝점이면 충분하고, 280개 커브에서
    // 이 구분이 페이로드를 눈에 띄게 줄인다.
    std::vector<ztDesign2DPoint> tess;
    if (geom.IsLine())
    {
        tess.push_back(geom.CP()[0]);
        tess.push_back(geom.CP()[3]);
    }
    else
    {
        // 최소 정점으로 편평도를 맞춘다 — 균등 분할보다 점이 적고 더 매끈하다
        geom.SmartTessellation(tess);
    }

    json pts = json::array();
    for (const ztDesign2DPoint& p : tess)
    {
        if (!finite(p)) return json();
        pts.push_back(p.x);
        pts.push_back(p.y);
    }
    if (pts.size() < 4) return json();   // 점 하나짜리는 그릴 것이 없다

    return json{
        { "uuid",   curveUuid.GetString() },
        { "kind",   kind },
        { "isLine", geom.IsLine() },
        { "cp",     cp },
        { "pts",    pts },
    };
}

json ReadDesign2D(ZestManager& manager)
{
    json surfaces = json::array();
    json seams    = json::array();
    json stitches = json::array();

    ztSceneQueryInterface* qi = QueryInterface(manager);
    if (!qi) return json{ { "surfaces", surfaces }, { "seams", seams },
                          { "stitches", stitches } };

    // 어느 종류를 어떤 이름으로 내릴지의 정본. 화면이 색을 여기에 건다.
    // `Grain`(식서 방향)·`SeamAllowance`(시접)도 열려 있지만 이 씬에 있는지
    // 안 쟀다 — 목록에 넣어 두면 프로브가 개수로 답한다.
    struct Kind { ztBoundaryType type; const char* name; };
    static const Kind kinds[] = {
        { ztBoundaryType::Outer,         "outer"         },
        { ztBoundaryType::Inner,         "inner"         },
        { ztBoundaryType::Hole,          "hole"          },
        { ztBoundaryType::Sewline,       "sewline"       },
        { ztBoundaryType::Grain,         "grain"         },
        { ztBoundaryType::SeamAllowance, "seamAllowance" },
    };

    for (const auto& entry : manager.GetSurfaceInfos())
    {
        const ztDesignSurface* surface = entry.second.get();
        if (!surface) continue;

        json curves = json::array();
        for (const Kind& k : kinds)
        {
            for (const ztUuid& c : qi->GetCurvesInSurface(entry.first, k.type))
            {
                json one = TessellateCurve(qi, c, k.name);
                if (!one.is_null()) curves.push_back(std::move(one));
            }
        }

        surfaces.push_back(json{
            { "uuid",   entry.first.GetString() },
            { "name",   Utf8(surface->GetData().name) },
            { "curves", curves },
        });
    }

    // ── 봉제선 ──────────────────────────────────────────────
    //
    // `.zls` 구조 그대로다: 측 2개 × 그룹 × 파트, 파트가
    // `{curve, surface, t0, t1}`. **한 커브의 t0~t1 구간**이 반대편 구간과
    // 꿰매진다. `t0 > t1` 이면 방향이 뒤집힌 것이고, 그건 데이터가 말하는
    // 사실이라 우리가 정규화하지 않는다 — 화면이 대응선을 그을 때 필요하다.
    //
    // ★ `Cut(t0, t1)` 이 그 구간만 잘라 준다. 우리가 베지어를 다시 풀지
    //   않는다는 규칙이 여기서도 그대로 선다.
    for (const auto& entry : qi->GetSeams())
    {
        const ztDesignSeamData* data = qi->GetSeamData(entry.first);
        if (!data) continue;

        // ── ★ 대응점과 색은 **엔진이 정본이다** ───────────────
        //
        // 처음엔 여기서 파트를 이어 붙여 길이로 균등 샘플링하고, 색은
        // 황금각으로 만들어 냈다. 둘 다 발명이었다 — 데스크톱의
        // `Seam2DRenderer::RenderSewingLines` 를 읽어 보니 엔진에 정본이 있다:
        //
        //     seam->GetPositionsForDraw(points0, points1, /*world=*/true);
        //     for k in [0, min(size0, size1)) : DrawDashedLine(p0[k], p1[k])
        //     ztColor seamColor = seam->GetColor();
        //
        // 우리가 지어낸 값으로 그리면 **데스크톱과 개수도 위치도 색도 다른
        // 그림**이 나오는데, 그 차이는 "점선이 좀 많은/적은 것 같다" 로만
        // 보여서 무엇이 옳은지 화면으로는 못 가른다. 실제로 그렇게 두 번
        // 틀렸다(45줄 → 199줄 → 이것).
        //
        // ⚠️ `world=true` 를 넘긴다. 데스크톱과 같은 값이고, 커브를
        //    `atWorld` 로 싣는 것과 좌표계가 일치해야 한다.
        json links = json::array();
        json seamColor;

        // ⚠️ `GetSeamByUuid` 는 **private 이다.** 대신 지금 돌고 있는 이 맵이
        //    객체를 직접 준다 — 한 번 더 찾을 이유도 없다.
        if (const ztDesignSeam* seamObj = entry.second.get())
        {
            std::vector<ztSeamTessellatedPoint>* pts[2] = { nullptr, nullptr };
            seamObj->GetPositionsForDraw(pts[0], pts[1], true);

            if (pts[0] && pts[1])
            {
                const std::size_t n = (std::min)(pts[0]->size(), pts[1]->size());
                for (std::size_t k = 0; k < n; ++k)
                {
                    const ztDesign2DPoint& a = (*pts[0])[k].point;
                    const ztDesign2DPoint& b = (*pts[1])[k].point;
                    if (a.x < -1e30f || a.x > 1e30f || b.x < -1e30f || b.x > 1e30f) continue;
                    links.push_back(json::array({ a.x, a.y, b.x, b.y }));
                }
            }

            const ztColor c = seamObj->GetColor();
            seamColor = json::array({ c.r, c.g, c.b, c.a });
        }

        json sides = json::array();
        for (const auto& side : data->seam)
        {
            json parts = json::array();
            for (const auto& group : side)
            {
                for (const auto& part : group)
                {
                    ztGeomCubicBezierCurve geom =
                        qi->CreateGeomCubicBezierCurve(part.curveUuid, true);
                    // ⚠️ `t[0] > t[1]` 이면 방향이 뒤집힌 파트다. `Cut` 은
                    //    오름차순을 기대하므로 여기서만 정렬하고, **원래 값은
                    //    응답에 그대로 싣는다** — 방향은 데이터가 말하는
                    //    사실이고 화면이 대응선을 그을 때 필요하다.
                    const float a = (std::min)(part.t[0], part.t[1]);
                    const float b = (std::max)(part.t[0], part.t[1]);
                    ztGeomCubicBezierCurve seg = geom.Cut(a, b);

                    std::vector<ztDesign2DPoint> tess;
                    seg.SmartTessellation(tess);

                    json pts = json::array();
                    bool ok = true;
                    for (const ztDesign2DPoint& p : tess)
                    {
                        if (p.x < -1e30f || p.x > 1e30f ||
                            p.y < -1e30f || p.y > 1e30f) { ok = false; break; }
                        pts.push_back(p.x);
                        pts.push_back(p.y);
                    }
                    if (!ok || pts.size() < 4) continue;

                    parts.push_back(json{
                        { "curve",   part.curveUuid.GetString()   },
                        { "surface", part.surfaceUuid.GetString() },
                        { "t0",      part.t[0] },
                        { "t1",      part.t[1] },
                        { "pts",     pts       },
                    });
                }
            }
            sides.push_back(parts);
        }

        seams.push_back(json{
            { "uuid",  entry.first.GetString() },
            { "sides", sides },
            // 엔진이 준 대응점 쌍 `[[ax,ay,bx,by], ...]`. 화면은 이 개수만큼
            // 점선을 긋는다 — 우리가 개수를 정하지 않는다
            { "links", links },
            // 엔진이 준 색 `[r,g,b,a]`. 없으면 null 이고, 그때만 화면이
            // 자기 팔레트로 떨어진다
            { "color", seamColor.is_null() ? json(nullptr) : seamColor },
        });
    }

    // ── 스티치 ──────────────────────────────────────────────
    //
    // 이쪽은 **색을 자기가 들고 있다**(`baseColor`). 이미지의 색 있는 변이
    // 여기서 나오는지는 그려 보고 대조한다 — 이 단위가 답할 수 있는 것은
    // "몇 개이고 어느 커브에 붙어 있는가" 까지다.
    for (const auto& entry : qi->GetStitches())
    {
        const ztDesignStitchData* data = qi->GetStitchData(entry.first);
        if (!data) continue;

        json curves = json::array();
        for (const ztUuid& c : data->bezierCurves)
        {
            json one = TessellateCurve(qi, c, "stitch");
            if (!one.is_null()) curves.push_back(std::move(one));
        }

        stitches.push_back(json{
            { "uuid",    entry.first.GetString() },
            { "surface", data->surfaceUuid.GetString() },
            { "color",   json::array({ data->baseColor.r, data->baseColor.g,
                                       data->baseColor.b, data->baseColor.a }) },
            { "curves",  curves },
        });
    }

    return json{
        { "surfaces", surfaces },
        { "seams",    seams    },
        { "stitches", stitches },
    };
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

            // ── 서피스 → 2D 도면 배치 (ISSUE-018) ───────────────────
            //
            // ⚠️ **위의 `transform`과 전혀 다른 것이다.** 저쪽은 패턴 로컬 →
            //    3D 월드(옷이 몸에 둘러지는 자리)이고, 이쪽은 로컬 → **2D
            //    재단 도면 위의 자리**다. 2D 펼침 뷰의 요점은 3D 변환을
            //    **쓰지 않는 것**이므로 둘을 섞으면 ISSUE-011을 다시 겪는다.
            //    그래서 키 이름을 나눴다 — `transform` 재사용 금지.
            //
            // ── 왜 필요한가 (실측) ──────────────────────────────────
            // `uvs`만으로는 2D 뷰를 그릴 수 없다. uv는 서피스 **로컬** 평면
            // 좌표라(ztDesignClothPattern.cpp:562-568의 GenerateUVs →
            // ztUVMaker::CopyPositionToUV, uv.x=p.x / uv.y=p.y) 패턴마다 자기
            // 원점 근처에서 시작한다. `W_Bra top & Leggings.zls`(패턴 24개)를
            // 실측했더니 AABB 쌍 276개 중 227개(82.2%)가 겹쳤고, 개별 AABB
            // 면적 합이 전체 합집합 상자의 **2.05배**였다. 98cm짜리 레깅스 판
            // 두 장(패턴 16·21)이 소수점 둘째 자리까지 같은 자리에 포개진다.
            //
            // ── 왜 행렬로 보내는가 ──────────────────────────────────
            // ztDesign2DTransform은 translate/scale/rotate/rotCenter/
            // scaleCenter 다섯 필드의 **합성**이고, 그 순서를 프론트에서 다시
            // 구현하면 그게 곧 어긋날 자리다. 엔진이 이미 합성해 주는
            // GetMatrix33()을 그대로 내보낸다.
            //
            // ★ 이 값이 데스크톱 2D 뷰포트가 쓰는 것과 **같은 값**이다:
            //   Renderer2D.cpp:164가 서피스마다 PaintInterface2D::Transform을
            //   부르고, 그 안(PaintInterface2D.cpp:908-914)이 쓰는 것이
            //   GetMatrix()이며 GetMatrix()는 GetMatrix33()을 그대로 편다.
            //
            // ⚠️ GetMatrix33()과 Transform()은 **엄밀히는 같지 않다.**
            //    Transform()은 스케일을 원점 기준으로 걸고(ztDesign2DTransform
            //    .cpp:13-21), GetMatrix33()은 scaleCenter 기준으로 건다(:61-80).
            //    둘이 갈라지는 조건은 `scaleCenter != 0` 하나인데, 그 필드는
            //    **어디서도 채워지지 않는다** — .zls 직렬화에 아예 없고
            //    (ztDesignSurface.cpp:731-739/785-792가 translate/scale/
            //    rotation/rotationCenter/scaleFactor만 읽고 쓴다) operator==
            //    조차 비교하지 않는다(:110-113). 따라서 로드된 씬에서는 항상
            //    (0,0)이고 두 경로가 일치한다. 언젠가 scaleCenter를 쓰는
            //    기능이 붙으면 이 등식이 깨지므로 여기 적어 둔다.
            //
            // ── 배열 형식 ───────────────────────────────────────────
            // **행 우선(row-major) 9개**다: [m00,m01,m02, m10,m11,m12,
            // m20,m21,m22]. 적용은 **열벡터** 규약 — world = M · [x, y, 1]ᵀ,
            // 즉 wx = m00*x + m01*y + m02 / wy = m10*x + m11*y + m12.
            // (마지막 행은 항상 [0,0,1]이라 정보가 없지만, 잘라 보내면 받는
            //  쪽이 "이게 3x3인가 2x3인가"를 매번 되물어야 해서 그대로 둔다.)
            //
            // ⚠️ zsMatrix33의 **저장 방식은 열 우선**이다(zsMatrix33.h:24의
            //    주석, `T e[3][4]`). 우리가 쓰는 GetElement(i, j)는 `e[j][i]`를
            //    돌려주므로 **(행, 열)** 접근이다(:330-336). 즉 아래 순서는
            //    메모리 순서가 아니라 수학 표기 순서다. 전치해서 읽어도 그림은
            //    그럴듯하게 나오므로(회전이 작으면 더욱), 규약을 여기 못박는다.
            //
            // ── 왜 includeTopology 안에 두는가 ──────────────────────
            // 위의 3D transform은 "249프레임 실측 결과 비트 단위로 불변"이
            // 근거인데, **2D 배치에는 그 근거가 없다.** 여기 근거는 다른
            // 것이다: 이 워커에 2D 배치를 바꿀 수 있는 op이 **하나도 없다.**
            // (ping/version/init/load/clear/start/pause/reset/step/subscribe/
            //  unsubscribe/status/getParams/setParams/meshInfo/meshData/
            //  export/quit — 전부 시뮬 제어·조회이고 디자인 데이터를 만지지
            //  않는다.) 시뮬레이션은 GetSimulationOutputMesh의 정점을 움직일
            //  뿐 서피스 변환을 건드리지 않는다. 따라서 한 세션 안에서 상수다.
            //
            // ★ 깨지면 어떻게 드러나는가 — 2D 창에서 패턴을 끌어 옮기는 기능
            //   (데스크톱의 2D 저작)이 붙는 순간이다. 클라이언트는 최초 1회
            //   받은 행렬을 계속 쓰므로 **끌어도 화면에서 패턴이 안 움직이거나,
            //   놓는 순간 원래 자리로 되돌아간 것처럼 보인다.** 3D 쪽의 실패
            //   양상("정점은 흔들리는데 옷이 엉뚱한 자리에 고정")과 달리
            //   오차가 아니라 **입력이 먹지 않는 것**으로 나타나서 렌더링
            //   문제로 오진하기 쉽다. 그때 할 일은 이 블록을 includeTopology
            //   밖으로 꺼내거나(패턴당 +9 float) 배치 변경 이벤트를 따로 내는
            //   것이다.
            //
            // ⚠️ 서피스가 없는 패턴이 있을 수 있다(GetSurface()가 널). 그때는
            //    키를 아예 싣지 않는다 — 항등행렬을 대신 보내면 받는 쪽이
            //    "원점에 배치된 것"과 "배치를 모르는 것"을 구분할 수 없다.
            if (const ztDesignSurface* surface = pattern->GetSurface())
            {
                const ZELUS::zsMatrix33 m = surface->GetTransform().GetMatrix33();
                p["transform2d"] = json::array({
                    m.GetElement(0, 0), m.GetElement(0, 1), m.GetElement(0, 2),
                    m.GetElement(1, 0), m.GetElement(1, 1), m.GetElement(1, 2),
                    m.GetElement(2, 0), m.GetElement(2, 1), m.GetElement(2, 2),
                });
            }

            // ── 패턴 머티리얼 (실시간 뷰의 진짜 색) ──────────────────
            //
            // 실시간 뷰는 여태 패턴 구분용 임의 5색을 칠했다. 스냅샷(glTF)만
            // 진짜 색이 나오는 상태라, 사용자가 움직이는 옷을 보면서 색을
            // 믿을 수 없었다. 그 출처를 여기서 싣는다.
            //
            // ★ 왜 패턴에 인라인인가 (별도 materials op이 아니라) — 실측했다.
            //   머티리얼 객체는 패턴과 **1:1**이다. 두 씬 모두에서 어떤
            //   머티리얼도 패턴 둘에게 공유되지 않는다:
            //     W_Bra top & Leggings.zls  패턴 24 : 머티리얼 24 (참조 각 1회)
            //     sample.zls                패턴  5 : 머티리얼 15 (front/back/
            //                                        side 슬롯마다 하나씩, 각 1회)
            //   즉 머티리얼 uuid로 묶는 별도 op을 만들어도 엔트리 수가 줄지
            //   않는다. 왕복만 하나 늘고 받는 쪽은 두 응답을 상관시켜야 한다.
            //
            //   진짜 N:1인 축은 **직물 에셋**이다(위 24개가 assetUuid 2개로
            //   묶인다 — 노랑 16 / 민트 8). 그래서 `fabricUuid`를 같이 싣는다.
            //   패턴을 직물별로 묶는 일(직물 목록 UI, setFabric의 대상 지정)은
            //   이 키 하나로 클라이언트에서 된다.
            //
            // ★ 왜 includeTopology 안인가 — transform2d와 **같은 근거**다.
            //   이 워커에 머티리얼을 바꿀 수 있는 op이 하나도 없고, 시뮬레이션은
            //   정점만 움직인다. 따라서 한 세션 안에서 상수다.
            //
            //   ⚠️ 다만 이 근거는 transform2d보다 먼저 깨질 예정이다 — 백로그의
            //   `setFabric`이 바로 이 값을 바꾸는 op이다. 그때 어떻게 드러나는가:
            //   클라이언트는 최초 1회 받은 색을 계속 쓰므로 **직물을 바꿔도
            //   화면 색이 그대로다.** 크래시도 에러도 없고, "적용 버튼이 안
            //   먹는다"로 보여서 UI 배선 문제로 오진하기 쉽다. 그때 할 일은 이
            //   블록을 밖으로 꺼내는 게 아니라(프레임마다 보낼 이유가 없다)
            //   **머티리얼 변경 이벤트를 따로 내는 것**이다.
            //
            // ⚠️ 머티리얼이 없는 패턴이 있을 수 있다(GetFrontMaterial()이 널).
            //    그때는 키를 아예 싣지 않는다 — 흰색을 대신 보내면 받는 쪽이
            //    "흰 옷"과 "색을 모름"을 구분할 수 없고, 임의 팔레트로 폴백할
            //    기회를 잃는다. sample.zls가 실제로 전부 흰색이라 이 구분이
            //    화면에서 바로 문제가 된다.
            //
            // 앞면만 읽는다. 익스포터도 기본 경로에서는 GetFrontMaterial()
            // 하나만 쓴다(zwGltfExporterImpl.cpp:477 — 뒷면/옆면은 thickness와
            // splitMesh가 둘 다 켜졌을 때만 갈라진다). 게다가 three.js의
            // MeshStandardMaterial은 DoubleSide여도 면마다 다른 색을 못 준다.
            if (const ztDesignMaterial* material = pattern->GetFrontMaterial())
            {
                const ztDesignMaterialData& d = material->GetMaterialData();

                // 씬의 값을 그대로 읽는다. 익스포터는 여기서 한 단계 더 가서
                // zwMaterialManager::LoadWithAssetUuid(assetUuid)로 에셋
                // 라이브러리의 사본을 다시 읽는데, 우리는 그러지 않는다.
                // 두 가지 이유다: (1) zwMaterialManager는 헤드리스에서 GL
                // 텍스처 생성에 닿는 알려진 위험 경로다(main.cpp:7-8 참고),
                // (2) 씬을 읽어야 사용자가 실제로 편집한 값이 나온다.
                // 실측상 두 출처는 일치한다 — 아래 색이 스냅샷과 같은 값이다.

                // 익스포터가 glTF에 쓰는 것과 **같은 네 가지**다
                // (zwGltfExporterImpl.cpp:1282, :1391-1392):
                //   baseColorFactor = { basecolor.xyz, alpha }
                //   roughnessFactor = roughness / metallicFactor = metalness
                // 그래서 실시간 뷰가 스냅샷과 같은 재질로 보일 수 있다. 이보다
                // 좁게 실으면 두 화면이 원리적으로 못 맞는다.
                //
                // 익스포터가 읽고도 glTF에 **안 쓰는** 값들(sheen, specular,
                // occlusion, anisotropy, displacement)은 여기서도 뺐다.
                // three.js MeshStandardMaterial에 대응하는 자리가 없다.
                // isDoubleSided도 뺐다 — 익스포터조차 이 필드를 무시하고
                // 자기 멤버를 쓰며(zwGltfExporterImpl.cpp:1395), 옷은 두께
                // 없는 껍질이라 클라이언트가 항상 양면으로 그려야 한다.
                //
                // ⚠️ 실측 기준: 두 씬에서 **color와 roughness만 값이 갈렸다**
                //    (roughness 1.0 / 0.3). opacity와 metalness는 양쪽 다
                //    1.0과 0.0으로 고정이었다. 그럼에도 싣는 이유는 위의
                //    "익스포터와 같은 네 가지"이지, 변화를 관측해서가 아니다.
                //    이 둘이 끝내 안 쓰인다면 지울 근거는 그때 생긴다.
                //
                // base64로 싸지 않는다 — 패턴당 숫자 5개뿐이라 압축 이득이
                // 없고, 사람이 읽을 수 있어야 씬 파일·익스포트 산출물과
                // 대조할 수 있다(transform / transform2d와 같은 규약).
                json m{
                    { "fabricUuid", ztUuidSaver::Convert(d.assetUuid) },
                    { "color",      { d.basecolor.x, d.basecolor.y, d.basecolor.z } },
                    { "opacity",    d.alpha },
                    { "roughness",  d.roughness },
                    { "metalness",  d.metalness },
                };

                // ★ 색공간을 같이 보낸다. basecolor.w가 아니라 alpha가 불투명도인
                //   것처럼(익스포터도 basecolor.w는 버린다), 이 값도 혼자서는
                //   해석이 안 된다. 실측한 노랑은 [0.9254902, 0.8117647,
                //   0.4705882] = 정확히 236/255, 207/255, 120/255 — 8비트
                //   색선택기에서 나온 sRGB 값이다. 이걸 선형으로 착각해 칠하면
                //   눈에 띄게 어둡고 진해진다. 두 씬 다 SRGB였지만, 값이 아니라
                //   **해석 규칙**이라 상수처럼 보여도 빼면 안 된다 — 받는 쪽이
                //   추측하면 틀렸을 때 화면만 조용히 어긋난다.
                m["colorProfile"] =
                    (d.colorProfile == ztColorProfile::Linear) ? "linear" : "srgb";

                p["material"] = std::move(m);
            }

            if (mesh.indices.size() > 0)
            {
                p["indices"] = Base64(&mesh.indices[0],
                                      mesh.indices.size() * sizeof(ZELUS::zsInt));
                p["indexStride"] = static_cast<int>(sizeof(ZELUS::zsInt));
            }
            // cm 단위 2D 패턴 좌표다(텍스처 좌표가 아니다 — 0~1로 정규화돼
            // 있지 않다). **서피스 로컬**이므로 이것만으로 2D 뷰를 그리면
            // 패턴들이 겹친다 — 위 `transform2d`를 곱해야 도면 좌표가 된다.
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
            else if (op == "avatarBody")
            {
                result = ReadAvatarBody(manager);
            }
            else if (op == "setAvatarBody")
            {
                if (!manager.IsLoadedZls())
                {
                    ok = false; error = "씬이 로드되지 않았습니다";
                }
                else
                {
                    std::vector<std::string> applied, unknown;
                    if (!WriteAvatarBody(manager, req.value("bodyParams", json::object()),
                                         applied, unknown))
                    {
                        ok = false; error = "씬에 아바타가 없습니다";
                    }
                    else
                    {
                        // ★ 쓰고 나서 **다시 읽어** 실어 준다. 요청한 값을 메아리치면
                        //   UpdateAvatar 가 아무 일도 안 했을 때조차 성공으로 보인다 —
                        //   그 미지수가 이 단위의 전부다(위 주석 참고).
                        result = json{
                            { "applied", applied },
                            { "unknown", unknown },
                            { "avatar",  ReadAvatarBody(manager) },
                        };
                    }
                }
            }
            else if (op == "surfaces")
            {
                if (!manager.IsLoadedZls())
                {
                    ok = false; error = "씬이 로드되지 않았습니다";
                }
                else
                {
                    result = ReadSurfaces(manager);
                }
            }
            else if (op == "design2d")
            {
                // 읽기 전용이다. 로드당 한 번이면 되고, 프레임 경로에 없다 —
                // 커브·봉제선은 드레이프와 무관하게 고정이기 때문이다
                // (L-2a 가 재단 도면에 대해 확인한 성질과 같은 이유다).
                if (!manager.IsLoadedZls())
                {
                    ok = false; error = "씬이 로드되지 않았습니다";
                }
                else
                {
                    result = ReadDesign2D(manager);
                }
            }
            else if (op == "setSurfaceSize")
            {
                const std::string uuid = req.value("uuid", "");
                if (!manager.IsLoadedZls())
                {
                    ok = false; error = "씬이 로드되지 않았습니다";
                }
                else if (uuid.empty())
                {
                    ok = false; error = "uuid가 필요합니다";
                }
                else if (WriteSurfaceSize(manager, uuid, req) != 0)
                {
                    // 조용히 성공으로 답하면 화면이 "바꿨다" 고 말하는데 아무
                    // 일도 안 일어난다 — ISSUE-014 가 정확히 그 모양이었다.
                    ok = false; error = "그런 서피스가 없습니다: " + uuid;
                }
                else
                {
                    // ★ 되읽어 싣는다. 엔진이 크기를 클램프하거나 비율을
                    //   유지하려고 다른 값을 넣었다면 그 사실이 응답에 드러나야
                    //   한다 — 요청값을 메아리치면 가려진다(setAvatarBody 와 같은 판단).
                    result = ReadSurfaces(manager);
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
