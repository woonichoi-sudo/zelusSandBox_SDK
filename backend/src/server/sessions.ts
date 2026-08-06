/**
 * WebSocket 연결 하나 = 세션 하나 = 워커 프로세스 하나.
 *
 * 이 등식은 취향이 아니라 엔진이 강제한 것이다. ZestManager의 콜백이 전부
 * static이라 한 프로세스에 두 세션을 담을 수 없다(CLAUDE.md). 그래서 여기서
 * 할 일은 "연결의 수명"과 "프로세스의 수명"을 **정확히** 포개는 것뿐이다.
 *
 * op 중계(#7)가 그 위에 얹혀 있지만 **정책은 bridge.ts에 있다.** 이 파일이
 * 하는 건 전송뿐이다 — 프레임을 텍스트로 만들고, JSON으로 파싱하고, 결과를
 * 소켓에 쓴다. 무엇을 통과시킬지는 한 줄도 여기 없다.
 *
 * 반대 방향(워커 → 클라이언트, #8)도 같은 분업이다: 리스너를 달고 떼는
 * **수명**은 여기, 이벤트의 모양과 내보낼지 여부는 bridge.ts다. 이 방향에서
 * 이 파일이 지키는 것은 하나뿐이고 그게 전부다 —
 * **리스너는 연결보다 오래 살지 않는다.** 세션은 풀로 반납돼 다음 연결에
 * 재사용될 수 있으므로(idleTimeout > 0), 리스너가 남으면 이전 클라이언트의
 * 소켓으로 남의 프레임이 간다. 그래서 #detach가 반드시 뗀다.
 *
 * 흐름 제어는 아직 없다. 구독 중이면 세션당 약 1.9MB/s(실측 40fps × 47.7KB)가
 * 아무 제한 없이 소켓으로 나간다 — 느린 클라이언트에서 프레임을 버리는
 * latest-wins는 **#9**다. #emit()이 그 자리다.
 *
 * 그 등식을 지키기 위해 정한 것들:
 *
 * ① **세션은 업그레이드 전에 확보한다.** acquire()가 ~110ms 걸리는데, 그
 *    동안 클라이언트는 여전히 "핸드셰이크 중"이다. 확보에 실패하면 핸드셰이크
 *    자체를 HTTP 상태코드로 끝낸다(503/502/404/400). 얻는 것:
 *      - **열린 소켓에는 항상 살아 있는 세션이 있다.** #7·#8이 "세션이 아직
 *        없는 연결"이라는 상태를 다룰 필요가 없다.
 *      - 거절이 REST와 같은 `{ error }` JSON이라 클라이언트 파서가 하나다.
 *      - 이미 버릴 연결에 워커를 붙였다 떼는 낭비가 없다.
 *    대가: 브라우저 WebSocket API는 핸드셰이크 실패의 본문·상태코드를 노출하지
 *    않는다(무조건 1006). Node의 `ws`는 'unexpected-response'로 받아볼 수 있다.
 *    그래도 이쪽을 고른 건, "연결됨 = 준비됨"이라는 불변식이 프론트엔드 상태
 *    기계에서 상태 하나를 통째로 지우기 때문이다.
 *
 * ② **acquire() 중에 클라이언트가 사라지는 110ms 창을 반드시 처리한다.**
 *    그 창에서 끊기면 주인 없는 워커가 남는다 — 라이선스 인스턴스를 물고 있는
 *    좀비다. 소켓의 close/error를 미리 걸어두고, acquire가 끝난 직후 확인해
 *    즉시 반납한다.
 *
 * ③ **연결 하나의 수명 전체가 하나의 Promise다.** acquire부터 release까지를
 *    #inflight에 담아 두고 shutdown()이 전부 기다린다. 이게 없으면 게이트웨이가
 *    닫힌 뒤에도 exe가 살아남아 스모크의 워치독이 발화한다.
 *
 * 서버 → 클라이언트 close code:
 *   1001  게이트웨이 종료 (표준 going away)
 *   4001  세션 소실 — 워커 프로세스가 스스로 죽었다. 재연결하면 새 세션이 붙는다
 *
 * 핸드셰이크 거절 (HTTP 상태코드, 본문은 `{ error }`):
 *   400  scene id 형식 오류
 *   404  경로가 /ws 가 아니거나, scene id에 해당하는 씬이 없음
 *   502  워커를 띄우지 못함 (exe 없음·기동 실패)
 *   503  게이트웨이가 기동 전/종료 중이거나, 세션 상한 도달 (Retry-After 동반)
 */

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer } from 'ws';

import { PoolExhaustedError, SessionPool, type Op, type PoolOptions } from '../sdk/index.ts';
import type { MeshDataResult } from '../sdk/protocol.ts';
import { SessionBridge, type ClientEvent, type ClientOutbound } from './bridge.ts';
import type { SceneStore } from './files.ts';

/** 게이트웨이 종료 — 표준 going away */
export const CLOSE_SHUTDOWN = 1001;
/** 워커가 스스로 죽었다. 세션 상태는 복구 불가 — 재연결이 유일한 답이다 */
export const CLOSE_SESSION_LOST = 4001;

/** close 프레임에 응하지 않는 상대를 끊기까지 기다리는 시간 */
const FORCE_CLOSE_MS = 2_000;

/** 클라이언트 → 서버 메시지 상한. op 요청은 전부 작다 (#7이 늘릴 일 있으면 늘릴 것) */
const DEFAULT_MAX_PAYLOAD = 1024 * 1024;

/** 죽은 연결이 워커를 붙잡고 있지 않게 하는 ping 주기 */
const DEFAULT_HEARTBEAT_MS = 30_000;

/**
 * 기본 워커 exe = `<backend>/native/build/Release/zelusSandBoxd-demo.exe`.
 *
 * cwd가 아니라 이 모듈 위치 기준이다 (defaultSceneDir과 같은 이유).
 * 데모 빌드라 라이선스가 필요 없다.
 */
export function defaultWorkerExe(): string {
  return path.resolve(
    import.meta.dirname, '..', '..',
    'native', 'build', 'Release', 'zelusSandBoxd-demo.exe',
  );
}

/**
 * 이 모듈이 세션에게 실제로 요구하는 것 전부.
 *
 * SDK의 `Session`을 그대로 쓰지 않고 구조 타입으로 좁힌 이유는 하나다 —
 * **exe 없이 도는 테스트 경로**를 남기기 위해서다. `SessionsOptions.createPool`에
 * 가짜 풀을 넘기면 워커를 띄우지 않고도 연결↔세션 수명을 검증할 수 있다.
 */
export interface SessionLike {
  readonly alive: boolean;
  once(event: 'exit', listener: (code: number | null) => void): unknown;

  /**
   * 워커 이벤트 구독 (#8). **옵셔널이다.**
   *
   * 필수로 만들면 exe 없이 도는 가짜 세션들이 이 표면을 흉내 내야 하고,
   * 그 순간 "가짜 풀로 수명만 검증한다"는 경로가 통째로 깨진다. 옵셔널이면
   * 없는 세션은 그냥 **이벤트를 내지 않는 세션**이 된다 — worker.request가
   * 없는 세션이 "중계를 지원하지 않는 세션"이 되는 것과 같은 규약이다.
   *
   * SDK의 `Session`은 그대로 만족한다(EventEmitter + 선언된 오버로드).
   */
  on?(event: 'frame', listener: (frame: number, mesh?: MeshDataResult) => void): unknown;
  on?(event: 'engineMessage', listener: (message: string) => void): unknown;

  /**
   * 리스너 제거. **'exit'만이 아니라 세 종류 전부** 여기로 뗀다.
   *
   * 필수인 이유가 `on`과 다르다: 리스너를 못 떼면 **세션이 풀로 반납돼
   * 재사용될 때 이전 클라이언트의 소켓으로 프레임이 계속 간다.** 이건
   * "기능이 없다"가 아니라 누수라, 조용히 건너뛸 수 있는 옵셔널로 두면
   * 안 된다. EventEmitter를 상속한 모든 세션(가짜 포함)이 이미 만족한다.
   */
  off(event: 'exit', listener: (code: number | null) => void): unknown;
  off(event: 'frame', listener: (frame: number, mesh?: MeshDataResult) => void): unknown;
  off(event: 'engineMessage', listener: (message: string) => void): unknown;
  /**
   * 로그용 pid와 op 중계 창구. 없으면 없는 대로 둔다.
   *
   * 중계를 `worker.request`로 하는 이유는 #7 보고에 적었지만 요약하면:
   * 클라이언트가 보내는 것은 어차피 `unknown` JSON이라 Session의 타입 있는
   * 메서드를 거쳐도 타입 안전을 얻지 못하고, op 17개를 메서드로 받으려면
   * 이 인터페이스가 17개를 요구하게 되어 **가짜 풀로 도는 테스트 경로가
   * 통째로 깨진다.** `request?`를 옵셔널로 두면 가짜 세션은 그대로 두고
   * (중계를 지원하지 않는 세션으로 취급된다) 실제 Session은 그냥 만족한다.
   *
   * Session이 감싸는 부가 상태(loadedPath·lastActivity)를 건너뛰지만,
   * 둘 다 지금 아무도 읽지 않는다 — 풀의 회수는 ageMs만 본다.
   */
  readonly worker?: {
    readonly pid?: number | undefined;
    request?(op: Op, payload?: Record<string, unknown>): Promise<unknown>;
  } | undefined;
}

export interface PoolStats {
  idle: number;
  busy: number;
  total: number;
}

/** SDK의 `SessionPool`이 그대로 만족한다 */
export interface SessionSource {
  acquire(): Promise<SessionLike>;
  release(session: SessionLike): Promise<void>;
  readonly stats: PoolStats;
  close(): Promise<void>;
}

export interface SessionsOptions {
  /** WS 경로. 기본 '/ws' */
  path?: string;

  // ── 워커 (기본 풀을 쓸 때만 의미 있다) ──────────────────────
  /** 워커 exe 경로. 기본 defaultWorkerExe() */
  exePath?: string;
  /** 라이선스가 필요한 빌드일 때 */
  licenseFile?: string;
  /** op 하나의 응답 상한 */
  requestTimeoutMs?: number;
  /** 세션 생성 시 Initialize()까지 부를지. 기본 true */
  autoInit?: boolean;
  /**
   * 세션 반납 후 프로세스를 살려둘 시간(ms). 기본 **0 = 즉시 종료**.
   *
   * 살려서 아끼는 건 기동 110ms뿐이고(씬 로드 ~830ms는 어차피 다시 낸다),
   * 유휴 프로세스는 라이선스 인스턴스를 계속 점유한다 — clear로도 안 풀린다.
   * 웹 세션은 브라우저 탭 단위라 재연결이 잦지도 않다. 그래서 기본은 0이다.
   */
  idleTimeout?: number;
  /** 유휴로 유지할 프로세스 상한 */
  maxIdle?: number;
  /** 동시에 살아 있을 수 있는 프로세스 상한. **라이선스 인스턴스 수와 직결된다** */
  maxTotal?: number;
  /** 이 나이를 넘긴 세션은 반납 시 회수. 풀은 사용 중인 세션을 뺏지 않는다 */
  maxLifetime?: number;

  // ── 전송 ──────────────────────────────────────────────────
  /** 클라이언트 메시지 상한(바이트). 기본 1MiB */
  maxPayload?: number;
  /** ping 주기(ms). 0이면 끈다. 기본 30000 */
  heartbeatIntervalMs?: number;
  /** 연결 하나가 동시에 띄울 수 있는 op 요청 수 (#7). 기본 32 */
  maxInflightRequests?: number;

  /**
   * 풀을 직접 만든다. 지정하면 위 워커 옵션은 전부 무시된다.
   *
   * **팩토리**인 이유는 재기동이다 — `SessionPool.close()`는 되돌릴 수 없어서
   * start()→close()→start()에 같은 인스턴스를 다시 쓸 수 없다. 인스턴스를 받으면
   * 두 번째 start()가 조용히 죽는다.
   */
  createPool?: () => SessionSource;
}

/** 게이트웨이가 채워 넣는 부분 */
export interface SessionManagerOptions extends SessionsOptions {
  /** scene id 검증용. 없으면 `?scene=`을 받지 않는다 */
  scenes?: SceneStore;
  log?: (line: string) => void;
}

/** 진단·테스트용 연결 요약. 서버 경로는 여기에도 없다 */
export interface SessionInfo {
  /** 연결 id (16자리 hex). 로그에서 세션을 따라가는 이름 */
  id: string;
  /** `?scene=`으로 지정된 씬. 이번 단위는 **로드하지 않는다** (#7의 일) */
  sceneId: string | null;
  openedAt: number;
  remote: string;
}

interface Conn {
  ws: WebSocket;
  info: SessionInfo;
  session: SessionLike;
  /** 반납은 반드시 **획득한 그 풀**로 한다. 재기동으로 풀이 갈릴 수 있다 */
  pool: SessionSource;
  onExit: (code: number | null) => void;
  /**
   * 워커 이벤트 중계 리스너 (#8). **연결이 닫히면 반드시 뗀다** —
   * 남으면 재사용된 세션의 프레임이 이전 클라이언트로 간다. null이면
   * 이 세션이 `on`을 제공하지 않는다는 뜻이다(가짜 세션 등).
   */
  onFrame: ((frame: number, mesh?: MeshDataResult) => void) | null;
  onEngineMessage: ((message: string) => void) | null;
  /**
   * 소켓이 OPEN이 아니라 버려진 이벤트 수.
   *
   * 지금은 진단용이다. **#9가 흐름 제어(latest-wins)를 넣는 자리가 정확히
   * 여기**이고, 그때 "안 보낸 것"과 "버린 것"을 같은 카운터로 셀 수 있게
   * 미리 자리를 잡아 둔다.
   */
  droppedEvents: number;
  /** 마지막 ping에 pong이 왔는가 */
  responsive: boolean;
  killTimer: NodeJS.Timeout | null;
  /** op 중계 정책 (#7). 연결 하나에 하나 */
  bridge: SessionBridge;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/**
 * 업그레이드를 HTTP 응답으로 끝낸다.
 *
 * 본문이 REST와 같은 `{ error }` JSON인 건 의도다 — 클라이언트가 파서를
 * 하나만 갖게 한다. 한글이 들어가므로 본문은 UTF-8, content-length는 **바이트**다.
 */
function refuse(
  socket: Duplex,
  status: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): void {
  if (socket.destroyed) return;
  if (!socket.writable) {
    socket.destroy();
    return;
  }

  const body = Buffer.from(JSON.stringify({ error: message }), 'utf8');
  const head = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
    'content-type: application/json; charset=utf-8',
    `content-length: ${body.length}`,
    'connection: close',
    ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
    '',
    '',
  ].join('\r\n');

  socket.end(Buffer.concat([Buffer.from(head, 'latin1'), body]));
}

/**
 * WS 연결 ↔ 세션 매핑을 소유한다.
 *
 * Gateway가 생성자에서 attach(http)로 붙이고, start()에서 open(),
 * close()에서 shutdown()을 부른다. 라우트 훅(RouteHooks)을 쓰지 않는 이유는
 * WS가 Express 스택을 지나지 않기 때문이다 — 업그레이드는 http.Server의
 * 'upgrade' 이벤트로 오고, 미들웨어도 404 catch-all도 거치지 않는다.
 */
export class SessionManager {
  #opts: SessionManagerOptions;
  #path: string;
  #attached: Server | null = null;

  /** open() ~ shutdown() 사이에만 존재한다. null이면 업그레이드를 받지 않는다 */
  #wss: WebSocketServer | null = null;
  #pool: SessionSource | null = null;

  #conns = new Map<WebSocket, Conn>();
  /** 연결 하나의 수명 전체(acquire → release). shutdown()이 이걸 기다린다 */
  #inflight = new Set<Promise<void>>();
  #heartbeat: NodeJS.Timeout | null = null;

  constructor(opts: SessionManagerOptions = {}) {
    this.#opts = opts;
    this.#path = opts.path ?? '/ws';
  }

  /** WS 엔드포인트 경로 */
  get path(): string {
    return this.#path;
  }

  /** open() ~ shutdown() 사이인가. 아니면 업그레이드가 전부 503이다 */
  get isOpen(): boolean {
    return this.#pool !== null;
  }

  /** 풀 통계. 열려 있지 않으면 전부 0 */
  get stats(): PoolStats {
    return this.#pool?.stats ?? { idle: 0, busy: 0, total: 0 };
  }

  /** 현재 붙어 있는 연결들. `stats.busy`와 어긋나면 어딘가 새고 있다는 뜻이다 */
  get connections(): SessionInfo[] {
    return [...this.#conns.values()].map((c) => ({ ...c.info }));
  }

  #log(line: string): void {
    this.#opts.log?.(line);
  }

  /**
   * http.Server의 'upgrade'를 잡는다. 생성자에서 한 번만 부른다.
   *
   * ⚠️ 리스너를 하나라도 달면 **업그레이드 소켓의 소유권이 우리에게 온다** —
   * Node의 기본 처리(소켓 파괴)가 사라지므로, 우리가 안 받는 경로도 반드시
   * 응답하고 끊어야 한다. 안 그러면 소켓이 타임아웃까지 매달린다.
   */
  attach(server: Server): void {
    if (this.#attached) return;
    this.#attached = server;
    server.on('upgrade', (req, socket, head) => {
      this.#track(req, socket as Duplex, head);
    });
  }

  /** 풀과 WS 서버를 만든다. Gateway.start()가 리스닝 직전에 부른다 (멱등) */
  open(): void {
    if (this.#pool) return;

    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.#opts.maxPayload ?? DEFAULT_MAX_PAYLOAD,
    });
    // noServer라도 핸드셰이크 도중 에러가 올라온다. 리스너가 없으면
    // EventEmitter가 throw 해서 프로세스를 죽인다.
    wss.on('error', (err: Error) => this.#log(`[warn] WS 서버 오류: ${err.message}`));
    this.#wss = wss;

    this.#pool = this.#opts.createPool
      ? this.#opts.createPool()
      : new SessionPool(this.#poolOptions());

    const interval = this.#opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    if (Number.isFinite(interval) && interval > 0) {
      this.#heartbeat = setInterval(() => this.#sweep(), interval);
      // 하트비트가 이벤트 루프를 붙잡으면 안 된다 — 서버가 닫혀도 프로세스가
      // 안 끝나고, 스모크의 워치독이 그걸 누수로 잡는다.
      this.#heartbeat.unref?.();
    }
  }

  #poolOptions(): PoolOptions {
    const o = this.#opts;
    return {
      exePath: o.exePath ?? defaultWorkerExe(),
      idleTimeout: o.idleTimeout ?? 0,
      onLog: (line) => this.#log(`[워커] ${line}`),
      ...(o.licenseFile === undefined ? {} : { licenseFile: o.licenseFile }),
      ...(o.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: o.requestTimeoutMs }),
      ...(o.autoInit === undefined ? {} : { autoInit: o.autoInit }),
      ...(o.maxIdle === undefined ? {} : { maxIdle: o.maxIdle }),
      ...(o.maxTotal === undefined ? {} : { maxTotal: o.maxTotal }),
      ...(o.maxLifetime === undefined ? {} : { maxLifetime: o.maxLifetime }),
    };
  }

  /**
   * 열려 있는 연결을 전부 닫고, 진행 중인 획득까지 기다린 뒤 풀을 비운다.
   *
   * 순서가 전부다. 풀을 먼저 닫으면 acquire 중이던 요청이 close 이후에 완료돼
   * **아무도 모르는 프로세스**가 남는다 (SessionPool.acquire는 create 후에
   * busy에 넣으므로 close()의 정리 대상에서 빠진다). 그래서 ①업그레이드를 먼저
   * 막고 ②연결을 닫고 ③진행 중인 것을 기다린 뒤 ④풀을 닫는다.
   */
  async shutdown(): Promise<void> {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }

    const pool = this.#pool;
    const wss = this.#wss;
    // ① 새 업그레이드를 막는다. 이 시점 이후의 요청은 503.
    this.#pool = null;
    this.#wss = null;

    // ②③ 진행 중이던 핸들러가 방금 연결을 등록했을 수 있으므로 수렴할 때까지 돈다.
    //    #pool이 null이라 새 세션은 더 안 생긴다 — 반드시 끝난다.
    while (this.#conns.size > 0 || this.#inflight.size > 0) {
      for (const conn of [...this.#conns.values()]) {
        this.#closeConn(conn, CLOSE_SHUTDOWN, '게이트웨이 종료');
      }
      await Promise.allSettled([...this.#inflight]);
    }

    if (wss) {
      try {
        wss.close();
      } catch {
        // 이미 닫혔거나 noServer라 할 일이 없다
      }
    }

    // ④ 유휴로 남은 프로세스까지 정리한다. 여기까지 와야 exe가 전부 사라진다.
    if (pool) await pool.close().catch(() => {});
  }

  // ── 연결 수명 ────────────────────────────────────────────────

  /** 연결 하나의 수명 전체를 #inflight에 담는다 */
  #track(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const done = this.#serve(req, socket, head).catch((err: unknown) => {
      this.#log(`[error] WS 업그레이드 처리 실패: ${err instanceof Error ? err.message : String(err)}`);
      if (!socket.destroyed) socket.destroy();
    });
    this.#inflight.add(done);
    void done.finally(() => this.#inflight.delete(done));
  }

  async #serve(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // req.url은 경로+쿼리뿐이다. 베이스는 파싱용 더미고 밖으로 나가지 않는다.
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname !== this.#path) {
      refuse(socket, 404, `WebSocket 엔드포인트가 아닙니다: ${url.pathname} (${this.#path} 를 쓰세요)`);
      return;
    }

    const pool = this.#pool;
    const wss = this.#wss;
    if (!pool || !wss) {
      refuse(socket, 503, '게이트웨이가 세션을 받을 수 있는 상태가 아닙니다', { 'retry-after': '5' });
      return;
    }

    // acquire 중(~110ms)에 클라이언트가 사라지는 것을 알아채야 한다.
    // 지금 걸어두지 않으면 그 창에서 끊긴 연결의 워커가 주인 없이 남는다.
    //
    // 이 리스너는 **소켓을 ws에 넘길 때까지 떼지 않는다.** 특히 'error'는
    // 리스너가 없으면 EventEmitter가 throw 해서 프로세스를 죽인다 —
    // 거절 응답을 쓴 뒤나 release()를 기다리는 동안 ECONNRESET이 도착하는
    // 경로가 실제로 있다. 떼는 건 ws가 소유권을 가져간 뒤 한 번뿐이다.
    let gone = socket.destroyed;
    const onGone = (): void => {
      gone = true;
    };
    socket.on('close', onGone);
    socket.on('error', onGone);
    const unwatch = (): void => {
      socket.off('close', onGone);
      socket.off('error', onGone);
    };

    // 씬 id는 **검증만** 한다. 로드는 #7의 op 중계가 한다.
    // 여기서 확인해 두면 없는 씬으로 세션을 띄우는 낭비가 사라지고,
    // 실패가 HTTP 상태코드로 즉시 드러난다.
    let sceneId: string | null = null;
    const raw = url.searchParams.get('scene');
    if (raw !== null) {
      if (!this.#opts.scenes) {
        refuse(socket, 404, '씬 저장소가 없습니다 (?scene= 를 쓸 수 없습니다)');
        return;
      }
      try {
        this.#opts.scenes.pathOf(raw); // 형식 검사 (통과해도 경로는 버린다)
      } catch {
        refuse(socket, 400, `씬 id 형식이 올바르지 않습니다: ${raw}`);
        return;
      }
      const record = await this.#opts.scenes.get(raw).catch(() => null);
      if (!record) {
        refuse(socket, 404, `씬을 찾을 수 없습니다: ${raw}`);
        return;
      }
      sceneId = raw;
    }

    const started = performance.now();
    let session: SessionLike;
    try {
      session = await pool.acquire();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof PoolExhaustedError) {
        // 상한 초과는 버그가 아니라 정상 운영 상황이다 (동접 = 라이선스 인스턴스).
        this.#log(`[warn] 세션 거절 — 상한 도달 (${this.stats.total}개 사용 중)`);
        refuse(socket, 503, message, { 'retry-after': '5' });
      } else {
        this.#log(`[error] 세션 확보 실패: ${message}`);
        refuse(socket, 502, `워커를 시작하지 못했습니다: ${message}`);
      }
      return;
    }
    const acquireMs = Math.round(performance.now() - started);

    // ② 110ms 창 ①: 주인이 사라졌다. 소켓은 이미 죽었으므로 반납만 하면 된다.
    if (gone || socket.destroyed) {
      await pool.release(session).catch(() => {});
      this.#log(`세션 취소 — 업그레이드 중 클라이언트가 끊김 (${acquireMs}ms)`);
      return;
    }

    // ② 110ms 창 ②: 그 사이 게이트웨이가 닫혔다. 위와 **소켓 상태가 다르다** —
    //    여기 소켓은 멀쩡히 살아 있다. 응답도 destroy도 없이 버리면, 'upgrade'를
    //    받은 뒤라 http.Server가 자기 close 리스너를 뗀 소켓 하나가 연결 카운트에
    //    영구히 남아 `http.close(cb)`의 콜백이 오지 않는다(closeAllConnections()도
    //    업그레이드된 소켓은 건드리지 못한다). 실측: 버리면 >4000ms 매달림,
    //    소켓을 처리하면 38ms. 그래서 다른 거절 경로와 **같은 모양으로** 닫는다.
    //    상태코드가 503인 이유도 같다 — "기동 전/종료 중"은 재시도하면 되는 상황이다.
    if (this.#pool !== pool) {
      // 먼저 거절을 써 보낸다. release()는 dispose 유예까지 기다릴 수 있어서,
      // 그 뒤에 두면 클라이언트가 이유도 모른 채 그만큼 매달린다.
      refuse(socket, 503, '게이트웨이가 종료 중입니다', { 'retry-after': '5' });
      await pool.release(session).catch(() => {});
      this.#log(`세션 취소 — 게이트웨이 종료 중 (${acquireMs}ms)`);
      return;
    }

    // 핸드셰이크를 완료한다. ws는 실패하면 콜백을 **부르지 않고** 소켓을
    // 파괴하므로, 소켓의 종료와 경주시키지 않으면 여기서 영원히 매달린다.
    const ws = await new Promise<WebSocket | null>((resolve) => {
      let settled = false;
      const finish = (value: WebSocket | null): void => {
        if (settled) return;
        settled = true;
        socket.off('close', onFail);
        socket.off('error', onFail);
        resolve(value);
      };
      const onFail = (): void => finish(null);
      socket.once('close', onFail);
      socket.once('error', onFail);
      wss.handleUpgrade(req, socket, head, (client) => finish(client));
    });

    if (!ws) {
      await pool.release(session).catch(() => {});
      // ②의 다른 얼굴이다. 클라이언트가 acquire 도중 끊으면 소켓의 'close'가
      // 아직 안 왔더라도 ws가 "읽거나 쓸 수 없는 소켓"으로 판정해 여기로 온다 —
      // 실측에서 10/40/80ms 중단이 전부 이 경로로 잡혔다. 두 그물이 모두 필요하다.
      this.#log(`세션 취소 — 핸드셰이크 실패/중단 (${acquireMs}ms)`);
      return;
    }

    // 소켓의 소유권이 ws로 넘어갔다. 우리 감시는 여기서 뗀다.
    unwatch();

    const info: SessionInfo = {
      id: randomBytes(8).toString('hex'),
      sceneId,
      openedAt: Date.now(),
      remote: `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? 0}`,
    };
    // 워커에 닿는 창구. `request`가 없는 세션(가짜 풀 등)은 target=null이
    // 되어 중계를 거부하고, 그 밖의 검증(화이트리스트·씬 id)은 그대로 돈다.
    const request = session.worker?.request;
    const worker = session.worker;
    const conn: Conn = {
      ws,
      info,
      session,
      pool,
      responsive: true,
      killTimer: null,
      onFrame: null,
      onEngineMessage: null,
      droppedEvents: 0,
      bridge: new SessionBridge({
        target: request && worker
          ? { request: (op, payload) => request.call(worker, op, payload) }
          : null,
        ...(this.#opts.scenes === undefined ? {} : { scenes: this.#opts.scenes }),
        sceneId,
        ...(this.#opts.maxInflightRequests === undefined
          ? {}
          : { maxInflight: this.#opts.maxInflightRequests }),
      }),
      onExit: (code) => {
        // 워커가 스스로 죽었다. 세션 상태는 복구 불가 — 연결을 끊어 클라이언트가
        // 재연결로 새 세션을 받게 한다. 조용히 살려두면 op이 전부 실패한다.
        this.#log(`[warn] 세션 ${info.id} 워커가 종료됨 (code=${code}) — 연결을 닫습니다`);
        this.#closeConn(conn, CLOSE_SESSION_LOST, '워커 프로세스가 종료되었습니다');
      },
    };

    this.#conns.set(ws, conn);
    session.once('exit', conn.onExit);
    this.#relayEvents(conn);

    ws.on('pong', () => {
      conn.responsive = true;
    });
    ws.on('error', (err: Error) => {
      // ws는 error 뒤에 반드시 close를 낸다. 반납은 close 한 곳에서만 한다.
      this.#log(`[warn] 세션 ${info.id} 소켓 오류: ${err.message}`);
    });
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      this.#onMessage(conn, data, isBinary);
    });

    this.#log(
      `세션 ${info.id} 시작 — pid=${session.worker?.pid ?? '?'}, `
      + `scene=${sceneId ?? '(없음)'}, acquire ${acquireMs}ms, 사용 중 ${this.stats.busy}개`,
    );

    // ③ 연결이 닫히고 **세션 반납까지 끝나야** 이 Promise가 풀린다.
    //    shutdown()이 이걸 기다리므로, 여기가 곧 "close() 후 exe가 없다"의 근거다.
    await new Promise<void>((resolve) => {
      ws.once('close', (code: number, reason: Buffer) => {
        void this.#detach(conn, code, reason.toString()).finally(resolve);
      });
    });
  }

  /**
   * 워커 이벤트를 이 연결의 소켓으로 흘린다 (#8).
   *
   * `on`이 없는 세션(가짜 풀 등)은 조용히 건너뛴다 — 이벤트를 내지 않는
   * 세션이라는 뜻일 뿐이고, op 중계는 그대로 돈다.
   *
   * 리스너를 conn에 **보관**하는 것이 이 함수의 요점이다. 익명 함수로 달면
   * #detach가 뗄 수 없고, 세션이 재사용될 때 이전 연결로 프레임이 간다.
   */
  #relayEvents(conn: Conn): void {
    const session = conn.session;
    if (!session.on) return;

    conn.onFrame = (frame: number, mesh?: MeshDataResult): void => {
      const ev = conn.bridge.frameEvent(frame, mesh);
      if (ev) this.#emit(conn, ev);
    };
    conn.onEngineMessage = (message: string): void => {
      const ev = conn.bridge.engineMessageEvent(message);
      if (ev) this.#emit(conn, ev);
    };

    session.on('frame', conn.onFrame);
    session.on('engineMessage', conn.onEngineMessage);
  }

  /** 연결 정리 + 세션 반납. ws의 'close'에서만 불린다 (한 번만 발화한다) */
  async #detach(conn: Conn, code: number, reason: string): Promise<void> {
    this.#conns.delete(conn.ws);
    conn.session.off('exit', conn.onExit);
    // ★ #8의 누수 방지. 이걸 빠뜨리면 재사용된 세션의 프레임이 이미 닫힌
    //   소켓의 conn으로 계속 들어온다 (bridge.close() 덕에 밖으로 나가지는
    //   않지만, 리스너가 세션에 무한정 쌓여 EventEmitter 경고와 함께 샌다).
    if (conn.onFrame) {
      conn.session.off('frame', conn.onFrame);
      conn.onFrame = null;
    }
    if (conn.onEngineMessage) {
      conn.session.off('engineMessage', conn.onEngineMessage);
      conn.onEngineMessage = null;
    }
    // 아직 응답을 기다리는 요청이 있어도 여기서 버린다. 소켓이 이미 닫혔으므로
    // 보낼 곳이 없고, 워커는 곧 반납·종료된다.
    conn.bridge.close();
    if (conn.killTimer) {
      clearTimeout(conn.killTimer);
      conn.killTimer = null;
    }

    // 구독은 **워커 쪽 스위치**라 load/clear/reset이 건드리지 않는다 —
    // 즉 프로세스 수명 내내 켜진 채로 남는다(protocol.cpp의 `subscribed`).
    // idleTimeout > 0 이면 세션이 풀로 돌아가 다음 연결에 재사용되는데,
    // 그때 새 클라이언트는 subscribe를 한 적도 없이 start만으로
    // **1.9MB/s의 메시를 받게 된다.** 구독을 연결 수명 안에 가두는 지점이
    // 여기뿐이라(SessionPool.release는 pause+clear까지만 한다) 여기서 끈다.
    //
    // 기다리지 않는 이유: 워커가 굳어 있으면 request가 requestTimeoutMs
    // (기본 120초)까지 매달리고, #detach를 기다리는 shutdown()이 통째로
    // 붙잡힌다. stdin 쓰기는 request() 안에서 동기로 끝나므로 아래 release가
    // 프로세스를 죽이든 풀에 넣든 이 줄은 이미 파이프에 들어가 있다.
    void conn.session.worker?.request?.('unsubscribe').catch(() => {
      // 이미 죽은 워커 / 미지원 세션. 반납 경로를 막을 이유가 없다.
    });

    const lifeMs = Date.now() - conn.info.openedAt;
    try {
      await conn.pool.release(conn.session);
    } catch (err: unknown) {
      this.#log(`[error] 세션 ${conn.info.id} 반납 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.#log(
      `세션 ${conn.info.id} 종료 — code=${code}${reason ? ` (${reason})` : ''}, `
      + `${lifeMs}ms, 사용 중 ${this.stats.busy}개`
      // 닫는 중에 도착한 이벤트다. 몇 건은 정상이지만 수백 건이면 워커가
      // 아직 시뮬을 돌리고 있다는 뜻이라 반납 경로를 의심할 근거가 된다.
      + (conn.droppedEvents > 0 ? `, 못 보낸 이벤트 ${conn.droppedEvents}건` : ''),
    );
  }

  /**
   * 서버가 먼저 닫는다. close 프레임에 응하지 않는 상대는 시간 뒤 강제로 끊는다 —
   * 안 그러면 죽은 소켓 하나가 shutdown()을 붙잡고 워커도 같이 남는다.
   */
  #closeConn(conn: Conn, code: number, reason: string): void {
    if (conn.ws.readyState === WebSocket.CLOSED) return;
    if (conn.ws.readyState !== WebSocket.CLOSING) {
      try {
        conn.ws.close(code, reason);
      } catch {
        conn.ws.terminate();
        return;
      }
    }
    if (conn.killTimer) return;
    conn.killTimer = setTimeout(() => conn.ws.terminate(), FORCE_CLOSE_MS);
    conn.killTimer.unref?.();
  }

  /**
   * 하트비트. WS는 죽은 TCP 연결을 조용히 유지할 수 있다(노트북 뚜껑, NAT 만료).
   * 그 연결 하나가 워커 프로세스 = 라이선스 인스턴스 하나를 무기한 붙잡으므로,
   * 나중이 아니라 지금 넣는다.
   */
  #sweep(): void {
    for (const conn of this.#conns.values()) {
      if (!conn.responsive) {
        this.#log(`[warn] 세션 ${conn.info.id} 하트비트 무응답 — 강제 종료`);
        conn.ws.terminate(); // close 이벤트 → #detach → 반납
        continue;
      }
      conn.responsive = false;
      try {
        conn.ws.ping();
      } catch {
        conn.ws.terminate();
      }
    }
  }

  /**
   * 클라이언트가 보낸 메시지 → 브리지.
   *
   * 여기서 하는 건 전송 계층의 판단뿐이다: 프레임 종류, 텍스트 디코딩, JSON
   * 파싱. 그 뒤는 전부 bridge.ts가 판단한다 — **어떤 op을 통과시키는지는 이
   * 파일에 한 줄도 없다.** 그래야 "무엇이 워커에 닿는가"를 한 파일에서 감사할
   * 수 있다.
   *
   * 응답은 어느 경로로 가든 워커 프로토콜과 같은 모양이다:
   *   { id?, ok: true, result } | { id?, ok: false, error }
   * 이 형태는 #6이 이미 클라이언트에게 약속한 것이라 바꾸지 않는다.
   *
   * 어떤 실패도 연결을 끊지 않는다. 잘못된 요청 하나가 세션(= 워커 프로세스
   * = 라이선스 인스턴스)을 날릴 이유가 없다.
   */
  #onMessage(conn: Conn, data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
    if (isBinary) {
      // 지금 클라이언트 → 서버는 op 요청뿐이고 전부 작은 JSON이다. 바이너리를
      // 받을 자리가 생긴다면 그건 #8 이후의 업로드 계열이지 여기가 아니다.
      this.#send(conn, { ok: false, error: '바이너리 프레임은 아직 받지 않습니다' });
      return;
    }

    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.from(new Uint8Array(data)).toString('utf8');

    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.#send(conn, { ok: false, error: 'JSON이 아닙니다' });
      return;
    }

    conn.bridge.dispatch(msg, (reply) => this.#send(conn, reply));
  }

  /**
   * 한 줄을 소켓에 쓴다. **던지지 않는다. 소켓 쓰기의 유일한 지점이다.**
   *
   * 브리지는 워커 응답이 도착했을 때 이걸 비동기로 부르고, 이벤트(#8)도
   * #emit을 거쳐 여기로 온다. 여기서 예외가 새면 그 자리가 처리되지 않은
   * Promise 거부가 되어 게이트웨이 프로세스가 통째로 죽는다 — 세션 하나의
   * 소켓이 방금 닫혔다는 이유로.
   */
  #send(conn: Conn, msg: ClientOutbound): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    try {
      conn.ws.send(JSON.stringify(msg));
    } catch (err: unknown) {
      this.#log(`[warn] 세션 ${conn.info.id} 전송 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 이벤트 한 줄 (#8). **워커 → 클라이언트 방향이 지나는 유일한 지점이다.**
   *
   * 응답과 갈라 둔 이유는 둘의 실패 의미가 다르기 때문이다. 응답을 못 보내면
   * 클라이언트의 요청 하나가 답을 못 받는 사고지만, 이벤트를 못 보내는 건
   * 정상이다 — 소켓이 닫히는 중인데 워커가 아직 프레임을 밀고 있는 상황은
   * 매 세션 종료마다 생긴다. 그래서 로그가 아니라 카운터로 센다.
   *
   * ★ **#9는 이 함수만 고치면 된다.** `ws.bufferedAmount`를 보고 프레임을
   *   버리는 latest-wins가 들어갈 자리가 여기다. 지금은 아무 제한이 없다:
   *   구독 중이면 세션당 약 1.9MB/s가 그대로 `ws.send`로 들어가고, 클라이언트가
   *   느리면 그만큼 ws 내부 버퍼에 쌓인다.
   */
  #emit(conn: Conn, ev: ClientEvent): void {
    if (conn.ws.readyState !== WebSocket.OPEN) {
      conn.droppedEvents += 1;
      return;
    }
    this.#send(conn, ev);
  }
}
