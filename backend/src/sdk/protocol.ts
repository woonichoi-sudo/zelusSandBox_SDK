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
  /**
   * 치수(cm)로 몸을 만든다 (W-1). ⚠️ **오래 걸린다** — 아래
   * `SetAvatarMeasurementsResult` 주석의 실측 참고.
   */
  | {
      id: number;
      op: 'setAvatarMeasurements';
      measurements: AvatarMeasurementTargets;
      simulationIterations?: number;
      bodyDimensionStepCm?: number;
    }
  /** `.zls` 에 저장된 자동 드레이프를 적용한다 (W-1) */
  | { id: number; op: 'loadDraping' }
  | { id: number; op: 'surfaces' }
  | { id: number; op: 'setSurfaceSize'; uuid: string; width?: number; height?: number }
  | { id: number; op: 'design2d' }
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

// ── 치수로 몸 만들기 (W-1) ──────────────────────────────────
//
// `setAvatarBody` 는 정규화 0~1 의 체형 슬라이더이고, 이쪽은 **cm 단위의 치수**
// 를 목표로 걸어 엔진이 그 몸을 만들게 한다. 둘은 같은 아바타를 다른 어휘로
// 만지는 것이라 응답이 서로의 결과를 되읽어 준다.

/**
 * 치수 목표. 키는 `AvatarBodyResult.measurements` 와 **같은 이름**이고
 * (`ztAvatarMeasureUtils::GetMeasurePartIdx` 가 정본), 값은 cm 다.
 *
 * ★ **`null` 은 "지정 안 함" 이다. 잘못된 값이 아니다.** 엔진팀 문서가 키 25개를
 *   전부 보내고 안 바꿀 것을 null 로 두라고 한다. 워커는 null 을 `rejected` 가
 *   아니라 `skipped` 로 세고, 전부 null 이어도 성공으로 답한다
 *   (`protocol.cpp` 의 `ApplyAvatarMeasurements`).
 */
export type AvatarMeasurementTargets = Record<string, number | null>;

/**
 * ⚠️ **오래 걸리는 유일한 op 이다.** 목표까지 `bodyDimensionStepCm` 씩 쪼개
 * 밀면서 단계마다 `simulationIterations` 번 시뮬을 돌린다 — 그동안 워커는
 * **다른 요청에 응답하지 못한다**(stdin 을 순차 처리한다).
 *
 * **[실측 2026-08-11]** Release, 허리둘레 Δ15cm = 16단계 × 6회 = Step 96번,
 * **15.4초**. (같은 조건 Debug 는 142초로 워커 기본 타임아웃 120초를 넘겼다.)
 *
 * `applied` 가 비고 `skipped` 만 크면 "바꿀 것이 없었다" 가 정상 통과한 것이다.
 */
export interface SetAvatarMeasurementsResult {
  /** 실제로 목표를 건 치수 이름 */
  applied: string[];
  /** 엔진에 그런 치수 이름이 없다. `setParams` 와 같은 규약이다 */
  unknown: string[];
  /** 이름은 맞지만 값을 쓸 수 없다 (숫자도 null 도 아닌 값) */
  rejected: string[];
  /** null 이라 건너뛴 수. **오류가 아니다** */
  skipped: number;
  /** 중간 단계 수 (마지막 목표값 단계 포함) */
  steps: number;
  /** 실제로 부른 Step 횟수 = 대략 `steps × simulationIterations` */
  simSteps: number;
  /** 적용 직후의 프레임 카운터. 엔진이 안에서 리셋하므로 보통 -1 이다 */
  frame: number;
  /**
   * ★ **되읽기의 정본이다.** 적용 뒤 `ztDesignZeta` 에서 **다시 잰** 치수
   * (이름 → cm)이고, 요청한 것만이 아니라 **25개 전부**가 실린다.
   *
   * ⚠️ **단, 실제로 적용된 것이 하나도 없으면 비어 있다** (실측 2026-08-11:
   *    키 25개를 전부 null 로 보내면 `skipped:25, steps:0` 에 `measured` 는
   *    `{}`). 워커가 다시 재는 것은 몸을 바꾼 뒤이기 때문이다 — 지금 치수를
   *    그냥 읽고 싶으면 이 op 이 아니라 `avatarBody` 다.
   *
   * ⚠️ 아래 `avatar.measurements[*].real` 은 **이 op 으로 움직이지 않는다** —
   *    그쪽은 씬 데이터의 사본이라 쓰기가 닿지 않는다(실측: Δ15cm 를 걸고
   *    Step 을 96번 돌려도 61.647 그대로였는데 glTF 해시는 바뀌었다).
   *    화면이 "지금 치수" 로 보여줄 값은 반드시 이쪽이다.
   */
  measured: Record<string, number>;
  /** 적용 뒤 다시 읽은 체형. 위 경고대로 `measurements` 쪽은 낡은 값이다 */
  avatar: AvatarBodyResult;
}

// ── 드레이프 (W-1) ──────────────────────────────────────────
//
// `.zls` 는 "입혀진 상태" 를 드레이핑 아이템으로 저장해 둔다. 그냥 로드하면
// 옷이 펼쳐진 채로 나오고, 이 op 이 그 저장된 상태를 씌운다.

/** 씬에 저장된 드레이프 아이템 하나 */
export interface DrapingItem {
  uuid: string;
  name: string;
  /**
   * 자동 드레이프(`ztDrapingItem::AUTO_ITEM_UUID`)인가.
   * **`loadDraping` 이 적용하는 것은 이것 하나다** — 나머지는 목록에만 나온다.
   */
  isAuto: boolean;
}

/**
 * ⚠️ **`applied: false` 는 에러가 아니다.** 씬에 자동 드레이프가 저장돼 있지
 * 않을 뿐이고(`reason: 'noAutoItem'`), 그 경우에도 op 자체는 성공으로 답한다.
 * 씬이 로드되지 않았을 때만 `ok:false` 가 된다.
 *
 * ★ **`applied: true` 면 워커가 프레임 카운터를 -1 로 되돌린다** —
 *   `LoadDrapingItem` 이 안에서 `ztSimulationManager::Reset()` 을 부르기
 *   때문이다. 즉 **`reset` op 과 같은 자리**이고, 화면의 재생 상태·프레임
 *   표시도 리셋과 똑같이 갱신돼야 한다.
 */
export interface LoadDrapingResult {
  applied: boolean;
  /** 왜 못 했는가. `applied: true` 면 없다 */
  reason?: 'noAutoItem' | 'loadFailed';
  items: DrapingItem[];
  count: number;
  /**
   * 엔진이 말하는 활성 아이템. **이것이 적용 여부의 증거다** — 요청을 메아리친
   * 값이 아니다. 쿼리 인터페이스가 없으면 없을 수 있다.
   */
  activeUuid?: string;
  activeName?: string;
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

// ── 디자인 기반 2D (D2-a) ───────────────────────────────────
//
// 재단 도면에 삼각형 메시 말고 **디자인 정보**를 얹기 위한 것이다 — 외곽선,
// 제어점, 봉제선, 스티치.
//
// ★ **좌표가 전부 월드 2D 다.** 워커가 `CreateGeomCubicBezierCurve(uuid,
//   atWorld=true)` 로 배치까지 끝낸 값을 준다. 화면이 `transform2d` 를 다시
//   곱하면 **두 번 적용된다** — 그러면 도면이 그럴듯하게 어긋난 채 나오고,
//   그 증상은 "패턴이 좀 흩어져 보인다" 로만 보여서 원인을 못 찾는다.
//   실측으로 확인했다: 전체 범위 144.24 × 175.45cm 로 L-2a 의 도면 크기와
//   소수점까지 같고, 서피스 상자 겹침이 2.5% 다(#15 가 "배치가 맞으면 2.5%"
//   라고 잰 값).

/** 커브 하나. 폴리라인은 **엔진이 푼 결과**다 — 우리가 베지어를 다시 풀지 않는다 */
export interface Design2DCurve {
  uuid: string;
  /**
   * 커브 종류. ⚠️ **실측에서 나온 것은 `outer`·`inner` 둘뿐이다** —
   * `hole`·`sewline`·`grain`·`seamAllowance` 는 워커가 요청은 하지만 이 씬에
   * 0개다. 즉 **시접은 그릴 데이터가 없다.**
   */
  kind: 'outer' | 'inner' | 'hole' | 'sewline' | 'grain' | 'seamAllowance' | 'stitch';
  /** 직선이면 폴리라인이 양 끝점 2개뿐이다 (세분이 무의미하다) */
  isLine: boolean;
  /** 제어점 4개 = `[x,y, x,y, x,y, x,y]`. 참고 이미지의 원들이 이것이다 */
  cp: number[];
  /** 폴리라인 `[x,y, x,y, ...]`. 최소 2점(4수)이 보장된다 */
  pts: number[];
}

export interface Design2DSurface {
  uuid: string;
  /** 유일하지 않다 — `SurfaceInfo.name` 과 같은 주의 */
  name: string;
  curves: Design2DCurve[];
}

/** 봉제선의 한 조각. **한 커브의 `t0`~`t1` 구간**이다 */
export interface Design2DSeamPart {
  curve: string;
  surface: string;
  /**
   * ⚠️ **`t0 > t1` 일 수 있다** — 실측 73개. 방향이 뒤집힌 파트라는 뜻이고,
   * 워커가 정규화하지 않고 그대로 싣는다. 대응선을 그을 때 필요하다.
   */
  t0: number;
  t1: number;
  /** 그 구간만 잘라낸 폴리라인 (월드) */
  pts: number[];
}

/** 봉제선 하나. `sides[0]` 과 `sides[1]` 이 서로 꿰매진다 */
export interface Design2DSeam {
  uuid: string;
  /** 길이 2. 각 측이 파트 여러 개일 수 있다 (실측: 최대 4파트) */
  sides: Design2DSeamPart[][];
  /**
   * ★ **대응점 쌍 `[[ax,ay,bx,by], ...]` — 화면은 이 개수만큼 점선을 긋는다.**
   *
   * 엔진의 `ztDesignSeam::GetPositionsForDraw(p0, p1, world=true)` 가 준 값이고,
   * 데스크톱 `Seam2DRenderer::RenderSewingLines` 가 쓰는 바로 그것이다.
   *
   * ⚠️ **개수를 화면이 정하면 안 된다.** 실제로 두 번 틀렸다 — 봉제선당
   *    중점 하나(45줄)는 너무 적고, 길이 4cm마다(199줄)는 너무 많다.
   *    엔진이 주는 것은 **108줄**(봉제선당 2~4)이다.
   */
  links: number[][];
  /**
   * ★ 엔진이 준 색 `[r,g,b,a]` (`ztDesignSeam::GetColor`). 실측 **22종**이고
   * 참고 이미지의 알록달록한 색이 이것이다.
   *
   * ⚠️ `.zls` 의 `seams` JSON 에는 색 필드가 없어서 처음에 "색은 데이터에
   *    없다" 고 잘못 결론지었다 — 스티치만 보고 판단한 탓이다. 객체가 갖고
   *    있다. null 이면 그때만 화면이 자기 팔레트로 떨어진다.
   */
  color: number[] | null;
}

/**
 * 스티치. ⚠️ **색이 회색·흰색 2종뿐이다** (실측: 0.408 회색 50개, 흰색 4개).
 * 참고 이미지의 알록달록한 색은 여기서 나오지 않는다.
 */
export interface Design2DStitch {
  uuid: string;
  surface: string;
  /** `[r,g,b,a]` 0~1 */
  color: number[];
  curves: Design2DCurve[];
}

export interface Design2DResult {
  surfaces: Design2DSurface[];
  seams: Design2DSeam[];
  stitches: Design2DStitch[];
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
