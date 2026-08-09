/**
 * 프론트엔드 프로토콜 계층의 공개 표면.
 *
 * 렌더링(#12)이든 스모크든 **여기만 import 한다.** 내부 파일을 직접 가리키는
 * 경로가 늘어나면 나중에 구조를 바꿀 때 전부 따라 고쳐야 한다.
 *
 *   import { GatewayClient, decodePatterns } from './protocol/index.ts';
 */

export {
  GatewayClient,
  GatewayClosedError,
  GatewayError,
  GatewayTimeoutError,
  type ClientState,
  type GatewayClientOptions,
  type GatewayEvents,
  type ReconnectPolicy,
  type WebSocketCtor,
} from './client.ts';

export {
  base64ToBytes,
  decodeFloat32,
  decodeInt32,
  decodePattern,
  decodePatterns,
  meshStats,
  type DecodedPattern,
} from './decode.ts';

export { Emitter, type Listener, type Unsubscribe } from './emitter.ts';

export {
  ApiError,
  downloadExport,
  fetchHealth,
  listScenes,
  uploadScene,
  type DownloadProgress,
} from './http.ts';

export { isServerEvent } from './types.ts';
export type {
  ClientOp,
  ErrResponse,
  ExportFormat,
  ExportResult,
  FrameMesh,
  HealthBody,
  LoadResult,
  MeshDataResult,
  MeshInfoResult,
  OkResponse,
  Op,
  PatternData,
  PatternInfo,
  PatternTransform,
  PatternTransform2D,
  SceneSummary,
  ServerEvent,
  ServerMessage,
  ServerResponse,
  SetParamsResult,
  SimulationParams,
  StatusResult,
  SubscribeResult,
  VersionResult,
} from './types.ts';

export { resolveEndpoints, withScene, type Endpoints } from './url.ts';
