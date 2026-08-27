#include "protocol.h"

#include <ZestManager.h>

#include <zsTransform.h>   // 패턴 → 월드 변환 (MeshData)

// 서피스 이름이 std::wstring 이라 UTF-8 변환에 WideCharToMultiByte 가 필요하다.
// NOMINMAX 가 없으면 windows.h 의 min/max 매크로가 std::min/max 를 깨뜨린다.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <ztAssetManager.h>        // GetAppdataRoot — 직물 상대경로의 뿌리 (텍스처)
#include <ztAvatarCommon.h>        // ztAvatarBodyParam·ztAvatarMeasurePart + 이름 함수
#include <ztAvatarMeasurement.h>   // GetMeasuredLength — 적용 뒤 치수를 다시 잰다
#include <ztAvatarShaper.h>        // ztAvatarShaperEx::MeasurementInfos (치수 목표값 배열)
#include <ztAvatarManager.h>       // ztAccessoryMeshData — 액세서리 (avatarMesh)
#include <ztSimulMesh.h>           // ztAccessoryMeshData::simulMeshes 의 완전한 타입.
                                   // ztAvatarManager.h 는 전방선언만 한다 —
                                   // 없으면 zsTriMesh 로 업캐스트가 안 된다
#include <ztDesignZeta.h>          // SetMeasurementParam / UpdateBodyParams (치수→체형)
#include <ztDesignUpdateManager.h> // skipRecomputeAvatar — 체형 쓰기의 재빌드를 막는다
#include <ztSimulationManager.h>   // 체형 단계마다 Step / Pause
#include <ztDesignSurface.h>       // ztDesignSurfaceData::name (옷 사이즈)
#include <ztDesign2DTransform.h>   // 서피스 2D 배치 (MeshData의 transform2d)
#include <ztDesignAvatar.h>        // ztDesignAvatarData·ztDesignZetaData (체형)
#include <ztDesignMannequin.h>     // 마네킹 아바타 메시·머티리얼 (avatarMesh)
#include <ztMutex.h>               // ztGlobalMutex — 아바타 메시 읽기 보호 (avatarMesh)
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

// 직물 목록 (`fabrics` op). **앱 코드다** — SDK 가 아니라 `zelusSandBox/core/`
// 이고 우리 CMakeLists 가 이미 컴파일한다(zwMaterialManager.cpp·zwFabricMaterial.cpp).
// GL 에 닿지 않는 이유는 `ReadFabrics` 머리말 참고.
#include "core/zwFabricMaterial.h"
#include "core/zwMaterialManager.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
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

    // ── 치수는 **살아 있는 객체에서 잰다** (ISSUE-021) ──────────
    //
    // ★ `zetaData.measurementRealValues` 는 `.zls` 에 저장되는 **씬 데이터**이고,
    //   `SetMeasurementParam` 의 쓰기는 살아 있는 `ztDesignZeta` 로 간다.
    //   **둘은 동기화되지 않는다.** 씬 데이터만 읽으면 체형·치수를 아무리
    //   바꿔도 이 값이 로드 시점 그대로다 — 실측: Δ15cm 를 걸어 몸이 실제로
    //   변했는데(glTF 해시 상이) `WaistCircum` 은 61.647 에 붙박여 있었다.
    //
    //   정본은 `ztDesignZeta::GetMeasurement()->GetMeasuredLength(part)` 이고,
    //   `setAvatarMeasurements` 응답의 `measured` 가 이미 이 경로를 쓴다.
    //   같은 값을 두 op 이 서로 다르게 답하고 있었다.
    //
    // ⚠️ **제타가 아니면 이 경로가 없다.** 마네킹은 `dynamic_cast` 가 실패하고
    //    `GetMeasurement()` 도 없다 — 그때는 씬 데이터로 떨어진다. 어느 쪽으로
    //    읽었는지를 `measurementSource` 로 **말해 준다**: 화면이 "지금 몸" 과
    //    "로드 시점 값" 을 구분할 수 있어야 낡음 배너를 옳게 걸 수 있다.
    std::shared_ptr<ztAvatarMeasurement> live;
    {
        const ztDesignAvatarStorage& avatars = qi->GetAvatars();
        const auto found = avatars.find(uuid);
        if (found != avatars.end())
        {
            if (ztDesignZeta* zeta = dynamic_cast<ztDesignZeta*>(found->second.get()))
                live = zeta->GetMeasurement();
        }
    }

    json measures = json::object();
    for (int i = 0; i < (int)ztAvatarMeasurePart::Count; ++i)
    {
        const auto& want = z.measurementExpectedValues[i];
        json m = json{
            { "real",   live ? live->GetMeasuredLength((ztAvatarMeasurePart)i)
                             : z.measurementRealValues[i] },
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
        // `live` = 살아 있는 제타에서 방금 잰 값. `sceneData` = `.zls` 에 저장된
        // 로드 시점 값(제타가 아닌 아바타). **화면이 이 둘을 구분해야 한다.**
        { "measurementSource", live ? "live" : "sceneData" },
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

    if (applied.empty()) return true;

    // ── 왜 `UpdateAvatar` 한 번으로 끝내지 않는가 ──────────────────
    //
    // ⛔ **`UpdateAvatar` 만 부르면 몸통 표면이 접힌다.** 그것은 씬 데이터를
    //    갈아 끼우고 `Synchronize` → `ztDesignZeta::Recompute()` 를 태우는데, 거기
    //    (`Zest/design/ztDesignZeta.cpp:220-231`)가 치수 정보를 이렇게 만든다:
    //
    //        copyRealValues[i].isLock = true;   // ← 20여 개를 **전부** 잠근다
    //        copyRealValues[i].value  = data.zetaData.measurementRealValues[i];
    //        mAvatarManager->SetMeasurementParam(copyRealValues, bodyParams, true, true);
    //
    //    `isLock` 의 기본값은 false 인데(`ztAvatarShaper.h:166`) 이 자리만 덮는다.
    //    그러면 `SetMeasurementParam` 이 잠긴 치수마다 "새 체형이 만드는 치수" 와
    //    "씬에 저장된 옛 치수" 의 오차를 재고, 5mm 를 넘으면 `AccurateMeasure` 로
    //    **정점별 오프셋**을 만들어 살을 옛 둘레로 끌어당긴다. 셰이퍼는 몸을
    //    부풀리고 그 잠금은 되당기므로, 두 힘이 부딪히는 가슴·허리·배가
    //    구겨진다. 실측(fatness, Body 파트 5,630 삼각형 중 뒤집힌 수):
    //
    //        0.4 → 0    0.5 → 0    0.55 → 134    0.8 → 269    1.0 → 338
    //
    //    씬에 저장된 값(0.5) 근처에서 0 이고 **양방향**으로 멀어질수록 커진다
    //    (0.25 → 59, 0.0 → 115). 오차가 5mm 를 넘는 순간부터 당기기 시작한다는
    //    설명과 정확히 맞는다. bust_size·belly 등 다른 파라미터도 같다.
    //
    // ★ 그래서 둘로 나눈다. 씬 데이터는 재빌드 없이 갱신하고(①), 실제 몸은
    //   셰이퍼 전용 입구로 만든다(②). `SetBodyParam` 이
    //   `mAccurateVertexOffsets` 를 비우므로 되당김이 사라진다
    //   (`Zest/avatar/ztAvatarManager.cpp:401-406`).
    //
    // ⚠️ 데스크톱 앱에는 이 경로를 밟는 자리가 아예 없다(`zelusSandBox` 전체에
    //    `bodyParams` · `SetMeasurementParam` 호출이 0건이다). 참고할 선례가
    //    없다는 뜻이므로, 고칠 때 위 실측을 기준선으로 쓸 것.

    // ① 씬 데이터만 갱신한다 — `ReadAvatarBody` 의 되읽기와 `.zls` 저장이 이 값을
    //    본다. 플래그는 `Recompute()` 첫 줄이 보고 그대로 돌아 나가는 것이다.
    {
        const bool prevSkip = ztDesignUpdateManager::mUpdateFlag.skipRecomputeAvatar;
        ztDesignUpdateManager::mUpdateFlag.skipRecomputeAvatar = true;
        qi->UpdateAvatar(uuid, next);
        ztDesignUpdateManager::mUpdateFlag.skipRecomputeAvatar = prevSkip;
    }

    // ② 살아 있는 제타에 셰이퍼 값을 넣고 몸을 다시 만든다.
    //
    // ⚠️ 제타가 아닌 아바타(마네킹·FBX)는 `dynamic_cast` 가 실패해 **몸이 안
    //    변한다.** 그 사실은 응답의 `avatar` 되읽기가 드러낸다 — 씬 값은 바뀌고
    //    `measurementSource` 가 `sceneData` 로 남는다(`ReadAvatarBody` 참고).
    {
        const ztDesignAvatarStorage& avatars = qi->GetAvatars();
        const auto found = avatars.find(uuid);
        if (found != avatars.end())
        {
            if (ztDesignZeta* zeta = dynamic_cast<ztDesignZeta*>(found->second.get()))
            {
                // 29개를 전부 실어 보낸다. 안 바꾼 것은 지금 값 그대로이므로
                // 결과가 같고, 부분만 보내면 `SetBodyParam` 이 배열을 통째로
                // 대입하는 탓에 나머지가 dirty 표시를 잃는다.
                ztAvatarManager::BodyParamInfos infos;
                for (int i = 0; i < (int)ztAvatarBodyParam::Count; ++i)
                {
                    infos[i] = std::make_pair(true, next.zetaData.bodyParams[i]);
                }

                zeta->SetBodyParam(infos);
                zeta->UpdateBodyParams(true, true);
            }
        }
    }

    return true;
}

// ── 치수 기반 체형 변형 (회사 consoleApplication 이식) ───────
//
// **위의 `WriteAvatarBody` 와 다른 경로다.** 저쪽은 셰이퍼 파라미터 29개를
// `ztDesignAvatarData` 에 직접 써 넣고 `UpdateAvatar` 로 되돌리는데, 그것이
// 엔진의 체형 갱신까지 내려가는지가 미지수로 남아 있다(위 머리말 참고).
// 이쪽은 회사가 새로 추가한 CLI 타깃
// (`consoleApplication/ZestManager.cpp:403-602`, `UpdateBodyParameter`)이
// 쓰는 **정식 경로**를 그대로 옮긴 것이다:
//
//     simManager->Pause()
//     → qi->GetAvatars()[qi->GetCurrentAvatar()] → dynamic_cast<ztDesignZeta*>
//     → (목표 치수 − 현재 실측치) 중 최대 변화량 / stepCm = 중간 단계 수
//     → 단계마다  zeta->SetMeasurementParam(measures, true)
//                 zeta->UpdateBodyParams(true, true)
//                 simManager->Step(true) × simulationIterations
//     → simManager->Pause()
//
// ★ 왜 한 번에 안 밀고 단계를 쪼개는가 — 치수를 크게 바꾸면 몸이 이미 입혀진
//   옷을 뚫고 나간다. 몸을 조금씩 키우면서 매 단계 시뮬을 돌려 옷이 따라오게
//   하는 것이 이 루프의 전부다. 그래서 `bodyDimensionStepCm` 는 정밀도가
//   아니라 **관통 회피 여유**를 정하는 값이다.
//
// ⚠️ **이 op 은 그 자리에서 시뮬레이션을 돌린다.** 단계 수 ×
//    simulationIterations 번의 `Step(true)` 가 동기로 실행되고, 그동안
//    프로토콜 루프는 stdin 을 읽지 않으므로 워커가 다른 요청에 응답하지
//    못한다(프레임 이벤트도 그동안 나가지 않는다 — 루프가 돌지 않으니
//    `maxFrame` 만 올라가고 이벤트는 op 이 끝난 뒤 한 번에 따라잡는다).
//
// ⚠️ **두 경로를 둘 다 남겨 둔다.** `setAvatarBody` 를 지우지 않았다.
//    어느 쪽이 실제로 반영되는지는 실측이 가르며, 그 판단은 여기서 하지 않는다.

/** ApplyAvatarMeasurements 의 실패 사유. 문자열로 바꾸는 일은 호출부가 한다 */
enum class MeasureApplyError
{
    None = 0,
    NoScene,        // 씬/쿼리 인터페이스 없음
    NoSimManager,   // 시뮬레이션 매니저 없음
    NoAvatar,       // 현재 아바타가 저장소에 없음
    NotZeta,        // ztDesignZeta 가 아님 (FBX/USD 아바타는 치수 변형이 없다)
    NoChange,       // 보낸 치수가 **전부 틀렸다** (모르는 이름 / 못 쓰는 값)
                    // ⚠️ "바꿀 것이 없다" 는 여기 안 온다 — null 뿐인 요청은 성공이다
};

struct MeasureApplyReport
{
    std::vector<std::string> applied;    // 반영한 치수 이름
    std::vector<std::string> unknown;    // 그런 치수 이름이 엔진에 없다
    std::vector<std::string> rejected;   // 이름은 맞지만 값을 쓸 수 없다
    int skipped  = 0;   // null(= "지정 안 함")이라 건너뛴 항목 수
    int steps    = 0;   // 중간 단계 수 (마지막 목표값 단계 포함)
    int simSteps = 0;   // 실제로 부른 Step 횟수

    // ★ 적용 뒤 **다시 잰** 치수. 이름 → cm.
    //
    //   `ReadAvatarBody` 의 `measurements[*].real` 로는 이 op 의 결과를 볼 수
    //   없다 — 그쪽은 `qi->GetAvatarData()` 가 주는 **씬 데이터의 사본**
    //   (`ztDesignAvatarData::zetaData::measurementRealValues`)인데 쓰기는
    //   `ztDesignZeta` 객체로 가고 둘이 동기화되지 않는다. 실측 2026-08-11:
    //   Δ15cm 를 걸고 Step 을 96번 돌려도 61.647 → 61.647 로 그대로였고,
    //   그런데도 glTF 해시는 바뀌었다(= 몸은 진짜 다시 만들어졌다).
    //
    //   여기서는 그 객체에서 직접 잰다: `ztDesignZeta::GetMeasurement()`
    //   → `ztAvatarMeasurement::GetMeasuredLength(part)`.
    std::map<std::string, float> measured;
};

/**
 * 치수를 목표값까지 단계적으로 밀면서 매 단계 시뮬을 돌린다.
 *
 * `measurements` 의 키는 **엔진이 정한 치수 이름**이다("WaistCircum",
 * "Stature", …). `avatarBody` 응답의 `measurements` 키와 같은 이름이며,
 * `ztAvatarMeasureUtils::GetMeasurePartIdx` 가 정본이다 — 우리가 이름을
 * 새로 만들면 읽는 op 과 쓰는 op 의 어휘가 갈라진다.
 */
MeasureApplyError ApplyAvatarMeasurements(ZestManager& manager,
                                          const json&  measurements,
                                          int          simulationIterations,
                                          float        bodyDimensionStepCm,
                                          MeasureApplyReport& report)
{
    ztSceneQueryInterface* qi = QueryInterface(manager);
    if (!qi) return MeasureApplyError::NoScene;

    ztSimulationManager* simManager = manager.GetSceneManager()->GetSimulationManager();
    if (!simManager) return MeasureApplyError::NoSimManager;

    // ── 1단계: 읽기만 하는 검증. **여기서는 Pause 하지 않는다** ──
    //
    // 원본은 이 앞에서 `simManager->Pause()` 를 부른다. 1회성 CLI 에서는
    // 무해했지만 우리는 상주 워커다 — 아바타가 없거나 zeta 가 아니거나 치수
    // 이름이 전부 틀리면 클라이언트는 "에러" 를 받는데 **재생 중이던 시뮬은
    // 이미 멈춘 뒤**가 된다. 화면은 이유 없이 조용히 선다.
    // (실측 2026-08-11: mode=play, frame 322→324 로 도는 중에 모르는 치수만
    //  보냈더니 요청은 실패하고 mode=pause 로 떨어졌다.)
    //
    // 이 단계가 만지는 것은 (a) 아바타 저장소 map 과 (b) 치수 **이름표**뿐이다.
    // 둘 다 시뮬 스레드가 쓰지 않는다 — 아바타의 추가·삭제는 이 프로토콜
    // 루프에서만 일어나고(단일 스레드), 이름표는 정적 테이블이다. 시뮬이
    // 건드릴 수 있는 아바타 **데이터**(measurementRealValues 등)는 일부러
    // 여기서 읽지 않고 Pause 뒤로 미룬다.
    const ztUuid avatarUuid = qi->GetCurrentAvatar();
    {
        const ztDesignAvatarStorage& avatars = qi->GetAvatars();

        const auto probe = avatars.find(avatarUuid);
        if (probe == avatars.end()) return MeasureApplyError::NoAvatar;
        if (!dynamic_cast<ztDesignZeta*>(probe->second.get()))
            return MeasureApplyError::NotZeta;
    }

    // 이름·값 검사는 아바타 데이터가 전혀 필요 없다 — `GetMeasurePartIdx` 는
    // 문자열 → 인덱스 변환일 뿐이다. 덕분에 "보낸 것이 전부 틀렸다" 까지
    // Pause 없이 판정된다.
    std::vector<std::pair<int, double>> wanted;      // (치수 인덱스, 목표 cm)
    std::vector<std::string>            wantedKeys;  // 같은 순서의 이름

    for (auto it = measurements.begin(); it != measurements.end(); ++it)
    {
        const std::string& key = it.key();

        const int idx = ztAvatarMeasureUtils::GetMeasurePartIdx(key);
        if (idx < 0) { report.unknown.push_back(key); continue; }

        // ★ `null` 은 "지정 안 함" 이다. 잘못된 값이 아니다.
        //
        //   엔진팀 문서: "모든 항목이 존재해야 함. 값은 치수(cm) or null,
        //   null인 경우 자연스러운 임의 값으로 계산됨". 즉 클라이언트는 치수
        //   키 25개를 **전부** 보내고 안 바꿀 것을 null 로 둔다. 회사 리더도
        //   `isNumeric()` 이 false 면 -1 로 두어 조용히 건너뛴다.
        //
        //   ⚠️ 이걸 `rejected` 에 넣으면 실제 파일을 그대로 보냈을 때 23개가
        //      rejected 로 뜨고, 전부 null 이면 요청 전체가 에러가 된다.
        //   → **키를 아예 안 보낸 경우와 똑같이 다룬다.** 센 수만 보고한다
        //      (조용히 삼키지 않는다 — ISSUE-014 의 교훈).
        if (it.value().is_null()) { ++report.skipped; continue; }

        // 숫자도 null 도 아니면 그건 클라이언트의 실수다(문자열·불리언·객체).
        if (!it.value().is_number()) { report.rejected.push_back(key); continue; }

        const double value = it.value().get<double>();

        // 원본의 `-1 < value` 를 그대로 지킨다. 파일 리더에서 "필드 없음"이
        // -1 이었기 때문에 생긴 조건이지만, 음수 치수를 엔진에 밀어 넣지
        // 않는다는 안전장치이기도 하다. 걸린 키는 조용히 버리지 않고
        // `rejected` 로 보고한다(ISSUE-014 의 교훈).
        if (!(-1 < value)) { report.rejected.push_back(key); continue; }

        wanted.emplace_back(idx, value);
        wantedKeys.push_back(key);
    }

    if (wanted.empty())
    {
        // 바꿀 것이 하나도 없다. **실패인지 아닌지는 "왜 없는지" 가 가른다.**
        //
        //  · 전부 null / 미지정  → 클라이언트가 "바꿀 것 없음" 을 보낸 것이다.
        //                          바꿀 것이 없는 것은 실패가 아니다 →
        //                          `applied:[]` · `steps:0` 으로 **성공**.
        //  · unknown/rejected 만  → 클라이언트가 틀렸다. 에러로 알려 준다
        //                          (호출부가 그 키 목록을 에러 문장에 붙인다).
        if (report.unknown.empty() && report.rejected.empty())
            return MeasureApplyError::None;

        return MeasureApplyError::NoChange;
    }

    // ── 2단계: 여기서부터 실제로 바꾼다 ─────────────────────
    //
    // 원본과 같은 이유로 멈춘다. 시뮬 스레드가 도는 중에 체형을 바꾸면
    // 같은 데이터를 두 스레드가 만진다.
    simManager->Pause();

    // Pause 앞에서 본 것을 **다시 확인한다.** 포인터를 Pause 너머로 들고
    // 가지 않는다 — 검증과 사용 사이에 시뮬이 멈추는 지점이 끼어 있다.
    const ztDesignAvatarStorage& avatars = qi->GetAvatars();

    const auto found = avatars.find(avatarUuid);
    if (found == avatars.end()) return MeasureApplyError::NoAvatar;

    ztDesignAvatar* avatar = found->second.get();
    ztDesignZeta*   zeta   = dynamic_cast<ztDesignZeta*>(avatar);
    if (!zeta) return MeasureApplyError::NotZeta;

    // ── 목표 치수 모으기 ────────────────────────────────────
    //
    // ⚠️ 기준선은 **실측치**(`measurementRealValues`)다. 목표치
    //    (`measurementExpectedValues`)가 아니다. 원본에서는 이 값을 담는
    //    변수 이름이 `orgMeasurementExpectedValues` 라 이름과 내용이
    //    어긋나 있는데, 이름이 아니라 동작을 옮긴다.
    const ztAvatarShaperEx::Measures org =
        avatar->GetData().zetaData.measurementRealValues;

    // ★ 목표는 **씬의 기존 목표값이 아니라 현재 실측치에서** 출발한다.
    //
    //   씬의 `measurementExpectedValues` 에는 예전에 걸어 둔 목표값과 잠금이
    //   남아 있다. 그것을 출발점으로 삼으면 **사용자가 보내지도 않은 부위가
    //   낡은 목표로 끌려간다** — 허리만 바꿨는데 팔이 짧아지는 식이다.
    //   회사도 같은 버그를 냈고 `8d73f85 "Modify arm length"` 로 고쳤다.
    //
    //   보내지 않은(또는 null 인) 치수는 `isLock=false` + 현재 실측치로 두어
    //   셰이퍼가 자유롭게 계산하게 한다. 엔진팀 문서의 *"null 인 경우
    //   자연스러운 임의 값으로 계산됨"* 이 성립하려면 잠금이 없어야 한다.
    ztAvatarShaperEx::MeasurementInfos dest;
    for (int i = 0; i < (int)ztAvatarMeasurePart::Count; ++i)
    {
        dest[i].isLock = false;
        dest[i].value  = org[i];
    }

    std::map<ztAvatarMeasurePart, float> lockItems;
    float maxDest = 0.0f;

    for (std::size_t i = 0; i < wanted.size(); ++i)
    {
        const int    idx   = wanted[i].first;
        const double value = wanted[i].second;

        dest[idx].isLock = true;
        dest[idx].value  = (float)value;

        const float delta = (float)value - org[idx];
        lockItems[(ztAvatarMeasurePart)idx] = delta;
        maxDest = (std::max)(maxDest, std::abs(delta));

        report.applied.push_back(wantedKeys[i]);
    }

    // ── 중간 단계 만들기 ────────────────────────────────────
    //
    // 단계 수는 **가장 많이 변하는 항목** 기준이다(`maxDest / stepCm`, 정수
    // 나눗셈). 각 단계에서 잠근 항목이 전부 같은 `offsetCm` 만큼 움직이고,
    // 목표를 넘어선 항목은 목표값에 클램프된다. 그래서 변화가 작은 항목은
    // 먼저 도착해 멈춰 있고 큰 항목만 계속 간다.
    std::vector<ztAvatarShaperEx::MeasurementInfos> stepValues;

    const float stepCm = bodyDimensionStepCm;
    const int   step   = (int)(maxDest / stepCm);

    for (int i = 0; i < step; ++i)
    {
        ztAvatarShaperEx::MeasurementInfos cur = dest;

        for (const auto& lockItem : lockItems)
        {
            const int   itemIdx  = (int)lockItem.first;
            const bool  isPlus   = (0.0 <= lockItem.second);
            const float offsetCm = (float)(i + 1) * stepCm;
            const float newValue = org[itemIdx] + (isPlus ? offsetCm : -offsetCm);

            const bool isOverValue = isPlus ? (dest[itemIdx].value <= newValue)
                                            : (newValue <= dest[itemIdx].value);

            cur[itemIdx].value = isOverValue ? dest[itemIdx].value : newValue;
        }

        stepValues.push_back(cur);
    }

    // 마지막 단계는 항상 목표값 그대로다. 위 루프가 정수 나눗셈으로 잘려
    // 목표에 못 미친 채 끝날 수 있기 때문이다(변화량 < stepCm 이면 위
    // 루프가 아예 돌지 않고 이 한 단계만 남는다).
    stepValues.push_back(dest);

    // ── 단계마다 체형 갱신 + 시뮬 ───────────────────────────
    const int total = (int)stepValues.size();
    report.steps = total;

    for (int i = 0; i < total; ++i)
    {
        // 원본은 std::cout 으로 찍는다. 우리는 cout 이 프로토콜 스트림이
        // 아니라 stderr 로 돌려져 있지만(OutputChannels), 사람이 읽는 로그는
        // 이 파일의 규약대로 LogLine 을 쓴다.
        LogLine("체형 단계 [" + std::to_string(i + 1) + "/" + std::to_string(total) + "]");

        zeta->SetMeasurementParam(stepValues[i], true);
        zeta->UpdateBodyParams(true, true);

        for (int j = 0; j < simulationIterations; ++j)
        {
            simManager->Step(true);
            ++report.simSteps;
        }
    }

    simManager->Pause();

    // ── 되읽기: 쓴 객체에서 직접 잰다 ───────────────────────
    //
    // 요청값을 메아리치지 않는다는 이 파일의 규약을 지키려면 **갱신되는**
    // 값을 실어야 한다. 위 struct 주석 참고 — 씬 데이터 사본은 안 움직인다.
    if (const std::shared_ptr<ztAvatarMeasurement> m = zeta->GetMeasurement())
    {
        for (int i = 0; i < (int)ztAvatarMeasurePart::Count; ++i)
        {
            const ztAvatarMeasurePart part = (ztAvatarMeasurePart)i;
            report.measured[ztAvatarMeasureUtils::GetMeasurePartName(part)] =
                m->GetMeasuredLength(part);
        }
    }

    return MeasureApplyError::None;
}

/** 실패 사유를 사람이 읽는 문장으로. 빈 문자열이면 성공이다 */
std::string MeasureApplyErrorText(MeasureApplyError err)
{
    switch (err)
    {
    case MeasureApplyError::None:         return {};
    case MeasureApplyError::NoScene:      return "씬이 없습니다";
    case MeasureApplyError::NoSimManager: return "시뮬레이션 매니저가 없습니다";
    case MeasureApplyError::NoAvatar:     return "씬에 아바타가 없습니다";
    case MeasureApplyError::NotZeta:      return "이 아바타는 치수 변형을 지원하지 않습니다 (ztDesignZeta 아님)";
    case MeasureApplyError::NoChange:     return "적용할 치수가 없습니다";
    }
    return "알 수 없는 실패";
}

// ── 드레이핑 보드 ───────────────────────────────────────────
//
// `.zls` 는 펼쳐진 패턴만이 아니라 **입혀진 상태(드레이프)** 도 같이 담는다.
// 그냥 `LoadZls` 만 하면 옷이 펼쳐진 채로 나온다. 회사의
// `consoleApplication/main.cpp:41-61` 이 그 뒤에 하는 일이 이것이다.
//
// ── 아이템 하나가 무엇인가 ──────────────────────────────────
//
// 프레임 한 장이 아니라 **완전한 세이브스테이트**다. `ztDrapingItem`
// (`Zest/scene/ztSceneData.h:392`) 이 담는 것:
//
//   simWorldData     Zelus `zsSimulationWorld` 통째 직렬화 (실측 2.1~2.8MB)
//   sceneDataStore   그 시점의 **씬 데이터 전체 사본** (패턴·심·아바타)
//   image            미리보기 (실측 512×512 PNG, 60~75KB)
//   frameNo          그 상태가 몇 프레임째였는가
//
// 실측 — `Zest/testing/sdk/sample.zls` 의 zip 안:
//
//   drapingBoard/drapingBoardHeader                          68 B
//   drapingBoard/222971026478300_101/    "Auto draping item"  2.7MB
//   drapingBoard/1023437106320000_10240/ "advance"            3.4MB
//   drapingBoard/1023470989221200_10991/ "legacy"             2.7MB
//
// ★ 여태 이 워커는 **AUTO 하나만** 적용할 수 있었다. 이름 붙은 나머지는
//   목록에만 나오고 쓸 수가 없었다 — 데스크톱 앱의 `Draping board` 패널은
//   아무거나 골라 Apply 하는데(`MainGUI.cpp:197-203`) 우리 쪽만 못 했다.
//   그 구멍을 `loadDraping` 의 **선택 인자 `uuid`** 로 메운다. 인자가 없으면
//   여태와 똑같이 AUTO 를 적용한다 — 옛 클라이언트가 그대로 돈다.
//
// ⚠️ 아이템이 **없는 씬도 있다.** 그때는 에러가 아니다 — 씬이 잘못된 것이
//    아니라 저장된 드레이프가 없을 뿐이고, 화면은 그 상태로도 정상 동작해야
//    한다. `ok:true` + `applied:false` + 사유로 답한다. 에러로 만들면
//    게이트웨이가 로드 실패와 구분하지 못한다.
//
// ⚠️ **이름 없는 아이템은 목록에 안 나온다.** `ZestManager::GetDrapingItems`
//    (`zelusSandBox/ZestManager.cpp:414`)가 이름이 빈 항목을 거른다. 그 필터를
//    그대로 쓰는 이유는 데스크톱 앱과 같은 목록이 나와야 해서다. 갓 만들어진
//    빈 AUTO 아이템이 여기 해당하고, 목록에 없으니 고를 수도 없다 — 고를 것이
//    없는 게 맞다(이름이 없으면 화면에서 구별할 방법도 없다).
//
// ⛔ **`applied:true` 를 "솔버 상태까지 복원됐다" 로 읽지 말 것.** 엔진의
//    `ztSimulationManager::LoadDrapingItem`
//    (`Zest/simulation/ztSimulationManager.cpp:482`)이 돌려주는 값은 변수
//    이름이 `noShield` 이고 **성공 여부가 아니다** — 시뮬이 돌고 있거나
//    `zsDeserializeBinaryBuffer` 가 실패해도 `true` 로 빠져나간다. 그래서
//    응답에 엔진이 말하는 `activeUuid` 를 같이 싣는다. 다만 그것도
//    `SetActiveDrapingItem` 이 먼저 바꾸므로 **"씬이 그 아이템으로 갈아탔다"**
//    까지가 증거이고, 솔버 월드가 실제로 풀렸는지는 프레임을 받아야 안다.

/**
 * 이미지 바이트의 매직으로 형식을 가린다.
 *
 * ⚠️ **엔진에 물어볼 수 없다.** `ztImage::FileType()` 이 있지만
 *    `SetCompressData`(`Zest/common/ztImage.cpp:225`)가 그 필드를 안 채운다 —
 *    `Clear()` 가 `UNKNOWN` 으로 돌려놓은 채로 남는다. 즉 `.zls` 에서 온
 *    이미지의 `FileType()` 은 **언제나 UNKNOWN** 이고, 그걸 믿으면 브라우저에
 *    쓸모없는 MIME 을 물려 그림이 안 뜬다.
 *
 * @return 매직이 맞으면 MIME, 모르는 형식이면 nullptr
 */
const char* SniffImageMime(const std::vector<char>& data)
{
    const std::size_t n = data.size();
    const unsigned char* p = reinterpret_cast<const unsigned char*>(data.data());

    if (n >= 8 && p[0] == 0x89 && p[1] == 0x50 && p[2] == 0x4E && p[3] == 0x47
               && p[4] == 0x0D && p[5] == 0x0A && p[6] == 0x1A && p[7] == 0x0A)
    {
        return "image/png";   // 실측 sample.zls 의 3개가 전부 이것이다
    }
    if (n >= 3 && p[0] == 0xFF && p[1] == 0xD8 && p[2] == 0xFF)
    {
        return "image/jpeg";  // ztImage::Save 의 기본값이 JPEG 이라 있을 수 있다
    }
    return nullptr;
}

/** 드레이핑 아이템 목록과 지금 활성인 것. 되읽기용이므로 부작용이 없다 */
json ReadDraping(ZestManager& manager)
{
    ztSceneQueryInterface* qi = QueryInterface(manager);
    json items = json::array();

    for (const auto& entry : manager.GetDrapingItems())
    {
        json item{
            { "uuid",   entry.first.GetString() },
            { "name",   entry.second },
            { "isAuto", entry.first == ztDrapingItem::AUTO_ITEM_UUID },
        };

        // 목록에서 **고를 수 있으려면** 이름만으로는 모자란다 — 언제 저장한
        // 것인지, 몇 프레임째였는지, 미리보기가 있는지.
        //
        // ★ **썸네일 바이트는 여기 싣지 않는다.** 개당 60~75KB 라 3개만 돼도
        //   목록 응답이 200KB 를 넘고, 그 값을 **목록을 열 때마다** 다시 문다.
        //   `drapingThumbnail` op 으로 갈라 화면이 필요할 때 하나씩 받는다.
        if (qi != nullptr)
        {
            if (const ztDrapingItem* full = qi->GetDrapingItem(entry.first))
            {
                item["frameNo"] = full->frameNo;

                // ⚠️ 기본 `ztDateTime` 은 1970-01-01 이고 `AsUnixTime()` 은
                //    그때 0 을, 무효값이면 -1 을 준다. 0 을 그대로 실으면
                //    화면이 "1970년에 저장됨" 이라고 말한다 — 없는 편이 낫다.
                const long long savedAt = (long long)full->dateTime.AsUnixTime();
                if (full->dateTime.IsValid() && savedAt > 0)
                {
                    item["savedAt"] = savedAt;   // unix 초
                }

                const ztImage& img  = full->image;
                const char*    mime = img.IsCompressed() ? SniffImageMime(img.GetData()) : nullptr;

                if (mime != nullptr && !img.GetData().empty())
                {
                    item["thumbnail"] = json{
                        { "width",  img.Width() },
                        { "height", img.Height() },
                        { "bytes",  (long long)img.GetData().size() },
                        { "mime",   mime },
                    };
                }
            }
        }

        items.push_back(std::move(item));
    }

    json out{
        { "items", items },
        { "count", (int)items.size() },
    };

    // 엔진이 말하는 활성 아이템. **이것이 적용 여부의 증거다** — 요청한
    // uuid 를 메아리치면 엔진이 아무 일도 안 했을 때조차 성공으로 보인다.
    if (qi != nullptr)
    {
        out["activeUuid"] = qi->GetActiveDrapingItemUuid().GetString();

        if (const ztDrapingItem* active = qi->GetActiveDrapingItem())
        {
            out["activeName"] = active->name.toStdString();
        }
    }

    return out;
}

/**
 * uuid 문자열로 목록에서 아이템을 찾는다.
 *
 * ⚠️ **문자열을 `ztUuid` 로 되파싱하지 않는다.** `ztUuidSaver::Convert(string)`
 *    이 있지만 `ztUuid::GetString()` 과 같은 형식이라는 보장이 헤더에 없다 —
 *    `setSurfaceSize` 가 같은 이유로 목록을 훑는다. 형식이 어긋나면 "없는
 *    아이템" 으로 조용히 실패하는데, 그 증상이 화면에서는 "눌렀는데 아무 일도
 *    안 일어난다" 로만 보인다. 아이템 3개짜리 선형 탐색이라 비용도 없다.
 *
 * ★ 이름을 같이 돌려주는 것이 **필수다.** `ZestManager::LoadDrapingItem` 은
 *   uuid 로 찾은 아이템의 이름이 인자와 같을 때만 적용한다
 *   (`ZestManager.cpp:433`). 이름을 지어내면 조용히 아무 일도 안 일어난다.
 */
bool FindDrapingItem(ZestManager& manager, const std::string& uuid,
                     std::pair<ztUuid, std::string>& out)
{
    for (const auto& entry : manager.GetDrapingItems())
    {
        if (entry.first.GetString() == uuid)
        {
            out = entry;
            return true;
        }
    }
    return false;
}

/**
 * 드레이핑 아이템을 적용한다. `uuid` 가 없으면 자동 아이템을 고른다.
 *
 * 응답은 **적용 후 상태를 되읽어** 싣는다(setAvatarBody·setSurfaceSize 와
 * 같은 규약). 실패해도 예외를 던지지 않고 `applied:false` + 사유로 답한다.
 *
 * 사유는 셋이고 **셋 다 다른 화면을 뜻한다**:
 *   noAutoItem  씬에 자동 드레이프가 없다. **인자 없이 불렀을 때만** 난다
 *   notFound    준 uuid 가 목록에 없다. 클라이언트가 틀렸다는 뜻이다 —
 *               목록이 낡았거나(씬이 바뀌었다) uuid 를 지어냈다
 *   loadFailed  엔진이 거절했다
 */
json ApplyDrapingItem(ZestManager& manager, const json& req)
{
    const bool byUuid = req.contains("uuid") && req["uuid"].is_string()
                        && !req["uuid"].get<std::string>().empty();

    std::pair<ztUuid, std::string> target;

    if (byUuid)
    {
        if (!FindDrapingItem(manager, req["uuid"].get<std::string>(), target))
        {
            json out = ReadDraping(manager);
            out["applied"] = false;
            out["reason"]  = "notFound";
            return out;
        }
    }
    else
    {
        const auto items = manager.GetDrapingItems();

        const auto it = std::find_if(items.begin(), items.end(),
            [](const std::pair<ztUuid, std::string>& p) {
                return p.first == ztDrapingItem::AUTO_ITEM_UUID;
            });

        if (it == items.end())
        {
            json out = ReadDraping(manager);
            out["applied"] = false;
            out["reason"]  = "noAutoItem";   // 씬에 자동 드레이프가 저장돼 있지 않다
            return out;
        }

        target = *it;
    }

    // ★ 크래시 방지용 `ztSimulationManager::Reset()` 은 **우리가 부를 필요가
    //   없다.** 우리가 컴파일하는 `zelusSandBox/ZestManager.cpp:435-437` 의
    //   `LoadDrapingItem` 안에 이미 들어 있고(원본 주석까지 동일),
    //   `consoleApplication` 쪽 구현과 바이트 단위로 같은 코드다.
    const bool loaded = manager.LoadDrapingItem(target.first, target.second);

    json out = ReadDraping(manager);
    out["applied"] = loaded;
    // 무엇을 고르려 했는가. `activeUuid`(엔진이 말하는 것)와 **다를 수 있고**,
    // 다르면 그것 자체가 진단이다.
    out["appliedUuid"] = target.first.GetString();
    if (!loaded) out["reason"] = "loadFailed";
    return out;
}

// 정의는 이 파일 아래쪽(정점 버퍼를 싣는 자리)에 있다. 그쪽으로 옮기지 않고
// 전방 선언만 두는 이유는 순서다 — op 갈래끼리 붙여 두는 편이 읽기 쉽고,
// `Base64` 는 특정 op 의 것이 아니라 공용 도구다.
std::string Base64(const void* data, std::size_t bytes);

/**
 * 아이템 하나의 미리보기 이미지.
 *
 * ── 왜 base64 인가 ──────────────────────────────────────────
 *
 * 이 워커에는 큰 것을 내보내는 길이 둘 있다. 텍스처는 **경로**를 주고
 * (`ReadTextures` 머리말), 정점 버퍼는 **base64** 로 싣는다. 썸네일은
 * 후자다 — 근거는 크기가 아니라 **출처**다:
 *
 *   텍스처   디스크의 파일이다. 경로가 이미 있고, 게이트웨이가 그 파일을
 *            그대로 서빙하면 브라우저 캐시까지 공짜로 붙는다.
 *   썸네일   **메모리에만 있다.** `.zls` zip 안의 바이트를 엔진이 풀어
 *            `ztImage` 로 들고 있을 뿐 파일이 아니다. 경로로 주려면 우리가
 *            임시 파일을 쓰고 언제 지울지를 새로 정해야 한다 — 60KB 를 위해
 *            파일 수명 관리를 하나 더 만드는 셈이다.
 *
 * 60~75KB 가 base64 로 33% 부풀어 ~100KB 다. 아이템 3개를 전부 받아도
 * 300KB 이고, **아이템당 한 번이면 되는 물건이라** 프레임 경로에 없다.
 *
 * ⚠️ 압축되지 않은 이미지는 **내보내지 않는다.** `IsCompressed()` 가 false 면
 *    `mData` 는 인코딩된 파일이 아니라 생픽셀이라 브라우저가 못 읽는다.
 *    PNG 로 인코딩해서 줄 수도 있지만(`zwGltfExporter.cpp` 가
 *    stb_image_write 를 링크한다) **실측에서 한 번도 본 적 없는 경로다** —
 *    안 본 것을 위해 코드를 두는 대신 `hasImage:false` + 사유로 **보이게** 남긴다.
 */
json ReadDrapingThumbnail(ZestManager& manager, const json& req)
{
    const std::string uuid = req.contains("uuid") && req["uuid"].is_string()
                             ? req["uuid"].get<std::string>() : std::string();

    std::pair<ztUuid, std::string> target;

    if (uuid.empty() || !FindDrapingItem(manager, uuid, target))
    {
        return json{
            { "uuid",     uuid },
            { "hasImage", false },
            { "reason",   "notFound" },
        };
    }

    json out{
        { "uuid", target.first.GetString() },
        { "name", target.second },
    };

    ztSceneQueryInterface* qi   = QueryInterface(manager);
    const ztDrapingItem*   full = qi ? qi->GetDrapingItem(target.first) : nullptr;

    if (full == nullptr)
    {
        // 목록에는 있는데 쿼리 인터페이스로는 못 얻었다. 목록이 곧 그 인터페이스
        // 에서 온 것이라 실제로는 안 나야 하지만, 났다면 그것이 사실이다.
        out["hasImage"] = false;
        out["reason"]   = "notFound";
        return out;
    }

    const ztImage& img  = full->image;
    const char*    mime = img.IsCompressed() ? SniffImageMime(img.GetData()) : nullptr;

    if (img.GetData().empty())
    {
        out["hasImage"] = false;
        out["reason"]   = "noImage";            // 미리보기 없이 저장된 아이템
        return out;
    }
    if (mime == nullptr)
    {
        out["hasImage"] = false;
        out["reason"]   = "unsupportedFormat";  // 생픽셀이거나 모르는 매직
        return out;
    }

    out["hasImage"] = true;
    out["width"]    = img.Width();
    out["height"]   = img.Height();
    out["mime"]     = mime;
    out["bytes"]    = (long long)img.GetData().size();
    out["data"]     = Base64(img.GetData().data(), img.GetData().size());
    return out;
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

    // 서피스 → 지금 입고 있는 직물. 서피스 자신은 재질을 모르고 **패턴이 안다**
    // (`ztDesignClothPattern::GetFrontMaterial`), 그래서 한 번 훑어 표를 만든다.
    //
    // ★ 화면이 "이 조각은 지금 어느 원단인가" 를 말하려면 이 값이 필요하다
    //   (UI #50). 없으면 직물 콤보가 **현재값 없이** 서고, 사용자는 뭘 고르고
    //   있는지 모른 채 눌러야 한다.
    //
    // ⚠️ 키가 `meshData` 의 `material.fabricUuid` · `fabrics` 의 `id` 와 **같은
    //    문자열**이어야 셋이 서로 짝지어진다. 실측으로 확인했다 — 셋 다
    //    `ztUuidSaver::Convert` 형식이다(`356925116857200/1500000`).
    //    ⛔ 서피스 uuid 는 이것과 **형식이 다르다**(`GetString()`). 섞지 말 것.
    std::map<std::string, std::string> fabricOf;
    if (ztSceneQueryInterface* qi = QueryInterface(manager))
    {
        for (const auto& entry : qi->GetClothPatterns())
        {
            const ztDesignClothPattern* pattern = entry.second.get();
            if (!pattern) continue;
            const ztDesignSurface* surface = pattern->GetSurface();
            if (!surface) continue;
            const ztDesignMaterial* m = pattern->GetFrontMaterial();
            if (!m) continue;
            fabricOf[surface->GetUuid().GetString()] =
                ztUuidSaver::Convert(m->GetMaterialData().assetUuid);
        }
    }

    for (const auto& entry : manager.GetSurfaceInfos())
    {
        const ztDesignSurface* surface = entry.second.get();
        if (!surface) continue;

        const zsVector2 size = manager.GetSurfaceSize(entry.first);
        json item{
            { "uuid",   entry.first.GetString() },
            { "name",   Utf8(surface->GetData().name) },
            { "width",  size.x },
            { "height", size.y },
        };
        // 없으면 키를 안 싣는다 — 옷과 같은 규약이다. 빈 문자열을 실으면 받는
        // 쪽이 "직물이 없다" 와 "모른다" 를 구분할 수 없다.
        const auto found = fabricOf.find(entry.first.GetString());
        if (found != fabricOf.end()) item["fabricUuid"] = found->second;

        items.push_back(std::move(item));
    }

    return json{ { "surfaces", items } };
}

// ── 직물 목록 (UI #50) ──────────────────────────────────────
//
// **데스크톱과 같은 출처·같은 필터다** (`MainGUI.cpp:1090-1105`):
// `zwMaterialManager::GetFabricRootFolder()` 아래에서 폴더 **둘만** 본다 —
// 프리셋과 씬 내장(in-file). 다른 폴더(사용자 라이브러리 등)를 우리가 임의로
// 더하면 데스크톱과 목록이 갈린다.
//
// ── ★ `zwMaterialManager` 를 쓰는데 GL 에 안 닿는다 ──────────
//
// 이 파일의 다른 자리(`materials-a`)가 **`zwMaterialManager` 를 일부러 피했다** —
// "헤드리스에서 GL 텍스처 생성에 닿는 알려진 위험 경로" 라고 적어 두고 씬에서
// 직접 읽었다. 그 경고는 맞지만 **함수 단위로 갈린다**:
//
//   `ParseFile` → `InitTextureOriginalSize` → `zsTexture::createAndLoadTexture`
//       (zwMaterialManager.cpp:2075)  ← GL. **폴더를 스캔할 때** 돈다
//   `GetFabricRootFolder()`           ← 이미 만들어진 트리를 읽기만 한다
//   `LoadIntoMaterial` → `ConvertToDesignMaterialData` (:1169)
//       ← 경로 문자열과 스칼라만 만든다. **GL 없음**
//
// 폴더 스캔은 `ZestManager::Initialize()` 때 이미 끝나 있고 그것이 헤드리스에서
// 통과한다는 것은 확인된 사실이다. 그래서 이 두 접근자는 안전하다.
//
// ⚠️ **텍스처 파일이 실제로 있는지 함께 싣는다.** 프리셋 직물이 가리키는
//    `Default_Base_Color.png` 가 **이 설치본에 없다** — 액세서리 작업에서
//    그것 때문에 게이트웨이가 거절하고 화면에 `⚠ 거절 1칸` 이 떴다. 없는 것을
//    고를 수 있게 두면 같은 잡음이 사용자 손에서 재현된다. 고르기 전에 알 수
//    있어야 한다.

/** 폴더 하나 안의 직물을 `out` 에 담는다 */
void CollectFabrics(const std::shared_ptr<zwMaterialFolder>& folder,
                    const char* source, json& out)
{
    if (!folder) return;

    for (const auto& zfm : folder->zfms)
    {
        if (!zfm) continue;

        // 앞면 basecolor 의 텍스처 경로. 없으면 색만 있는 직물이다.
        const ztString texPath =
            zwFabricMaterial::TryGetTexturePath(zfm->front.basecolor, zfm->pathToZfm);
        const std::string tex = texPath.toStdString();

        out.push_back(json{
            { "id",     Utf8(zfm->id) },
            { "name",   Utf8(zfm->name) },
            // `preset` / `inFile`. 화면이 둘을 갈라 보여줄 수 있어야 한다 —
            // 씬 내장은 이 옷이 실제로 쓰는 직물이고 프리셋은 라이브러리다.
            { "source", source },
            { "custom", zfm->isCustom },
            { "hasTexture", !tex.empty() },
            // ⚠️ **경로가 있다고 파일이 있는 것이 아니다** (위 주석). 화면이
            //    이 값으로 "고르면 무늬가 빠진다" 를 미리 말할 수 있다.
            { "textureExists", !tex.empty() && std::filesystem::exists(std::filesystem::u8path(tex)) },
        });
    }
}

/** id 로 직물 하나를 찾는다. 못 찾으면 null (목록과 **같은 두 폴더**만 본다) */
std::shared_ptr<zwFabricMaterial> FindFabric(const std::string& id)
{
    const std::shared_ptr<zwMaterialFolder> root = zwMaterialManager::GetFabricRootFolder();
    if (!root || id.empty()) return nullptr;

    for (const auto& folder : root->Folders)
    {
        if (!folder) continue;
        if (folder->Name != zwMaterialManager::ZS_PRESET_FOLDER_NAME
            && folder->Name != zwMaterialManager::ZS_IN_FILE_FOLDER_NAME) continue;

        for (const auto& zfm : folder->zfms)
        {
            // 목록이 실은 것과 **같은 문자열**로 찾는다. 여기서 다른 키를 쓰면
            // 화면이 고른 것과 우리가 찾는 것이 갈린다.
            if (zfm && Utf8(zfm->id) == id) return zfm;
        }
    }
    return nullptr;
}

json ReadFabrics()
{
    json items = json::array();

    const std::shared_ptr<zwMaterialFolder> root = zwMaterialManager::GetFabricRootFolder();
    if (root)
    {
        for (const auto& folder : root->Folders)
        {
            if (!folder) continue;
            if (folder->Name == zwMaterialManager::ZS_PRESET_FOLDER_NAME)
                CollectFabrics(folder, "preset", items);
            else if (folder->Name == zwMaterialManager::ZS_IN_FILE_FOLDER_NAME)
                CollectFabrics(folder, "inFile", items);
        }
    }

    return json{ { "fabrics", items } };
}

/**
 * 서피스 하나에 직물을 입힌다 (UI #50).
 *
 * 데스크톱과 **같은 3단계**다(`MainGUI.cpp:298-312`):
 *   ① 고른 직물(`zwFabricMaterial`)을 찾고
 *   ② `LoadIntoMaterial` 로 `ztDesignMaterialData` 로 바꾼 뒤
 *   ③ `ZestManager::SetFabricMaterial(surfaceUuid, data)` 에 넘긴다
 *
 * **한 번에 서피스 하나다.** `setSurfaceSize` 와 같은 판단이다 — 여러 개를 모아
 * 보내면 중간에 하나가 실패했을 때 "일부만 적용됨" 이라는 상태를 화면이
 * 표현해야 하는데, 하나씩 보내면 그 상태가 아예 생기지 않는다. 데스크톱도
 * 콤보 하나에 서피스 하나다.
 *
 * ── ★ 되읽어서 실어 준다 ────────────────────────────────────
 *
 * 이 파일의 규약이다 — 요청값을 메아리치면 엔진이 아무 일도 안 했을 때조차
 * 성공으로 보인다. 적용 뒤 그 서피스를 쓰는 패턴의 `GetFrontMaterial()` 을
 * 다시 읽어 색과 텍스처를 응답에 담는다.
 *
 * ⚠️ **화면이 이 응답만으로 새 색을 그리지는 못한다.** 옷 색은 `meshData` 의
 *    `topology` 페이로드 안에 있고, 클라이언트는 그것을 최초 1회만 받는다
 *    (그렇게 정한 근거가 "한 세션 안에서 상수" 였는데 이 op 이 그 근거를
 *    깨뜨린다 — meshData 주석에 예고돼 있다). **그래서 화면은 적용 뒤
 *    `restageTopology` 로 토폴로지를 다시 받아야 한다.** L-3d 가 옷 사이즈
 *    때문에 만들어 둔 그 갈래를 그대로 쓰면 된다(씬을 다시 열지 않는다).
 *    안 부르면 증상은 **"적용 버튼이 안 먹는다"** 로 보인다.
 */
json SetSurfaceFabric(ZestManager& manager, ztSceneQueryInterface* qi,
                      const std::string& surfaceUuidStr, const std::string& fabricId,
                      bool& ok, std::string& error)
{
    ok = false;

    const std::shared_ptr<zwFabricMaterial> zfm = FindFabric(fabricId);
    if (!zfm)
    {
        error = "직물을 찾을 수 없습니다: " + fabricId;
        return json::object();
    }

    // ⚠️ **uuid 문자열을 되파싱하지 않는다** — 위 `ReadSurfaces` 머리말의 규칙을
    //    그대로 따른다. `ztUuidSaver::Convert(string)` 이 `GetString()` 과 같은
    //    형식이라는 보장이 헤더에 없고, 어긋나면 "없는 서피스" 로 조용히 실패해
    //    화면에서는 "적용했는데 아무 일도 안 일어난다" 로만 보인다. 목록을 돌며
    //    비교하면 그 위험이 원리적으로 없다(서피스 24개, 비용 없음).
    // ⚠️⚠️ **`ReadSurfaces` 가 싣는 것과 같은 함수로 비교해야 한다.** 저쪽은
    //    `entry.first.GetString()` 이고 `ztUuidSaver::Convert` 와 **형식이 다르다** —
    //    실측: 같은 서피스가 `007C7IvlTV0/000000000W3`(GetString) 와
    //    `356924893322900/150000`(Convert) 로 나온다. 처음에 Convert 로 비교했다가
    //    전부 "서피스를 찾을 수 없습니다" 로 떨어졌다. 위 머리말이 경고한 그
    //    함정에 **경고를 적어 둔 파일 안에서** 걸린 것이다.
    ztUuid surfaceUuid;
    bool found = false;
    for (const auto& entry : manager.GetSurfaceInfos())
    {
        if (entry.first.GetString() != surfaceUuidStr) continue;
        surfaceUuid = entry.first;
        found = true;
        break;
    }
    if (!found)
    {
        error = "서피스를 찾을 수 없습니다: " + surfaceUuidStr;
        return json::object();
    }

    ztDesignMaterialData data;
    // ⚠️ 기본 생성자가 프리셋 직물의 텍스처를 이미 물고 있다(액세서리에서 밟았다).
    //    여기서는 `LoadIntoMaterial` 이 **통째로 대입**하므로(`*material = ...`)
    //    남지 않는다 — 그래도 이 사실은 적어 둔다. 직접 채우는 코드가 생기면
    //    다시 문제가 된다.
    zwMaterialManager::LoadIntoMaterial(&data, *zfm);
    manager.SetFabricMaterial(surfaceUuid, data);

    // ── 되읽기 ──────────────────────────────────────────────
    json applied = json::object();
    if (qi)
    {
        for (const auto& entry : qi->GetClothPatterns())
        {
            const ztDesignClothPattern* pattern = entry.second.get();
            if (!pattern) continue;
            // 위와 같은 이유로 `GetString()` 이다.
            const ztDesignSurface* surface = pattern->GetSurface();
            if (!surface || surface->GetUuid().GetString() != surfaceUuidStr) continue;

            if (const ztDesignMaterial* m = pattern->GetFrontMaterial())
            {
                const ztDesignMaterialData& d = m->GetMaterialData();
                // ⚠️ `basecolor` 는 `zsVector4` 라 `.r/.g/.b` 가 아니라 `.x/.y/.z` 다.
                //    `.w` 는 불투명도가 아니다 — 그건 `alpha` 다(meshData 주석 참고).
                applied = json{
                    { "fabricUuid", ztUuidSaver::Convert(d.assetUuid) },
                    { "color", json::array({ d.basecolor.x, d.basecolor.y, d.basecolor.z }) },
                    { "roughness", d.roughness },
                    { "hasTexture", !d.basecolorTexture.empty() },
                };
            }
            break;
        }
    }

    ok = true;
    return json{
        { "surface",  surfaceUuidStr },
        { "fabricId", fabricId },
        { "name",     Utf8(zfm->name) },
        // 되읽은 값. 비어 있으면 그 서피스를 쓰는 패턴을 못 찾았다는 뜻이다.
        { "applied",  applied },
    };
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

// ── 텍스처 필드 덤프 (조사용, `texturesRaw:true` 일 때만) ──────────
//
// 실시간 뷰는 흰 몸 + 단색 옷인데 스냅샷(glTF)에는 피부·눈·직물 무늬가 다
// 나온다. 그 차이가 텍스처이고, **워커가 그 이미지에 어떻게 닿는지**를 아직
// 모른다. `ztDesignMaterialData` 에 텍스처 자리가 9종 있다(ztDesignMaterial.h:60-84)
// — 여기를 통째로 찍어 경로인지 원시 데이터인지 빈 칸인지 눈으로 본다.
//
// ⚠️ `isRawData == true` 면 그 std::string 들이 **경로가 아니라 이미지 바이트**다
//    (헤더 주석: "if true, then all string textures contain raw data").
//    통째로 실으면 응답이 수십 MB 가 되고, 게다가 바이너리라 nlohmann 이
//    UTF-8 이 아닌 바이트를 dump 할 때 예외(type_error.316)를 던져 **응답
//    자체가 사라진다.** 그래서 길이와 앞부분만 싣고, 앞부분도 출력 가능한
//    ASCII 가 아니면 hex 로 바꾼다.
//
// ★ **이건 조사용이고, 실제 전송 형태는 아래 `TextureTable` 이다.**
//   조사가 끝나 답이 나왔으므로(경로였다) 기본 경로는 이제 그쪽이다. 그래도
//   지우지 않는 이유는 남은 미지수가 있어서다 — 색과 텍스처를 엔진이 어떻게
//   섞는지(`useCustomBaseColor=false` 인데 색과 basecolor 가 공존한다)와
//   roughness/specular/bump 를 쓸지가 아직 안 정해졌다. 다시 재야 할 때
//   `tools/probe-texture.ts` 가 이 플래그를 켠다.
namespace
{

constexpr std::size_t kTexHeadChars = 200;   // 경로면 이 안에 다 들어온다
constexpr std::size_t kTexHexBytes  = 32;    // 바이너리면 매직넘버만 보면 된다

/** 텍스처 문자열 하나 — 길이 + (읽을 수 있으면) 앞부분, 아니면 hex. */
json TextureStringJson(const std::string& s)
{
    json j{ { "len", s.size() } };
    if (s.empty()) return j;

    const std::size_t headLen = (std::min)(s.size(), kTexHeadChars);

    bool printable = true;
    for (std::size_t i = 0; i < headLen; ++i)
    {
        const unsigned char c = static_cast<unsigned char>(s[i]);
        if (c < 0x20 || c > 0x7E) { printable = false; break; }
    }

    if (printable)
    {
        j["head"]      = s.substr(0, headLen);
        j["truncated"] = (s.size() > headLen);
    }
    else
    {
        // 이미지 원시 데이터로 의심된다 — 앞 몇 바이트로 포맷을 알 수 있다
        // (PNG 89 50 4E 47, JPEG FF D8 FF).
        static const char* kHex = "0123456789ABCDEF";
        std::string hex;
        const std::size_t n = (std::min)(s.size(), kTexHexBytes);
        hex.reserve(n * 3);
        for (std::size_t i = 0; i < n; ++i)
        {
            const unsigned char c = static_cast<unsigned char>(s[i]);
            hex.push_back(kHex[c >> 4]);
            hex.push_back(kHex[c & 0x0F]);
            hex.push_back(' ');
        }
        j["binary"] = true;
        j["hex"]    = hex;
    }
    return j;
}

/** UDIM 때문에 9종 모두 벡터다. 원소 수와 각 원소를 그대로 보인다. */
json TextureVectorJson(const std::vector<std::string>& v)
{
    json items = json::array();
    for (const std::string& s : v) items.push_back(TextureStringJson(s));
    return items;
}

} // namespace

/** 머티리얼의 텍스처 관련 필드 전부. 조사용이라 해석하지 않고 날것으로 싣는다. */
json MaterialTextureJson(const ztDesignMaterialData& d)
{
    return json{
        // ★ 이 다섯이 갈래를 가른다: isRawData 면 위 문자열이 이미지 바이트,
        //   아니면 경로. isInMemory / isCustom 은 그 경로가 어느 뿌리에서
        //   시작하는지(프리셋 / 커스텀 / 씬 안)를 가른다.
        { "isRawData",          d.isRawData },
        { "isInMemory",         d.isInMemory },
        { "isCustom",           d.isCustom },
        { "isZipperFabric",     d.isZipperFabric },
        { "useCustomBaseColor", d.useCustomBaseColor },
        { "flipTextures",       d.flipTextures },

        // 직물의 물리 크기(cm). 텍스처를 UV 에 몇 번 반복할지가 여기서 나온다.
        { "physicalWidth",  d.width },
        { "physicalHeight", d.height },

        { "vectors", {
            { "basecolor",       TextureVectorJson(d.basecolorTexture) },
            { "roughness",       TextureVectorJson(d.roughnessTexture) },
            { "specular",        TextureVectorJson(d.specularTexture) },
            { "metalness",       TextureVectorJson(d.metalnessTexture) },
            { "normal",          TextureVectorJson(d.normalTexture) },
            { "alpha",           TextureVectorJson(d.alphaTexture) },
            { "displacement",    TextureVectorJson(d.displacementTexture) },
            { "anisotropyAngle", TextureVectorJson(d.anisotropyAngleTexture) },
            { "occlusion",       TextureVectorJson(d.occlusionTexture) },
        } },

        // USDZ 등에서 "이름만" 따로 두는 자리(헤더 주석). 벡터 쪽이 원시
        // 데이터일 때 여기에 원래 파일명이 남아 있을 수 있다 — 갈래 C 의 실마리.
        { "paths", {
            { "basecolor",       TextureStringJson(d.basecolorTexturePath) },
            { "roughness",       TextureStringJson(d.roughnessTexturePath) },
            { "specular",        TextureStringJson(d.specularTexturePath) },
            { "metalness",       TextureStringJson(d.metalnessTexturePath) },
            { "normal",          TextureStringJson(d.normalTexturePath) },
            { "alpha",           TextureStringJson(d.alphaTexturePath) },
            { "displacement",    TextureStringJson(d.displacementTexturePath) },
            { "anisotropyAngle", TextureStringJson(d.anisotropyAngleTexturePath) },
            { "occlusion",       TextureStringJson(d.occlusionTexturePath) },
        } },
    };
}

// ── 텍스처 표 (실제 전송 형태, `textures:true`) ─────────────────────
//
// 조사(`texturesRaw`)가 답을 냈다: **전부 디스크 파일이고 워커는 경로만 실으면
// 된다.** 이미지를 읽지도 base64 하지도 않는다 — 그러면 응답이 19.7MB 가 되고,
// 무엇보다 **체형을 바꿀 때마다 다시 실리게 된다.** 텍스처는 체형이 바뀌어도
// 안 변하므로 그 비용은 순수한 낭비다. 경로만 싣고 게이트웨이가 정적으로
// 서빙하면 브라우저 캐시가 두 번째부터 0 바이트로 만든다.
//
// ── 왜 표(별도 배열)인가 — 같은 파일이 여러 번 나온다 ────────────
// `eyelashes_alp.png` 는 **한 파트 안에서 basecolor 와 alpha 두 슬롯에** 들어
// 있고, 좌우 속눈썹·좌우 눈이 같은 파일을 또 공유한다. 머티리얼에 경로를
// 인라인하면 받는 쪽이 같은 이미지를 몇 번씩 내려받거나, 중복 제거를 스스로
// 해야 한다. 표를 따로 두고 머티리얼이 **색인**만 갖게 하면 그 문제가 원리적으로
// 사라지고, 게이트웨이도 파일당 한 번만 등록하면 된다.
//
// ── 상대경로를 여기서 푼다 ──────────────────────────────────────
// 옷 직물은 `fabric_infile/CS-00120.png` 처럼 **상대경로**로 온다. 그 뿌리는
// `ztAssetManager::GetAppdataRoot(true)` 이고(zwMaterialManager.cpp:954 가
// 거기에 "fabric_infile/" 를 붙인다), 그 값을 아는 것은 엔진에 링크된 이
// 프로세스뿐이다. 게이트웨이가 `%LOCALAPPDATA%` 로 추측하게 두면 exe 이름이
// 바뀌는 날 조용히 어긋난다 — **경로는 아는 쪽이 완성해서 보낸다.**
//
// ⚠️ 슬롯을 셋(basecolor·normal·alpha)으로 줄였다. 근거는 아래 kTexSlots 참고.
namespace
{

/**
 * 응답 하나에 실리는 텍스처 파일 표. 경로를 정규화·중복 제거해 모은다.
 *
 * ⚠️ `isRawData` 인 머티리얼(= 문자열이 이미지 바이트)은 **버린다.** 실측된 두
 *    씬에서는 전부 false 였지만, true 인 씬을 만나면 그 바이트를 경로로 착각해
 *    싣게 된다. 출력 가능한 ASCII 인지 보고 아니면 없는 것으로 친다 — 조용히
 *    틀린 경로를 싣는 것보다 텍스처가 안 나오는 편이 화면에서 읽힌다.
 */
class TextureTable
{
public:
    /** 경로 하나를 넣고 색인을 돌려준다. 실을 수 없으면 -1 */
    int Add(const std::string& raw)
    {
        if (raw.empty()) return -1;

        // 원시 바이트 방어. 경로라면 전부 출력 가능한 ASCII 다(한글 경로는
        // UTF-8 이라 여기 걸리지만, 에셋 경로가 한글인 경우가 관측된 적 없고
        // 걸려도 "텍스처 없음" 으로 안전하게 떨어진다).
        for (const char ch : raw)
        {
            const unsigned char c = static_cast<unsigned char>(ch);
            if (c < 0x20 || c > 0x7E) return -1;
        }

        std::string full = IsAbsolute(raw) ? raw : (AppdataRoot() + raw);
        for (char& ch : full) if (ch == '\\') ch = '/';

        const auto it = mIndex.find(full);
        if (it != mIndex.end()) return it->second;

        const int idx = static_cast<int>(mPaths.size());
        mPaths.push_back(full);
        mIndex.emplace(std::move(full), idx);
        return idx;
    }

    bool Empty() const { return mPaths.empty(); }

    json ToJson() const
    {
        json items = json::array();
        for (const std::string& p : mPaths) items.push_back(p);
        return items;
    }

private:
    static bool IsAbsolute(const std::string& s)
    {
        if (s.size() >= 2 && s[1] == ':') return true;              // C:\...
        return !s.empty() && (s[0] == '/' || s[0] == '\\');         // \\서버, /...
    }

    /**
     * `fabric_infile/…` 의 뿌리. 끝에 구분자가 붙은 형태다.
     *
     * 한 번만 묻는다 — 프로세스 수명 안에서 안 바뀌고, 이 함수는 머티리얼마다
     * 불린다. 실측 `%LOCALAPPDATA%\z-emotion\zelusSandBoxd-demo\`.
     */
    static const std::string& AppdataRoot()
    {
        static const std::string root = []() -> std::string {
            const ztString s = ztAssetManager::GetAppdataRoot(true);
            std::string u = Utf8(std::wstring(s.c_str()));
            if (!u.empty() && u.back() != '/' && u.back() != '\\') u.push_back('/');
            return u;
        }();
        return root;
    }

    std::vector<std::string>   mPaths;
    std::map<std::string, int> mIndex;
};

/**
 * 실어 보낼 슬롯 셋.
 *
 * ★ 9종 중 셋만 고른 것은 **용량과 three.js 의 실효 둘 다** 때문이다. 실측
 *   디스크 크기(사용자 씬):
 *     basecolor 10.73MB · normal 1.45 · alpha 1.68   → 실음  (합 13.86MB)
 *     roughness  8.37MB · specular 9.39 · bump 5.84  → 뺌    (합 23.60MB)
 *   빼는 쪽이 넣는 쪽보다 크다. roughness 를 넣으면 첫 로딩이 +60% 인데
 *   `MeshStandardMaterial` 에서 그 맵이 바꾸는 것은 하이라이트의 번짐 정도이고,
 *   specular 는 애초에 대응하는 자리가 없다(`MeshPhongMaterial` 것이다).
 *   bump 는 자리가 있지만(`bumpMap`) 민트 직물에만 있고 5.84MB 다.
 *
 *   ⚠️ 이건 **판단이지 관측이 아니다.** 화면에서 스냅샷과 재질감이 갈리면
 *      여기에 줄을 더하는 것이 첫 수다 — 아래 `MaterialTextureRefs` 에 한 줄,
 *      클라이언트에 한 줄이면 된다.
 *
 * ⚠️ UDIM 때문에 각 슬롯이 벡터인데 **첫 칸만 쓴다.** three.js 에 UDIM 을 그리는
 *    길이 없고, 실측된 두 씬은 전부 원소 1개였다.
 */
json MaterialTextureRefs(const ztDesignMaterialData& d, TextureTable& table)
{
    json refs = json::object();

    const auto put = [&](const char* name, const std::vector<std::string>& v) {
        if (v.empty()) return;
        const int idx = table.Add(v.front());
        if (idx >= 0) refs[name] = idx;
    };

    put("basecolor", d.basecolorTexture);
    put("normal",    d.normalTexture);
    put("alpha",     d.alphaTexture);

    return refs;
}

/**
 * 머티리얼 json 에 텍스처 관련 필드를 얹는다. **셋 다 없으면 아무것도 안 얹는다.**
 *
 * ★ `physicalSizeCm` 이 없으면 무늬 크기가 통째로 틀린다. 옷의 `uvs` 는 0~1 이
 *   아니라 **cm 단위 패턴 좌표**라(cloth.ts 머리말), 텍스처를 몇 번 반복할지는
 *   직물의 물리 크기가 정한다. 실측 노랑 2.114cm / 민트 29.997cm — 같은 옷 안에서
 *   14배 차이다. 이 값을 빼면 받는 쪽이 추측할 방법이 없다.
 */
void AttachTextureFields(json& m, const ztDesignMaterialData& d, TextureTable& table)
{
    json refs = MaterialTextureRefs(d, table);
    if (!refs.empty()) m["textures"] = std::move(refs);

    // 0 이나 음수는 "모른다" 다. 그때 1cm 로 메우면 무늬가 100배로 나온다.
    if (d.width > 0.0f && d.height > 0.0f)
    {
        m["physicalSizeCm"] = { d.width, d.height };
    }

    // ⚠️ 이 둘은 **아직 해석이 안 끝났다.** `useCustomBaseColor=false` 인데
    //    색과 basecolor 텍스처가 공존하는 머티리얼이 있어서, 엔진이 둘을
    //    곱하는지 텍스처가 이기는지 모른다. 싣는 이유는 화면에서 갈랐을 때
    //    받는 쪽이 판단할 재료가 이미 와 있어야 해서다.
    m["useCustomBaseColor"] = d.useCustomBaseColor;
    m["flipTextures"]       = d.flipTextures;
}

} // namespace

// 토폴로지는 프레임 간 고정이므로 최초 1회만 보내면 된다.
// 프레임마다 필요한 건 positions뿐이다.
//
// 패턴 변환(transform)도 같은 이유로 topology 쪽에 붙는다 — 실측상 프레임마다
// 바뀌지 않는다. 근거와 그 가정이 깨졌을 때의 증상은 아래 해당 블록의 주석에 있다.
//
// meshData 응답과 구독 중 frame 이벤트의 mesh 필드가 **같은 함수**를 쓴다.
// zsVector3 재포장(아래)이 두 곳에 복사되면 언젠가 갈라지고, 그때 어긋난
// 쪽은 화면이 깨져야만 드러난다.
json MeshData(ZestManager& manager, bool includeTopology, bool includeTextures = true,
              bool includeTexturesRaw = false)
{
    json patterns = json::array();
    TextureTable textures;

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

                // ★ 직물 무늬. 경로는 아래 표에 모이고 여기엔 색인만 남는다.
                if (includeTextures) AttachTextureFields(m, d, textures);
                // 조사용(`texturesRaw:true`). 이걸 켜면 위 색인 대신 날것이 온다.
                if (includeTexturesRaw) m["texturesRaw"] = MaterialTextureJson(d);

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

    json out{ { "patterns", patterns }, { "topology", includeTopology } };
    // ⚠️ 비어 있으면 키를 아예 안 싣는다 — `[]` 를 보내면 받는 쪽이 "표는 왔는데
    //    빈 것" 과 "이 워커는 텍스처를 모른다" 를 구분할 수 없다.
    if (!textures.Empty()) out["textures"] = textures.ToJson();
    return out;
}

// ── 아바타 메시 (AM-1) ──────────────────────────────────────
//
// 실시간 뷰에는 여태 옷만 떠 있었다. 몸이 없으니 `setAvatarMeasurements` 로
// 체형을 바꿔도 결과를 눈으로 볼 수 없다 — 이 op 이 있는 이유다.
//
// ── ★ 왜 `meshData` 확장이 아니라 새 op 인가 ────────────────
//
//   `MeshData()` 는 **프레임 이벤트의 본체**다(RunProtocolLoop 의
//   `ev["mesh"] = MeshData(manager, false)`). 거기에 아바타를 얹으면 구독
//   중인 클라이언트가 프레임마다 몸을 통째로 받는다. 이미 백프레셔가 걸린
//   대역폭을 통째로 잡아먹는다 — `W_Bra top & Leggings.zls` 실측:
//
//     topology  normals   응답      비고
//     true      true      1,947KB   106ms — 최초 1회용
//     true      false     1,501KB
//     false     true        895KB
//     false     false       448KB    41ms — 형태만 갱신
//     (같은 씬의 meshData topology:false = 212KB = 옷 한 프레임)
//
//   즉 **가장 작은 아바타 응답도 옷 한 프레임의 2.1배**다.
//   `meshData` 에 "아바타 포함" 플래그를 다는 방법도 있지만, 그러면 같은
//   함수가 프레임 경로와 요청 경로에서 다르게 동작하게 되고 그 분기가 곧
//   틀릴 자리가 된다. **보내는 주기가 다르면 op 을 나눈다.**
//
//   대신 `topology` 플래그의 의미는 `meshData` 와 **똑같이** 맞췄다 — 받는
//   쪽 디코더가 두 갈래가 되지 않게 하기 위해서다.
//
// ── 언제 부르는가 (클라이언트 규약) ─────────────────────────
//   · 씬 로드 직후                   — 처음 세운다 (topology:true)
//   · `setAvatarMeasurements` 뒤     — 몸이 다시 만들어진다
//   · `setAvatarBody` 뒤             — 위와 같다
//   · `loadDraping` 뒤               — ⚠️ **포즈가 크게 바뀐다.** 실측:
//                                      팔이 내려오면서 x 범위가 ±61.3 →
//                                      ±29.9cm 로 절반이 됐다. 다시 안 받으면
//                                      옷은 새 자세에 걸리는데 몸만 옛 자세로
//                                      남는다.
//                                      ⓘ 같은 실측에서 아바타 uuid·파트 12개·
//                                      정점 28,564 는 **그대로였다** — 즉 이
//                                      씬에서는 topology:false 로 충분했다.
//                                      (씬 하나의 관측이지 보장이 아니다.
//                                       응답의 uuid/vertices 가 달라졌으면
//                                       topology 를 다시 받을 것.)
//   · 애니메이션 중                  — 포즈가 움직인다. `frameInfo` 로
//                                      끝났는지 판정한다(아래)
//
// ── ⚠️ 부르면 안 되는 것 셋 ─────────────────────────────────
//
//   `IsUpdateRenderMesh()` / `IsForceUpdatedMesh()` 는 `const` 인데 **읽는
//   순간 mutable 플래그를 지운다**(ztDesignAvatar.cpp 의 두 함수 모두
//   `mIsX = false` 를 하고 나간다). 시뮬 실행기가 그 플래그를 소비하므로
//   (ztSimulationStandardCPUExecutor.cpp:1905 의 `isNeedToUpdateAvatar`)
//   워커가 부르면 **시뮬 동작 자체가 바뀐다.**
//
//   ★ 여기에 하나 더 있다 — **`IsAnimationFinished()` 도 같은 부류다.**
//     이름만 보면 순수 조회 같지만 내부에서
//     `IsUpdatedTempVeticesForSimulation()` 을 부르고, 그 함수가
//     `mUpdatedTempVeticesForSimulation = false` 로 지운다
//     (ztDesignAvatar.cpp:64-72, ztDesignZeta.cpp:339). 그리고 그 값은 바로
//     위의 :1905 와 같은 줄에서 쓰인다. **그래서 이 op 은 부르지 않는다.**
//
//     대신 `frameInfo` 를 그대로 싣는다 — `GetFrameInfo()` 는 순수 조회이고,
//     실행기 자신이 애니메이션 종료를 표시할 때 쓰는 판정
//     (`info.first + 1 >= info.second`, :277-280)을 클라이언트가 같은 값으로
//     다시 내릴 수 있다. 부작용 없이 같은 정보를 얻는 길이다.
//
// ── ⚠️ 뮤텍스 — 옷과 다르다 ─────────────────────────────────
//
//   옷은 `GetSimulationOutputMesh()` 가 `ztChangeTracker` 라 `Read()` 가
//   이중버퍼의 안정된 쪽을 준다. **아바타에는 그 보호가 없다.**
//   시뮬 스레드가 `ztGlobalMutex` 를 잡고 `designAvatar->Tick(dt)` 와
//   `UpdateRenderMesh()` 로 정점을 덮어쓴다
//   (ztSimulationStandardCPUExecutor.cpp:266-272, :347-365). 잠그지 않으면
//   상반신은 이번 프레임, 하반신은 다음 프레임인 **찢어진 몸**이 나간다.
//   그래서 추출 전체를 같은 뮤텍스로 감싼다.
//
//   ⚠️ 재진입 불가다(std::mutex). 이 안에서 부르는 엔진 함수가 같은 뮤텍스를
//      잡으면 그대로 데드락이다. 확인했다 — `ztDesignZeta::GetRenderMeshs`
//      → `GetBodySubMesh` 는 잠그지 않고(ztDesignZeta.cpp:456-540),
//      `ztDesignMannequin` 쪽에서 잠그는 것은 `Recompute()` 하나뿐이다
//      (:666). 그러니 이 안에서 **아바타를 바꾸는 함수를 부르면 안 된다.**
//
//   ⓘ `GetRenderMeshs()` 는 매번 **새 메시를 만들어 채워 돌려준다**
//     (`std::make_shared<zsTriMesh>()` + `ConvertToTriMesh`). 즉 복사가
//     락 안에서 끝나므로, 락을 놓은 뒤 그 shared_ptr 를 들고 있어도 안전하다.
//     그래도 base64 인코딩까지 락 안에서 한다 — 코드가 한 덩어리여야
//     "어디까지가 보호 구간인가" 가 헷갈리지 않는다.
//
// ── 좌표계 ──────────────────────────────────────────────────
//
//   ★ **월드다. 변환을 곱하면 안 된다.** 옷(ISSUE-011)과 정반대다.
//
//   근거 둘: (1) glTF 익스포터가 아바타 노드에
//   `ZELUS::zsTransform::Identity()` 를 준다(zwGltfExporterImpl.cpp:521·582
//   — 옷은 :392 에서 `GetTransformIn3D()` 를 준다). (2) `localTransform` 은
//   정점에 **이미 구워져 있다**: 마네킹은
//   `vertices[i] = localTransform * dynamicBodyVertices[i]`
//   (ztDesignMannequin.cpp:1126·1140), 제타는 로드 시
//   `mAvatarManager->SetLocalTransform(...)` (ztDesignZeta.cpp:204).
//
//   그래서 `transform` 키를 아예 싣지 않는다. 실으면 받는 쪽이 곱하고 싶어진다.
//   단위는 옷과 같은 cm 다.
//
// ── 어느 접근자인가 ─────────────────────────────────────────
//
//   `GetRenderMeshs()` 다. `GetMeshes()` 가 아니다.
//   제타에서 둘은 **다른 물건**이다:
//     GetMeshes()     → 시뮬 충돌용 body mesh **1개** (ztDesignZeta.cpp:426)
//     GetRenderMeshs() → 서브머티리얼별로 갈린 렌더 메시 여러 개
//                        (몸 4 + 눈/속눈썹/동공/각막 8 = 12파트)
//   데스크톱 3D 뷰(Renderer3D.cpp:499·551)와 익스포터가 둘 다 렌더 메시를
//   쓴다. 화면에 몸을 세우는 것이 목적이므로 같은 것을 쓴다.
//
//   실측 파트 12개 — Face 4,310 / Body 2,964 / Legs 5,440 / Arms 7,058 /
//   좌우 Eye 1,505 · Lashe 1,812 · Pupil 21 · Cornea 1,058 (합 28,564정점,
//   48,198삼각형). 재질이 파트마다 달라서 합치면 안 된다(속눈썹·각막은
//   alpha 0.5, 동공은 검정).
//
// ── 액세서리 (머리카락·신발·양말·속옷) ──────────────────────
//
//   제타는 몸과 **다른 접근자**로 액세서리를 준다 —
//   `GetRenderAccessoryMeshes()` → `std::vector<ztAccessoryMeshData>`.
//   데스크톱(Renderer3D.cpp:566-)과 익스포터(zwGltfExporterImpl.cpp:530-546)가
//   둘 다 그것을 그리고, 실측한 씬의 glTF 에 `zeta_accessory12` 노드가 있다.
//
//   ⓘ **한동안 일부러 뺐던 자리다.** 이유는 텍스처였다 — 머리카락은
//     basecolor + alpha **이미지**로 그려지는데(알파 컷아웃이 없으면 머리가
//     판때기로 보인다) 프로토콜에 이미지를 싣는 통로가 없었다. 그 통로가
//     생겼으므로(`TextureTable` + 게이트웨이 정적 서빙) 이제 붙인다.
//     **색만 보내면 안 되는 이유는 그대로 유효하다** — 알파를 무시하면
//     머리가 덩어리가 된다.
//
//   ★ 익스포터를 베꼈다. 렌더러가 아니라 익스포터인 이유는 성격이 같아서다
//     — 둘 다 GL 재질을 만들지 않고 `ztDesignMaterialData` 를 **합성해서**
//     내보낸다(:537-541). 그 구조체가 우리 `AvatarMaterialJson` 의 입력이라
//     몸 파트와 **완전히 같은 경로**를 탄다. 새로 만든 코드가 거의 없다.
//
//   ⚠️ 익스포터가 안 하는 널 검사를 우리는 한다. 저쪽은 `mesh.image->path` 를
//      타입 검사 없이 역참조하는데(:540-541), 렌더러는 **Hair 일 때만**
//      이미지를 만진다(Renderer3D.cpp:593-597). 즉 신발·양말에는 이미지가
//      없을 수 있다는 뜻이다 — 저쪽은 1회성 CLI 라 죽어도 티가 안 나지만
//      우리는 상주 워커다. `accessoryInfo` 의 `find_if` 도 마찬가지로
//      `end()` 를 안 보고 역참조한다(:534-535).

/** 아바타 파트의 머티리얼. 옷 쪽(`MeshData`)과 같은 다섯 필드 + 색공간이다. */
json AvatarMaterialJson(const ztDesignMaterialData& d, TextureTable& textures,
                        bool includeTextures = true, bool includeTexturesRaw = false)
{
    json j{
        { "assetUuid",    ztUuidSaver::Convert(d.assetUuid) },
        { "color",        { d.basecolor.x, d.basecolor.y, d.basecolor.z } },
        { "opacity",      d.alpha },
        { "roughness",    d.roughness },
        { "metalness",    d.metalness },
        // 옷과 같은 이유로 해석 규칙을 같이 보낸다 — 값이 아니라 규칙이라
        // 상수처럼 보여도 빼면 받는 쪽이 추측하게 된다.
        { "colorProfile", (d.colorProfile == ztColorProfile::Linear) ? "linear" : "srgb" },
    };

    // ★ 피부·눈·속눈썹. 옷과 **같은 표를 쓴다** — 한 응답 안에서 파일이
    //   중복되면 안 된다는 규칙이 아바타 안에서 특히 중요하다: 속눈썹은 한
    //   파트에서 basecolor·alpha 두 슬롯에 같은 파일을 쓰고, 좌우가 또 그것을
    //   공유한다(같은 파일이 4번 나온다).
    if (includeTextures) AttachTextureFields(j, d, textures);
    // 조사용(`texturesRaw:true`).
    if (includeTexturesRaw) j["texturesRaw"] = MaterialTextureJson(d);

    return j;
}

/**
 * 액세서리 종류 이름. 숫자로 보내지 않는 이유는 옷·파라미터 쪽과 같다 —
 * enum 값은 엔진이 재배열하면 조용히 뜻이 바뀐다.
 *
 * `ztAccessoryType`(ztAvatarCommon.h:129)의 5종 전부다.
 */
const char* AccessoryTypeName(ztAccessoryType t)
{
    switch (t)
    {
    case ztAccessoryType::UnderwearTop:    return "underwearTop";
    case ztAccessoryType::UnderwearBottom: return "underwearBottom";
    case ztAccessoryType::Sock:            return "sock";
    case ztAccessoryType::Shoes:           return "shoes";
    case ztAccessoryType::Hair:            return "hair";
    default:                               return "unknown";
    }
}

/** ztGlobalMutex 를 예외 경로에서도 반드시 놓는다. 이 op 은 try 블록 안이다. */
struct GlobalMutexGuard
{
    GlobalMutexGuard()  { ztGlobalMutex::GetInstance()->Lock(); }
    ~GlobalMutexGuard() { ztGlobalMutex::GetInstance()->Unlock(); }
    GlobalMutexGuard(const GlobalMutexGuard&) = delete;
    GlobalMutexGuard& operator=(const GlobalMutexGuard&) = delete;
};

json AvatarMeshData(ZestManager& manager, bool includeTopology, bool includeNormals,
                    bool includeTextures = true, bool includeTexturesRaw = false)
{
    TextureTable textures;
    json avatars = json::array();

    std::size_t totalV = 0, totalT = 0;

    ztSceneQueryInterface* qi = QueryInterface(manager);
    if (!qi)
    {
        // 씬이 없어도 모양은 같아야 한다 — `MeshData` 와 같은 규약이다.
        return json{
            { "avatars", avatars }, { "topology", includeTopology },
            { "normals", includeNormals },
            { "totalVertices", totalV }, { "totalTriangles", totalT },
        };
    }

    const ztUuid currentUuid = qi->GetCurrentAvatar();

    GlobalMutexGuard lock;

    for (const auto& entry : qi->GetAvatars())
    {
        const ztDesignAvatar* avatar = entry.second.get();
        if (!avatar) continue;

        // 데스크톱 3D 뷰(Renderer3D.cpp:973)와 익스포터
        // (zwGltfExporterImpl.cpp:498)가 쓰는 것과 **같은 필터**다.
        // 여기서 갈라지면 화면과 스냅샷에 다른 몸이 선다.
        if (!avatar->JoinInSimulation()) continue;

        const bool isZeta = (avatar->GetSubType() == ztAvatarSubType::Zeta);

        // 제타는 서브머티리얼 배열이 파트와 1:1이고, 마네킹은 파트 인덱스로
        // 하나씩 받는다. 익스포터·렌더러의 두 갈래를 그대로 옮긴 것이다.
        const ztDesignZeta*      zeta      = dynamic_cast<const ztDesignZeta*>(avatar);
        const ztDesignMannequin* mannequin = dynamic_cast<const ztDesignMannequin*>(avatar);

        std::vector<ztDesignMaterialData> zetaMaterials;
        if (zeta) zetaMaterials = zeta->GetBodySubMaterials();

        const std::vector<std::shared_ptr<ZELUS::zsTriMesh>> meshes = avatar->GetRenderMeshs();

        json parts = json::array();

        std::size_t avatarV = 0, avatarT = 0;
        float lo[3] = {  1e30f,  1e30f,  1e30f };
        float hi[3] = { -1e30f, -1e30f, -1e30f };

        // ★ 몸 파트와 액세서리가 **같은 포장을 쓴다.** 둘은 접근자만 다르고
        //   (`GetRenderMeshs` vs `GetRenderAccessoryMeshes`) 실체는 같은
        //   `zsTriMesh` 다 — `ztSimulMesh : public ZELUS::zsTriMesh`.
        //   여기를 갈라 두면 아래 쓰레기 정점 AABB 규칙이나 법선 규약을
        //   한쪽에만 고치는 사고가 난다.
        //
        // 인자 셋이 갈래를 만든다:
        //   `material`   없으면 `material` 키를 아예 안 싣는다(옷과 같은 규약).
        //   `uvFallback` 액세서리 전용 — `ztAccessoryMeshData` 는 `texcoords` 를
        //                메시 **밖에** 따로 들고 있다. 메시에 uv 가 없을 때만 본다.
        //   `extra`      파트 json 에 얹을 추가 필드(액세서리의 종류·양면 여부).
        const auto packPart = [&](const ZELUS::zsTriMesh* mesh, int index,
                                  const std::string& name,
                                  const ztDesignMaterialData* material,
                                  const std::vector<ZELUS::zsVector2>* uvFallback,
                                  const json* extra) -> void
        {
            if (!mesh) return;

            const std::size_t nv = static_cast<std::size_t>(mesh->vertices.size());
            const std::size_t ni = static_cast<std::size_t>(mesh->indices.size());

            // 익스포터가 같은 검사로 건너뛴다(:515·567). 빈 파트를 실으면
            // 받는 쪽이 정점 0짜리 지오메트리를 만들게 된다.
            if (nv == 0 || ni == 0) return;

            avatarV += nv;
            avatarT += ni / 3;

            json p{
                { "index",     index },
                { "name",      name },
                { "vertices",  nv },
                { "triangles", ni / 3 },
            };

            if (extra)
                for (auto it = extra->begin(); it != extra->end(); ++it) p[it.key()] = it.value();

            // zsVector3는 SIMD 정렬 때문에 16바이트다. 옷과 **같은 이유로**
            // float3로 다시 포장한다 — 그대로 보내면 4바이트씩 어긋난다.
            {
                std::vector<float> tight;
                tight.reserve(nv * 3);
                for (std::size_t k = 0; k < nv; ++k)
                {
                    const ZELUS::zsVector3& v = mesh->vertices[static_cast<int>(k)];
                    tight.push_back(v.x);
                    tight.push_back(v.y);
                    tight.push_back(v.z);
                }
                p["positions"]      = Base64(tight.data(), tight.size() * sizeof(float));
                p["positionStride"] = 12;
            }

            // ── AABB는 **인덱스가 가리키는 정점만** 본다 ─────────────
            //
            // ⚠️ 아바타 정점 버퍼에는 **어떤 삼각형도 참조하지 않는 쓰레기
            //    정점이 섞일 수 있다.** glTF 익스포터가 그 사실을 알고 있고,
            //    POSITION 접근자의 min/max를 구할 때 일부러 `for (int i :
            //    trimesh->indices)` 로 돌린다(zwGltfExporterImpl.cpp:1691-1697
            //    의 주석 "There can be garbage vertices in vertex buffer").
            //
            //    전체 정점으로 재면 상자가 엉뚱하게 커지고, 화면은 그 상자로
            //    카메라를 맞추므로 **몸이 화면 구석에 조그맣게 박힌다** —
            //    에러도 경고도 없이 "왜 이렇게 멀지" 로만 보인다.
            //
            //    쓰레기 정점 자체는 그대로 싣는다. 인덱스가 안 가리키므로
            //    그리지 않고, 빼면 인덱스를 전부 다시 매겨야 한다.
            for (std::size_t k = 0; k < ni; ++k)
            {
                const ZELUS::zsInt idx = mesh->indices[static_cast<int>(k)];
                if (idx < 0 || static_cast<std::size_t>(idx) >= nv) continue;

                const ZELUS::zsVector3& v = mesh->vertices[idx];
                lo[0] = (std::min)(lo[0], v.x); hi[0] = (std::max)(hi[0], v.x);
                lo[1] = (std::min)(lo[1], v.y); hi[1] = (std::max)(hi[1], v.y);
                lo[2] = (std::min)(lo[2], v.z); hi[2] = (std::max)(hi[2], v.z);
            }

            // ★ 법선은 topology 가 아니라 **positions 와 한 몸**이다.
            //   몸은 포즈·체형에 따라 휘므로 정점이 바뀌면 법선도 바뀐다.
            //   토폴로지 쪽에 붙이면 최초 1회 받은 법선이 남아 **몸은 움직이는데
            //   음영만 옛 자세로 고정**되는, 화면에서만 드러나는 오류가 된다.
            //
            //   대신 끌 수 있게 했다(`normals:false`). 위치와 같은 크기라
            //   응답이 두 배가 되기 때문이다. 끄면 클라이언트가
            //   computeVertexNormals 로 대신할 수 있다 — 다만 UV 이음매에서
            //   각지게 보인다(엔진 법선은 그 자리를 부드럽게 잇는다).
            if (includeNormals && mesh->normals.size() == mesh->vertices.size() && nv > 0)
            {
                std::vector<float> tight;
                tight.reserve(nv * 3);
                for (std::size_t k = 0; k < nv; ++k)
                {
                    const ZELUS::zsVector3& n = mesh->normals[static_cast<int>(k)];
                    tight.push_back(n.x);
                    tight.push_back(n.y);
                    tight.push_back(n.z);
                }
                p["normals"]      = Base64(tight.data(), tight.size() * sizeof(float));
                p["normalStride"] = 12;
            }

            if (includeTopology)
            {
                p["indices"]     = Base64(&mesh->indices[0], ni * sizeof(ZELUS::zsInt));
                p["indexStride"] = static_cast<int>(sizeof(ZELUS::zsInt));

                if (mesh->uvs.size() > 0)
                {
                    p["uvs"] = Base64(&mesh->uvs[0],
                                      static_cast<std::size_t>(mesh->uvs.size())
                                          * sizeof(ZELUS::zsVector2));
                }
                else if (uvFallback && !uvFallback->empty())
                {
                    // 액세서리 갈래. 여기까지 왔다는 것은 메시가 uv 를 안 들고
                    // 있다는 뜻이고, 그러면 무늬가 한 점에 뭉쳐 단색이 된다.
                    p["uvs"] = Base64(uvFallback->data(),
                                      uvFallback->size() * sizeof(ZELUS::zsVector2));
                }

                // ⚠️ 머티리얼이 없으면 키를 아예 싣지 않는다 — 옷과 같은 규약.
                //    흰색을 대신 보내면 "흰 몸"과 "색을 모름"이 구분되지 않는다.
                if (material)
                    p["material"] = AvatarMaterialJson(*material, textures,
                                                       includeTextures, includeTexturesRaw);
            }

            parts.push_back(std::move(p));
        };

        // ── 몸 ─────────────────────────────────────────────────
        for (std::size_t i = 0; i < meshes.size(); ++i)
        {
            // 마네킹은 꺼진 파트가 있다(Renderer3D.cpp:505-507이 같은 검사를
            // 한다). 제타는 항상 true 를 돌려주므로 이 줄이 무해하다
            // (ztDesignZeta.cpp: GetMeshPartActivated → return true).
            if (!avatar->GetMeshPartActivated(static_cast<unsigned int>(i))) continue;

            // 제타는 서브머티리얼 배열이 파트와 1:1, 마네킹은 인덱스로 하나씩
            // 받는다. 마네킹 쪽은 **값 반환**이라 지역 변수로 수명을 잡아 둔다.
            ztDesignMaterialData          mannequinMaterial;
            const ztDesignMaterialData*   material = nullptr;

            if (zeta)
            {
                if (i < zetaMaterials.size()) material = &zetaMaterials[i];
            }
            else if (mannequin)
            {
                mannequinMaterial = mannequin->GetMaterialData(static_cast<unsigned int>(i));
                material = &mannequinMaterial;
            }

            packPart(meshes[i].get(), static_cast<int>(i),
                     avatar->GetMeshPartName(static_cast<unsigned int>(i)),
                     material, nullptr, nullptr);
        }

        // ── 액세서리 (머리카락·신발·양말·속옷) ──────────────────
        //
        // 머리말의 "액세서리" 절이 근거다. 제타에만 있다 — 마네킹에는
        // `GetRenderAccessoryMeshes()` 자체가 없다.
        if (zeta)
        {
            const ztDesignAvatarData* avatarData = qi->GetAvatarData(entry.first);
            const std::vector<ztAccessoryMeshData>& accessories =
                zeta->GetRenderAccessoryMeshes();

            // 파트 인덱스는 몸 뒤에 이어 붙인다 — 익스포터의 노드 이름
            // `zeta_accessory12` 가 정확히 이 규칙이다(몸 12파트 다음이 12번).
            int accIndex = static_cast<int>(meshes.size());

            for (const ztAccessoryMeshData& acc : accessories)
            {
                // 데스크톱(:571)과 익스포터(:532)가 둘 다 이 검사로 거른다.
                // 슬롯은 있는데 아무것도 안 걸친 경우가 여기서 빠진다.
                if (!acc.IsEnableMesh()) { ++accIndex; continue; }

                // ★ 머티리얼을 **합성한다.** 익스포터(:537-541)와 같은 일이다 —
                //   액세서리에는 `ztDesignMaterialData` 가 원래 없고, 색은 씬
                //   데이터(`accessoryInfos`)에, 이미지는 메시 쪽에 흩어져 있다.
                //   합성해 두면 몸 파트와 완전히 같은 경로로 나간다.
                ztDesignMaterialData md;

                // ★★ 기본 생성자가 **이미 텍스처를 물고 있다.**
                //    `basecolorTexture = { BASE_COLOR_TEXTURE }`
                //    (ztDesignMaterial.h:60) — 빈 벡터가 아니라 프리셋 직물의
                //    `Default_Base_Color.png` 다. 안 비우면 "우리가 아무것도
                //    안 실었는데 텍스처가 하나 실린" 상태가 되고, 그 파일은
                //    이 설치본에 **없어서** 게이트웨이가 거절한다.
                //
                //    실측으로 밟았다 — 신발에 `Default_Base_Color.png` 가
                //    붙어 나왔고 처음엔 엔진이 준 값인 줄 알았다. 아니었다.
                //
                //    ⚠️ `MaterialTextureRefs` 가 읽는 셋만 비우면 된다.
                //       나머지 슬롯의 기본값은 `""` 라 무해하다.
                md.basecolorTexture.clear();
                md.normalTexture.clear();
                md.alphaTexture.clear();

                if (avatarData)
                {
                    const auto& infos = avatarData->zetaData.accessoryInfos;
                    const auto  found = std::find_if(
                        infos.begin(), infos.end(),
                        [&acc](const ztAccessoryInfo& d) { return d.selectedData == acc.name; });

                    // ⚠️ 익스포터는 여기서 end() 를 안 보고 역참조한다(:535).
                    //    우리는 색을 포기하고 진행한다 — 이름이 안 맞는다고
                    //    머리카락을 통째로 빼는 것보다 낫다.
                    if (found != infos.end())
                        md.basecolor.Set(found->color.r, found->color.g, found->color.b);
                }

                // ★★ 텍스처는 **Hair 일 때만** 건다. 여기서 익스포터를 따르지
                //    않고 렌더러(Renderer3D.cpp:593-601)를 따른다 — 실측으로
                //    갈렸다:
                //
                //      신발 `low_top_sneakers.obj` 의 `image->path` 는
                //      `fabric/Preset/Default/textures/Default_Base_Color.png`
                //      인데 **그 파일이 디스크에 없다.** 엔진이 "안 쓰는 슬롯"
                //      에 기본값을 꽂아 둔 것이고, 렌더러가 Hair 만 보는 이유가
                //      그것이다. 익스포터(:540-541)는 타입을 안 보고 거는데,
                //      그렇게 만든 glTF 는 없는 파일을 가리키게 된다 — 저쪽
                //      버그다. 1회성 CLI 라 아무도 안 밟았을 뿐이다.
                //
                //    ⚠️ 이걸 그대로 두면 게이트웨이가 "파일이 없습니다" 로
                //       거절하고 화면에 `⚠ 거절 1칸` 이 뜬다. 기능은 멀쩡한데
                //       경고만 나는, 제일 나쁜 종류의 잡음이다.
                if (ztAccessoryType::Hair == acc.type)
                {
                    // 널 검사는 여전히 우리 몫이다 — 렌더러는 Hair 라면
                    // 이미지가 있다고 **가정하고** 역참조한다(:595-596).
                    if (acc.image      && !acc.image->path.empty())
                        md.basecolorTexture = { acc.image->path };
                    if (acc.imageAlpha && !acc.imageAlpha->path.empty())
                        md.alphaTexture     = { acc.imageAlpha->path };
                }

                // `doubleSided` 는 우리 판단이 아니라 데스크톱의 설정을 옮긴
                // 것이다(Renderer3D.cpp:588 `enableTwoSided()`). 머리카락은
                // 얇은 판이라 뒷면을 버리면 숱이 절반으로 보인다.
                const json extra{
                    { "accessory",   AccessoryTypeName(acc.type) },
                    { "assetName",   acc.name },
                    { "doubleSided", true },
                };

                packPart(acc.simulMeshes.get(), accIndex,
                         acc.name.empty() ? std::string(AccessoryTypeName(acc.type)) : acc.name,
                         &md, acc.texcoords, &extra);

                ++accIndex;
            }
        }

        totalV += avatarV;
        totalT += avatarT;

        // `GetFrameInfo()` 는 (현재 프레임, 전체 프레임)이다. 실행기가
        // 종료를 판정하는 식이 `first + 1 >= second` 다
        // (ztSimulationStandardCPUExecutor.cpp:277-280). 클라이언트가 같은
        // 식을 쓰면 `IsAnimationFinished()`(부작용 있음, 위 주석)를 부르지
        // 않고도 "이제 몸이 안 움직인다 = 더 안 받아도 된다"를 판정한다.
        const std::pair<int, int> frameInfo = avatar->GetFrameInfo();

        json a{
            { "uuid",      ztUuidSaver::Convert(entry.first) },
            { "subType",   isZeta ? "zeta" : "mannequin" },
            { "current",   entry.first == currentUuid },
            { "parts",     std::move(parts) },
            { "vertices",  avatarV },
            { "triangles", avatarT },
            // 순수 조회다 — 제타는 상수 true, 마네킹은 fbx 상태를 읽기만 한다.
            { "animation", avatar->IsAnimation() },
            { "animationTime", avatar->GetAnimationTime() },
            { "frameInfo", { frameInfo.first, frameInfo.second } },
        };

        // ★ 요청값의 메아리가 아니라 **우리가 실제로 실은 정점에서 잰 상자**다.
        //   클라이언트가 "진짜 몸이 왔나"를 이 값 하나로 판정할 수 있고,
        //   glTF 익스포트 산출물과 대조할 기준선이기도 하다(단위 cm).
        if (avatarV > 0 && lo[0] <= hi[0])
        {
            a["bounds"] = json{
                { "min", { lo[0], lo[1], lo[2] } },
                { "max", { hi[0], hi[1], hi[2] } },
            };
        }

        avatars.push_back(std::move(a));
    }

    json out{
        { "avatars",        avatars },
        { "topology",       includeTopology },
        { "normals",        includeNormals },
        { "totalVertices",  totalV },
        { "totalTriangles", totalT },
    };
    // 옷과 같은 규약 — 비어 있으면 키를 안 싣는다.
    if (!textures.Empty()) out["textures"] = textures.ToJson();
    return out;
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

                    // ★ 엔진은 실패 이유를 `std::cout` 으로만 말한다. 예:
                    //     [Open zls]'...' Failed to open ZLS.
                    //     The file was created with a newer version.
                    //   그런데 `OutputChannels` 가 cout 을 stderr 로 돌려 두므로
                    //   (머리말 참고) 그 줄은 **워커 로그에만** 남고 응답에는 실리지
                    //   않았다. 그래서 화면이 말할 수 있는 것이 "zls 로드 실패"
                    //   뿐이었고, 사용자는 왜 안 되는지 모른 채 같은 파일을 반복해
                    //   올린다 — 2026-08-24에 실제로 네 번 올렸다.
                    //
                    //   로드하는 동안만 cout 을 따로 받아 두고, 실패하면 그 문장을
                    //   응답에 함께 싣는다. 성공 경로의 진행 메시지도 같이 잡히므로
                    //   잡은 것은 그대로 stderr 로 흘려보내 로그를 보존한다.
                    std::ostringstream engineOut;
                    std::streambuf* const prevCout = std::cout.rdbuf(engineOut.rdbuf());
                    ok = manager.LoadZls(ztString(path));
                    std::cout.rdbuf(prevCout);

                    const std::string engineText = engineOut.str();
                    if (!engineText.empty())
                    {
                        std::cerr << engineText;
                        if (engineText.back() != '\n') std::cerr << '\n';
                    }

                    if (!ok)
                    {
                        error = "zls 로드 실패";

                        // 엔진이 찍은 마지막 의미 있는 줄이 이유다.
                        std::string reason;
                        {
                            std::istringstream lines(engineText);
                            std::string line;
                            while (std::getline(lines, line))
                            {
                                while (!line.empty() && (line.back() == '\r' || line.back() == ' '))
                                    line.pop_back();
                                if (!line.empty()) reason = line;
                            }
                        }
                        if (!reason.empty()) error += " — " + reason;

                        // ⚠️ 이 갈래는 **다시 올려도 절대 열리지 않는다.** 그 사실을
                        //    말해 주지 않으면 사용자가 재시도로 시간을 태운다.
                        if (engineText.find("newer version") != std::string::npos)
                        {
                            error += " (이 씬은 현재 엔진보다 새 버전으로 저장됐습니다. "
                                     "다시 올려도 열리지 않습니다 — 낮은 버전으로 다시 "
                                     "내보내거나 엔진을 올려야 합니다)";
                        }
                    }
                    else result = json{ { "loaded", true }, { "path", path } };
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
            else if (op == "setAvatarMeasurements")
            {
                // ⚠️ 오래 걸린다. 단계 수 × simulationIterations 번의 Step 을
                //    동기로 돌린다(위 머리말 참고).
                const json measurements = req.value("measurements", json::object());

                // ⚠️ **기본값이 회사 struct 와 다르다 — 일부러 그렇다.**
                //
                //   회사 `BodyParameterReader.h:38-39` 의 struct 초기값은
                //   `simulationIterations = 1`, `bodyDimensionStepCm = 100` 이다.
                //   그런데 엔진팀이 전달한 **문서의 기본값은 6 과 1.0** 이다.
                //   둘이 어긋나 있고, 우리는 문서 쪽을 정본으로 삼는다.
                //
                //   근거: stepCm=100 이면 `(int)(maxDest / 100)` 이 0 이라 중간
                //   단계가 통째로 사라지고 몸이 한 번에 변한다 — **옷이 몸을
                //   뚫는다.** 단계 쪼개기의 존재 이유가 기본값에서 죽는다.
                //   회사 struct 값은 파일에 필드가 없을 때의 자리채움이지
                //   권장값이 아니라고 본다.
                //
                //   대가: 기본값 호출이 훨씬 느려진다. Debug 빌드 실측에서
                //   허리둘레 +15cm 가 16단계 × 6회 = Step 96번, **142초**였다
                //   (게이트웨이 요청 타임아웃 120초를 넘는다).
                const int    iterations = req.value("simulationIterations", 6);
                const double stepCm     = req.value("bodyDimensionStepCm", 1.0);

                if (!manager.IsLoadedZls())
                {
                    ok = false; error = "씬이 로드되지 않았습니다";
                }
                else if (!measurements.is_object() || measurements.empty())
                {
                    ok = false; error = "measurements가 필요합니다";
                }
                else if (iterations < 0)
                {
                    ok = false; error = "simulationIterations는 0 이상이어야 합니다";
                }
                else if (!(stepCm > 0.0))
                {
                    // 원본에는 이 검사가 없다. 0 이면 `maxDest / stepCm` 이
                    // inf 가 되고 그것을 int 로 캐스팅하는 것은 UB 다 —
                    // 실제로는 거대한 루프가 되어 워커가 돌아오지 않는다.
                    ok = false; error = "bodyDimensionStepCm는 0보다 커야 합니다";
                }
                else
                {
                    MeasureApplyReport report;
                    const MeasureApplyError err = ApplyAvatarMeasurements(
                        manager, measurements, iterations, (float)stepCm, report);

                    if (err != MeasureApplyError::None)
                    {
                        ok = false;
                        error = MeasureApplyErrorText(err);

                        // 왜 하나도 안 먹었는지는 키 목록이 있어야 안다.
                        // 에러 문자열밖에 못 싣는 규약이라 여기에 붙인다.
                        if (err == MeasureApplyError::NoChange)
                        {
                            for (const std::string& k : report.unknown)  error += " / 모르는 치수: " + k;
                            for (const std::string& k : report.rejected) error += " / 못 쓰는 값: " + k;
                        }
                    }
                    else
                    {
                        // ★ 되읽어 싣는다. `avatar.measurements[*].real` 이
                        //   엔진이 실제로 만들어 낸 치수다 — 요청값을
                        //   메아리치면 몸이 안 변했을 때도 성공으로 보인다.
                        result = json{
                            { "applied",  report.applied  },
                            { "unknown",  report.unknown  },
                            { "rejected", report.rejected },
                            // null 이라 건너뛴 개수. `applied` 가 비고 `skipped` 만
                            // 크면 "바꿀 것 없음" 이 정상 통과한 것이다.
                            { "skipped",  report.skipped  },
                            { "steps",    report.steps    },
                            { "simSteps", report.simSteps },
                            { "frame",    curFrame.load() },
                            // ★ 적용 뒤 **다시 잰** 치수. 이것이 되읽기의 정본이다 —
                            //   아래 `avatar.measurements[*].real` 은 씬 데이터
                            //   사본이라 이 op 으로는 안 움직인다(struct 주석 참고).
                            { "measured", report.measured },
                            { "avatar",   ReadAvatarBody(manager) },
                        };
                    }
                }
            }
            else if (op == "drapingItems")
            {
                // 순수 읽기다 — 씬을 안 바꾼다.
                //
                // ⚠️ 씬을 **요구한다.** `fabrics` 와 판단이 다른 이유는 출처다:
                //    직물 목록은 설치본의 라이브러리라 씬과 무관하지만,
                //    드레이핑 아이템은 **씬 파일 안에 들어 있다.** 씬 없이 빈
                //    목록을 돌려주면 화면이 "이 씬에는 저장된 드레이프가 없다"
                //    로 읽는데 사실은 씬이 없는 것이다. 둘은 다른 화면이어야 한다.
                if (!manager.IsLoadedZls())
                {
                    ok = false; error = "씬이 로드되지 않았습니다";
                }
                else
                {
                    result = ReadDraping(manager);
                }
            }
            else if (op == "drapingThumbnail")
            {
                // ★ 없는 uuid 를 **에러로 만들지 않는다.** `setSurfaceSize` 는
                //   없는 uuid 를 에러로 되돌리지만 저쪽은 쓰기다 — 못 썼으면
                //   실패가 맞다. 여기는 읽기이고 "그런 아이템의 그림이 있는가"
                //   가 질문이라, "없다" 는 그 질문의 **정당한 답**이다.
                //   `loadDraping` 의 `notFound` 와도 같은 채널이 된다.
                if (!manager.IsLoadedZls())
                {
                    ok = false; error = "씬이 로드되지 않았습니다";
                }
                else
                {
                    result = ReadDrapingThumbnail(manager, req);
                }
            }
            else if (op == "loadDraping")
            {
                if (!manager.IsLoadedZls())
                {
                    ok = false; error = "씬이 로드되지 않았습니다";
                }
                else
                {
                    // `uuid` 가 있으면 그것을, 없으면 자동 아이템을 적용한다.
                    // 인자가 없을 때의 동작은 예전과 한 글자도 다르지 않다.
                    result = ApplyDrapingItem(manager, req);

                    // LoadDrapingItem 이 안에서 ztSimulationManager::Reset() 을
                    // 부른다. 프레임 카운터를 그대로 두면 화면이 "249프레임째"
                    // 라고 말하는데 시뮬은 처음부터 다시 도는 상태가 된다 —
                    // reset op 과 같은 자리를 되돌린다.
                    if (result.value("applied", false))
                    {
                        maxFrame.store(-1);
                        curFrame.store(-1);
                        lastEmitted = -1;
                    }
                }
            }
            else if (op == "fabrics")
            {
                // ⚠️ **씬을 요구하지 않는다.** 목록은 설치본의 라이브러리이고
                //    씬과 무관하다 — 다만 씬 내장(in-file) 직물은 씬을 열어야
                //    채워지므로, 씬 없이 부르면 프리셋만 온다. 그것이 거짓말은
                //    아니다(그때는 정말 그것뿐이다).
                result = ReadFabrics();
            }
            else if (op == "setFabric")
            {
                if (!manager.IsLoadedZls())
                {
                    ok = false; error = "씬이 로드되지 않았습니다";
                }
                else
                {
                    const std::string surfaceUuid = req.value("surface", std::string{});
                    const std::string fabricId    = req.value("fabricId", std::string{});
                    if (surfaceUuid.empty() || fabricId.empty())
                    {
                        ok = false;
                        error = "surface 와 fabricId 가 필요합니다";
                    }
                    else
                    {
                        result = SetSurfaceFabric(manager, QueryInterface(manager),
                                                  surfaceUuid, fabricId, ok, error);
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
                // ★ `textures` 는 **기본이 켜짐**이다(`normals` 와 같은 쪽).
                //   재질을 싣는 응답에서 그 재질의 텍스처만 빼는 조합이 쓸모가
                //   없고, 기본을 꺼 두면 모든 호출자가 매번 기억해야 한다 —
                //   `normals` 가 그 함정을 이미 한 번 보여줬다(bridge.ts:495).
                //   비용도 작다: 실리는 것은 짧은 경로 문자열 몇 개이고,
                //   `topology:false`(= 프레임 경로)에는 재질 자체가 없어서
                //   한 글자도 늘지 않는다.
                result = MeshData(manager, req.value("topology", false),
                                  req.value("textures",    true),
                                  req.value("texturesRaw", false));
            }
            else if (op == "avatarMesh")
            {
                // 씬 없이 부르면 `avatars: []` 로 답할 수도 있지만, 그러면
                // "아바타가 없는 씬"과 "씬이 없음"이 같은 응답이 된다.
                if (!manager.IsLoadedZls())
                {
                    ok = false; error = "씬이 로드되지 않았습니다";
                }
                else
                {
                    result = AvatarMeshData(manager,
                                            req.value("topology", false),
                                            req.value("normals",  true),
                                            req.value("textures",    true),
                                            req.value("texturesRaw", false));
                }
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
