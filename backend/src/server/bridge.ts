/**
 * 클라이언트 → 워커 방향의 op 중계 **정책**.
 *
 * 전송(소켓·프레임·JSON 파싱)은 sessions.ts가 갖고, 이 파일은 그 위의 판단만
 * 갖는다: **무엇을 통과시키고, 무엇으로 바꿔서 보내고, 무엇을 되돌려주는가.**
 * 파일을 가른 기준이 "게이트웨이/브리지"가 아니라 "전송/정책"인 이유:
 *
 *   - 여기 있는 코드가 이 단위에서 유일하게 **보안에 걸리는** 부분이다.
 *     소켓 수명과 섞여 있으면 "이 값이 워커에 닿기 전에 무엇을 지나는가"를
 *     한눈에 확인할 수 없다. 지금은 OPS 테이블 하나만 읽으면 된다.
 *   - 여기엔 WebSocket도, 풀도, 연결 상태도 없다. 의존이 sessions → bridge
 *     한 방향뿐이라 결합이 늘지 않는다. 오히려 sessions.ts의 #onMessage가
 *     "파싱해서 넘긴다"로 줄어든다.
 *
 * ── 이 파일이 지키는 것 두 가지 ──────────────────────────────
 *
 * ① **클라이언트 필드는 build()를 통과해야만 워커에 닿는다.** 요청 객체를
 *    그대로 흘려보내는 경로가 없다. 워커의 `load`/`export`는 파일 절대경로를
 *    받는데, 그걸 클라이언트가 직접 주면 서버의 임의 파일을 열고(load) 임의
 *    위치에 쓴다(export). 그래서 payload는 항상 **새 객체로 조립**한다 —
 *    스프레드로 넘기지 않는다. 새 op을 추가할 때 이 규칙만 지키면 된다.
 *
 * ② **역방향도 막는다.** 워커의 load 응답은 `{ loaded, path }`라 서버 절대경로가
 *    결과에 섞여 나온다(protocol.cpp:503). 응답을 그대로 중계하면 #5가 세운
 *    "경로는 밖으로 안 나간다"가 여기서 무너진다. mapResult가 그 자리를 막고,
 *    에러 문자열은 redact()가 한 번 더 훑는다. 워커가 스스로 밀어 보내는
 *    이벤트(#8)도 같은 그물을 지난다 — engineMessageEvent 주석 참고.
 *
 * ── 화이트리스트가 테이블인 이유 ────────────────────────────
 * `Record<Op, OpRule>`이라 protocol.ts에 op이 하나 늘면 **컴파일이 깨진다.**
 * if 나열이었다면 새 op은 조용히 "알 수 없는 op"으로 떨어지거나, 더 나쁘게는
 * default 통과로 열린다. 여기서는 결정을 내리지 않고서는 빌드가 안 된다.
 */

import type { MeshDataResult, Op } from '../sdk/protocol.ts';
import { isExportFormat, type ExportFormat, type ExportStore, type SceneStore } from './files.ts';

/**
 * 브리지가 워커에게 요구하는 표면 전부. SDK Worker가 그대로 만족한다.
 *
 * 제네릭이 아닌 이유: 클라이언트가 보낸 것은 어차피 `unknown`이라 여기서
 * 결과 타입을 안다고 주장할 근거가 없다. 타입이 붙는 건 SDK를 직접 쓰는
 * 코드지, 남의 JSON을 중계하는 이 경로가 아니다.
 */
export interface RelayTarget {
  request(op: Op, payload?: Record<string, unknown>): Promise<unknown>;
}

/** 클라이언트에게 나가는 응답. 워커 프로토콜(Response)과 같은 모양이다 */
export type ClientReply =
  | { id?: number; ok: true; result: unknown }
  | { id?: number; ok: false; error: string };

/**
 * 클라이언트에게 나가는 **이벤트** (#8). 워커가 스스로 밀어 보내는 것들이다.
 *
 * ── 왜 워커 프로토콜과 같은 모양인가 ────────────────────────
 * 감싸지 않는다(`{type:'event', payload:…}` 같은 봉투를 씌우지 않는다).
 * 응답이 이미 워커 프로토콜과 같은 모양이고(ClientReply), 이벤트만 다른
 * 어휘를 쓰면 클라이언트가 **같은 것을 두 이름으로** 알게 된다.
 * `sdk/protocol.ts`의 `Event`·`isEvent()`를 #11이 그대로 재사용할 수 있다는
 * 실질적 이득도 여기서 나온다.
 *
 * ── 구분은 `id`의 유무가 아니라 `event` 필드다 ──────────────
 * "id가 없으면 이벤트"는 **틀린 규칙**이다. 응답에도 id가 없는 경우가 있다:
 * JSON 파싱 실패, `op` 필드 누락, 바이너리 프레임 거부는 전부
 * `{ ok:false, error }`로 나간다(#fail의 id===undefined 갈래).
 * 그래서 판별은 **`'event' in msg`** 하나뿐이다 — 없는 것이 아니라 있는 것으로
 * 판별한다. 응답에 `event` 필드가 붙는 경로는 존재하지 않는다.
 *
 * `ready`는 여기 없다. 워커가 기동 직후 한 번 보내는데, 그때는 소켓이 아직
 * 없고(세션은 업그레이드 **전에** 확보된다) SDK의 `Session.create`가 이미
 * 소비한 뒤다. `Session`은 그걸 다시 emit하지도 않는다 — 중계할 것 자체가
 * 없다. 클라이언트에게 "준비됐다"는 **소켓이 열렸다는 사실**이 곧 그것이다
 * (sessions.ts 머리말 ①의 불변식).
 */
export type ClientEvent =
  | { event: 'frame'; frame: number; mesh?: MeshDataResult }
  | { event: 'engineMessage'; message: string };

/** 소켓으로 나가는 모든 것 */
export type ClientOutbound = ClientReply | ClientEvent;

/** build()가 던지는 "클라이언트 잘못". 메시지가 그대로 클라이언트에게 간다 */
class RejectError extends Error {}

function reject(message: string): never {
  throw new RejectError(message);
}

/** build()의 결과. payload는 **새로 조립된** 것이어야 한다 */
interface Prepared {
  /** 워커에 보낼 페이로드. 없으면 op만 보낸다 */
  payload?: Record<string, unknown>;
  /**
   * 워커 결과 → 클라이언트 결과. 서버 경로처럼 되돌려주면 안 되는 것이
   * 결과에 섞이는 op에서 쓴다. 없으면 결과를 그대로 보낸다.
   *
   * **비동기를 허용한다** (#10). export는 워커가 "썼다"고 답한 뒤에 그 파일을
   * 실제로 stat 해서 확인해야 하는데(protocol.cpp가 ExportGltf의 실패를
   * 확인하지 않는다), 그게 디스크 I/O라 동기로는 할 수 없다. 여기서 `reject()`를
   * 던지면 그 문구가 그대로 클라이언트에게 간다 — 그 밖의 예외는 뭉개진다.
   */
  mapResult?: (result: unknown) => unknown | Promise<unknown>;
  /**
   * 워커가 **실패**로 답했을 때 부른다 (#10). 부작용을 되돌리는 자리다.
   *
   * export만 쓴다. 실패한 익스포트는 반쯤 쓰인 수십 MB짜리 파일을 남길 수
   * 있고, TTL 청소가 30분 뒤에 걷긴 하지만 실패를 아는 순간 지우는 편이 싸다.
   * 던지면 안 된다 — 응답 경로 한가운데다.
   */
  onFailure?: () => void;
}

export interface BuildContext {
  /** 씬 id → 경로 변환의 유일한 소유자 (#5의 결정). 없으면 load를 받지 않는다 */
  scenes?: SceneStore | undefined;
  /** 연결 시 `?scene=`으로 지정된 씬. load의 **기본값**이다 (아래 buildLoad 주석) */
  sceneId: string | null;
  /**
   * 익스포트 산출물 저장소 (#10). 없으면 export를 받지 않는다.
   * 씬 저장소와 같은 역할이다 — id ↔ 경로 변환의 유일한 소유자.
   */
  exports?: ExportStore | undefined;
  /** 이 연결의 id. 산출물 사이드카에 남는다(진단용) */
  sessionId?: string | undefined;

  // ── 아래 둘은 **연결이 살아 있는 동안 변한다** ──────────────
  // BuildContext는 원래 생성 시점의 스냅샷이었지만, #10에서 두 가지가
  // "이 연결이 지금까지 무엇을 했는가"를 알아야 해졌다. 브리지가 인스턴스마다
  // 하나씩 만들어 들고 있으므로 수명은 연결과 정확히 같다 — OPS 테이블을
  // 모듈 수준에 두면서도 연결별 상태를 갖는 유일한 방법이다.

  /**
   * 마지막으로 **성공한** load의 씬 id. 익스포트 파일명을 여기서 짓는다.
   * 초기값은 `?scene=`(sceneId)이며, 클라이언트가 다른 씬을 열면 따라간다.
   */
  loadedScene?: string | null;
  /**
   * 이 연결이 만든 익스포트 id들, 오래된 것부터. **세션당 상한을 여기서 센다.**
   * 상한을 넘기면 앞에서부터 지운다 — 자기 것만 지우므로 다른 세션에 닿지 않는다.
   */
  ownExports?: string[];
}

type Build = (msg: Record<string, unknown>, ctx: BuildContext) => Prepared | Promise<Prepared>;

interface OpRule {
  /** 클라이언트가 부를 수 있는가 */
  readonly allow: boolean;
  /** allow:false 의 사유. 그대로 클라이언트에게 간다 */
  readonly reason?: string;
  /** 페이로드가 필요한 op만. 없으면 op만 보낸다 (부가 필드는 전부 버려진다) */
  readonly build?: Build;
}

// ── 필드 검증 도우미 ────────────────────────────────────────

function requireString(msg: Record<string, unknown>, key: string): string | null {
  const v = msg[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') reject(`${key}는 문자열이어야 합니다`);
  return v;
}

// ── op별 build ──────────────────────────────────────────────

/**
 * load: 클라이언트는 **씬 id**를 준다. 경로는 절대 받지 않는다.
 *
 *   { id, op: 'load', scene: '<32자리 hex>' }
 *   { id, op: 'load' }                        ← 연결 시 ?scene= 을 쓴다
 *
 * id를 고른 이유는 단순하다 — #5가 이미 그 형태로 씬을 식별하고, 변환은
 * `scenes.pathOf(id)` 한 곳에서만 일어난다는 것이 #5의 결정이다. 여기서
 * 경로를 받으면 그 결정이 무의미해진다.
 *
 * **`?scene=`은 구속이 아니라 기본값이다.** 연결에 씬을 못 박고 싶은 유혹이
 * 있지만, 그렇게 해도 얻는 보안이 없다 — 클라이언트는 `GET /api/scenes`로
 * 모든 id를 볼 수 있고, 다른 씬을 열고 싶으면 그 id로 다시 연결하면 그만이다.
 * 반면 잃는 건 크다: 씬을 바꿀 때마다 워커를 새로 띄우게 되고(기동 110ms +
 * 세션 상한 = 라이선스 인스턴스를 그만큼 더 씀), #11이 "다른 옷 열기"를
 * 재연결로 구현해야 한다. 그래서 같은 세션에서 다른 씬을 여는 것을 허용한다.
 *
 * 존재 확인까지 하는 이유: pathOf는 형태만 본다. 없는 씬을 그대로 넘기면
 * 워커가 "zls 로드 실패"라고만 답해서, 파일이 없는 건지 파싱이 깨진 건지
 * 클라이언트가 구분할 수 없다.
 */
const buildLoad: Build = async (msg, ctx) => {
  // 조용히 무시하지 않는다. 무시하면 클라이언트는 자기가 준 경로가 먹혔다고
  // 믿는다 — 실패는 시끄러워야 한다.
  if ('path' in msg) {
    reject('load는 path를 받지 않습니다. 업로드한 씬의 id를 scene 필드로 보내세요');
  }

  const scene = requireString(msg, 'scene') ?? ctx.sceneId;
  if (scene === null) {
    reject('scene 필드가 필요합니다 (POST /api/scenes 의 id). 연결 시 ?scene= 으로도 지정할 수 있습니다');
  }
  if (!ctx.scenes) reject('씬 저장소가 없어 load를 받을 수 없습니다');

  let path: string;
  try {
    // ★ 클라이언트 문자열이 경로가 되는 유일한 지점. 형태가 틀리면 여기서 던진다.
    path = ctx.scenes.pathOf(scene);
  } catch {
    reject(`씬 id 형식이 올바르지 않습니다: ${scene}`);
  }
  if (!(await ctx.scenes.get(scene))) reject(`씬을 찾을 수 없습니다: ${scene}`);

  return {
    payload: { path },
    // 워커는 `{ loaded, path }`를 돌려준다. path를 그대로 내보내면 서버
    // 절대경로가 클라이언트에 노출된다 — id로 바꿔 끼운다.
    mapResult: (r) => {
      const loaded = isRecord(r) ? r['loaded'] === true : true;
      // #10이 익스포트 파일명을 짓는 데 쓴다. **성공했을 때만** 갱신한다 —
      // 실패한 load는 워커 안의 씬을 바꾸지 않으므로, 여기서 따라가면
      // 다음 익스포트가 열리지도 않은 씬의 이름을 달게 된다.
      if (loaded) ctx.loadedScene = scene;
      return { loaded, scene };
    },
  };
};

/**
 * setParams: 값의 **범위**는 검증하지 않는다. 물성 범위는 엔진이 아는 것이고
 * (§7.2의 튜너블 81개), 게이트웨이가 흉내 내면 두 곳이 어긋난 채로 굳는다.
 * 모르는 키도 막지 않는다 — 워커가 `unknown[]`으로 되돌려주는 쪽이 오타를
 * 조용히 삼키지 않는 더 나은 계약이다.
 *
 * 대신 **타입**은 여기서 거른다. 실측: `{ timeStep: "0.01" }`(입력 필드에서
 * 흔히 나오는 문자열)을 보내면 워커가
 *   `예외: [json.exception.type_error.302] type must be number, but is string`
 * 으로 요청 전체를 실패시키는데, 그 앞에 있던 키들은 **이미 적용된 뒤다**
 * (protocol.cpp:118 루프가 키 단위로 대입한다). 부분 적용된 시뮬레이션은
 * 클라이언트가 알 수 없는 상태다. 숫자/불린만 통과시키면 이 경로가 사라진다.
 *
 * 어느 키가 float이고 어느 키가 int인지는 여기서 다시 적지 않는다 — 그
 * 테이블은 protocol.cpp에 있고, 복제하면 반드시 어긋난다.
 */
const buildSetParams: Build = (msg) => {
  const params = msg['params'];
  if (!isRecord(params) || Array.isArray(params)) {
    reject('params 필드가 필요합니다 (객체)');
  }

  const out: Record<string, number | boolean> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'boolean') {
      out[k] = v;
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      reject(`params.${k}는 숫자나 불린이어야 합니다 (받은 값: ${describe(v)})`);
    }
    out[k] = v;
  }
  return { payload: { params: out } };
};

/**
 * setAvatarBody: 체형 값은 **숫자만** 받는다 (L-3a).
 *
 * `buildSetParams` 와 갈리는 점 하나 — 여기에는 불린이 없다.
 * `ztAvatarBodyParam` 29개가 전부 float 이라, 불린을 통과시키면 워커에서
 * `is_number()` 에 걸려 조용히 `unknown` 으로 돌아간다. 그러면 사용자는
 * "적용이 안 됐다" 만 보고 왜인지는 못 본다 — 여기서 거절해야 이유가 남는다.
 *
 * 범위(0~1)는 **검사하지 않는다.** 정규화라는 것은 실측이지 계약이 아니고,
 * 여기서 클램프하면 엔진이 범위 밖 값을 실제로 어떻게 다루는지가 우리 코드에
 * 가려진다. 같은 이유로 `setParams` 도 범위를 엔진에 맡긴다.
 */
const buildSetAvatarBody: Build = (msg) => {
  const bodyParams = msg['bodyParams'];
  if (!isRecord(bodyParams) || Array.isArray(bodyParams)) {
    reject('bodyParams 필드가 필요합니다 (객체)');
  }

  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(bodyParams)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      reject(`bodyParams.${k}는 숫자여야 합니다 (받은 값: ${describe(v)})`);
    }
    out[k] = v;
  }
  return { payload: { bodyParams: out } };
};

/**
 * setSurfaceSize: uuid 는 필수, 크기는 **둘 중 하나만 있어도 된다** (L-3b).
 *
 * 둘 다 요구하지 않는 이유는 워커 쪽과 같다 — 화면이 항상 두 값을 들고 있어야
 * 하면, 폭만 고치려던 사용자가 높이를 낡은 값으로 덮어쓴다.
 *
 * ⚠️ **둘 다 없으면 거절한다.** 통과시키면 워커가 "지금 값으로 다시 쓰기" 를
 *    하고 성공을 돌려주는데, 아무것도 안 바뀐 성공은 화면에서 "바꿨다" 로
 *    읽힌다. 크기 없이 부르는 것은 실수이므로 여기서 이유를 남긴다.
 */
const buildSetSurfaceSize: Build = (msg) => {
  const uuid = msg['uuid'];
  if (typeof uuid !== 'string' || uuid === '') {
    reject('uuid 필드가 필요합니다 (문자열)');
  }

  const out: Record<string, string | number> = { uuid };
  for (const k of ['width', 'height'] as const) {
    const v = msg[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      reject(`${k}는 0보다 큰 숫자여야 합니다 (받은 값: ${describe(v)})`);
    }
    out[k] = v;
  }

  if (out['width'] === undefined && out['height'] === undefined) {
    reject('width 나 height 중 하나는 있어야 합니다');
  }
  return { payload: out };
};

/**
 * export: 클라이언트는 **형식만** 준다. 산출물 위치는 서버가 정한다 (#10).
 *
 *   { id, op: 'export' }                    → gltf
 *   { id, op: 'export', format: 'zbin' }
 *
 * ── 왜 경로를 안 받는가 ─────────────────────────────────────
 * load는 서버의 파일을 **읽고**, export는 **쓴다.** 경로를 받으면 임의 위치에
 * 수십 MB를 쓰게 되고, 확장자를 바꿔 실행 파일이나 설정을 덮는 것까지 한 걸음이다.
 * #5가 업로드에서, #7이 load에서 세운 결정("클라이언트 문자열은 경로가 되지
 * 않는다")이 여기서 가장 중요해진다. 그래서 `path`가 오면 **조용히 무시하지 않고
 * 거부한다** — 무시하면 클라이언트는 자기가 지정한 곳에 파일이 생겼다고 믿는다.
 *
 * ── 응답 ────────────────────────────────────────────────────
 * 워커는 `{ path, format }`을 돌려준다(protocol.cpp:602,607). 그 path가 곧
 * 서버 절대경로다. mapResult가 id와 다운로드 URL로 바꿔 끼우므로 밖으로
 * 나가지 않는다 — load의 `{ loaded, path }`와 정확히 같은 처리다.
 *
 * 실패 문자열 쪽은 mapResult가 못 막는다(엔진이 만든다). 그건 redact가
 * 훑는데, #10에서 익스포트 디렉토리를 그 그물에 **추가**했다 — 안 그러면
 * 씬 경로만 지우고 방금 우리가 워커에 넘긴 산출물 경로는 그대로 나간다.
 */
const buildExport: Build = async (msg, ctx) => {
  if ('path' in msg) {
    reject('export는 path를 받지 않습니다. 산출물 위치는 서버가 정하고, 응답의 url로 내려받습니다');
  }

  const rawFormat = msg['format'];
  if (rawFormat !== undefined && typeof rawFormat !== 'string') {
    reject('format은 문자열이어야 합니다');
  }
  const format: unknown = rawFormat ?? 'gltf';
  if (!isExportFormat(format)) {
    reject(`알 수 없는 익스포트 형식: ${describe(format)} (gltf, zbin)`);
  }

  const store = ctx.exports;
  if (!store) reject('익스포트 저장소가 없어 export를 받을 수 없습니다');

  // 파일명은 열려 있는 씬에서 따온다. 없으면 저장소가 `export.gltf`로 떨어뜨린다.
  // 이름을 **못 구하는 것이 실패가 아니다** — 헤더 값일 뿐이라 익스포트 자체를
  // 막을 이유가 없다.
  const sceneId = ctx.loadedScene ?? ctx.sceneId;
  const sceneName = sceneId && ctx.scenes
    ? (await ctx.scenes.get(sceneId).catch(() => null))?.name
    : undefined;

  const reserved = await store.allocate(format);
  const own = (ctx.ownExports ??= []);
  const sessionId = ctx.sessionId ?? '(알 수 없음)';

  return {
    // ★ 클라이언트가 준 것 중 여기 실리는 건 format 하나이고, 그것도
    //   'gltf'|'zbin' 둘 중 하나로 좁혀진 뒤다. path는 서버가 만든 것이다.
    payload: { path: reserved.path, format },

    mapResult: async () => {
      let record;
      try {
        // 워커가 ok라고 해도 파일이 없을 수 있다 — ExportStore.commit 주석 참고.
        record = await store.commit(reserved.id, {
          format,
          sessionId,
          sceneName,
        });
      } catch (err: unknown) {
        await store.discard(reserved.id).catch(() => {});
        // commit의 문구는 경로를 담지 않도록 쓰여 있으므로 그대로 전달한다.
        reject(err instanceof Error ? err.message : '익스포트 결과를 확인하지 못했습니다');
      }

      // 세션당 상한. 넘치면 **자기 것 중 가장 오래된 것**을 지운다.
      // commit 뒤에 세는 이유: 실패한 시도까지 세면 상한이 실제 보유량보다
      // 빨리 차서, 멀쩡한 산출물이 실패 때문에 밀려난다.
      own.push(record.id);
      while (own.length > store.maxPerSession) {
        const oldest = own.shift();
        if (oldest) await store.discard(oldest).catch(() => {});
      }

      return {
        id: record.id,
        format: record.format,
        bytes: record.bytes,
        name: record.name,
        createdAt: record.createdAt,
        /** 상대 URL이다. 오리진은 클라이언트가 이미 알고 있고(ISSUE-002의
         *  같은 오리진 구조), 서버가 자기 주소를 지어내면 프록시 뒤에서 틀린다. */
        url: `/api/exports/${record.id}`,
      };
    },

    // 워커가 실패로 답했다. 반쯤 쓰인 파일이 남았을 수 있다.
    onFailure: () => {
      void store.discard(reserved.id).catch(() => {});
    },
  };
};

const buildMeshData: Build = (msg) => {
  const topology = msg['topology'];
  if (topology !== undefined && typeof topology !== 'boolean') {
    reject('topology는 불린이어야 합니다');
  }
  return { payload: { topology: topology === true } };
};

// ── 화이트리스트 ────────────────────────────────────────────

/**
 * op 하나당 한 줄. 새 op은 여기에 줄을 더하지 않으면 **컴파일되지 않는다.**
 *
 * 판단 근거는 각 줄에. 요약하면 세 갈래다:
 *   - 그대로 통과 (부가 필드는 build가 없으므로 전부 버려진다)
 *   - build로 변환 (load, setParams, meshData)
 *   - 차단 (quit, export)
 */
const OPS: Record<Op, OpRule> = {
  ping: { allow: true },
  version: { allow: true },

  // 세션 생성 시 autoInit이 이미 부른다. 그래도 여는 이유는 두 가지다:
  // (1) autoInit:false로 띄운 게이트웨이에서는 이게 없으면 load가 죽는다.
  // (2) 재호출이 안전하다는 것을 실측했다 — init을 4번 부르고 로드 후에 또
  //     불러도 워커가 살아 있고 씬도 그대로다(status.loaded=true).
  // 즉 막아서 얻는 안전이 없고, 막으면 구성 하나가 통째로 못 쓰게 된다.
  init: { allow: true },

  // ★ 경로가 아니라 씬 id를 받는다. 아래 buildLoad 참고
  load: { allow: true, build: buildLoad },

  // 씬을 내린다. 세션(=프로세스)은 살아 있으므로 클라이언트가 불러도 안전하고,
  // 메모리를 364MB → 24MB로 되돌리는 유일한 수단이다.
  clear: { allow: true },

  start: { allow: true },
  pause: { allow: true },
  reset: { allow: true },
  step: { allow: true },
  status: { allow: true },
  getParams: { allow: true },

  // 타입만 거른다. 범위는 엔진의 몫 — 아래 buildSetParams 참고
  setParams: { allow: true, build: buildSetParams },

  // ── 아바타 체형 (L-3a) ────────────────────────────────────
  //
  // 읽기는 무해하다 — 값 54개(체형 29 + 치수 25)를 돌려줄 뿐이고 씬을 안 바꾼다.
  avatarBody: { allow: true },

  // 쓰기. 타입만 거르고 **범위는 엔진에 맡긴다** — setParams 와 같은 판단이다.
  // 정규화 0~1 이라는 것은 실측이지 계약이 아니고, 여기서 클램프하면 엔진이
  // 실제로 어떻게 처리하는지가 우리 코드에 가려진다. 모르는 키는 워커가
  // unknown 으로 되돌려 준다(ISSUE-014 를 되풀이하지 않는 자리다).
  setAvatarBody: { allow: true, build: buildSetAvatarBody },

  // ── 옷 사이즈 (L-3b) ──────────────────────────────────────
  //
  // 읽기는 무해하다 — 서피스 24개의 이름과 크기를 돌려줄 뿐이다.
  surfaces: { allow: true },

  // 쓰기. uuid 는 **워커가 검증한다** — 없는 uuid 면 에러로 되돌린다. 여기서
  // 미리 목록을 들고 있으려면 게이트웨이가 씬 상태를 따라다녀야 하는데,
  // 그건 세션이 이미 하는 일을 두 번 하는 것이고 갈라지면 더 나쁘다.
  setSurfaceSize: { allow: true, build: buildSetSurfaceSize },

  // ── 디자인 기반 2D (D2-a) ─────────────────────────────────
  //
  // 읽기 전용이고 씬을 안 바꾼다. 1건 ~288KB 로 `meshData`(~48KB)보다 크지만
  // **로드당 한 번이면 되는 물건이다** — 커브·봉제선은 드레이프와 무관하게
  // 고정이라 프레임 경로에 없다. 연타를 따로 막지 않는 근거는 `meshData` 와
  // 같다: 워커가 stdin 을 순차 처리하고, 무한정 쌓이는 것은 연결당 동시 요청
  // 상한(maxInflight)이 이미 막는다.
  design2d: { allow: true },

  meshInfo: { allow: true },

  // 1건 ~48KB. 연타를 따로 막지 않는 이유: 실측에서 20건 동시 요청이 27ms에
  // 끝났고(워커가 stdin을 순차 처리한다), 무한정 쌓이는 것은 op별 제한이
  // 아니라 연결당 동시 요청 상한(maxInflight)이 이미 막는다. 프레임을 계속
  // 흘리는 경로는 이쪽이 아니라 subscribe(#8)다.
  meshData: { allow: true, build: buildMeshData },

  // frame 이벤트에 메시를 실으라고 워커에 켜는 스위치. **이벤트 중계의 유일한
  // 스위치가 이것이다** — 게이트웨이 쪽에 두 번째 스위치는 없다(frameEvent 주석).
  // 켜면 프레임당 ~48KB가 붙는다: 실측 40fps × 47.7KB = 세션당 약 1.9MB/s.
  subscribe: { allow: true },
  unsubscribe: { allow: true },

  // ★ **서버 파일 쓰기.** 이 테이블에서 유일하게 디스크를 바꾸는 op이다.
  //
  // #7이 닫아 뒀던 이유는 "여는 방법이 없어서"가 아니라 여는 데 필요한 결정
  // 네 가지가 전부 #10에 있어서였다. 그 답이 이제 붙어 있다:
  //   - 산출물 위치 → 서버가 정한다. `ExportStore.allocate()`가 만든
  //     `<익스포트 디렉토리>/<32자리 hex>.<ext>` 하나뿐이고, 클라이언트가 준
  //     `path`는 **거부**된다(buildExport 첫 줄).
  //   - 다운로드   → `GET /api/exports/:id` (files.ts). 응답의 url이 그 주소다.
  //   - 정리       → 세션당 상한 + TTL 청소 + 실패 즉시 폐기. 근거는 files.ts 머리말.
  //   - 세션당 개수 → `ExportStore.maxPerSession`(기본 4). 넘치면 **이 연결이 만든
  //     것 중** 가장 오래된 것부터 지운다(ctx.ownExports).
  export: { allow: true, build: buildExport },

  // ⛔ 세션 = 워커 프로세스 1개다. 클라이언트가 이걸 부르면 자기 세션을
  //    죽인다. 종료는 소켓을 닫는 것으로 충분하고, 그 경로는 게이트웨이가
  //    반납까지 책임진다(sessions.ts #detach). 여기로 들어올 이유가 없다.
  quit: {
    allow: false,
    reason: 'quit은 클라이언트가 부를 수 없습니다. 세션을 끝내려면 연결을 닫으세요',
  },
};

/** 거부 메시지에 실을 목록. 프론트엔드가 이것만 보고 개발할 수 있게 한다 */
const ALLOWED_OPS: readonly string[] = Object.entries(OPS)
  .filter(([, rule]) => rule.allow)
  .map(([op]) => op);

/** 지원하는 op 목록 (읽기 전용). 진단·문서용 */
export function allowedOps(): readonly string[] {
  return ALLOWED_OPS;
}

// ── 잡동사니 ────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 에러 메시지에 값을 넣을 때. 값 자체를 그대로 넣으면 길이가 통제되지 않는다 */
function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '배열';
  if (typeof v === 'object') return '객체';
  if (typeof v === 'string') return `문자열 "${v.slice(0, 24)}"`;
  return String(v);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 워커가 돌려준 에러 문자열에서 서버 경로를 지운다.
 *
 * mapResult가 성공 결과를 막지만, 에러는 엔진이 만드는 문자열이라 무엇이
 * 들어올지 우리가 정하지 못한다(예외 메시지에 파일 경로가 붙는 건 흔한 일이다).
 * 그래서 마지막에 한 번 훑는다 — 방어를 한 겹 더 두는 쪽이 싸다.
 *
 * **#10에서 익스포트 디렉토리가 두 번째 대상으로 붙었다.** export는 우리가
 * 만든 절대경로를 워커에 **넘기는** op이라, 실패 문구에 그 경로가 실릴 확률이
 * load보다 높다. 씬 경로만 지우면 그물이 반쪽이 된다.
 *
 * 구분자를 `[\\/]+`로 받는 이유: 우리는 `\`로 넘겼는데 예외 메시지가 `/`로
 * 되돌려주거나 이중 이스케이프되는 경우가 있다.
 */
function makeRedactor(dirs: Array<[string | undefined, string]>): (text: string) => string {
  const rules = dirs
    .filter((d): d is [string, string] => typeof d[0] === 'string' && d[0].length > 0)
    .map(([dir, label]) => {
      const body = dir.split(/[\\/]+/).filter(Boolean).map(escapeRe).join('[\\\\/]+');
      return [new RegExp(`${body}[\\\\/]*[^\\s"',)]*`, 'gi'), label] as const;
    });
  if (rules.length === 0) return (t) => t;
  return (t) => rules.reduce((acc, [re, label]) => acc.replace(re, label), t);
}

// ── 브리지 ──────────────────────────────────────────────────

/**
 * `loadedScene`·`ownExports`를 빼는 이유: 그 둘은 **연결이 살아가며 브리지가
 * 쌓는 상태**이지 밖에서 주는 설정이 아니다. 받을 수 있게 두면 "미리 채워
 * 넣으면 되는 값"으로 읽힌다.
 */
export interface BridgeOptions extends Omit<BuildContext, 'loadedScene' | 'ownExports'> {
  /** 워커. null이면 중계를 지원하지 않는 세션(테스트용 가짜 등)이다 */
  target: RelayTarget | null;
  /**
   * 연결 하나가 동시에 띄울 수 있는 요청 수. 기본 32.
   *
   * op별 연타 제한 대신 이 하나를 둔 이유: 워커는 stdin을 순차 처리하므로
   * 실제 병목은 요청 수가 아니라 **응답을 기다리는 동안 쌓이는 메모리**이고,
   * 그건 op 종류와 무관하다. 상한을 넘긴 요청은 큐에 쌓지 않고 즉시 거부한다 —
   * 쌓아두면 클라이언트가 압력을 못 느끼고 계속 보낸다.
   */
  maxInflight?: number;
}

const DEFAULT_MAX_INFLIGHT = 32;

/**
 * 연결 하나의 op 중계.
 *
 * SessionManager가 연결마다 하나씩 만들고, 파싱된 메시지를 dispatch()로 넘긴다.
 * 소켓을 모르므로 응답은 콜백으로 돌려준다 — 그래서 이 클래스는 소켓 없이도
 * 그대로 테스트된다.
 */
export class SessionBridge {
  #target: RelayTarget | null;
  #ctx: BuildContext;
  #max: number;
  #redact: (text: string) => string;

  /** 처리 중인 요청 id. 같은 id가 겹치면 클라이언트가 응답을 상관시킬 수 없다 */
  #inflight = new Set<number>();

  /**
   * **워커에 쓰는 순서**를 클라이언트가 보낸 순서로 고정한다.
   *
   * 이게 없으면 load→start가 뒤집힌다: load는 씬 존재 확인(await)을 지나므로
   * 워커에 닿기까지 한 틱 이상 걸리는데, start는 곧장 간다. 실제로 순서가
   * 뒤집히면 "로드 안 된 씬을 start" → 조용한 실패다.
   *
   * 체인은 **보내는 시점까지만** 붙잡는다. 응답 대기는 체인 밖이라 동시
   * 요청의 이점(20건 27ms)은 그대로다.
   */
  #chain: Promise<void> = Promise.resolve();

  #closed = false;

  constructor(opts: BridgeOptions) {
    this.#target = opts.target;
    // ctx는 이 인스턴스가 소유한다 = 수명이 연결과 같다. loadedScene·ownExports가
    // 여기 사는 이유다 (BuildContext 주석 참고).
    this.#ctx = {
      scenes: opts.scenes,
      sceneId: opts.sceneId,
      exports: opts.exports,
      sessionId: opts.sessionId,
      loadedScene: opts.sceneId,
      ownExports: [],
    };
    this.#max = opts.maxInflight ?? DEFAULT_MAX_INFLIGHT;
    this.#redact = makeRedactor([
      [opts.scenes?.dir, '<씬 저장소>'],
      [opts.exports?.dir, '<익스포트 저장소>'],
    ]);
  }

  /** 응답을 기다리는 요청 수 */
  get inflight(): number {
    return this.#inflight.size;
  }

  /** 연결이 끝났다. 이후 도착하는 워커 응답은 버린다 */
  close(): void {
    this.#closed = true;
    this.#inflight.clear();
  }

  /**
   * 클라이언트 메시지 하나를 처리한다. `reply`는 **정확히 한 번** 불린다.
   *
   * 던지지 않는다 — 이 경로에서 예외가 새면 소켓 핸들러가 죽는다.
   */
  dispatch(msg: unknown, reply: (r: ClientReply) => void): void {
    if (!isRecord(msg) || Array.isArray(msg)) {
      reply({ ok: false, error: '요청은 JSON 객체여야 합니다' });
      return;
    }

    const rawId = msg['id'];
    const op = typeof msg['op'] === 'string' ? msg['op'] : null;

    if (op === null) {
      const id = typeof rawId === 'number' && Number.isFinite(rawId) ? rawId : undefined;
      this.#fail(reply, id, 'op 필드가 없습니다');
      return;
    }

    // id 없는 요청은 받지 않는다. 워커는 id 없이도 처리하지만, 응답을
    // **상관시킬 수 없는** 요청은 클라이언트에게 의미가 없고 — 정확히는,
    // 여러 개를 동시에 보내면 어느 응답이 어느 요청의 것인지 알 수 없다.
    // 실패를 여기서 즉시 내는 편이 낫다.
    if (typeof rawId !== 'number' || !Number.isFinite(rawId)) {
      this.#fail(reply, undefined, `id 필드가 필요합니다 (숫자, op=${op})`);
      return;
    }
    const id = rawId;

    const rule = Object.prototype.hasOwnProperty.call(OPS, op)
      ? OPS[op as Op]
      : undefined;

    if (!rule) {
      // 목록을 알려준다. 프론트엔드 개발이 훨씬 쉬워지고, 노출되는 정보는
      // 어차피 클라이언트 번들에 들어갈 op 이름뿐이다 — 서버 내부에 대해
      // 아무것도 말하지 않는다. 차단된 op(quit/export)은 여기 없다:
      // 그것들은 "모르는 op"이 아니라 "부를 수 없는 op"이라 문구가 다르다.
      this.#fail(reply, id, `알 수 없는 op: ${op} (사용 가능: ${ALLOWED_OPS.join(', ')})`);
      return;
    }

    if (!rule.allow) {
      this.#fail(reply, id, rule.reason ?? `허용되지 않는 op입니다: ${op}`);
      return;
    }

    if (this.#target === null) {
      this.#fail(reply, id, `이 세션은 op 중계를 지원하지 않습니다 (op=${op})`);
      return;
    }

    if (this.#inflight.has(id)) {
      this.#fail(reply, id, `id ${id} 요청이 아직 처리 중입니다. 다른 id를 쓰세요`);
      return;
    }
    if (this.#inflight.size >= this.#max) {
      this.#fail(reply, id, `처리 중인 요청이 너무 많습니다 (상한 ${this.#max}). 응답을 기다린 뒤 보내세요`);
      return;
    }

    this.#inflight.add(id);
    let done = false;
    const settle = (r: ClientReply): void => {
      if (done) return;
      done = true;
      this.#inflight.delete(id);
      if (!this.#closed) reply(r);
    };

    // 보내는 순서만 직렬화한다. **체인이 한 번 거부되면 이후 요청이 전부
    // 조용히 사라지므로**(거부된 Promise의 .then은 실행되지 않는다) 여기서
    // 반드시 삼킨다. #send는 던지지 않도록 쓰여 있지만, 그 보장을 미래의
    // 편집에 맡기지 않는다.
    this.#chain = this.#chain.then(() =>
      this.#send(op as Op, rule, msg, id, settle).catch((err: unknown) => {
        settle({ id, ok: false, error: this.#errorText(err) });
      }),
    );
  }

  /** 검증 → 워커에 쓰기. 응답 대기는 이 함수 밖(체인 밖)이다 */
  async #send(
    op: Op,
    rule: OpRule,
    msg: Record<string, unknown>,
    id: number,
    settle: (r: ClientReply) => void,
  ): Promise<void> {
    if (this.#closed) {
      settle({ id, ok: false, error: '연결이 종료되었습니다' });
      return;
    }

    let prepared: Prepared;
    try {
      prepared = rule.build ? await rule.build(msg, this.#ctx) : {};
    } catch (err: unknown) {
      // RejectError는 우리가 만든 문구다. 그 밖의 예외(저장소 I/O 등)는
      // 내부 사정이므로 원문을 그대로 내보내지 않는다.
      settle({
        id,
        ok: false,
        error: err instanceof RejectError
          ? err.message
          : `${op} 요청을 처리할 수 없습니다`,
      });
      return;
    }

    const target = this.#target;
    if (!target) {
      settle({ id, ok: false, error: `이 세션은 op 중계를 지원하지 않습니다 (op=${op})` });
      return;
    }

    let pending: Promise<unknown>;
    try {
      // ★ 클라이언트 객체가 아니라 build가 조립한 payload만 나간다.
      pending = target.request(op, prepared.payload);
    } catch (err: unknown) {
      settle({ id, ok: false, error: this.#errorText(err) });
      return;
    }

    void pending.then(
      // async인 이유는 #10이다 — export의 mapResult가 산출물을 stat 하고
      // 사이드카를 쓴다. 이 함수는 **던지지 않는다**(전부 try 안이다):
      // 여기서 새면 잡아 줄 프레임이 없어 처리되지 않은 거부가 된다.
      async (result) => {
        let mapped: unknown = result;
        try {
          if (prepared.mapResult) mapped = await prepared.mapResult(result);
        } catch (err: unknown) {
          // build()와 같은 규약이다: RejectError는 우리가 쓴 문구라 그대로,
          // 그 밖의 예외는 내부 사정이라 뭉갠다.
          settle({
            id,
            ok: false,
            error: err instanceof RejectError
              ? err.message
              : `${op} 응답을 해석하지 못했습니다`,
          });
          return;
        }
        settle({ id, ok: true, result: mapped });
      },
      // 워커가 돌려준 실패는 **가공하지 않고 전달한다** (경로만 지운다).
      // 엔진 문구가 곧 진단이고, 게이트웨이가 "시뮬레이션 실패" 따위로
      // 뭉개면 운영에서 원인을 못 찾는다. 워커가 응답 중 죽은 경우도
      // 같은 길로 온다 — Worker가 대기 중인 요청을 전부
      // `워커가 종료됨 (code=…)`으로 거부하므로 매달리지 않는다.
      // (그 직후 sessions.ts가 연결을 4001로 닫으므로, 이 응답이 소켓에
      //  닿는지는 경합이다. 닿지 않아도 클라이언트는 close code로 안다.)
      (err: unknown) => {
        // 부작용 되돌리기 (#10). 던지면 이 거부 핸들러가 통째로 깨져
        // 클라이언트가 응답을 못 받으므로 반드시 삼킨다.
        try {
          prepared.onFailure?.();
        } catch {
          // 정리 실패는 TTL 청소가 받아낸다. 응답을 막을 이유가 없다.
        }
        settle({ id, ok: false, error: this.#errorText(err) });
      },
    );
  }

  // ── 역방향: 워커 이벤트 → 클라이언트 (#8) ─────────────────
  //
  // 여기 두 함수가 하는 일은 **모양을 정하는 것과 내보낼지 정하는 것**뿐이다.
  // 소켓에 쓰는 건 sessions.ts다 — 요청 방향과 같은 분업이다.
  //
  // ⚠️ **게이트웨이에는 이벤트 스위치가 없다.** 켜고 끄는 건 워커 쪽
  // subscribe/unsubscribe 하나뿐이고, 여기는 온 것을 그대로 흘린다.
  // 게이트웨이에도 스위치를 두면 클라이언트가 "구독했는데 왜 안 오지"를
  // 두 곳에서 확인해야 한다 — 상태가 둘이면 반드시 어긋난다.
  // 참고: `subscribed`는 워커 수명 내내 유지되므로(load/clear/reset이 안
  // 건드린다) 세션이 풀로 반납될 때 남을 수 있다. 그 뒤처리는 sessions.ts의
  // #detach가 한다(연결이 끝나면 unsubscribe를 보낸다).
  //
  // 흐름 제어(느린 클라이언트에서 프레임을 버리는 latest-wins)는 **#9**이고
  // **이 파일에 없다** — sessions.ts의 #emit()이다. 이 방향만 정책이 전송 쪽에
  // 있는 이유는 판단 근거가 `ws.bufferedAmount` 하나뿐이어서다. 여기로 옮기면
  // 브리지가 소켓을 알아야 하고, 그 순간 이 클래스를 소켓 없이 테스트하는
  // 경로가 사라진다. 그래서 여기 두 함수는 여전히 **모양만** 정한다 —
  // 무엇이 버려졌는지도 모른다(카운터는 SessionManager.connections에 있다).

  /**
   * 워커의 frame 이벤트 → 클라이언트 이벤트. null이면 내보내지 않는다.
   *
   * mesh는 **구독 중일 때만** 실린다. undefined일 때 키를 아예 안 넣는 이유는
   * 워커가 보내는 모양과 정확히 같게 하기 위해서다 — `"mesh":null`이 섞이면
   * 클라이언트가 두 가지 "없음"을 다루게 된다.
   */
  frameEvent(frame: number, mesh?: MeshDataResult): ClientEvent | null {
    // 연결이 끝난 뒤 도착한 이벤트. 리스너는 #detach가 떼지만, 떼기 직전에
    // 큐에 들어온 것이 있을 수 있다.
    if (this.#closed) return null;
    return mesh === undefined ? { event: 'frame', frame } : { event: 'frame', frame, mesh };
  }

  /**
   * 워커의 engineMessage → 클라이언트 이벤트.
   *
   * **redact를 지나는 이유**: 이건 엔진이 만드는 사람이 읽는 문자열이라
   * 무엇이 들어올지 우리가 정하지 못한다 — 에러 응답과 정확히 같은 사정이다
   * (makeRedactor 주석). 실측된 문구는 `"0.4 sec, avatar animation (10/300)"`
   * 처럼 무해하지만, 파일을 못 열었다는 메시지가 이 채널로 나오면 서버
   * 절대경로가 그대로 실린다. 그물을 응답에만 치고 이벤트에 안 치면
   * #5·#7이 세운 "경로는 밖으로 안 나간다"가 여기서 새어 나간다.
   */
  engineMessageEvent(message: string): ClientEvent | null {
    if (this.#closed) return null;
    return { event: 'engineMessage', message: this.#redact(message) };
  }

  #errorText(err: unknown): string {
    return this.#redact(err instanceof Error ? err.message : String(err));
  }

  #fail(reply: (r: ClientReply) => void, id: number | undefined, error: string): void {
    reply(id === undefined ? { ok: false, error } : { id, ok: false, error });
  }
}
