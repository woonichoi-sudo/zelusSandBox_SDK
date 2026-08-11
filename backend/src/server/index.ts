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

import { existsSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import { createExportRoutes, createSceneRoutes, ExportStore, SceneStore } from './files.ts';
import { createTextureRoutes, defaultTextureRoots, TextureStore } from './textures.ts';
import { SessionManager, type SessionsOptions } from './sessions.ts';

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
  /**
   * 익스포트 산출물을 둘 디렉토리 (#10). 기본은 `backend/data/exports`.
   * 씬과 마찬가지로 회사 저장소 밖이어야 한다.
   *
   * **씬과 같은 디렉토리를 쓰지 않는다.** 두 저장소의 정리 정책이 정반대이기
   * 때문이다 — 씬은 지우지 않고, 익스포트는 TTL로 지운다. 섞으면 익스포트
   * 청소가 남의 씬을 밟는다.
   */
  exportDir?: string;
  /** 산출물 수명(ms). 기본 DEFAULT_EXPORT_TTL_MS (30분) */
  exportTtlMs?: number;
  /** 연결 하나가 보유할 수 있는 산출물 수. 기본 DEFAULT_MAX_EXPORTS_PER_SESSION (4) */
  maxExportsPerSession?: number;
  /**
   * 텍스처를 내보내도 되는 **허용 뿌리**. 기본 `defaultTextureRoots()`
   * (= `%LOCALAPPDATA%\z-emotion`, 환경변수 `TEXTURE_ROOTS` 로 대체 가능).
   *
   * ⚠️ **빈 배열은 "전부 허용"이 아니라 "전부 금지"다.** 이 목록 밖의 경로는
   *    워커가 줘도 열리지 않는다 — 사용자가 올린 `.zls` 안의 문자열이 결국
   *    여기까지 오기 때문이다(`textures.ts` 머리말).
   */
  textureRoots?: readonly string[];
  /**
   * 프론트엔드 빌드 산출물(`frontend/dist`)을 서빙할 디렉토리 (#11).
   *
   * **기본값은 "끔"이다.** 켜져 있으면 404 catch-all이 SPA 폴백에 가려서,
   * `GET /없는경로`가 JSON 404 대신 index.html을 돌려준다 — 임베딩·테스트가
   * 기대하는 계약이 조용히 바뀐다. 그래서 "서빙한다"는 배포 시점의 명시적
   * 결정으로 두고, CLI(main)만 `defaultStaticDir()`을 켠다.
   *
   * 디렉토리가 없어도 죽지 않는다. `express.static`은 stat 실패 시 next()로
   * 흘리고 SPA 폴백도 index.html이 없으면 건너뛰므로, 개발 중(빌드 전)에는
   * 켜 두더라도 API·WS만 있는 서버와 동작이 같다.
   */
  staticDir?: string | null;

  /**
   * WS 세션(#6). 워커 exe 경로·세션 상한·하트비트 등.
   *
   * 라우트가 아니라 별도 옵션인 이유는 WS가 Express 스택을 지나지 않기
   * 때문이다 — 업그레이드는 http.Server의 'upgrade'로 온다.
   * `createPool`을 넘기면 exe 없이도 연결↔세션 수명을 검증할 수 있다.
   */
  sessions?: SessionsOptions;
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

/** 기본 익스포트 디렉토리 = `<backend>/data/exports` (#10). 근거는 위와 같다 */
export function defaultExportDir(): string {
  return path.resolve(import.meta.dirname, '..', '..', 'data', 'exports');
}

/**
 * 기본 정적 루트 = `<repo>/frontend/dist` (#11).
 *
 * defaultSceneDir과 같은 이유로 cwd가 아니라 모듈 위치 기준이다.
 * `src/server/`에서든 `dist/server/`에서든 세 단계 위가 저장소 루트다.
 */
export function defaultStaticDir(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..', 'frontend', 'dist');
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
  #exports: ExportStore;
  #textures: TextureStore;
  #sessions: SessionManager;

  constructor(opts: GatewayOptions = {}) {
    this.#opts = opts;
    this.#scenes = new SceneStore({
      dir: opts.sceneDir ?? defaultSceneDir(),
      ...(opts.maxSceneBytes === undefined ? {} : { maxBytes: opts.maxSceneBytes }),
    });
    this.#exports = new ExportStore({
      dir: opts.exportDir ?? defaultExportDir(),
      ...(opts.exportTtlMs === undefined ? {} : { ttlMs: opts.exportTtlMs }),
      ...(opts.maxExportsPerSession === undefined
        ? {}
        : { maxPerSession: opts.maxExportsPerSession }),
    });
    // ★ 씬·익스포트와 달리 **디렉토리가 아니라 허용 뿌리**를 받는다. 우리가 쓰는
    //   저장소가 아니라, 엔진이 만든 파일을 **내보내도 되는 범위**라서다.
    //   뿌리가 비면(LOCALAPPDATA 가 없는 환경 등) 텍스처 기능이 통째로 꺼진다 —
    //   "빈 목록 = 전부 허용" 으로 해석하면 설정을 빠뜨렸을 때 최악으로 열린다.
    this.#textures = new TextureStore({
      roots: opts.textureRoots ?? defaultTextureRoots(),
      onLog: (line) => this.#log(line),
    });
    this.#app = express();
    this.#configure(this.#app);
    this.#http = createHttpServer(this.#app);

    // WS는 라우트가 아니다. Express 스택(미들웨어·404 catch-all)을 지나지 않고
    // http.Server의 'upgrade' 이벤트로 온다. 그래서 #configure가 아니라 여기서
    // 붙는다. 리스너를 다는 순간 업그레이드 소켓의 소유권이 우리에게 오므로,
    // /ws가 아닌 경로도 SessionManager가 404로 끊는다.
    this.#sessions = new SessionManager({
      ...(opts.sessions ?? {}),
      scenes: this.#scenes,
      exports: this.#exports,
      textures: this.#textures,
      log: (line) => this.#log(line),
    });
    this.#sessions.attach(this.#http);
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

  /**
   * 익스포트 산출물 저장소 (#10).
   *
   * 씬 저장소와 대칭이다 — 세션이 만든 파일의 경로를 아는 곳이 여기 하나뿐이고,
   * 클라이언트는 id와 `/api/exports/<id>`만 본다.
   */
  /**
   * 텍스처 파일 등록소.
   *
   * 씬·익스포트와 달리 **디스크를 소유하지 않는다** — 엔진이 만든 파일을
   * id 로 가리키기만 한다. `gw.textures.size` 가 등록된 파일 수다.
   */
  get textures(): TextureStore {
    return this.#textures;
  }

  get exports(): ExportStore {
    return this.#exports;
  }

  /**
   * WS 세션 관리자 (#6).
   *
   * `gw.sessions.stats`가 풀 통계, `gw.sessions.connections`가 현재 연결이다.
   * 둘이 어긋나면 세션이 새고 있다는 뜻이다.
   */
  get sessions(): SessionManager {
    return this.#sessions;
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
    use(createExportRoutes(this.#exports)); // #10 GET /api/exports/:id
    use(createTextureRoutes(this.#textures)); // GET /api/textures/:id

    // (b) 바깥에서 주입한 라우트. 내장 뒤, catch-all 앞.
    for (const register of this.#opts.routes ?? []) use(register);

    // (c) 정적 파일 (#11). **API 라우트 뒤, 404 catch-all 앞**이어야 한다.
    //     앞이면 `/api/*`가 정적 파일 조회를 먼저 지나고, 뒤면 SPA 폴백이
    //     영원히 실행되지 않는다(ISSUE-001과 같은 실패 모드).
    const staticDir = this.#opts.staticDir;
    if (staticDir) this.#useStatic(app, staticDir);

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

  /**
   * 프론트엔드 번들 서빙 (#11).
   *
   * 두 겹이다.
   *   ① `express.static` — 실제 파일(`/assets/*.js`, `/favicon.ico`, `/`)
   *   ② SPA 폴백        — 그 밖의 GET을 index.html로. 라우팅이 클라이언트에
   *                        있는 한 `/scene/abc` 같은 주소를 새로고침해도 떠야 한다.
   *
   * 폴백이 삼키면 안 되는 것 두 가지를 명시적으로 뺀다:
   *   - `/api/*` — 없는 API는 **JSON 404**여야 한다. HTML을 돌려주면
   *     클라이언트가 `res.json()`에서 파싱 오류로 죽고, 진짜 원인(오타난 경로)이
   *     그 뒤에 묻힌다.
   *   - HTML을 원하지 않는 요청 — `fetch`가 Accept: application/json으로 물어본
   *     것에 index.html을 주면 같은 일이 벌어진다.
   * (`/ws`는 애초에 Express 스택을 지나지 않는다 — http.Server의 upgrade다.)
   *
   * dist가 없어도(개발 중) 죽지 않는다. ①은 stat 실패로 next(), ②는 존재
   * 확인에서 next() — 결과적으로 404 catch-all까지 그대로 흘러간다.
   * existsSync를 요청 시점에 보는 이유도 그것이다: 서버를 띄운 뒤에 프론트를
   * 빌드해도 재기동 없이 잡힌다.
   */
  #useStatic(app: Express, dir: string): void {
    const index = path.join(dir, 'index.html');

    app.use(
      express.static(dir, {
        // 해시가 박힌 에셋은 영구 캐시해도 되지만, index.html은 절대 안 된다.
        // 구별을 여기서 흉내 내지 않고 전부 재검증시킨다 — 정적 서빙이
        // 병목인 배포라면 앞단에 리버스 프록시를 두는 편이 맞다.
        etag: true,
        lastModified: true,
        maxAge: 0,
        // 디렉토리 목록은 절대 노출하지 않는다.
        index: ['index.html'],
        redirect: false,
        fallthrough: true,
        dotfiles: 'ignore',
      }),
    );

    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path === '/api' || req.path.startsWith('/api/')) return next();
      if (!req.accepts('html')) return next();
      if (!existsSync(index)) return next();

      res.sendFile(index, (err: unknown) => {
        if (!err) return;
        // 전송 도중 끊겼으면 헤더가 이미 나갔다 — 여기서 next()로 넘기면
        // 404 JSON이 헤더 뒤에 덧붙어 응답이 깨진다.
        if (res.headersSent) {
          res.end();
          return;
        }
        next();
      });
    });

    this.#log(`정적 서빙: ${dir}`);
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

    // 세션 풀도 리스닝 **전에** 연다. 업그레이드 요청이 풀 없는 순간을 만나면
    // 정상 요청이 503으로 튕긴다. 풀 생성은 프로세스를 띄우지 않으므로 싸다.
    this.#sessions.open();

    let bound: AddressInfo;
    try {
      bound = await new Promise<AddressInfo>((resolve, reject) => {
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
    } catch (err) {
      // 바인딩 실패(포트 점유 등)면 #address가 안 잡히고, close()는 그 경우
      // 조기 반환한다 — 방금 연 풀·하트비트 타이머를 여기서 되돌려야 한다.
      await this.#sessions.shutdown().catch(() => {});
      throw err;
    }

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
   *
   * **세션을 먼저 정리한다.** 여기서 워커를 안 죽이면 exe가 좀비로 남고,
   * 자식 프로세스의 stdio 파이프가 이벤트 루프를 붙잡아 스모크가 매달린다.
   * closeAllConnections()보다 앞이어야 하는 이유도 같다 — 소켓을 먼저 파괴하면
   * WS가 close 프레임 없이 끊기고, 반납이 그 뒤로 밀린다.
   */
  async close(): Promise<void> {
    if (!this.#address) return;
    this.#address = null;
    this.#startedAt = 0;

    await this.#sessions.shutdown();

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
  const exportTtlMs = Number(process.env['EXPORT_TTL_MS'] ?? Number.NaN);
  const maxExportsPerSession = Number(process.env['MAX_EXPORTS_PER_SESSION'] ?? Number.NaN);
  const maxSessions = Number(process.env['MAX_SESSIONS'] ?? Number.NaN);
  const idleTimeout = Number(process.env['SESSION_IDLE_TIMEOUT'] ?? Number.NaN);
  // 배포에서는 게이트웨이가 프론트 번들도 서빙한다 — 브라우저가 한 오리진만
  // 보게 되어 CORS 자체가 발생하지 않는다(ISSUE-002의 결정). 개발은 Vite
  // 프록시가 같은 모양을 흉내 내므로 프론트 코드는 양쪽에서 동일하다.
  // STATIC_DIR=off 로 끌 수 있다 — API만 띄우고 프론트는 Vite로 볼 때.
  const staticEnv = process.env['STATIC_DIR'];
  const staticDir = staticEnv === 'off' || staticEnv === 'none'
    ? null
    : (staticEnv ?? defaultStaticDir());

  const gateway = createServer({
    port,
    host: process.env['HOST'] ?? '127.0.0.1',
    onLog: (line) => console.log(line),
    staticDir,
    ...(process.env['SCENE_DIR'] ? { sceneDir: process.env['SCENE_DIR'] } : {}),
    ...(Number.isFinite(maxSceneBytes) ? { maxSceneBytes } : {}),
    ...(process.env['EXPORT_DIR'] ? { exportDir: process.env['EXPORT_DIR'] } : {}),
    ...(Number.isFinite(exportTtlMs) ? { exportTtlMs } : {}),
    ...(Number.isFinite(maxExportsPerSession) ? { maxExportsPerSession } : {}),
    sessions: {
      // MAX_SESSIONS는 라이선스 인스턴스 수와 직결된다. 안 주면 무제한이므로
      // 운영에서는 반드시 지정할 것.
      ...(process.env['WORKER_EXE'] ? { exePath: process.env['WORKER_EXE'] } : {}),
      ...(Number.isFinite(maxSessions) ? { maxTotal: maxSessions } : {}),
      ...(Number.isFinite(idleTimeout) ? { idleTimeout } : {}),
    },
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
  console.log(
    `익스포트 디렉토리: ${gateway.exports.dir} `
    + `(수명 ${Math.round(gateway.exports.ttlMs / 1000)}초, 세션당 ${gateway.exports.maxPerSession}개)`,
  );
  console.log(
    staticDir
      ? `정적 루트: ${staticDir}${existsSync(staticDir) ? '' : ' (아직 없음 — frontend에서 npm run build)'}`
      : '정적 루트: 없음 (STATIC_DIR=off)',
  );
  console.log(`WS: ${url.replace(/^http/, 'ws')}${gateway.sessions.path}  (연결 1개 = 워커 프로세스 1개)`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
