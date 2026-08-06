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
import type { SceneStore } from './files.ts';

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
   */
  mapResult?: (result: unknown) => unknown;
}

export interface BuildContext {
  /** 씬 id → 경로 변환의 유일한 소유자 (#5의 결정). 없으면 load를 받지 않는다 */
  scenes?: SceneStore | undefined;
  /** 연결 시 `?scene=`으로 지정된 씬. load의 **기본값**이다 (아래 buildLoad 주석) */
  sceneId: string | null;
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
    mapResult: (r) => ({
      loaded: isRecord(r) ? r['loaded'] === true : true,
      scene,
    }),
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

  // ⛔ **서버 파일 쓰기.** load보다 위험하다 — 임의 위치에 파일을 만든다.
  //
  // 지금 여는 방법이 없어서가 아니라, 여는 데 필요한 결정이 전부 #10에
  // 있어서 닫아 둔다: 산출물을 어디에 두는가, 어떻게 내려받는가, 언제
  // 지우는가, 세션당 몇 개까지인가. 그 답 없이 "서버가 경로를 정하고
  // 형식만 받는다"로 열면, 아무도 지우지 않고 아무도 못 받는 파일이
  // 디스크에 쌓인다 — 기능은 0이고 디스크 고갈 경로만 생긴다.
  // #10은 이 줄을 build 있는 줄로 바꾸기만 하면 된다.
  export: {
    allow: false,
    reason: 'export는 아직 열려 있지 않습니다 (#10에서 다운로드와 함께 열립니다)',
  },

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
 * 구분자를 `[\\/]+`로 받는 이유: 우리는 `\`로 넘겼는데 예외 메시지가 `/`로
 * 되돌려주거나 이중 이스케이프되는 경우가 있다.
 */
function makeRedactor(dir: string | undefined): (text: string) => string {
  if (!dir) return (t) => t;
  const body = dir.split(/[\\/]+/).filter(Boolean).map(escapeRe).join('[\\\\/]+');
  const re = new RegExp(`${body}[\\\\/]*[^\\s"',)]*`, 'gi');
  return (t) => t.replace(re, '<씬 저장소>');
}

// ── 브리지 ──────────────────────────────────────────────────

export interface BridgeOptions extends BuildContext {
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
    this.#ctx = { scenes: opts.scenes, sceneId: opts.sceneId };
    this.#max = opts.maxInflight ?? DEFAULT_MAX_INFLIGHT;
    this.#redact = makeRedactor(opts.scenes?.dir);
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
      (result) => {
        let mapped: unknown = result;
        try {
          if (prepared.mapResult) mapped = prepared.mapResult(result);
        } catch {
          settle({ id, ok: false, error: `${op} 응답을 해석하지 못했습니다` });
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
      (err: unknown) => settle({ id, ok: false, error: this.#errorText(err) }),
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
  // 흐름 제어(느린 클라이언트에서 프레임을 버리는 latest-wins)는 **#9**다.
  // 지금은 아무 제한 없이 흘린다 — 그래야 #9에서 "안 오는 것"과 "버려진 것"이
  // 구분된다.

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
