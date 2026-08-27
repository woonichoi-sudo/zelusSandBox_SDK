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
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, type Duplex } from 'node:stream';
import { promisify } from 'node:util';

import { WebSocket } from 'ws';

import { decodeFloat32, PoolExhaustedError, SessionPool } from '../sdk/index.ts';
import type { MeshDataResult, Op } from '../sdk/protocol.ts';
import { allowedOps } from './bridge.ts';
import {
  createServer,
  defaultExportDir,
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
import { defaultTextureRoots, TextureStore } from './textures.ts';

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
 * ⚠️ **스모크가 개발자의 실제 산출물을 지우지 않게 하는 안전망** (#10).
 *
 * `exportDir`을 안 주면 게이트웨이는 `backend/data/exports`를 쓰고,
 * `ExportStore.prepare()`가 리스닝 직전에 **강제 청소를 한 번 돌린다.**
 * 즉 스모크를 한 번 돌리는 것만으로 수명이 지난 실제 산출물이 사라진다 —
 * 씬 디렉토리(`withSceneDir`)와 정확히 같은 이유로 격리가 필요하고,
 * 여기가 **모든** 섹션이 반드시 지나는 한 곳이라 여기서 막는다.
 *
 * `...opts`보다 **앞**에 두는 것이 요점이다. 기본값으로만 작동하므로
 * §10처럼 자기 디렉토리가 필요한 섹션은 그대로 덮어쓸 수 있다.
 */
const SMOKE_EXPORT_ROOT = mkdtempSync(path.join(tmpdir(), 'zelus-smoke-exports-'));

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
  const gw = createServer({ onLog: () => {}, exportDir: SMOKE_EXPORT_ROOT, ...opts });
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

/**
 * 임시 익스포트 디렉토리를 만들고 **반드시** 지운다 (#10).
 *
 * `SMOKE_EXPORT_ROOT`(안전망)와 별개로 이걸 두는 이유는 **셈**이다. §10은
 * "디렉토리에 파일이 몇 개 남았는가"로 정리 정책을 판정하는데, 다른 섹션이
 * 만든 산출물이 섞인 디렉토리에서는 그 수를 말할 수 없다.
 *
 * 한 단계 아래에 두는 것(`<root>/exports`)도 의도다 — 저장소가 없는
 * 디렉토리를 스스로 만드는지(`prepare`의 mkdir) 확인된다.
 */
async function withExportDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'zelus-smoke-exp-'));
  try {
    return await fn(path.join(root, 'exports'));
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/** 디렉토리 안의 파일 이름들 (정렬). 없으면 빈 배열 — 정리 정책 판정에 쓴다 */
async function filesIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/**
 * 익스포트 다운로드. 본문을 **바이트로** 받는다.
 *
 * `get()`이 `res.text()`를 쓰는 것과의 차이가 이 단위의 통과 기준 그 자체다 —
 * 9.7MB짜리 산출물을 문자열로 받으면 UTF-8 디코딩을 지나므로 "바이트가
 * 일치한다"를 말할 수 없다(비ASCII·잘못된 시퀀스가 대체문자로 바뀐다).
 */
async function download(url: string): Promise<{
  status: number;
  type: string;
  disposition: string;
  cache: string;
  bytes: Uint8Array;
  text: string;
}> {
  const res = await fetch(url);
  const buf = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    disposition: res.headers.get('content-disposition') ?? '',
    cache: res.headers.get('cache-control') ?? '',
    bytes: buf,
    // 진단·오류 본문용. 판정은 위의 bytes로 한다.
    text: buf.length <= 4096 ? Buffer.from(buf).toString('utf8') : '',
  };
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
 * 이벤트가 섞여 흐르는 소켓에서 응답을 **id로 상관시킨다** (#8).
 *
 * 위의 `ask()`는 `ws.once('message')`라 **시뮬레이션 중에는 쓸 수 없다.**
 * 구독 중이면 초당 약 80건(frame 40 + engineMessage 40)이 흐르므로 "다음
 * 메시지 한 건"이 내 응답일 확률이 사실상 0이다. 그래서 #8 섹션은 전부
 * 이 클래스를 쓴다 — 받은 것을 분류해 쌓아두고, 응답은 id로 골라 꺼낸다.
 *
 * ★ 분류 규칙이 곧 게이트웨이가 클라이언트에게 약속한 계약이다:
 *   **판별은 `'event' in msg` 하나뿐이다.** id 유무로 가르면 안 된다 —
 *   응답에도 id가 없는 경로가 셋 있다(JSON 파싱 실패 / `op` 누락 / 바이너리
 *   프레임 거부). 그 셋이 여기서 `events`로 잘못 분류되면 §7-14가 실패한다.
 *   즉 이 헬퍼는 도우미인 동시에 계약의 실행 가능한 명세다.
 */
class Inbox {
  /** `event` 필드를 가진 것 전부 (도착 순서) */
  readonly events: Array<Record<string, unknown>> = [];
  /** 응답인데 id가 없는 것. 위 세 경로가 여기로 온다 */
  readonly idless: Array<Record<string, unknown>> = [];

  #ws: WebSocket;
  #waiters = new Map<number, (r: Record<string, unknown>) => void>();
  #nextId = 1;

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let m: unknown;
      try {
        m = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (!isRecord(m)) return;
      if ('event' in m) {
        this.events.push(m);
        return;
      }
      const id = m['id'];
      if (typeof id !== 'number') {
        this.idless.push(m);
        return;
      }
      const w = this.#waiters.get(id);
      if (w) {
        this.#waiters.delete(id);
        w(m);
      }
    });
  }

  /** op 하나 왕복. 이벤트가 아무리 흘러도 **내 id의 응답만** 기다린다 */
  send(req: Record<string, unknown>, timeoutMs = 8_000): Promise<Record<string, unknown> | null> {
    const id = this.#nextId++;
    const got = new Promise<Record<string, unknown>>((resolve) => this.#waiters.set(id, resolve));
    this.#ws.send(JSON.stringify({ id, ...req }));
    return withTimeout<Record<string, unknown> | null>(got, timeoutMs, null);
  }

  /** 이름이 name인 이벤트만 */
  of(name: string): Array<Record<string, unknown>> {
    return this.events.filter((e) => e['event'] === name);
  }

  /** name 이벤트가 n건 모일 때까지 기다린다. 못 모으면 모인 만큼 돌려준다 */
  async collect(name: string, n: number, timeoutMs = 8_000): Promise<Array<Record<string, unknown>>> {
    await until(() => this.of(name).length >= n, timeoutMs);
    return this.of(name);
  }
}

/** 실제 sample.zls (107MB). SDK 스모크가 쓰는 그 파일이다 */
const SAMPLE_ZLS = path.resolve(
  import.meta.dirname, '..', '..', '..',
  'zelusSandBox_Cobalt', 'Zest', 'testing', 'sdk', 'sample.zls',
);

/**
 * 씬을 **디스크에 직접 심는다** (HTTP 업로드를 타지 않는다).
 *
 * 업로드 경로는 §6이 전수로 덮었고, #8이 필요로 하는 건 그게 아니라
 * **엔진이 실제로 시뮬레이션할 수 있는 씬**이다. 다른 §7 섹션들이 올리는
 * `'not a real zls'` 14바이트로는 frame 이벤트가 한 건도 나오지 않는다.
 * 107MB를 fetch로 흘리면 이 섹션이 통째로 그 비용이 되므로 복사로 끝낸다
 * (실측 31ms — 캐시가 식어도 600ms).
 *
 * ⚠️ **원본은 읽기만 한다.** 회사 저장소(zelusSandBox_Cobalt)는 읽기 전용이다.
 */
async function plantScene(store: { dir: string; pathOf(id: string): string }): Promise<string> {
  const id = randomBytes(16).toString('hex');
  await mkdir(store.dir, { recursive: true });
  await copyFile(SAMPLE_ZLS, store.pathOf(id));
  const record = {
    id,
    name: 'sample.zls',
    bytes: statSync(SAMPLE_ZLS).size,
    uploadedAt: new Date().toISOString(),
  };
  await writeFile(path.join(store.dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return id;
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

/**
 * 워커 자리에 앉아 `(op, payload)`를 **기록**하는 중계 창구 (#7).
 *
 * 실제 워커로는 응답만 보인다. 그런데 이 단위가 지키려는 주장은 응답이 아니라
 * **"클라이언트가 보낸 필드가 워커에 닿지 않는다"**이고, 그건 응답만 봐서는
 * 확인할 수 없다 — 워커가 모르는 필드를 무시했을 뿐일 수도 있다. 여기서는
 * request()가 실제로 받은 객체를 그대로 붙잡으므로 bridge.ts의 ①(payload는
 * 항상 새로 조립한다)을 눈으로 확인할 수 있다.
 *
 * 응답을 붙잡아 두는 `hold`도 실제 워커로는 못 만든다. 동시 요청 상한과
 * id 중복은 "응답이 아직 안 온 상태"가 있어야 재현되는데, 실제 워커는
 * ping에 1ms 안에 답한다 — 시간이 아니라 **순서**로 재현해야 한다.
 */
class Relay {
  readonly calls: Array<{ op: string; payload: Record<string, unknown> | undefined }> = [];

  /** true면 응답을 붙잡아 둔다. releaseAll()로 한꺼번에 푼다 */
  hold = false;

  /** 워커 응답. 기본은 어떤 op이 왔는지 되돌려주는 표식 */
  respond: (op: string, payload: Record<string, unknown> | undefined) => unknown =
    (op) => ({ echoed: op });

  /** null이 아니면 그 오류로 거부한다 (워커가 실패를 돌려주는 경로) */
  fail: (op: string, payload: Record<string, unknown> | undefined) => Error | null = () => null;

  #held: Array<() => void> = [];

  handle(op: string, payload?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ op, payload });
    const settle = (): Promise<unknown> => {
      const err = this.fail(op, payload);
      return err ? Promise.reject(err) : Promise.resolve(this.respond(op, payload));
    };
    if (!this.hold) return settle();
    return new Promise<unknown>((resolve, reject) => {
      this.#held.push(() => void settle().then(resolve, reject));
    });
  }

  /** 붙잡아 둔 응답을 전부 내보낸다 */
  releaseAll(): void {
    const held = this.#held;
    this.#held = [];
    for (const f of held) f();
  }

  /** 워커에 닿은 op을 순서대로. 순서 보장 테스트가 읽는 값이다 */
  get ops(): string[] {
    return this.calls.map((c) => c.op);
  }

  last(): { op: string; payload: Record<string, unknown> | undefined } | undefined {
    return this.calls[this.calls.length - 1];
  }

  reset(): void {
    this.calls.length = 0;
  }
}

/**
 * 클라이언트가 받은 텍스트에 **서버 경로**의 흔적이 있는가 (#7 ②).
 *
 * 문자열 하나만 비교하지 않는 이유가 셋이다:
 *   - JSON 안에서는 `\`가 `\\`로 이스케이프된다 — 원문 비교가 그냥 빗나간다.
 *   - 예외 메시지가 `/`로 되돌려주는 경우가 있다 (bridge.ts의 redact 주석).
 *   - 씬 디렉토리가 아닌 **다른** 서버 경로가 새는 경우를 그물이 놓친다.
 *     그래서 드라이브 문자(`C:\`)를 마지막 그물로 둔다 — 이 단위의 응답에
 *     드라이브 문자가 나올 정당한 이유가 하나도 없다.
 */
function leaksPath(text: string, dir: string): boolean {
  const flat = text.replace(/\\\\/g, '\\').toLowerCase();
  const d = dir.toLowerCase();
  return flat.includes(d) || flat.includes(d.replace(/\\/g, '/')) || /[a-z]:[\\/]/.test(flat);
}

/** 프로세스를 안 띄우는 세션. SessionLike가 요구하는 표면이 이게 전부다 */
class FakeSession extends EventEmitter implements SessionLike {
  alive = true;
  readonly worker: {
    readonly pid?: number | undefined;
    request?(op: Op, payload?: Record<string, unknown>): Promise<unknown>;
  };

  /**
   * relay가 없으면 `worker.request`도 없다 — 브리지가 target=null로 보는
   * "중계를 지원하지 않는 세션"이 된다.
   *
   * **기본을 relay 없음으로 둔 이유**: 그 갈래는 bridge.ts에 살아 있는 코드라
   * (SessionLike.request가 옵셔널인 한 계속 살아 있다) 덮는 테스트가 하나는
   * 있어야 하고, 그게 §7-5다. relay를 기본으로 켜면 그 갈래가 통째로
   * 무검증이 된다. 중계 성공 경로는 §7-9~7-11이 relay를 켜서 본다.
   */
  constructor(relay?: Relay) {
    super();
    this.worker = relay
      ? { pid: 0, request: (op, payload) => relay.handle(op, payload) }
      : { pid: 0 };
  }

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
  /** 지정하면 세션이 `worker.request`를 갖는다 (#7 중계 경로) */
  relay?: Relay;
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
    const s = new FakeSession(this.#o.relay);
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
 * **같은 세션 하나를 계속 돌려주는** 풀 (#8).
 *
 * FakePool은 acquire마다 새 FakeSession을 만들고 release에서 죽인다 —
 * 즉 `idleTimeout: 0`(기본값)의 세계다. 그런데 #8의 리스너 누수가 실제로
 * 피해를 내는 건 **`idleTimeout > 0`이라 세션이 재사용될 때**다: 이전 연결의
 * 리스너가 세션에 남아 있으면 다음 연결의 프레임이 이미 닫힌 소켓의 conn으로
 * 계속 들어오고, 리스너가 연결 수만큼 쌓인다.
 *
 * 그 세계를 재현하는 게 이 풀이다. 세션이 EventEmitter이므로 **`emit`을 직접
 * 불러** 워커 없이 게이트웨이 경로 전체(#relayEvents → bridge → #emit → 소켓)를
 * 결정적으로 검증할 수 있고, `listenerCount`로 누수를 **직접** 읽을 수 있다.
 */
class ReusingPool implements SessionSource {
  readonly session: FakeSession;
  acquired = 0;
  released = 0;
  #busy = 0;

  constructor(relay?: Relay) {
    this.session = new FakeSession(relay);
  }

  async acquire(): Promise<SessionLike> {
    this.acquired++;
    this.#busy++;
    return this.session;
  }

  async release(_session: SessionLike): Promise<void> {
    // 실제 풀의 release는 pause+clear까지만 하고 **프로세스를 살려둔다**.
    // 세션 객체도 리스너도 그대로 남는다 — 그게 여기서 재현하려는 상태다.
    this.released++;
    this.#busy = Math.max(0, this.#busy - 1);
  }

  get stats(): PoolStats {
    return { idle: this.#busy > 0 ? 0 : 1, busy: this.#busy, total: 1 };
  }

  async close(): Promise<void> {
    this.session.alive = false;
  }
}

/**
 * `on()`이 **없는** 세션 (#8).
 *
 * SessionLike.on은 옵셔널이다 — 그래야 exe 없이 도는 세션들이 이벤트 표면을
 * 흉내 내지 않아도 된다(sessions.ts 주석). 그런데 FakeSession은 EventEmitter를
 * 상속하므로 `on`을 **항상 갖는다.** 즉 `#relayEvents`의 `if (!session.on)
 * return;` 갈래는 기존 스모크에서 한 번도 실행되지 않는다.
 *
 * EventEmitter가 아닌 세션을 하나 두어 그 갈래를 덮는다. 주장은 두 가지다:
 * 게이트웨이가 터지지 않는다는 것과, **op 중계는 그대로 돈다**는 것 —
 * 이벤트를 못 내는 것이 세션 전체를 못 쓰게 만들면 안 된다.
 */
class NoEventSession implements SessionLike {
  alive = true;
  readonly worker: {
    readonly pid?: number | undefined;
    request?(op: Op, payload?: Record<string, unknown>): Promise<unknown>;
  };

  /** off로 뗀 이벤트 이름. frame/engineMessage가 여기 오면 안 된다 (달지도 않았으므로) */
  readonly offCalls: string[] = [];

  #exit: Array<(code: number | null) => void> = [];

  constructor(relay?: Relay) {
    this.worker = relay
      ? { pid: 0, request: (op, payload) => relay.handle(op, payload) }
      : { pid: 0 };
  }

  once(_event: 'exit', listener: (code: number | null) => void): unknown {
    this.#exit.push(listener);
    return this;
  }

  off(event: 'exit', listener: (code: number | null) => void): unknown;
  off(event: 'frame', listener: (frame: number, mesh?: MeshDataResult) => void): unknown;
  off(event: 'engineMessage', listener: (message: string) => void): unknown;
  off(event: string, _listener: unknown): unknown {
    this.offCalls.push(event);
    return this;
  }
}

/** NoEventSession을 내주는 풀 */
class NoEventPool implements SessionSource {
  readonly sessions: NoEventSession[] = [];
  #relay: Relay | undefined;
  #busy = 0;

  constructor(relay?: Relay) {
    this.#relay = relay;
  }

  async acquire(): Promise<SessionLike> {
    const s = new NoEventSession(this.#relay);
    this.sessions.push(s);
    this.#busy++;
    return s;
  }

  async release(_session: SessionLike): Promise<void> {
    this.#busy = Math.max(0, this.#busy - 1);
  }

  get stats(): PoolStats {
    return { idle: 0, busy: this.#busy, total: this.#busy };
  }

  async close(): Promise<void> {
    for (const s of this.sessions) s.alive = false;
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

/**
 * 실측 크기(약 48KB)의 가짜 프레임 메시 (#9).
 *
 * 크기가 이 테스트의 **재현 장치**다. `{event:"frame",frame:1}` 같은 30바이트
 * 프레임을 아무리 몰아쳐도 소켓 쓰기가 동기로 끝나 `ws.bufferedAmount`가
 * 0에서 안 올라간다 — 임계값을 0으로 낮춰도 흐름 제어가 발화하지 않는다.
 * 구독 중 실제 프레임이 47.8KB라는 실측치를 그대로 흉내 내면, 버스트 하나가
 * Node의 쓰기 큐에 남아 버퍼가 실제로 찬다.
 *
 * 내용은 게이트웨이가 들여다보지 않으므로(중계는 mesh를 손대지 않는다,
 * §7-12) 채우는 문자가 무엇인지는 상관없다. 길이만 맞춘다.
 */
function bulkyMesh(bytes = 48 * 1024): MeshDataResult {
  const positions = 'A'.repeat(Math.max(4, Math.floor(bytes / 4) * 4));
  return {
    patterns: [{ uuid: 'bulk', vertices: 0, triangles: 0, positionStride: 12, positions }],
    topology: false,
  };
}

/**
 * 가짜 릴레이에게 **파일까지 쓰게** 만든다 (#10).
 *
 * export는 이 프로토콜에서 워커가 디스크를 건드리는 유일한 op이고, 게이트웨이
 * 쪽 정리 정책(상한·폐기·TTL)은 전부 "그 파일이 실제로 있다"를 전제로 돈다.
 * 기본 릴레이처럼 `{echoed:'export'}`만 돌려주면 `ExportStore.commit`의 stat이
 * 실패해 **차단된 것과 구별되지 않는 ok:false**가 나온다 — 정책을 볼 수가 없다.
 *
 * 그래서 여기서 워커의 두 가지 행동만 흉내 낸다: 준 경로에 쓰고,
 * `{path, format}`을 돌려준다(protocol.cpp:602,607). 실제 워커를 쓰지 않는
 * 이유는 비용이다 — sample.zls 익스포트 한 건이 1.5초·9.7MB고, 상한·폐기·
 * 형식별 동작을 실제 산출물로 확인하면 이 섹션 하나가 스모크 전체보다 길어진다.
 * **"진짜 바이트가 진짜로 오간다"는 §10-1이 실제 워커로 한 번 세운다.**
 *
 * `body`가 빈 문자열이면 0바이트 파일이 되고, `null`이면 아예 쓰지 않는다 —
 * 워커가 "썼다"고 답하고 안 쓴 경우(protocol.cpp:606이 반환값을 안 본다)를
 * 그대로 재현한다.
 */
function exportingRelay(relay: Relay, body: string | null = '{"asset":{"version":"2.0"}}\n'): void {
  relay.respond = (op, payload) => {
    const p = payload?.['path'];
    if (op !== 'export' || typeof p !== 'string') return { echoed: op };
    if (body !== null) writeFileSync(p, body);
    return { path: p, format: payload?.['format'] };
  };
}

/** 도착한 frame 이벤트의 번호만, 도착 순서대로 */
function frameNos(inbox: Inbox): number[] {
  return inbox.of('frame').map((e) => Number(e['frame']));
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
      // #7 이전에는 중계가 없어 ok:false(거절)가 왕복의 증거였다. 이제 중계가
      // 있으므로 **성공 응답**이 더 강한 확인이다 — 소켓이 열렸다는 것뿐 아니라
      // 요청이 실제로 워커까지 갔다 왔다는 뜻이 된다.
      const reply = ok.ws ? await ask(ok.ws, { id: 1, op: 'ping' }) : null;
      check(
        '그 세션으로 왕복이 된다',
        reply?.['id'] === 1 && reply?.['ok'] === true
        && isRecord(reply['result']) && reply['result']['pong'] === true,
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

  // ── 7-8. op 중계 (실제 워커) ──────────────────────────
  // TASKS.json #7의 통과 기준 두 줄이 여기 있다: ping 왕복, quit 거부 + 세션 생존.
  //
  // **실제 워커를 쓰는 이유**는 가짜로는 답할 수 없는 질문이 둘이기 때문이다:
  //   (1) 요청이 정말 워커 프로세스까지 갔다 오는가 (가짜는 자기가 답한다)
  //   (2) 워커가 `{ loaded, path }`로 되돌려주는 **서버 절대경로**가 실제로
  //       막히는가. 가짜에게 경로를 돌려주게 시킬 수는 있지만, 그 경로가
  //       진짜 워커가 만드는 것과 같다는 보장은 사람이 하는 것이다.
  //
  // 진짜 .zls는 103MB짜리 하나뿐이라 스모크에 넣을 수 없다(매 실행 103MB
  // 업로드 + 임시 디스크). 다행히 ZestManager::LoadZls는 **아무 바이트나 받아
  // true를 돌려준다** — 14바이트짜리 "not a real zls"로도 status.loaded가
  // true가 된다(직접 확인). 이 섹션이 지키는 것은 시뮬레이션이 아니라
  // **경로가 밖으로 나가는가**이므로 그걸로 충분하다.
  //
  // ⚠ 이 섹션은 그 엔진 동작에 얹혀 있다. 언젠가 워커가 zls 형식을 검증하게
  //   되면 여기 load 단언들이 "zls 로드 실패"로 깨진다 — 브리지가 회귀한 게
  //   아니라 전제가 바뀐 것이다. 그때는 작은 진짜 .zls를 픽스처로 넣을 것.
  section('7-8. op 중계 (실제 워커, 통과 기준)');
  {
    const traced = new TracingPool(new SessionPool({
      exePath: defaultWorkerExe(),
      idleTimeout: 0,
      maxTotal: 1,
      onLog: () => {},
    }));

    await withScenes(async (gw, addr) => {
      const up = await upload(addr, 'tiny.zls', new TextEncoder().encode('not a real zls'));
      const sceneId = String(sceneOf(up)?.['id'] ?? '');
      check('중계용 씬 업로드', /^[0-9a-f]{32}$/.test(sceneId), sceneId || JSON.stringify(up.body));

      const r = await connect(wsUrlOf(addr));
      const ws = r.ws;
      strayPids.push(...traced.pids);
      if (!ws) {
        check('연결 성립', false, `status=${String(r.status)}, error=${String(r.error)}`);
        return;
      }
      const pid = traced.pids[0];
      const dir = gw.scenes.dir;

      // ① 통과 기준 1 — ping 왕복
      const pong = await ask(ws, { id: 1, op: 'ping' });
      check(
        'ping 왕복 → { id, ok:true, result.pong } (통과 기준)',
        pong?.['id'] === 1 && pong['ok'] === true
        && isRecord(pong['result']) && pong['result']['pong'] === true,
        JSON.stringify(pong),
      );

      // ② 통과 기준 2 — quit 거부 + 세션 생존.
      //    "살아 있다"를 세 겹으로 본다: 소켓 / 게이트웨이 장부 / OS 프로세스.
      //    앞의 둘만 보면 워커가 죽고 게이트웨이만 모르는 경우를 놓친다.
      const q = await ask(ws, { id: 2, op: 'quit' });
      check(
        'quit 거부 → { id, ok:false, error } (통과 기준)',
        q?.['id'] === 2 && q['ok'] === false && String(q['error']).includes('quit'),
        JSON.stringify(q),
      );
      check(
        'quit 뒤에도 소켓·세션·워커 프로세스가 전부 살아 있다 (통과 기준)',
        ws.readyState === WebSocket.OPEN
        && gw.sessions.stats.busy === 1
        && pid !== undefined && await pidAlive(pid),
        `readyState=${ws.readyState}, busy=${gw.sessions.stats.busy}, pid=${String(pid)}`,
      );
      // 그리고 워커가 **손상되지 않았다**. 프로세스가 살아 있는 것과 아직
      // 요청을 처리하는 것은 다른 얘기다.
      const pong2 = await ask(ws, { id: 3, op: 'ping' });
      check(
        '거부는 워커에 닿지도 않았다 — 이어서 ping이 그대로 돈다',
        pong2?.['ok'] === true,
        JSON.stringify(pong2),
      );

      // ③ export는 #10에서 **열렸다.** 그래도 임의 위치 쓰기는 여전히 막힌다 —
      //    막는 이유만 "아직 안 열렸다"에서 "열렸지만 경로는 서버가 정한다"로
      //    바뀌었다(bridge.buildExport). 이 단언을 지우면 그 방어가 무방비가
      //    되므로, 형태를 바꿔 다시 세운다: 거부되고, 산출물이 하나도 안 생긴다.
      const expDirBefore = await filesIn(gw.exports.dir);
      const ex = await ask(ws, { id: 4, op: 'export', path: 'C:\\Windows\\evil.gltf' });
      check(
        'export{path} 거부 — 열린 뒤에도 임의 위치 파일 쓰기는 막힌다',
        ex?.['ok'] === false && String(ex['error']).includes('path'),
        JSON.stringify(ex),
      );
      check(
        '그 거부는 파일을 하나도 만들지 않았다 (익스포트 저장소가 그대로다)',
        (await filesIn(gw.exports.dir)).join(',') === expDirBefore.join(',')
        && !existsSync('C:\\Windows\\evil.gltf'),
        `${expDirBefore.length}개 → ${(await filesIn(gw.exports.dir)).length}개`,
      );

      const un = await ask(ws, { id: 5, op: 'rm-rf' });
      const unMsg = String(un?.['error'] ?? '');
      check(
        '알 수 없는 op → 사용 가능 목록을 알려준다',
        un?.['ok'] === false && unMsg.includes('rm-rf') && unMsg.includes('ping'),
        unMsg.slice(0, 100),
      );
      // 차단된 op은 "모르는 op"이 아니라 "부를 수 없는 op"이라 목록에 없어야
      // 한다. 목록에 실리면 프론트엔드가 있다고 믿고 호출을 만든다.
      // **#10에서 export가 열렸으므로 이제 실려야 한다** — 지키려던 성질은
      // "차단된 것은 안 실린다"이고, 그 대상이 quit 하나로 줄었을 뿐이다.
      // 반대 방향(열린 것이 안 실림)도 같은 이유로 프론트엔드를 속인다.
      check(
        '그 목록에 quit은 없고(차단) export는 있다(#10에서 열림)',
        !unMsg.includes('quit') && unMsg.includes('export'),
        unMsg.slice(0, 200),
      );

      // ④ ★ 경로 노출 — 이 섹션의 진짜 값어치
      const loaded = await ask(ws, { id: 6, op: 'load', scene: sceneId });
      const result = isRecord(loaded?.['result']) ? loaded['result'] : null;
      check(
        'load(씬 id) 성공',
        loaded?.['ok'] === true && result?.['loaded'] === true,
        JSON.stringify(loaded).slice(0, 160),
      );
      check(
        '워커가 실은 path가 응답에서 씬 id로 갈아끼워졌다',
        result !== null && !('path' in result) && result['scene'] === sceneId,
        JSON.stringify(result),
      );
      check(
        '응답 어디에도 서버 경로가 없다 (#5의 "경로는 밖으로 안 나간다")',
        !leaksPath(JSON.stringify(loaded), dir),
        JSON.stringify(loaded).slice(0, 200),
      );
      // 응답이 위조가 아니라는 증거. 워커의 상태가 실제로 바뀌었어야 한다.
      const st = await ask(ws, { id: 7, op: 'status' });
      check(
        '그 load가 실제로 워커에 닿았다 (status.loaded == true)',
        isRecord(st?.['result']) && st['result']['loaded'] === true,
        JSON.stringify(st?.['result']),
      );

      // ⑤ 주입 — 실제 워커로도 한 번은 확인한다 (변종 전수는 §7-10)
      const inj = await ask(ws, { id: 8, op: 'load', path: 'C:\\Windows\\win.ini' });
      check(
        'load{path} 거부 — 조용히 무시하지 않는다',
        inj?.['ok'] === false && String(inj['error']).includes('path'),
        JSON.stringify(inj),
      );
      const stillMine = await ask(ws, { id: 9, op: 'status' });
      check(
        '거부된 load가 워커의 씬을 건드리지 않았다',
        isRecord(stillMine?.['result']) && stillMine['result']['loaded'] === true,
        JSON.stringify(stillMine?.['result']),
      );

      const missing = await ask(ws, { id: 10, op: 'load', scene: '0'.repeat(32) });
      const missMsg = String(missing?.['error'] ?? '');
      check(
        '없는 씬 → "찾을 수 없습니다" (엔진 로드 실패와 구분된다)',
        missing?.['ok'] === false && missMsg.includes('찾을 수 없습니다'),
        missMsg,
      );
      check('그 오류에도 서버 경로가 없다', !leaksPath(missMsg, dir), missMsg);

      // ⑥ 세션은 끝까지 하나. 거부 6번을 맞고도 워커가 그대로다.
      check(
        '거부 연타 뒤에도 세션 1개 그대로',
        gw.sessions.stats.busy === 1 && ws.readyState === WebSocket.OPEN,
        `busy=${gw.sessions.stats.busy}, readyState=${ws.readyState}`,
      );
      ws.close();
      check('종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
      check(
        '워커 프로세스도 사라진다',
        pid !== undefined && await until(async () => !(await pidAlive(pid))),
        `pid=${String(pid)}`,
      );
    }, { sessions: { createPool: () => traced, heartbeatIntervalMs: 0 } });
  }

  // ── 7-9. 화이트리스트 전수 ────────────────────────────
  // OPS 테이블은 **데이터**다. 한 줄이 틀리면 문이 조용히 열리거나 기능이
  // 조용히 사라지는데, 어느 쪽도 다른 테스트가 잡지 못한다. 그래서 22개를
  // 전부 통과시켜 본다 — 실제 워커로 하면 18번의 왕복이지만, 가짜 릴레이는
  // "워커에 닿았는가"까지 함께 볼 수 있어 오히려 판정이 강하다:
  // 차단된 op은 ok:false인 것으로 부족하고 **워커에 닿지 않아야** 한다.
  section('7-9. op 화이트리스트 전수 (가짜 릴레이)');
  {
    const relay = new Relay();
    const fake = new FakePool({ relay });
    await withScenes(async (gw, addr) => {
      const up = await upload(addr, 'w.zls', new TextEncoder().encode('x'));
      const sceneId = String(sceneOf(up)?.['id'] ?? '');
      const r = await connect(wsUrlOf(addr));
      const ws = r.ws;
      if (!ws) {
        check('연결 성립', false, `status=${String(r.status)}`);
        return;
      }

      // 워커가 export에서 파일을 쓰는 것까지 흉내 낸다. 안 그러면 commit의
      // stat이 실패해 "열렸는데 실패"와 "차단"이 같은 ok:false로 보인다.
      exportingRelay(relay);

      // protocol.ts의 Request 유니온 전부. 여기서 빠진 op이 있으면 아래
      // 개수 단언이 잡는다.
      //
      // ★ export는 #10에서 **통과 + 워커 도달**로 바뀌었다. 워커에 닿는다는
      //   것이 여기서는 위험이 아니라 계약이다 — 클라이언트가 준 것 중 워커에
      //   실리는 건 format 하나이고 경로는 서버가 만든다는 것을 §10-2가 본다.
      const TABLE: Array<[string, boolean]> = [
        ['ping', true], ['version', true], ['init', true], ['load', true],
        ['clear', true], ['start', true], ['pause', true], ['reset', true],
        ['step', true], ['status', true], ['getParams', true], ['setParams', true],
        // 아바타 체형 (L-3a). 읽기는 무해하고, 쓰기는 buildSetAvatarBody 가
        // 타입만 거른 뒤 워커에 닿는다.
        ['avatarBody', true], ['setAvatarBody', true],
        // 치수로 몸 만들기 (W-1). build 가 measurements 를 요구한다 — extra 참고.
        // ★ 이 표에서 유일하게 세션을 10초 이상 붙잡는 op 이지만, 가짜 릴레이는
        //   즉시 답하므로 여기서 재는 것은 "문이 열려 있는가" 뿐이다.
        ['setAvatarMeasurements', true],
        // 드레이핑 보드 (W-1 / DB-1). 목록은 인자가 없고, 적용은 uuid 가
        // **선택**이며(없으면 자동), 썸네일은 uuid 가 **필수**다 — extra 참고.
        // 셋 다 씬 존재 확인은 워커가 한다.
        ['drapingItems', true], ['loadDraping', true], ['drapingThumbnail', true],
        // 옷 사이즈 (L-3b). uuid 검증은 워커가 한다 — 게이트웨이는 타입만 본다.
        ['surfaces', true], ['setSurfaceSize', true],
        // 직물 (UI #50). 읽기는 인자가 없고 씬도 요구하지 않는다. 쓰기는 build 가
        // surface·fabricId 둘 다 요구한다 — extra 참고.
        ['fabrics', true], ['setFabric', true],
        // 디자인 2D (D2-a). 읽기 전용이라 build 가 없다 — 인자가 없는 op 이다.
        ['design2d', true],
        ['meshInfo', true], ['meshData', true],
        // 아바타 메시 (AM-1). 이 표에서 가장 큰 응답이고 build 가 불린 3개를 거른다.
        ['avatarMesh', true],
        ['subscribe', true], ['unsubscribe', true],
        ['export', true], ['quit', false],
      ];
      const extra: Record<string, Record<string, unknown>> = {
        load: { scene: sceneId },
        setParams: { params: { timeStep: 0.01 } },
        // build 가 bodyParams 를 요구한다. 없으면 차단이 아니라 **거절**로
        // 떨어져서 "화이트리스트가 막았다"와 구분되지 않는다.
        setAvatarBody: { bodyParams: { height: 0.5 } },
        // build 가 uuid 와 크기 하나를 요구한다. 없으면 차단이 아니라 **거절**로
        // 떨어져서 "화이트리스트가 막았다"와 구분되지 않는다.
        setSurfaceSize: { uuid: 'x', width: 10 },
        // build 가 비어 있지 않은 measurements 를 요구한다. 없으면(또는 `{}` 면)
        // 차단이 아니라 **거절**로 떨어져서 화이트리스트 판정이 무의미해진다.
        setAvatarMeasurements: { measurements: { Waist: 70 } },
        // build 가 둘 다 요구한다. 없으면 차단이 아니라 **거절**로 떨어져서
        // 화이트리스트가 막은 것과 구분되지 않는다.
        setFabric: { surface: 'x', fabricId: 'y' },
        // build 가 uuid 를 요구한다. 없으면 차단이 아니라 **거절**로 떨어져서
        // 화이트리스트가 막은 것과 구분되지 않는다. `loadDraping` 은 반대로
        // uuid 가 선택이라 여기 없다 — 인자 없이 부르는 것이 정상 경로다.
        drapingThumbnail: { uuid: 'x' },
      };

      let id = 100;
      for (const [op, allow] of TABLE) {
        const before = relay.calls.length;
        id += 1;
        const rep = await ask(ws, { id, op, ...(extra[op] ?? {}) });
        const reached = relay.calls.length > before;
        check(
          `${op} — ${allow ? '통과 + 워커 도달' : '차단 + 워커 미도달'}`,
          rep?.['id'] === id && rep['ok'] === allow && reached === allow,
          `ok=${String(rep?.['ok'])}, 도달=${reached}${rep?.['error'] ? `, ${String(rep['error']).slice(0, 60)}` : ''}`,
        );
      }

      // ★ 이 숫자는 **의식적인 인벤토리**다. op 을 더하고 여기를 안 고치면
      //   빨간불이 난다 — "문이 하나 늘었다"를 사람이 한 번은 보게 하는 장치이고,
      //   실제로 W-1/AM-1 의 op 3개(setAvatarMeasurements·loadDraping·avatarMesh)를
      //   이 단언이 잡아냈다. 아래 집합 비교와 짝이라 하나만으로는 부족하다:
      //   집합 비교는 **허용된 것**만 보므로 차단 op 이 늘어도 안 걸린다.
      check('표가 프로토콜 op 30개를 전부 덮는다', TABLE.length === 30, `${TABLE.length}개`);
      check(
        'allowedOps()가 허용 29개와 정확히 일치 (거부 문구에 실리는 목록)',
        allowedOps().slice().sort().join(',')
          === TABLE.filter(([, a]) => a).map(([o]) => o).sort().join(','),
        allowedOps().join(','),
      );
      // 지키려는 성질은 "차단된 op은 목록에 안 실린다"이고, #10 뒤로 그
      // 대상은 quit 하나다. export를 함께 빼 두면 열린 뒤에도 알아채지 못한다.
      check(
        'allowedOps()에 quit이 없고 export이 있다 (차단만 빠진다)',
        !allowedOps().includes('quit') && allowedOps().includes('export'),
        allowedOps().join(','),
      );

      // ★ build 없는 op은 부가 필드를 통째로 버린다. payload가 undefined여야
      //   한다 — 빈 객체조차 아니다. 스프레드로 흘려보내는 회귀가 생기면
      //   여기서 정확히 잡힌다.
      relay.reset();
      await ask(ws, {
        id: 200, op: 'status',
        path: 'C:\\Windows\\win.ini', format: 'gltf', params: { timeStep: 9 }, evil: 1,
      });
      check(
        'build 없는 op은 클라이언트 부가 필드를 전부 버린다 (payload 없음)',
        relay.last()?.op === 'status' && relay.last()?.payload === undefined,
        JSON.stringify(relay.last()),
      );

      ws.close();
      check('종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
    }, { sessions: { createPool: () => fake, heartbeatIntervalMs: 0 } });
  }

  // ── 7-10. 필드 변환 · 주입 · 경로 차단 ────────────────
  // §7-8이 "진짜 워커로도 막힌다"를 봤다면 여기는 **변종**을 본다. 가짜를
  // 쓰는 이유는 하나다: 막혔다는 것을 응답이 아니라 `relay.calls`로 —
  // 즉 "워커에 닿지 않았다"로 — 판정할 수 있다.
  section('7-10. 필드 변환과 경로 차단 (가짜 릴레이)');
  {
    const relay = new Relay();
    const fake = new FakePool({ relay });
    await withScenes(async (gw, addr) => {
      const a = String(sceneOf(await upload(addr, 'a.zls', new TextEncoder().encode('a')))?.['id'] ?? '');
      const b = String(sceneOf(await upload(addr, 'b.zls', new TextEncoder().encode('bb')))?.['id'] ?? '');
      const dir = gw.scenes.dir;

      // ?scene= 을 달고 연결한다. 이게 **구속이 아니라 기본값**이라는 결정을
      // 아래에서 두 방향으로 확인한다.
      const r = await connect(wsUrlOf(addr, `?scene=${a}`));
      const ws = r.ws;
      if (!ws) {
        check('연결 성립', false, `status=${String(r.status)}`);
        return;
      }

      // 워커가 protocol.cpp:503에서 하는 것과 **같은 모양**으로 답한다.
      // 경로를 지어내지 않고 브리지가 방금 만든 그 경로를 되돌려주므로,
      // mapResult가 없으면 진짜 서버 경로가 그대로 새어 나간다.
      relay.respond = (op, payload) =>
        op === 'load' ? { loaded: true, path: payload?.['path'] } : { echoed: op };

      // ① scene 없는 load → ?scene= 기본값
      relay.reset();
      const def = await ask(ws, { id: 1, op: 'load' });
      const defCall = relay.last();
      check(
        'scene 없는 load → ?scene= 이 기본값으로 쓰인다',
        defCall?.payload?.['path'] === gw.scenes.pathOf(a),
        JSON.stringify(defCall),
      );
      check(
        '워커에 가는 payload는 path 하나뿐 (scene 필드는 안 간다)',
        defCall?.payload !== undefined && Object.keys(defCall.payload).join(',') === 'path',
        JSON.stringify(defCall?.payload && Object.keys(defCall.payload)),
      );
      check(
        '워커가 실어 보낸 path가 응답에서 씬 id로 바뀐다',
        isRecord(def?.['result']) && def['result']['scene'] === a && !('path' in def['result']),
        JSON.stringify(def),
      );
      check('그 응답에 서버 경로가 없다', !leaksPath(JSON.stringify(def), dir), JSON.stringify(def));

      // ② ?scene= 은 구속이 아니다 — 같은 세션에서 다른 씬
      relay.reset();
      const other = await ask(ws, { id: 2, op: 'load', scene: b });
      check(
        '같은 세션에서 다른 씬을 열 수 있다 (?scene= 은 기본값일 뿐)',
        relay.last()?.payload?.['path'] === gw.scenes.pathOf(b)
        && isRecord(other?.['result']) && other['result']['scene'] === b,
        JSON.stringify(other),
      );

      // ③ redact — 워커 오류 문자열에 실린 서버 경로.
      //    성공 결과는 mapResult가 막지만 에러 문구는 엔진이 만들어서
      //    무엇이 들어올지 우리가 정하지 못한다. 마지막 그물이 이것뿐이다.
      relay.fail = (op) => op === 'status'
        ? new Error(`예외: 파일을 열 수 없습니다: ${gw.scenes.pathOf(a)} (code 2)`)
        : null;
      const errRep = await ask(ws, { id: 3, op: 'status' });
      const eMsg = String(errRep?.['error'] ?? '');
      check(
        '워커 오류의 서버 경로가 <씬 저장소>로 지워진다',
        eMsg.includes('<씬 저장소>') && !leaksPath(eMsg, dir),
        eMsg,
      );
      check(
        '그래도 엔진 문구 자체는 살아남는다 (뭉개면 운영에서 원인을 못 찾는다)',
        eMsg.includes('예외') && eMsg.includes('code 2'),
        eMsg,
      );
      // 슬래시로 되돌아온 경우도 같은 그물에 걸려야 한다 (bridge.ts redact 주석)
      relay.fail = (op) => op === 'status'
        ? new Error(`open failed: ${gw.scenes.pathOf(a).replace(/\\/g, '/')}`)
        : null;
      const slashMsg = String((await ask(ws, { id: 4, op: 'status' }))?.['error'] ?? '');
      check(
        '구분자가 / 로 돌아와도 지워진다',
        slashMsg.includes('<씬 저장소>') && !leaksPath(slashMsg, dir),
        slashMsg,
      );
      relay.fail = () => null;

      // ④ path 주입 변종.
      //    #5의 traversal 18종만큼 넓히지 않는 이유: 여기 검사는 값이 아니라
      //    **필드의 존재**다(`'path' in msg`). 값을 아무리 바꿔도 같은 한 줄을
      //    지난다. 대신 타입 변종과 "scene과 함께 보내기"를 넣는다 — 후자가
      //    유일하게 다른 코드 경로를 탈 수 있는 모양이다.
      const injections: Array<[string, unknown]> = [
        ['절대경로', 'C:\\Windows\\win.ini'],
        ['UNC 경로', '\\\\attacker\\share\\evil.zls'],
        ['상대 traversal', '../../../Windows/win.ini'],
        ['POSIX 절대경로', '/etc/passwd'],
        ['빈 문자열', ''],
        ['null', null],
        ['숫자', 1],
        ['배열', ['C:\\Windows\\win.ini']],
        ['객체', { toString: 'x' }],
      ];
      let injId = 300;
      let injBlocked = 0;
      for (const [label, value] of injections) {
        relay.reset();
        injId += 1;
        const rep = await ask(ws, { id: injId, op: 'load', path: value, scene: a });
        const blocked = rep?.['ok'] === false
          && String(rep['error']).includes('path를 받지 않습니다')
          && relay.calls.length === 0;
        if (blocked) injBlocked += 1;
        else check(`load{path=${label}} 거부`, false, JSON.stringify(rep));
      }
      check(
        `path 주입 ${injections.length}종이 전부 거부되고 워커에 닿지 않는다`,
        injBlocked === injections.length,
        `${injBlocked}/${injections.length} — scene을 함께 보내도 path가 있으면 거부된다`,
      );

      // ⑤ 씬 id 형식. 여기는 값이 실제로 `path.join`에 들어가는 자리라
      //    변종을 넓힐 값어치가 있다 (#5의 pathOf가 유일한 관문이다).
      const badIds: Array<[string, unknown]> = [
        ['상대 traversal', '../../../Windows/win.ini'],
        ['역슬래시 traversal', '..\\..\\..\\Windows\\win.ini'],
        ['절대경로', 'C:\\Windows\\win.ini'],
        ['31자', 'a'.repeat(31)],
        ['33자', 'a'.repeat(33)],
        ['대문자 hex', 'A'.repeat(32)],
        ['비 hex', 'g'.repeat(32)],
        ['빈 문자열', ''],
        ['확장자 붙임', `${'a'.repeat(32)}.zls`],
        ['널바이트', `${'a'.repeat(31)}\u0000`],
        ['숫자 타입', 12345],
        ['객체 타입', { id: 'a'.repeat(32) }],
      ];
      let badId = 400;
      let badBlocked = 0;
      for (const [label, value] of badIds) {
        relay.reset();
        badId += 1;
        const rep = await ask(ws, { id: badId, op: 'load', scene: value });
        const blocked = rep?.['ok'] === false && relay.calls.length === 0;
        if (blocked) badBlocked += 1;
        else check(`load{scene=${label}} 거부`, false, JSON.stringify(rep));
      }
      check(
        `씬 id 변종 ${badIds.length}종이 전부 거부되고 워커에 닿지 않는다`,
        badBlocked === badIds.length,
        `${badBlocked}/${badIds.length}`,
      );

      // ⑥ setParams 타입 필터. 문자열 하나가 통과하면 워커가 요청 중간에
      //    죽고 **앞의 키는 이미 적용된 뒤**다 (bridge.ts 주석).
      relay.reset();
      const good = await ask(ws, { id: 500, op: 'setParams', params: { timeStep: 0.01, groundPlane: true, subStep: 5 } });
      check(
        'setParams — 숫자·불린은 통과하고 그대로 전달된다',
        good?.['ok'] === true
        && JSON.stringify(relay.last()?.payload) === JSON.stringify({ params: { timeStep: 0.01, groundPlane: true, subStep: 5 } }),
        JSON.stringify(relay.last()?.payload),
      );

      const badParams: Array<[string, string]> = [
        ['문자열 값', '{"id":501,"op":"setParams","params":{"timeStep":"0.01"}}'],
        ['null 값', '{"id":502,"op":"setParams","params":{"timeStep":null}}'],
        ['Infinity (1e999)', '{"id":503,"op":"setParams","params":{"timeStep":1e999}}'],
        ['중첩 객체', '{"id":504,"op":"setParams","params":{"a":{"b":1}}}'],
        ['배열 값', '{"id":505,"op":"setParams","params":{"a":[1]}}'],
        ['params 누락', '{"id":506,"op":"setParams"}'],
        ['params가 배열', '{"id":507,"op":"setParams","params":[1,2]}'],
        ['params가 문자열', '{"id":508,"op":"setParams","params":"x"}'],
      ];
      let paramBlocked = 0;
      for (const [label, raw] of badParams) {
        relay.reset();
        const rep = await ask(ws, null, { raw });
        const blocked = rep?.['ok'] === false && relay.calls.length === 0;
        if (blocked) paramBlocked += 1;
        else check(`setParams{${label}} 거부`, false, JSON.stringify(rep));
      }
      check(
        `setParams 잘못된 값 ${badParams.length}종이 워커에 닿기 전에 막힌다`,
        paramBlocked === badParams.length,
        `${paramBlocked}/${badParams.length} — 하나라도 새면 시뮬이 부분 적용된 상태가 된다`,
      );

      // ⑦ meshData — 불린 두 개를 **언제나 채워** 보낸다
      //
      // ★ `textures` 는 materials-c 에서 늘어난 칸이고 **기본이 true 다.**
      //   이 단언을 새 사실에 맞춘 근거(회귀가 아니라는 판단):
      //     · 재질을 싣는 응답에서 그 재질의 텍스처만 빼는 조합이 무의미하다
      //     · 프레임 경로(`topology:false`)에는 재질이 자체가 없어 응답이 한
      //       글자도 안 는다 — 대역폭 회귀가 성립하지 않는다
      //     · 기본이 false 였다면 화면 쪽이 `textures:true` 를 한 곳에서만
      //       빠뜨려도 흰 옷이 되고 크래시가 없어 원인을 못 읽는다
      //   지키려는 성질은 **"기본값이 무엇인지 여기 적혀 있다"** 이다.
      //   기본이 조용히 뒤집히면 아래 두 줄이 잡는다.
      relay.reset();
      await ask(ws, { id: 600, op: 'meshData' });
      check(
        'meshData — 아무것도 안 주면 topology:false · textures:true 로 채워 보낸다',
        JSON.stringify(relay.last()?.payload) === '{"topology":false,"textures":true}',
        JSON.stringify(relay.last()?.payload),
      );
      relay.reset();
      await ask(ws, { id: 601, op: 'meshData', topology: true });
      check(
        'meshData — topology:true는 그대로 (textures 기본은 유지된다)',
        JSON.stringify(relay.last()?.payload) === '{"topology":true,"textures":true}',
        JSON.stringify(relay.last()?.payload),
      );
      relay.reset();
      await ask(ws, { id: 602, op: 'meshData', textures: false });
      check(
        '★ meshData — textures:false 는 그대로 실린다 (기본값이 덮어쓰지 않는다)',
        JSON.stringify(relay.last()?.payload) === '{"topology":false,"textures":false}',
        JSON.stringify(relay.last()?.payload),
      );
      relay.reset();
      const badTopo = await ask(ws, { id: 603, op: 'meshData', topology: 'true' });
      check(
        'meshData — topology:"true"(문자열) 거부, 워커 미도달',
        badTopo?.['ok'] === false && relay.calls.length === 0,
        JSON.stringify(badTopo),
      );
      relay.reset();
      const badTex = await ask(ws, { id: 604, op: 'meshData', textures: 'yes' });
      check(
        'meshData — textures:"yes"(문자열) 거부, 워커 미도달',
        badTex?.['ok'] === false && relay.calls.length === 0,
        JSON.stringify(badTex),
      );

      // ⑦-2 avatarMesh — 같은 계열이되 칸이 셋이다. `normals` 기본이 **true** 인
      //     것이 핵심이다: 법선은 topology 가 아니라 positions 와 한 몸이라
      //     기본이 false 로 뒤집히면 몸이 움직이는데 음영만 굳는다.
      relay.reset();
      await ask(ws, { id: 610, op: 'avatarMesh' });
      check(
        '★ avatarMesh — 기본은 topology:false · normals:true · textures:true',
        JSON.stringify(relay.last()?.payload)
          === '{"topology":false,"normals":true,"textures":true}',
        JSON.stringify(relay.last()?.payload),
      );
      relay.reset();
      await ask(ws, { id: 611, op: 'avatarMesh', topology: true, normals: false, textures: false });
      check(
        'avatarMesh — 셋 다 명시하면 그대로 실린다',
        JSON.stringify(relay.last()?.payload)
          === '{"topology":true,"normals":false,"textures":false}',
        JSON.stringify(relay.last()?.payload),
      );
      let avatarBadBlocked = 0;
      for (const [k, v] of [['topology', 1], ['normals', 'x'], ['textures', null]] as const) {
        relay.reset();
        const rep = await ask(ws, { id: 612, op: 'avatarMesh', [k]: v });
        if (rep?.['ok'] === false && relay.calls.length === 0) avatarBadBlocked += 1;
        else check(`avatarMesh{${k}} 비불린 거부`, false, JSON.stringify(rep));
      }
      check(
        'avatarMesh — 불린이 아닌 값 3종이 워커에 닿기 전에 막힌다',
        avatarBadBlocked === 3,
        `${avatarBadBlocked}/3`,
      );

      // ⑦-3 setAvatarMeasurements — **`null` 은 "지정 안 함" 이지 잘못된 값이
      //     아니다.** 엔진팀 문서의 규약이고, 여기서 막으면 25개 중 일부만
      //     지정하는 정상 사용이 통째로 불가능해진다.
      relay.reset();
      await ask(ws, {
        id: 620, op: 'setAvatarMeasurements',
        measurements: { Waist: 70, Bust: null },
      });
      check(
        '★ setAvatarMeasurements — null 이 그대로 워커에 실린다 (지정 안 함)',
        JSON.stringify(relay.last()?.payload)
          === '{"measurements":{"Waist":70,"Bust":null}}',
        JSON.stringify(relay.last()?.payload),
      );
      relay.reset();
      await ask(ws, {
        id: 621, op: 'setAvatarMeasurements',
        measurements: { Waist: 70 }, simulationIterations: 3, bodyDimensionStepCm: 0.5,
      });
      check(
        'setAvatarMeasurements — 튜너블 둘은 있을 때만 실린다',
        JSON.stringify(relay.last()?.payload)
          === '{"measurements":{"Waist":70},"simulationIterations":3,"bodyDimensionStepCm":0.5}',
        JSON.stringify(relay.last()?.payload),
      );
      const badMeasure: Array<[string, string]> = [
        ['measurements 누락', '{"id":630,"op":"setAvatarMeasurements"}'],
        ['빈 객체', '{"id":631,"op":"setAvatarMeasurements","measurements":{}}'],
        ['배열', '{"id":632,"op":"setAvatarMeasurements","measurements":[1]}'],
        ['문자열 값', '{"id":633,"op":"setAvatarMeasurements","measurements":{"Waist":"70"}}'],
        ['Infinity', '{"id":634,"op":"setAvatarMeasurements","measurements":{"Waist":1e999}}'],
        // 0 이면 단계 수가 무한이 되어 워커가 돌아오지 않는다 — 굳게 만들 수
        // 있는 값은 게이트웨이를 지나면 안 된다.
        ['stepCm 0', '{"id":635,"op":"setAvatarMeasurements","measurements":{"Waist":70},"bodyDimensionStepCm":0}'],
        ['iterations 음수', '{"id":636,"op":"setAvatarMeasurements","measurements":{"Waist":70},"simulationIterations":-1}'],
      ];
      let measureBlocked = 0;
      for (const [label, raw] of badMeasure) {
        relay.reset();
        const rep = await ask(ws, null, { raw });
        if (rep?.['ok'] === false && relay.calls.length === 0) measureBlocked += 1;
        else check(`setAvatarMeasurements{${label}} 거부`, false, JSON.stringify(rep));
      }
      check(
        `setAvatarMeasurements 잘못된 값 ${badMeasure.length}종이 워커에 닿기 전에 막힌다`,
        measureBlocked === badMeasure.length,
        `${measureBlocked}/${badMeasure.length}`,
      );

      // ⑦-4 loadDraping 은 **uuid 만** 통과시킨다 (DB-1).
      //
      // 예전에는 build 가 없어 부가 필드를 통째로 버렸다. DB-1 이 uuid 를
      // 받게 하면서 build 가 생겼으므로, 이제 확인할 것은 "아무것도 안 실린다"
      // 가 아니라 **"uuid 말고는 아무것도 안 실린다"** 다 — 경로가 워커까지
      // 새어 나가지 않는다는 사실은 그대로 지켜져야 한다.
      relay.reset();
      await ask(ws, {
        id: 640, op: 'loadDraping',
        uuid: 'drape-1', name: 'x', path: 'C:\\Windows\\win.ini',
      });
      check(
        'loadDraping — uuid 만 실리고 나머지 클라이언트 필드는 버려진다',
        JSON.stringify(relay.last()?.payload ?? null) === JSON.stringify({ uuid: 'drape-1' }),
        JSON.stringify(relay.last()?.payload ?? null),
      );

      // uuid 가 아예 없으면 여전히 아무것도 안 싣는다 — 그것이 "자동" 의 표현이다.
      relay.reset();
      await ask(ws, { id: 641, op: 'loadDraping', name: 'x' });
      check(
        'loadDraping — uuid 없이 부르면 빈 페이로드다 (= 자동 아이템)',
        JSON.stringify(relay.last()?.payload ?? null) === JSON.stringify({}),
        JSON.stringify(relay.last()?.payload ?? null),
      );

      // ⚠️ **빈 문자열은 거절한다.** 통과시키면 워커가 "자동" 으로 읽어,
      //    아이템을 골랐는데 엉뚱한 것이 적용되고 **성공으로 보인다**.
      relay.reset();
      const emptyDrapeUuid = await ask(ws, { id: 642, op: 'loadDraping', uuid: '' });
      check(
        'loadDraping — 빈 uuid 는 워커에 닿기 전에 막힌다',
        emptyDrapeUuid?.['ok'] === false && relay.calls.length === 0,
        JSON.stringify(emptyDrapeUuid),
      );

      // ⑦-5 drapingThumbnail 은 uuid 가 **필수**다 (DB-1). `loadDraping` 과
      //      다른 이유는 대신할 것이 없어서다 — 자동으로 채우면 화면이 **다른
      //      아이템의 그림을 그 아이템의 것으로 믿는다**.
      relay.reset();
      const thumbNoUuid = await ask(ws, { id: 643, op: 'drapingThumbnail' });
      check(
        'drapingThumbnail — uuid 없이 부르면 워커에 닿기 전에 막힌다',
        thumbNoUuid?.['ok'] === false && relay.calls.length === 0,
        JSON.stringify(thumbNoUuid),
      );

      // ⑧ 거부를 그렇게 많이 받고도 세션이 그대로다
      check(
        `거부 ${injections.length + badIds.length + badParams.length + badMeasure.length + 5}건 뒤에도 연결과 세션 유지`,
        ws.readyState === WebSocket.OPEN && gw.sessions.stats.busy === 1 && fake.released === 0,
        `readyState=${ws.readyState}, busy=${gw.sessions.stats.busy}`,
      );
      const stillOk = await ask(ws, { id: 700, op: 'ping' });
      check('그리고 정상 op은 여전히 돈다', stillOk?.['ok'] === true, JSON.stringify(stillOk));

      ws.close();
      check('종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
    }, { sessions: { createPool: () => fake, heartbeatIntervalMs: 0 } });
  }

  // ── 7-11. 보내는 순서와 동시 요청 ─────────────────────
  // load→start 뒤집힘은 **조용한 실패**다. 클라이언트는 ok:true 둘을 받고,
  // 워커는 로드 안 된 씬을 start한다. 아무도 모르는 채로 회귀한다.
  //
  // 이 테스트에 이빨이 있는 근거: buildLoad는 `scenes.get()`(fs I/O)을
  // await한다. 체인이 없으면 뒤따르는 start는 마이크로태스크만 지나 곧장
  // 워커로 가므로 **반드시** 먼저 도착한다 — 확률이 아니라 구조다.
  // 그래도 타이밍이 걸린 주장이므로 10회 반복해서 본다.
  section('7-11. 보내는 순서와 동시 요청 (가짜 릴레이)');
  {
    const relay = new Relay();
    const fake = new FakePool({ relay });
    await withScenes(async (gw, addr) => {
      const sceneId = String(sceneOf(await upload(addr, 's.zls', new TextEncoder().encode('s')))?.['id'] ?? '');
      const r = await connect(wsUrlOf(addr));
      const ws = r.ws;
      if (!ws) {
        check('연결 성립', false, `status=${String(r.status)}`);
        return;
      }

      // 응답을 전부 모아 둔다. 붙잡아 둔 요청이 풀린 뒤를 확인해야 해서
      // ask()의 "한 번에 하나"로는 부족하다.
      const inbox: Array<Record<string, unknown>> = [];
      ws.on('message', (d: Buffer) => {
        try {
          const v: unknown = JSON.parse(d.toString('utf8'));
          if (isRecord(v)) inbox.push(v);
        } catch { /* 무시 */ }
      });
      const send = (o: unknown): void => ws.send(JSON.stringify(o));

      // ① 순서 — 10회 반복
      let ordered = 0;
      let sawOrder = '';
      for (let i = 0; i < 10; i += 1) {
        relay.reset();
        send({ id: 1000 + i * 3, op: 'load', scene: sceneId });
        send({ id: 1001 + i * 3, op: 'start' });
        send({ id: 1002 + i * 3, op: 'status' });
        await until(() => relay.calls.length === 3);
        sawOrder = relay.ops.join(',');
        if (sawOrder === 'load,start,status') ordered += 1;
      }
      check(
        'load→start→status가 보낸 순서 그대로 워커에 닿는다 (10회)',
        ordered === 10,
        `${ordered}/10, 마지막 관측=${sawOrder}`,
      );

      // ①-b 대조군 — 위 단언에 이빨이 있다는 증거.
      //
      // "순서가 맞았다"만으로는 체인이 일하는지 알 수 없다. 우연히 맞았을
      // 수도 있으니까. 체인은 **연결 단위**이므로, 같은 두 요청을 서로 다른
      // 연결로 보내면 직렬화가 걸리지 않는다 — load가 fs I/O를 지나는 사이
      // start가 먼저 도착해야 한다. 그게 관측되면 "load는 실제로 느리다 =
      // 한 연결에서 순서가 맞은 것은 체인 덕분이다"가 된다.
      //
      // 소켓 두 개의 도착 순서에는 지터가 있어 판정에 넣지 않는다(note).
      // 판정은 위의 10/10이 하고, 이건 그 숫자의 의미를 남기는 기록이다.
      {
        let reversed = 0;
        for (let i = 0; i < 10; i += 1) {
          const other = await connect(wsUrlOf(addr));
          if (!other.ws) break;
          relay.reset();
          send({ id: 5000 + i * 2, op: 'load', scene: sceneId });
          other.ws.send(JSON.stringify({ id: 5001 + i * 2, op: 'start' }));
          await until(() => relay.calls.length === 2);
          if (relay.ops.join(',') === 'start,load') reversed += 1;
          other.ws.close();
          await until(() => gw.sessions.stats.busy === 1);
        }
        note(
          '대조군 — 연결이 다르면 순서가 뒤집힌다',
          `${reversed}/10회. 체인은 연결 단위이고, load가 씬 확인(fs)을 지나는 동안 `
          + 'start가 먼저 도착한다. 위 10/10은 그래서 우연이 아니다',
        );
      }

      // ② 체인은 **쓰기까지만** 붙잡는다. 응답 대기까지 직렬화하면 동시
      //    요청의 이점이 사라지므로, 4건이 응답 없이 전부 도달해야 한다.
      relay.hold = true;
      relay.reset();
      inbox.length = 0;
      for (let i = 0; i < 4; i += 1) send({ id: 2000 + i, op: 'ping' });
      const allSent = await until(() => relay.calls.length === 4);
      check(
        '응답을 안 기다리고 4건이 동시에 워커에 도달 (체인은 쓰기까지만)',
        allSent && inbox.length === 0,
        `도달=${relay.calls.length}건, 이미 온 응답=${inbox.length}건`,
      );

      // ③ id 중복 — 처리 중인 id는 거부된다.
      //    (dispatch에서 중복 검사가 상한 검사보다 앞이라 상한 4에 걸리지 않는다)
      const dup = await ask(ws, { id: 2000, op: 'ping' });
      check(
        '처리 중인 id 재사용 → 거부 (두 응답이 같은 id로 나가면 상관 불가)',
        dup?.['id'] === 2000 && dup['ok'] === false && String(dup['error']).includes('처리 중'),
        JSON.stringify(dup),
      );

      // ④ 동시 요청 상한 (maxInflightRequests: 4)
      const over = await ask(ws, { id: 2999, op: 'ping' });
      check(
        '상한 초과 → 큐에 쌓지 않고 즉시 거부',
        over?.['id'] === 2999 && over['ok'] === false && String(over['error']).includes('상한 4'),
        JSON.stringify(over),
      );
      check(
        '거부된 요청은 워커에 닿지 않았다 (여전히 4건)',
        relay.calls.length === 4,
        `${relay.calls.length}건`,
      );

      // ⑤ 붙잡은 응답을 풀면 전부 돌아오고 상한도 풀린다
      relay.hold = false;
      relay.releaseAll();
      const drained = await until(() =>
        [2000, 2001, 2002, 2003].every((i) => inbox.some((m) => m['id'] === i && m['ok'] === true)));
      check(
        '붙잡아 둔 4건이 전부 성공으로 돌아온다',
        drained,
        `받은 id=${inbox.map((m) => `${String(m['id'])}:${String(m['ok'])}`).join(' ')}`.slice(0, 160),
      );
      check(
        '거부된 2999는 실패 한 번으로 끝났다 (나중에 다시 오지 않는다)',
        inbox.filter((m) => m['id'] === 2999).length === 1,
        `${inbox.filter((m) => m['id'] === 2999).length}건`,
      );
      const after = await ask(ws, { id: 3000, op: 'ping' });
      check('상한이 풀리면 다시 받는다', after?.['ok'] === true, JSON.stringify(after));

      ws.close();
      check('종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
    }, { sessions: { createPool: () => fake, heartbeatIntervalMs: 0, maxInflightRequests: 4 } });
  }

  // ── §7-12. 이벤트 역방향 중계 (TASKS #8) ──────────────
  // 통과 기준은 한 줄이다: **load → start → 클라이언트에 frame 이벤트 도착.**
  //
  // 이 한 줄만은 실제 워커여야 한다. #8이 주장하는 것은 "게이트웨이가 이벤트를
  // 잘 포장한다"가 아니라 **"워커가 스스로 밀어 보내는 것이 클라이언트까지
  // 닿는다"**이고, 가짜 세션의 emit은 그 사슬의 앞쪽 절반(엔진 → SDK Session)을
  // 통째로 건너뛴다. 실측 비용은 씬 복사 31ms + load 1.1s + 시뮬 0.3s ≈ 2.1s로,
  // 30초 가드 안에서 충분히 감당된다.
  //
  // 반대로 **리스너 수명·구독 물려받기·응답/이벤트 판별**은 실제 워커로 하면
  // 안 된다 — 전부 "무엇이 오지 않는가"에 대한 주장이라 실제 워커로는
  // 확률적으로만 확인된다. 그건 §7-13/7-14가 가짜 세션으로 결정적으로 본다.
  section('7-12. 워커 이벤트 역방향 중계 (실제 워커, 통과 기준)');
  {
    const traced = new TracingPool(new SessionPool({
      exePath: defaultWorkerExe(),
      idleTimeout: 0,
      maxTotal: 1,
      onLog: () => {},
    }));

    await withScenes(async (gw, addr) => {
      if (!existsSync(SAMPLE_ZLS)) {
        check('sample.zls 존재 — 통과 기준에는 진짜 씬이 필요하다', false, SAMPLE_ZLS);
        return;
      }
      const sceneId = await plantScene(gw.scenes);

      const r = await connect(wsUrlOf(addr));
      const ws = r.ws;
      strayPids.push(...traced.pids);
      if (!ws) {
        check('연결 성립', false, `status=${String(r.status)}, error=${String(r.error)}`);
        return;
      }
      const pid = traced.pids[0];
      const inbox = new Inbox(ws);

      // ── ① 통과 기준 ────────────────────────────────────
      const loaded = await inbox.send({ op: 'load', scene: sceneId });
      check(
        'load(sample.zls) 성공',
        loaded?.['ok'] === true
        && isRecord(loaded['result']) && loaded['result']['loaded'] === true,
        JSON.stringify(loaded).slice(0, 160),
      );
      // load는 1초 넘게 걸리는데 그 사이 이벤트가 없다는 것이, 아래에서 세는
      // 프레임이 **start 때문에 나온 것**이라는 근거다.
      check(
        'load 중에는 이벤트가 오지 않는다 (시뮬이 안 돌고 있으므로)',
        inbox.events.length === 0,
        `${inbox.events.length}건`,
      );

      const started = await inbox.send({ op: 'start' });
      check('start 성공', started?.['ok'] === true, JSON.stringify(started));

      const frames = await inbox.collect('frame', 5);
      check(
        '★ load → start → 클라이언트에 frame 이벤트 도착 (통과 기준)',
        frames.length > 0,
        `${frames.length}건, 첫 이벤트=${JSON.stringify(frames[0])}`,
      );

      // ── ② 이벤트의 모양 — 워커 프로토콜 그대로, 감싸지 않는다 ──
      const f0 = frames[0];
      check(
        'frame 이벤트가 { event:"frame", frame:숫자 } — 봉투를 씌우지 않는다',
        f0?.['event'] === 'frame' && typeof f0['frame'] === 'number',
        JSON.stringify(f0),
      );
      // ★ 클라이언트 라우팅이 이것 하나에 걸려 있다. 이벤트에 id가 붙으면
      //   Inbox 같은 상관 로직이 남의 id를 자기 응답으로 착각한다.
      check(
        'frame 이벤트에 id가 없다 (응답과 섞이지 않는다)',
        frames.every((e) => !('id' in e)),
        `id 달린 이벤트 ${frames.filter((e) => 'id' in e).length}건`,
      );

      const engineMsgs = inbox.of('engineMessage');
      check(
        'engineMessage 이벤트도 중계된다',
        engineMsgs.length > 0 && typeof engineMsgs[0]?.['message'] === 'string',
        `${engineMsgs.length}건, 예: ${JSON.stringify(engineMsgs[0]?.['message'])}`,
      );

      // ── ③ mesh는 **구독 중일 때만** ────────────────────
      // `null`이 아니라 **키 자체가 없어야** 한다. `"mesh":null`이 섞이면
      // 클라이언트가 두 가지 "없음"을 다루게 된다(bridge.frameEvent 주석).
      check(
        '비구독 frame에는 mesh 키 자체가 없다 (null이 아니다)',
        frames.every((e) => !('mesh' in e)),
        `mesh 실린 frame ${frames.filter((e) => 'mesh' in e).length}/${frames.length}건`,
      );

      const mark = inbox.events.length;
      const sub = await inbox.send({ op: 'subscribe' });
      check(
        'subscribe → { subscribed: true }',
        sub?.['ok'] === true && isRecord(sub['result']) && sub['result']['subscribed'] === true,
        JSON.stringify(sub),
      );

      await until(
        () => inbox.events.slice(mark).filter((e) => e['event'] === 'frame' && 'mesh' in e).length >= 3,
        8_000,
      );
      const meshFrames = inbox.events
        .slice(mark)
        .filter((e) => e['event'] === 'frame' && 'mesh' in e);
      check(
        '구독하면 같은 frame 이벤트에 mesh가 실린다',
        meshFrames.length >= 3,
        `${meshFrames.length}건, 1건 ${Math.round(JSON.stringify(meshFrames[0] ?? {}).length / 1024)}KB`,
      );

      // 게이트웨이가 mesh를 **손대지 않고** 넘기는가. positions는 워커가 만든
      // base64 그대로여야 한다 — 디코드해서 정점 수와 맞아떨어지면, 중간에
      // 자르거나 다시 인코딩하는 일이 없었다는 뜻이다.
      const mesh = meshFrames[0]?.['mesh'] as MeshDataResult | undefined;
      const pats = mesh?.patterns ?? [];
      let meshBad: string | null = pats.length === 0 ? '패턴 0개' : null;
      for (const p of pats) {
        const n = p.positions === undefined ? -1 : decodeFloat32(p.positions).length;
        if (n !== (p.vertices ?? -1) * 3) {
          meshBad = `${String(p.uuid)}: positions ${n} != vertices ${String(p.vertices)} × 3`;
          break;
        }
      }
      check(
        '각 패턴 positions(base64) 디코드 = 정점수 × 3 — 중계가 메시를 손대지 않는다',
        meshBad === null,
        meshBad ?? `패턴 ${pats.length}개 검사`,
      );
      // 프레임마다 실으면 대역폭이 몇 배가 된다(protocol.cpp:424). 토폴로지는
      // meshData{topology:true}로 1회만 받는 것이 계약이다.
      check(
        '프레임 메시에 토폴로지가 없다 (topology:false, indices/uvs 없음)',
        mesh?.topology === false && pats.every((p) => !('indices' in p) && !('uvs' in p)),
        `topology=${String(mesh?.topology)}`,
      );

      // ── ③b 이벤트가 쏟아지는 중에도 응답은 id로 상관된다 ──
      // #11의 라우팅이 정확히 이 상황에 걸려 있다: 구독 중이면 초당 약 80건이
      // 흐르므로 "다음 메시지"는 거의 항상 남의 이벤트다. 요청 3건을 연달아
      // 던져 각각 **자기 id의 응답**을 받는지 본다. 하나라도 이벤트를 응답으로
      // 착각하면 Inbox의 waiter가 안 풀려 null이 돌아온다.
      const flood = await Promise.all([
        inbox.send({ op: 'ping' }),
        inbox.send({ op: 'status' }),
        inbox.send({ op: 'version' }),
      ]);
      check(
        '★ 메시가 흐르는 중에도 요청 3건이 각자 자기 id의 응답을 받는다',
        flood.every((m) => m !== null && m['ok'] === true),
        flood.map((m) => (m === null ? 'null' : `id=${String(m['id'])} ok=${String(m['ok'])}`)).join(' | '),
      );
      // 응답에는 event 필드가 없다 — 실제 워커 응답으로도 §7-14의 계약을 본다.
      check(
        '실제 워커 응답에도 event 필드가 없다 (판별 필드가 겹치지 않는다)',
        flood.every((m) => m !== null && !('event' in m)),
        `${flood.filter((m) => m !== null && 'event' in m).length}건이 event를 달고 왔다`,
      );

      // ── ④ 흐르는 중에 닫는다 ───────────────────────────
      // 매 세션 종료마다 실제로 일어나는 경로다(1.9MB/s가 흐르는 중의 close).
      // 여기서 매달리거나 워커가 남으면 #detach의 fire-and-forget이 잘못된 것이다.
      const seenBefore = inbox.events.length;
      ws.close();
      check('구독 중 종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
      const afterClose = inbox.events.length - seenBefore;
      await new Promise((res) => setTimeout(res, 150));
      check(
        '닫은 뒤 이 소켓에 이벤트가 더 오지 않는다',
        inbox.events.length - seenBefore === afterClose,
        `close 직후 ${afterClose}건 → 150ms 뒤 ${inbox.events.length - seenBefore}건`,
      );
      check(
        '워커 프로세스도 사라진다 (시뮬 중이었어도)',
        pid !== undefined && await until(async () => !(await pidAlive(pid))),
        `pid=${String(pid)}`,
      );
    }, { sessions: { createPool: () => traced, heartbeatIntervalMs: 0 } });
  }

  // ── §7-13. 리스너는 연결보다 오래 살지 않는다 ─────────
  // #8의 최악의 실패는 "이벤트가 안 온다"가 아니라 **"다음 연결의 프레임이
  // 이전 클라이언트로 간다"**이다. 그건 실제 워커로는 재현이 확률적이라
  // 여기서 세션의 emit을 직접 불러 결정적으로 본다.
  //
  // ★ 판정을 `listenerCount`로 하는 이유가 이 섹션의 핵심이다. "닫은 뒤
  //   emit해도 아무 데도 안 간다"만 보면 **부족하다** — `bridge.close()`가
  //   이미 그것을 막으므로, #detach가 `off()`를 통째로 빠뜨려도 그 단언은
  //   통과한다. 실제로 새는 것은 세션에 쌓이는 리스너이고, 그건
  //   EventEmitter의 장부를 직접 읽어야만 보인다.
  section('7-13. 이벤트 리스너 수명 (가짜 세션, emit 직접 호출)');
  {
    const relay = new Relay();
    const pool = new ReusingPool(relay);
    const session = pool.session;

    await withScenes(async (gw, addr) => {
      const dir = gw.scenes.dir;

      // ── ① 워커 없이 게이트웨이 경로 전체를 지난다 ──────
      const r1 = await connect(wsUrlOf(addr));
      const a = r1.ws;
      if (!a) {
        check('연결 성립', false, `status=${String(r1.status)}`);
        return;
      }
      const inboxA = new Inbox(a);

      check(
        '연결되면 세션에 frame/engineMessage 리스너가 하나씩 달린다',
        session.listenerCount('frame') === 1 && session.listenerCount('engineMessage') === 1,
        `frame=${session.listenerCount('frame')}, engineMessage=${session.listenerCount('engineMessage')}`,
      );

      session.emit('frame', 7);
      await until(() => inboxA.of('frame').length >= 1);
      check(
        'session.emit("frame", 7) → 클라이언트에 그대로 도착',
        JSON.stringify(inboxA.of('frame')[0]) === '{"event":"frame","frame":7}',
        JSON.stringify(inboxA.of('frame')[0]),
      );

      // frame 리스너는 인자가 2개다 (frame, mesh?). mesh를 실어 보내면
      // 게이트웨이가 그대로 통과시켜야 한다.
      const fakeMesh: MeshDataResult = {
        patterns: [{ uuid: 'u-1', vertices: 2, triangles: 0, positionStride: 12, positions: 'AAAA' }],
        topology: false,
      };
      session.emit('frame', 8, fakeMesh);
      await until(() => inboxA.of('frame').length >= 2);
      const withMesh = inboxA.of('frame')[1];
      check(
        'mesh 인자가 있으면 그대로 실린다 (게이트웨이에 두 번째 스위치가 없다)',
        isRecord(withMesh?.['mesh'])
        && JSON.stringify(withMesh['mesh']) === JSON.stringify(fakeMesh),
        JSON.stringify(withMesh),
      );

      // engineMessage는 엔진이 만드는 사람이 읽는 문자열이라 서버 경로가
      // 섞일 수 있다. 응답에만 그물을 치고 이벤트에 안 치면 #5·#7이 세운
      // "경로는 밖으로 안 나간다"가 여기서 새어 나간다(bridge 주석).
      session.emit('engineMessage', `zls를 열 수 없습니다: ${dir}\\deadbeef.zls`);
      await until(() => inboxA.of('engineMessage').length >= 1);
      const em = String(inboxA.of('engineMessage')[0]?.['message'] ?? '');
      check(
        'engineMessage의 서버 경로가 이벤트 채널에서도 지워진다',
        em.includes('<씬 저장소>') && !leaksPath(em, dir),
        em,
      );

      // ── ② 연결이 끝나면 리스너가 남지 않는다 ───────────
      const beforeUnsub = relay.ops.length;
      a.close();
      check('A 종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));

      check(
        '★ 닫으면 세션에 리스너가 하나도 남지 않는다 (frame/engineMessage/exit)',
        session.listenerCount('frame') === 0
        && session.listenerCount('engineMessage') === 0
        && session.listenerCount('exit') === 0,
        `frame=${session.listenerCount('frame')}, engineMessage=${session.listenerCount('engineMessage')}, exit=${session.listenerCount('exit')}`,
      );

      // 구독은 워커 쪽 스위치라 세션이 살아 있는 한 켜진 채로 남는다.
      // 안 끄면 다음 연결이 subscribe한 적도 없이 1.9MB/s를 받는다.
      // fire-and-forget이지만 stdin 쓰기(= relay.calls push)는 release보다
      // **먼저 동기로** 일어나므로, busy가 0이 된 시점엔 이미 기록돼 있다.
      check(
        '★ 반납 직전에 unsubscribe가 워커로 나간다 (구독 물려받기 차단)',
        relay.ops.slice(beforeUnsub).includes('unsubscribe'),
        `종료 후 워커에 닿은 op=[${relay.ops.slice(beforeUnsub).join(',')}]`,
      );

      const strayBefore = inboxA.events.length;
      session.emit('frame', 999);
      session.emit('engineMessage', '닫힌 뒤');
      await new Promise((res) => setTimeout(res, 100));
      check(
        '닫힌 뒤의 emit은 아무 데도 가지 않는다',
        inboxA.events.length === strayBefore,
        `${inboxA.events.length - strayBefore}건 추가 도착`,
      );

      // ── ③ ★ 재사용된 세션이 이전 클라이언트로 새지 않는다 ──
      // 이 풀은 **같은 세션 객체**를 다시 내준다 (idleTimeout > 0 의 세계).
      const r2 = await connect(wsUrlOf(addr));
      const b = r2.ws;
      if (!b) {
        check('재사용 연결 성립', false, `status=${String(r2.status)}`);
        return;
      }
      const inboxB = new Inbox(b);
      check(
        '두 번째 연결이 같은 세션 객체를 물려받았다 (재사용 재현)',
        pool.acquired === 2 && pool.released === 1,
        `acquired=${pool.acquired}, released=${pool.released}`,
      );

      const aBefore = inboxA.events.length;
      session.emit('frame', 42);
      await until(() => inboxB.of('frame').length >= 1);
      check(
        '재사용 세션의 프레임은 새 연결(B)에만 간다',
        inboxB.of('frame')[0]?.['frame'] === 42 && inboxA.events.length === aBefore,
        `B=${JSON.stringify(inboxB.of('frame')[0])}, A에 추가 도착 ${inboxA.events.length - aBefore}건`,
      );
      check(
        '리스너도 새 연결 것 하나뿐이다 (이전 것이 쌓이지 않았다)',
        session.listenerCount('frame') === 1,
        `frame=${session.listenerCount('frame')}`,
      );

      b.close();
      check('B 종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));

      // ── ④ 반복해도 쌓이지 않는다 ───────────────────────
      // 누수는 한 번으로는 안 보이고 **누적**으로 보인다. 5회 돌려서
      // 리스너가 1을 넘긴 적이 있는지 본다.
      let peak = 0;
      for (let i = 0; i < 5; i++) {
        const r = await connect(wsUrlOf(addr));
        if (!r.ws) break;
        peak = Math.max(peak, session.listenerCount('frame'));
        r.ws.close();
        await until(() => gw.sessions.stats.busy === 0);
      }
      check(
        '연결 5회 반복해도 리스너가 누적되지 않는다',
        peak === 1 && session.listenerCount('frame') === 0,
        `연결 중 최대 ${peak}개, 마지막 종료 후 ${session.listenerCount('frame')}개`,
      );
    }, { sessions: { createPool: () => pool, heartbeatIntervalMs: 0 } });
  }

  // ── §7-14. 응답 ≠ 이벤트 (판별 계약) ──────────────────
  // "id가 없으면 이벤트"는 **틀린 규칙**이다. 응답에도 id가 없는 경로가 셋
  // 있고(JSON 파싱 실패 / `op` 누락 / 바이너리 거부), 그 셋이 이벤트로
  // 오인되면 클라이언트가 오류를 조용히 삼킨다. 판별은 `'event' in msg`
  // 하나뿐이라는 것을 이 셋으로 고정한다.
  //
  // Inbox가 정확히 그 규칙으로 분류하므로, 셋이 `idless`에 들어오면 계약이
  // 지켜진 것이고 `events`에 들어오면 깨진 것이다.
  section('7-14. id 없는 응답이 이벤트로 오인되지 않는다');
  {
    const fake = new FakePool();
    await withScenes(async (gw, addr) => {
      const r = await connect(wsUrlOf(addr));
      const ws = r.ws;
      if (!ws) {
        check('연결 성립', false, `status=${String(r.status)}`);
        return;
      }
      const inbox = new Inbox(ws);

      ws.send('{"op":');                       // JSON 파싱 실패
      ws.send(JSON.stringify({ id: 1 }));      // op 누락 (id가 있어도 응답에 실린다)
      ws.send(JSON.stringify({ noOp: true })); // op 누락 + id 없음
      ws.send(new Uint8Array([1, 2, 3]), { binary: true }); // 바이너리 거부

      await until(() => inbox.idless.length >= 3);
      check(
        'id 없는 응답 3종이 전부 도착했다',
        inbox.idless.length === 3,
        inbox.idless.map((m) => String(m['error'])).join(' | '),
      );
      check(
        '★ 그 셋이 하나도 이벤트로 분류되지 않았다 (판별 = "event" in msg)',
        inbox.events.length === 0 && inbox.idless.every((m) => !('event' in m)),
        `이벤트로 샌 것 ${inbox.events.length}건`,
      );
      check(
        '전부 { ok:false, error } 형태다',
        inbox.idless.every((m) => m['ok'] === false && typeof m['error'] === 'string'),
        JSON.stringify(inbox.idless),
      );
      // 대조군: 이벤트에는 event 필드가 있고 id가 없다. 응답에는 그 반대다.
      // 둘이 같은 소켓으로 나가는데 겹치는 필드가 없다는 것이 계약의 전부다.
      check(
        '반대로 응답에는 event 필드가 없다 (겹치는 판별 필드가 없다)',
        inbox.idless.every((m) => !('event' in m)),
        `${inbox.idless.length}건 확인`,
      );

      ws.close();
      check('종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
    }, { sessions: { createPool: () => fake, heartbeatIntervalMs: 0 } });
  }

  // ── §7-15. 반납이 unsubscribe에 붙잡히지 않는다 ───────
  // #detach는 반납 직전에 워커로 unsubscribe를 **기다리지 않고** 보낸다.
  // 기다리도록 바꾸면(= `void`를 `await`로) 평소에는 아무 증상이 없다 —
  // 워커가 1ms 안에 답하기 때문이다. 증상은 **워커가 굳었을 때만** 나오고,
  // 그때는 requestTimeoutMs(기본 120초)까지 세션이 반납되지 않으며 그 세션을
  // 기다리는 shutdown()이 통째로 붙잡힌다. 즉 회귀해도 조용하다.
  //
  // 그래서 여기서는 **응답하지 않는 워커**와 **거부하는 워커**를 만들어
  // 두 갈래를 결정적으로 고정한다. 실제 워커로는 재현할 수 없는 상태다.
  section('7-15. 굳거나 실패하는 워커가 세션 반납을 막지 않는다 (가짜 세션)');
  {
    // ── ① 응답하지 않는 워커 ───────────────────────────
    const relay = new Relay();
    const pool = new ReusingPool(relay);

    await withScenes(async (gw, addr) => {
      const r = await connect(wsUrlOf(addr));
      const ws = r.ws;
      if (!ws) {
        check('연결 성립', false, `status=${String(r.status)}`);
        return;
      }
      const inbox = new Inbox(ws);
      const sub = await inbox.send({ op: 'subscribe' });
      check('구독해 둔다 (반납 시 unsubscribe가 나갈 조건)', sub?.['ok'] === true, JSON.stringify(sub));

      // 이 시점부터 워커는 어떤 op에도 답하지 않는다.
      relay.hold = true;
      const before = relay.ops.length;
      const t0 = Date.now();
      ws.close();

      const freed = await until(() => gw.sessions.stats.busy === 0, 3_000);
      const ms = Date.now() - t0;
      check(
        '★ 워커가 unsubscribe에 답하지 않아도 세션은 반납된다 (fire-and-forget)',
        freed && ms < 2_000,
        `${ms}ms 만에 busy=${gw.sessions.stats.busy}`,
      );
      check(
        '기다리지 않았을 뿐, unsubscribe는 실제로 워커에 나갔다',
        relay.ops.slice(before).includes('unsubscribe'),
        `종료 후 워커에 닿은 op=[${relay.ops.slice(before).join(',')}]`,
      );

      // 붙잡아 둔 약속을 풀어 준다 — 안 풀면 teardown이 매달릴 수 있다.
      relay.hold = false;
      relay.releaseAll();
    }, { sessions: { createPool: () => pool, heartbeatIntervalMs: 0 } });
  }
  {
    // ── ② 거부하는 워커 ────────────────────────────────
    // 워커가 이미 죽은 뒤에 닫히는 경로(4001)에서는 unsubscribe가 반드시
    // 거부된다. `.catch()`가 빠지면 그 자리가 **처리되지 않은 Promise 거부**가
    // 되어 게이트웨이 프로세스가 통째로 죽는다 — 세션 하나가 끝났다는 이유로.
    const relay = new Relay();
    relay.fail = (op) => (op === 'unsubscribe' ? new Error('워커가 종료됨 (code=1)') : null);
    const pool = new ReusingPool(relay);

    const unhandled: string[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err instanceof Error ? err.message : String(err));
    };
    process.on('unhandledRejection', onUnhandled);

    await withScenes(async (gw, addr) => {
      const r = await connect(wsUrlOf(addr));
      const ws = r.ws;
      if (!ws) {
        check('연결 성립', false, `status=${String(r.status)}`);
        return;
      }
      const inbox = new Inbox(ws);
      check('중계는 정상', (await inbox.send({ op: 'ping' }))?.['ok'] === true);

      ws.close();
      check('종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
      // 거부는 마이크로태스크로 온다. 한 틱 이상 기다려야 잡힌다.
      await new Promise((res) => setTimeout(res, 100));
      check(
        '★ unsubscribe가 거부돼도 처리되지 않은 거부가 생기지 않는다',
        unhandled.length === 0,
        unhandled.join(' | ') || '0건',
      );

      // 게이트웨이가 살아 있는가 — 다음 연결이 그대로 받아진다.
      const r2 = await connect(wsUrlOf(addr));
      check('게이트웨이가 살아남아 다음 연결을 받는다', r2.ws !== null, `status=${String(r2.status)}`);
      r2.ws?.close();
      await until(() => gw.sessions.stats.busy === 0);
    }, { sessions: { createPool: () => pool, heartbeatIntervalMs: 0 } });

    process.off('unhandledRejection', onUnhandled);
  }

  // ── §7-16. 이벤트 경로의 두 경계 ──────────────────────
  section('7-16. on()이 없는 세션 / 연결별 격리');
  {
    // ── ① `on`이 없는 세션도 op 중계는 그대로 돈다 ─────
    // SessionLike.on이 옵셔널인 것의 대가를 여기서 확인한다. FakeSession은
    // EventEmitter라 이 갈래를 절대 밟지 않는다 — 그래서 전용 세션을 쓴다.
    const relay = new Relay();
    const pool = new NoEventPool(relay);

    await withScenes(async (gw, addr) => {
      const r = await connect(wsUrlOf(addr));
      const ws = r.ws;
      if (!ws) {
        check('연결 성립', false, `status=${String(r.status)}`);
        return;
      }
      const inbox = new Inbox(ws);
      const pong = await inbox.send({ op: 'ping' });
      check(
        '★ 이벤트를 못 내는 세션이어도 op 중계는 돈다 (연결이 죽지 않는다)',
        pong?.['ok'] === true,
        JSON.stringify(pong),
      );
      check('이벤트는 당연히 오지 않는다', inbox.events.length === 0, `${inbox.events.length}건`);

      ws.close();
      check('종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
      // 달지 않은 리스너를 떼려 들면 안 된다. exit만 떼는 것이 맞다.
      const s = pool.sessions[0];
      check(
        '달지 않은 frame/engineMessage 리스너를 떼려 하지 않는다',
        s !== undefined && s.offCalls.length === 1 && s.offCalls[0] === 'exit',
        `off된 이벤트=[${(s?.offCalls ?? []).join(',')}]`,
      );
    }, { sessions: { createPool: () => pool, heartbeatIntervalMs: 0 } });
  }
  {
    // ── ② 연결이 둘일 때 서로의 프레임이 섞이지 않는다 ──
    // §7-13은 세션 하나를 **순차로** 물려주는 경우였다. 여기서는 두 세션이
    // **동시에** 살아 있다 — 게이트웨이가 이벤트를 conn 하나가 아니라 열린
    // 소켓 전체로 흘리면 여기서만 드러난다.
    const fake = new FakePool({ relay: new Relay() });

    await withScenes(async (gw, addr) => {
      const r1 = await connect(wsUrlOf(addr));
      const r2 = await connect(wsUrlOf(addr));
      const a = r1.ws;
      const b = r2.ws;
      if (!a || !b) {
        check('연결 2개 성립', false, `${String(r1.status)} / ${String(r2.status)}`);
        return;
      }
      const inboxA = new Inbox(a);
      const inboxB = new Inbox(b);

      // acquire 순서가 곧 연결 순서다 (위에서 순차로 기다렸다).
      const [sA, sB] = [...fake.live];
      if (!sA || !sB) {
        check('세션 2개', false, `${fake.live.size}개`);
        return;
      }

      sA.emit('frame', 11);
      sB.emit('frame', 22);
      await until(() => inboxA.of('frame').length >= 1 && inboxB.of('frame').length >= 1);
      await new Promise((res) => setTimeout(res, 80)); // 새는 것이 있으면 도착할 시간

      check(
        '★ 각 연결은 자기 세션의 프레임만 받는다',
        inboxA.of('frame').length === 1 && inboxA.of('frame')[0]?.['frame'] === 11
        && inboxB.of('frame').length === 1 && inboxB.of('frame')[0]?.['frame'] === 22,
        `A=${JSON.stringify(inboxA.of('frame'))}, B=${JSON.stringify(inboxB.of('frame'))}`,
      );

      // A만 닫는다. B는 계속 받아야 한다 — #detach가 남의 리스너까지 떼면
      // 여기서 B가 조용해진다.
      a.close();
      check('A 종료 → busy 1', await until(() => gw.sessions.stats.busy === 1));
      sB.emit('frame', 33);
      await until(() => inboxB.of('frame').length >= 2);
      check(
        '★ 한쪽을 닫아도 다른 연결의 이벤트는 계속 흐른다',
        inboxB.of('frame').length === 2 && inboxB.of('frame')[1]?.['frame'] === 33,
        JSON.stringify(inboxB.of('frame')),
      );

      b.close();
      check('B 종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
    }, { sessions: { createPool: () => fake, heartbeatIntervalMs: 0 } });
  }

  // ── §9. 백프레셔 latest-wins ──────────────────────────
  // 통과 기준은 단언 **둘**이고, 둘이 함께 서야만 의미가 있다:
  //   ① 중간 프레임이 드롭된다  — 전부 도착하면 흐름 제어가 발화하지 않은 것
  //   ② 최신 프레임이 도착한다  — 드롭만 하면 그냥 막은 것이지 latest-wins가 아니다
  // 하나씩 떼어 놓으면 각각을 자명하게 통과시키는 잘못된 구현이 있다
  // (아무것도 안 보내기 / 전부 보내기). 그래서 아래 세 섹션 전부 짝으로 단언한다.
  //
  // 재현을 **가짜 세션(9-1·9-2)과 실제 워커(9-3)로 둘 다** 한다. 이유가 갈린다:
  //   - 가짜: `frameHighWaterMark: 0`으로 파이프라인 깊이를 1로 만들면 드롭이
  //     확정적으로 난다. 보낸 수·도착 수·버린 수가 정수로 맞아떨어져 회계까지
  //     단언할 수 있다 — 실제 워커로는 프레임 수가 매번 달라 불가능하다.
  //   - 실제: 가짜만 쓰면 "우리가 세운 임계값 앞에서 우리가 만든 이벤트가
  //     멈춘다"만 확인한 것이다. 이 단위가 막으려던 사고는 **실제 1.9MB/s가
  //     안 읽는 소켓에 쌓이는 것**이었으므로, 그 흐름 자체로 한 번 봐야 한다.
  section('9-1. 느린 소비자 → 중간 드롭 + 최신 도착 (가짜 세션, 통과 기준)');
  {
    const pool = new ReusingPool();
    const N = 40;

    await withScenes(async (gw, addr) => {
      const r = await connect(wsUrlOf(addr));
      const ws = r.ws;
      if (!ws) {
        check('연결 성립', false, `status=${String(r.status)}`);
        return;
      }
      const inbox = new Inbox(ws);
      const session = pool.session;

      check(
        '임계값 0으로 열렸다 (보낸 것이 소켓을 빠져나가기 전엔 다음을 안 쓴다)',
        gw.sessions.frameHighWaterMark === 0,
        `frameHighWaterMark=${gw.sessions.frameHighWaterMark}`,
      );

      // 프레임 N건을 **동기 루프**로 몰아넣는다. 소비자는 그 사이 한 바이트도
      // 읽지 못한다(이벤트 루프가 이 루프에 잡혀 있다) — 이것이 "느린 소비자"다.
      // engineMessage를 사이사이 끼우는 건 정책이 갈렸는지 같이 보기 위해서다.
      const mesh = bulkyMesh();
      for (let i = 1; i <= N; i++) {
        session.emit('frame', i, mesh);
        session.emit('engineMessage', `m${i}`);
      }

      // 버스트 직후 = 드레인이 한 번도 안 돈 순간. 여기서 이미 버려져 있어야 한다.
      const mid = gw.sessions.connections[0];
      check(
        '버스트 직후 이미 드롭이 났고 보류 칸이 차 있다',
        (mid?.droppedFrames ?? 0) > 0 && mid?.pendingFrame === true,
        `droppedFrames=${String(mid?.droppedFrames)}, pendingFrame=${String(mid?.pendingFrame)}, bufferedBytes=${String(mid?.bufferedBytes)}`,
      );

      const arrived = await until(() => frameNos(inbox).includes(N), 8_000);
      // 최신 프레임 뒤에 뒤늦게 오는 것이 있으면 회계가 틀어진다. 확인차 더 기다린다.
      await new Promise((res) => setTimeout(res, 200));

      const got = frameNos(inbox);
      const conn = gw.sessions.connections[0];
      const dropped = conn?.droppedFrames ?? -1;

      check(
        `★ ① 중간 프레임이 드롭된다 (${N}건을 밀었는데 전부 도착하지 않는다)`,
        dropped > 0 && got.length < N,
        `도착 ${got.length}/${N}건, droppedFrames=${dropped}, 도착 번호=[${got.join(',')}]`,
      );
      check(
        '★ ② 최신 프레임이 도착한다 (마지막에 밀어 넣은 것이 마지막으로 온다)',
        arrived && got[got.length - 1] === N,
        `마지막 도착=${String(got[got.length - 1])}, 기대=${N}`,
      );
      // ★ 이 회계가 ①·②를 한꺼번에 조인다. 도착도 아니고 드롭도 아닌 프레임이
      //   있으면(= 조용히 사라졌으면) 여기서만 드러난다. 소켓이 열려 있으므로
      //   unsentEvents로 새는 경로도 없어야 한다.
      check(
        '★ 회계가 맞는다: 도착 + 버림 = 보낸 수, 그리고 안 보낸 것은 없다',
        got.length + dropped === N && conn?.unsentEvents === 0,
        `${got.length} + ${dropped} = ${got.length + dropped} (기대 ${N}), unsentEvents=${String(conn?.unsentEvents)}`,
      );
      check(
        '보류 칸은 큐가 아니다 — 도착한 프레임 번호가 역행하지 않는다',
        got.every((v, i) => i === 0 || v > (got[i - 1] as number)),
        `[${got.join(',')}]`,
      );
      check(
        '★ engineMessage는 드롭 대상이 아니다 (같은 버스트에서 전부 도착)',
        inbox.of('engineMessage').length === N,
        `${inbox.of('engineMessage').length}/${N}건`,
      );
      check(
        '드레인이 끝나면 보류 칸이 빈다 (48KB짜리가 매달려 남지 않는다)',
        conn?.pendingFrame === false,
        `pendingFrame=${String(conn?.pendingFrame)}`,
      );

      // 흐름이 멎었다가 회복되면 다시 정상으로 흐른다 — 한 번 드롭이 났다고
      // 그 연결이 영영 절름발이가 되면 안 된다.
      const afterBurst = frameNos(inbox).length;
      const droppedBefore = dropped;
      session.emit('frame', 999, mesh);
      await until(() => frameNos(inbox).length > afterBurst, 4_000);
      check(
        '회복 후의 프레임은 그냥 통과한다 (드롭이 눌러앉지 않는다)',
        frameNos(inbox).at(-1) === 999
        && (gw.sessions.connections[0]?.droppedFrames ?? -1) === droppedBefore,
        `마지막=${String(frameNos(inbox).at(-1))}, droppedFrames=${String(gw.sessions.connections[0]?.droppedFrames)} (버스트 직후 ${droppedBefore})`,
      );

      ws.close();
      check('종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
    }, { sessions: { createPool: () => pool, frameHighWaterMark: 0, heartbeatIntervalMs: 0 } });
  }

  // ── §9-2. 대조군 ──────────────────────────────────────
  // 9-1의 ①은 "드롭이 났다"인데, 드롭이 **언제나** 나는 구현이면 그 단언은
  // 아무것도 안 지킨다. 그래서 반대쪽을 두 방향으로 고정한다:
  //   A. 소비자가 제때 읽으면 (운영 기본 임계값) 한 건도 안 버린다
  //   B. 같은 버스트라도 임계값이 충분히 크면 한 건도 안 버린다
  // B가 특히 중요하다 — 9-1에서 프레임이 사라진 원인이 "버스트"나 "가짜
  // 세션"이 아니라 **임계값을 넘긴 것**임을 이것만이 가른다.
  section('9-2. 대조군 — 안 버려야 할 때는 안 버린다');
  {
    const pool = new ReusingPool();
    const M = 10;
    await withScenes(async (gw, addr) => {
      const r = await connect(wsUrlOf(addr));
      const ws = r.ws;
      if (!ws) {
        check('연결 성립', false, `status=${String(r.status)}`);
        return;
      }
      const inbox = new Inbox(ws);
      const mesh = bulkyMesh();

      check(
        '운영 기본값으로 열렸다 (임계값 > 0)',
        gw.sessions.frameHighWaterMark > 0,
        `frameHighWaterMark=${gw.sessions.frameHighWaterMark}`,
      );

      // 한 건씩, 도착을 확인하고 다음을 보낸다 = 밀리지 않는 클라이언트.
      for (let i = 1; i <= M; i++) {
        pool.session.emit('frame', i, mesh);
        await until(() => frameNos(inbox).length >= i, 4_000);
      }
      const conn = gw.sessions.connections[0];
      check(
        '★ A. 제때 읽는 클라이언트에서는 한 건도 버려지지 않는다',
        conn?.droppedFrames === 0 && frameNos(inbox).length === M,
        `도착 ${frameNos(inbox).length}/${M}건, droppedFrames=${String(conn?.droppedFrames)}`,
      );
      check(
        '건강한 흐름에서 보류 칸이 비어 있다 (정상 지터에 반응하지 않는다)',
        conn?.pendingFrame === false,
        `pendingFrame=${String(conn?.pendingFrame)}, bufferedBytes=${String(conn?.bufferedBytes)}`,
      );

      ws.close();
      check('종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
    }, { sessions: { createPool: () => pool, heartbeatIntervalMs: 0 } });
  }
  {
    const pool = new ReusingPool();
    const N = 40;
    await withScenes(async (gw, addr) => {
      const r = await connect(wsUrlOf(addr));
      const ws = r.ws;
      if (!ws) {
        check('연결 성립', false, `status=${String(r.status)}`);
        return;
      }
      const inbox = new Inbox(ws);
      const mesh = bulkyMesh();
      for (let i = 1; i <= N; i++) pool.session.emit('frame', i, mesh);

      const all = await until(() => frameNos(inbox).length >= N, 8_000);
      check(
        '★ B. 임계값이 충분히 크면 같은 버스트가 한 건도 안 버려진다',
        all && (gw.sessions.connections[0]?.droppedFrames ?? -1) === 0,
        `도착 ${frameNos(inbox).length}/${N}건, droppedFrames=${String(gw.sessions.connections[0]?.droppedFrames)}`,
      );
      check(
        '순서도 그대로다 (1..N)',
        frameNos(inbox).every((v, i) => v === i + 1),
        `첫 5건=[${frameNos(inbox).slice(0, 5).join(',')}], 마지막=${String(frameNos(inbox).at(-1))}`,
      );

      ws.close();
      check('종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
    }, { sessions: { createPool: () => pool, frameHighWaterMark: 64 * 1024 * 1024, heartbeatIntervalMs: 0 } });
  }

  // ── §9-3. 진짜 느린 소비자 ────────────────────────────
  // 여기서만 확인되는 것: **실제 1.9MB/s**가 실제로 막히는가. 클라이언트
  // 소켓을 pause()하면 TCP 수신 창이 닫히고, 커널 버퍼가 찬 뒤부터
  // `ws.bufferedAmount`가 오른다 — 실측 사고(30초에 RSS +121MB)와 같은 모양의
  // 상황을 재현한 것이다. 이 섹션이 운영 기본 임계값을 쓰는 이유가 그것이다.
  //
  // 대신 여기서는 회계를 못 단언한다(워커가 몇 프레임을 냈는지 모른다).
  // 그 몫은 9-1이 진다. 여기서 세우는 건 방향뿐이다: 드롭이 나는가, 재개하면
  // 최신이 오는가, engineMessage는 살아남는가.
  section('9-3. 진짜 느린 소비자 (실제 워커, 소켓 읽기를 멈춘다)');
  {
    const traced = new TracingPool(new SessionPool({
      exePath: defaultWorkerExe(),
      idleTimeout: 0,
      maxTotal: 1,
      onLog: () => {},
    }));

    await withScenes(async (gw, addr) => {
      if (!existsSync(SAMPLE_ZLS)) {
        check('sample.zls 존재 — 실제 흐름 재현에는 진짜 씬이 필요하다', false, SAMPLE_ZLS);
        return;
      }
      const sceneId = await plantScene(gw.scenes);

      const r = await connect(wsUrlOf(addr));
      const ws = r.ws;
      strayPids.push(...traced.pids);
      if (!ws) {
        check('연결 성립', false, `status=${String(r.status)}, error=${String(r.error)}`);
        return;
      }
      const pid = traced.pids[0];
      const inbox = new Inbox(ws);

      const loaded = await inbox.send({ op: 'load', scene: sceneId });
      check('load(sample.zls) 성공', loaded?.['ok'] === true, JSON.stringify(loaded).slice(0, 120));
      check('start 성공', (await inbox.send({ op: 'start' }))?.['ok'] === true);
      check(
        'subscribe 성공 (프레임당 약 48KB가 흐르기 시작한다)',
        (await inbox.send({ op: 'subscribe' }))?.['ok'] === true,
      );

      const flowing = await until(
        () => inbox.events.filter((e) => e['event'] === 'frame' && 'mesh' in e).length >= 3,
        8_000,
      );
      check('메시가 실린 프레임이 흐른다 (재현의 전제)', flowing, `${inbox.of('frame').length}건`);

      // ── 소비자가 읽기를 멈춘다 ──────────────────────────
      const maxBefore = Math.max(0, ...frameNos(inbox));
      const framesBefore = frameNos(inbox).length;
      ws.pause();

      const fired = await until(
        () => (gw.sessions.connections[0]?.droppedFrames ?? 0) > 0,
        8_000,
      );
      check(
        '★ ① 실제 흐름에서도 소켓을 안 읽으면 프레임이 버려진다',
        fired,
        `droppedFrames=${String(gw.sessions.connections[0]?.droppedFrames)}`,
      );

      // 버려지기 시작한 뒤에도 계속 안 읽는다. 큐라면 여기서 무한히 자란다.
      await new Promise((res) => setTimeout(res, 800));
      const paused = gw.sessions.connections[0];
      const bufKB = Math.round((paused?.bufferedBytes ?? 0) / 1024);
      check(
        '★ 안 읽는 동안 소켓 버퍼가 무한히 자라지 않는다 (칸 하나, 큐가 아니다)',
        (paused?.bufferedBytes ?? Number.POSITIVE_INFINITY) < 1024 * 1024,
        `bufferedAmount=${bufKB}KB — 흐름을 그대로 쌓았다면 초당 1.9MB였다`,
      );
      note(
        '일시정지 구간 요약',
        `droppedFrames=${String(paused?.droppedFrames)}, pendingFrame=${String(paused?.pendingFrame)}, unsentEvents=${String(paused?.unsentEvents)}`,
      );

      // ── 다시 읽기 시작한다 ──────────────────────────────
      ws.resume();
      const advanced = await until(() => Math.max(0, ...frameNos(inbox)) > maxBefore, 8_000);
      const got = frameNos(inbox);
      check(
        '★ ② 재개하면 최신 프레임이 도착한다 (옛 화면에서 굳지 않는다)',
        advanced,
        `멈추기 전 최대 ${maxBefore} → 재개 후 최대 ${Math.max(0, ...got)}`,
      );
      // 밀린 것을 전부 토해내면 latest-wins가 아니라 그냥 지연 큐다.
      // 워커가 낸 프레임 수는 모르지만, engineMessage가 그 대용이다 —
      // 같은 주기로 나오는데 버리지 않기 때문이다.
      const engineMsgs = inbox.of('engineMessage').length;
      check(
        '★ ③ 프레임은 버려졌는데 engineMessage는 살아남았다 (진단이 사라지지 않는다)',
        engineMsgs > got.length,
        `engineMessage ${engineMsgs}건 vs frame ${got.length}건 (멈추기 전 frame ${framesBefore}건)`,
      );
      const gaps = got.filter((v, i) => i > 0 && v - (got[i - 1] as number) > 1).length;
      note('도착한 프레임 번호의 구멍', `${gaps}곳 — 마지막 8건=[${got.slice(-8).join(',')}]`);

      ws.close();
      check('구독 중 종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
      check(
        '워커 프로세스도 사라진다 (백프레셔가 걸린 채 닫았어도)',
        pid !== undefined && await until(async () => !(await pidAlive(pid))),
        `pid=${String(pid)}`,
      );
    }, { sessions: { createPool: () => traced, heartbeatIntervalMs: 0 } });
  }

  // ── §10-1. export → 다운로드 → 바이트 일치 ─────────────
  // TASKS.json #10의 통과 기준 한 줄이 이 섹션이다:
  // **"세션에서 export 실행 → 그 파일이 HTTP로 받아지고 바이트가 일치"**.
  //
  // ★ 여기만 실제 워커를 쓴다. 기준의 주어가 "그 파일"이라 가짜로는 답할 수
  //   없는 것이 둘이기 때문이다: (1) 엔진이 정말 산출물을 쓰는가, (2) 게이트웨이가
  //   워커에 넘긴 경로와 다운로드가 읽는 경로가 같은 파일인가. 가짜 릴레이는
  //   그 경로에 자기가 쓰므로 (2)를 스스로 참으로 만든다 — 순환이다.
  //
  //   대신 **익스포트는 딱 한 번만 한다**(실측 1.5초, 9.7MB). 상한·폐기·형식
  //   같은 정책은 같은 파일을 몇 번 더 뽑아야 확인되는데, 그건 §10-3이 가짜
  //   릴레이로 대신한다 — 그쪽이 검증하는 것은 엔진이 아니라 게이트웨이의
  //   장부이므로 진짜 9.7MB가 필요 없다.
  //
  // "바이트가 일치"의 판정은 **길이 + sha256**이다. 전체 비교(memcmp)와 같은
  // 강도이면서 실패했을 때 로그에 9.7MB를 쏟지 않는다. 크기만 보는 것은
  // 부족하다 — 응답 조립이 잘못돼 다른 파일을 같은 크기로 내주는 회귀를
  // (그리고 인코딩이 섞여 바이트가 바뀌는 경우를) 통과시킨다.
  section('10-1. 세션 export → HTTP 다운로드 → 바이트 일치 (실제 워커, 통과 기준)');
  {
    const traced = new TracingPool(new SessionPool({
      exePath: defaultWorkerExe(),
      idleTimeout: 0,
      maxTotal: 1,
      onLog: () => {},
    }));

    await withExportDir((expDir) => withScenes(async (gw, addr) => {
      if (!existsSync(SAMPLE_ZLS)) {
        check('sample.zls 존재 — 통과 기준에는 진짜 씬이 필요하다', false, SAMPLE_ZLS);
        return;
      }
      const sceneId = await plantScene(gw.scenes);

      const r = await connect(wsUrlOf(addr));
      const ws = r.ws;
      strayPids.push(...traced.pids);
      if (!ws) {
        check('연결 성립', false, `status=${String(r.status)}, error=${String(r.error)}`);
        return;
      }
      const pid = traced.pids[0];
      const inbox = new Inbox(ws);

      check(
        '익스포트 디렉토리가 비어 있다 (이 섹션이 세는 것의 출발점)',
        (await filesIn(expDir)).length === 0,
        (await filesIn(expDir)).join(',') || '0개',
      );

      const loaded = await inbox.send({ op: 'load', scene: sceneId }, 20_000);
      check(
        'load(sample.zls) 성공',
        loaded?.['ok'] === true && isRecord(loaded['result']) && loaded['result']['loaded'] === true,
        JSON.stringify(loaded).slice(0, 160),
      );

      // ── ① 세션에서 export ──────────────────────────────
      // 클라이언트가 보내는 것은 op 하나뿐이다. format 기본값(gltf)도 함께 본다.
      const t0 = performance.now();
      const rep = await inbox.send({ op: 'export' }, 20_000);
      const ms = Math.round(performance.now() - t0);
      const rec = isRecord(rep?.['result']) ? rep['result'] : null;
      const id = String(rec?.['id'] ?? '');
      check(
        '★ export 성공 → { id, url, bytes, name, format } (통과 기준 전반부)',
        rep?.['ok'] === true && /^[0-9a-f]{32}$/.test(id)
        && rec?.['url'] === `/api/exports/${id}`
        && rec['format'] === 'gltf'
        && typeof rec['bytes'] === 'number' && (rec['bytes'] as number) > 0,
        `${ms}ms, ${JSON.stringify(rec).slice(0, 200)}`,
      );
      // 파일명은 **열린 씬**에서 따온다(sample.zls → sample.gltf). 경로가 아니라
      // 헤더 값이므로 아래 Content-Disposition에서 다시 확인한다.
      check(
        '다운로드 이름이 열린 씬에서 온다 (sample.zls → sample.gltf)',
        rec?.['name'] === 'sample.gltf',
        String(rec?.['name']),
      );
      // ★ 워커는 `{path, format}`을 돌려준다. 그 절대경로가 응답에 실리면
      //   #5·#7이 세운 "경로는 밖으로 안 나간다"가 이 op에서 무너진다.
      check(
        '응답에 서버 경로가 없다 (path 필드도, 드라이브 문자도)',
        rec !== null && !('path' in rec) && !leaksPath(JSON.stringify(rep), expDir),
        JSON.stringify(rep).slice(0, 200),
      );

      // 디스크에는 본체와 사이드카 둘뿐이다. glTF는 보통 `.bin`을 곁에 남기는데
      // 이 익스포트는 **단일 파일**이고(Builder 실측), 정리 정책 전체가 그
      // 전제 위에 서 있다 — 짝 파일이 생기기 시작하면 discard가 본체만 지운다.
      const onDisk = await filesIn(expDir);
      check(
        '디스크에 `<id>.gltf` + `<id>.json` 둘뿐이다 (.bin 짝 파일이 없다)',
        onDisk.length === 2 && onDisk.includes(`${id}.gltf`) && onDisk.includes(`${id}.json`),
        onDisk.join(', '),
      );

      // ── ② HTTP로 받는다 ────────────────────────────────
      const url = `${addr.url}/api/exports/${id}`;
      const got = await download(url);
      check(
        'GET /api/exports/:id → 200',
        got.status === 200,
        `status=${got.status}, ${got.text.slice(0, 120)}`,
      );
      check(
        'Content-Type이 glTF (확장자 추측이 아니라 서버가 정한 값)',
        got.type.startsWith('model/gltf+json'),
        got.type,
      );
      check(
        '첨부로 내려온다 — Content-Disposition: attachment; filename="sample.gltf"',
        got.disposition.includes('attachment') && got.disposition.includes('sample.gltf'),
        got.disposition,
      );
      // 수명이 짧고 언제든 사라지는 자원이다. 중간 캐시가 들고 있으면
      // "지웠는데 받아진다"가 된다.
      check(
        '캐시 금지 (private, no-store)',
        got.cache.includes('no-store') && got.cache.includes('private'),
        got.cache,
      );

      // ── ③ ★ 바이트가 일치한다 ──────────────────────────
      const diskPath = gw.exports.pathOf(id, 'gltf');
      const disk = await readFile(diskPath);
      check(
        '★ 받은 바이트 = 디스크의 산출물 (길이와 sha256이 모두 같다, 통과 기준 후반부)',
        got.bytes.length === disk.length && sha256(got.bytes) === sha256(disk),
        `${got.bytes.length}바이트, sha256=${sha256(got.bytes).slice(0, 16)}… `
        + `(디스크 ${disk.length}바이트 ${sha256(disk).slice(0, 16)}…)`,
      );
      check(
        '응답의 bytes 필드가 실제 길이와 같다 (클라이언트가 진행률을 믿을 수 있다)',
        rec?.['bytes'] === got.bytes.length,
        `${String(rec?.['bytes'])} vs ${got.bytes.length}`,
      );
      // 크기와 해시만 보면 "엔진이 쓰레기를 9.7MB 썼다"도 통과한다. 받은
      // 바이트를 그대로 파싱해 glTF 2.0 문서인지 본다 — 브라우저의 GLTFLoader가
      // 하는 일과 같고(#10의 소비자가 그것이다), 9.7MB 파싱은 100ms 남짓이다.
      let gltf: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(Buffer.from(got.bytes).toString('utf8'));
        gltf = isRecord(parsed) ? parsed : null;
      } catch {
        gltf = null;
      }
      const asset = isRecord(gltf?.['asset']) ? gltf['asset'] : null;
      check(
        '내용이 실제 glTF 2.0 문서다 (asset.version + 메시가 들어 있다)',
        asset?.['version'] === '2.0'
        && Array.isArray(gltf?.['meshes']) && (gltf['meshes'] as unknown[]).length > 0,
        gltf === null
          ? 'JSON 파싱 실패'
          : `asset=${JSON.stringify(asset)}, meshes=${String((gltf['meshes'] as unknown[] | undefined)?.length)}, `
            + `keys=${Object.keys(gltf).join(',')}`,
      );

      // ── ④ 다운로드는 산출물을 소모하지 않는다 ───────────
      // 브라우저가 두 번 클릭하는 것은 정상이고, 여기서 파일이 사라지면
      // "한 번만 받아지는" 서비스가 된다.
      const again = await download(url);
      check(
        '같은 URL을 다시 받아도 같은 바이트 (다운로드가 파일을 소모하지 않는다)',
        again.status === 200 && sha256(again.bytes) === sha256(got.bytes),
        `status=${again.status}, ${again.bytes.length}바이트`,
      );

      // ── ⑤ 세션이 끝나도 산출물은 남는다 ────────────────
      // 다운로드는 WS가 아니라 HTTP로 일어난다. 연결이 끊기는 순간 지우면
      // 브라우저가 받는 도중에 사라진다 (files.ts의 명시적 결정).
      ws.close();
      check('종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
      const afterClose = await download(url);
      check(
        '세션이 끝난 뒤에도 같은 바이트가 받아진다 (수명은 연결이 아니라 TTL)',
        afterClose.status === 200 && sha256(afterClose.bytes) === sha256(got.bytes),
        `status=${afterClose.status}, ${afterClose.bytes.length}바이트`,
      );
      check(
        '워커 프로세스는 사라진다',
        pid !== undefined && await until(async () => !(await pidAlive(pid))),
        `pid=${String(pid)}`,
      );
      note('실측', `export ${ms}ms, ${got.bytes.length}바이트`);
    }, { exportDir: expDir, sessions: { createPool: () => traced, heartbeatIntervalMs: 0 } }));
  }

  // ── §10-2. 무엇이 워커에 닿고 무엇이 밖으로 나가는가 ───
  // §10-1이 "된다"를 봤다면 여기는 **경로**를 본다. export는 이 프로토콜에서
  // 게이트웨이가 디스크에 쓰는 유일한 op이라, 클라이언트 문자열이 경로에
  // 닿는 순간이 곧 임의 파일 쓰기다. 가짜 릴레이를 쓰는 이유는 §7-10과 같다 —
  // 막혔다는 것을 응답이 아니라 **`relay.calls`(워커에 닿지 않았다)**로 판정할 수 있다.
  section('10-2. export 경로 방어와 다운로드 라우트 (가짜 릴레이)');
  {
    const relay = new Relay();
    const fake = new FakePool({ relay });
    await withExportDir((expDir) => withScenes(async (gw, addr) => {
      exportingRelay(relay);
      const sceneId = String(
        sceneOf(await upload(addr, 'my dress.zls', new TextEncoder().encode('zls')))?.['id'] ?? '',
      );
      const r = await connect(wsUrlOf(addr, `?scene=${sceneId}`));
      const ws = r.ws;
      if (!ws) {
        check('연결 성립', false, `status=${String(r.status)}`);
        return;
      }
      const inbox = new Inbox(ws);
      await inbox.send({ op: 'load', scene: sceneId });

      // ── ① 워커에 가는 payload ──────────────────────────
      relay.reset();
      const ok = await inbox.send({ op: 'export' });
      const call = relay.last();
      const p = String(call?.payload?.['path'] ?? '');
      check(
        '워커에 가는 payload는 { path, format } 둘뿐이다',
        call?.op === 'export' && call.payload !== undefined
        && Object.keys(call.payload).sort().join(',') === 'format,path',
        JSON.stringify(call?.payload && Object.keys(call.payload)),
      );
      check(
        '그 path는 서버가 만든 것이다 — 익스포트 디렉토리 안의 `<32자리 hex>.gltf`',
        p.startsWith(path.resolve(expDir) + path.sep)
        && /^[0-9a-f]{32}\.gltf$/.test(path.basename(p)),
        p,
      );
      check(
        '이름은 사이드카에만 있다 — 디스크 파일명은 씬 이름이 아니다',
        !path.basename(p).includes('dress')
        && isRecord(ok?.['result']) && ok['result']['name'] === 'my dress.gltf',
        `${path.basename(p)} / ${String(isRecord(ok?.['result']) ? ok['result']['name'] : '')}`,
      );

      // ── ② 클라이언트 경로는 거부된다 (무시가 아니라) ────
      // 무시하면 클라이언트는 자기가 지정한 곳에 파일이 생겼다고 믿는다.
      const before = await filesIn(expDir);
      relay.reset();
      const evil = await inbox.send({ op: 'export', path: 'C:\\Windows\\evil.gltf' });
      check(
        'export{path} → 거부 + 워커 미도달',
        evil?.['ok'] === false && String(evil['error']).includes('path') && relay.calls.length === 0,
        `${String(evil?.['error'])} / 도달 ${relay.calls.length}건`,
      );

      // 형식은 표에 있는 두 값뿐이다. 여기가 확장자가 경로에 들어가는 유일한
      // 통로라, 표에 없는 문자열이 통과하면 확장자로 경로를 조작할 수 있다.
      for (const bad of ['exe', '../../x', '.gltf', 'GLTF', '']) {
        relay.reset();
        const rej = await inbox.send({ op: 'export', format: bad });
        check(
          `format=${JSON.stringify(bad)} → 거부 + 워커 미도달`,
          rej?.['ok'] === false && relay.calls.length === 0,
          `${String(rej?.['error']).slice(0, 60)} / 도달 ${relay.calls.length}건`,
        );
      }
      relay.reset();
      const notString = await inbox.send({ op: 'export', format: 123 });
      check(
        'format이 문자열이 아니면 거부 + 워커 미도달',
        notString?.['ok'] === false && relay.calls.length === 0,
        String(notString?.['error']).slice(0, 60),
      );
      check(
        '거부 6번 동안 익스포트 저장소가 그대로다 (반쪽 파일도 안 생긴다)',
        (await filesIn(expDir)).join(',') === before.join(','),
        `${before.length}개 → ${(await filesIn(expDir)).length}개`,
      );

      // ── ③ 워커 실패 문구에 서버 경로가 실려도 새지 않는다 ──
      // export는 우리가 만든 절대경로를 워커에 **넘기는** op이라, 실패 문구에
      // 그 경로가 실릴 확률이 load보다 높다(bridge의 redact가 #10에서
      // 익스포트 디렉토리를 그물에 추가한 이유).
      relay.fail = (op, payload) =>
        op === 'export' ? new Error(`파일을 열지 못했습니다: ${String(payload?.['path'])}`) : null;
      const failed = await inbox.send({ op: 'export' });
      const failMsg = String(failed?.['error'] ?? '');
      check(
        '워커 실패 문구에서 익스포트 경로가 지워진다',
        failed?.['ok'] === false && !leaksPath(failMsg, path.resolve(expDir)),
        failMsg.slice(0, 120),
      );
      check(
        '그래도 엔진의 진단은 남는다 (뭉개지 않는다)',
        failMsg.includes('열지 못했습니다'),
        failMsg.slice(0, 120),
      );
      relay.fail = () => null;

      // ── ④ zbin도 같은 길을 지난다 ──────────────────────
      const zb = await inbox.send({ op: 'export', format: 'zbin' });
      const zrec = isRecord(zb?.['result']) ? zb['result'] : null;
      const zdl = await download(`${addr.url}${String(zrec?.['url'])}`);
      check(
        'format=zbin → .zbin 산출물, content-type은 octet-stream',
        zrec?.['format'] === 'zbin' && zrec['name'] === 'my dress.zbin'
        && zdl.status === 200 && zdl.type.startsWith('application/octet-stream'),
        `${String(zrec?.['name'])} / ${zdl.type}`,
      );

      // ── ⑤ 씬을 안 열었으면 이름만 떨어진다 (익스포트는 된다) ──
      const solo = await connect(wsUrlOf(addr));
      if (solo.ws) {
        const soloBox = new Inbox(solo.ws);
        const anon = await soloBox.send({ op: 'export' });
        check(
          '열린 씬이 없어도 익스포트는 막히지 않는다 — 이름만 export.gltf로 떨어진다',
          anon?.['ok'] === true && isRecord(anon['result']) && anon['result']['name'] === 'export.gltf',
          JSON.stringify(isRecord(anon?.['result']) ? anon['result']['name'] : anon),
        );
        solo.ws.close();
      }

      // ── ⑥ 다운로드 라우트 자체의 방어 ──────────────────
      // `/api/exports/:id`는 **요청 파라미터가 경로 조립에 직접 닿는** 첫
      // 라우트다. 32자리 hex가 아니면 pathOf를 부르지도 않아야 한다.
      const goodId = String(zrec?.['id'] ?? '');
      const BAD: Array<[string, string]> = [
        ['abc', '너무 짧다'],
        ['..%2f..%2fscenes', 'traversal'],
        ['%2e%2e%5c%2e%2e%5cwin.ini', '역슬래시 traversal'],
        [`${goodId}.json`, '사이드카 직접 조회'],
        [goodId.toUpperCase(), '대문자 hex (표기가 하나여야 한다)'],
        [`${goodId}%00.gltf`, 'NUL 주입'],
      ];
      for (const [bad, why] of BAD) {
        const res = await download(`${addr.url}/api/exports/${bad}`);
        check(
          `잘못된 id(${why}) → 400, 본문은 JSON`,
          res.status === 400 && errorOf(res.text) !== '',
          `status=${res.status}, ${res.text.slice(0, 80)}`,
        );
        check(
          `그 거절에 서버 경로가 없다 (${why})`,
          !leaksPath(res.text, path.resolve(expDir)),
          res.text.slice(0, 100),
        );
      }
      const missing = await download(`${addr.url}/api/exports/${'0'.repeat(32)}`);
      check(
        '없는 id → 404 (만료·상한·실패를 구분해 주지 않는다)',
        missing.status === 404 && !leaksPath(missing.text, path.resolve(expDir)),
        `status=${missing.status}, ${missing.text.slice(0, 100)}`,
      );
      // 목록 라우트를 **일부러 두지 않았다** — 인증이 없어 id가 곧 권한이므로
      // 목록은 다른 세션의 산출물을 그대로 내주는 것과 같다. 나중에 대칭을
      // 맞추려는 손이 오면 여기가 먼저 깨진다.
      const listing = await download(`${addr.url}/api/exports`);
      check(
        '목록 라우트는 없다 (GET /api/exports → 404)',
        listing.status === 404,
        `status=${listing.status}`,
      );

      ws.close();
      check('종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
    }, { exportDir: expDir, sessions: { createPool: () => fake, heartbeatIntervalMs: 0 } }));
  }

  // ── §10-3. 정리 정책 ──────────────────────────────────
  // 산출물은 9.7~36.5MB다. 지우는 규칙 없이 열면 기능이 아니라 디스크 고갈
  // 경로가 하나 생긴다. 세 겹(세션당 상한 / TTL / 실패 즉시 폐기)을 각각 본다.
  //
  // ★ **값이 아니라 행동에 단언한다.** 기본값(4개, 30분)을 여기 적어 두면
  //   운영 판단이 바뀔 때마다 테스트가 깨지고, 정작 "밀려난 것이 지워지는가"는
  //   확인하지 않게 된다. 그래서 상한 2·수명 몇 초로 **구성해 놓고** 그
  //   구성에서 무슨 일이 일어나는지만 본다.
  section('10-3. 정리 정책 — 세션당 상한 · 실패 폐기 · 기동 시 회수 (가짜 릴레이)');
  {
    const relay = new Relay();
    const fake = new FakePool({ relay });
    await withExportDir((expDir) => withScenes(async (gw, addr) => {
      exportingRelay(relay);
      const dl = async (u: unknown): Promise<number> =>
        (await download(`${addr.url}${String(u)}`)).status;

      const a = await connect(wsUrlOf(addr));
      if (!a.ws) {
        check('연결 성립', false, `status=${String(a.status)}`);
        return;
      }
      const boxA = new Inbox(a.ws);
      const urlsA: string[] = [];
      for (let i = 0; i < 2; i++) {
        const rep = await boxA.send({ op: 'export' });
        urlsA.push(String(isRecord(rep?.['result']) ? rep['result']['url'] : ''));
      }
      check(
        '상한 안에서는 둘 다 살아 있다',
        (await dl(urlsA[0])) === 200 && (await dl(urlsA[1])) === 200,
        urlsA.join(' '),
      );

      // 상한을 넘긴다. 밀려나는 것은 **가장 오래된 것**이고, 밀려남 = 즉시 삭제다.
      const third = await boxA.send({ op: 'export' });
      const url3 = String(isRecord(third?.['result']) ? third['result']['url'] : '');
      check(
        '★ 상한을 넘기면 가장 오래된 것이 밀려나 404가 된다',
        (await dl(urlsA[0])) === 404,
        `첫 번째=${await dl(urlsA[0])}, 두 번째=${await dl(urlsA[1])}, 세 번째=${await dl(url3)}`,
      );
      check(
        '밀려난 것만 사라진다 (나머지는 그대로 받아진다)',
        (await dl(urlsA[1])) === 200 && (await dl(url3)) === 200,
        `${urlsA[1]} ${url3}`,
      );
      // 사이드카만 지우고 본체를 남기면 디스크는 그대로 찬다.
      check(
        '밀려난 것은 본체까지 지워진다 (남은 2건 × 2파일 = 4개)',
        (await filesIn(expDir)).length === 4,
        (await filesIn(expDir)).join(', '),
      );

      // ── 상한은 **연결별**이다. 남의 산출물을 지우면 안 된다 ──
      const b = await connect(wsUrlOf(addr));
      if (b.ws) {
        const boxB = new Inbox(b.ws);
        for (let i = 0; i < 3; i++) await boxB.send({ op: 'export' });
        check(
          '★ 다른 연결이 상한을 넘겨도 내 산출물은 안 지워진다 (자기 것만 센다)',
          (await dl(urlsA[1])) === 200 && (await dl(url3)) === 200,
          `A의 남은 2건: ${await dl(urlsA[1])}, ${await dl(url3)}`,
        );
        b.ws.close();
      }

      // ── 실패 즉시 폐기 ─────────────────────────────────
      // 워커가 반쯤 쓰다 실패하면 아무도 못 받는 수십 MB가 남는다.
      const beforeFail = (await filesIn(expDir)).length;
      relay.fail = (op) => (op === 'export' ? new Error('엔진 익스포트 실패') : null);
      const failed = await boxA.send({ op: 'export' });
      check(
        '★ 워커가 실패하면 반쯤 쓰인 파일이 즉시 사라진다',
        failed?.['ok'] === false && (await filesIn(expDir)).length === beforeFail,
        `${beforeFail}개 → ${(await filesIn(expDir)).length}개, ${String(failed?.['error'])}`,
      );
      relay.fail = () => null;

      // ── 워커가 "썼다"고 답하고 안 썼다 ─────────────────
      // protocol.cpp:606의 ExportGltf는 반환값을 확인하지 않아 실패해도
      // ok:true가 나간다. 게이트웨이가 stat 하지 않으면 클라이언트가 URL을
      // 받아 404를 만나고, 실패가 한 단계 뒤로 밀려 원인을 못 짚는다.
      exportingRelay(relay, null);
      const ghost = await boxA.send({ op: 'export' });
      check(
        '★ 워커가 ok라 해도 파일이 없으면 실패로 답한다 (URL을 주지 않는다)',
        ghost?.['ok'] === false && String(ghost['error']).includes('만들어지지 않았습니다'),
        JSON.stringify(ghost).slice(0, 140),
      );
      check(
        '그 실패 문구에 서버 경로가 없다',
        !leaksPath(String(ghost?.['error'] ?? ''), path.resolve(expDir)),
        String(ghost?.['error']),
      );

      // ── 0바이트 산출물 ─────────────────────────────────
      const beforeEmpty = (await filesIn(expDir)).length;
      exportingRelay(relay, '');
      const empty = await boxA.send({ op: 'export' });
      check(
        '0바이트 산출물은 성공으로 치지 않고 지운다',
        empty?.['ok'] === false && String(empty['error']).includes('비어 있습니다')
        && (await filesIn(expDir)).length === beforeEmpty,
        `${String(empty?.['error'])}, ${beforeEmpty}개 → ${(await filesIn(expDir)).length}개`,
      );

      a.ws.close();
      check('종료 → busy 0', await until(() => gw.sessions.stats.busy === 0));
    }, {
      exportDir: expDir,
      maxExportsPerSession: 2,
      sessions: { createPool: () => fake, heartbeatIntervalMs: 0 },
    }));
  }

  // ── §10-4. 기동 시 회수 (TTL) ─────────────────────────
  // 프로세스가 죽으면 세션당 상한을 발동시킬 주체가 통째로 사라진다.
  // **연결 수명을 넘겨 살아남은 파일을 회수하는 것은 TTL뿐**이고, 그 발동
  // 계기 중 하나가 기동이다. 여기서도 값이 아니라 행동을 본다 — 수명을
  // 짧게 **구성해 놓고**, 그보다 오래된 것만 사라지는지.
  section('10-4. 기동 시 수명 지난 산출물 회수 (TTL)');
  {
    await withExportDir(async (expDir) => {
      await mkdir(expDir, { recursive: true });
      const old = 'a'.repeat(32);
      const fresh = 'b'.repeat(32);
      const stale = 'c'.repeat(32);
      // 사이드카는 **완결 표시**다. 모양이 맞아야 `get()`이 산출물로 인정하고
      // 다운로드가 열린다 — 아래 "받아진다" 단언이 그것까지 확인한다.
      const sidecar = (sid: string): string => JSON.stringify({
        id: sid,
        name: 'kept.gltf',
        format: 'gltf',
        bytes: 2,
        createdAt: new Date().toISOString(),
        sessionId: 'smoke',
      });
      for (const [n, body] of [
        [`${old}.gltf`, '{}'], [`${old}.json`, sidecar(old)],
        [`${fresh}.gltf`, '{}'], [`${fresh}.json`, sidecar(fresh)],
        // 사이드카 없는 고아 — 워커가 실패했거나 게이트웨이가 commit 전에
        // 죽어 남은 것. 아무도 못 받으므로 이것도 걷혀야 한다.
        [`${stale}.gltf`, '{}'],
      ] as Array<[string, string]>) {
        await writeFile(path.join(expDir, n), body, 'utf8');
      }
      // mtime을 과거로 돌린다. 실제로 기다리면 스모크가 그만큼 길어진다.
      const past = new Date(Date.now() - 60_000);
      for (const n of [`${old}.gltf`, `${old}.json`, `${stale}.gltf`]) {
        await utimes(path.join(expDir, n), past, past);
      }

      await withServer(async (_gw, addr) => {
        const left = await filesIn(expDir);
        check(
          '★ 기동 시 수명이 지난 산출물이 회수된다 (사이드카 없는 고아까지)',
          !left.includes(`${old}.gltf`) && !left.includes(`${old}.json`)
          && !left.includes(`${stale}.gltf`),
          left.join(', ') || '0개',
        );
        check(
          '수명이 남은 것은 그대로 있고 받아진다',
          left.includes(`${fresh}.gltf`) && left.includes(`${fresh}.json`)
          && (await download(`${addr.url}/api/exports/${fresh}`)).status === 200,
          left.join(', '),
        );
        check(
          '회수된 것은 404가 된다',
          (await download(`${addr.url}/api/exports/${old}`)).status === 404,
          `${old.slice(0, 8)}…`,
        );
      }, { exportDir: expDir, exportTtlMs: 10_000 });
    });
  }

  // ── §10-5. 스모크가 실제 산출물을 지우지 않는다 ────────
  // Builder의 경고: 게이트웨이는 exportDir을 안 주면 `backend/data/exports`를
  // 쓰고 prepare()가 강제 청소를 돌린다. 즉 **스모크 실행 자체가 개발자의
  // 산출물을 지우는** 부작용을 갖는다. withServer가 임시 디렉토리를
  // 기본값으로 넣어 막고 있고(SMOKE_EXPORT_ROOT), 그게 실제로 유효한지는
  // 여기서 **운영 기본 디렉토리를 들여다보는 것**으로만 확인된다.
  section('10-5. 스모크는 운영 익스포트 디렉토리를 건드리지 않는다');
  {
    const realDir = defaultExportDir();
    const canary = path.join(realDir, 'smoke-canary.txt');
    await mkdir(realDir, { recursive: true });
    // 수명이 한참 지난 것으로 만든다 — 청소가 돌았다면 **반드시** 지워질 파일이다.
    await writeFile(canary, 'do not delete\n', 'utf8');
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(canary, past, past);

    // exportDir을 **안 주고** 띄운다 — 다른 섹션 대부분이 이 모양이고,
    // 안전망이 없으면 바로 이 시점(prepare의 강제 청소)에서 canary가 사라진다.
    await withServer(async () => {});

    check(
      '★ exportDir 없이 띄운 게이트웨이가 운영 디렉토리의 낡은 파일을 지우지 않았다',
      existsSync(canary),
      `${canary} — 지워졌다면 스모크가 실제 산출물을 회수하고 있다는 뜻이다`,
    );
    check(
      '스모크의 산출물은 임시 디렉토리에 있다 (운영 디렉토리와 다른 곳)',
      SMOKE_EXPORT_ROOT !== realDir && !SMOKE_EXPORT_ROOT.startsWith(realDir),
      SMOKE_EXPORT_ROOT,
    );
    await rm(canary, { force: true }).catch(() => {});
  }

  // ── §11-1. 텍스처 등록 — 경로의 주인이 우리가 아닌 유일한 저장소 ──
  //
  // 씬·익스포트와 방향이 다르다: **워커가 경로를 준다.** 그 경로는 결국 사용자가
  // 올린 `.zls` 안의 문자열에서 왔으므로, 검사를 빼먹으면 업로드 하나로 서버의
  // 임의 파일을 읽는 길이 생긴다. 여기서 재는 것은 그 검사가 실제로 서 있는가다.
  section('11-1. 텍스처 등록 — 허용 뿌리와 거절 (TextureStore)');
  {
    const root = await mkdtemp(path.join(tmpdir(), 'zelus-smoke-tex-'));
    try {
      // 뿌리 **밖**이지만 접두사가 같은 디렉토리. `startsWith` 로 검사하면
      // 여기가 통과한다 — 그 회귀를 잡는 자리다.
      const evil = `${root}-evil`;
      await mkdir(path.join(root, 'sub'), { recursive: true });
      await mkdir(evil, { recursive: true });

      const png = path.join(root, 'skin.png');
      await writeFile(png, 'PNGDATA-0123456789', 'utf8');
      const jpg = path.join(root, 'sub', 'cloth.jpg');
      await writeFile(jpg, 'JPGDATA', 'utf8');
      const outside = path.join(evil, 'secret.png');
      await writeFile(outside, 'SECRET', 'utf8');
      const zls = path.join(root, 'scene.zls');
      await writeFile(zls, 'x', 'utf8');
      const empty = path.join(root, 'empty.png');
      await writeFile(empty, '', 'utf8');
      const big = path.join(root, 'big.png');
      await writeFile(big, 'x'.repeat(2048), 'utf8');

      const logs: string[] = [];
      const store = new TextureStore({ roots: [root], onLog: (l) => logs.push(l) });

      const a = await store.register(png);
      check(
        '허용 뿌리 안의 png 가 등록된다 — id 는 32자리 hex, url 은 /api/textures/<id>',
        a !== null && /^[0-9a-f]{32}$/.test(a.id) && a.url === `/api/textures/${a.id}`
        && a.bytes === 18,
        JSON.stringify(a),
      );
      check(
        '★ 응답 어디에도 서버 경로가 없다 (경로는 밖으로 안 나간다 — #5·#7 의 규칙)',
        a !== null && !JSON.stringify(a).includes('zelus-smoke-tex')
        && !JSON.stringify(a).includes('skin'),
        JSON.stringify(a),
      );
      // ★ 캐시가 사는 유일한 근거. 난수였다면 씬을 다시 열 때마다 URL 이 바뀌어
      //   19.7MB 를 매번 다시 받는다 — 이 단위의 값어치가 통째로 사라진다.
      const a2 = await store.register(png);
      check(
        '★ 같은 파일이면 언제나 같은 id (결정적 해시 — 브라우저 캐시가 사는 조건)',
        a !== null && a2 !== null && a.id === a2.id,
        `${a?.id ?? 'null'} / ${a2?.id ?? 'null'}`,
      );
      const upper = await store.register(png.toUpperCase());
      check(
        '대소문자만 다른 경로도 같은 id (Windows 파일시스템 — 두 번 받지 않는다)',
        upper !== null && a !== null && upper.id === a.id,
        `${upper?.id ?? 'null'}`,
      );
      const sub = await store.register(jpg);
      check(
        '하위 디렉토리의 jpg 도 등록된다',
        sub !== null && sub.id !== a?.id,
        JSON.stringify(sub),
      );

      const bad: Array<[string, unknown]> = [
        ['허용 뿌리 밖', outside],
        ['접두사만 같은 옆 디렉토리 (startsWith 로 하면 샌다)', path.join(evil, 'secret.png')],
        ['.. 탈출', path.join(root, 'sub', '..', '..', path.basename(evil), 'secret.png')],
        ['.zls', zls],
        ['.exe', path.join(root, 'a.exe')],
        ['확장자 없음', path.join(root, 'noext')],
        ['상대경로 (옛 워커)', 'skin.png'],
        ['UNC', '\\\\server\\share\\a.png'],
        ['널바이트', `${png} .txt`],
        ['ADS', `${png}:evil`],
        ['빈 파일', empty],
        ['디렉토리', path.join(root, 'sub')],
        ['없는 파일', path.join(root, 'nope.png')],
        ['문자열이 아님', 42],
        ['빈 문자열', ''],
      ];
      let denied = 0;
      for (const [label, p] of bad) {
        if (await store.register(p) === null) denied += 1;
        else check(`텍스처 거절: ${label}`, false, String(p));
      }
      check(
        `★ 경로 ${bad.length}종이 전부 거절된다 (뿌리 밖 · 탈출 · 확장자 · UNC · 널바이트 · ADS)`,
        denied === bad.length,
        `${denied}/${bad.length}`,
      );
      check(
        '거절된 것은 등록되지 않는다 (등록 수가 안 늘었다)',
        store.size === 2,
        `${store.size}개`,
      );

      // 거절만 기억한다. 뿌리 설정이 틀렸을 때 같은 경고가 열 줄씩 쌓이면
      // 진짜 신호가 묻힌다.
      const before = logs.length;
      await store.register(outside);
      check(
        '같은 경로를 다시 거절할 때는 로그가 안 늘어난다 (거절만 기억한다)',
        logs.length === before,
        `${before} → ${logs.length}`,
      );

      // ── ★★ 거절의 두 갈래 — 무엇을 기억하고 무엇을 다시 물어야 하는가 ──
      //
      // 2026-08-12 에 실제로 밟은 사고다. **거절을 전부 캐시했는데** 사유의
      // 절반(`파일이 없습니다`·`빈 파일`)은 그 순간의 디스크 상태였다. 씬을
      // 여는 동안 엔진이 직물을 다시 푸는 창에 등록이 걸리면 4칸이 떨어졌고,
      // 그 뒤로는 **파일이 멀쩡해져도 이 프로세스가 사는 내내 거절**이라
      // 게이트웨이 재시작 말고는 복구가 없었다.
      //
      // 화면에서는 **옷 색이 통째로 사라진 것**으로 보였다 — 예외도 오류도
      // 없이. 아래 두 단언이 그 회귀를 막는 전부다.
      {
        const l2: string[] = [];
        const s2 = new TextureStore({ roots: [root], onLog: (x) => l2.push(x) });

        // ① 없는 파일 → 나중에 생긴다 (엔진이 아직 안 풀었을 뿐이었다)
        const later = path.join(root, 'later.png');
        check('아직 없는 파일은 거절된다', await s2.register(later) === null, '');
        await writeFile(later, 'NOWEXISTS', 'utf8');
        const revived = await s2.register(later);
        check(
          '★★★ 파일이 생기면 등록된다 — 상태 거절을 기억하지 않는다 (기억하면 옷 색이 영영 안 돌아온다)',
          revived !== null && revived.bytes === 9,
          revived === null ? '거절이 캐시됐다 (회귀)' : JSON.stringify(revived),
        );

        // ② 0바이트 → 다 써진다. **가장 흔한 일시적 실패다** — 엔진이 파일을
        //    만들고 아직 다 쓰지 않았으면 그 순간엔 0바이트로 보인다.
        const half = path.join(root, 'half.png');
        await writeFile(half, '', 'utf8');
        check('빈 파일은 거절된다', await s2.register(half) === null, '');
        await writeFile(half, 'FULLYWRITTEN', 'utf8');
        const filled = await s2.register(half);
        check(
          '★★★ 다 써지면 등록된다 — `빈 파일` 도 상태다 (엔진이 쓰는 중이었을 뿐이다)',
          filled !== null && filled.bytes === 12,
          filled === null ? '거절이 캐시됐다 (회귀)' : JSON.stringify(filled),
        );

        // ③ 대조군. **경로 거절은 여전히 기억해야 한다.** 이것까지 풀어 버리면
        //    뿌리 설정이 틀렸을 때 체형을 만질 때마다 같은 검사를 다시 돈다 —
        //    고치려던 것과 반대 방향으로 넘어간 것이다.
        const outsideNew = path.join(evil, 'appears.png');
        check('뿌리 밖은 거절된다', await s2.register(outsideNew) === null, '');
        await writeFile(outsideNew, 'REALFILE', 'utf8');
        check(
          '★★ 그런데 뿌리 밖은 파일이 생겨도 계속 거절이다 (경로 거절은 기억한다 — 캐시를 통째로 버린 것이 아니다)',
          await s2.register(outsideNew) === null,
          '',
        );
        // ⚠️ **여기서 못 보는 것을 적어 둔다.** 위 단언이 재는 것은 *답*이지
        //    *캐시*가 아니다 — `#rejected` 를 통째로 없애도 경로 검사가 매번
        //    다시 돌아 같은 `null` 이 나오므로 초록이다. 캐시가 하는 일은
        //    "같은 답을 싸게 준다" 뿐이라 동작으로 관측되지 않는다. 그 갈래가
        //    사라지는 회귀는 성능 문제이고, 잘못된 쪽으로 넘어가는 회귀(=상태를
        //    기억한다)는 위 ①② 가 잡는다.
        note('단언 밖', '경로 캐시의 단축 자체는 동작으로 안 보인다 — 답이 같아서다');

        // ④ 검사를 매번 하게 만든 대가는 **로그 도배**다. 그래서 검사는 매번,
        //    경고는 한 번만 — `#rejected` 가 겸하던 두 역할 중 뒤엣것만 뗐다.
        //    ⚠️ **줄 수를 세지 말고 늘어난 양을 재라.** 경고 문구에는 경로가
        //       안 들어간다(`[warn] 텍스처를 거절했습니다 (파일이 없습니다)`) —
        //       사유로 거르면 위 ①의 `later.png` 경고까지 함께 세어진다.
        //       처음에 그렇게 짰다가 2줄이 나왔다.
        const missing = path.join(root, 'ghost.png');
        const n0 = l2.length;
        for (let i = 0; i < 5; i++) await s2.register(missing);
        check(
          '★★ 없는 파일을 5번 물어도 경고는 한 줄만 는다 (검사는 매번, 경고는 한 번)',
          l2.length - n0 === 1,
          `${l2.length - n0}줄 (${n0} → ${l2.length})`,
        );

        // ⑤ 사유가 바뀌면 그건 **새 사실**이라 한 번은 보여야 한다. 경고 키에
        //    사유를 붙인 이유가 이것이다. 로그를 따로 받는 이유는 위와 같다.
        const l3: string[] = [];
        const small2 = new TextureStore({ roots: [root], maxBytes: 8, onLog: (x) => l3.push(x) });
        const grow = path.join(root, 'grow.png');
        await writeFile(grow, '', 'utf8');
        await small2.register(grow);
        await small2.register(grow);
        check(
          '같은 경로·같은 사유는 몇 번을 물어도 한 줄이다',
          l3.length === 1 && (l3[0] ?? '').includes('빈 파일'),
          `${l3.length}줄: ${l3.join(' | ')}`,
        );
        await writeFile(grow, 'x'.repeat(64), 'utf8');
        await small2.register(grow);
        check(
          '★ 같은 경로라도 사유가 바뀌면 한 번 더 경고한다 (빈 파일 → 상한 초과)',
          l3.length === 2 && (l3[1] ?? '').includes('상한 초과'),
          `${l3.length}줄: ${l3.join(' | ')}`,
        );
      }
      // ⚠️ 반대로 **성공은 캐시하면 안 된다.** 엔진이 씬을 열 때마다 직물을
      //    다시 풀어서 크기가 달라질 수 있고, 옛 ETag 를 들고 있으면 낡은
      //    이미지를 계속 내준다.
      await writeFile(png, 'PNGDATA-CHANGED-LONGER', 'utf8');
      const a3 = await store.register(png);
      check(
        '★ 성공은 캐시하지 않는다 — 크기가 바뀌면 새 크기로 다시 등록된다',
        a3 !== null && a3.bytes === 22 && a3.id === a?.id,
        JSON.stringify(a3),
      );

      const small = new TextureStore({ roots: [root], maxBytes: 1024, onLog: () => {} });
      check(
        '상한을 넘는 파일은 거절된다',
        await small.register(big) === null,
      );

      // 색인이 밀리면 머티리얼이 **엉뚱한 이미지**를 가리킨다. 거절 칸은
      // 지우지 않고 null 로 남겨야 한다.
      const table = await store.registerAll([outside, png, zls, jpg]);
      check(
        '★ registerAll — 거절한 칸이 null 로 남고 색인이 안 밀린다',
        table.length === 4 && table[0] === null && table[2] === null
        && table[1]?.id === a?.id && table[3]?.id === sub?.id,
        JSON.stringify(table.map((t) => t?.id ?? null)),
      );

      // 뿌리가 비면 **전부 금지**다. 전부 허용으로 해석하면 설정을 빠뜨렸을 때
      // 가장 나쁜 쪽으로 열린다.
      const off = new TextureStore({ roots: [], onLog: () => {} });
      check(
        '★ 허용 뿌리가 비면 기능이 꺼진다 (전부 허용이 아니다)',
        !off.enabled && await off.register(png) === null,
        `enabled=${off.enabled}`,
      );

      // 넘치면 가장 오래 전에 등록된 것부터 버린다 — 게이트웨이 수명 동안
      // 새는 맵이 되지 않게 하는 유일한 장치다.
      const tiny = new TextureStore({ roots: [root], maxEntries: 2, onLog: () => {} });
      const files: string[] = [];
      for (let i = 0; i < 3; i++) {
        const f = path.join(root, `t${i}.png`);
        await writeFile(f, `T${i}`, 'utf8');
        files.push(f);
      }
      const ids = [];
      for (const f of files) ids.push((await tiny.register(f))?.id ?? '');
      check(
        '★ maxEntries 를 넘으면 가장 오래된 것부터 버려진다',
        tiny.size === 2 && tiny.get(ids[0] ?? '') === null
        && tiny.get(ids[1] ?? '') !== null && tiny.get(ids[2] ?? '') !== null,
        `size=${tiny.size}`,
      );

      const badIds = [
        ['대문자 hex', (a?.id ?? '').toUpperCase()],
        ['너무 짧다', 'abc'],
        ['traversal', '../../scenes'],
        ['확장자 붙임', `${a?.id ?? ''}.png`],
        ['빈 문자열', ''],
      ] as const;
      let idDenied = 0;
      for (const [label, id] of badIds) {
        if (store.get(id) === null) idDenied += 1;
        else check(`get(${label}) 거절`, false, id);
      }
      check(
        `get() 이 형식 밖의 id ${badIds.length}종을 조회조차 하지 않는다`,
        idDenied === badIds.length,
        `${idDenied}/${badIds.length}`,
      );

      // 뿌리 목록의 정본. 환경변수는 **대체한다** — 더하지 않는다.
      const env = { TEXTURE_ROOTS: `${root};${evil}` } as unknown as NodeJS.ProcessEnv;
      check(
        'TEXTURE_ROOTS 는 기본 뿌리를 대체한다 (더하지 않는다)',
        JSON.stringify(defaultTextureRoots(env))
          === JSON.stringify([path.resolve(root), path.resolve(evil)]),
        JSON.stringify(defaultTextureRoots(env)),
      );
      check(
        'LOCALAPPDATA 도 TEXTURE_ROOTS 도 없으면 뿌리가 없다 (= 기능이 꺼진다)',
        defaultTextureRoots({} as NodeJS.ProcessEnv).length === 0,
      );
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      await rm(`${root}-evil`, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ── §11-2. GET /api/textures/:id — ETag 와 304 ──────────
  //
  // 이 단위의 값어치가 정확히 여기 있다: 두 번째 요청이 0 바이트여야 한다.
  // express 기본 ETag(크기 + mtime)를 쓰면 씬을 다시 열 때마다 13.9MB 를
  // 다시 받는데(엔진이 직물을 매번 다시 푼다), 그 회귀는 화면에서 안 보인다.
  section('11-2. 텍스처 다운로드 라우트 (ETag · 304 · 목록 없음)');
  {
    const root = await mkdtemp(path.join(tmpdir(), 'zelus-smoke-texsrv-'));
    try {
      const png = path.join(root, 'a.png');
      const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
      await writeFile(png, body);

      await withServer(async (gw, addr) => {
        const asset = await gw.textures.register(png);
        if (!asset) {
          check('텍스처가 등록된다', false, '게이트웨이의 뿌리 설정이 다르다');
          return;
        }
        const res = await fetch(`${addr.url}${asset.url}`);
        const got = new Uint8Array(await res.arrayBuffer());
        const etag = res.headers.get('etag') ?? '';
        check(
          '등록된 텍스처가 바이트 그대로 내려온다',
          res.status === 200 && got.length === body.length
          && Buffer.compare(Buffer.from(got), body) === 0,
          `status=${res.status}, ${got.length}B`,
        );
        check(
          'content-type 은 확장자 표에서 온다 (express 추측이 아니다)',
          (res.headers.get('content-type') ?? '').startsWith('image/png'),
          res.headers.get('content-type') ?? '',
        );
        check(
          `★ ETag 가 "<id>-<크기>" 다 — mtime 이 안 들어간다`,
          etag === `"${asset.id}-${body.length.toString(16)}"`,
          etag,
        );
        check(
          '★ Last-Modified 를 안 보낸다 (엔진이 푼 파일의 mtime 이 1657년이다)',
          res.headers.get('last-modified') === null,
          String(res.headers.get('last-modified')),
        );
        check(
          'Cache-Control 은 max-age=0 — 매번 재검증한다',
          (res.headers.get('cache-control') ?? '').includes('max-age=0'),
          res.headers.get('cache-control') ?? '',
        );

        // ⚠️ `Cache-Control` 을 **직접 적어야 한다.** node 의 fetch(undici)는
        //    시키지 않아도 요청에 `cache-control: no-cache` 와 `pragma: no-cache`
        //    를 붙이는데, `fresh` 는 그게 있으면 **일부러 304 를 안 준다**
        //    ("캐시 말고 본문을 다시 달라" 는 뜻이니 서버 동작이 맞다).
        //
        //    그래서 이 한 줄이 없으면 **서버가 멀쩡한데도 200 이 나온다.**
        //    2026-08-12 에 실제로 그렇게 빨간불이 떴고, 단언을 "200 도 통과"
        //    로 약하게 고쳤다면 진짜 캐시 회귀(씬을 열 때마다 20MB 재전송)를
        //    영영 못 잡게 될 뻔했다. 실측으로 갈랐다:
        //
        //      curl · node:http(raw) · 브라우저   → 304 / 0 바이트
        //      node fetch (기본)                  → 200 / 전량
        //      node fetch + 이 헤더               → 304 / 0 바이트
        const again = await fetch(`${addr.url}${asset.url}`, {
          headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' },
        });
        const againBody = new Uint8Array(await again.arrayBuffer());
        check(
          '★★ 두 번째 요청은 304 + 0 바이트다 (이 단위의 값어치가 여기 있다)',
          again.status === 304 && againBody.length === 0,
          `status=${again.status}, ${againBody.length}B`,
        );

        const missing = await get(`${addr.url}/api/textures/${'0'.repeat(32)}`);
        check(
          '등록 안 된 id → 404, 본문은 JSON',
          missing.status === 404 && errorOf(missing.text).includes('찾을 수 없습니다'),
          `status=${missing.status}, ${missing.text.slice(0, 80)}`,
        );
        check(
          '그 거절에 서버 경로가 없다',
          !missing.text.includes('zelus-smoke-texsrv') && !missing.text.includes(root),
          missing.text.slice(0, 120),
        );
        // 형식이 틀린 것과 없는 것을 구분하지 않는다 — 400 을 따로 주면
        // "이 id 는 형식은 맞는데 없다"가 그 자체로 신호가 된다.
        for (const [label, id] of [
          ['대문자 id', asset.id.toUpperCase()],
          ['너무 짧다', 'abc'],
          ['인코딩된 traversal', '%2e%2e%2f%2e%2e%2fwin.ini'],
          ['확장자 붙임', `${asset.id}.png`],
        ] as const) {
          const r = await get(`${addr.url}/api/textures/${id}`);
          check(`${label} → 404 (형식 오류와 미등록을 구분하지 않는다)`, r.status === 404, `status=${r.status}`);
        }
        const list = await get(`${addr.url}/api/textures`);
        check(
          '★ 목록 라우트는 없다 (id 가 곧 열람 권한이다)',
          list.status === 404,
          `status=${list.status}`,
        );
        check(
          'served 카운터가 200 만 센다 (304 는 안 센다)',
          gw.textures.served === 1,
          `${gw.textures.served}`,
        );
      }, { textureRoots: [root] });
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
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

/** 안전망 디렉토리를 남기지 않는다. 어느 경로로 끝나든 지난다 (#10) */
function cleanupExportRoot(): void {
  rmSync(SMOKE_EXPORT_ROOT, { recursive: true, force: true });
}

main().then(
  () => {
    clearTimeout(guard);
    cleanupExportRoot();
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
    cleanupExportRoot();
    console.error('\n스모크 테스트 중 예외:', err);
    process.exit(1);
  },
);
