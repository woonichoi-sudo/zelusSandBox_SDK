/**
 * 게이트웨이 ↔ 브라우저 메시지 타입.
 *
 * ── 왜 복제하지 않는가 ──────────────────────────────────────
 * 이 파일은 타입을 **다시 적지 않고** `backend/src/sdk/protocol.ts` 에서
 * 그대로 끌어온다. 복제하면 op 이 하나 늘거나 결과 모양이 바뀔 때 두 곳이
 * 조용히 어긋나고, 그 어긋남은 런타임에야(그것도 사용자 브라우저에서) 드러난다.
 * bridge.ts 가 화이트리스트를 `Record<Op, OpRule>` 테이블로 둔 것과 같은 이유다 —
 * 결정을 안 내리면 컴파일이 깨지게 만든다.
 *
 * ── 그런데 왜 import 가 `import type` 뿐인가 ────────────────
 * SDK 의 `decodeFloat32`/`decodeInt32`/`decodePatterns` 는 Node 의 `Buffer` 를
 * 쓴다. 브라우저에는 없다. `import type` 은 `verbatimModuleSyntax` 아래에서
 * **완전히 지워지므로** 번들에 backend 코드가 한 줄도 들어가지 않는다 —
 * Vite 는 이 import 를 보지도 못한다. 값이 필요한 디코딩은 브라우저 API 로
 * 새로 쓴 `./decode.ts` 가 담당한다. (SDK 는 수정 금지 대상이다.)
 *
 * 상대경로가 저장소 밖으로 나가는 유일한 파일이 여기다. 경로를 늘리고 싶으면
 * 이 파일에 re-export 를 더할 것 — 다른 파일은 전부 `./types.ts` 만 본다.
 */

import type {
  Event as WorkerEvent,
  MeshDataResult,
  Op,
  Response as WorkerResponse,
} from '../../../backend/src/sdk/protocol.ts';

export type {
  // 아바타 체형 (L-3a). ⚠️ `AvatarMeasurement.real` 은 로드 시점 값이고
  // 체형을 바꿔도 갱신되지 않는다 — 원본 주석 참고.
  AvatarBodyResult,
  AvatarMeasurement,
  SetAvatarBodyResult,
  ErrResponse,
  MeshDataResult,
  MeshInfoResult,
  OkResponse,
  Op,
  PatternData,
  PatternInfo,
  PatternMaterial,
  PatternTransform,
  PatternTransform2D,
  SetParamsResult,
  SimulationParams,
  StatusResult,
  SubscribeResult,
  VersionResult,
} from '../../../backend/src/sdk/protocol.ts';

/**
 * 게이트웨이가 실제로 받아 주는 op.
 *
 * 워커의 op 전체에서 차단된 것을 뺀 것이다 (bridge.ts 의 OPS 테이블):
 *   - `quit` — 세션 종료는 소켓을 닫는 것으로 한다
 *
 * `export` 는 **#10 에서 열렸다** (커밋 `1a178ab`). 다만 워커의 `export` 는
 * `path` 를 요구하는 반면 게이트웨이는 **`path` 를 받으면 거부한다** — 산출물
 * 위치는 서버가 정하고 클라이언트가 넣는 것은 `format` 하나뿐이다. 그래서 이
 * 타입은 op **이름**만 공유하고 payload 는 공유하지 않는다
 * (`GatewayClient.exportScene()` 참고).
 *
 * `Exclude` 로 **빼서** 정의한 이유: 목록을 새로 적으면 워커에 op 이 늘어도
 * 여기가 모른다. 빼는 형태면 늘어난 op 이 자동으로 들어오고, 그게 틀렸다면
 * 서버가 "알 수 없는 op" 으로 알려 준다.
 */
export type ClientOp = Exclude<Op, 'quit'>;

/** 익스포트 형식. 게이트웨이가 이 둘만 받는다 (bridge.ts `isExportFormat`) */
export type ExportFormat = 'gltf' | 'zbin';

/**
 * `export` op 의 결과 — **게이트웨이가 갈아 끼운 모양이다.**
 *
 * 워커는 `{ path, format }` 을 돌려주지만 서버 절대경로가 밖으로 나가면 안 되므로
 * bridge.ts 가 id 와 다운로드 URL 로 바꿔 끼운다. `load` 의 `{ loaded, path }`
 * → `{ loaded, scene }` 과 정확히 같은 처리다.
 *
 * ⚠️ `url` 은 **상대 경로**(`/api/exports/<id>`)다. 오리진을 서버가 지어내면
 *    프록시 뒤에서 틀리기 때문이다 — 붙일 오리진은 클라이언트가 이미 안다.
 */
export interface ExportResult {
  /** 32자리 hex. **이것이 곧 다운로드 권한이다** — 목록 라우트가 없다 */
  id: string;
  format: ExportFormat;
  /** 산출물 크기. 실측 sample.zls 9.7MB / 사용자 씬 36.5MB */
  bytes: number;
  /** `Content-Disposition` 에 실리는 파일명. 열려 있는 씬에서 딴다 */
  name: string;
  createdAt: string;
  /** `/api/exports/<id>`. 상대 경로다 */
  url: string;
}

/**
 * 서버 → 클라이언트 이벤트.
 *
 * 워커의 `Event` 에서 `ready` 를 뺀 것이다. `ready` 는 워커가 기동 직후 한 번
 * 보내고 SDK 가 소비하며, 소켓이 열리기 **전에** 끝난다 — 브라우저에는 절대
 * 오지 않는다. 브라우저에게 "준비됐다"는 소켓이 열렸다는 사실 자체다
 * (sessions.ts 머리말 ①의 불변식).
 */
export type ServerEvent = Exclude<WorkerEvent, { event: 'ready' }>;

/** 서버 → 클라이언트 응답. 워커 프로토콜과 같은 모양이다 */
export type ServerResponse<T = unknown> = WorkerResponse<T>;

/** 소켓으로 들어오는 모든 것 */
export type ServerMessage<T = unknown> = ServerResponse<T> | ServerEvent;

/**
 * 응답과 이벤트의 판별 — **`'event' in msg` 하나뿐이다.**
 *
 * ⚠️ "id 가 없으면 이벤트" 는 **틀렸다.** 응답에도 id 가 없는 경로가 셋 있다
 * (JSON 파싱 실패 / op 필드 누락 / 바이너리 프레임 거부). 그것들을 이벤트로
 * 오인하면 서버가 알려준 오류를 통째로 삼키게 된다.
 *
 * 없는 것이 아니라 **있는 것**으로 판별한다. 응답에 `event` 필드가 붙는 경로는
 * 존재하지 않는다.
 */
export function isServerEvent(msg: ServerMessage): msg is ServerEvent {
  return 'event' in msg;
}

/**
 * `load` 의 결과. 워커는 `{ loaded, path }` 를 돌려주지만 게이트웨이가 서버
 * 절대경로를 씬 id 로 바꿔 끼운다 (bridge.ts 의 mapResult).
 */
export interface LoadResult {
  loaded: boolean;
  scene: string;
}

/** `GET /api/health` 응답 */
export interface HealthBody {
  status: 'ok';
  uptimeMs: number;
  pid: number;
  node: string;
  time: string;
}

/** `POST /api/scenes` 가 돌려주는 씬 한 건 */
export interface SceneSummary {
  id: string;
  name: string;
  bytes: number;
  uploadedAt: string;
}

/**
 * 프레임 이벤트의 mesh.
 *
 * ⚠️ 구독 중이 아니면 **키 자체가 없다.** `null` 이 아니다 — `mesh === null`
 * 로 검사하면 영원히 거짓이다. `mesh === undefined` 이거나 `'mesh' in ev` 를 쓸 것.
 */
export type FrameMesh = MeshDataResult;
