/**
 * 게이트웨이 HTTP 골격.
 *
 * 이후 단위(업로드·세션 API·WebSocket)가 전부 이 위에 쌓이므로, 지금
 * 정하는 건 라우트가 아니라 **수명 관리**다. 세 가지를 지킨다:
 *
 *   1. import 만으로는 아무것도 리스닝하지 않는다. start()를 불러야 뜬다.
 *   2. port 0 을 기본값으로 둔다 — 테스트가 포트 충돌 없이 몇 번이든 뜬다.
 *      실제로 잡힌 포트는 start()의 반환값과 `.port` 로 알 수 있다.
 *   3. close()가 keep-alive 소켓까지 끊는다. 안 그러면 이벤트 루프가
 *      살아남아 CI에서 매달린다.
 *
 * express 의 app.listen 대신 node:http 서버를 직접 만든다. WebSocket
 * 업그레이드(#6)가 http.Server 인스턴스를 필요로 하기 때문이다.
 *
 * 라우트를 추가하려면 #configure 안의 "라우트 등록 지점"을 볼 것. 404
 * catch-all이 같은 함수 안에서 등록되므로, 그 뒤에 붙은 라우트는 조용히
 * 죽는다 — 그래서 등록 자리를 한 곳으로 고정했다 (app 게터 주석 참고).
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import { createSceneRoutes, SceneStore } from './files.ts';

/**
 * 라우트 모듈이 받는 것.
 *
 * Gateway 내부(#opts, #log)를 직접 만지지 않고도 필요한 걸 얻게 하는 통로다.
 * 라우트별 의존성(#5의 업로드 디렉토리 등)은 `GatewayOptions`에 필드를 늘리고
 * 여기 `options`로 읽거나, 팩토리 인자로 직접 넘긴다 — 아래 RouteRegistrar 참고.
 */
export interface RouteContext {
  /** 생성자에 들어온 옵션 그대로 */
  readonly options: Readonly<GatewayOptions>;
  /** onLog와 같은 경로. 지정 안 했으면 조용하다 */
  log(line: string): void;
}

/** 라우트 모듈이 돌려줄 수 있는 수명 훅 */
export interface RouteHooks {
  /**
   * 디렉토리 생성처럼 await가 필요한 준비.
   *
   * 생성자는 await할 수 없으므로 여기로 뺀다. start()가 **리스닝 직전에**
   * 부르므로, 준비가 끝나기 전에 요청이 라우트에 닿는 일이 없다.
   * start()는 close() 후 재기동될 수 있으니 멱등해야 한다.
   */
  prepare?: () => Promise<void>;
}

/**
 * 라우트 등록 함수.
 *
 * 의존성이 필요하면 이 함수를 직접 export하지 말고 **팩토리**로 만든다:
 *
 *   export function createFileRoutes(deps: { uploadDir: string }): RouteRegistrar {
 *     return (app, ctx) => {
 *       app.post('/api/files', ...);
 *       return { prepare: () => mkdir(deps.uploadDir, { recursive: true }).then(() => {}) };
 *     };
 *   }
 */
export type RouteRegistrar = (app: Express, ctx: RouteContext) => void | RouteHooks;

export interface GatewayOptions {
  /** 바인딩 포트. 0이면 임의 포트. 기본 0 */
  port?: number;
  /** 바인딩 호스트. 기본 127.0.0.1 (외부 노출은 명시적으로만) */
  host?: string;
  /** 로그 훅. 지정하지 않으면 조용하다 (SDK의 onLog와 같은 규약) */
  onLog?: (line: string) => void;
  /**
   * 바깥에서 주입하는 추가 라우트. 내장 라우트 **뒤**, 404 catch-all **앞**에
   * 등록된다. 테스트·임베딩용이며, 항상 켜져 있어야 하는 기능 라우트는
   * 여기가 아니라 #configure의 내장 목록에 넣는다.
   */
  routes?: RouteRegistrar[];
  /**
   * 업로드된 씬을 둘 디렉토리. 기본은 `backend/data/scenes`.
   * 회사 저장소 밖이어야 한다 — 기본값도 그렇게 잡혀 있다.
   * 테스트는 임시 디렉토리를 넘겨 서버 인스턴스마다 격리할 수 있다.
   */
  sceneDir?: string;
  /** 업로드 1건의 상한(바이트). 기본 DEFAULT_MAX_SCENE_BYTES (512MiB) */
  maxSceneBytes?: number;
}

/**
 * 기본 씬 디렉토리 = `<backend>/data/scenes`.
 *
 * cwd가 아니라 **이 모듈 위치**를 기준으로 잡는다. cwd 기준이면 어디서
 * 띄우느냐에 따라 씬이 흩어지고, 최악의 경우 읽기 전용인 회사 저장소 안에
 * 생긴다. src/server/ 에서든 dist/server/ 에서든 두 단계 위가 backend/ 다.
 */
export function defaultSceneDir(): string {
  return path.resolve(import.meta.dirname, '..', '..', 'data', 'scenes');
}

/** start()가 알려주는 실제 바인딩 결과 */
export interface GatewayAddress {
  host: string;
  port: number;
  /** `http://host:port` — 테스트가 fetch에 바로 쓸 수 있게 */
  url: string;
}

/** /api/health 응답 본문 */
export interface HealthBody {
  status: 'ok';
  /** 프로세스가 아니라 이 서버 인스턴스가 뜬 뒤 지난 시간 */
  uptimeMs: number;
  pid: number;
  node: string;
  time: string;
}

/**
 * 에러가 들고 온 HTTP 상태코드를 꺼낸다. 없거나 수상하면 500.
 *
 * express.json()은 파싱 실패 시 `status`/`statusCode` = 400을 붙여 던지고,
 * http-errors 계열도 같은 규약을 쓴다. 이걸 무시하고 전부 500으로 덮으면
 * 클라이언트가 "내 요청이 잘못됐다"와 "서버가 터졌다"를 구분할 수 없다.
 *
 * `status`를 먼저 본다 — http-errors가 정본으로 두는 쪽이고, `statusCode`는
 * 그 별칭이다. 값은 신뢰하지 않는다: 400~599 정수가 아니면(예: 라이브러리가
 * errno나 문자열을 넣은 경우) res.status()가 던지므로 500으로 떨어뜨린다.
 * 3xx 이하도 에러 응답의 상태로는 말이 안 되므로 제외한다.
 */
function errorStatus(err: unknown): number {
  if (typeof err !== 'object' || err === null) return 500;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  for (const value of [status, statusCode]) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599) {
      return value;
    }
  }
  return 500;
}

export class Gateway {
  #opts: GatewayOptions;
  #app: Express;
  #http: Server;
  #address: GatewayAddress | null = null;
  #startedAt = 0;
  /** 등록된 라우트 모듈이 돌려준 수명 훅. start()가 소비한다 */
  #routeHooks: RouteHooks[] = [];
  #scenes: SceneStore;

  constructor(opts: GatewayOptions = {}) {
    this.#opts = opts;
    this.#scenes = new SceneStore({
      dir: opts.sceneDir ?? defaultSceneDir(),
      ...(opts.maxSceneBytes === undefined ? {} : { maxBytes: opts.maxSceneBytes }),
    });
    this.#app = express();
    this.#configure(this.#app);
    this.#http = createHttpServer(this.#app);
  }

  /**
   * 진단·검사용 Express 인스턴스.
   *
   * ⛔ **여기에 라우트를 붙이지 마라.** 404 catch-all이 생성자 안(#configure)에서
   * 이미 등록돼 있고 express는 등록 순서대로 평가하므로, `gw.app.get(...)`으로
   * 나중에 붙인 핸들러는 catch-all에 가려 **절대 실행되지 않는다** — 요청하면
   * 조용히 404가 돌아온다. 실제로 확인된 동작이다.
   *
   * 라우트를 추가하는 길은 두 개뿐이다:
   *   - 항상 켜져 있어야 하는 기능 → #configure의 "라우트 등록 지점"에 한 줄
   *   - 테스트·임베딩용 임시 라우트 → `GatewayOptions.routes`
   *
   * 이 게터는 설정 조회(`app.get('trust proxy')`)나 미들웨어 스택 검사처럼
   * 라우팅을 바꾸지 않는 용도로만 남겨 둔다.
   */
  get app(): Express {
    return this.#app;
  }

  /** WebSocket 업그레이드가 필요할 때 (#6) */
  get server(): Server {
    return this.#http;
  }

  /**
   * 업로드된 씬 저장소.
   *
   * #6이 세션에 씬을 물릴 때 필요하다. 클라이언트는 id만 알고, 워커의 load
   * op은 절대경로를 받으므로, 그 변환은 `gw.scenes.pathOf(id)` 한 곳에서만
   * 일어난다 — 경로가 응답 JSON으로 새는 길을 아예 만들지 않기 위해서다.
   */
  get scenes(): SceneStore {
    return this.#scenes;
  }

  get listening(): boolean {
    return this.#address !== null;
  }

  /** 실제로 잡힌 포트. 기동 전에는 던진다 — 0을 돌려주면 조용히 틀린다 */
  get port(): number {
    if (!this.#address) throw new Error('서버가 아직 기동되지 않았습니다 (start() 먼저)');
    return this.#address.port;
  }

  get url(): string {
    if (!this.#address) throw new Error('서버가 아직 기동되지 않았습니다 (start() 먼저)');
    return this.#address.url;
  }

  #log(line: string): void {
    this.#opts.onLog?.(line);
  }

  #configure(app: Express): void {
    // 프록시 뒤에 두더라도 req.ip가 맞게 나오게 한다. 지금은 무해하고,
    // 나중에 rate limit을 붙일 때 필요해진다.
    app.set('trust proxy', true);
    app.disable('x-powered-by');

    app.use(express.json({ limit: '1mb' }));

    app.get('/api/health', (_req: Request, res: Response) => {
      const body: HealthBody = {
        status: 'ok',
        uptimeMs: this.#startedAt > 0 ? Math.round(performance.now() - this.#startedAt) : 0,
        pid: process.pid,
        node: process.version,
        time: new Date().toISOString(),
      };
      res.json(body);
    });

    // ── 라우트 등록 지점 ──────────────────────────────────────────────
    // 후속 단위(#5 파일 API, #7~ 세션 API …)의 라우트는 **여기**에 붙는다.
    // 아래 404 catch-all보다 나중에 등록되는 라우트는 영원히 실행되지 않으므로,
    // 등록 자리를 한 곳으로 못 박아 그 실패 모드 자체를 없앤다. 순서가
    // 이 함수 하나만 읽으면 보인다는 것도 의도한 결과다.
    const ctx: RouteContext = {
      options: this.#opts,
      log: (line) => this.#log(line),
    };
    const use = (register: RouteRegistrar): void => {
      const hooks = register(app, ctx);
      if (hooks) this.#routeHooks.push(hooks);
    };

    // (a) 내장 라우트 모듈. 여기에 한 줄씩 는다.
    //
    //     의존성은 팩토리 인자로 넘기고, 바깥에서 바꿔야 하는 값이면
    //     GatewayOptions에 필드를 추가해 생성자 시점에 받는다.
    //     await가 필요한 준비는 팩토리가 RouteHooks.prepare로 돌려주면
    //     start()가 리스닝 직전에 처리한다 — 생성자에서 await할 필요가 없다.
    use(createSceneRoutes(this.#scenes)); // #5 POST/GET /api/scenes

    // (b) 바깥에서 주입한 라우트. 내장 뒤, catch-all 앞.
    for (const register of this.#opts.routes ?? []) use(register);

    // 404도 JSON이어야 한다. 클라이언트가 한 종류의 파서만 쓰게 된다.
    app.use((req: Request, res: Response) => {
      res.status(404).json({ error: `찾을 수 없음: ${req.method} ${req.path}` });
    });

    // express 5는 async 핸들러가 던진 것도 여기로 넘긴다 (4와 다른 점).
    // 인자 4개여야 에러 핸들러로 인식된다.
    app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
      const message = err instanceof Error ? err.message : String(err);
      const status = errorStatus(err);

      // 4xx는 클라이언트 잘못이고 서버는 멀쩡하다. 같은 [error]로 찍으면
      // 깨진 요청 몇 건에 진짜 장애가 묻힌다. 레벨을 갈라 둔다.
      this.#log(`[${status < 500 ? 'warn' : 'error'}] ${status} ${message}`);

      if (res.headersSent) {
        next(err);
        return;
      }
      res.status(status).json({ error: message });
    });
  }

  /** 리스닝을 시작한다. 이미 떠 있으면 현재 주소를 그대로 돌려준다. */
  async start(): Promise<GatewayAddress> {
    if (this.#address) return this.#address;

    const host = this.#opts.host ?? '127.0.0.1';
    const port = this.#opts.port ?? 0;

    // 라우트의 비동기 준비를 리스닝 **전에** 끝낸다. 요청이 아직 못 들어오는
    // 시점이라, 준비 중인 디렉토리를 핸들러가 먼저 만나는 경우가 없다.
    // 재기동될 수 있으므로 prepare는 멱등이어야 한다(RouteHooks 주석 참고).
    for (const hooks of this.#routeHooks) await hooks.prepare?.();

    const bound = await new Promise<AddressInfo>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.#http.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.#http.removeListener('error', onError);
        resolve(this.#http.address() as AddressInfo);
      };
      this.#http.once('error', onError);
      this.#http.once('listening', onListening);
      this.#http.listen(port, host);
    });

    this.#startedAt = performance.now();
    this.#address = {
      host: bound.address,
      port: bound.port,
      url: `http://${bound.family === 'IPv6' ? `[${bound.address}]` : bound.address}:${bound.port}`,
    };
    this.#log(`게이트웨이 기동 ${this.#address.url}`);
    return this.#address;
  }

  /**
   * 리스닝을 멈추고 소켓을 전부 끊는다.
   * server.close()만으로는 keep-alive 연결이 남아 이벤트 루프가 안 빈다.
   */
  async close(): Promise<void> {
    if (!this.#address) return;
    this.#address = null;
    this.#startedAt = 0;

    await new Promise<void>((resolve, reject) => {
      this.#http.close((err) => (err ? reject(err) : resolve()));
      this.#http.closeAllConnections();
    });
    this.#log('게이트웨이 종료');
  }
}

/** 테스트든 CLI든 여기를 지난다. import 만으로는 아무 포트도 잡지 않는다. */
export function createServer(opts: GatewayOptions = {}): Gateway {
  return new Gateway(opts);
}

/** CLI 경로: node --experimental-strip-types src/server/index.ts */
async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 3000);
  const maxSceneBytes = Number(process.env['MAX_SCENE_BYTES'] ?? Number.NaN);
  const gateway = createServer({
    port,
    host: process.env['HOST'] ?? '127.0.0.1',
    onLog: (line) => console.log(line),
    ...(process.env['SCENE_DIR'] ? { sceneDir: process.env['SCENE_DIR'] } : {}),
    ...(Number.isFinite(maxSceneBytes) ? { maxSceneBytes } : {}),
  });

  const shutdown = (signal: string): void => {
    console.log(`\n${signal} 수신 — 종료합니다`);
    void gateway.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const { url } = await gateway.start();
  console.log(`health: ${url}/api/health`);
  console.log(`씬 디렉토리: ${gateway.scenes.dir} (상한 ${gateway.scenes.maxBytes} 바이트)`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
