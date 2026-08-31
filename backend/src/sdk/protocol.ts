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
  /** 씬에 저장된 드레이핑 아이템 목록. 부작용이 없다 (DB-1) */
  | { id: number; op: 'drapingItems' }
  /**
   * `.zls` 에 저장된 드레이프를 적용한다 (W-1 / DB-1).
   *
   * `uuid` 를 주면 그 아이템을, **없으면 자동 아이템**을 적용한다 — 인자 없이
   * 부르던 옛 호출이 한 글자도 안 달라진다.
   */
  | { id: number; op: 'loadDraping'; uuid?: string }
  /** 아이템 하나의 미리보기 이미지 (base64). 목록에는 안 실린다 (DB-1) */
  | { id: number; op: 'drapingThumbnail'; uuid: string }
  /**
   * 옷 위에 얹힌 그래픽(프린트·자수) 목록. 부작용이 없다 (LG-1).
   *
   * **원단 텍스처와 다른 계층이다** — 직물을 아무리 잘 입혀도 이것을 따로 싣지
   * 않으면 로고가 화면에 안 나온다. 지금은 목록·크기까지이고, 메시 알맹이는
   * 크기를 재고 나서 정한다.
   */
  | { id: number; op: 'logos' }
  | { id: number; op: 'surfaces' }
  | { id: number; op: 'setSurfaceSize'; uuid: string; width?: number; height?: number }
  | { id: number; op: 'fabrics' }
  | { id: number; op: 'setFabric'; surface: string; fabricId: string }
  | { id: number; op: 'design2d' }
  | { id: number; op: 'meshInfo' }
  | { id: number; op: 'meshData'; topology?: boolean }
  /**
   * 아바타(사람 몸) 메시 (AM-1). **요청해야 오는 값이다** — 스트리밍에
   * 얹혀 있지 않다. 언제 부르는지는 `AvatarMeshResult` 주석 참고.
   */
  | { id: number; op: 'avatarMesh'; topology?: boolean; normals?: boolean }
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
/**
 * 머티리얼이 참조하는 텍스처 — **응답의 `textures` 표 색인**이다.
 *
 * 슬롯 셋으로 줄인 근거는 `protocol.cpp` 의 `kTexSlots` 주석에 있다(용량 대비
 * three.js 에서의 실효). 없는 슬롯은 **키가 아예 없다** — `null` 을 넣으면
 * "텍스처 없음" 과 "표에서 밀렸음" 이 같은 모양이 된다.
 */
export interface MaterialTextures {
  /** 색 텍스처. **sRGB 로 읽어야 한다** (아래 두 슬롯은 아니다) */
  basecolor?: number;
  /** 탄젠트 공간 노멀맵. 선형이다 */
  normal?: number;
  /** 투명도. 선형이다. ⚠️ basecolor 와 **같은 파일일 수 있다**(속눈썹) */
  alpha?: number;
}

/**
 * 응답에 실린 텍스처 파일 한 칸.
 *
 * ── 워커와 게이트웨이가 다른 것을 싣는다 ────────────────────
 * 워커는 **서버 절대경로 문자열**을 싣고, 게이트웨이가 그것을 id + 다운로드
 * URL 로 **바꿔 끼운다** — `load` 의 `{loaded, path}` → `{loaded, scene}`,
 * `export` 의 `{path}` → `{id, url}` 과 정확히 같은 처리다(bridge.ts).
 * 서버 경로가 브라우저에 나가면 #5·#7 이 세운 규칙이 여기서 무너진다.
 *
 * 게이트웨이가 **거절한 칸은 `null`** 이다 — 허용 뿌리 밖이거나, 파일이 없거나,
 * 확장자가 아닌 경우다. 색인이 밀리면 안 되므로 칸을 지우지 않고 비운다.
 */
export interface TextureAsset {
  /** 32자리 hex. 경로의 해시라 **같은 파일이면 항상 같다**(브라우저 캐시가 산다) */
  id: string;
  /** `/api/textures/<id>`. 상대 경로다 — 오리진은 클라이언트가 안다 */
  url: string;
  bytes: number;
}

/** 워커가 싣는 것(경로) 또는 게이트웨이가 바꿔 끼운 것(자산) 또는 거절(null) */
export type TextureEntry = string | TextureAsset | null;

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
  /** 직물 무늬. 없으면 아예 오지 않는다 (`textures:false` 이거나 텍스처 없는 재질) */
  textures?: MaterialTextures;
  /**
   * 직물의 **물리 크기 `[폭, 높이]` cm.** 텍스처 타일링이 여기서 나온다.
   *
   * ★ 옷의 `uvs` 는 0~1 이 아니라 **cm 단위 패턴 좌표**다. 따라서 한 장이
   *   덮는 UV 범위가 곧 이 값이고, 반복 배수는 `1 / 폭`, `1 / 높이` 다.
   *   실측 노랑 2.114cm / 민트 29.997cm — 같은 옷 안에서 14배 차이라,
   *   이 값을 무시하면 무늬 크기가 통째로 틀린다.
   *
   * 0 이하면 아예 오지 않는다("모른다"를 1cm 로 메우면 무늬가 100배가 된다).
   */
  physicalSizeCm?: [number, number];
  /**
   * ⚠️ **아직 해석이 안 끝났다.** 실측된 두 씬 모두 `false` 인데 색과 basecolor
   *    텍스처가 **공존한다** — 엔진이 둘을 곱하는지 텍스처가 이기는지 코드로는
   *    확정하지 못했다. 싣는 이유는 화면에서 갈랐을 때 받는 쪽에 재료가 이미
   *    와 있어야 해서다.
   */
  useCustomBaseColor?: boolean;
  /** 실측상 두 씬 모두 `false`. three.js 의 `texture.flipY` 와 대응한다 */
  flipTextures?: boolean;
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
  /**
   * 이 응답이 참조하는 텍스처 파일 표. **머티리얼은 여기 색인만 갖는다.**
   *
   * 표를 따로 두는 이유는 중복이다 — 같은 파일이 여러 슬롯·여러 파트에 나온다
   * (속눈썹은 한 파트 안에서 basecolor·alpha 두 슬롯, 게다가 좌우가 공유해
   * 같은 파일이 네 번 나온다). 인라인하면 받는 쪽이 같은 이미지를 몇 번씩
   * 내려받거나 스스로 중복 제거를 해야 한다.
   *
   * ⚠️ 텍스처가 하나도 없으면 **키 자체가 없다** (`[]` 가 아니다) — "표는 왔는데
   *    빈 것" 과 "이 워커는 텍스처를 모른다" 를 구분할 수 있어야 한다.
   *    `topology:false`(= 프레임 이벤트) 에는 재질 자체가 없으므로 항상 없다.
   */
  textures?: TextureEntry[];
}

// ── 아바타 메시 (AM-1) ──────────────────────────────────────
//
// 실시간 뷰에 몸을 세우기 위한 것이다. 여태 옷만 떠 있어서 체형을 바꿔도
// 결과가 화면에 안 보였다.
//
// ★ `meshData` 와 별개의 op 인 이유 — 보내는 **주기**가 다르다.
//   `meshData` 는 프레임 이벤트의 본체라 초당 수십 번 나가고, 아바타는
//   그보다 훨씬 크면서 정해진 시점에만 바뀐다. 한 op 에 합치면 구독 중인
//   클라이언트가 프레임마다 몸을 통째로 받는다.
//
//   다만 `topology` 플래그의 **의미는 `meshData` 와 똑같다** — 디코더가
//   두 갈래가 되지 않게 일부러 맞췄다.

/** 아바타 파트의 재질. 옷의 `PatternMaterial` 과 필드 의미가 같다. */
export interface AvatarPartMaterial {
  /** 아바타 에셋 uuid. 옷의 `fabricUuid` 자리에 해당한다 */
  assetUuid: string;
  /** `[r, g, b]`, 각 0~1. `colorProfile` 없이 해석하면 안 된다 */
  color: [number, number, number];
  colorProfile: 'srgb' | 'linear';
  /** 0~1. 제타의 속눈썹은 1 미만이다 — 데스크톱도 이 값으로 반투명 처리한다 */
  opacity: number;
  roughness: number;
  metalness: number;
  /**
   * 피부·눈·속눈썹. 옷과 **같은 표**(`AvatarMeshResult.textures`)를 가리킨다.
   *
   * 실측: Face/Body/Legs/Arms/Eye 는 `basecolor` 하나, 속눈썹은 같은 파일이
   * `basecolor` 와 `alpha` **둘 다**, Pupil·Cornea 는 텍스처 없이 색만(검정).
   */
  textures?: MaterialTextures;
  /**
   * 아바타에서는 실측상 항상 `[1, 1]` 이다. 옷과 달리 UV 가 이미 0~1 정규화된
   * 텍스처 좌표라 **타일링에 쓰면 안 된다** — 그리는 쪽은 아바타에 반복 1 을
   * 고정한다(우연히 1/1 = 1 로 맞아떨어지지만 근거가 다르므로 기대지 않는다).
   */
  physicalSizeCm?: [number, number];
  useCustomBaseColor?: boolean;
  flipTextures?: boolean;
}

/**
 * 아바타의 렌더 파트 하나.
 *
 * 제타는 파트가 여럿이다 — 실측: Face / Body / Legs / Arms + 좌우
 * Eye / Lashe / Pupil / Cornea. 파트마다 재질이 다르므로 합치면 안 된다.
 */
export interface AvatarPart {
  /** `GetRenderMeshs()` 안의 인덱스. 엔진의 파트 순서 그대로다 */
  index: number;
  /** 엔진이 정한 파트 이름 ("Face", "Body", …) */
  name: string;
  vertices: number;
  triangles: number;
  /**
   * base64. float32 x3, 촘촘히 포장됨.
   *
   * ★ **월드 좌표다. 어떤 변환도 곱하지 마라.** 옷(`PatternData.transform`)과
   *   정반대다 — 아바타의 `localTransform` 은 엔진이 정점에 이미 구워 넣고,
   *   glTF 익스포터도 아바타 노드에 항등변환을 준다. 그래서 이 타입에는
   *   `transform` 필드가 아예 없다. 단위는 옷과 같은 cm.
   */
  positions?: string;
  positionStride?: number;
  /**
   * base64. float32 x3. **`normals:false` 로 요청했을 때만 없다.**
   *
   * ⚠️ topology 가 아니라 **positions 와 한 몸**이다 — 몸이 휘면 법선도
   *    바뀐다. 이걸 최초 1회만 받아 두면 몸은 움직이는데 음영만 옛 자세로
   *    고정된다(크래시 없이 화면만 어색해지는 종류의 오류다).
   */
  normals?: string;
  normalStride?: number;
  /** base64. int32. **topology:true 일 때만** */
  indices?: string;
  indexStride?: number;
  /** base64. float32 x2. 텍스처 좌표다(옷의 `uvs` 와 달리 cm 가 아니다). topology:true 일 때만 */
  uvs?: string;
  /**
   * **topology:true 일 때만.** 없으면 아예 오지 않는다 — 옷과 같은 규약으로,
   * "흰 몸" 과 "색을 모름" 을 구분할 수 있어야 한다.
   */
  material?: AvatarPartMaterial;

  // ── 액세서리 파트만 갖는 필드 (몸 파트에는 아예 없다) ──────
  //
  // ★ `accessory` 가 **갈래를 가르는 필드다.** 몸 파트와 액세서리는 같은
  //   `parts` 배열에 섞여 오고 포장도 완전히 같다 — 접근자만 다르다
  //   (`GetRenderMeshs` vs `GetRenderAccessoryMeshes`). 구분이 필요하면
  //   `accessory !== undefined` 로 본다.

  /**
   * 액세서리 종류. **숫자가 아니라 이름으로 온다** — enum 값은 엔진이
   * 재배열하면 조용히 뜻이 바뀐다(옷·파라미터 쪽과 같은 판단이다).
   *
   * `ztAccessoryType` 5종 전부이고, 엔진이 새 종류를 더하면 `unknown` 이다.
   */
  accessory?: 'underwearTop' | 'underwearBottom' | 'sock' | 'shoes' | 'hair' | 'unknown';
  /** 걸친 에셋의 파일 이름 (실측: `low_top_sneakers.obj`). 비어 있으면 `name` 이 종류 이름이 된다 */
  assetName?: string;
  /**
   * 뒷면을 그려야 하는가. **우리 판단이 아니라 데스크톱의 설정을 옮긴 것이다**
   * (Renderer3D.cpp:588 `enableTwoSided()`). 머리카락은 얇은 판이라 뒷면을
   * 버리면 숱이 절반으로 보인다. 실측상 액세서리는 전부 `true` 다.
   */
  doubleSided?: boolean;
}

export interface AvatarMesh {
  uuid: string;
  /** `zeta` 는 치수로 조형되는 아바타, `mannequin` 은 에셋 마네킹 */
  subType: 'zeta' | 'mannequin';
  /** `avatarBody` / `setAvatarMeasurements` 가 대상으로 삼는 아바타인가 */
  current: boolean;
  parts: AvatarPart[];
  /** 파트 합계. 실제로 실은 정점 수다 (요청값의 메아리가 아니다) */
  vertices: number;
  triangles: number;
  /** 애니메이션을 가진 아바타인가. 제타는 항상 true */
  animation: boolean;
  animationTime: number;
  /**
   * `[현재 프레임, 전체 프레임]`.
   *
   * ★ **애니메이션이 끝났는지는 이 값으로 판정한다** — `cur + 1 >= total`.
   *   엔진에 `IsAnimationFinished()` 가 있지만 **부르면 안 된다**: `const`
   *   인데 내부에서 mutable 플래그를 지우고, 시뮬 실행기가 바로 그 플래그로
   *   아바타 갱신 여부를 정한다. 워커가 대신 읽으면 시뮬 동작이 바뀐다.
   *   실행기 자신도 상태 메시지를 만들 때 이 식을 쓴다.
   */
  frameInfo: [number, number];
  /**
   * 실제로 실은 정점에서 **다시 잰** 월드 AABB (cm). 정점이 하나도 없으면 없다.
   *
   * ⚠️ **인덱스가 가리키는 정점만 센 값이다.** 아바타 정점 버퍼에는 어떤
   *    삼각형도 참조하지 않는 쓰레기 정점이 섞여 있을 수 있어서다(glTF
   *    익스포터도 같은 이유로 POSITION min/max 를 인덱스로 돈다). 화면이
   *    `positions` 전체로 상자를 다시 재면 이 값과 달라질 수 있고, 그쪽이
   *    틀린 쪽이다 — 카메라를 그 상자에 맞추면 몸이 구석에 박힌다.
   *
   * 클라이언트가 "진짜 몸이 왔나" 를 이 값 하나로 판정할 수 있고,
   * glTF 익스포트 산출물과 대조할 기준선이기도 하다.
   */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * `avatarMesh` 의 결과.
 *
 * ── 언제 부르는가 ───────────────────────────────────────────
 *   · 씬 로드 직후                — `topology:true`
 *   · `setAvatarMeasurements` 뒤  — 몸이 다시 만들어진다
 *   · `setAvatarBody` 뒤          — 위와 같다
 *   · `loadDraping` 뒤            — ⚠️ **포즈가 크게 바뀐다.** 실측으로 팔이
 *                                   내려오면서 x 범위가 ±61.3 → ±29.9cm 가
 *                                   됐다. 다시 안 받으면 옷은 새 자세인데
 *                                   몸만 옛 자세로 남는다.
 *                                   ⓘ 같은 실측에서 uuid·파트 수·정점 수는
 *                                   그대로였다 — `topology:false` 로 충분했다.
 *                                   (씬 하나의 관측이다. 응답의 `uuid` 나
 *                                    `vertices` 가 달라졌으면 topology 를
 *                                    다시 받을 것.)
 *   · 애니메이션 중               — 포즈가 움직인다. `frameInfo` 가 끝을 알린다
 *
 * ⚠️ **프레임마다 부르지 마라.** 옷 한 프레임의 몇 배다.
 */
export interface AvatarMeshResult {
  /**
   * `joinInSimulation` 이 꺼진 아바타는 오지 않는다 — 데스크톱 3D 뷰와 같은 필터다.
   *
   * ★ **액세서리(머리카락·신발·양말·속옷)도 온다.** 몸 파트와 **같은 `parts`
   *   배열에 섞여** 오고, `AvatarPart.accessory` 가 있는 것이 액세서리다.
   *   한동안 일부러 뺐던 자리인데(텍스처를 실을 통로가 없어 머리카락이
   *   판때기로 보였다) 아래 `textures` 표가 생기면서 붙였다.
   *
   * ⚠️ **파트 인덱스가 몸 뒤로 연속하지 않는다.** 비활성 슬롯도 번호를 먹기
   *    때문이다 — 실측: 몸 12파트(0–11) 다음의 신발이 **29번**이다(그 사이
   *    17칸이 빈 슬롯). 인덱스로 갈래를 나누지 말고 `accessory` 필드를 볼 것.
   *
   * ⚠️ **액세서리에 텍스처가 붙는 것은 머리카락뿐이다.** 신발·양말의
   *    `image->path` 에는 엔진이 안 쓰는 기본값(`Default_Base_Color.png`)이
   *    꽂혀 있고 **그 파일은 설치본에 없다.** 데스크톱 렌더러도 Hair 일 때만
   *    이미지를 만진다 — 익스포터는 타입을 안 보고 거는데 그쪽이 버그다
   *    (1회성 CLI 라 아무도 안 밟았을 뿐이다).
   */
  avatars: AvatarMesh[];
  /** 요청한 값이 그대로 온다. 받은 응답에 indices 가 있는지 판정하는 데 쓴다 */
  topology: boolean;
  normals: boolean;
  totalVertices: number;
  totalTriangles: number;
  /**
   * 텍스처 파일 표. 규약은 `MeshDataResult.textures` 와 같다 — **아바타 안에서
   * 특히 중요하다**: 속눈썹 한 파일이 슬롯 둘 × 좌우 둘 = 네 번 참조된다.
   *
   * 실측(제타 아바타): 6칸 5.79MB — face 0.66 / body 1.14 / leg 1.46 /
   * arm 0.84 / eye 1.29 / eyelashes 0.40.
   */
  textures?: TextureEntry[];
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
  /**
   * 치수 25개. 키는 `ztAvatarMeasureUtils::GetMeasurePartName`.
   *
   * ★ **`measurementSource` 를 함께 보라** — `live` 면 지금 몸을 방금 잰 값이고,
   *   `sceneData` 면 `.zls` 에 저장된 **로드 시점 값**이라 체형을 바꿔도 안 움직인다.
   */
  measurements?: Record<string, AvatarMeasurement>;
  /**
   * `measurements[].real` 을 어디서 읽었는가 (ISSUE-021).
   *
   * - `live` — 살아 있는 `ztDesignZeta::GetMeasurement()` 에서 방금 쟀다.
   *   **제타 아바타면 언제나 이쪽이다.** 실측: `height` 를 0.5 → 0.9 로 올리면
   *   25개 중 19개가 따라 움직인다(`Height` 175.739 → 196.503).
   * - `sceneData` — 제타가 아니라 그 경로가 없어 `.zls` 의 저장값으로 떨어졌다.
   *   **체형을 바꿔도 이 값은 안 움직인다** — 화면이 그렇게 말해야 한다.
   *
   * ⚠️ 옛 워커는 이 필드를 안 보낸다. 없으면 `sceneData` 로 취급하는 편이
   *    안전하다 — "안 움직일 수 있다" 가 더 조심스러운 쪽이다.
   */
  measurementSource?: 'live' | 'sceneData';
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

// ── 드레이핑 보드 (W-1 / DB-1) ──────────────────────────────
//
// `.zls` 는 "입혀진 상태" 를 드레이핑 아이템으로 저장해 둔다. 그냥 로드하면
// 옷이 펼쳐진 채로 나오고, 이 op 들이 그 저장된 상태를 씌운다.
//
// ★ 아이템 하나는 프레임 한 장이 아니라 **완전한 세이브스테이트**다 —
//   솔버 월드 통째(2.1~2.8MB) + 그 시점의 씬 데이터 전체 사본 + 미리보기 PNG.
//   그래서 적용은 "다시 계산" 이 아니라 "그 순간으로 되돌아가기" 다.
//
// ★ **W-1 은 자동 아이템 하나만 적용할 수 있었다.** DB-1 이 그것을 보드로
//   넓혔다: `drapingItems` 로 목록을 읽고, `loadDraping({uuid})` 로 아무거나
//   고르고, `drapingThumbnail` 로 미리보기를 받는다. 인자 없는 `loadDraping`
//   은 **한 글자도 안 달라졌다**.

/** 아이템의 미리보기 이미지 **메타데이터**. 바이트는 안 실린다 */
export interface DrapingThumbnailInfo {
  /** 실측 512×512 */
  width: number;
  height: number;
  /** 원본(인코딩된) 바이트 수. base64 로 받으면 약 4/3 배가 된다 */
  bytes: number;
  /**
   * 워커가 **매직 바이트로 가려낸** 형식. 실측 sample.zls 는 전부 `image/png`.
   *
   * ⚠️ 엔진의 `ztImage::FileType()` 은 `.zls` 에서 온 이미지에 대해 언제나
   *    UNKNOWN 이라(`SetCompressData` 가 그 필드를 안 채운다) 못 쓴다.
   */
  mime: string;
}

/** 씬에 저장된 드레이프 아이템 하나 */
export interface DrapingItem {
  uuid: string;
  name: string;
  /**
   * 자동 드레이프(`ztDrapingItem::AUTO_ITEM_UUID`)인가.
   * **인자 없는 `loadDraping` 이 적용하는 것이 이것**이다.
   */
  isAuto: boolean;
  /**
   * 그 상태가 몇 프레임째였는가. 쿼리 인터페이스를 못 얻으면 없다.
   *
   * ⚠️ 이 값은 적용 뒤 워커가 되돌리는 프레임 카운터(-1)와 **다른 축이다** —
   *    저장 당시의 번호일 뿐, 적용 후 화면이 그 번호에서 시작하지 않는다.
   */
  frameNo?: number;
  /**
   * 저장 시각, **unix 초**. 없을 수 있다 — 엔진이 무효값(-1)이나 1970-01-01(0)
   * 을 주면 아예 안 싣는다("1970년에 저장됨" 은 없는 것만 못하다).
   *
   * ⚠️ **시간대가 불명이다.** `ztDateTime` 은 시간대를 안 들고 다니고
   *    (헤더 주석), 저장한 쪽이 UTC 였는지 로컬이었는지 기록이 없다. 화면에
   *    분 단위 정확도를 약속하지 말 것.
   */
  savedAt?: number;
  /** 미리보기가 있으면. 없으면 **키가 아예 없다** */
  thumbnail?: DrapingThumbnailInfo;
}

/** `drapingItems` — 목록만. 부작용이 없다 */
export interface DrapingItemsResult {
  items: DrapingItem[];
  count: number;
  /**
   * 엔진이 말하는 활성 아이템. 쿼리 인터페이스가 없으면 없을 수 있다.
   *
   * ⚠️ 씬을 갓 로드했을 때 이것이 무엇인지는 **씬이 정한다** — 우리가 아직
   *    아무것도 적용하지 않았어도 비어 있지 않을 수 있다.
   */
  activeUuid?: string;
  activeName?: string;
}

/**
 * ⚠️ **`applied: false` 는 에러가 아니다.** 씬에 자동 드레이프가 없거나
 * (`noAutoItem`) 준 uuid 가 목록에 없을 뿐이고(`notFound`), 그 경우에도 op
 * 자체는 성공으로 답한다. 씬이 로드되지 않았을 때만 `ok:false` 가 된다.
 *
 * ★ **`applied: true` 면 워커가 프레임 카운터를 -1 로 되돌린다** —
 *   `LoadDrapingItem` 이 안에서 `ztSimulationManager::Reset()` 을 부르기
 *   때문이다. 즉 **`reset` op 과 같은 자리**이고, 화면의 재생 상태·프레임
 *   표시도 리셋과 똑같이 갱신돼야 한다.
 *
 * ⛔ **`applied:true` 를 "솔버 상태까지 복원됐다" 로 읽지 말 것.** 엔진이
 *   돌려주는 값은 변수 이름이 `noShield` 이고 성공 여부가 아니다 — 시뮬이
 *   돌고 있거나 역직렬화가 실패해도 `true` 로 빠져나간다
 *   (`Zest/simulation/ztSimulationManager.cpp:482`). 확실한 것은 아래
 *   `activeUuid` 가 바뀌었다는 것("씬이 그 아이템으로 갈아탔다")까지다.
 */
export interface LoadDrapingResult extends DrapingItemsResult {
  applied: boolean;
  /**
   * 왜 못 했는가. `applied: true` 면 없다. 셋은 **다른 화면을 뜻한다**:
   *
   *   noAutoItem  씬에 자동 드레이프가 없다. **인자 없이 불렀을 때만** 난다
   *   notFound    준 uuid 가 목록에 없다. 목록이 낡았거나 uuid 를 지어냈다
   *   loadFailed  엔진이 거절했다
   */
  reason?: 'noAutoItem' | 'notFound' | 'loadFailed';
  /**
   * 무엇을 고르려 했는가. `reason:'notFound'` 면 없다.
   *
   * ★ 위 `activeUuid`(엔진이 말하는 것)와 **다를 수 있고, 다르면 그것 자체가
   *   진단이다** — 엔진이 우리가 고른 것과 다른 자리에 있다는 뜻이다.
   */
  appliedUuid?: string;
}

/**
 * `drapingThumbnail` — 아이템 하나의 미리보기.
 *
 * ⚠️ **`hasImage:false` 는 에러가 아니다.** "그런 아이템의 그림이 있는가" 가
 *    질문이고 "없다" 는 그 질문의 정당한 답이다 — 없는 uuid(`notFound`)도
 *    여기로 온다(`loadDraping` 의 `notFound` 와 같은 채널이다). 씬이 로드되지
 *    않았을 때만 `ok:false` 가 된다.
 */
export interface DrapingThumbnailResult {
  uuid: string;
  /** 아이템 이름. `notFound` 면 없다 */
  name?: string;
  hasImage: boolean;
  /**
   *   notFound           그 uuid 의 아이템이 목록에 없다
   *   noImage            아이템은 있는데 미리보기 없이 저장됐다
   *   unsupportedFormat  압축되지 않은 생픽셀이거나 모르는 매직 —
   *                      **실측에서 본 적 없다**. 났다면 그 자체가 발견이다
   */
  reason?: 'notFound' | 'noImage' | 'unsupportedFormat';
  width?: number;
  height?: number;
  mime?: string;
  /** 원본 바이트 수 (base64 길이가 아니다) */
  bytes?: number;
  /**
   * **base64 로 인코딩된 이미지 파일 바이트.** 픽셀이 아니라 PNG/JPEG 파일
   * 통째이므로, `data:${mime};base64,${data}` 로 바로 `<img>` 에 물릴 수 있다.
   */
  data?: string;
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
  /**
   * 이 조각이 **지금 입고 있는 직물** (UI #50). 없으면 키가 아예 없다 —
   * "직물이 없다" 와 "모른다" 를 구분할 수 있어야 한다.
   *
   * ★ `FabricInfo.id` · `PatternMaterial.fabricUuid` 와 **같은 문자열**이라
   *   셋이 서로 짝지어진다. ⛔ 위 `uuid`(서피스)와는 **형식이 다르다** —
   *   섞으면 "서피스를 찾을 수 없습니다" 로 조용히 실패한다.
   */
  fabricUuid?: string;
}

export interface SurfacesResult {
  surfaces: SurfaceInfo[];
}

// ── 직물 (UI #50) ───────────────────────────────────────────
//
// 데스크톱의 `Pattern ▸ Fabric` 콤보와 같은 것이다 — 재단 조각 하나를 고르고
// 원단을 고르면 그 조각이 그 원단이 된다. 출처·필터도 데스크톱과 같다
// (`zwMaterialManager::GetFabricRootFolder()` 의 `Preset` / `In file` 두 폴더).
//
// ⚠️⚠️ **이 설치본에는 `Preset` 이 없다.** 실측(2026-08-12): 씬을 열기 전에는
//    0개, 연 뒤에는 **씬 내장 2개뿐**이다(`fabric_custom` 이 비어 있고 프리셋
//    폴더는 디스크에 아예 없다). 즉 지금 할 수 있는 일은 "그 옷이 이미 쓰는
//    직물끼리 재배정" 이고, "라이브러리에서 새 원단 고르기" 가 아니다.
//    **기능이 좁은 것이 아니라 이 머신에 원단이 없는 것이다** — 원단이 있는
//    환경에서는 그대로 다 뜬다.

export interface FabricInfo {
  /** 직물 자산 id. `setFabric` 에 그대로 돌려준다 */
  id: string;
  name: string;
  /** `inFile` = `.zls` 안에 든 것(이 옷이 실제로 입은 것), `preset` = 설치본 라이브러리 */
  source: 'preset' | 'inFile';
  custom: boolean;
  /** 앞면 basecolor 에 텍스처 경로가 있는가 */
  hasTexture: boolean;
  /**
   * ★ **그 경로의 파일이 실제로 있는가.** 경로가 있다고 파일이 있는 것이
   * 아니다 — 프리셋 직물이 가리키는 `Default_Base_Color.png` 가 이 설치본에
   * 없고, 그런 것을 고르면 게이트웨이가 텍스처를 거절해 화면에 `⚠ 거절` 이
   * 뜬다(액세서리 작업에서 실제로 밟았다). **고르기 전에 알 수 있어야 한다.**
   */
  textureExists: boolean;
}

/**
 * 옷 위의 그래픽 — 로고 (LG-1).
 *
 * ★ **메시가 좌표가 아니라 무게중심이다.** `tri`(패턴 삼각형의 정점 색인 3개)와
 *   `ratio`(그 안의 비율 2개)로 한 점이 정해지고, 받는 쪽이
 *   `p = v0 + (v1-v0)·x + (v2-v0)·y` 로 푼다. 옷이 매 프레임 움직여도 **다시
 *   받을 필요가 없다** — 이 사실이 프로토콜의 모양을 정했다.
 * ⓘ `positions` 는 그 순간의 정답 좌표다. 받는 쪽이 자기 계산을 한 번 대조해
 *   규약을 잘못 읽은 것을 숫자로 잡으라고 같이 싣는다(실측 오차 0.000006cm).
 */
export interface LogoInfo {
  uuid: string;
  /** 이 로고가 붙은 패턴. `meshData` 의 패턴 uuid 와 같은 문자열이다 */
  patternUuid: string;
  assetUuid: string;
  assetName: string;
  /** cm */
  width: number;
  height: number;
  angle: number;
  /** 메시에서 띄우는 거리(cm). 0 이면 옷과 같은 면이라 얼룩진다 */
  offsetFromMesh: number;
  textureRatio: number;
  keepRatio: boolean;
  isMetal: boolean;
  shareOnSeam: boolean;
  /** 꺼져 있으면 3D 에 그리지 않는다 — 데스크톱과 같은 동작이다 */
  showIn3DView: boolean;
  /** 짝이 되는 패턴이 씬에 있는가. 없으면 받는 쪽이 그릴 자리를 못 찾는다 */
  patternFound: boolean;
  patternVertices?: number;
  basePoints: number;
  baseIndices: number;
  baseUv: number;
  smoothPoints: number;
  smoothIndices: number;
  hasTexture: boolean;
  textureExists: boolean;
  /** `textures` 표의 색인 */
  textureIndex?: number;
  /** base64 — int32 3개씩 */
  tri?: string;
  /** base64 — float 2개씩 */
  ratio?: string;
  /** base64 — int32 */
  indices?: string;
  /** base64 — float 2개씩 */
  uv?: string;
  /** base64 — float 3개씩. 지금 이 순간의 정답 좌표 (위 ⓘ) */
  positions?: string;
}

export interface LogosResult {
  logos: LogoInfo[];
  /** 로고 그림. `meshData` 와 **같은 표**다 — 게이트웨이가 id + URL 로 바꾼다 */
  textures?: TextureEntry[];
}

export interface FabricsResult {
  /** 씬을 열기 전에는 비어 있을 수 있다 — 씬 내장 직물은 로드해야 채워진다 */
  fabrics: FabricInfo[];
}

export interface SetFabricResult {
  surface: string;
  fabricId: string;
  /** 입힌 직물의 이름 */
  name: string;
  /**
   * **되읽은 값이다** — 요청의 메아리가 아니다. 그 서피스를 쓰는 패턴의
   * `GetFrontMaterial()` 을 적용 뒤 다시 읽었다. 비어 있으면 그 서피스를 쓰는
   * 패턴을 못 찾았다는 뜻이다.
   */
  applied: {
    fabricUuid: string;
    /** `[r, g, b]`, 각 0~1 */
    color: [number, number, number];
    roughness: number;
    hasTexture: boolean;
  } | Record<string, never>;
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
