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
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';

export interface GatewayOptions {
  /** 바인딩 포트. 0이면 임의 포트. 기본 0 */
  port?: number;
  /** 바인딩 호스트. 기본 127.0.0.1 (외부 노출은 명시적으로만) */
  host?: string;
  /** 로그 훅. 지정하지 않으면 조용하다 (SDK의 onLog와 같은 규약) */
  onLog?: (line: string) => void;
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

export class Gateway {
  #opts: GatewayOptions;
  #app: Express;
  #http: Server;
  #address: GatewayAddress | null = null;
  #startedAt = 0;

  constructor(opts: GatewayOptions = {}) {
    this.#opts = opts;
    this.#app = express();
    this.#configure(this.#app);
    this.#http = createHttpServer(this.#app);
  }

  /** 라우트를 더 얹고 싶을 때. #5 이후 단위가 여기에 붙는다 */
  get app(): Express {
    return this.#app;
  }

  /** WebSocket 업그레이드가 필요할 때 (#6) */
  get server(): Server {
    return this.#http;
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

    // 404도 JSON이어야 한다. 클라이언트가 한 종류의 파서만 쓰게 된다.
    app.use((req: Request, res: Response) => {
      res.status(404).json({ error: `찾을 수 없음: ${req.method} ${req.path}` });
    });

    // express 5는 async 핸들러가 던진 것도 여기로 넘긴다 (4와 다른 점).
    // 인자 4개여야 에러 핸들러로 인식된다.
    app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
      const message = err instanceof Error ? err.message : String(err);
      this.#log(`[error] ${message}`);
      if (res.headersSent) {
        next(err);
        return;
      }
      res.status(500).json({ error: message });
    });
  }

  /** 리스닝을 시작한다. 이미 떠 있으면 현재 주소를 그대로 돌려준다. */
  async start(): Promise<GatewayAddress> {
    if (this.#address) return this.#address;

    const host = this.#opts.host ?? '127.0.0.1';
    const port = this.#opts.port ?? 0;

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
  const gateway = createServer({
    port,
    host: process.env['HOST'] ?? '127.0.0.1',
    onLog: (line) => console.log(line),
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
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
