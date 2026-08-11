/**
 * zelusSandBoxd 의 JSON Lines 프로토콜 타입.
 *
 * C++ 쪽 정의는 backend/native/src/protocol.cpp 에 있다. 양쪽이 어긋나면
 * 런타임에야 드러나므로, op 를 추가할 때는 반드시 두 파일을 같이 고칠 것.
 */

// ── 요청 ────────────────────────────────────────────────────

export type Request =
  | { id: number; op: 'ping' }
  | { id: number; op: 'version' }
  | { id: number; op: 'init' }
  | { id: number; op: 'load'; path: string }
  | { id: number; op: 'clear' }
  | { id: number; op: 'start' }
  | { id: number; op: 'pause' }
  | { id: number; op: 'reset' }
  | { id: number; op: 'step' }
  | { id: number; op: 'subscribe' }
  | { id: number; op: 'unsubscribe' }
  | { id: number; op: 'status' }
  | { id: number; op: 'getParams' }
  | { id: number; op: 'setParams'; params: Partial<SimulationParams> }
  | { id: number; op: 'avatarBody' }
  | { id: number; op: 'setAvatarBody'; bodyParams: Record<string, number> }
  | { id: number; op: 'surfaces' }
  | { id: number; op: 'setSurfaceSize'; uuid: string; width?: number; height?: number }
  | { id: number; op: 'meshInfo' }
  | { id: number; op: 'meshData'; topology?: boolean }
  | { id: number; op: 'export'; path: string; format?: 'gltf' | 'zbin' }
  | { id: number; op: 'quit' };

export type Op = Request['op'];

// ── 응답 ────────────────────────────────────────────────────

export interface OkResponse<T = unknown> {
  id?: number;
  ok: true;
  result: T;
}

export interface ErrResponse {
  id?: number;
  ok: false;
  error: string;
}

export type Response<T = unknown> = OkResponse<T> | ErrResponse;

// ── 이벤트 (id 없음) ────────────────────────────────────────

export type Event =
  | { event: 'ready'; protocol: number; session: string }
  | {
      event: 'frame';
      frame: number;
      /**
       * 구독(subscribe) 중일 때만 붙는다. meshData{topology:false}의 결과와
       * **같은 모양**이므로 디코더를 하나만 쓰면 된다 (decodePatterns).
       *
       * indices/uvs는 없다 — 프레임 간 고정이라 meshData{topology:true}로
       * 한 번만 받으면 되고, 매 프레임 실으면 대역폭이 몇 배가 된다.
       */
      mesh?: MeshDataResult;
    }
  | { event: 'engineMessage'; message: string };

export type Incoming = Response | Event;

export function isEvent(msg: Incoming): msg is Event {
  return 'event' in msg;
}

// ── 결과 페이로드 ───────────────────────────────────────────

/**
 * 링크된 엔진의 버전 문자열. 데스크톱 앱의 About 표시와 같은 출처다.
 * 씬 로드나 init 없이도 호출된다.
 */
export interface VersionResult {
  /** 예: "1.94.19" */
  zelus: string;
  /** 예: "3.0.149" */
  lumia: string;
}

export interface StatusResult {
  loaded: boolean;
  simInitialized: boolean;
  mode: 'play' | 'pause' | 'reset' | 'step' | 'unknown';
  frame: number;
  maxFrame: number;
  /**
   * frame 이벤트에 메시(positions)를 실어 보낼지. 씬 상태가 아니라
   * 클라이언트의 전송 취향이므로 load/clear/reset이 건드리지 않는다 —
   * 워커 수명 내내 유지된다.
   */
  subscribed: boolean;
}

/** subscribe / unsubscribe 의 결과. 요청한 방향을 그대로 확인해준다. */
export interface SubscribeResult {
  subscribed: boolean;
}

export interface PatternInfo {
  uuid: string;
  vertices: number;
  triangles: number;
  changed: boolean;
}

export interface MeshInfoResult {
  patterns: PatternInfo[];
  totalVertices: number;
  totalTriangles: number;
}

/**
 * 패턴 로컬 → 월드 변환 (ISSUE-011). **정점에 곱해져 있지 않다.**
 *
 * `positions` 는 패턴 로컬 좌표라 이 변환 없이는 위치가 정해지지 않는다.
 * 워커가 `ztDesignClothPattern::GetTransformIn3D()` 를 그대로 분해해 싣고,
 * 이것은 glTF 익스포터가 옷 패턴 **노드 변환**으로 쓰는 값과 같은 출처다 —
 * 따라서 익스포트 산출물과 대조하면 정답지가 있는 검증이 된다.
 *
 * ⚠️ 단위는 정점과 같은 **cm** 다. 익스포터가 거는 cm→m 스케일 0.01 은 glTF
 *    **루트 노드**의 것이지 이 변환의 것이 아니다.
 * ⚠️ TRS 분해다(4×4 행렬이 아니다). `rotation` 은 glTF·three.js 와 같은
 *    **[x, y, z, w]** 순서 쿼터니언이다.
 */
export interface PatternTransform {
  /** [x, y, z], cm */
  translation: [number, number, number];
  /** [x, y, z, w] 쿼터니언 */
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

/**
 * 서피스 → **2D 재단 도면** 배치 (ISSUE-018). 행 우선 3×3, 9개.
 *
 * ⚠️ 위의 `PatternTransform`(3D)과 **전혀 다른 것이다.** 저쪽은 패턴 로컬 →
 *    3D 월드(옷이 몸에 둘러지는 자리)이고, 이쪽은 로컬 → 2D 도면 위의 자리다.
 *    2D 펼침 뷰의 요점은 3D 변환을 **쓰지 않는 것**이라 둘을 섞으면 안 된다.
 *
 * ── 왜 필요한가 ────────────────────────────────────────────
 * `uvs` 는 cm 단위 2D 패턴 좌표지만 **서피스 로컬**이다 — 패턴마다 자기 원점
 * 근처에서 시작하므로 그대로 그리면 겹친다. `W_Bra top & Leggings.zls`
 * (패턴 24개) 실측: 적용 전 AABB 쌍 276개 중 227개(82.2%)가 겹쳤고, 적용 후
 * **7개(2.5%)** 로 떨어졌다(면적비 2.05배 → 0.55배).
 *
 * ── 규약 (전치해도 그럴듯한 그림이 나오므로 못박는다) ──────
 * 배열은 **행 우선** `[m00,m01,m02, m10,m11,m12, m20,m21,m22]` 이고 적용은
 * **열벡터** 규약이다:
 *
 *   wx = m[0]*x + m[1]*y + m[2]
 *   wy = m[3]*x + m[4]*y + m[5]
 *
 * 마지막 행은 항상 `[0,0,1]` 이다. 단위는 정점·uv 와 같은 **cm**.
 *
 * 워커가 `ztDesignSurface::GetTransform().GetMatrix33()` 을 그대로 내보내고,
 * 그 값은 데스크톱 2D 뷰포트가 캔버스에 거는 것과 **같은 행렬**이다
 * (`Renderer2D.cpp:164` → `PaintInterface2D.cpp:908-914`).
 */
export type PatternTransform2D = [
  number, number, number,
  number, number, number,
  number, number, number,
];

/**
 * 패턴의 **진짜** 재질. 실시간 3D 뷰가 임의 팔레트 대신 쓸 값이다.
 *
 * 워커가 `ztDesignClothPattern::GetFrontMaterial()` 의 데이터를 그대로 싣는다.
 * 앞면만 읽는 이유는 익스포터도 기본 경로에서 그러기 때문이고
 * (`zwGltfExporterImpl.cpp:477` — 뒷면/옆면은 thickness+splitMesh 가 둘 다
 * 켜졌을 때만 갈라진다), three.js 가 DoubleSide 에서 면별로 다른 색을 못 주는
 * 것과도 맞는다.
 *
 * ── 왜 패턴마다 인라인인가 (별도 materials op 이 아니라) ────
 * 머티리얼 **객체**는 패턴과 **1:1** 이다. 두 씬 실측에서 어떤 머티리얼도
 * 패턴 둘에게 공유되지 않았다 — `W_Bra top & Leggings.zls` 는 패턴 24 : 머티리얼
 * 24(참조 각 1회), `sample.zls` 는 패턴 5 : 머티리얼 15(front/back/side 슬롯마다
 * 하나씩, 각 1회). 머티리얼 uuid 로 묶는 별도 op 을 만들어도 엔트리가 줄지
 * 않고 왕복만 늘어난다.
 *
 * 진짜 N:1 인 축은 **직물 에셋**(`fabricUuid`)이다 — 위 24개가 2개로 묶인다.
 */
export interface PatternMaterial {
  /**
   * 직물 에셋 uuid. **패턴을 직물별로 묶는 유일한 키다.**
   *
   * `W_Bra top & Leggings.zls` 실측: 패턴 24개가 2개로 묶인다(노랑 16 / 민트 8).
   * 익스포터가 glTF 머티리얼을 합칠 때 쓰는 것과 같은 키다
   * (`zwGltfExporterImpl.cpp` 의 `mUuidToGltfMaterial`, `assetUuid` 기준).
   */
  fabricUuid: string;
  /**
   * 베이스 색 `[r, g, b]`, 각 0~1. **알파는 여기 없다** — `opacity` 를 볼 것
   * (익스포터도 `basecolor.w` 를 버리고 `alpha` 를 쓴다).
   *
   * ⚠️ `colorProfile` 없이 해석하면 안 된다. 아래 참고.
   */
  color: [number, number, number];
  /**
   * `color` 의 색공간. 거의 항상 `'srgb'` 지만 **상수로 가정하면 안 된다.**
   *
   * 실측한 노랑 `[0.9254902, 0.8117647, 0.4705882]` 은 정확히
   * `236/255, 207/255, 120/255` — 8비트 색선택기에서 나온 sRGB 값이다.
   * 선형으로 착각해 칠하면 눈에 띄게 어둡고 진해진다. three.js 라면
   * `Color.setRGB(r, g, b, SRGBColorSpace)` 처럼 색공간을 명시해야 한다.
   */
  colorProfile: 'srgb' | 'linear';
  /** 0~1. `ztDesignMaterialData::alpha`. 1 미만이면 반투명하게 그려야 한다. */
  opacity: number;
  /** 0~1. 실측: `W_Bra top & Leggings.zls` 1.0 / `sample.zls` 0.3 — 씬마다 다르다. */
  roughness: number;
  /** 0~1. 실측상 두 씬 모두 0 이었다. */
  metalness: number;
}

export interface PatternData {
  uuid: string;
  vertices: number;
  triangles: number;
  /** base64. float32 x3 per vertex, 촘촘히 포장됨 (C++에서 재포장) */
  positions?: string;
  positionStride?: number;
  /** base64. int32. topology:true 일 때만 */
  indices?: string;
  indexStride?: number;
  /**
   * base64. float32 x2. topology:true 일 때만.
   *
   * cm 단위 2D 패턴 좌표다(텍스처 좌표가 아니다). **서피스 로컬**이라
   * 이것만으로는 2D 도면을 그릴 수 없다 — `transform2d` 를 곱해야 한다.
   */
  uvs?: string;
  /**
   * 패턴 로컬 → 월드 (ISSUE-011). **topology:true 일 때만.**
   *
   * 프레임 이벤트의 mesh(= topology:false)에는 없다. 프레임마다 바뀌지 않는
   * 값이라 최초 1회만 싣기 때문이다(sample.zls 249프레임 실측에서 비트 단위
   * 동일). 받는 쪽은 한 번 받아 계속 쓴다.
   */
  transform?: PatternTransform;
  /**
   * 서피스 → 2D 도면 배치 (ISSUE-018). **topology:true 일 때만.**
   *
   * `uvs` 와 짝이다 — 저것이 로컬 좌표, 이것이 배치. 서피스가 없는 패턴에는
   * 아예 오지 않는다(항등행렬을 대신 보내지 않는다 — "원점에 배치된 것" 과
   * "배치를 모르는 것" 을 구분할 수 있어야 한다).
   *
   * ⚠️ topology 안에 있는 근거가 3D `transform` 과 **다르다.** 저쪽은 249프레임
   *    실측으로 불변을 확인한 것이고, 이쪽은 **워커에 2D 배치를 바꿀 op 이
   *    하나도 없다**는 것이다. 2D 저작 기능이 붙으면 깨진다.
   */
  transform2d?: PatternTransform2D;
  /**
   * 패턴의 진짜 재질. **topology:true 일 때만.**
   *
   * 머티리얼이 없는 패턴에는 아예 오지 않는다(흰색을 대신 보내지 않는다 —
   * "흰 옷" 과 "색을 모름" 을 구분할 수 있어야 임의 팔레트로 폴백할 수 있다.
   * `sample.zls` 가 실제로 전부 흰색이라 이 구분이 화면에서 바로 문제가 된다).
   *
   * ⚠️ topology 안에 있는 근거는 2D `transform2d` 와 같다 — 워커에 재질을 바꿀
   *    op 이 하나도 없다는 것. **다만 이쪽이 먼저 깨진다**: 백로그의
   *    `setFabric` 이 바로 이 값을 바꾸는 op 이다. 그때는 이 필드를 프레임마다
   *    보낼 게 아니라 **재질 변경 이벤트를 따로** 내야 한다.
   */
  material?: PatternMaterial;
}

export interface MeshDataResult {
  patterns: PatternData[];
  topology: boolean;
}

export interface SetParamsResult {
  applied: string[];
  /** 서버가 모르는 키. 오타를 조용히 삼키지 않기 위해 되돌려준다 */
  unknown: string[];
}

// ── 아바타 체형 (L-3a) ──────────────────────────────────────
//
// 데스크톱 앱에 이 UI가 없다. 엔진에는 완비돼 있고 노출만 안 돼 있었다.
// 워커는 `ztSceneQueryInterface` 로 데이터를 왕복시킨다
// (`GetAvatarData` → 수정 → `UpdateAvatar`). 실측으로 그 왕복이 지오메트리까지
// 바꾼다는 것을 확인했다 — 같은 씬에서 height 0.5/0.8 의 glTF 해시가 다르다.

/**
 * 치수 한 항목. **cm 다.**
 *
 * ⚠️ `real` 은 **로드 시점의 값이고 체형을 바꿔도 갱신되지 않는다.** 워커가
 *    수정본을 만들 때 이 필드를 그대로 복사해 넘기고, 엔진이 되써주지 않기
 *    때문이다(실측). 화면이 이 값을 "지금 치수" 로 보여주면 거짓말이 된다 —
 *    체형을 만진 뒤에는 씬을 다시 로드해야 맞는 값이 나온다.
 */
export interface AvatarMeasurement {
  /** 엔진이 계산해 둔 실측치. 위 경고 참고 */
  real: number;
  /** 목표 치수. 지정된 적이 없으면 없다 (엔진의 FLT_MIN 을 워커가 걸러낸다) */
  expected?: number;
  locked: boolean;
}

export interface AvatarBodyResult {
  /** 씬에 아바타가 없으면 false 이고 나머지 필드가 없다 */
  hasAvatar: boolean;
  uuid?: string;
  /**
   * 체형 29개. 키는 엔진이 정한 이름(`ztAvatarBodyParamUtils::GetParamName`)이고
   * 값은 **정규화된 0~1** 이다(실측: 사용자 씬이 전부 0.5). cm 가 아니다 —
   * cm 단위의 몸을 보려면 `measurements` 쪽이다.
   */
  bodyParams?: Record<string, number>;
  /** 치수 25개. 키는 `ztAvatarMeasureUtils::GetMeasurePartName` */
  measurements?: Record<string, AvatarMeasurement>;
}

// ── 옷 사이즈 (L-3b) ────────────────────────────────────────
//
// 데스크톱 `Pattern` 패널의 Width/Height 가 이것이다. 아바타 체형과 달리
// `ZestManager` 안에서 끝난다(GetSurfaceInfos/GetSurfaceSize/UpdateSizeSurface).

/** 서피스 하나. **크기는 cm 다** */
export interface SurfaceInfo {
  uuid: string;
  /** 씬이 준 이름. 유일하지 않다 — 실측에서 "pattern 9" 가 셋이었다 */
  name: string;
  width: number;
  height: number;
}

export interface SurfacesResult {
  surfaces: SurfaceInfo[];
}

export interface SetAvatarBodyResult {
  applied: string[];
  /** 모르는 키. `setParams` 와 같은 규약이다 (ISSUE-014 를 되풀이하지 않는다) */
  unknown: string[];
  /**
   * **쓰고 나서 다시 읽은 값이다 — 요청값의 메아리가 아니다.**
   *
   * 이 구분이 이 op 의 설계 근거다. 메아리치면 엔진이 아무 일도 안 했을
   * 때조차 성공으로 보인다.
   */
  avatar: AvatarBodyResult;
}

/**
 * ztSceneDataSimulationParams 중 프로토콜이 노출하는 부분.
 *
 * 주의: 데스크톱 앱은 "solver type"과 "Collision solver"를 같은 solverType
 * 필드에 쓰는 버그가 있다 (PROJECT_ANALYSIS.md §9 ①). 여기서는 solverType이
 * 적분기 하나만 가리킨다. 충돌 솔버를 노출할 때 같은 이름을 재사용하지 말 것.
 */
export interface SimulationParams {
  timeStep: number;
  subStep: number;
  drapingTime: number;
  gravityY: number;
  groundPlane: boolean;
  groundFriction: number;
  groundMargin: number;
  useWind: boolean;
  windMagnitude: number;
  solverType: number;
  preconditioner: number;
  nonlinearIterations: number;
  maxSolverIterations: number;
  solverTolerance: number;
  useIEQS: boolean;
  staticCouplingMethod: number;
  dynamicCouplingMethod: number;
  dynCouplingStiffness: number;
  dynCouplingDamping: number;
  untanglingStiffness: number;
  untanglingDamping: number;
  meshingEdgeLength: number;
}

/** base64 지오메트리를 브라우저/three.js 가 바로 쓸 수 있는 형태로 푼다. */
export function decodeFloat32(base64: string): Float32Array {
  const buf = Buffer.from(base64, 'base64');
  // Buffer 가 4바이트 정렬을 보장하지 않으므로 복사해서 정렬을 맞춘다.
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

export function decodeInt32(base64: string): Int32Array {
  const buf = Buffer.from(base64, 'base64');
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Int32Array(copy.buffer);
}
