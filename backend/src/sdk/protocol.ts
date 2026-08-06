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
  | { event: 'frame'; frame: number }
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
   * frame 이벤트에 메시를 실어 보낼지. 씬 상태가 아니라 클라이언트의 전송
   * 취향이므로 load/clear/reset이 건드리지 않는다 — 워커 수명 내내 유지된다.
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
