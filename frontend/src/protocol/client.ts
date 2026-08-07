/**
 * 게이트웨이 WebSocket 클라이언트.
 *
 * 프론트에서 **자동 테스트가 붙는 유일한 층**이다(#11). 그래서 이 파일은
 * 브라우저 API 를 세 개(`WebSocket`, `JSON`, `setTimeout`)만 쓰고 DOM 을 전혀
 * 만지지 않는다 — Node 22+ 에는 `WebSocket` 이 전역으로 있으므로 스모크가
 * 게이트웨이를 실제로 띄워 그대로 돌릴 수 있다.
 *
 * ── 이 클래스가 책임지는 것 네 가지 ──────────────────────────
 * ① **연결 = 준비 완료.** 게이트웨이는 세션(워커 프로세스)을 업그레이드 **전에**
 *    확보한다. 소켓이 열렸다는 것은 워커가 이미 살아 있다는 뜻이다. 그래서
 *    "연결됐지만 아직 세션이 없음" 이라는 상태가 존재하지 않는다.
 * ② **응답/이벤트 판별은 `'event' in msg` 하나뿐.** id 유무로 나누면 틀린다
 *    (types.ts 의 `isServerEvent` 주석).
 * ③ **id 상관.** 요청마다 단조 증가 id 를 붙이고 응답을 되찾아 준다. 서버는
 *    같은 id 가 처리 중이면 거부하므로 id 를 재사용하지 않는 것이 계약이다.
 * ④ **끊김의 처리.** 대기 중이던 요청을 전부 거부하고, 정책이 있으면 백오프로
 *    다시 붙는다.
 *
 * ── ⚠️ 재연결은 "복구" 가 아니다 ────────────────────────────
 * 재연결하면 **새 워커 프로세스**가 붙는다. 씬은 로드돼 있지 않고, 시뮬 상태도
 * 파라미터도 구독도 전부 초기값이며, 라이선스 인스턴스를 하나 더 쓴다. 그래서
 * 기본값이 **꺼짐**이다 — 조용히 다시 붙으면 앱은 "잠깐 끊겼다 돌아왔다" 고
 * 믿지만 실제로는 빈 세션이다. 켜려면 `reconnect: true` 를 명시하고,
 * `open` 이벤트의 `reconnected` 를 보고 **씬을 다시 로드해야 한다.**
 *
 * ── ⚠️ 거절은 close 1006 으로만 보인다 ─────────────────────
 * 만석(503)·워커 실패(502)·없는 씬(404)은 전부 업그레이드 전 HTTP 응답이라
 * 브라우저가 본문을 못 읽는다. 구분하려면 `diagnose()` 로 `/api/health` 를
 * 되물어야 한다.
 */

import { Emitter, type Unsubscribe } from './emitter.ts';
import { fetchHealth } from './http.ts';
import {
  isServerEvent,
  type ClientOp,
  type FrameMesh,
  type LoadResult,
  type MeshInfoResult,
  type ServerEvent,
  type ServerMessage,
  type SetParamsResult,
  type SimulationParams,
  type StatusResult,
  type SubscribeResult,
  type VersionResult,
} from './types.ts';
import { resolveEndpoints, withScene } from './url.ts';

// ── 오류 ────────────────────────────────────────────────────

/** 서버가 `{ ok:false, error }` 로 답했다. message 는 게이트웨이/엔진의 원문이다 */
export class GatewayError extends Error {
  readonly op: ClientOp | undefined;
  readonly requestId: number | undefined;

  constructor(message: string, op?: ClientOp, requestId?: number) {
    super(message);
    this.name = 'GatewayError';
    this.op = op;
    this.requestId = requestId;
  }
}

/** 응답이 제한 시간 안에 오지 않았다. 요청은 워커에 이미 닿았을 수 있다 */
export class GatewayTimeoutError extends GatewayError {
  constructor(op: ClientOp, requestId: number, timeoutMs: number) {
    super(`${op} 응답이 ${timeoutMs}ms 안에 오지 않았습니다 (id=${requestId})`, op, requestId);
    this.name = 'GatewayTimeoutError';
  }
}

/** 연결이 없거나, 대기 중에 끊겼다 */
export class GatewayClosedError extends GatewayError {
  readonly code: number | undefined;

  constructor(message: string, op?: ClientOp, requestId?: number, code?: number) {
    super(message, op, requestId);
    this.name = 'GatewayClosedError';
    this.code = code;
  }
}

// ── 상태와 이벤트 ───────────────────────────────────────────

export type ClientState =
  /** connect() 전 */
  | 'idle'
  /** 소켓을 여는 중 */
  | 'connecting'
  /** 열렸다 = 워커 세션이 살아 있다 */
  | 'open'
  /** 끊겼고, 백오프를 기다리는 중 */
  | 'reconnecting'
  /** 끝났다. connect() 를 다시 부르지 않는 한 아무 일도 없다 */
  | 'closed';

// interface 가 아니라 type 인 이유: interface 는 암묵적 인덱스 시그니처를 얻지
// 못해서 `Emitter<M extends Record<string, unknown>>` 의 제약을 만족하지 않는다.
export type GatewayEvents = {
  state: { state: ClientState; previous: ClientState };
  /**
   * `reconnected: true` 면 **새 워커 세션**이다 — 씬을 다시 로드해야 한다.
   * `attempt` 는 이번 연결에 든 재시도 횟수(첫 연결은 0).
   */
  open: { reconnected: boolean; attempt: number };
  close: {
    code: number;
    reason: string;
    willReconnect: boolean;
    /** 재연결까지 남은 시간. willReconnect 가 false 면 null */
    retryInMs: number | null;
  };
  /** ⚠️ `mesh` 는 구독 중이 아니면 **키 자체가 없다** (null 이 아니다) */
  frame: { frame: number; mesh?: FrameMesh };
  engineMessage: { message: string };
  /**
   * 상관시킬 수 없는 서버 메시지. 요청 하나의 실패가 아니라 **프로토콜의 문제**다.
   * 셋 중 하나다: JSON 이 아님 / id 없는 실패 응답 / 모르는(이미 타임아웃된) id.
   */
  protocolError: { error: Error; raw: string };
  /** 소켓 오류, 리스너가 던진 예외 등. 연결이 끊길지는 close 가 알려준다 */
  error: { error: Error };
};

/** 지수 백오프. 켜기만 하려면 `reconnect: true` */
export interface ReconnectPolicy {
  /** 첫 재시도까지. 기본 500ms */
  minDelayMs?: number;
  /** 상한. 기본 10초 */
  maxDelayMs?: number;
  /** 배수. 기본 2 */
  factor?: number;
  /** 지터 비율 0~1. 기본 0.3 — 여러 탭이 동시에 재접속해 만석을 만드는 걸 막는다 */
  jitter?: number;
  /** 최대 시도 횟수. 기본 무제한 */
  maxAttempts?: number;
}

const DEFAULT_POLICY: Required<ReconnectPolicy> = {
  minDelayMs: 500,
  maxDelayMs: 10_000,
  factor: 2,
  jitter: 0.3,
  maxAttempts: Number.POSITIVE_INFINITY,
};

export type WebSocketCtor = new (url: string) => WebSocket;

export interface GatewayClientOptions {
  /**
   * 게이트웨이 주소. **브라우저에서는 생략한다** — 같은 오리진이 전제다.
   * Node 스모크는 `gateway.url` 을 그대로 넘기면 된다.
   */
  url?: string | undefined;
  /** WS 경로. 게이트웨이 기본값과 같다 */
  wsPath?: string;
  /**
   * 연결 시 `?scene=`. **기본값이지 구속이 아니다** — 같은 세션에서 다른 씬도
   * 열 수 있다. 틀린 id 는 close 1006 으로만 보이므로 주의 (url.ts 참고).
   */
  scene?: string | null | undefined;
  /**
   * 응답 하나의 제한 시간. 기본 60초.
   *
   * 실측 기준: 워커 기동 ~110ms, 103MB 씬 로드 ~830ms, meshData 1건 ~27ms.
   * 60초는 그 전부에 두 자릿수 배의 여유다 — 여기 걸린다면 값이 짧아서가 아니라
   * 워커가 굳은 것이다.
   */
  requestTimeoutMs?: number;
  /** 기본 **꺼짐**. 켜면 새 워커 세션이 붙는다 — 클래스 머리말 참고 */
  reconnect?: boolean | ReconnectPolicy;
  /** 진단 로그 */
  onLog?: ((line: string) => void) | undefined;
  /** 테스트에서 소켓을 갈아끼울 때. 기본 전역 WebSocket */
  webSocket?: WebSocketCtor | undefined;
}

interface Pending {
  op: ClientOp;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve: (v) => {
      if (d.settled) return;
      d.settled = true;
      resolve(v);
    },
    reject: (e) => {
      if (d.settled) return;
      d.settled = true;
      reject(e);
    },
  };
  return d;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── 클라이언트 ──────────────────────────────────────────────

export class GatewayClient {
  readonly #httpBase: string;
  readonly #wsUrl: string;
  readonly #timeoutMs: number;
  readonly #policy: Required<ReconnectPolicy> | null;
  readonly #ctor: WebSocketCtor;
  readonly #log: (line: string) => void;

  readonly #events = new Emitter<GatewayEvents>((err) => {
    this.#events.emit('error', {
      error: err instanceof Error ? err : new Error(String(err)),
    });
  });

  #ws: WebSocket | null = null;
  #state: ClientState = 'idle';

  /** 단조 증가. **재사용하지 않는다** — 서버가 처리 중인 id 를 거부한다 */
  #nextId = 1;
  #pending = new Map<number, Pending>();

  /** connect() 가 돌려준 약속. 첫 open 에 풀린다 */
  #connectWaiter: Deferred<void> | null = null;
  #closeWaiter: Deferred<void> | null = null;

  #manualClose = false;
  #attempt = 0;
  #opens = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: GatewayClientOptions = {}) {
    const { httpBase, wsBase } = resolveEndpoints(opts.url, opts.wsPath ?? '/ws');
    this.#httpBase = httpBase;
    this.#wsUrl = withScene(wsBase, opts.scene);
    this.#timeoutMs = opts.requestTimeoutMs ?? 60_000;

    this.#policy = opts.reconnect
      ? { ...DEFAULT_POLICY, ...(opts.reconnect === true ? {} : opts.reconnect) }
      : null;

    const ctor = opts.webSocket ?? (globalThis.WebSocket as WebSocketCtor | undefined);
    if (!ctor) {
      throw new Error(
        'WebSocket 이 없습니다. Node 22+ 이거나 options.webSocket 을 넘겨야 합니다',
      );
    }
    this.#ctor = ctor;
    this.#log = opts.onLog ?? ((): void => {});
  }

  // ── 관찰 ──────────────────────────────────────────────────

  get state(): ClientState {
    return this.#state;
  }

  get connected(): boolean {
    return this.#state === 'open';
  }

  /** 응답을 기다리는 요청 수 */
  get pending(): number {
    return this.#pending.size;
  }

  /** 다음에 발급될 요청 id. 진단용 */
  get nextRequestId(): number {
    return this.#nextId;
  }

  get wsUrl(): string {
    return this.#wsUrl;
  }

  get httpBase(): string {
    return this.#httpBase;
  }

  /** 지금까지 성공한 연결 수. 1 보다 크면 재연결을 거쳤다는 뜻이다 */
  get openCount(): number {
    return this.#opens;
  }

  on<K extends keyof GatewayEvents>(
    type: K,
    fn: (payload: GatewayEvents[K]) => void,
  ): Unsubscribe {
    return this.#events.on(type, fn);
  }

  once<K extends keyof GatewayEvents>(
    type: K,
    fn: (payload: GatewayEvents[K]) => void,
  ): Unsubscribe {
    return this.#events.once(type, fn);
  }

  off<K extends keyof GatewayEvents>(
    type: K,
    fn: (payload: GatewayEvents[K]) => void,
  ): void {
    this.#events.off(type, fn);
  }

  // ── 연결 수명 ─────────────────────────────────────────────

  /**
   * 연결한다. 열릴 때까지 기다린다.
   *
   * 여러 번 불러도 안전하다 — 이미 열려 있으면 즉시, 여는 중이면 같은 약속을
   * 돌려준다. 재연결 정책이 있으면 **정책이 소진될 때까지** 거부하지 않는다.
   */
  connect(): Promise<void> {
    if (this.#state === 'open') return Promise.resolve();
    if (this.#connectWaiter) return this.#connectWaiter.promise;

    this.#manualClose = false;
    this.#attempt = 0;
    const waiter = deferred<void>();
    this.#connectWaiter = waiter;
    this.#openSocket();
    return waiter.promise;
  }

  /**
   * 연결을 닫는다. **재연결하지 않는다.**
   *
   * 소켓이 닫히면 게이트웨이가 세션을 반납하고 워커 프로세스를 정리한다
   * (sessions.ts #detach). 즉 이게 세션을 끝내는 정식 방법이다 — `quit` op 은
   * 애초에 막혀 있다.
   */
  async close(code = 1000, reason = ''): Promise<void> {
    this.#manualClose = true;
    this.#clearRetry();

    const ws = this.#ws;
    if (!ws) {
      this.#setState('closed');
      this.#connectWaiter?.reject(new GatewayClosedError('연결을 닫았습니다'));
      this.#connectWaiter = null;
      return;
    }

    if (!this.#closeWaiter) this.#closeWaiter = deferred<void>();
    const waiter = this.#closeWaiter;
    try {
      ws.close(code, reason);
    } catch {
      // 이미 닫히는 중이다. close 이벤트가 어차피 온다.
    }
    return waiter.promise;
  }

  /**
   * 연결이 거절됐을 때 **왜**인지 되묻는다.
   *
   * 브라우저는 핸드셰이크 거절을 close 1006 으로만 보여 준다. 게이트웨이가
   * 살아 있는데 1006 이면 거절(만석 503 / 워커 실패 502 / 없는 씬 404)이고,
   * 죽어 있으면 그냥 서버가 없는 것이다.
   */
  async diagnose(): Promise<'gateway-down' | 'refused' | 'unknown'> {
    const health = await fetchHealth({ base: this.#httpBase });
    if (!health) return 'gateway-down';
    return this.#opens === 0 ? 'refused' : 'unknown';
  }

  // ── 요청 ──────────────────────────────────────────────────

  /**
   * op 하나를 보내고 응답을 기다린다.
   *
   * `payload` 는 **평평하게** 합쳐진다 — 워커 프로토콜이 `{id, op, ...}` 한 겹
   * 이기 때문이다 (`{id:1, op:'load', scene:'…'}`). `id` 와 `op` 는 덮어쓸 수 없다.
   *
   * 실패는 `GatewayError` 로 던진다. message 는 게이트웨이나 엔진의 원문이라
   * 그대로 사용자에게 보여도 된다 — 서버 경로는 게이트웨이가 이미 지운다.
   */
  request<T = unknown>(
    op: ClientOp,
    payload?: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const ws = this.#ws;
    if (!ws || this.#state !== 'open') {
      return Promise.reject(
        new GatewayClosedError(`연결되어 있지 않습니다 (state=${this.#state}, op=${op})`, op),
      );
    }

    const id = this.#nextId++;
    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 대기 목록에서 지운다. 뒤늦게 응답이 와도 상관시킬 짝이 없으므로
        // protocolError 로 나간다 — 조용히 삼키는 것보다 낫다.
        this.#pending.delete(id);
        reject(new GatewayTimeoutError(op, id, timeoutMs));
      }, timeoutMs);
      // 타이머가 Node 스모크의 이벤트 루프를 붙잡지 않게 한다 (브라우저엔 없다).
      (timer as unknown as { unref?: () => void }).unref?.();

      this.#pending.set(id, {
        op,
        timer,
        resolve: resolve as (v: unknown) => void,
        reject,
      });

      const msg: Record<string, unknown> = { ...(payload ?? {}), id, op };
      try {
        ws.send(JSON.stringify(msg));
      } catch (err: unknown) {
        this.#settle(id, null, err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ── op 래퍼 ───────────────────────────────────────────────
  //
  // 전부 request() 한 줄이다. 있는 이유는 **결과 타입**과 **op 이름의 오타를
  // 컴파일 시점에 잡는 것** 둘뿐이다. 여기 없는 op 은 request() 로 직접 부른다.

  ping(): Promise<unknown> {
    return this.request('ping');
  }

  version(): Promise<VersionResult> {
    return this.request<VersionResult>('version');
  }

  init(): Promise<unknown> {
    return this.request('init');
  }

  /** ⚠️ 경로가 아니라 **씬 id** 다 (`POST /api/scenes` 가 돌려준 것) */
  load(scene?: string): Promise<LoadResult> {
    return this.request<LoadResult>('load', scene === undefined ? undefined : { scene });
  }

  /** 씬을 내린다. 세션(프로세스)은 살아 있다. 메모리 364MB → 24MB */
  clear(): Promise<unknown> {
    return this.request('clear');
  }

  start(): Promise<unknown> {
    return this.request('start');
  }

  pause(): Promise<unknown> {
    return this.request('pause');
  }

  reset(): Promise<unknown> {
    return this.request('reset');
  }

  step(): Promise<unknown> {
    return this.request('step');
  }

  status(): Promise<StatusResult> {
    return this.request<StatusResult>('status');
  }

  getParams(): Promise<SimulationParams> {
    return this.request<SimulationParams>('getParams');
  }

  /** 모르는 키는 막지 않는다 — 서버가 `unknown[]` 으로 되돌려준다 */
  setParams(params: Partial<SimulationParams> & Record<string, number | boolean>): Promise<SetParamsResult> {
    return this.request<SetParamsResult>('setParams', { params });
  }

  meshInfo(): Promise<MeshInfoResult> {
    return this.request<MeshInfoResult>('meshInfo');
  }

  /** `topology:true` 면 indices·uvs 까지. 프레임 간 고정이라 보통 한 번만 부른다 */
  meshData(topology = false): Promise<FrameMesh> {
    return this.request<FrameMesh>('meshData', { topology });
  }

  /**
   * frame 이벤트에 메시를 실으라고 **워커에** 켠다.
   * 실측 프레임당 ~47.8KB × 40/s = 세션당 약 1.82MB/s.
   */
  subscribe(): Promise<SubscribeResult> {
    return this.request<SubscribeResult>('subscribe');
  }

  unsubscribe(): Promise<SubscribeResult> {
    return this.request<SubscribeResult>('unsubscribe');
  }

  /**
   * 목표 프레임까지 기다린다. 연결이 끊기거나 시간이 다하면 거부한다.
   *
   * 시뮬 진행을 기다리는 유일한 수단이다 — `start` 는 즉시 응답하고 프레임은
   * 이벤트로만 온다.
   */
  waitForFrame(target: number, timeoutMs = 300_000): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const cleanup = (): void => {
        offFrame();
        offClose();
        clearTimeout(timer);
      };
      const offFrame = this.on('frame', (ev) => {
        if (ev.frame >= target) {
          cleanup();
          resolve(ev.frame);
        }
      });
      const offClose = this.on('close', (ev) => {
        cleanup();
        reject(new GatewayClosedError(`프레임 대기 중 연결이 끊겼습니다 (code=${ev.code})`, undefined, undefined, ev.code));
      });
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`프레임 ${target} 도달 실패 (${timeoutMs}ms)`));
      }, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
  }

  // ── 내부: 소켓 ────────────────────────────────────────────

  #openSocket(): void {
    this.#setState('connecting');

    let ws: WebSocket;
    try {
      ws = new this.#ctor(this.#wsUrl);
    } catch (err: unknown) {
      // 주소가 잘못된 경우 등. close 이벤트가 오지 않으므로 여기서 끝낸다.
      const error = err instanceof Error ? err : new Error(String(err));
      this.#events.emit('error', { error });
      this.#onClosed(1006, error.message);
      return;
    }
    this.#ws = ws;

    ws.addEventListener('open', () => {
      if (this.#ws !== ws) return;
      const attempt = this.#attempt;
      const reconnected = this.#opens > 0;
      this.#opens += 1;
      this.#attempt = 0;
      this.#setState('open');
      this.#log(`연결됨 ${this.#wsUrl}${reconnected ? ` (재연결 ${attempt}회 만에)` : ''}`);
      this.#events.emit('open', { reconnected, attempt });
      const waiter = this.#connectWaiter;
      this.#connectWaiter = null;
      waiter?.resolve();
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      if (this.#ws !== ws) return;
      this.#onText(typeof ev.data === 'string' ? ev.data : String(ev.data));
    });

    ws.addEventListener('error', () => {
      if (this.#ws !== ws) return;
      // 브라우저는 보안상 이유를 알려주지 않는다. 원인은 close 코드와
      // diagnose() 로 좁혀야 한다.
      this.#events.emit('error', {
        error: new Error('WebSocket 오류 (원인은 close 코드와 diagnose() 로 확인)'),
      });
    });

    ws.addEventListener('close', (ev: CloseEvent) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#onClosed(ev.code, ev.reason);
    });
  }

  #onClosed(code: number, reason: string): void {
    // ① 대기 중이던 요청은 전부 실패다. 보낼 곳도, 받을 곳도 없다.
    //    남겨두면 호출자의 await 가 영원히 풀리지 않는다.
    const closedErr = (op: ClientOp, id: number): GatewayClosedError =>
      new GatewayClosedError(
        `연결이 끊겨 ${op} 응답을 받지 못했습니다 (code=${code}${reason ? `, ${reason}` : ''})`,
        op,
        id,
        code,
      );
    for (const [id, p] of [...this.#pending]) {
      this.#pending.delete(id);
      clearTimeout(p.timer);
      p.reject(closedErr(p.op, id));
    }

    // ② 재연결 여부
    const policy = this.#policy;
    const willReconnect = !this.#manualClose
      && policy !== null
      && this.#attempt < policy.maxAttempts;

    const retryInMs = willReconnect && policy ? this.#backoff(policy, this.#attempt) : null;

    this.#setState(willReconnect ? 'reconnecting' : 'closed');
    this.#log(`연결 종료 code=${code}${reason ? ` (${reason})` : ''}${willReconnect ? ` — ${retryInMs}ms 뒤 재시도` : ''}`);
    this.#events.emit('close', { code, reason, willReconnect, retryInMs });

    // ③ close() 를 기다리던 쪽
    const closeWaiter = this.#closeWaiter;
    this.#closeWaiter = null;
    closeWaiter?.resolve();

    if (willReconnect && retryInMs !== null) {
      this.#attempt += 1;
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = null;
        if (this.#manualClose) return;
        this.#openSocket();
      }, retryInMs);
      (this.#retryTimer as unknown as { unref?: () => void }).unref?.();
      return;
    }

    // 재연결하지 않는다 → connect() 를 기다리던 쪽에게 실패를 알린다.
    const waiter = this.#connectWaiter;
    this.#connectWaiter = null;
    waiter?.reject(
      new GatewayClosedError(
        `연결하지 못했습니다 (code=${code}${reason ? `, ${reason}` : ''}). `
        + '1006 이면 게이트웨이가 업그레이드 전에 거절했을 수 있습니다 — diagnose() 를 보세요',
        undefined,
        undefined,
        code,
      ),
    );
  }

  #backoff(policy: Required<ReconnectPolicy>, attempt: number): number {
    const base = Math.min(
      policy.maxDelayMs,
      policy.minDelayMs * Math.pow(policy.factor, attempt),
    );
    // 지터는 **줄이는 방향으로만** 넣는다. 상한을 넘기지 않기 위해서다.
    const jitter = base * policy.jitter * Math.random();
    return Math.max(0, Math.round(base - jitter));
  }

  #clearRetry(): void {
    if (this.#retryTimer === null) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #setState(next: ClientState): void {
    if (this.#state === next) return;
    const previous = this.#state;
    this.#state = next;
    this.#events.emit('state', { state: next, previous });
  }

  // ── 내부: 수신 ────────────────────────────────────────────

  #onText(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err: unknown) {
      this.#protocolError(`서버 메시지가 JSON 이 아닙니다: ${err instanceof Error ? err.message : String(err)}`, text);
      return;
    }
    if (!isRecord(parsed)) {
      this.#protocolError('서버 메시지가 JSON 객체가 아닙니다', text);
      return;
    }

    const msg = parsed as unknown as ServerMessage;

    // ★ 판별은 이것 하나. id 유무로 나누면 틀린다.
    if (isServerEvent(msg)) {
      this.#onEvent(msg, text);
      return;
    }

    // 응답. id 가 없는 실패 응답이 존재한다 (JSON 파싱 실패 / op 누락 /
    // 바이너리 거부). 상관시킬 짝이 없으므로 protocolError 로 올린다.
    const id = (parsed as { id?: unknown }).id;
    if (typeof id !== 'number') {
      const error = typeof (parsed as { error?: unknown }).error === 'string'
        ? String((parsed as { error: string }).error)
        : '서버가 id 없는 응답을 보냈습니다';
      this.#protocolError(error, text);
      return;
    }

    const ok = (parsed as { ok?: unknown }).ok;
    if (typeof ok !== 'boolean') {
      this.#protocolError(`응답에 ok 필드가 없습니다 (id=${id})`, text);
      return;
    }

    if (ok) {
      this.#settle(id, (parsed as { result?: unknown }).result ?? null, null, text);
      return;
    }
    const error = typeof (parsed as { error?: unknown }).error === 'string'
      ? (parsed as { error: string }).error
      : '알 수 없는 오류';
    this.#settle(id, null, new GatewayError(error, undefined, id), text);
  }

  #onEvent(ev: ServerEvent, raw: string): void {
    switch (ev.event) {
      case 'frame':
        // mesh 키가 없을 때 `mesh: undefined` 를 넣지 않는다 — 서버가 보내는
        // 모양과 정확히 같게 유지한다 (`'mesh' in payload` 가 그대로 성립).
        this.#events.emit(
          'frame',
          ev.mesh === undefined ? { frame: ev.frame } : { frame: ev.frame, mesh: ev.mesh },
        );
        return;
      case 'engineMessage':
        this.#events.emit('engineMessage', { message: ev.message });
        return;
      default:
        this.#protocolError(
          `알 수 없는 이벤트: ${String((ev as { event: unknown }).event)}`,
          raw,
        );
    }
  }

  /** 대기 중인 요청 하나를 끝낸다. 짝이 없으면 protocolError */
  #settle(id: number, result: unknown, error: Error | null, raw = ''): void {
    const p = this.#pending.get(id);
    if (!p) {
      this.#protocolError(
        `상관시킬 수 없는 응답입니다 (id=${id}). 이미 타임아웃됐거나 서버가 보낸 적 없는 id 입니다`,
        raw,
      );
      return;
    }
    this.#pending.delete(id);
    clearTimeout(p.timer);
    if (error) {
      // op 을 붙여 준다 — 서버 응답에는 없다.
      p.reject(error instanceof GatewayError ? new GatewayError(error.message, p.op, id) : error);
      return;
    }
    p.resolve(result);
  }

  #protocolError(message: string, raw: string): void {
    this.#events.emit('protocolError', {
      error: new Error(message),
      raw: raw.length > 500 ? `${raw.slice(0, 500)}…` : raw,
    });
  }
}
