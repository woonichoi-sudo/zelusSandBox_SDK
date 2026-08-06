/**
 * 게이트웨이 서버 스모크 테스트.
 *
 * 이 파일은 health 라우트 하나를 확인하려고 있는 게 아니다. 이후 단위
 * (#5 파일 API, #6 WS 브리지, #7~#10 백프레셔·다운로드)가 전부 여기에
 * 테스트를 얹으므로, 실제 산출물은 **하네스**다. 세 가지를 보장한다:
 *
 *   1. 서버는 어떤 경로로 나가든 닫힌다 — withServer()의 finally.
 *   2. 테스트가 매달리지 않는다 — 전역 가드(진행 중 멈춤)와
 *      워치독(끝난 뒤 이벤트 루프가 안 비는 경우)이 각각 잡는다.
 *   3. 섹션마다 독립된 서버를 쓴다 — port 0이라 병렬·연속 기동이 자유롭다.
 *
 * 스타일은 sdk/smoke.ts를 그대로 따른다. 프레임워크 없음.
 *
 *   node --experimental-strip-types src/server/smoke.ts
 *
 * ── 이후 단위가 테스트를 추가하는 법 ────────────────────────────
 * 아래 "§N" 주석 섹션을 하나 새로 열고, 그 안에서 withServer()로 서버를
 * 띄운 뒤 check()를 부르면 된다. 서버 정리·타임아웃·exit code는 하네스가
 * 이미 처리하므로 신경 쓸 필요가 없다. 다른 섹션의 서버와 포트가 겹치지도
 * 않는다. 라우트가 상태를 갖는다면(업로드된 파일 등) 섹션 안에서
 * withServer 콜백이 끝나는 순간 그 서버 인스턴스와 함께 사라진다.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, type Duplex } from 'node:stream';
import { promisify } from 'node:util';

import { WebSocket } from 'ws';

import { PoolExhaustedError, SessionPool } from '../sdk/index.ts';
import {
  createServer,
  type Gateway,
  type GatewayAddress,
  type GatewayOptions,
  type RouteContext,
  type RouteRegistrar,
} from './index.ts';
import {
  CLOSE_SESSION_LOST,
  CLOSE_SHUTDOWN,
  defaultWorkerExe,
  type PoolStats,
  type SessionLike,
  type SessionSource,
} from './sessions.ts';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  실패'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** 판정에 넣지 않는 진단. 기준(§1) 밖이지만 알아둘 값을 남긴다. */
function note(label: string, detail: string): void {
  console.log(`  ..    ${label}  — ${detail}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

/**
 * 서버를 띄우고 **반드시** 닫는다.
 *
 * 콜백이 던지든, check가 실패하든, await가 거부되든 finally가 close()를
 * 부른다. close()가 keep-alive 소켓까지 끊으므로 이벤트 루프가 남지 않는다.
 * 테스트가 gateway를 직접 만들면 이 보장이 깨지므로, 새 섹션도 이걸 쓸 것.
 */
async function withServer<T>(
  fn: (gw: Gateway, addr: GatewayAddress) => Promise<T>,
  opts: GatewayOptions = {},
): Promise<T> {
  const gw = createServer({ onLog: () => {}, ...opts });
  try {
    const addr = await gw.start();
    return await fn(gw, addr);
  } finally {
    await gw.close();
  }
}

interface Fetched {
  status: number;
  contentType: string;
  body: unknown;
  text: string;
}

/** 상태코드·헤더·본문을 한 번에. 본문이 JSON이 아니어도 죽지 않는다. */
async function get(url: string, init?: RequestInit): Promise<Fetched> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body, text };
}

/** 거부되기를 기대하는 요청. 거부 사유를 문자열로 돌려준다. */
async function expectRefused(url: string): Promise<string | null> {
  try {
    await fetch(url);
    return null;
  } catch (err: unknown) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ?? (err instanceof Error ? err.message : String(err));
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 거절 본문(`{ error }` JSON)에서 문구만. 파싱 실패는 빈 문자열 */
function errorOf(body: string): string {
  try {
    const v: unknown = JSON.parse(body);
    return isRecord(v) && typeof v['error'] === 'string' ? v['error'] : '';
  } catch {
    return '';
  }
}

/**
 * 503 두 가지의 **문구**. 상태코드도 Retry-After도 같아서 클라이언트가
 * 둘을 가를 수 있는 단서가 이 문구뿐이다:
 *
 *   NOT_ACCEPTING  아직 안 열렸거나 세션 계층이 이미 닫힌 뒤 — 업그레이드 자체를 안 받는다
 *   SHUTTING_DOWN  받긴 받았고 세션까지 얻었는데 그 사이 게이트웨이가 닫혔다
 *
 * 앞은 "다시 걸면 언젠가 된다", 뒤는 "이 게이트웨이는 지금 죽는 중"이다.
 * 운영에서 재시도 로직과 원인 추적이 갈리는 지점이라 **계약으로 고정한다** —
 * 통일하려는 손이 오면 여기가 먼저 깨진다.
 */
const REFUSE_NOT_ACCEPTING = '게이트웨이가 세션을 받을 수 있는 상태가 아닙니다';
const REFUSE_SHUTTING_DOWN = '게이트웨이가 종료 중입니다';

// ── §6 도우미 ────────────────────────────────────────────────────────
// 씬 API는 **디스크 상태**를 갖는 첫 라우트다. 앞 섹션들과 달리 서버를
// 닫는 것만으로 정리되지 않으므로, 도우미가 두 가지를 더 책임진다:
// 격리(인스턴스마다 자기 디렉토리)와 삭제(어떤 경로로 나가든 rm).

/**
 * 임시 씬 디렉토리를 만들고 **반드시** 지운다.
 *
 * 레이아웃이 `<root>/a/b/scenes`인 건 취향이 아니다. traversal 테스트가
 * `..`·`..\..`로 한두 단계 위를 노리는데, 그 착지점이 시스템 temp 루트면
 * "안 새어나갔다"를 단언할 수가 없다. 위로 두 단계를 우리가 소유하면
 * root 전체를 훑어 "예상 밖 파일 0건"이라고 말할 수 있다.
 */
async function withSceneDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'zelus-smoke-'));
  try {
    return await fn(path.join(root, 'a', 'b', 'scenes'));
  } finally {
    // 103MB를 남기지 않는다. 실패하든 던지든 여기를 지난다.
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/** withServer + 격리된 씬 디렉토리. 씬 테스트는 전부 이걸 쓴다 */
async function withScenes<T>(
  fn: (gw: Gateway, addr: GatewayAddress, dir: string) => Promise<T>,
  opts: Omit<GatewayOptions, 'sceneDir'> = {},
): Promise<T> {
  return withSceneDir((dir) =>
    withServer((gw, addr) => fn(gw, addr, dir), { ...opts, sceneDir: dir }),
  );
}

/** `<root>/a/b/scenes` 에서 root */
function rootOf(sceneDir: string): string {
  return path.resolve(sceneDir, '..', '..', '..');
}

/** 트리 전체를 상대경로 목록으로. 디렉토리는 끝에 `/`가 붙는다 */
async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        out.push(`${child}/`);
        stack.push(child);
      } else {
        out.push(child);
      }
    }
  }
  return out.sort();
}

async function partFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.part'));
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** duplex는 표준 RequestInit 타입에 아직 없다. 스트림 본문에 필수 */
type UploadInit = RequestInit & { duplex?: 'half' };

/**
 * POST /api/scenes. name이 undefined면 쿼리 자체를 붙이지 않는다
 * ("파라미터 없음"과 "빈 문자열"은 다른 케이스라 구분이 필요하다).
 */
function upload(
  addr: GatewayAddress,
  name: string | undefined,
  body: Uint8Array | Readable,
  opts: { contentType?: string; signal?: AbortSignal } = {},
): Promise<Fetched> {
  const url = name === undefined
    ? `${addr.url}/api/scenes`
    : `${addr.url}/api/scenes?name=${encodeURIComponent(name)}`;
  const init: UploadInit = {
    method: 'POST',
    headers: { 'content-type': opts.contentType ?? 'application/octet-stream' },
    body: body instanceof Readable
      ? (Readable.toWeb(body) as unknown as ReadableStream)
      : body,
    duplex: 'half',
  };
  if (opts.signal) init.signal = opts.signal;
  return get(url, init);
}

function sceneOf(f: Fetched): Record<string, unknown> | null {
  if (!isRecord(f.body)) return null;
  const s = f.body['scene'];
  return isRecord(s) ? s : null;
}

function scenesOf(f: Fetched): Array<Record<string, unknown>> {
  if (!isRecord(f.body)) return [];
  const s = f.body['scenes'];
  return Array.isArray(s) ? s.filter(isRecord) : [];
}

async function listScenes(addr: GatewayAddress): Promise<Array<Record<string, unknown>>> {
  return scenesOf(await get(`${addr.url}/api/scenes`));
}

/** 진행 중인 업로드를 붙잡아 두는 밸브 */
function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

/**
 * 앞부분을 보낸 뒤 밸브가 열릴 때까지 멈추는 요청 본문.
 * "업로드가 아직 안 끝난 순간"을 만들어야 부분 업로드 불변식을 볼 수 있다.
 */
function stalledBody(head: Uint8Array, tail: Uint8Array, gate: Promise<void>): Readable {
  return Readable.from((async function* () {
    yield head;
    await gate;
    yield tail;
  })());
}

/** probe가 값을 낼 때까지 짧게 폴링. 못 내면 null (매달리지 않는다) */
async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 5_000): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== null) return v;
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── §7 도우미 (WS 세션) ──────────────────────────────────────────────
// 이 단위가 지키는 불변식은 하나다: **열린 소켓 하나 = 살아 있는 워커 하나.**
// 그래서 도우미도 그 등식의 양쪽을 각각 볼 수 있게 만든다 —
// 게이트웨이 쪽은 `stats.busy`/`connections`로, OS 쪽은 pid로.
//
// 가짜 풀(FakePool)과 실제 풀(TracingPool)을 둘 다 두는 이유:
//   - 가짜: 프로세스를 안 띄우므로 즉시 돌고, acquire를 게이트로 붙잡아
//     "110ms 창"처럼 실제로는 재현이 불안정한 타이밍을 **결정적으로** 만든다.
//   - 실제: 가짜만 쓰면 "진짜 프로세스가 진짜로 죽는가"를 한 번도 확인하지
//     않게 된다. 이 단위가 지키려는 게 정확히 그것이므로 7-1은 실제 exe를 쓴다.

const execFileAsync = promisify(execFile);

/** `ws://host:port/ws` + 쿼리 */
function wsUrlOf(addr: GatewayAddress, query = ''): string {
  return `${addr.url.replace(/^http/, 'ws')}/ws${query}`;
}

/**
 * 핸드셰이크의 결말.
 *
 * 이 설계에서 거절은 **업그레이드 전 HTTP 응답**이라, 결과가 둘 중 하나로
 * 갈린다: 소켓이 열리거나(ws), 상태코드가 돌아오거나(status). Node의 ws는
 * 'unexpected-response'로 본문·헤더까지 읽을 수 있다 — 브라우저는 못 읽는다.
 */
interface WsOutcome {
  ws: WebSocket | null;
  status: number | null;
  retryAfter: string | null;
  body: string;
  error: string | null;
}

async function connect(url: string, opts: { autoPong?: boolean } = {}): Promise<WsOutcome> {
  const client = new WebSocket(url, opts);
  const blank: WsOutcome = { ws: null, status: null, retryAfter: null, body: '', error: null };
  return new Promise<WsOutcome>((resolve) => {
    client.once('open', () => {
      // open 뒤에 오는 오류(서버가 소켓을 파괴하는 경우 등)를 삼킨다.
      // 리스너가 없으면 EventEmitter가 throw 해서 스모크가 죽는다.
      client.on('error', () => {});
      resolve({ ...blank, ws: client });
    });
    client.once('unexpected-response', (_req, res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const ra = res.headers['retry-after'];
        resolve({
          ...blank,
          status: res.statusCode ?? 0,
          retryAfter: typeof ra === 'string' ? ra : null,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    client.once('error', (err: Error) => resolve({ ...blank, error: err.message }));
  });
}

/** 매달리지 않는 await. 시간 안에 안 풀리면 fallback */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    void p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}

/** 조건이 참이 될 때까지 폴링. `stats.busy`는 release가 비동기라 즉시 읽으면 틀린다 */
async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  return (await waitFor(async () => ((await cond()) ? true : null), timeoutMs)) === true;
}

/** close 프레임의 code/reason. **닫기 전에** 불러 두어야 놓치지 않는다 */
function closedWith(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString('utf8') }));
  });
}

/** 메시지 하나를 보내고 응답 하나를 받는다. 응답이 없으면 null */
async function ask(
  ws: WebSocket,
  payload: unknown,
  opts: { raw?: string; binary?: Uint8Array } = {},
): Promise<Record<string, unknown> | null> {
  const got = new Promise<string>((resolve) => {
    ws.once('message', (data: Buffer) => resolve(data.toString('utf8')));
  });
  if (opts.binary) ws.send(opts.binary, { binary: true });
  else if (opts.raw !== undefined) ws.send(opts.raw);
  else ws.send(JSON.stringify(payload));
  const text = await withTimeout(got, 2_000, '');
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * pid 하나가 아직 살아 있는가.
 *
 * exe **개수**를 세지 않는 게 핵심이다. 같은 exe를 다른 프로세스가 띄우고
 * 있으면(SDK 스모크 병행 실행 등) 개수는 오탐을 낸다. 우리가 만든 pid만
 * 확인하면 그 오탐이 구조적으로 사라진다. 이미지명까지 함께 보는 건
 * pid 재사용 방어다.
 */
async function pidAlive(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV']);
    return stdout.includes(`"${pid}"`) && stdout.toLowerCase().includes('zelussandboxd-demo.exe');
  } catch {
    return false;
  }
}

/** 진단용 전체 개수. 판정에는 쓰지 않는다 (다른 프로세스가 띄운 것도 세므로) */
async function exeCount(): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'tasklist', ['/FI', 'IMAGENAME eq zelusSandBoxd-demo.exe', '/NH', '/FO', 'CSV'],
    );
    return stdout.split('\n').filter((l) => l.toLowerCase().includes('zelussandboxd-demo.exe')).length;
  } catch {
    return -1;
  }
}

/** 프로세스를 안 띄우는 세션. SessionLike가 요구하는 표면이 이게 전부다 */
class FakeSession extends EventEmitter implements SessionLike {
  alive = true;
  readonly worker = { pid: 0 };

  /** 워커가 스스로 죽는 상황 (엔진 크래시) */
  die(code: number | null = 1): void {
    this.alive = false;
    this.emit('exit', code);
  }
}

interface FakePoolOptions {
  /** 동시 상한. 넘으면 PoolExhaustedError (실제 풀과 같은 예외 타입) */
  maxTotal?: number;
  /** acquire를 붙잡아 둔다. "110ms 창"을 결정적으로 만드는 장치 */
  gate?: Promise<void>;
  /** acquire가 PoolExhaustedError가 **아닌** 오류로 실패 (워커 기동 실패) */
  boom?: boolean;
  /** acquire에 들어온 순간 */
  onEnter?: () => void;
}

class FakePool implements SessionSource {
  acquired = 0;
  released = 0;
  closed = 0;
  readonly live = new Set<FakeSession>();
  #o: FakePoolOptions;

  constructor(o: FakePoolOptions = {}) {
    this.#o = o;
  }

  async acquire(): Promise<SessionLike> {
    this.#o.onEnter?.();
    if (this.#o.gate) await this.#o.gate;
    if (this.#o.boom) throw new Error('가짜 워커 기동 실패');
    const max = this.#o.maxTotal;
    if (max !== undefined && this.live.size >= max) {
      throw new PoolExhaustedError(`세션 상한 도달 (${max}). 동시 인스턴스 수는 라이선스와 직결됩니다.`);
    }
    const s = new FakeSession();
    this.live.add(s);
    this.acquired++;
    return s;
  }

  async release(session: SessionLike): Promise<void> {
    // 실제 풀과 같은 순서: busy에서 먼저 빼고 정리한다.
    this.live.delete(session as FakeSession);
    (session as FakeSession).alive = false;
    this.released++;
  }

  get stats(): PoolStats {
    return { idle: 0, busy: this.live.size, total: this.live.size };
  }

  async close(): Promise<void> {
    this.closed++;
    for (const s of this.live) s.alive = false;
    this.live.clear();
  }
}

/**
 * 실제 SessionPool을 감싸 **pid를 기록**한다.
 *
 * SessionInfo에는 pid가 없다(설계상 밖으로 내보내지 않는다). 그런데 이 단위의
 * 진짜 주장은 "프로세스가 죽는다"이므로 OS에 물어볼 열쇠가 필요하다.
 * 풀을 갈아 끼우는 대신 감싸기만 하므로 검증 대상은 그대로 실제 풀이다.
 */
class TracingPool implements SessionSource {
  readonly pids: number[] = [];
  #inner: SessionSource;

  constructor(inner: SessionSource) {
    this.#inner = inner;
  }

  async acquire(): Promise<SessionLike> {
    const s = await this.#inner.acquire();
    const pid = s.worker?.pid;
    if (typeof pid === 'number') this.pids.push(pid);
    return s;
  }

  release(session: SessionLike): Promise<void> {
    return this.#inner.release(session);
  }

  get stats(): PoolStats {
    return this.#inner.stats;
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}

async function main(): Promise<void> {
  console.log('\n=== 게이트웨이 서버 스모크 테스트 ===');

  // ── §1. 기동 → GET /api/health 200 ────────────────────
  // TASKS.json #4의 통과 기준이 이 섹션 하나다. 나머지 섹션은 하네스가
  // 이후 단위를 버틸 수 있는지를 본다.
  section('1. 기동과 /api/health (통과 기준)');
  await withServer(async (gw, addr) => {
    check(
      '서버 기동',
      gw.listening && addr.port > 0,
      `${addr.url} (host=${addr.host})`,
    );

    const health = await get(`${addr.url}/api/health`);
    check('GET /api/health → 200', health.status === 200, `status=${health.status}`);

    // 이후 단위가 이 응답을 liveness probe로 파싱한다. 형태가 JSON이고
    // status가 ok인지까지만 본다 — 나머지 필드는 값이 유동적이라 단언 대상이 아니다.
    check(
      'JSON 본문 { status: "ok" }',
      health.contentType.includes('application/json')
        && isRecord(health.body) && health.body['status'] === 'ok',
      `content-type=${health.contentType || '(없음)'}, body=${health.text.slice(0, 120)}`,
    );

    if (isRecord(health.body)) {
      note(
        'health 필드',
        `uptimeMs=${String(health.body['uptimeMs'])}, pid=${String(health.body['pid'])}, node=${String(health.body['node'])}`,
      );
    }
  });

  // ── §2. 수명 관리 ─────────────────────────────────────
  // 여기가 하네스의 핵심이다. #5~#10이 서버를 수십 번 띄웠다 닫는데,
  // close()가 새거나 재기동이 안 되면 그때 가서 원인을 찾기 어렵다.
  section('2. 수명 관리 (하네스가 6개 단위를 버티는가)');
  {
    const gw = createServer({ onLog: () => {} });

    // 기동 전 port/url은 0을 돌려주는 대신 던져야 한다.
    let threw = 0;
    for (const g of [() => gw.port, () => gw.url]) {
      try {
        g();
      } catch {
        threw++;
      }
    }
    check('기동 전 port/url이 throw', threw === 2, `${threw}/2`);
    check('기동 전 listening === false', gw.listening === false);

    try {
      const first = await gw.start();
      const again = await gw.start();
      check(
        'start() 멱등',
        first.port === again.port && first.url === again.url,
        `${first.port} → ${again.port}`,
      );

      await gw.close();
      check('close() 후 listening === false', gw.listening === false);

      const why = await expectRefused(`${first.url}/api/health`);
      check('close() 후 연결 거부', why !== null, why ?? '응답이 돌아왔다');

      // 중복 close가 던지면 finally 정리 코드가 전부 위험해진다.
      await gw.close();
      await gw.close();
      check('close() 중복 호출 안전', true);

      // 같은 인스턴스 재기동. #5 이후 테스트가 서버를 반복 교체한다.
      const second = await gw.start();
      const health = await get(`${second.url}/api/health`);
      check(
        '같은 인스턴스 재기동 → health 200',
        gw.listening && health.status === 200,
        `port ${first.port} → ${second.port}, status=${health.status}`,
      );
    } finally {
      await gw.close();
    }
  }

  // 섹션끼리 포트를 다투지 않아야 병렬 실행이나 섹션 추가가 안전하다.
  {
    const [a, b] = await Promise.all([
      withServer(async (_gw, addr) => addr.port),
      withServer(async (_gw, addr) => addr.port),
    ]);
    check('동시 인스턴스 2개가 서로 다른 포트', a !== b, `${a}, ${b}`);
  }

  // ── §3. 라우팅 계약 ───────────────────────────────────
  // 이후 단위가 얹을 라우트들이 따를 규약. 클라이언트가 파서를 하나만
  // 쓰게 하려면 실패 응답도 JSON이어야 한다.
  section('3. 라우팅 계약');
  await withServer(async (gw, addr) => {
    const nope = await get(`${addr.url}/api/nope`);
    check(
      '알 수 없는 경로 → 404 JSON',
      nope.status === 404 && isRecord(nope.body) && typeof nope.body['error'] === 'string',
      `status=${nope.status}, body=${nope.text.slice(0, 120)}`,
    );

    // app 게터로 나중에 붙인 라우트가 **도달하지 않는** 것은 회귀가 아니라
    // 확정된 계약이다(ISSUE-001 B안). catch-all은 생성자 안 제자리에 두고
    // 등록 지점을 그 앞에 만드는 쪽을 골랐으므로, 사후 등록 경로는 고쳐지지
    // 않는다. 진단(note)이었던 것을 테스트로 승격해 둔다 — 이게 계약으로
    // 박혀 있어야 다음 사람이 "왜 내 라우트가 404지"를 여기서 바로 읽는다.
    // 이 단언이 깨진다면 등록 순서가 바뀐 것이고, 그때는 §4의 등록 지점이
    // 여전히 유일한 길인지 다시 확인해야 한다.
    gw.app.get('/api/__late-registered', (_req, res) => {
      res.json({ late: true });
    });
    const late = await get(`${addr.url}/api/__late-registered`);
    check(
      'app 게터 사후 등록 → 404 (의도된 동작)',
      late.status === 404,
      `status=${late.status} — 200이면 등록 순서가 바뀐 것이다. 라우트는 GatewayOptions.routes나 #configure의 내장 목록으로 붙인다`,
    );
  });

  // ── §4. 라우트 등록 지점 (ISSUE-001) ──────────────────
  // §3이 "사후 등록은 안 된다"를 못 박았으니, 여기서는 "그럼 되는 길이
  // 실제로 되는가"를 본다. GatewayOptions.routes가 그 길이고, 하네스의
  // withServer(fn, opts)가 이미 opts를 통과시키므로 하네스 변경이 없다.
  section('4. 라우트 등록 지점 (routes 옵션)');

  // (1) 주입한 라우트가 도달하고, ctx가 약속한 것을 들고 온다.
  {
    const logs: string[] = [];
    let ctxSeen: RouteContext | null = null;

    const probeRoutes: RouteRegistrar = (app, ctx) => {
      ctxSeen = ctx;
      app.get('/api/__probe', (_req, res) => {
        ctx.log('probe 처리');
        res.json({ probe: true });
      });
      // 주입 라우트는 내장 뒤에 붙으므로 /api/health를 가로챌 수 없어야 한다.
      // 가로채진다면 후속 단위가 내장 라우트를 조용히 덮어쓸 수 있다는 뜻이다.
      app.get('/api/health', (_req, res) => {
        res.json({ status: 'hijacked' });
      });
    };

    await withServer(
      async (_gw, addr) => {
        const probe = await get(`${addr.url}/api/__probe`);
        check(
          'routes로 주입한 라우트 → 200',
          probe.status === 200 && isRecord(probe.body) && probe.body['probe'] === true,
          `status=${probe.status}, body=${probe.text.slice(0, 120)}`,
        );

        const nope = await get(`${addr.url}/api/nope`);
        check(
          '주입 후에도 없는 경로 → 404 JSON',
          nope.status === 404 && isRecord(nope.body) && typeof nope.body['error'] === 'string',
          `status=${nope.status}, body=${nope.text.slice(0, 120)}`,
        );

        const health = await get(`${addr.url}/api/health`);
        check(
          '주입 라우트가 내장 /api/health를 못 가로챈다',
          isRecord(health.body) && health.body['status'] === 'ok',
          `body=${health.text.slice(0, 120)}`,
        );

        check('ctx.log가 onLog로 나간다', logs.includes('probe 처리'), `logs=${logs.length}건`);

        const ctx = ctxSeen as RouteContext | null;
        check(
          'ctx.options가 생성자 옵션 그대로',
          ctx !== null && ctx.options.routes?.includes(probeRoutes) === true,
          ctx === null ? 'registrar가 호출되지 않았다' : 'routes 배열 동일성 확인',
        );
      },
      { onLog: (line) => logs.push(line), routes: [probeRoutes] },
    );
  }

  // (2) 등록 순서: 먼저 넘긴 registrar가 이긴다. #5 이후 라우트가 서로
  //     겹칠 때 어느 쪽이 잡히는지가 예측 가능해야 한다.
  {
    const first: RouteRegistrar = (app) => {
      app.get('/api/__order', (_req, res) => {
        res.json({ who: 'first' });
      });
    };
    const second: RouteRegistrar = (app) => {
      app.get('/api/__order', (_req, res) => {
        res.json({ who: 'second' });
      });
    };
    await withServer(
      async (_gw, addr) => {
        const r = await get(`${addr.url}/api/__order`);
        check(
          '먼저 넘긴 registrar가 이긴다',
          isRecord(r.body) && r.body['who'] === 'first',
          `body=${r.text.slice(0, 80)}`,
        );
      },
      { routes: [first, second] },
    );
  }

  // (3) prepare가 listen() **전에** 끝난다. 이게 뒤집히면 #5의 업로드
  //     디렉토리가 생기기 전에 요청이 핸들러에 닿는다 — 재현이 어려운
  //     레이스라 여기서 못 잡으면 운영에서 만난다.
  //     gw는 prepare가 불리는 시점(start() 안)에는 이미 할당돼 있다.
  {
    const observed: Array<{ gatewayListening: boolean; socketListening: boolean }> = [];
    const lifecycle: RouteRegistrar = (app) => {
      app.get('/api/__prepared', (_req, res) => {
        res.json({ prepares: observed.length });
      });
      return {
        prepare: async () => {
          await Promise.resolve();
          observed.push({
            gatewayListening: gw.listening,
            socketListening: gw.server.listening,
          });
        },
      };
    };
    const gw = createServer({ onLog: () => {}, routes: [lifecycle] });

    try {
      const addr = await gw.start();
      check(
        'prepare가 listen() 전에 불린다',
        observed.length === 1
          && observed[0]?.gatewayListening === false
          && observed[0]?.socketListening === false,
        `호출 ${observed.length}회, 첫 호출 시점 listening=${String(observed[0]?.gatewayListening)}/socket=${String(observed[0]?.socketListening)}`,
      );

      const prepared = await get(`${addr.url}/api/__prepared`);
      check(
        'prepare를 돌려준 registrar의 라우트도 도달',
        prepared.status === 200 && isRecord(prepared.body) && prepared.body['prepares'] === 1,
        `status=${prepared.status}, body=${prepared.text.slice(0, 80)}`,
      );

      // start()가 재기동될 수 있으므로 prepare는 매번 불린다(멱등 계약).
      await gw.close();
      const second = await gw.start();
      const again = await get(`${second.url}/api/__prepared`);
      check(
        '재기동 시 prepare가 다시 불린다',
        observed.length === 2 && isRecord(again.body) && again.body['prepares'] === 2,
        `호출 ${observed.length}회`,
      );
    } finally {
      await gw.close();
    }
  }

  // ── §5. 에러 상태코드 ─────────────────────────────────
  // 에러 핸들러가 무조건 500으로 덮으면 클라이언트는 "내 요청이 잘못됐다"와
  // "서버가 터졌다"를 구분할 수 없다. 깨진 JSON이 500이던 게 이번 수정의
  // 발단이므로, 400으로 돌아오는지가 회귀 방지의 핵심이다.
  section('5. 에러 상태코드');

  /** err에 심을 값 → 기대 status. undefined는 "필드 없음"과 같게 취급된다. */
  const statusCases: Array<{
    path: string;
    status?: unknown;
    statusCode?: unknown;
    expect: number;
    why: string;
  }> = [
    { path: 'teapot', status: 418, expect: 418, why: 'err.status를 존중' },
    { path: 'code-only', statusCode: 503, expect: 503, why: 'statusCode 폴백' },
    { path: 'status-wins', status: 418, statusCode: 503, expect: 418, why: 'status 우선' },
    { path: 'bad-status-good-code', status: 'nope', statusCode: 503, expect: 503, why: 'status 무효 → statusCode' },
    { path: 'both-bad', status: 'nope', statusCode: 99, expect: 500, why: '둘 다 신뢰 못 함' },
    { path: 'too-low', status: 399, expect: 500, why: '4xx 미만은 에러 상태가 아니다' },
    { path: 'ok-status', status: 200, expect: 500, why: '2xx로 에러를 보내면 클라이언트가 성공으로 읽는다' },
    { path: 'too-high', status: 600, expect: 500, why: 'res.status(600)은 던진다' },
    { path: 'fractional', status: 400.5, expect: 500, why: '정수가 아니다' },
    { path: 'nan', status: Number.NaN, expect: 500, why: 'NaN' },
    { path: 'numeric-string', status: '418', expect: 500, why: '문자열은 거부 (느슨한 변환 안 함)' },
    { path: 'null-status', status: null, statusCode: null, expect: 500, why: 'null' },
  ];

  {
    const logs: string[] = [];
    const errorRoutes: RouteRegistrar = (app) => {
      app.post('/api/__echo', (req, res) => {
        res.json({ got: req.body });
      });
      app.get('/api/__boom', () => {
        throw new Error('핸들러가 던짐');
      });
      app.get('/api/__async-boom', async () => {
        await Promise.resolve();
        throw new Error('비동기 핸들러가 던짐');
      });
      app.get('/api/__throw-string', () => {
        // Error가 아닌 것을 던지는 코드는 실제로 있다(문자열 reject 등).
        // errorStatus가 객체가 아닌 값에서 죽지 않아야 한다.
        throw '문자열을 던짐';
      });
      for (const c of statusCases) {
        app.get(`/api/__status/${c.path}`, () => {
          throw Object.assign(new Error(`상태 실험: ${c.path}`), {
            status: c.status,
            statusCode: c.statusCode,
          });
        });
      }
      app.get('/api/__late-throw', async (_req, res) => {
        // 헤더가 이미 나간 뒤의 에러. 상태를 다시 쓸 수 없으므로 핸들러는
        // next(err)로 넘겨야 하고, 그 경로에서 프로세스가 죽으면 안 된다.
        res.write('부분 응답');
        await Promise.resolve();
        throw new Error('늦게 던짐');
      });
    };

    await withServer(
      async (_gw, addr) => {
        // ① 깨진 JSON → 400. express.json()이 err.status=400을 붙여 던진다.
        const broken = await get(`${addr.url}/api/__echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"a":',
        });
        check(
          '깨진 JSON POST → 400 (500 회귀 방지)',
          broken.status === 400,
          `status=${broken.status}, body=${broken.text.slice(0, 120)}`,
        );
        check(
          '깨진 JSON 응답도 JSON',
          broken.contentType.includes('application/json')
            && isRecord(broken.body) && typeof broken.body['error'] === 'string',
          `content-type=${broken.contentType || '(없음)'}`,
        );

        // 바디 파서는 라우팅보다 앞이므로, 없는 경로라도 404가 아니라 400이다.
        const brokenNowhere = await get(`${addr.url}/api/__no-such-route`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{',
        });
        check(
          '없는 경로 + 깨진 JSON → 404가 아니라 400',
          brokenNowhere.status === 400,
          `status=${brokenNowhere.status}`,
        );

        // 멀쩡한 JSON은 그대로 통과해야 한다 — 400이 과잉 반응이 아님을 확인.
        const okBody = await get(`${addr.url}/api/__echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ a: 1 }),
        });
        check(
          '정상 JSON POST → 200',
          okBody.status === 200 && isRecord(okBody.body)
            && isRecord(okBody.body['got']) && okBody.body['got']['a'] === 1,
          `status=${okBody.status}, body=${okBody.text.slice(0, 80)}`,
        );

        // ② 라우트가 던진 일반 에러는 500. 404 catch-all에 잡히면 안 된다
        //    (에러 핸들러는 인자 4개짜리만이고, catch-all은 그 앞이다).
        const boom = await get(`${addr.url}/api/__boom`);
        check(
          '핸들러가 던진 에러 → 500',
          boom.status === 500 && isRecord(boom.body) && boom.body['error'] === '핸들러가 던짐',
          `status=${boom.status}, body=${boom.text.slice(0, 120)}`,
        );

        // express 5는 async 핸들러의 rejection도 에러 핸들러로 보낸다(4와 다름).
        const asyncBoom = await get(`${addr.url}/api/__async-boom`);
        check(
          'async 핸들러 rejection → 500',
          asyncBoom.status === 500,
          `status=${asyncBoom.status}, body=${asyncBoom.text.slice(0, 120)}`,
        );

        const thrown = await get(`${addr.url}/api/__throw-string`);
        check(
          'Error가 아닌 값을 던져도 500 JSON',
          thrown.status === 500 && isRecord(thrown.body) && thrown.body['error'] === '문자열을 던짐',
          `status=${thrown.status}, body=${thrown.text.slice(0, 120)}`,
        );

        // ③ status 값 검증표. 범위 밖 값을 그대로 res.status()에 넘기면
        //    Node가 RangeError를 던져 응답이 끊긴다 — 서버를 죽일 수 있는
        //    경로라 개별로 확인한다.
        for (const c of statusCases) {
          const r = await get(`${addr.url}/api/__status/${c.path}`);
          // 문자열에 따옴표를 씌우는 이유: String('418')과 String(418)이 같아서
          // "숫자 문자열은 거부한다"는 케이스가 라벨에서 구분되지 않는다.
          const show = (v: unknown): string =>
            v === undefined ? '없음' : typeof v === 'string' ? `'${v}'` : String(v);
          check(
            `status=${show(c.status)} statusCode=${show(c.statusCode)} → ${c.expect}`,
            r.status === c.expect && isRecord(r.body) && typeof r.body['error'] === 'string',
            `status=${r.status} (${c.why})`,
          );
        }

        // ④ 로그 레벨이 갈리는가. 4xx 몇 건에 진짜 장애가 묻히지 않게 하는 게
        //    이 분기의 목적이므로, 문자열 접두사를 계약으로 본다.
        check(
          '4xx는 [warn]으로 로그',
          logs.some((l) => l.startsWith('[warn] 400 ')),
          `logs=${logs.filter((l) => l.startsWith('[warn]')).length}건 warn`,
        );
        check(
          '5xx는 [error]로 로그',
          logs.some((l) => l.startsWith('[error] 500 ')),
          `logs=${logs.filter((l) => l.startsWith('[error]')).length}건 error`,
        );
        check(
          '418도 [warn] (4xx 판정이 500 하드코딩이 아니다)',
          logs.some((l) => l.startsWith('[warn] 418 ')),
          logs.find((l) => l.includes('418')) ?? '없음',
        );

        // ⑤ 헤더가 나간 뒤의 에러: 응답이 어떻게 끝나든 서버는 살아 있어야 한다.
        note(
          '아래 "Error: 늦게 던짐" 스택',
          'express 기본 핸들러가 stderr에 찍는 것 — 실패가 아니다',
        );
        try {
          await get(`${addr.url}/api/__late-throw`);
        } catch {
          // 소켓이 끊겨 fetch가 거부될 수 있다. 그 자체는 판정 대상이 아니다.
        }
        const alive = await get(`${addr.url}/api/health`);
        check(
          'headersSent 뒤 에러에도 서버 생존',
          alive.status === 200,
          `status=${alive.status}`,
        );
      },
      { onLog: (line) => logs.push(line), routes: [errorRoutes] },
    );
  }

  // ── §6. 씬 업로드 + 목록 (TASKS #5) ───────────────────
  // 통과 기준은 한 줄이다: "업로드 → 목록에 뜸 → 저장된 바이트가 원본과 일치".
  // 6-1이 그 한 줄이고, 나머지는 이 라우트가 **디스크에 쓰는 첫 라우트**라서
  // 붙인다 — 뚫리면 임의 파일 쓰기(6-3), 넘치면 디스크 고갈(6-5), 끊기면
  // 반쯤 쓰인 파일이 #6의 load로 넘어간다(6-6).
  section('6-1. 왕복 (통과 기준)');
  await withScenes(async (gw, addr, dir) => {
    const empty = await get(`${addr.url}/api/scenes`);
    check(
      '빈 저장소 → { scenes: [], count: 0 }',
      empty.status === 200 && scenesOf(empty).length === 0
        && isRecord(empty.body) && empty.body['count'] === 0,
      `status=${empty.status}, body=${empty.text.slice(0, 120)}`,
    );

    // 320KiB. 스트림 highWaterMark(64KiB)의 5배라 write가 여러 번 갈리고,
    // 청크 경계에서 바이트가 섞이면 해시가 깨진다.
    const payload = randomBytes(320 * 1024);
    const up = await upload(addr, 'sample.zls', payload);
    const scene = sceneOf(up);
    check(
      '업로드 → 201 + scene 레코드',
      up.status === 201 && scene !== null
        && scene['name'] === 'sample.zls' && scene['bytes'] === payload.length,
      `status=${up.status}, body=${up.text.slice(0, 160)}`,
    );

    const id = typeof scene?.['id'] === 'string' ? scene['id'] : '';
    check('id가 32자리 hex', /^[0-9a-f]{32}$/.test(id), `id=${id || '(없음)'}`);

    const rows = await listScenes(addr);
    check(
      '목록에 뜬다',
      rows.length === 1 && rows[0]?.['id'] === id && rows[0]?.['name'] === 'sample.zls',
      `${rows.length}건, ids=${rows.map((r) => String(r['id']).slice(0, 8)).join(',')}`,
    );

    // ★ 통과 기준의 핵심. 클라이언트 응답에 경로가 없으므로 pathOf로 얻는다.
    const stored = id ? await readFile(gw.scenes.pathOf(id)) : Buffer.alloc(0);
    check(
      '저장된 바이트가 원본과 일치 (sha256)',
      stored.length === payload.length && sha256(stored) === sha256(payload),
      `${stored.length}/${payload.length} 바이트, ${sha256(stored).slice(0, 16)} vs ${sha256(payload).slice(0, 16)}`,
    );

    // 응답이 서버 경로를 흘리면 #6의 "경로는 pathOf 한 곳에서만" 계약이 깨진다.
    check(
      '응답에 서버 경로가 없다',
      scene !== null
        && Object.keys(scene).sort().join(',') === 'bytes,id,name,uploadedAt'
        && !/[A-Za-z]:\\/.test(up.text),
      `키=${scene === null ? '(없음)' : Object.keys(scene).sort().join(',')}`,
    );

    check('성공 후 .part 잔해 없음', (await partFiles(dir)).length === 0, (await partFiles(dir)).join(',') || '없음');

    // 이름 충돌 개념이 없다 — 같은 이름 두 번은 서로 다른 씬 두 건이다.
    // #6이 id로만 씬을 가리키는 근거이므로 계약으로 박아 둔다.
    const dup = await upload(addr, 'sample.zls', randomBytes(1024));
    const dupId = String(sceneOf(dup)?.['id'] ?? '');
    const both = await listScenes(addr);
    check(
      '같은 이름 두 번 → 덮어쓰기 없이 두 건',
      dup.status === 201 && dupId !== '' && dupId !== id
        && both.length === 2 && both.some((r) => r['id'] === id) && both.some((r) => r['id'] === dupId),
      `${both.length}건, 첫 파일 ${(await readFile(gw.scenes.pathOf(id))).length} 바이트 유지`,
    );

    const times = both.map((r) => String(r['uploadedAt']));
    check(
      '목록이 uploadedAt 내림차순',
      times.every((t, i) => i === 0 || (times[i - 1] as string) >= t),
      times.join(' > '),
    );
  });

  // ── 6-2. 이름 처리 ────────────────────────────────────
  section('6-2. 이름 처리');
  await withScenes(async (_gw, addr) => {
    // 한글 이름은 macOS 클라이언트에서 NFD로 온다. 저장값과 표시값이
    // 갈리지 않으려면 서버가 한쪽으로 고정해야 한다(NFC).
    const nfc = '한글 씬.zls'.normalize('NFC');
    const r = await upload(addr, nfc.normalize('NFD'), randomBytes(64));
    check(
      'NFD로 보낸 한글 이름 → NFC로 저장',
      r.status === 201 && sceneOf(r)?.['name'] === nfc,
      `status=${r.status}, name=${JSON.stringify(sceneOf(r)?.['name'])}`,
    );

    const upper = await upload(addr, 'UPPER.ZLS', randomBytes(64));
    check(
      '확장자 대소문자 무시 (.ZLS 허용)',
      upper.status === 201 && sceneOf(upper)?.['name'] === 'UPPER.ZLS',
      `status=${upper.status}`,
    );
  });

  // ── 6-3. 이름 검증 = traversal 방어 ───────────────────
  // 뚫리면 임의 파일 쓰기다. 저장 경로가 서버 난수 id로만 만들어지므로
  // 구조적으로는 이미 막혀 있지만, 그 구조가 유지되는지를 결과로 확인한다.
  // Windows 특유의 벡터(백슬래시·드라이브 문자·UNC·ADS·예약 장치명)를
  // 일부러 넣어 둔다 — 리눅스에서 리팩터링하면 제일 먼저 사라질 것들이다.
  section('6-3. 이름 검증 / traversal');
  {
    const nameCases: Array<{ label: string; name?: string; expect: number }> = [
      { label: 'name 파라미터 없음', expect: 400 },
      { label: "빈 문자열 ''", name: '', expect: 400 },
      { label: '../../evil.zls (POSIX traversal)', name: '../../evil.zls', expect: 400 },
      { label: '..\\..\\evil.zls (Windows 백슬래시)', name: '..\\..\\evil.zls', expect: 400 },
      { label: 'C:\\Windows\\evil.zls (드라이브 문자)', name: 'C:\\Windows\\evil.zls', expect: 400 },
      { label: '\\\\server\\share\\evil.zls (UNC)', name: '\\\\server\\share\\evil.zls', expect: 400 },
      { label: 'evil.zls:hidden.zls (NTFS ADS)', name: 'evil.zls:hidden.zls', expect: 400 },
      { label: 'evil.zls::$DATA (ADS 원본 스트림)', name: 'evil.zls::$DATA', expect: 400 },
      { label: 'evil\\u0000.zls (널바이트 잘림)', name: 'evil\u0000.zls', expect: 400 },
      { label: 'evil\\r\\n.zls (헤더 인젝션)', name: 'evil\r\n.zls', expect: 400 },
      { label: '..', name: '..', expect: 400 },
      { label: '"a.zls " (후미 공백)', name: 'a.zls ', expect: 400 },
      { label: '"a.zls." (후미 점)', name: 'a.zls.', expect: 400 },
      { label: 'con.zls (예약 장치명)', name: 'con.zls', expect: 400 },
      { label: '.zls (확장자뿐)', name: '.zls', expect: 400 },
      { label: '129자 이름', name: `${'a'.repeat(125)}.zls`, expect: 400 },
      { label: 'evil.txt (확장자 불일치)', name: 'evil.txt', expect: 415 },
      { label: 'evil.zls.exe (이중 확장자)', name: 'evil.zls.exe', expect: 415 },
    ];

    await withScenes(async (_gw, addr, dir) => {
      const payload = randomBytes(2048);
      for (const c of nameCases) {
        const r = await upload(addr, c.name, payload);
        check(
          `${c.label} → ${c.expect}`,
          r.status === c.expect && isRecord(r.body) && typeof r.body['error'] === 'string',
          `status=${r.status}, body=${r.text.slice(0, 90)}`,
        );
      }

      check('거부 후 목록이 비어 있다', (await listScenes(addr)).length === 0);

      // 씬 디렉토리 위 두 단계까지 우리 것이다. 거기에 새 파일이 생겼다면
      // 이름이 어딘가에서 경로로 쓰였다는 뜻이다.
      const tree = await walk(rootOf(dir));
      check(
        '씬 디렉토리와 상위 두 단계에 산출물 0건',
        tree.join('|') === 'a/|a/b/|a/b/scenes/',
        `트리=${tree.join(' ') || '(빈 트리)'}`,
      );
    });
  }

  // ── 6-4. content-type ─────────────────────────────────
  // 전역 express.json({limit:'1mb'})이 요청 스트림을 먼저 먹으면 0바이트
  // 파일이 생긴다. 그 실패는 원인을 지목하지 못하므로 415로 먼저 끊는 게
  // 설계였고, 여기서 그 분기가 살아 있는지 본다.
  section('6-4. content-type과 빈 본문');
  await withScenes(async (_gw, addr, dir) => {
    const payload = randomBytes(2048);

    // application/json은 두 갈래로 갈린다. 전역 express.json({limit:'1mb'})이
    // 라우트보다 **앞**이라, 415 가드는 파서가 통과시킨 본문에만 닿는다.
    //
    //   (a) 본문이 유효한 JSON  → 파서 통과 → 핸들러의 415. 가드가 사는 경로다.
    //       여기가 진짜 위험한 케이스이기도 하다 — 파서가 스트림을 이미
    //       소진해서, 415가 없으면 0바이트 파일이 생긴다.
    //   (b) 본문이 파일 바이트  → 파서가 먼저 400으로 끊는다. 415에 닿지 않는다.
    //
    // (b)의 실제 status는 판정에 넣지 않는다(설계 문서의 표와 다르지만
    // 거절이라는 결과는 같다). 대신 "거절되고 파일이 안 생긴다"를 단언한다.
    const jsonBody = await upload(addr, 'a.zls', Buffer.from('{"a":1}'), {
      contentType: 'application/json',
    });
    check(
      'application/json + 유효 JSON → 415 (바디 파서 선점 방어)',
      jsonBody.status === 415,
      `status=${jsonBody.status}, body=${jsonBody.text.slice(0, 90)}`,
    );

    const asJson = await upload(addr, 'a.zls', payload, { contentType: 'application/json' });
    check(
      'application/json + 파일 바이트 → 거절 (파일 생성 없음)',
      asJson.status >= 400 && isRecord(asJson.body) && typeof asJson.body['error'] === 'string',
      `status=${asJson.status}, body=${asJson.text.slice(0, 90)}`,
    );
    note(
      'application/json + 파일 바이트의 실제 status',
      `${asJson.status} — 설계 문서 표는 415라고 적혀 있지만 express.json이 먼저 파싱에 실패한다. 415 가드는 이 경로에 닿지 않는다`,
    );

    const asMultipart = await upload(addr, 'a.zls', payload, {
      contentType: 'multipart/form-data; boundary=----x',
    });
    check('multipart/form-data → 415', asMultipart.status === 415, `status=${asMultipart.status}`);

    // json/multipart만 막는다는 게 설계다. 그 외는 통과해야 한다.
    const asOctetish = await upload(addr, 'a.zls', payload, { contentType: 'application/x-zls' });
    check('그 외 content-type은 허용', asOctetish.status === 201, `status=${asOctetish.status}`);

    const emptyBody = await upload(addr, 'empty.zls', new Uint8Array(0));
    check('빈 본문 → 400', emptyBody.status === 400, `status=${emptyBody.status}, body=${emptyBody.text.slice(0, 90)}`);

    check(
      '415·400 뒤 목록은 성공한 1건뿐',
      (await listScenes(addr)).length === 1 && (await partFiles(dir)).length === 0,
      `목록 ${(await listScenes(addr)).length}건, .part ${(await partFiles(dir)).length}건`,
    );
  });

  // ── 6-5. 상한 (413) ───────────────────────────────────
  // content-length는 클라이언트 주장이고 chunked에는 아예 없다. 두 경로가
  // 따로 막혀야 상한이 상한이 된다.
  section('6-5. 업로드 상한');
  await withScenes(async (_gw, addr, dir) => {
    const declared = await upload(addr, 'big.zls', randomBytes(8192));
    check(
      'content-length 초과 → 413',
      declared.status === 413 && isRecord(declared.body) && typeof declared.body['error'] === 'string',
      `status=${declared.status}, body=${declared.text.slice(0, 90)}`,
    );

    // content-length 없이(chunked) 보내면 선언값 검사를 우회한다.
    // 실제로 흘러간 양을 세는 카운터가 없으면 여기서 뚫린다.
    const chunked = await upload(addr, 'big.zls', Readable.from([randomBytes(4096), randomBytes(4096)]));
    check(
      'chunked 초과 → 413 (선언값 우회 방어)',
      chunked.status === 413,
      `status=${chunked.status}, body=${chunked.text.slice(0, 90)}`,
    );

    check(
      '413 뒤 .part 잔해 없음 + 목록 비어 있음',
      (await partFiles(dir)).length === 0 && (await listScenes(addr)).length === 0,
      `.part ${(await partFiles(dir)).join(',') || '없음'}, 목록 ${(await listScenes(addr)).length}건`,
    );

    // 413은 요청 거절이지 연결 장애가 아니다. 소켓을 망가뜨렸다면 다음
    // 요청이 ECONNRESET으로 죽는다 (undici는 기본적으로 연결을 재사용한다).
    const alive = await get(`${addr.url}/api/health`);
    check('413 뒤 다음 요청 정상', alive.status === 200, `status=${alive.status}`);

    const exact = await upload(addr, 'exact.zls', randomBytes(4096));
    check(
      '정확히 상한 → 201 (off-by-one 아님)',
      exact.status === 201 && sceneOf(exact)?.['bytes'] === 4096,
      `status=${exact.status}, bytes=${String(sceneOf(exact)?.['bytes'])}`,
    );
  }, { maxSceneBytes: 4096 });

  // ── 6-6. 부분 업로드 불변식 ───────────────────────────
  // 이 설계의 핵심 안전장치는 "목록에 보인다 ⇒ 본체가 완결돼 있다"다.
  // #6이 목록을 보고 워커에 load를 시키므로, 반쯤 쓰인 파일이 목록에 오르면
  // 엔진이 깨진 씬을 연다. 진행 중인 업로드를 실제로 붙잡아 두고 확인한다.
  section('6-6. 부분 업로드 불변식');
  {
    const logs: string[] = [];

    // (1) 업로드가 진행 중인 바로 그 순간: .part는 있고 목록은 비어 있다.
    //     .part에 바이트가 이미 들어 있다는 것 자체가 스트리밍의 증거다 —
    //     본문을 메모리에 모았다면 요청이 끝나기 전엔 디스크에 아무것도 없다.
    await withScenes(async (gw, addr, dir) => {
      const gate = deferred();
      const head = randomBytes(256 * 1024);
      const tail = randomBytes(64 * 1024);
      const pending = upload(addr, 'streamed.zls', stalledBody(head, tail, gate.promise));

      const partSize = await waitFor(async () => {
        const parts = await partFiles(dir);
        const first = parts[0];
        if (first === undefined) return null;
        const size = (await readFile(path.join(dir, first))).length;
        return size > 0 ? size : null;
      });
      check(
        '업로드 중 .part에 바이트가 쌓인다 (스트리밍)',
        partSize !== null && partSize > 0 && partSize <= head.length,
        partSize === null ? '.part가 나타나지 않았다' : `${partSize} 바이트 (본문 미완결 상태)`,
      );

      const midList = await listScenes(addr);
      check(
        '업로드 중에는 목록에 없다',
        midList.length === 0,
        `${midList.length}건 — 0이 아니면 반쯤 쓰인 씬이 #6의 load로 넘어간다`,
      );

      gate.open();
      const done = await pending;
      const id = String(sceneOf(done)?.['id'] ?? '');
      check('밸브를 열면 201로 완결', done.status === 201 && id !== '', `status=${done.status}`);

      const stored = id ? await readFile(gw.scenes.pathOf(id)) : Buffer.alloc(0);
      check(
        '완결 후 바이트가 head+tail과 일치',
        sha256(stored) === sha256(Buffer.concat([head, tail])),
        `${stored.length}/${head.length + tail.length} 바이트`,
      );
      check(
        '완결 후 .part 없음 + 목록 1건',
        (await partFiles(dir)).length === 0 && (await listScenes(addr)).length === 1,
        `.part ${(await partFiles(dir)).length}건`,
      );
    });

    // (2) 클라이언트가 중간에 끊은 경우. 대용량 업로드에서 흔한 일이라
    //     잔해가 남으면 디스크가 조용히 찬다.
    await withScenes(async (_gw, addr, dir) => {
      const ac = new AbortController();
      const gate = deferred();
      const pending = upload(
        addr,
        'aborted.zls',
        stalledBody(randomBytes(256 * 1024), randomBytes(1024), gate.promise),
        { signal: ac.signal },
      ).then(() => null, (err: unknown) => err);

      const appeared = await waitFor(async () => {
        const parts = await partFiles(dir);
        const first = parts[0];
        if (first === undefined) return null;
        return (await readFile(path.join(dir, first))).length > 0 ? first : null;
      });
      check('중단 전 .part가 존재', appeared !== null, appeared ?? '나타나지 않음');

      ac.abort();
      gate.open(); // 매달린 제너레이터를 풀어 준다 (스트림은 이미 파괴됐다)
      await pending;

      const cleaned = await waitFor(async () => ((await partFiles(dir)).length === 0 ? true : null));
      check('중단 후 .part 잔해 없음', cleaned === true, `남은 .part=${(await partFiles(dir)).join(',') || '없음'}`);
      check('중단 후 목록이 비어 있다', (await listScenes(addr)).length === 0);

      // 클라이언트가 끊은 걸 500으로 찍으면 진짜 장애가 그 로그에 묻힌다.
      const closed = await waitFor(async () =>
        logs.some((l) => l.startsWith('[warn] 499 ')) ? true : null, 2_000);
      check(
        '클라이언트 중단은 499 [warn] (500 아님)',
        closed === true,
        logs.filter((l) => l.startsWith('[warn]') || l.startsWith('[error]')).join(' / ') || '로그 없음',
      );

      const alive = await get(`${addr.url}/api/health`);
      check('중단 뒤 서버 생존', alive.status === 200, `status=${alive.status}`);
    }, { onLog: (line) => logs.push(line) });
  }

  // ── §7. WS 연결 = 세션 수명 (TASKS #6) ────────────────
  // 통과 기준: "연결 → stats.busy == 1 → 종료 → 0. maxTotal 초과 시 거부
  // 코드로 닫힘". 7-1이 그 한 줄을 **실제 워커 프로세스로** 확인하고,
  // 나머지는 그 등식이 깨지는 경로들을 가짜 풀로 결정적으로 재현한다.
  //
  // 세션 = 워커 프로세스 = 라이선스 인스턴스다. 그래서 누수는 버그가 아니라
  // 동접 상한을 깎아먹는 사건이고, 여기서 잡지 못하면 운영에서 만난다.

  section('7-1. 연결 수명 = 프로세스 수명 (실제 워커, 통과 기준)');
  const strayPids: number[] = [];
  {
    const before = await exeCount();
    // 실제 exe를 쓰는 유일한 섹션이다. 기동이 ~110ms라 케이스마다 띄우면
    // 스모크가 몇 배로 느려진다 — 그래서 여기서만 3개를 띄우고,
    // 정상 종료 / 급단절 / 게이트웨이 종료라는 서로 다른 세 경로에 하나씩 쓴다.
    //
    // 풀을 미리 만들어 팩토리가 그대로 돌려준다. createPool이 팩토리인 건
    // 재기동 때문인데, 이 섹션은 start()를 한 번만 하므로 안전하다.
    const traced = new TracingPool(new SessionPool({
      exePath: defaultWorkerExe(),
      idleTimeout: 0,   // 유휴 프로세스는 라이선스를 계속 문다
      maxTotal: 1,      // 상한 거절을 실제 풀로도 확인하기 위해 1
      onLog: () => {},
    }));

    await withServer(async (gw, addr) => {
      // ① 연결 → busy == 1, 그리고 **OS에 프로세스가 실제로 있다**
      const t0 = performance.now();
      const first = await connect(wsUrlOf(addr));
      const openMs = Math.round(performance.now() - t0);
      check(
        '연결 성립 (onopen = 세션 준비 완료)',
        first.ws !== null,
        first.ws ? `${openMs}ms` : `status=${String(first.status)}, error=${String(first.error)} — exe가 없으면 여기서 깨진다`,
      );
      check(
        'stats.busy == 1',
        gw.sessions.stats.busy === 1 && gw.sessions.stats.total === 1,
        JSON.stringify(gw.sessions.stats),
      );
      check(
        'connections도 1건 (stats와 어긋나면 새고 있다)',
        gw.sessions.connections.length === 1 && gw.sessions.connections[0]?.sceneId === null,
        `${gw.sessions.connections.length}건, id=${gw.sessions.connections[0]?.id ?? '(없음)'}`,
      );

      const pid1 = traced.pids[0];
      strayPids.push(...traced.pids);
      check(
        '워커 프로세스가 OS에 실제로 존재',
        pid1 !== undefined && await pidAlive(pid1),
        pid1 === undefined ? 'pid를 얻지 못했다' : `pid=${pid1}`,
      );

      // ② 상한 초과 → 거부. 실제 풀이므로 "워커를 안 띄운다"까지 확인된다.
      const t1 = performance.now();
      const over = await connect(wsUrlOf(addr));
      const refuseMs = Math.round(performance.now() - t1);
      check(
        'maxTotal 초과 → 503 + Retry-After (업그레이드 전 HTTP 거절)',
        over.ws === null && over.status === 503 && over.retryAfter === '5',
        `status=${String(over.status)}, retry-after=${String(over.retryAfter)}, ${refuseMs}ms, body=${over.body.slice(0, 80)}`,
      );
      check(
        '거절은 워커를 띄우지 않는다 (pid 추가 없음)',
        traced.pids.length === 1,
        `누적 pid ${traced.pids.length}개`,
      );
      check(
        '거절 뒤에도 기존 세션은 OPEN',
        first.ws?.readyState === WebSocket.OPEN && gw.sessions.stats.busy === 1,
        `readyState=${String(first.ws?.readyState)}, busy=${gw.sessions.stats.busy}`,
      );

      // ③ 정상 종료 → busy 0 **그리고 프로세스 소멸**
      first.ws?.close();
      const drained = await until(() => gw.sessions.stats.busy === 0);
      check(
        '연결 종료 → stats.busy == 0',
        drained && gw.sessions.connections.length === 0,
        `${JSON.stringify(gw.sessions.stats)}, connections=${gw.sessions.connections.length}건`,
      );
      const gone1 = pid1 !== undefined && await until(async () => !(await pidAlive(pid1)));
      check(
        '워커 프로세스도 함께 사라진다 (라이선스 인스턴스 반납)',
        gone1,
        pid1 === undefined ? 'pid 없음' : `pid=${pid1}`,
      );

      // ④ 급단절(terminate). close 프레임 없이 TCP가 끊기는 실제 상황이다 —
      //    브라우저 탭을 죽이거나 네트워크가 끊기면 이 경로로 온다.
      const second = await connect(wsUrlOf(addr));
      const pid2 = traced.pids[1];
      strayPids.push(...traced.pids.slice(1));
      check('두 번째 연결 성립 (상한이 반납으로 풀렸다)', second.ws !== null, `pid=${String(pid2)}`);
      second.ws?.terminate();
      const gone2 = pid2 !== undefined && await until(async () => !(await pidAlive(pid2)));
      check(
        '급단절(terminate)에도 프로세스가 회수된다',
        gone2 && gw.sessions.stats.busy === 0,
        `pid=${String(pid2)}, busy=${gw.sessions.stats.busy}`,
      );

      // ⑤ 게이트웨이 종료 중 살아 있는 연결 → 1001, 프로세스 소멸.
      //    close()가 반납까지 기다리지 않으면 여기서 exe가 남는다.
      const third = await connect(wsUrlOf(addr));
      const pid3 = traced.pids[2];
      strayPids.push(...traced.pids.slice(2));
      const bye = third.ws ? closedWith(third.ws) : Promise.resolve({ code: -1, reason: '' });
      const t2 = performance.now();
      await gw.close();
      const closeMs = Math.round(performance.now() - t2);
      const info = await withTimeout(bye, 3_000, { code: -1, reason: '' });
      check(
        'close() → 클라이언트가 1001 수신',
        info.code === CLOSE_SHUTDOWN,
        `code=${info.code} (기대 ${CLOSE_SHUTDOWN}), reason=${info.reason}, close ${closeMs}ms`,
      );
      const gone3 = pid3 !== undefined && await until(async () => !(await pidAlive(pid3)));
      check('close() 후 워커 프로세스 0개', gone3, `pid=${String(pid3)}`);
      check(
        'close() 후 stats 전부 0 + isOpen false',
        gw.sessions.stats.total === 0 && gw.sessions.isOpen === false,
        `${JSON.stringify(gw.sessions.stats)}, isOpen=${String(gw.sessions.isOpen)}`,
      );

      note('워커 pid', traced.pids.join(', ') || '없음');
    }, { sessions: { createPool: () => traced, heartbeatIntervalMs: 0 } });

    const after = await exeCount();
    note(
      '섹션 전후 exe 개수',
      `${before} → ${after} (판정 아님 — 다른 프로세스가 띄운 것도 세므로 pid로만 판정한다)`,
    );
  }

  // ── 7-2. 거절은 업그레이드 **전** HTTP 응답 ───────────
  // 이 설계의 값어치는 "열린 소켓에는 항상 살아 있는 세션이 있다"는 불변식이다.
  // 거절이 소켓을 연 뒤에 일어나면 #7·#8이 "세션 없는 연결" 상태를 다뤄야 한다.
  // 그러므로 각 거절이 (a) 상태코드로 끝나고 (b) **acquire 자체를 안 한다**는
  // 두 가지를 함께 본다. 프로세스를 안 띄우므로 가짜 풀로 충분하다.
  section('7-2. 핸드셰이크 거절 (업그레이드 전 HTTP)');
  {
    const fake = new FakePool({ maxTotal: 1 });
    await withScenes(async (gw, addr) => {
      const wrongPath = await connect(`${addr.url.replace(/^http/, 'ws')}/nope`);
      check(
        '경로가 /ws가 아님 → 404',
        wrongPath.ws === null && wrongPath.status === 404,
        `status=${String(wrongPath.status)}, body=${wrongPath.body.slice(0, 80)}`,
      );

      const badScene = await connect(wsUrlOf(addr, '?scene=not-a-hex-id'));
      check(
        '?scene= 형식 오류 → 400',
        badScene.ws === null && badScene.status === 400,
        `status=${String(badScene.status)}, body=${badScene.body.slice(0, 80)}`,
      );

      const missing = await connect(wsUrlOf(addr, `?scene=${'f'.repeat(32)}`));
      check(
        '?scene= 씬 없음 → 404',
        missing.ws === null && missing.status === 404,
        `status=${String(missing.status)}, body=${missing.body.slice(0, 80)}`,
      );

      check(
        '거절 3건이 세션을 하나도 잡지 않았다',
        fake.acquired === 0 && fake.stats.busy === 0,
        `acquired=${fake.acquired}, busy=${fake.stats.busy}`,
      );

      // 거절 본문은 REST와 같은 { error } JSON이어야 한다 — 클라이언트 파서가 하나다.
      let parsed = false;
      try {
        parsed = isRecord(JSON.parse(missing.body)) && typeof (JSON.parse(missing.body) as Record<string, unknown>)['error'] === 'string';
      } catch {
        parsed = false;
      }
      check('거절 본문이 { error } JSON', parsed, missing.body.slice(0, 80));

      // 유효한 씬 id는 통과하고, 이번 단위는 **로드하지 않는다** (#7의 일).
      const up = await upload(addr, 'ws.zls', randomBytes(2048));
      const id = String(sceneOf(up)?.['id'] ?? '');
      const withScene = await connect(wsUrlOf(addr, `?scene=${id}`));
      check(
        '유효한 ?scene= → 연결 성립 + sceneId 기록',
        withScene.ws !== null && gw.sessions.connections[0]?.sceneId === id,
        `status=${String(withScene.status)}, sceneId=${gw.sessions.connections[0]?.sceneId ?? '(없음)'}`,
      );

      // 상한이 1이므로 다음 연결은 503. 가짜 풀도 실제와 같은 예외 타입을 던진다.
      const over = await connect(wsUrlOf(addr));
      check(
        'maxTotal 초과 → 503 + Retry-After',
        over.ws === null && over.status === 503 && over.retryAfter === '5',
        `status=${String(over.status)}, retry-after=${String(over.retryAfter)}`,
      );

      withScene.ws?.close();
      check('거절 뒤 정리', await until(() => fake.stats.busy === 0), JSON.stringify(fake.stats));
    }, { sessions: { createPool: () => fake, heartbeatIntervalMs: 0 } });
  }

  // 워커 기동 실패 → 502. 실제 풀을 쓰되 엔진을 띄우지 않는다 —
  // node 자신을 `--serve`로 부르면 즉시 exit 9라 "기동 중 죽는 워커"가 된다.
  {
    await withServer(async (gw, addr) => {
      const r = await connect(wsUrlOf(addr));
      check(
        '워커가 기동 중 죽으면 → 502',
        r.ws === null && r.status === 502,
        `status=${String(r.status)}, body=${r.body.slice(0, 100)}`,
      );
      check('502 뒤 세션 누수 없음', gw.sessions.stats.total === 0, JSON.stringify(gw.sessions.stats));
    }, { sessions: { exePath: process.execPath, heartbeatIntervalMs: 0 } });
  }

  // 게이트웨이가 세션을 받을 수 없는 상태(종료 중)의 업그레이드.
  {
    const fake = new FakePool();
    await withServer(async (gw, addr) => {
      await gw.sessions.shutdown(); // HTTP는 살아 있고 세션만 닫힌 상태
      const r = await connect(wsUrlOf(addr));
      check(
        '세션이 닫힌 뒤 업그레이드 → 503',
        r.ws === null && r.status === 503 && r.retryAfter === '5',
        `status=${String(r.status)}, retry-after=${String(r.retryAfter)}`,
      );
      // 두 503은 문구로만 갈린다. 여기가 "업그레이드를 아예 안 받는" 쪽이다 —
      // 7-3의 "종료 중 취소"와 같은 문구가 되면 진단이 사라진다.
      check(
        '문구가 "받을 수 없는 상태" 쪽 (7-3의 종료 중 취소와 구분)',
        errorOf(r.body) === REFUSE_NOT_ACCEPTING
          && errorOf(r.body) !== REFUSE_SHUTTING_DOWN,
        errorOf(r.body) || r.body.slice(0, 80),
      );
      check('그 상태의 stats는 전부 0', gw.sessions.stats.total === 0 && !gw.sessions.isOpen);
      check('풀이 정확히 한 번 닫혔다', fake.closed === 1, `closed=${fake.closed}`);
    }, { sessions: { createPool: () => fake, heartbeatIntervalMs: 0 } });
  }

  // ── 7-2b. exe 경로가 아예 없을 때 (ISSUE-006 회귀) ────
  // 이 케이스는 원래 **테스트로 만들 수 없었다.** child_process는 spawn 실패를
  // 'exit'이 아니라 'error'로 알리는데, 그 리스너가 없으면 EventEmitter가
  // unhandled로 승격시켜 게이트웨이 = 스모크 프로세스를 통째로 죽였다.
  // 그래서 note로만 남아 있었다. sdk/worker.ts가 'error'를 받아 "세션 하나의
  // 실패"로 국한하면서 비로소 정식 케이스가 됐다.
  //
  // 위의 exit 9 케이스와 다른 점 두 가지를 함께 못 박는다:
  //   - 프로세스가 시작조차 못 했으므로 exit code가 **null**이다
  //   - 실패한 exe 경로는 502 본문이 아니라 **게이트웨이 로그**에 있다
  section('7-2b. exe 없음 → 502, 게이트웨이 생존 (ISSUE-006)');
  {
    const logs: string[] = [];
    // 랜덤 이름이라 우연히 존재할 수 없다. 디렉토리는 실제 워커와 같은 곳에
    // 두어 "경로는 맞고 파일만 없다"는 상황으로 좁힌다.
    const ghost = path.join(
      path.dirname(defaultWorkerExe()),
      `no-such-worker-${randomBytes(6).toString('hex')}.exe`,
    );

    await withServer(async (gw, addr) => {
      const r = await connect(wsUrlOf(addr));
      const msg = errorOf(r.body);

      check(
        '없는 exe로 연결 → 502 (크래시가 아니라 응답)',
        r.ws === null && r.status === 502,
        `status=${String(r.status)}, error=${String(r.error)}, body=${r.body.slice(0, 120)}`,
      );
      check(
        '502 본문이 { error } JSON + 기동 실패 문구',
        msg.startsWith('워커를 시작하지 못했습니다:'),
        msg || `(파싱 실패) ${r.body.slice(0, 80)}`,
      );
      // spawn 실패는 'exit'이 오지 않는다 — code가 숫자로 오면 어딘가에서
      // "정상 종료"로 오인하고 있다는 뜻이다.
      check(
        'exit code가 null (spawn 실패엔 exit이 없다)',
        msg.includes('code=null'),
        msg || '(본문 없음)',
      );
      check('502 뒤 세션 누수 없음', gw.sessions.stats.total === 0, JSON.stringify(gw.sessions.stats));

      // ★ 이 단위의 핵심. 예전엔 여기까지 오지도 못했다 — 프로세스가 이미
      //   죽어 있었다. **같은 pid**로 health가 200이어야 "게이트웨이가 그대로
      //   살아 있다"가 된다 (죽고 되살아난 게 아니다).
      const health = await get(`${addr.url}/api/health`);
      const hpid = isRecord(health.body) ? health.body['pid'] : undefined;
      check(
        '게이트웨이 프로세스 생존 — 같은 pid로 health 200',
        health.status === 200 && hpid === process.pid,
        `status=${health.status}, health.pid=${String(hpid)}, 스모크 pid=${process.pid}`,
      );

      // 같은 풀에 한 번 더. 실패가 풀에 상태를 남겼다면 두 번째는 다르게 깨진다.
      const again = await connect(wsUrlOf(addr));
      check(
        '두 번째 시도도 똑같이 502 (풀에 상태가 남지 않는다)',
        again.ws === null && again.status === 502 && errorOf(again.body).includes('code=null')
        && gw.sessions.stats.total === 0,
        `status=${String(again.status)}, stats=${JSON.stringify(gw.sessions.stats)}`,
      );
    }, { onLog: (l) => logs.push(l), sessions: { exePath: ghost, heartbeatIntervalMs: 0 } });

    // 502 본문에는 경로가 없다(세션 계층의 문구가 그대로 나간다). 그러면
    // "어느 exe가 없었는가"는 로그에만 남는데, 그게 없으면 운영에서 원인을
    // 영영 못 찾는다. 로그 쪽을 계약으로 잡아 둔다.
    check(
      '실패한 exe 경로가 게이트웨이 로그에 남는다',
      logs.some((l) => l.includes(ghost)),
      logs.filter((l) => l.includes('워커')).join(' / ').slice(0, 200) || '로그 없음',
    );

    // 그리고 그 다음이 진짜로 도는가. spawn 실패가 이 프로세스에 아무것도
    // 남기지 않았다는 것을 **실제 워커로** 확인한다 (§7-1과 같은 경로, 순서만 뒤).
    const traced = new TracingPool(new SessionPool({
      exePath: defaultWorkerExe(),
      idleTimeout: 0,
      onLog: () => {},
    }));
    await withServer(async (gw, addr) => {
      const ok = await connect(wsUrlOf(addr));
      strayPids.push(...traced.pids);
      check(
        '기동 실패 뒤에도 정상 exe로는 연결된다',
        ok.ws !== null && gw.sessions.stats.busy === 1,
        `status=${String(ok.status)}, error=${String(ok.error)}, `
        + `stats=${JSON.stringify(gw.sessions.stats)}, pid=${String(traced.pids[0])}`,
      );
      const reply = ok.ws ? await ask(ok.ws, { id: 1, op: 'ping' }) : null;
      check(
        '그 세션으로 왕복이 된다',
        reply?.['id'] === 1 && reply?.['ok'] === false,
        JSON.stringify(reply),
      );
      ok.ws?.close();
      check(
        '종료 → busy 0',
        await until(() => gw.sessions.stats.busy === 0),
        JSON.stringify(gw.sessions.stats),
      );
    }, { sessions: { createPool: () => traced, heartbeatIntervalMs: 0 } });
  }

  // 502로 가는 다른 갈래: PoolExhaustedError가 **아닌** 오류.
  {
    const fake = new FakePool({ boom: true });
    await withServer(async (gw, addr) => {
      const r = await connect(wsUrlOf(addr));
      check(
        '풀이 일반 오류를 던지면 → 502 (503과 구분)',
        r.ws === null && r.status === 502,
        `status=${String(r.status)}, body=${r.body.slice(0, 80)}`,
      );
      check('502 뒤 busy 0', gw.sessions.stats.busy === 0);
    }, { sessions: { createPool: () => fake, heartbeatIntervalMs: 0 } });
  }

  // ── 7-3. acquire 도중 단절 (110ms 창) ─────────────────
  // 여기가 이 단위에서 가장 값진 회귀 테스트다. 실제 워커는 이 창이 110ms라
  // 타이밍을 맞추기가 불안정하지만, 가짜 풀의 acquire를 게이트로 붙잡으면
  // 창을 **원하는 만큼** 열어둘 수 있다 — 시간이 아니라 순서로 재현한다.
  //
  // 이 그물이 없으면: (1) 주인 없는 워커가 라이선스를 문 채 남고,
  // (2) 연결 수명 Promise가 영원히 매달려 close()가 멈춘다.
  section('7-3. acquire 도중 단절 (110ms 창)');
  {
    // (1) 클라이언트가 핸드셰이크 도중 사라진다.
    const logs: string[] = [];
    const gate = deferred();
    const entered = deferred();
    const fake = new FakePool({ gate: gate.promise, onEnter: () => entered.open() });

    await withServer(async (gw, addr) => {
      const client = new WebSocket(wsUrlOf(addr));
      client.on('error', () => {}); // 중단 시 오는 오류를 삼킨다

      await withTimeout(entered.promise, 3_000, undefined);
      check(
        'acquire 진입 시점에는 아직 연결이 없다',
        gw.sessions.connections.length === 0,
        `connections=${gw.sessions.connections.length}건`,
      );

      client.terminate();                              // 소켓을 죽이고
      await new Promise((r) => setTimeout(r, 30));     // FIN이 서버에 닿게 둔 뒤
      gate.open();                                     // acquire를 완료시킨다

      const released = await until(() => fake.released === 1);
      check(
        '주인 없는 세션이 즉시 반납된다 (좀비 워커 방지)',
        released && fake.acquired === 1 && fake.stats.busy === 0,
        `acquired=${fake.acquired}, released=${fake.released}, busy=${fake.stats.busy}`,
      );
      check(
        '연결로 등록되지 않는다',
        await until(() => gw.sessions.connections.length === 0),
        `connections=${gw.sessions.connections.length}건`,
      );
      check(
        '취소 경로가 로그에 남는다',
        logs.some((l) => l.includes('세션 취소')),
        logs.filter((l) => l.includes('세션')).join(' / ') || '로그 없음',
      );
      note(
        '어느 그물이 잡았는가',
        logs.find((l) => l.includes('세션 취소')) ?? '(취소 로그 없음)',
      );
    }, { onLog: (l) => logs.push(l), sessions: { createPool: () => fake, heartbeatIntervalMs: 0 } });

    // (2) acquire 도중 **게이트웨이가** 닫힌다. close()가 진행 중인 획득을
    //     기다리지 않으면 아무도 모르는 프로세스가 남고, 반대로 잘못 기다리면
    //     close()가 영원히 안 끝난다. 둘 다 이 케이스가 잡는다.
    const gate2 = deferred();
    const entered2 = deferred();
    const fake2 = new FakePool({ gate: gate2.promise, onEnter: () => entered2.open() });
    const gw2 = createServer({
      onLog: () => {},
      sessions: { createPool: () => fake2, heartbeatIntervalMs: 0 },
    });
    // 업그레이드 소켓을 테스트도 붙잡아 둔다. 리스너를 하나 더 다는 것뿐이라
    // SessionManager의 처리에는 영향이 없다.
    //
    // 예전엔 이 참조가 **하네스 구조용**이었다 — 서버가 소켓을 버리고 return
    // 하던 시절엔 finally에서 파괴해야 뒤의 close()가 안 매달렸다. 이제는
    // 서버가 닫는 것이 계약이므로 용도가 뒤집힌다: "우리가 치울 게 없다"를
    // 단언하는 데 쓴다. finally의 destroy는 회귀 시 스모크가 30초 워치독으로
    // 죽는 대신 읽을 수 있는 실패로 끝나게 하는 안전망으로만 남긴다
    // (아래 단언이 먼저 깨지므로 결함을 가릴 수는 없다).
    let abandoned: Duplex | null = null;
    gw2.server.on('upgrade', (_req, socket) => {
      abandoned = socket as Duplex;
    });

    try {
      const addr2 = await gw2.start();
      // await 하지 않는다 — acquire가 게이트에 걸려 핸드셰이크가 진행 중이다.
      // 결말(503 본문·헤더)은 아래에서 받는다.
      const pending = connect(wsUrlOf(addr2));
      await withTimeout(entered2.promise, 3_000, undefined);

      const closing = gw2.close();                     // shutdown이 inflight를 기다린다
      await new Promise((r) => setTimeout(r, 30));
      check(
        'acquire가 안 끝났으면 close()도 안 끝난다',
        await withTimeout(closing.then(() => false), 100, true),
        '100ms 안에 끝나면 진행 중인 획득을 버린 것이다',
      );

      gate2.open();
      const t3 = performance.now();
      const finished = await withTimeout(closing.then(() => true), 2_000, false);
      const closeMs = Math.round(performance.now() - t3);
      check(
        'acquire 완료 → close()가 매달리지 않고 끝난다',
        finished,
        `${finished ? `${closeMs}ms, ` : ''}`
        + `acquired=${fake2.acquired}, released=${fake2.released}, closed=${fake2.closed}`
        + (finished ? '' : ' — 세션 정리(shutdown)는 끝났는데 close()가 안 풀린다'),
      );
      check(
        '그 사이 얻은 세션은 반납된다 (게이트웨이 종료 중)',
        fake2.acquired === 1 && fake2.released === 1 && fake2.stats.busy === 0,
        `acquired=${fake2.acquired}, released=${fake2.released}, busy=${fake2.stats.busy}`,
      );
      check('풀도 닫힌다', fake2.closed === 1, `closed=${fake2.closed}`);

      // 클라이언트도 매달리지 않는다. 여기가 "close()가 빨라졌다"와 별개로
      // 지켜야 할 절반이다 — 서버만 빨리 끝나고 클라이언트가 이유도 모른 채
      // 타임아웃까지 기다리면 고친 게 아니다.
      const outcome = await withTimeout(pending, 3_000, null);
      check(
        '그 클라이언트는 503 + Retry-After를 받는다 (매달리지 않는다)',
        outcome !== null && outcome.ws === null && outcome.status === 503 && outcome.retryAfter === '5',
        outcome === null
          ? '3초 안에 결말이 나지 않았다 — 소켓이 버려졌다는 뜻이다'
          : `status=${String(outcome.status)}, retry-after=${String(outcome.retryAfter)}, `
            + `ws=${outcome.ws === null ? 'null' : 'open'}, error=${String(outcome.error)}`,
      );
      check(
        '문구가 "종료 중" 쪽 (기동 전/종료 중 거절과 구분)',
        outcome !== null && errorOf(outcome.body) === REFUSE_SHUTTING_DOWN
          && errorOf(outcome.body) !== REFUSE_NOT_ACCEPTING,
        outcome === null ? '(결말 없음)' : errorOf(outcome.body) || outcome.body.slice(0, 80),
      );

      // 예전엔 이 소켓이 응답도 파괴도 없이 버려져 http.close()의 콜백이 영영
      // 오지 않았다(>4000ms 매달림). 이제 서버가 refuse()로 end() 하므로
      // **테스트가 치울 것이 없어야 한다.** 이 단언이 그 자리를 지킨다.
      const sock = abandoned as Duplex | null;
      check(
        '버려진 업그레이드 소켓이 없다 (서버가 응답하고 닫았다)',
        sock !== null && sock.writableEnded,
        sock === null
          ? '업그레이드 소켓을 잡지 못했다'
          : `writableEnded=${String(sock.writableEnded)}, destroyed=${String(sock.destroyed)}`,
      );

      if (!finished) {
        // 회귀했을 때 원인을 출력에 못 박는다. 종료 중 취소 분기(sessions.ts
        // #serve의 `this.#pool !== pool`)가 소켓에 응답도 파괴도 하지 않고
        // return 하면, node의 http 서버는 그 소켓을 계속 세므로 close()의
        // 콜백이 오지 않는다 — closeAllConnections()도 업그레이드된 소켓은
        // 못 건드린다. 겸사겸사 하네스도 구한다.
        sock?.destroy();
        const afterDestroy = await withTimeout(closing.then(() => true), 1_000, false);
        note(
          '버려진 업그레이드 소켓을 테스트가 파괴하면',
          afterDestroy
            ? 'close()가 곧바로 끝난다 — 원인은 응답 없이 버려진 그 소켓이다'
            : '그래도 안 끝난다 — 원인이 다른 데 있다',
        );
      }
      outcome?.ws?.close();
    } finally {
      (abandoned as Duplex | null)?.destroy();
      await gw2.close();
    }
  }

  // ── 7-4. 하트비트 ─────────────────────────────────────
  // WS는 죽은 TCP 연결을 조용히 유지한다(노트북 뚜껑, NAT 만료). 그 연결 하나가
  // 워커 = 라이선스 인스턴스 하나를 무기한 붙잡으므로, 회수되는지가 곧 검증이다.
  // 기본 30초를 40ms로 줄이면 시간이 아니라 주기 수로 확인할 수 있다.
  section('7-4. 하트비트 (죽은 연결 회수)');
  {
    const fake = new FakePool();
    await withServer(async (gw, addr) => {
      const r = await connect(wsUrlOf(addr), { autoPong: false }); // pong을 안 보낸다
      check('무응답 클라이언트도 일단 연결된다', r.ws !== null);
      const t0 = performance.now();
      const reaped = await until(() => fake.released === 1 && gw.sessions.stats.busy === 0, 3_000);
      check(
        'pong 없는 연결은 다음 주기에 회수된다',
        reaped,
        `${Math.round(performance.now() - t0)}ms, acquired=${fake.acquired}, released=${fake.released}`,
      );
    }, { sessions: { createPool: () => fake, heartbeatIntervalMs: 40 } });

    // 반대 방향. 정상 클라이언트를 끊어버리면 하트비트가 그냥 학살자가 된다.
    const fake2 = new FakePool();
    await withServer(async (gw, addr) => {
      const r = await connect(wsUrlOf(addr)); // ws 기본값은 자동 pong
      await new Promise((res) => setTimeout(res, 260)); // ~6주기
      check(
        '응답하는 연결은 여러 주기를 살아남는다',
        r.ws?.readyState === WebSocket.OPEN && gw.sessions.stats.busy === 1 && fake2.released === 0,
        `readyState=${String(r.ws?.readyState)}, busy=${gw.sessions.stats.busy}, released=${fake2.released}`,
      );
      r.ws?.close();
      check('그 뒤 정상 종료', await until(() => fake2.released === 1));
    }, { sessions: { createPool: () => fake2, heartbeatIntervalMs: 40 } });

    // 끌 수 있어야 한다. 끄면 무응답 클라이언트도 안 끊긴다.
    const fake3 = new FakePool();
    await withServer(async (gw, addr) => {
      const r = await connect(wsUrlOf(addr), { autoPong: false });
      await new Promise((res) => setTimeout(res, 200));
      check(
        'heartbeatIntervalMs: 0 → 하트비트 없음',
        r.ws?.readyState === WebSocket.OPEN && gw.sessions.stats.busy === 1,
        `readyState=${String(r.ws?.readyState)}, busy=${gw.sessions.stats.busy}`,
      );
      r.ws?.terminate();
    }, { sessions: { createPool: () => fake3, heartbeatIntervalMs: 0 } });
  }

  // ── 7-5. 메시지 (중계는 #7의 일) ──────────────────────
  // 지금 중계하지 않는 건 의도다. 하지만 무시하면 클라이언트가 영원히 기다리므로
  // **워커 프로토콜과 같은 모양**의 에러를 돌려준다. 형태가 지금 고정돼야
  // #7이 켜질 때 같은 자리에 성공 응답이 들어올 뿐 계약이 안 바뀐다.
  section('7-5. 메시지 응답 형태');
  {
    const fake = new FakePool();
    await withServer(async (gw, addr) => {
      const r = await connect(wsUrlOf(addr));
      const ws = r.ws;
      if (!ws) {
        check('연결 성립', false, '세션을 얻지 못했다');
        return;
      }

      const withId = await ask(ws, { id: 7, op: 'ping' });
      check(
        'op 요청 → { id, ok:false, error } (id를 그대로 되돌려준다)',
        withId?.['id'] === 7 && withId?.['ok'] === false && typeof withId?.['error'] === 'string',
        JSON.stringify(withId),
      );

      const noId = await ask(ws, { op: 'ping' });
      check(
        'id 없는 요청 → id 필드 없이 { ok:false, error }',
        noId?.['ok'] === false && !('id' in (noId ?? {})),
        JSON.stringify(noId),
      );

      const noOp = await ask(ws, { id: 8 });
      check(
        'op 누락 → op 필드가 없다는 오류',
        noOp?.['id'] === 8 && String(noOp?.['error']).includes('op'),
        JSON.stringify(noOp),
      );

      const bad = await ask(ws, null, { raw: '{not json' });
      check(
        '비 JSON → { ok:false, error }',
        bad?.['ok'] === false && String(bad?.['error']).includes('JSON'),
        JSON.stringify(bad),
      );

      const bin = await ask(ws, null, { binary: new Uint8Array([1, 2, 3]) });
      check(
        '바이너리 프레임 → 거절 응답',
        bin?.['ok'] === false && String(bin?.['error']).includes('바이너리'),
        JSON.stringify(bin),
      );

      check(
        '다섯 번 거절해도 연결과 세션은 유지된다',
        ws.readyState === WebSocket.OPEN && gw.sessions.stats.busy === 1 && fake.released === 0,
        `readyState=${ws.readyState}, busy=${gw.sessions.stats.busy}`,
      );

      ws.close();
      check('종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
    }, { sessions: { createPool: () => fake, heartbeatIntervalMs: 0 } });
  }

  // ── 7-6. 워커 자멸 → 4001 ─────────────────────────────
  // 워커가 스스로 죽으면 세션 상태는 복구 불가다. 연결을 살려두면 이후 op가
  // 전부 실패하므로, 끊어서 클라이언트가 재연결로 새 세션을 받게 해야 한다.
  section('7-6. 워커 자멸 → 4001');
  {
    const fake = new FakePool();
    await withServer(async (gw, addr) => {
      const r = await connect(wsUrlOf(addr));
      check('연결 성립', r.ws !== null && gw.sessions.stats.busy === 1);

      const [session] = [...fake.live];
      const bye = r.ws ? closedWith(r.ws) : Promise.resolve({ code: -1, reason: '' });
      session?.die(3);

      const info = await withTimeout(bye, 3_000, { code: -1, reason: '' });
      check(
        '워커가 죽으면 연결이 4001로 닫힌다',
        info.code === CLOSE_SESSION_LOST,
        `code=${info.code} (기대 ${CLOSE_SESSION_LOST}), reason=${info.reason}`,
      );
      check(
        '그 세션도 반납된다',
        await until(() => fake.released === 1 && gw.sessions.stats.busy === 0),
        `released=${fake.released}, busy=${gw.sessions.stats.busy}`,
      );
    }, { sessions: { createPool: () => fake, heartbeatIntervalMs: 0 } });
  }

  // ── 7-7. 좀비 최종 확인 ───────────────────────────────
  // 개수가 아니라 **우리가 만든 pid**로 판정한다. 다른 프로세스가 같은 exe를
  // 띄우고 있어도(SDK 스모크 병행 실행 등) 오탐이 나지 않는다.
  section('7-7. 좀비 프로세스');
  {
    const alive: number[] = [];
    for (const pid of [...new Set(strayPids)]) {
      if (await pidAlive(pid)) alive.push(pid);
    }
    check(
      '이 스모크가 띄운 워커가 하나도 남지 않았다',
      alive.length === 0,
      alive.length === 0 ? `확인한 pid ${new Set(strayPids).size}개 전부 종료` : `남은 pid=${alive.join(',')}`,
    );
    note('전체 exe 개수', `${await exeCount()}개 (다른 프로세스가 띄운 것 포함)`);
  }
}

// 진행 중 어딘가에서 멈추면(예: start()가 resolve 안 함) 여기서 끊는다.
// 정상 종료 시에는 clearTimeout으로 지우므로 자연 종료를 막지 않는다.
const guard = setTimeout(() => {
  console.error('\n스모크 테스트가 30초 안에 끝나지 않았습니다 — 강제 종료');
  process.exit(1);
}, 30_000);

main().then(
  () => {
    clearTimeout(guard);
    console.log(failures === 0 ? '\n전부 통과\n' : `\n${failures}건 실패\n`);
    process.exitCode = failures === 0 ? 0 : 1;

    // process.exit()로 끝내지 않는 이유: 프로세스가 스스로 끝나는지가
    // 곧 "close()가 이벤트 루프를 비웠는가"에 대한 테스트다. #5~#10에서
    // 소켓·워커·타이머가 새면 CI가 매달리는데, 그 회귀를 여기서 잡는다.
    // unref된 타이머는 루프가 이미 비었으면 발화하지 않는다.
    const watchdog = setTimeout(() => {
      console.error('경고: 테스트가 끝났는데 이벤트 루프가 비지 않았습니다 (소켓/타이머 누수)');
      process.exit(1);
    }, 3_000);
    watchdog.unref();
  },
  (err: unknown) => {
    clearTimeout(guard);
    console.error('\n스모크 테스트 중 예외:', err);
    process.exit(1);
  },
);
