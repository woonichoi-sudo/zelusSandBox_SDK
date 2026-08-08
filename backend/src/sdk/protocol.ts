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
  /** base64. float32 x2. topology:true 일 때만 */
  uvs?: string;
  /**
   * 패턴 로컬 → 월드 (ISSUE-011). **topology:true 일 때만.**
   *
   * 프레임 이벤트의 mesh(= topology:false)에는 없다. 프레임마다 바뀌지 않는
   * 값이라 최초 1회만 싣기 때문이다(sample.zls 249프레임 실측에서 비트 단위
   * 동일). 받는 쪽은 한 번 받아 계속 쓴다.
   */
  transform?: PatternTransform;
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
