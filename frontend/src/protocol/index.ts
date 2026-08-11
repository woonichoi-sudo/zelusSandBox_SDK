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
  decodeAvatar,
  decodeAvatarPart,
  decodeAvatars,
  decodeAvatarTextures,
  decodeFloat32,
  decodeInt32,
  decodePattern,
  decodePatterns,
  decodeMeshTextures,
  decodeTextureTable,
  isAnimationFinished,
  meshStats,
  type DecodedAvatar,
  type DecodedAvatarPart,
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
  PatternMaterial,
  PatternTransform,
  PatternTransform2D,
  // 텍스처 (materials-c)
  MaterialTextures,
  TextureAsset,
  TextureEntry,
  SceneSummary,
  ServerEvent,
  ServerMessage,
  ServerResponse,
  // 아바타 체형 (L-3a)
  AvatarBodyResult,
  AvatarMeasurement,
  SetAvatarBodyResult,
  // 아바타 메시 (AM-1). ★ 정점이 **월드 cm** 다 — 옷과 달리 변환을 곱하면 안 된다
  AvatarMesh,
  AvatarMeshResult,
  AvatarPart,
  AvatarPartMaterial,
  // 치수로 몸 만들기 · 드레이프 (W-1)
  AvatarMeasurementTargets,
  SetAvatarMeasurementsResult,
  DrapingItem,
  LoadDrapingResult,
  // 옷 사이즈 (L-3b)
  SurfaceInfo,
  SurfacesResult,
  // 디자인 기반 2D (D2-a)
  Design2DCurve,
  Design2DResult,
  Design2DSeam,
  Design2DSeamPart,
  Design2DStitch,
  Design2DSurface,
  SetParamsResult,
  SimulationParams,
  StatusResult,
  SubscribeResult,
  VersionResult,
} from './types.ts';

export { resolveEndpoints, withScene, type Endpoints } from './url.ts';
