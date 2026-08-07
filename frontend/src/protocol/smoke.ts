/**
 * 프론트엔드 프로토콜 계층 스모크 테스트 (#11).
 *
 *   node --experimental-strip-types src/protocol/smoke.ts
 *
 * ── 이 파일이 존재하는 이유 ──────────────────────────────────
 * **프론트에서 자동 테스트가 붙는 유일한 층이다.** #12(three.js 3D)부터는
 * 화면을 눈으로 보는 확인만 남으므로, 여기서 못 잡는 회귀는 앞으로도 못 잡는다.
 * 그래서 이 파일은 "돌아간다"를 보는 게 아니라 **조용히 깨지는 것들**을 겨냥한다:
 *
 *   - 디코딩 정렬 — 뚫리면 예외 없이 화면의 형체만 뒤틀린다 (§2)
 *   - id 상관    — 뚫리면 A의 응답이 B에게 간다. 값이 그럴듯해서 안 보인다 (§3)
 *   - 재연결     — 뚫리면 앱이 빈 세션을 "복구됐다"고 믿는다 (§4)
 *   - 개발 프록시 — 뚫리면 #12 이후 전부가 원인 모를 1006/파싱오류가 된다 (§5)
 *   - SPA 폴백   — 뚫리면 fetch가 JSON 대신 HTML을 받아 진짜 원인이 묻힌다 (§6)
 *   - 3D 지오메트리 — 뚫리면 증상이 전부 "화면이 비었다" 하나로 수렴한다 (§8)
 *   - 프레임 스트리밍 — 뚫리면 "시뮬은 도는데 옷이 안 움직인다" (§8-5~§8-7)
 *
 * 프로토콜 계층은 DOM을 쓰지 않으므로(`WebSocket`/`JSON`/`setTimeout`뿐) Node에서
 * 그대로 돈다. `main.ts`는 DOM을 쓰므로 **여기서 import하지 않는다.**
 * `viewer3d/cloth.ts`·`loader.ts`도 DOM을 쓰지 않는다(three의 데이터 구조뿐).
 * DOM이 필요한 것은 `viewer.ts`의 WebGLRenderer 쪽이고, 그건 §8이 대역으로
 * 대신한다 — 자세한 이유는 §8 머리말에 있다.
 *
 * 스타일은 backend/src/{sdk,server}/smoke.ts를 그대로 따른다. 프레임워크 없음.
 *
 * ── #12 이후가 테스트를 추가하는 법 ──────────────────────────
 * 아래 "§N" 섹션을 하나 새로 열고 check()를 부르면 된다. 서버가 필요하면
 * withGateway(), 소켓의 응답을 손으로 조종하고 싶으면 withFakeGateway()를 쓴다.
 * 둘 다 어떤 경로로 나가든 finally에서 닫으므로 정리를 신경 쓸 필요가 없다.
 * 포트는 전부 freePort()로 잡으므로 섹션끼리 겹치지 않는다.
 *
 * ── 의존성 ───────────────────────────────────────────────────
 * 새로 설치한 것이 없다. `ws`(가짜 게이트웨이용)는 backend의 node_modules에서
 * createRequire로 꺼내 쓴다 — frontend는 브라우저 번들이라 서버용 패키지를
 * devDependency로도 들이지 않는 편이 맞다.
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import * as THREE from 'three';

import {
  decodeFloat32 as sdkDecodeFloat32,
  decodeInt32 as sdkDecodeInt32,
} from '../../../backend/src/sdk/protocol.ts';
import {
  createServer as createGateway,
  type Gateway,
  type GatewayAddress,
  type GatewayOptions,
} from '../../../backend/src/server/index.ts';
import { ClothObject } from '../viewer3d/cloth.ts';
import {
  FrameStream,
  type DrainOutcome,
  type PositionSink,
  type TopologyMismatch,
} from '../viewer3d/frameStream.ts';
import { showScene } from '../viewer3d/loader.ts';
import type { Viewer3D } from '../viewer3d/viewer.ts';

import {
  base64ToBytes,
  decodeFloat32,
  decodeInt32,
  decodePattern,
  decodePatterns,
  fetchHealth,
  GatewayClient,
  GatewayClosedError,
  GatewayError,
  GatewayTimeoutError,
  listScenes,
  meshStats,
  resolveEndpoints,
  uploadScene,
  withScene,
  type ClientOp,
  type DecodedPattern,
  type FrameMesh,
  type PatternData,
  type SceneSummary,
} from './index.ts';

// ── 하네스 ───────────────────────────────────────────────────

const HERE = import.meta.dirname;
const FRONTEND = path.resolve(HERE, '..', '..');
const ROOT = path.resolve(FRONTEND, '..');
const EXE = path.resolve(ROOT, 'backend/native/build/Release/zelusSandBoxd-demo.exe');
const ZLS = path.resolve(ROOT, 'zelusSandBox_Cobalt/Zest/testing/sdk/sample.zls');
const DIST = path.resolve(FRONTEND, 'dist');

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  OK ' : '  실패'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** 판정에 넣지 않는 진단. 기준 밖이지만 알아둘 값을 남긴다 */
function note(label: string, detail: string): void {
  console.log(`  ..    ${label}  — ${detail}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

function ms(t: number): string {
  return `${Math.round(t)}ms`;
}

function sleep(msec: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, msec);
    t.unref?.();
  });
}

/** 조건이 참이 될 때까지. 시간이 다하면 false — 던지지 않는다(단언은 호출자 몫) */
async function until(pred: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(5);
  }
  return true;
}

/** 거부를 값으로 바꾼다. 성공하면 null — unhandled rejection을 만들지 않는다 */
function caught<T>(p: Promise<T>): Promise<unknown> {
  return p.then(() => null, (e: unknown) => e);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 비어 있는 포트 하나. strictPort인 Vite와 가짜 WS 서버가 이걸 쓴다 */
function freePort(): Promise<number> {
  return new Promise<number>((res, rej) => {
    const srv = createNetServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

/** 게이트웨이를 띄우고 **반드시** 닫는다 (server/smoke.ts의 withServer와 같은 계약) */
async function withGateway<T>(
  fn: (gw: Gateway, addr: GatewayAddress) => Promise<T>,
  opts: GatewayOptions = {},
): Promise<T> {
  const gw = createGateway({ onLog: () => {}, ...opts });
  try {
    return await fn(gw, await gw.start());
  } finally {
    await gw.close();
  }
}

/** 임시 디렉토리를 만들고 **반드시** 지운다 */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'zelus-front-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── 가짜 게이트웨이 ──────────────────────────────────────────
//
// 실제 게이트웨이로는 재현할 수 없는 것들이 있다: 응답을 역순으로 보내기,
// 타임아웃 뒤에 뒤늦게 답하기, 없는 id로 답하기, 소켓을 난폭하게 끊기.
// id 상관(§3)과 재연결(§4)의 경계는 전부 그런 상황이라 여기서 결정적으로 만든다.
//
// `ws`는 frontend의 의존성이 아니다(브라우저 번들에 서버 패키지를 들이지
// 않는다). backend의 node_modules에서 createRequire로 꺼낸다 — 새 설치 없음.

const backendRequire = createRequire(path.resolve(ROOT, 'backend', 'package.json'));

/** `ws`가 실제로 쓰는 표면만. 타입 패키지를 frontend에 들이지 않기 위한 최소 선언 */
interface FakeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: { toString(): string }) => void): this;
  on(event: 'close', listener: () => void): this;
}
interface FakeServer {
  on(event: 'connection', listener: (socket: FakeSocket) => void): this;
  on(event: 'listening', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  close(cb?: (err?: Error) => void): void;
}
type FakeServerCtor = new (opts: { port: number; host: string; path: string }) => FakeServer;

const WebSocketServerCtor = (
  backendRequire('ws') as { WebSocketServer: FakeServerCtor }
).WebSocketServer;

interface FakeGateway {
  /** `http://127.0.0.1:<port>` — GatewayClient의 url 옵션에 그대로 넣는다 */
  url: string;
  /** 지금까지 받아들인 연결 수. 재연결을 셀 때 쓴다 */
  connections: number;
  /** 도착한 요청 원문(파싱된 것). 순서대로 */
  received: Record<string, unknown>[];
  /** 요청 하나를 어떻게 처리할지. 기본은 즉시 echo 응답 */
  handler: (msg: Record<string, unknown>, sock: FakeSocket) => void;
  /** 살아있는 소켓 전부에 원문 문자열을 그대로 밀어넣는다 */
  push(text: string): void;
  /** 난폭한 끊김(1006). 재연결·pending 정리를 보는 유일한 방법 */
  kill(): void;
}

async function withFakeGateway<T>(fn: (fake: FakeGateway) => Promise<T>): Promise<T> {
  const port = await freePort();
  const wss = new WebSocketServerCtor({ port, host: '127.0.0.1', path: '/ws' });
  const sockets = new Set<FakeSocket>();

  const fake: FakeGateway = {
    url: `http://127.0.0.1:${port}`,
    connections: 0,
    received: [],
    handler: (msg, sock) => {
      sock.send(JSON.stringify({ id: msg['id'], ok: true, result: { echoed: msg['op'] } }));
    },
    push: (text) => {
      for (const s of sockets) s.send(text);
    },
    kill: () => {
      for (const s of sockets) s.terminate();
      sockets.clear();
    },
  };

  wss.on('connection', (sock) => {
    fake.connections += 1;
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!isRecord(msg)) return;
      fake.received.push(msg);
      fake.handler(msg, sock);
    });
  });

  await new Promise<void>((res, rej) => {
    wss.on('listening', () => res());
    wss.on('error', rej);
  });

  try {
    return await fn(fake);
  } finally {
    fake.kill();
    await new Promise<void>((res) => wss.close(() => res()));
  }
}

// ── 바이트 도우미 ────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function f32Base64(values: readonly number[]): string {
  const f = Float32Array.from(values);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}

function i32Base64(values: readonly number[]): string {
  const i = Int32Array.from(values);
  return Buffer.from(i.buffer, i.byteOffset, i.byteLength).toString('base64');
}

/** NaN !== NaN 이므로 값이 아니라 **바이트**로 비교한다 */
function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  const va = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const vb = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (va.length !== vb.length) return false;
  for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
  return true;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─────────────────────────────────────────────────────────────
// §0. 주소 해석 — 손으로 문자열을 이어붙이면 반드시 틀리는 자리
// ─────────────────────────────────────────────────────────────

function sectionEndpoints(): void {
  section('§0. 주소 해석 (url.ts)');

  const a = resolveEndpoints('http://127.0.0.1:3000');
  check(
    'http → httpBase/wsBase',
    a.httpBase === 'http://127.0.0.1:3000' && a.wsBase === 'ws://127.0.0.1:3000/ws',
    JSON.stringify(a),
  );

  // https인데 ws://로 붙으면 브라우저가 혼합 콘텐츠로 막는다 — 가장 조용한 실패다.
  const b = resolveEndpoints('https://example.com');
  check(
    '★ https → wss (혼합 콘텐츠 차단을 만들지 않는다)',
    b.httpBase === 'https://example.com' && b.wsBase === 'wss://example.com/ws',
    JSON.stringify(b),
  );

  const c = resolveEndpoints('ws://h:1');
  check('ws → httpBase는 http', c.httpBase === 'http://h:1', JSON.stringify(c));

  const d = resolveEndpoints('wss://h');
  check(
    'wss → httpBase는 https',
    d.httpBase === 'https://h' && d.wsBase === 'wss://h/ws',
    JSON.stringify(d),
  );

  const e = resolveEndpoints('http://h:2', '/socket');
  check('wsPath를 바꿀 수 있다', e.wsBase === 'ws://h:2/socket', e.wsBase);

  const f = resolveEndpoints('ws://h:3/custom');
  check('base에 경로가 있으면 그것을 존중한다', f.wsBase === 'ws://h:3/custom', f.wsBase);

  // Node에는 location이 없다. 여기서 죽지 않으면 wsUrl이 'undefined/ws'가 된다.
  let noBase = '';
  try {
    resolveEndpoints(undefined);
  } catch (err: unknown) {
    noBase = messageOf(err);
  }
  check(
    '브라우저 밖에서 base 없으면 즉시 죽는다',
    noBase.includes('게이트웨이 주소를 알 수 없습니다'),
    noBase || '던지지 않았다',
  );

  let badProto = '';
  try {
    resolveEndpoints('ftp://h');
  } catch (err: unknown) {
    badProto = messageOf(err);
  }
  check('지원하지 않는 프로토콜은 거부한다', badProto.includes('지원하지 않는 프로토콜'), badProto);

  check('withScene: 없으면 그대로', withScene('ws://h/ws', null) === 'ws://h/ws');
  check('withScene: undefined도 그대로', withScene('ws://h/ws', undefined) === 'ws://h/ws');
  check(
    'withScene: ?scene= 을 붙인다',
    withScene('ws://h/ws', 'abc123') === 'ws://h/ws?scene=abc123',
    withScene('ws://h/ws', 'abc123'),
  );
  check(
    'withScene: 값을 인코딩한다',
    withScene('ws://h/ws', 'a b&c') === 'ws://h/ws?scene=a+b%26c',
    withScene('ws://h/ws', 'a b&c'),
  );

  const client = new GatewayClient({ url: 'http://127.0.0.1:9', scene: 'deadbeef' });
  check(
    '클라이언트가 두 주소를 그대로 노출한다',
    client.wsUrl === 'ws://127.0.0.1:9/ws?scene=deadbeef'
      && client.httpBase === 'http://127.0.0.1:9',
    `${client.wsUrl} / ${client.httpBase}`,
  );
  check('connect() 전 상태는 idle', client.state === 'idle' && client.connected === false);
}

// ─────────────────────────────────────────────────────────────
// §1. 디코딩 — 길이
//
// 길이 검증이 decode.ts의 본체다. 어긋난 채 three.js에 넘기면 지오메트리가
// 조용히 뒤틀리거나 마지막 몇 정점이 원점에 붙는다. 렌더 결과만 보고는
// 디코딩 문제인지 시뮬 문제인지 구분할 수 없다.
// ─────────────────────────────────────────────────────────────

function sectionDecodeLength(): void {
  section('§1. 디코딩 — 길이');

  const f = decodeFloat32(f32Base64([1, 2, 3, 4.5]));
  check(
    'float32 왕복',
    f.length === 4 && f[0] === 1 && f[3] === 4.5,
    `[${Array.from(f).join(',')}]`,
  );

  const i = decodeInt32(i32Base64([0, -1, 2147483647, -2147483648]));
  check(
    'int32 왕복',
    i.length === 4 && i[1] === -1 && i[2] === 2147483647 && i[3] === -2147483648,
    `[${Array.from(i).join(',')}]`,
  );

  // 리틀엔디언 전제. 뒤집히면 좌표가 천문학적 값이나 0으로 보인다.
  check(
    '★ 리틀엔디언 (00 00 80 3F === 1.0)',
    decodeFloat32(bytesToBase64(Uint8Array.of(0, 0, 0x80, 0x3f)))[0] === 1,
    String(decodeFloat32(bytesToBase64(Uint8Array.of(0, 0, 0x80, 0x3f)))[0]),
  );

  check('빈 문자열 → 길이 0', decodeFloat32('').length === 0);

  // 4의 배수가 아닌 길이. 조용히 잘라내면 정점 하나가 사라진 메시가 그려진다.
  let three = '';
  try {
    decodeFloat32(bytesToBase64(Uint8Array.of(1, 2, 3)));
  } catch (err: unknown) {
    three = messageOf(err);
  }
  check(
    '★ 3바이트 → 던진다 (조용히 잘라내지 않는다)',
    three === 'float32 배열 길이가 4의 배수가 아닙니다 (3바이트)',
    three || '던지지 않았다',
  );

  let threeI = '';
  try {
    decodeInt32(bytesToBase64(Uint8Array.of(1, 2, 3, 4, 5)), '패턴 X indices');
  } catch (err: unknown) {
    threeI = messageOf(err);
  }
  check(
    'int32도 같다. label이 메시지에 실린다',
    threeI === '패턴 X indices 길이가 4의 배수가 아닙니다 (5바이트)',
    threeI || '던지지 않았다',
  );

  let badB64 = '';
  try {
    decodeFloat32('!!!not base64!!!');
  } catch (err: unknown) {
    badB64 = messageOf(err);
  }
  check('망가진 base64는 우리 문구로 감싼다', badB64.startsWith('base64 디코딩 실패'), badB64);

  // ── decodePattern: 서버가 말한 개수와 실제 바이트가 맞는가 ──
  const good: PatternData = {
    uuid: 'p-good',
    vertices: 2,
    triangles: 1,
    positions: f32Base64([0, 0, 0, 1, 1, 1]),
    indices: i32Base64([0, 1, 0]),
    uvs: f32Base64([0, 0, 1, 1]),
    positionStride: 12,
  };
  const dp = decodePattern(good);
  check(
    'decodePattern: positions/indices/uvs 전부 길이가 맞는다',
    dp.positions.length === 6 && dp.indices?.length === 3 && dp.uvs?.length === 4,
    `pos=${dp.positions.length}, idx=${dp.indices?.length}, uv=${dp.uvs?.length}`,
  );

  const cases: [string, PatternData, string][] = [
    [
      '★ positions 길이 ≠ vertices×3',
      { uuid: 'p1', vertices: 3, triangles: 1, positions: f32Base64([0, 0, 0, 1, 1, 1]) },
      'positions 길이가 맞지 않습니다',
    ],
    [
      '★ indices 길이 ≠ triangles×3',
      {
        uuid: 'p2',
        vertices: 2,
        triangles: 2,
        positions: f32Base64([0, 0, 0, 1, 1, 1]),
        indices: i32Base64([0, 1, 0]),
      },
      'indices 길이가 맞지 않습니다',
    ],
    [
      '★ uvs 길이 ≠ vertices×2',
      {
        uuid: 'p3',
        vertices: 2,
        triangles: 0,
        positions: f32Base64([0, 0, 0, 1, 1, 1]),
        uvs: f32Base64([0, 0]),
      },
      'uvs 길이가 맞지 않습니다',
    ],
  ];
  for (const [label, pattern, expect] of cases) {
    let msg = '';
    try {
      decodePattern(pattern);
    } catch (err: unknown) {
      msg = messageOf(err);
    }
    check(`${label} → 던진다`, msg.includes(expect) && msg.includes(pattern.uuid), msg || '통과해버렸다');
  }

  // positions가 아예 없는 패턴(topology 없이 온 빈 패턴)은 정상이다.
  const empty = decodePattern({ uuid: 'p-empty', vertices: 0, triangles: 0 });
  check(
    'positions 없는 패턴은 빈 배열 (던지지 않는다)',
    empty.positions.length === 0 && empty.indices === undefined && empty.uvs === undefined,
  );

  const mesh: FrameMesh = { patterns: [good, { ...good, uuid: 'p-good-2' }], topology: true };
  const all = decodePatterns(mesh);
  check('decodePatterns: 패턴 전부', all.length === 2 && all[1]?.uuid === 'p-good-2');

  const stats = meshStats(mesh);
  check(
    'meshStats 합계',
    stats.patterns === 2 && stats.vertices === 4 && stats.triangles === 2 && stats.base64Bytes > 0,
    JSON.stringify(stats),
  );
}

// ─────────────────────────────────────────────────────────────
// §2. 디코딩 — 정렬, 그리고 SDK와의 바이트 동일성
//
// 이 섹션이 이 파일에서 가장 중요하다. 정렬이 뚫리면 **예외 없이** 값만
// 어긋나거나(뷰가 한 칸 밀린다) RangeError가 엉뚱한 자리에서 난다. #12 이후
// 수동 확인으로는 원인을 절대 못 찾는 종류다.
//
// 그런데 공개 API(`decodeFloat32`)만으로는 정렬 가드에 **도달할 수 없다** —
// `base64ToBytes`가 항상 오프셋 0을 주기 때문이다. 그래서 두 갈래로 고정한다:
//   ① 그 전제("항상 오프셋 0, 전용 버퍼") 자체를 단언한다. Buffer.from으로
//      바꾸는 손이 오면 여기가 깨진다 — Node Buffer는 8KB 풀의 임의 위치다.
//   ② 브라우저가 실제로 타는 `Uint8Array.fromBase64` 경로를 폴리필로 주입해
//      가드를 도달 가능하게 만든 뒤, 어긋난 뷰를 줘도 값이 정확한지 본다.
//      Node 24.15에는 fromBase64가 없어서 이 경로는 통째로 미검증 상태다.
// ─────────────────────────────────────────────────────────────

type DecodeModule = typeof import('./decode.ts');
type Base64Slot = { fromBase64?: unknown };

const U8 = Uint8Array as unknown as Base64Slot;
const NATIVE_FROM_BASE64 = U8.fromBase64;

/**
 * `Uint8Array.fromBase64`를 갈아끼운 채 decode.ts를 **새 인스턴스로** 읽는다.
 * 쿼리스트링이 다르면 Node ESM은 다른 모듈로 취급하므로 모듈 최상단의
 * `nativeFromBase64` 캡처가 다시 일어난다.
 */
async function loadDecodeWith(
  tag: string,
  impl: ((base64: string) => Uint8Array) | null,
): Promise<DecodeModule> {
  if (impl) U8.fromBase64 = impl;
  else delete U8.fromBase64;
  try {
    return (await import(`./decode.ts?probe=${tag}`)) as DecodeModule;
  } finally {
    if (NATIVE_FROM_BASE64 === undefined) delete U8.fromBase64;
    else U8.fromBase64 = NATIVE_FROM_BASE64;
  }
}

function atobBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k) & 0xff;
  return out;
}

async function sectionAlignment(): Promise<void> {
  section('§2. 디코딩 — 정렬 / SDK 바이트 동일성');

  note(
    '이 Node의 Uint8Array.fromBase64',
    NATIVE_FROM_BASE64 === undefined
      ? '없음 → atob 폴백 경로가 돈다 (브라우저 Chrome 133+는 네이티브 경로다)'
      : '있음 → 네이티브 경로가 돈다',
  );

  // ── ① base64ToBytes의 전제: 오프셋 0 + 전용 버퍼 ──────────
  // 이게 깨지면 아래 뷰 생성이 복사 없이 끝난다는 보장이 사라진다.
  for (const n of [1, 3, 4, 7, 12, 1000]) {
    const bytes = base64ToBytes(bytesToBase64(new Uint8Array(n).fill(0xab)));
    const dedicated = bytes.buffer.byteLength === n;
    check(
      `★ base64ToBytes(${n}바이트): byteOffset 0 + 전용 버퍼`,
      bytes.byteOffset === 0 && dedicated && bytes.length === n,
      `offset=${bytes.byteOffset}, buffer=${bytes.buffer.byteLength}, len=${bytes.length}`,
    );
  }

  // decodeFloat32의 결과도 오프셋 0이어야 한다 — three.js에 그대로 넘어간다.
  const view = decodeFloat32(f32Base64([1, 2, 3]));
  check(
    'decodeFloat32 결과도 byteOffset 0',
    view.byteOffset === 0 && view.buffer.byteLength === 12,
    `offset=${view.byteOffset}, buffer=${view.buffer.byteLength}`,
  );

  // ── ② 함정이 실재한다는 증거 ──────────────────────────────
  const backing = new Uint8Array(16);
  const skewed = backing.subarray(1, 13); // byteOffset 1
  let naiveThrew = '';
  try {
    new Float32Array(skewed.buffer, skewed.byteOffset, skewed.byteLength / 4);
  } catch (err: unknown) {
    naiveThrew = err instanceof Error ? err.name : String(err);
  }
  check(
    '★ 정렬 안 맞는 뷰를 그대로 쓰면 RangeError (함정이 실재한다)',
    naiveThrew === 'RangeError',
    naiveThrew || '던지지 않았다 — 이 런타임에서는 함정이 없다',
  );

  // ── ③ 네이티브 경로 두 벌을 폴리필로 태운다 ───────────────
  const sample = [0, -0, 1, -1, 0.5, 1e-30, 1e30, 12345.678];
  const b64 = f32Base64(sample);
  const reference = decodeFloat32(b64);

  let probed = false;
  try {
    // (a) 스펙대로 동작하는 네이티브 (오프셋 0)
    const spec = await loadDecodeWith('spec', (s) => atobBytes(s));
    const specOut = spec.decodeFloat32(b64);
    check(
      '★ 네이티브 fromBase64 경로가 atob 경로와 바이트가 같다',
      sameBytes(specOut, reference),
      `len=${specOut.length}`,
    );
    check(
      '네이티브 경로도 byteOffset 0',
      specOut.byteOffset === 0,
      `offset=${specOut.byteOffset}`,
    );

    // (b) 어긋난 뷰를 주는 구현 (남이 준 뷰가 섞이는 상황)
    const skew = await loadDecodeWith('skew', (s) => {
      const bin = atobBytes(s);
      const pad = new Uint8Array(bin.length + 3);
      const v = pad.subarray(1, bin.length + 1); // byteOffset 1 — 4의 배수가 아니다
      v.set(bin);
      return v;
    });
    const skewOut = skew.decodeFloat32(b64);
    check(
      '★ 어긋난 뷰가 와도 던지지 않고 복사해서 살린다',
      sameBytes(skewOut, reference),
      `offset=${skewOut.byteOffset}, len=${skewOut.length}`,
    );
    check(
      '★ 복사 후에는 오프셋이 0으로 정렬된다',
      skewOut.byteOffset % 4 === 0,
      `offset=${skewOut.byteOffset}`,
    );
    // 길이 검증은 복사 경로에서도 살아 있어야 한다.
    let skewLen = '';
    try {
      skew.decodeFloat32(bytesToBase64(Uint8Array.of(1, 2, 3)));
    } catch (err: unknown) {
      skewLen = messageOf(err);
    }
    check(
      '복사 경로에서도 길이 검증이 먼저 돈다',
      skewLen.includes('4의 배수가 아닙니다 (3바이트)'),
      skewLen || '던지지 않았다',
    );
    probed = true;
  } catch (err: unknown) {
    check('네이티브 fromBase64 경로 검증', false, `모듈 재로딩 실패: ${messageOf(err)}`);
  }
  if (!probed) note('참고', '쿼리스트링 동적 import가 막히면 이 경로는 검증할 수 없다');

  // ── ④ SDK(Node/Buffer 구현)와 바이트가 같은가 ─────────────
  // 두 구현이 갈라지면 게이트웨이 스모크는 통과하는데 브라우저만 틀린다.
  const edge = [
    0, -0, 1, -1,
    Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
    3.4028234663852886e38, -3.4028234663852886e38,
    1.1754943508222875e-38, 1.401298464324817e-45,
    Math.PI, -Math.E,
  ];
  const edgeB64 = f32Base64(edge);
  check(
    '★ float32: 브라우저 구현 === SDK 구현 (엣지 값 13종)',
    sameBytes(decodeFloat32(edgeB64), sdkDecodeFloat32(edgeB64)),
    `${edge.length}개`,
  );

  const edgeI = [0, 1, -1, 2147483647, -2147483648, 0x7f7f7f7f, -123456789];
  const edgeIB64 = i32Base64(edgeI);
  check(
    '★ int32: 브라우저 구현 === SDK 구현 (엣지 값 7종)',
    sameBytes(decodeInt32(edgeIB64), sdkDecodeInt32(edgeIB64)),
    `${edgeI.length}개`,
  );

  // 무작위 바이트 — 길이를 4의 배수로 쓸면서 base64 패딩 3종을 전부 태운다.
  let allSame = true;
  let firstBad = '';
  for (let n = 4; n <= 4 * 64; n += 4) {
    const raw = new Uint8Array(n);
    for (let k = 0; k < n; k++) raw[k] = (k * 37 + n * 11) & 0xff;
    const s = bytesToBase64(raw);
    if (!sameBytes(decodeFloat32(s), sdkDecodeFloat32(s))) {
      allSame = false;
      firstBad = `n=${n}`;
      break;
    }
    if (!sameBytes(base64ToBytes(s), raw)) {
      allSame = false;
      firstBad = `base64ToBytes n=${n}`;
      break;
    }
  }
  check('★ 무작위 바이트 64가지 길이에서도 바이트가 같다', allSame, firstBad || '4~256바이트');

  // base64 패딩 3종
  for (const [label, raw] of [
    ['패딩 없음(3n)', Uint8Array.of(1, 2, 3, 4, 5, 6)],
    ['패딩 1개', Uint8Array.of(1, 2, 3, 4)],
    ['패딩 2개', Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)],
  ] as const) {
    const s = bytesToBase64(raw);
    check(`base64 ${label} → 바이트 그대로`, sameBytes(base64ToBytes(s), raw), s);
  }
}

// ─────────────────────────────────────────────────────────────
// §3. 요청 id 상관
//
// 뚫려도 예외가 나지 않는다 — A의 응답이 B에게 가고, 값이 그럴듯하면
// 화면은 멀쩡해 보인다. 그래서 경계를 전부 고정한다.
// ─────────────────────────────────────────────────────────────

async function sectionCorrelation(): Promise<void> {
  section('§3. 요청 id 상관 (가짜 게이트웨이)');

  await withFakeGateway(async (fake) => {
    const client = new GatewayClient({ url: fake.url, requestTimeoutMs: 3_000 });
    await client.connect();
    check('가짜 게이트웨이에 연결', client.connected && client.state === 'open');

    // 3-1. 단조 증가, 재사용 없음
    check('nextRequestId 초기값 1', client.nextRequestId === 1, String(client.nextRequestId));
    await client.ping();
    await client.ping();
    await client.ping();
    const ids = fake.received.map((m) => m['id']);
    check('★ id는 1,2,3으로 단조 증가한다', JSON.stringify(ids) === '[1,2,3]', JSON.stringify(ids));
    check('nextRequestId가 4로 전진', client.nextRequestId === 4, String(client.nextRequestId));
    check('op 이름이 그대로 실린다', fake.received.every((m) => m['op'] === 'ping'));

    // 3-2. payload가 id/op을 덮어쓰지 못한다 (덮이면 차단된 op이 새어나간다)
    fake.received.length = 0;
    await client.request('ping', { id: 999, op: 'quit', extra: 'x' });
    const forged = fake.received[0];
    check(
      '★ payload의 id/op은 무시된다 (차단된 op을 흉내낼 수 없다)',
      forged?.['id'] === 4 && forged?.['op'] === 'ping' && forged?.['extra'] === 'x',
      JSON.stringify(forged),
    );

    // 3-3. 역순 응답도 id로 정확히 상관된다
    const inbox: { msg: Record<string, unknown>; sock: FakeSocket }[] = [];
    fake.handler = (msg, sock) => {
      inbox.push({ msg, sock });
    };
    const ops: ClientOp[] = ['ping', 'version', 'status'];
    const promises = ops.map((op) =>
      client.request<{ tag: string }>(op).then((r) => `${op}:${r.tag}`),
    );
    check('세 요청이 전부 도착', await until(() => inbox.length === 3), `${inbox.length}건`);
    check('pending이 3', client.pending === 3, String(client.pending));
    for (const { msg, sock } of [...inbox].reverse()) {
      sock.send(JSON.stringify({ id: msg['id'], ok: true, result: { tag: msg['op'] } }));
    }
    const paired = await Promise.all(promises);
    check(
      '★ 응답이 역순으로 와도 요청과 정확히 짝지어진다',
      paired.join('|') === 'ping:ping|version:version|status:status',
      paired.join('|'),
    );
    check('pending이 0으로 돌아온다', client.pending === 0, String(client.pending));

    // 3-4. 동시 20건 — 지연을 섞어 도착 순서를 흐트러뜨린다
    fake.handler = (msg, sock) => {
      const t = setTimeout(
        () => sock.send(JSON.stringify({ id: msg['id'], ok: true, result: { n: msg['id'] } })),
        Number(msg['id']) % 7,
      );
      t.unref?.();
    };
    const before = client.nextRequestId;
    const many = await Promise.all(
      Array.from({ length: 20 }, () => client.request<{ n: number }>('ping')),
    );
    const expected = Array.from({ length: 20 }, (_, k) => before + k);
    check(
      '★ 동시 20건이 각자 자기 id의 결과를 받는다',
      many.map((r) => r.n).join(',') === expected.join(','),
      `id ${before}..${before + 19}`,
    );
    check('20건 뒤에도 pending 0', client.pending === 0, String(client.pending));

    // 3-5. 실패 응답 → GatewayError. op/requestId가 붙는다
    fake.handler = (msg, sock) => {
      sock.send(JSON.stringify({ id: msg['id'], ok: false, error: '엔진이 거절했습니다' }));
    };
    const gerr = await caught(client.version());
    check(
      '★ ok:false → GatewayError (원문 + op + id)',
      gerr instanceof GatewayError
        && gerr.message === '엔진이 거절했습니다'
        && gerr.op === 'version'
        && typeof gerr.requestId === 'number',
      gerr instanceof GatewayError
        ? `${gerr.name}/${gerr.message}/op=${String(gerr.op)}/id=${String(gerr.requestId)}`
        : String(gerr),
    );

    await client.close();
  });

  // 3-6. 타임아웃, 그리고 뒤늦게 도착한 응답
  await withFakeGateway(async (fake) => {
    const client = new GatewayClient({ url: fake.url });
    const protocolErrors: string[] = [];
    client.on('protocolError', (p) => protocolErrors.push(p.error.message));
    await client.connect();

    let held: { msg: Record<string, unknown>; sock: FakeSocket } | null = null;
    fake.handler = (msg, sock) => {
      held = { msg, sock };
    };
    const t0 = performance.now();
    const terr = await caught(client.request('ping', undefined, { timeoutMs: 120 }));
    check(
      '★ 응답이 없으면 GatewayTimeoutError',
      terr instanceof GatewayTimeoutError && terr.op === 'ping',
      `${messageOf(terr)} (${ms(performance.now() - t0)})`,
    );
    check('타임아웃된 요청은 pending에서 빠진다', client.pending === 0, String(client.pending));

    const kept = held as { msg: Record<string, unknown>; sock: FakeSocket } | null;
    check('가짜 서버가 요청을 붙잡고 있었다', kept !== null);
    if (kept) {
      kept.sock.send(JSON.stringify({ id: kept.msg['id'], ok: true, result: { late: true } }));
      await sleep(120);
    }
    check(
      '★ 뒤늦게 온 응답은 조용히 삼켜지지 않고 protocolError로 나간다',
      protocolErrors.some((m) => m.includes('상관시킬 수 없는 응답')),
      protocolErrors.join(' | ') || '아무 것도 오지 않았다',
    );

    // 3-7. 상관 불가 메시지들 — 이벤트로 오인되면 서버의 오류를 통째로 삼킨다
    protocolErrors.length = 0;
    const frames: { frame: number; hasMesh: boolean }[] = [];
    const engineMsgs: string[] = [];
    client.on('frame', (e) => frames.push({ frame: e.frame, hasMesh: 'mesh' in e }));
    client.on('engineMessage', (e) => engineMsgs.push(e.message));

    const junk: [string, string][] = [
      ['JSON이 아님', 'not json at all'],
      ['JSON 객체가 아님(배열)', '[1,2,3]'],
      ['id 없는 실패 응답', '{"ok":false,"error":"op 필드가 없습니다"}'],
      ['모르는 id', '{"id":98765,"ok":true,"result":null}'],
      ['ok 필드 없음', '{"id":98766,"result":null}'],
      ['모르는 이벤트', '{"event":"nope"}'],
    ];
    for (const [, raw] of junk) fake.push(raw);
    await sleep(120);
    check(
      `★ 상관 불가 메시지 ${junk.length}종이 전부 protocolError로 나간다`,
      protocolErrors.length === junk.length,
      `${protocolErrors.length}/${junk.length}: ${protocolErrors.join(' | ').slice(0, 200)}`,
    );
    check(
      '★ 그 중 하나도 frame/engineMessage로 새지 않았다',
      frames.length === 0 && engineMsgs.length === 0,
      `frame=${frames.length}, engineMessage=${engineMsgs.length}`,
    );
    check(
      'id 없는 실패 응답의 원문이 보존된다',
      protocolErrors.includes('op 필드가 없습니다'),
      protocolErrors.join(' | '),
    );

    // 정상 이벤트는 그대로 흐른다. mesh는 **키 자체가 없다** (null이 아니다)
    fake.push('{"event":"frame","frame":7}');
    fake.push('{"event":"frame","frame":8,"mesh":{"patterns":[],"topology":false}}');
    fake.push('{"event":"engineMessage","message":"엔진 로그"}');
    await sleep(120);
    check(
      '★ 구독 전 frame에는 mesh 키가 없다 (null이 아니다)',
      frames.length === 2 && frames[0]?.hasMesh === false && frames[1]?.hasMesh === true,
      JSON.stringify(frames),
    );
    check('engineMessage가 그대로 온다', engineMsgs.join('') === '엔진 로그', engineMsgs.join('|'));

    await client.close();
  });

  // 3-8. 연결 전 요청 — 던지지 않고 **거부**해야 한다 (동기 throw면 호출자가 못 잡는다)
  const orphan = new GatewayClient({ url: 'http://127.0.0.1:1' });
  const oerr = await caught(orphan.ping());
  check(
    '★ 연결 전 request는 GatewayClosedError로 거부된다 (동기 throw 아님)',
    oerr instanceof GatewayClosedError && oerr.message.includes('state=idle'),
    messageOf(oerr),
  );
}

// ─────────────────────────────────────────────────────────────
// §4. 끊김과 재연결
//
// "재연결 = 새 워커 세션"이 지켜지지 않으면 앱이 빈 세션을 정상으로 오인한다
// (씬 미로드, 파라미터·구독 초기값, 라이선스 인스턴스 추가). 그 계약을 고정한다.
// ─────────────────────────────────────────────────────────────

async function sectionReconnect(): Promise<void> {
  section('§4. 끊김과 재연결 (가짜 게이트웨이)');

  // 4-1. 끊기면 대기 중이던 요청이 **전부** 거부된다 (남으면 await가 영원히 안 풀린다)
  await withFakeGateway(async (fake) => {
    const client = new GatewayClient({ url: fake.url });
    const closes: { code: number; willReconnect: boolean; retryInMs: number | null }[] = [];
    client.on('close', (e) =>
      closes.push({ code: e.code, willReconnect: e.willReconnect, retryInMs: e.retryInMs }),
    );
    await client.connect();

    fake.handler = () => {}; // 응답하지 않는다
    const pending = [
      caught(client.ping()),
      caught(client.version()),
      caught(client.status()),
    ];
    check('세 요청이 워커까지 나갔다', await until(() => fake.received.length === 3));
    check('pending이 3', client.pending === 3, String(client.pending));

    fake.kill();
    const errs = await Promise.all(pending);
    check(
      '★ 끊기면 대기 중 요청이 전부 GatewayClosedError로 거부된다',
      errs.every((e) => e instanceof GatewayClosedError),
      errs.map((e) => (e instanceof Error ? e.name : String(e))).join(','),
    );
    check(
      '★ 오류에 close 코드와 op이 실린다 (1006 = 난폭한 끊김)',
      errs.every((e) => e instanceof GatewayClosedError && e.code === 1006)
        && errs.map((e) => (e as GatewayClosedError).op).join(',') === 'ping,version,status',
      errs.map((e) => `${(e as GatewayClosedError).op}/${String((e as GatewayClosedError).code)}`).join(' '),
    );
    check('pending이 0으로 정리된다', client.pending === 0, String(client.pending));

    // 4-2. 기본값은 재연결 **꺼짐**
    check(
      '★ 재연결 기본 꺼짐 — close 이벤트가 그렇게 알린다',
      closes.length === 1 && closes[0]?.willReconnect === false && closes[0]?.retryInMs === null,
      JSON.stringify(closes),
    );
    await sleep(350);
    check(
      '★ 350ms를 기다려도 다시 붙지 않는다 (빈 세션이 조용히 생기지 않는다)',
      fake.connections === 1 && client.state === 'closed',
      `connections=${fake.connections}, state=${client.state}`,
    );

    // diagnose(): /api/health가 없는 곳이므로 gateway-down
    const dx = await client.diagnose();
    check(
      'diagnose()가 게이트웨이 부재를 알아본다 (fetchHealth는 던지지 않는다)',
      dx === 'gateway-down',
      dx,
    );
  });

  // 4-3. 재연결을 켜면 **새 세션임을 알린다**
  await withFakeGateway(async (fake) => {
    const client = new GatewayClient({
      url: fake.url,
      reconnect: { minDelayMs: 60, maxDelayMs: 200, factor: 1, jitter: 0 },
    });
    const opens: { reconnected: boolean; attempt: number }[] = [];
    const closes: { willReconnect: boolean; retryInMs: number | null }[] = [];
    client.on('open', (e) => opens.push(e));
    client.on('close', (e) => closes.push({ willReconnect: e.willReconnect, retryInMs: e.retryInMs }));

    await client.connect();
    check(
      '첫 연결의 open은 reconnected:false',
      opens.length === 1 && opens[0]?.reconnected === false && opens[0]?.attempt === 0,
      JSON.stringify(opens),
    );
    await client.ping();
    const idBeforeDrop = client.nextRequestId;

    fake.kill();
    check('재연결이 일어났다', await until(() => opens.length === 2, 4_000), `opens=${opens.length}`);
    check(
      '★ 재연결 open은 reconnected:true — 씬을 다시 로드해야 한다는 신호',
      opens[1]?.reconnected === true && (opens[1]?.attempt ?? 0) >= 1,
      JSON.stringify(opens[1]),
    );
    check('openCount가 2', client.openCount === 2, String(client.openCount));
    check(
      'close 이벤트가 재시도를 예고했다',
      closes[0]?.willReconnect === true && typeof closes[0]?.retryInMs === 'number',
      JSON.stringify(closes[0]),
    );
    check('가짜 서버도 두 번째 연결을 봤다', fake.connections === 2, String(fake.connections));

    fake.received.length = 0;
    await client.ping();
    check(
      '★ 재연결해도 요청 id를 재사용하지 않는다 (서버가 처리 중인 id를 거부한다)',
      fake.received[0]?.['id'] === idBeforeDrop,
      `기대 ${idBeforeDrop}, 실제 ${String(fake.received[0]?.['id'])}`,
    );

    // 4-4. close()는 정책이 있어도 재연결하지 않는다
    await client.close();
    await sleep(300);
    check(
      '★ close() 뒤에는 정책이 있어도 다시 붙지 않는다',
      fake.connections === 2 && client.state === 'closed',
      `connections=${fake.connections}, state=${client.state}`,
    );
  });

  // 4-5. 정책이 소진되면 connect()가 거부된다 (영원히 매달리지 않는다)
  {
    const dead = await freePort(); // 아무도 듣지 않는다
    const client = new GatewayClient({
      url: `http://127.0.0.1:${dead}`,
      reconnect: { minDelayMs: 20, maxDelayMs: 40, factor: 1, jitter: 0, maxAttempts: 2 },
    });
    const t0 = performance.now();
    const err = await caught(client.connect());
    check(
      '★ maxAttempts가 소진되면 connect()가 거부된다 (매달리지 않는다)',
      err instanceof GatewayClosedError,
      `${messageOf(err).slice(0, 90)} (${ms(performance.now() - t0)})`,
    );
    check('그 뒤 상태는 closed', client.state === 'closed', client.state);
    check('연결에 성공한 적이 없다', client.openCount === 0, String(client.openCount));
  }

  // 4-6. connect()는 멱등이다 (여러 곳에서 불러도 소켓이 하나)
  await withFakeGateway(async (fake) => {
    const client = new GatewayClient({ url: fake.url });
    await Promise.all([client.connect(), client.connect(), client.connect()]);
    await client.connect();
    check(
      'connect()를 4번 불러도 연결은 하나',
      fake.connections === 1 && client.openCount === 1,
      `connections=${fake.connections}, opens=${client.openCount}`,
    );
    await client.close();
    await client.close(); // 두 번 닫아도 안전
    check('close()는 두 번 불러도 안전하다', client.state === 'closed');
  });
}

// ─────────────────────────────────────────────────────────────
// §5. 개발 서버(Vite) 경유 — TASKS #11의 통과 기준 항목
//
// 프록시가 깨지면 #12 이후 전부가 "원인 모를 1006"과 "JSON 파싱 오류"가 된다.
// 그 원인이 한 곳(vite.config.ts)을 가리키게 하려고 기준에 들어가 있다.
//
// **vite.config.ts를 그대로 읽는다.** 프록시 설정을 인라인으로 다시 적으면
// 정작 그 파일이 깨져도 여기는 통과한다 — 그러면 테스트가 아니라 장식이다.
// 게이트웨이 주소만 GATEWAY_URL로 주입한다(설정 파일이 읽는 바로 그 변수다).
// ─────────────────────────────────────────────────────────────

async function sectionViteProxy(): Promise<void> {
  section('§5. 개발 서버(Vite) 경유 — /api/health가 브라우저까지 닿는가');

  const vitePort = await freePort();
  const savedGateway = process.env['GATEWAY_URL'];

  await withGateway(async (gw, addr) => {
    process.env['GATEWAY_URL'] = addr.url;
    let vite: { listen(): Promise<unknown>; close(): Promise<void> } | null = null;
    const t0 = performance.now();
    try {
      const mod = await import('vite');
      vite = await mod.createServer({
        configFile: path.resolve(FRONTEND, 'vite.config.ts'),
        root: FRONTEND,
        logLevel: 'error',
        // strictPort는 설정 파일 그대로 둔다. 포트만 비어 있는 것으로 바꾼다.
        server: { port: vitePort },
      });
      await vite.listen();
    } catch (err: unknown) {
      check('Vite 개발 서버 기동', false, messageOf(err));
      return;
    }
    const base = `http://127.0.0.1:${vitePort}`;
    check('Vite 개발 서버 기동', true, `${base} (${ms(performance.now() - t0)})`);

    try {
      // ★ 기준 항목.
      const res = await fetch(`${base}/api/health`, { headers: { accept: 'application/json' } });
      const body: unknown = await res.json().catch(() => null);
      check(
        '★★ 개발서버 경유 GET /api/health → 200',
        res.status === 200,
        `status=${res.status}`,
      );
      check(
        '★ 본문이 정말 게이트웨이의 것이다 (Vite가 만든 게 아니다)',
        isRecord(body) && body['status'] === 'ok' && body['pid'] === process.pid,
        JSON.stringify(body),
      );

      // 프론트가 실제로 쓰는 함수로도 같은 것을 본다.
      const health = await fetchHealth({ base });
      check(
        'fetchHealth()가 프록시 너머 게이트웨이를 본다',
        health !== null && health.pid === process.pid,
        JSON.stringify(health),
      );
      const scenes = await listScenes({ base });
      check('listScenes()도 프록시를 탄다 (JSON이 온다)', Array.isArray(scenes), `${scenes.length}건`);

      // Vite 자신도 서빙하고 있다 — 프록시가 전부를 삼키지 않는다.
      const idx = await fetch(`${base}/`);
      const html = await idx.text();
      check(
        'Vite가 index.html을 서빙한다 (프록시가 /를 삼키지 않는다)',
        idx.status === 200 && html.includes('/src/main.ts'),
        `status=${idx.status}, ${html.length}바이트`,
      );

      // ★ ws:true 트랩. 이 줄이 없으면 /api는 되는데 WS만 1006이 된다.
      if (existsSync(EXE)) {
        const client = new GatewayClient({ url: base, requestTimeoutMs: 20_000 });
        try {
          const tws = performance.now();
          await client.connect();
          const ver = await client.version();
          check(
            '★ 개발서버 경유 WebSocket도 붙는다 (vite.config의 ws:true)',
            client.connected && typeof ver.zelus === 'string' && ver.zelus.length > 0,
            `zelus=${ver.zelus} (${ms(performance.now() - tws)})`,
          );
        } catch (err: unknown) {
          check('★ 개발서버 경유 WebSocket도 붙는다 (vite.config의 ws:true)', false, messageOf(err));
        } finally {
          await client.close().catch(() => {});
        }
      } else {
        note('WS 프록시 검증 생략', `워커 exe가 없다: ${EXE}`);
      }
    } finally {
      await vite.close();
      if (savedGateway === undefined) delete process.env['GATEWAY_URL'];
      else process.env['GATEWAY_URL'] = savedGateway;
    }
    void gw;
  }, { sessions: { idleTimeout: 0, requestTimeoutMs: 20_000 } });
}

// ─────────────────────────────────────────────────────────────
// §6. 정적 서빙 + SPA 폴백
//
// 배포에서는 게이트웨이가 dist/를 서빙한다. 그때 SPA 폴백이 404 catch-all을
// 가려버리면 `fetch('/api/오타')`가 HTML을 받고, 클라이언트는 `res.json()`에서
// 파싱 오류로 죽는다 — 진짜 원인(오타난 경로)이 그 뒤에 완전히 묻힌다.
// **기본이 꺼져 있으므로 켜서 확인해야 한다.**
// ─────────────────────────────────────────────────────────────

async function sectionStatic(): Promise<void> {
  section('§6. 정적 서빙 + SPA 폴백');

  // 6-1. 꺼진 것이 기본이다 (server/smoke.ts의 "알 수 없는 경로 → 404 JSON"이 이 전제 위에 있다)
  await withGateway(async (_gw, addr) => {
    const res = await fetch(`${addr.url}/`, { headers: { accept: 'text/html' } });
    const text = await res.text();
    check(
      '★ 정적 서빙 기본 꺼짐 — GET / 도 404 JSON이다',
      res.status === 404 && text.trimStart().startsWith('{'),
      `status=${res.status}, ${text.slice(0, 60)}`,
    );
  });

  // 6-2. 켜면 어떻게 되는가
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><html><body>SPA-ROOT-MARKER</body></html>',
      'utf8',
    );
    await writeFile(path.join(dir, 'assets', 'app.js'), 'export const marker = "ASSET";\n', 'utf8');
    await writeFile(path.join(dir, '.env.secret'), 'DO-NOT-SERVE', 'utf8');

    await withGateway(async (_gw, addr) => {
      const get = async (
        p: string,
        init?: RequestInit,
      ): Promise<{ status: number; text: string; type: string }> => {
        const r = await fetch(`${addr.url}${p}`, init);
        return { status: r.status, text: await r.text(), type: r.headers.get('content-type') ?? '' };
      };

      const root = await get('/', { headers: { accept: 'text/html' } });
      check(
        'GET / → index.html',
        root.status === 200 && root.text.includes('SPA-ROOT-MARKER'),
        `status=${root.status}, ${root.type}`,
      );

      const asset = await get('/assets/app.js');
      check(
        '실제 파일은 실제 파일이다 (폴백이 가로채지 않는다)',
        asset.status === 200 && asset.text.includes('ASSET'),
        `status=${asset.status}, ${asset.type}`,
      );

      const deep = await get('/scene/abc/def', { headers: { accept: 'text/html' } });
      check(
        'SPA 폴백: /scene/abc/def → index.html (새로고침해도 뜬다)',
        deep.status === 200 && deep.text.includes('SPA-ROOT-MARKER'),
        `status=${deep.status}`,
      );

      // ★ 핵심 두 가지. 여기가 뚫리면 fetch가 HTML을 파싱하려다 죽는다.
      const apiMiss = await get('/api/nope', { headers: { accept: 'text/html' } });
      check(
        '★ /api/* 는 accept:text/html 이어도 JSON 404다',
        apiMiss.status === 404 && apiMiss.type.includes('json'),
        `status=${apiMiss.status}, ${apiMiss.type}, ${apiMiss.text.slice(0, 60)}`,
      );

      const jsonMiss = await get('/nope', { headers: { accept: 'application/json' } });
      check(
        '★ accept:application/json 은 폴백에 안 먹힌다 → JSON 404',
        jsonMiss.status === 404 && jsonMiss.type.includes('json'),
        `status=${jsonMiss.status}, ${jsonMiss.type}, ${jsonMiss.text.slice(0, 60)}`,
      );

      const posted = await get('/nope', { method: 'POST', headers: { accept: 'text/html' } });
      check(
        'GET/HEAD가 아니면 폴백하지 않는다 (POST → JSON 404)',
        posted.status === 404 && posted.type.includes('json'),
        `status=${posted.status}, ${posted.type}`,
      );

      const health = await get('/api/health', { headers: { accept: 'application/json' } });
      check(
        '정적 서빙이 API를 가리지 않는다',
        health.status === 200 && health.text.includes('"status":"ok"'),
        `status=${health.status}`,
      );

      const dotfile = await get('/.env.secret', { headers: { accept: 'application/json' } });
      check(
        '★ dotfile은 서빙되지 않는다',
        dotfile.status === 404 && !dotfile.text.includes('DO-NOT-SERVE'),
        `status=${dotfile.status}, ${dotfile.text.slice(0, 60)}`,
      );

      // http.ts가 정적 서빙 아래에서도 멀쩡한가 — 이게 이 섹션의 실제 목적이다.
      const h = await fetchHealth({ base: addr.url });
      check('fetchHealth()가 정적 서빙 아래에서도 동작', h !== null && h.status === 'ok');
      const list = await listScenes({ base: addr.url });
      check('listScenes()가 HTML을 받지 않는다', Array.isArray(list), `${list.length}건`);
    }, { staticDir: dir });
  });

  // 6-3. 진짜 빌드 산출물 (있으면)
  if (existsSync(path.join(DIST, 'index.html'))) {
    await withGateway(async (_gw, addr) => {
      const r = await fetch(`${addr.url}/`, { headers: { accept: 'text/html' } });
      const html = await r.text();
      const m = /src="(\/assets\/[^"]+\.js)"/.exec(html);
      check(
        '실제 dist/index.html이 서빙된다',
        r.status === 200 && m !== null,
        `status=${r.status}, script=${m?.[1] ?? '없음'}`,
      );
      if (m?.[1]) {
        const js = await fetch(`${addr.url}${m[1]}`);
        const body = await js.text();

        // ── 왜 `\bBuffer\b` 를 세지 않는가 ────────────────────────
        // three.js 가 자기 경고 문자열에 그 단어를 쓴다:
        //   "BufferGeometry: Buffer size too small for points data…"
        // `setFromPoints` 안의 리터럴이라 트리셰이킹으로 빠지지 않는다. 단어를
        // 세는 방식은 three 를 들이는 순간(#12) 영구 오탐이 된다. 그래서 단어가
        // 아니라 **Node 런타임을 실제로 부르는 형태**만 본다.
        const NODE_ONLY: readonly [string, RegExp][] = [
          ['Buffer.<메서드>', /\bBuffer\s*\.\s*(?:from|alloc|allocUnsafe|isBuffer|concat|byteLength)\b/],
          ['globalThis.Buffer', /\bglobalThis\s*\.\s*Buffer\b/],
          ['require(buffer)', /\brequire\s*\(\s*["'](?:node:)?buffer["']\s*\)/],
          ['node: 스킴', /["']node:[a-z_]+["']/],
          ['createRequire', /\bcreateRequire\b/],
          ['__dirname/__filename', /\b__dirname\b|\b__filename\b/],
          ['process.versions', /\bprocess\s*\.\s*versions\b/],
        ];
        const hits = NODE_ONLY.filter(([, re]) => re.test(body)).map(([name]) => name);
        check(
          '★ 번들에 Node 런타임 호출이 없다 (backend SDK가 섞이면 여기가 걸린다)',
          js.status === 200 && hits.length === 0,
          hits.length > 0 ? `걸린 패턴: ${hits.join(', ')}` : `status=${js.status}, ${body.length}바이트`,
        );

        // ★ 이쪽이 진짜 계약이다. 위 패턴은 "무엇을 부르는가"를 보므로 구멍이
        //   있다 — Buffer를 안 쓰는 함수 하나(예: isEvent)만 값으로 import해도
        //   backend 모듈은 번들에 들어오는데 위 목록은 조용하다. 소스맵의
        //   `sources`는 **번들에 들어간 모듈 목록 그 자체**라 그 구멍이 없다.
        //   (vite.config.ts가 sourcemap:true다. 꺼지면 이 단언이 먼저 알려준다.)
        const map = await fetch(`${addr.url}${m[1]}.map`);
        const sources = map.ok
          ? ((JSON.parse(await map.text()) as { sources?: string[] }).sources ?? [])
          : [];
        const leaked = sources
          .map((s) => s.replace(/\\/g, '/'))
          .filter((s) => /(^|\/)backend\//.test(s));
        const appSources = sources.filter((s) => !s.includes('node_modules'));
        check(
          '★ 번들 모듈 목록에 backend/ 가 하나도 없다 (import type만 썼다 — 소스맵 근거)',
          map.ok && sources.length > 0 && leaked.length === 0,
          leaked.length > 0
            ? `섞인 모듈: ${leaked.join(', ')}`
            : `모듈 ${sources.length}개 (앱 소스 ${appSources.length}개), 소스맵 status=${map.status}`,
        );
        note(
          '번들 크기',
          `${body.length}바이트 (three 포함). 상한을 걸지 않는 이유는 backend 누출이 겨우 수십 KB라 크기로는 안 잡히기 때문이다 — 위 두 단언이 그 일을 한다`,
        );
      }
    }, { staticDir: DIST });
  } else {
    note('dist 검증 생략', `아직 빌드되지 않았다: ${DIST} (npm run build 뒤 다시 돌면 잡힌다)`);
  }
}

// ─────────────────────────────────────────────────────────────
// §7. 실제 워커 종단 — 진짜 메시로 §1·§2를 다시 통과시킨다
//
// 합성 데이터로 길이·정렬을 아무리 고정해도, 워커가 보내는 모양이 바뀌면
// 그건 못 잡는다. 여기가 그 한 겹이다: 워커 → 게이트웨이 → 클라이언트 →
// 디코더까지 실제 바이트가 흐른다.
//
// 씬은 **이미 업로드된 것을 재사용한다.** 씬 id는 내용 해시가 아니라 난수라
// (files.ts) 매번 올리면 107MB가 계속 쌓인다. 없을 때만 한 번 올린다.
// ─────────────────────────────────────────────────────────────

async function findOrUploadScene(base: string): Promise<SceneSummary | null> {
  if (!existsSync(ZLS)) return null;
  const bytes = statSync(ZLS).size;
  const existing = await listScenes({ base });
  const hit = existing.find((s) => s.name === 'sample.zls' && s.bytes === bytes);
  if (hit) {
    note('씬 재사용', `${hit.id} (${hit.bytes}바이트) — 새로 올리지 않는다`);
    return hit;
  }
  const t0 = performance.now();
  const data = await readFile(ZLS);
  const up = await uploadScene('sample.zls', data);
  note('씬 업로드', `${up.id} (${up.bytes}바이트, ${ms(performance.now() - t0)})`);
  return up;
}

async function sectionRealWorker(): Promise<void> {
  section('§7. 실제 워커 종단 (진짜 메시)');

  if (!existsSync(EXE) || !existsSync(ZLS)) {
    check('워커 exe와 sample.zls가 있다', false, `exe=${existsSync(EXE)}, zls=${existsSync(ZLS)}`);
    return;
  }

  await withGateway(async (_gw, addr) => {
    const scene = await findOrUploadScene(addr.url);
    if (!scene) {
      check('씬 준비', false, 'sample.zls를 준비하지 못했다');
      return;
    }

    const client = new GatewayClient({ url: addr.url, requestTimeoutMs: 60_000 });
    const frames: { frame: number; hasMesh: boolean; mesh?: FrameMesh }[] = [];
    const protocolErrors: string[] = [];
    client.on('frame', (e) =>
      frames.push(e.mesh === undefined
        ? { frame: e.frame, hasMesh: false }
        : { frame: e.frame, hasMesh: true, mesh: e.mesh }),
    );
    client.on('protocolError', (p) => protocolErrors.push(p.error.message));

    try {
      let t = performance.now();
      await client.connect();
      check('실제 게이트웨이에 연결 (= 워커가 이미 살아 있다)', client.connected, ms(performance.now() - t));

      const ver = await client.version();
      check(
        'version',
        typeof ver.zelus === 'string' && ver.zelus.length > 0,
        `zelus=${ver.zelus}, lumia=${ver.lumia}`,
      );

      t = performance.now();
      const loaded = await client.load(scene.id);
      check(
        '★ load 결과에 서버 경로가 아니라 씬 id가 온다',
        loaded.loaded === true && loaded.scene === scene.id,
        `${JSON.stringify(loaded)} (${ms(performance.now() - t)})`,
      );

      const info = await client.meshInfo();
      check(
        'meshInfo',
        info.patterns.length > 0 && info.totalVertices > 0,
        `패턴 ${info.patterns.length}, 정점 ${info.totalVertices}, 삼각형 ${info.totalTriangles}`,
      );

      // ── 진짜 바이트로 §1·§2를 다시 ─────────────────────────
      t = performance.now();
      const md = await client.meshData(true);
      const geomMs = performance.now() - t;
      check('meshData(topology:true)', md.patterns.length === info.patterns.length, ms(geomMs));

      let decoded = 0;
      let decodeErr = '';
      try {
        const patterns = decodePatterns(md);
        decoded = patterns.length;
        // decodePatterns 자체가 길이를 검증한다. 통과했다는 게 곧 단언이다.
        const offsetsZero = patterns.every(
          (p) => p.positions.byteOffset === 0
            && (p.indices?.byteOffset ?? 0) === 0
            && (p.uvs?.byteOffset ?? 0) === 0,
        );
        check(
          '★ 실제 메시가 길이 검증을 통과한다 (positions=v×3, indices=t×3, uvs=v×2)',
          patterns.every(
            (p) => p.positions.length === p.vertices * 3
              && (p.indices?.length ?? p.triangles * 3) === p.triangles * 3
              && (p.uvs?.length ?? p.vertices * 2) === p.vertices * 2,
          ),
          `패턴 ${decoded}개, 정점 ${patterns.reduce((a, p) => a + p.vertices, 0)}`,
        );
        check('★ 실제 메시의 뷰도 전부 byteOffset 0', offsetsZero);

        // 브라우저 구현 === SDK 구현, 실제 페이로드로.
        const identical = md.patterns.every((p) => {
          if (!p.positions) return true;
          return sameBytes(decodeFloat32(p.positions), sdkDecodeFloat32(p.positions));
        });
        check('★ 실제 페이로드에서도 브라우저 디코딩 === SDK 디코딩', identical);

        // 값이 그럴듯한가 — 전부 0이면 위 검증이 전부 통과해도 화면은 빈다.
        const first = patterns[0];
        const finite = first ? Array.from(first.positions).every((v) => Number.isFinite(v)) : false;
        const nonzero = first ? Array.from(first.positions).some((v) => v !== 0) : false;
        check('디코딩된 좌표가 유한하고 0이 아니다', finite && nonzero, first
          ? `첫 정점 (${first.positions[0]}, ${first.positions[1]}, ${first.positions[2]})`
          : '패턴 없음');

        const stats = meshStats(md);
        note('메시 규모', `패턴 ${stats.patterns}, 정점 ${stats.vertices}, 삼각형 ${stats.triangles}, base64 ${stats.base64Bytes}바이트`);
      } catch (err: unknown) {
        decodeErr = messageOf(err);
        check('★ 실제 메시 디코딩', false, decodeErr);
      }

      // ── 구독 전: frame에 mesh 키가 없다 ────────────────────
      frames.length = 0;
      await client.start();
      const reached = await client.waitForFrame(5, 30_000).then(
        (f) => f,
        (e: unknown) => {
          check('프레임 진행', false, messageOf(e));
          return -1;
        },
      );
      await client.pause();
      check('프레임이 흐른다', reached >= 5, `frame ${reached}, ${frames.length}건 수신`);
      check(
        '★ 구독 전에는 프레임에 mesh 키가 없다',
        frames.length > 0 && frames.every((f) => !f.hasMesh),
        `${frames.filter((f) => f.hasMesh).length}/${frames.length}건에 mesh가 실렸다`,
      );

      // ── 구독 후: 프레임마다 메시가 오고, 전부 디코딩된다 ───
      await client.subscribe();
      frames.length = 0;
      await client.start();
      const target = reached + 6;
      await client.waitForFrame(target, 30_000).catch(() => {});
      await client.pause();
      await client.unsubscribe();

      const withMesh = frames.filter((f) => f.hasMesh);
      check(
        '★ 구독 중에는 프레임마다 mesh가 실린다',
        withMesh.length > 0 && withMesh.length === frames.length,
        `${withMesh.length}/${frames.length}건`,
      );

      let frameDecodeErr = '';
      let checkedPatterns = 0;
      for (const f of withMesh) {
        if (!f.mesh) continue;
        try {
          checkedPatterns += decodePatterns(f.mesh).length;
        } catch (err: unknown) {
          frameDecodeErr = `frame ${f.frame}: ${messageOf(err)}`;
          break;
        }
      }
      check(
        '★ 구독 중 모든 프레임의 모든 패턴이 길이 검증을 통과한다',
        frameDecodeErr === '' && checkedPatterns > 0,
        frameDecodeErr || `프레임 ${withMesh.length}개 / 패턴 ${checkedPatterns}개`,
      );

      check('종단 중 protocolError가 없었다', protocolErrors.length === 0, protocolErrors.join(' | '));
      check('요청이 하나도 남아있지 않다', client.pending === 0, String(client.pending));

      // 세션 종료 = 소켓 닫기 (quit op은 애초에 막혀 있다)
      const closeSeen: number[] = [];
      client.on('close', (e) => closeSeen.push(e.code));
      await client.close();
      check('close()로 세션이 끝난다', client.state === 'closed' && closeSeen.length === 1, JSON.stringify(closeSeen));
    } finally {
      await client.close().catch(() => {});
    }
  }, { sessions: { idleTimeout: 0, requestTimeoutMs: 60_000 } });
}

// ─────────────────────────────────────────────────────────────
// §8. 3D 뷰 계층 (viewer3d) — 화면을 봐도 원인이 안 보이는 것들
//
// #12의 통과 기준은 `verify: manual`이라 "옷이 떴는가"는 사람이 본다. 그런데
// 사람이 볼 수 있는 것은 **결과뿐이고 원인이 아니다.** 아래 셋은 전부 증상이
// "화면이 비었다" 하나로 수렴해서, 눈으로는 어느 것인지 절대 구분할 수 없다:
//
//   - 인덱스가 Int32Array로 넘어간다 → drawElements가 거부 → 아무것도 안 그려짐
//   - 법선이 없다                    → 조명 아래 새까맣게 → "안 그려짐"으로 보임
//   - 경계구를 갱신 안 한다          → 프러스텀 컬링에 잘림 → 움직이다 사라짐
//
// 그리고 이 셋은 전부 DOM 없이 검증된다. `cloth.ts`는 three의 **데이터 구조만**
// 쓰고 WebGLRenderer를 모른다(그건 viewer.ts다). 그래서 Node에서 그대로 돈다 —
// 여기가 #12에서 자동으로 고정할 수 있는 유일한 영역이다.
//
// ⚠️ viewer.ts는 여기서 값으로 import하지 않는다. WebGLRenderer/ResizeObserver/
//    OrbitControls는 DOM이 있어야 만들어진다. `showScene()`이 실제로 만지는
//    표면은 `viewer.cloth`와 `viewer.frameCamera()` 둘뿐이라 대역으로 충분하다.
// ─────────────────────────────────────────────────────────────

/** 합성 패턴 하나. 값은 서로 겹치지 않게 seed로 어긋내 둔다 */
function synthPattern(uuid: string, vertices: number, triangles: number, seed = 0): DecodedPattern {
  const positions = new Float32Array(vertices * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = seed * 1000 + i * 0.5;
  const indices = new Int32Array(triangles * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = (i * 7 + seed) % vertices;
  const uvs = new Float32Array(vertices * 2);
  for (let i = 0; i < uvs.length; i++) uvs[i] = i * 0.25;
  return { uuid, positions, indices, uvs, vertices, triangles };
}

/**
 * Node에서 세울 수 있는 최소한의 Viewer3D 대역.
 *
 * `showScene()`이 쓰는 것만 갖춘다. 진짜 Viewer3D를 만들면 WebGLRenderer가
 * 캔버스를 요구해서 Node에서는 생성 자체가 불가능하다.
 */
function stubViewer(): { viewer: Viewer3D; cloth: ClothObject; framed: () => number } {
  const cloth = new ClothObject();
  let framed = 0;
  const viewer = {
    cloth,
    frameCamera: (): void => {
      framed += 1;
    },
  } as unknown as Viewer3D;
  return { viewer, cloth, framed: () => framed };
}

function isGlIndexArray(a: ArrayLike<number>): boolean {
  // WebGL의 drawElements는 UNSIGNED_BYTE/SHORT/INT만 받는다. three는 배열
  // 타입을 보고 GL 타입을 정하므로, 이 셋이 아니면 그리기가 성립하지 않는다.
  return a instanceof Uint8Array || a instanceof Uint16Array || a instanceof Uint32Array;
}

function sectionClothTopology(): void {
  section('§8. 3D 뷰 — 토폴로지 (cloth.ts, DOM 없이)');

  const src = synthPattern('p0', 6, 4, 1);
  // 디코더가 준 배열을 나중에 건드려 본다. 소유권 검사에 쓴다.
  const srcPositions = src.positions;
  const srcIndices = src.indices as Int32Array;

  const cloth = new ClothObject();
  cloth.setTopology([src, synthPattern('p1', 5, 3, 2)]);

  check('패턴 수', cloth.patternCount === 2, String(cloth.patternCount));
  check('정점·삼각형 합계', cloth.vertexCount === 11 && cloth.triangleCount === 7,
    `정점 ${cloth.vertexCount}, 삼각형 ${cloth.triangleCount}`);
  check('메시가 group에 붙었다 (씬에 넣을 것이 여기 있다)',
    cloth.group.children.length === 2, String(cloth.group.children.length));

  const p0 = cloth.patterns[0];
  if (!p0) {
    check('패턴 0이 있다', false);
    return;
  }
  const idx = p0.geometry.getIndex();

  // ★ 이 단위에서 가장 조용한 회귀. toIndexArray()가 사라지면 예외도 경고도
  //   없이 그냥 아무것도 안 그려진다 — 화면만 보면 원인이 보이지 않는다.
  check(
    '★ 인덱스가 WebGL이 받는 타입이다 (Int32Array 그대로면 아무것도 안 그려진다)',
    idx !== null && isGlIndexArray(idx.array),
    idx === null ? 'index가 없다' : idx.array.constructor.name,
  );
  check(
    '★ 타입을 바꿔도 인덱스 값이 보존된다 (비트 재해석이지 캐스팅이 아니다)',
    idx !== null && idx.array.length === srcIndices.length
      && Array.from(idx.array).every((v, i) => v === srcIndices[i]),
    idx === null ? '-' : `${Array.from(idx.array).slice(0, 6).join(',')} ← ${Array.from(srcIndices).slice(0, 6).join(',')}`,
  );

  // 소유권 — 디코더 버퍼는 프레임마다 새로 나므로 붙잡고 있으면 안 된다.
  srcPositions[0] = -12345;
  srcIndices[0] = 99;
  check(
    '★ 지오메트리가 디코더 버퍼를 붙잡지 않는다 (복사본을 소유한다)',
    (p0.position.array as Float32Array)[0] !== -12345
      && (idx === null || idx.array[0] !== 99),
    `position[0]=${(p0.position.array as Float32Array)[0]}, index[0]=${idx?.array[0]}`,
  );

  check('position은 vec3다', p0.position.itemSize === 3 && p0.position.count === 6,
    `itemSize=${p0.position.itemSize}, count=${p0.position.count}`);
  const uv = p0.geometry.getAttribute('uv');
  check('uv는 vec2다 (#15가 cm 단위 2D 좌표로 쓴다)',
    uv !== undefined && uv.itemSize === 2 && uv.count === 6,
    uv === undefined ? '없음' : `itemSize=${uv.itemSize}, count=${uv.count}`);

  // ★ 법선이 없으면 조명 아래에서 새까맣다 = 눈에는 "안 그려짐"과 같다.
  const normal = p0.geometry.getAttribute('normal');
  check(
    '★ 법선이 만들어졌다 (프로토콜에 없으므로 여기서 안 만들면 새까맣게 나온다)',
    normal !== undefined && normal.count === 6
      && Array.from(normal.array).every((v) => Number.isFinite(v)),
    normal === undefined ? '없음' : `count=${normal.count}`,
  );

  check('position이 매 프레임 갱신될 것이라고 표시돼 있다 (#13)',
    p0.position.usage === THREE.DynamicDrawUsage, String(p0.position.usage));
  check('★ 머티리얼이 양면이다 (단면이면 옷 안쪽에서 통째로 사라진다)',
    (p0.mesh.material as THREE.MeshStandardMaterial).side === THREE.DoubleSide,
    String((p0.mesh.material as THREE.MeshStandardMaterial).side));
  check('프러스텀 컬링이 꺼져 있다 (패턴 하나가 잘려 나가는 사고를 막는다)',
    p0.mesh.frustumCulled === false, String(p0.mesh.frustumCulled));
  check('경계구·경계상자가 계산돼 있다',
    p0.geometry.boundingSphere !== null && p0.geometry.boundingBox !== null
    && Number.isFinite(p0.geometry.boundingSphere?.radius ?? NaN),
    `r=${p0.geometry.boundingSphere?.radius}`);
  check('boundingBox()가 비어 있지 않다 (카메라 맞춤이 여기에 걸려 있다)',
    !cloth.boundingBox().isEmpty());

  // ── setTopology 멱등 — 재연결 후 재로드가 정확히 이 경로다 ──
  let disposed = 0;
  for (const p of cloth.patterns) p.geometry.addEventListener('dispose', () => { disposed += 1; });
  cloth.setTopology([synthPattern('p0', 6, 4, 3), synthPattern('p1', 5, 3, 4)]);
  check(
    '★ setTopology를 다시 불러도 메시가 겹쳐 쌓이지 않는다 (재연결 재로드 경로)',
    cloth.group.children.length === 2 && cloth.patternCount === 2,
    `children=${cloth.group.children.length}, patterns=${cloth.patternCount}`,
  );
  check('★ 이전 지오메트리가 해제됐다 (반복 재로드가 GPU 메모리를 흘리지 않는다)',
    disposed === 2, `${disposed}/2`);
  check('정점·삼각형 수가 누적되지 않는다',
    cloth.vertexCount === 11 && cloth.triangleCount === 7,
    `정점 ${cloth.vertexCount}, 삼각형 ${cloth.triangleCount}`);

  cloth.clear();
  check('clear()가 전부 비운다',
    cloth.patternCount === 0 && cloth.group.children.length === 0 && cloth.vertexCount === 0);
}

function sectionClothFrames(): void {
  section('§8-2. 3D 뷰 — 프레임 갱신 계약 (#13이 얹힐 자리)');

  const cloth = new ClothObject();
  cloth.setTopology([synthPattern('p0', 6, 4, 1), synthPattern('p1', 5, 3, 2)]);
  const p0 = cloth.patterns[0];
  if (!p0) {
    check('패턴 0이 있다', false);
    return;
  }
  const sphereBefore = p0.geometry.boundingSphere?.center.x ?? NaN;
  // ⚠️ `needsUpdate`는 three에서 **setter 전용**이다(getter가 없어 읽으면
  //    undefined). 실제로 올라간 표시는 `version` 증가 쪽이다.
  const versionBefore = p0.position.version;

  // 정상 경로
  const next0 = synthPattern('p0', 6, 4, 9);
  const ok = cloth.updatePositions([next0, synthPattern('p1', 5, 3, 9)]);
  check('정상 갱신은 true', ok === true, String(ok));
  check('★ 실제로 값이 반영됐다',
    (p0.position.array as Float32Array)[0] === next0.positions[0],
    `${(p0.position.array as Float32Array)[0]} === ${next0.positions[0]}`);
  check('★ GPU 업로드가 예약됐다 (needsUpdate → version 증가. 안 서면 화면이 멎는다)',
    p0.position.version > versionBefore, `${versionBefore} → ${p0.position.version}`);
  check(
    '★ 경계구가 다시 계산됐다 (안 하면 옷이 움직이다 컬링에 잘려 사라진다 / #16 레이캐스팅이 같은 값을 쓴다)',
    (p0.geometry.boundingSphere?.center.x ?? NaN) !== sphereBefore,
    `${sphereBefore} → ${p0.geometry.boundingSphere?.center.x}`,
  );

  // ── 거부해야 하는 것들. 여기서 true를 돌려주면 어긋난 메시를 조용히 그린다 ──
  const mark = (p0.position.array as Float32Array)[0];
  const versionAtReject = p0.position.version;

  check('패턴 수가 다르면 false (토폴로지가 바뀌었다는 뜻이다)',
    cloth.updatePositions([synthPattern('p0', 6, 4, 5)]) === false);
  check('모르는 uuid면 false (다른 씬이다)',
    cloth.updatePositions([synthPattern('p0', 6, 4, 5), synthPattern('그런패턴없음', 5, 3, 5)]) === false);
  // 뒤쪽 패턴만 어긋나게 둔다. 앞쪽(p0)은 멀쩡하므로, 사전 검증 없이 쓰는
  // 구현이면 p0에 5000이 들어가 버린다 — 바로 아래 단언이 그걸 본다.
  check('정점 수가 다르면 false',
    cloth.updatePositions([synthPattern('p0', 6, 4, 5), synthPattern('p1', 4, 3, 5)]) === false);

  // ★ 절반만 쓰이면 화면에 형체가 깨진 옷이 뜨는데 원인을 눈으로 못 찾는다.
  check(
    '★ 거부할 때 절반도 쓰지 않는다 (앞 패턴이 멀쩡해도 건드리지 않는다)',
    (p0.position.array as Float32Array)[0] === mark
      && p0.position.version === versionAtReject,
    `값 ${(p0.position.array as Float32Array)[0]} === ${mark}, version ${p0.position.version} === ${versionAtReject}`,
  );

  cloth.clear();
}

// ─────────────────────────────────────────────────────────────
// §8-5 ~ §8-7. 프레임 스트리밍 (#13)
//
// #13의 통과 기준은 "옷이 움직인다" 하나이고 verify는 manual이다. 사람이
// 화면에서 볼 수 있는 것은 **움직인다/안 움직인다** 둘뿐인데, "안 움직인다"에
// 도달하는 경로는 최소 여섯이고 화면에서는 전부 똑같이 보인다:
//
//   ① 구독이 안 켜졌다      → frame은 오는데 mesh가 없다 (번호만 오른다)
//   ② 칸이 큐가 됐다        → 화면이 3초 전 옷을 그린다 (움직이긴 한다)
//   ③ 최신이 아니라 옛것을 푼다 → 위와 같은 증상, 원인이 다르다
//   ④ drain이 던졌다        → rAF가 통째로 멎어 조작까지 죽는다
//   ⑤ updatePositions가 false → 화면이 얼어붙는데 프레임 번호는 계속 오른다
//   ⑥ version이 안 오른다   → 좌표는 바뀌었는데 GPU에 안 올라간다
//
// 아래 셋이 이 여섯을 전부 화면 없이 가른다. 사람에게 남기는 판정은
// **"three가 그린 픽셀이 실제로 바뀌는가"** 하나뿐이다 — WebGL 컨텍스트가
// 있어야만 확인되는, 여기서 원리적으로 못 덮는 마지막 한 칸이다.
// ─────────────────────────────────────────────────────────────

/**
 * frame 이벤트의 mesh 를 만든다.
 *
 * ⚠️ **positions만 싣는다.** 실제 워커의 frame 이벤트가 그렇다 — indices·uvs는
 *    프레임 간 고정이라 서버가 보내지 않는다. 여기서 실어 버리면 테스트가
 *    실제와 다른 모양을 검증하게 되고, "frame만으로는 토폴로지를 복구할 수
 *    없다"는 #13의 전제 자체가 무너진다.
 */
function frameMeshOf(patterns: readonly DecodedPattern[]): FrameMesh {
  return {
    topology: false,
    patterns: patterns.map((p) => ({
      uuid: p.uuid,
      vertices: p.vertices,
      triangles: p.triangles,
      positions: bytesToBase64(
        new Uint8Array(p.positions.buffer, p.positions.byteOffset, p.positions.byteLength),
      ),
    })),
  };
}

/** seed 하나로 프레임 mesh 하나. positions[0] === seed × 1000 이라 눈으로 구분된다 */
function frameAt(seed: number): FrameMesh {
  return frameMeshOf([synthPattern('p0', 6, 4, seed), synthPattern('p1', 5, 3, seed)]);
}

/**
 * three 없이 `PositionSink` 를 만족하는 대역.
 *
 * 진짜 `ClothObject` 로는 못 보는 것이 둘 있어서 필요하다: (a) `updatePositions`
 * 가 **몇 번, 무엇으로** 불렸는지, (b) `false` 를 **원할 때** 돌려주는 것.
 * 진짜 옷으로 (b)를 만들려면 토폴로지를 어긋내야 하는데, 그러면 "불일치를
 * 만드는 방법"이 단언에 섞여 들어와 검증하려는 것이 흐려진다.
 */
function recordingSink(patternCount = 2): {
  sink: PositionSink;
  calls: DecodedPattern[][];
  reject: () => void;
  allow: () => void;
} {
  const calls: DecodedPattern[][] = [];
  let accept = true;
  const sink: PositionSink = {
    updatePositions(patterns: readonly DecodedPattern[]): boolean {
      calls.push([...patterns]);
      return accept;
    },
    get patternCount(): number {
      return patternCount;
    },
  };
  return { sink, calls, reject: () => { accept = false; }, allow: () => { accept = true; } };
}

/** 주입 가능한 시계. fps를 결정적으로 잰다 */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (msec: number) => { t += msec; } };
}

/** 배열 앞 n개를 읽기 좋게 */
function head3(a: Float32Array): string {
  return `[${Array.from(a.slice(0, 3)).map((v) => v.toFixed(3)).join(', ')}]`;
}

function sectionFrameStreamQueue(): void {
  section('§8-5. 프레임 스트림 — 최신-only 큐 (frameStream.ts, three 없이)');

  // ── 구독 전: mesh 키 자체가 없는 frame 이벤트 ────────────────
  {
    const stream = new FrameStream();
    const rec = recordingSink();
    stream.push({ frame: 1 });
    stream.push({ frame: 2 });
    const out = stream.drain(rec.sink);
    check(
      'mesh 없는 frame 이벤트는 칸에 얹히지 않는다 (구독 전에는 번호만 온다)',
      out.status === 'idle' && rec.calls.length === 0 && !stream.hasPending,
      `${out.status}, sink ${rec.calls.length}회`,
    );
    check(
      '★ received는 오르는데 withMesh가 0 = "구독이 안 켜졌다"의 유일한 신호',
      stream.stats.received === 2 && stream.stats.withMesh === 0,
      `received ${stream.stats.received}, withMesh ${stream.stats.withMesh}`,
    );
  }

  // ── 최신-only. 이 단위에서 가장 중요한 한 가지 ───────────────
  {
    const stream = new FrameStream();
    const rec = recordingSink();
    for (const f of [10, 11, 12]) stream.push({ frame: f, mesh: frameAt(f) });

    check(
      '세 프레임이 몰려도 칸에는 하나뿐이다 (큐를 두면 지연이 무한히 쌓인다)',
      stream.hasPending && stream.stats.dropped === 2,
      `dropped ${stream.stats.dropped}`,
    );

    const out = stream.drain(rec.sink);
    const got = rec.calls[0]?.[0]?.positions[0];
    check(
      '★ 드레인이 푸는 것은 가장 최신 프레임이다 (옛것을 풀면 화면이 뒤처진다)',
      out.status === 'applied' && out.frame === 12 && got === 12_000,
      `frame ${out.frame}, positions[0]=${got} (10→10000 / 12→12000)`,
    );
    check(
      '드레인 한 번은 sink를 한 번만 부른다 (칸이 큐가 아니다)',
      rec.calls.length === 1, `${rec.calls.length}회`,
    );
    check(
      '★ 대조군 — 드레인 뒤에 또 드레인하면 아무 일도 없다',
      stream.drain(rec.sink).status === 'idle' && rec.calls.length === 1,
      `sink ${rec.calls.length}회`,
    );
  }

  // ── 번호는 건너뛴다. 역행하지는 않는다 ───────────────────────
  {
    const stream = new FrameStream();
    const rec = recordingSink();
    // 게이트웨이(#9)의 칸도 하나라 37 다음이 41일 수 있다. 이건 정상이다.
    stream.push({ frame: 37, mesh: frameAt(37) });
    check('건너뛴 번호는 정상이다 (게이트웨이가 이미 버렸다)',
      stream.drain(rec.sink).status === 'applied');
    stream.push({ frame: 41, mesh: frameAt(41) });
    check('번호가 건너뛰어도 그대로 적용된다',
      stream.drain(rec.sink).frame === 41 && stream.stats.outOfOrder === 0);

    // 반대로 역행은 프로토콜이 깨졌다는 신호다.
    stream.push({ frame: 50, mesh: frameAt(50) });
    stream.push({ frame: 49, mesh: frameAt(49) });
    const out = stream.drain(rec.sink);
    const got = rec.calls[2]?.[0]?.positions[0];
    check(
      '★ 역행하는 번호는 최신을 밀어내지 않고 버려진다',
      out.frame === 50 && got === 50_000 && stream.stats.outOfOrder === 1,
      `frame ${out.frame}, positions[0]=${got}, outOfOrder ${stream.stats.outOfOrder}`,
    );
  }

  // ── 깨진 프레임 하나가 흐름을 죽이지 않는다 ──────────────────
  {
    const stream = new FrameStream();
    const rec = recordingSink();
    // vertices 6인데 positions는 3개 float — decodePattern이 던진다.
    const broken: FrameMesh = {
      topology: false,
      patterns: [{ uuid: 'p0', vertices: 6, triangles: 4, positions: f32Base64([1, 2, 3]) }],
    };
    stream.push({ frame: 1, mesh: broken });

    let threw = false;
    let out: DrainOutcome = { status: 'idle', frame: null };
    try {
      out = stream.drain(rec.sink);
    } catch {
      threw = true;
    }
    check(
      '★ drain은 절대 던지지 않는다 (rAF 안에서 던지면 화면 갱신이 통째로 멎는다)',
      !threw, threw ? '던졌다' : '-',
    );
    check('깨진 프레임은 error로 나오고 sink에 닿지 않는다',
      out.status === 'error' && rec.calls.length === 0 && stream.lastError !== null,
      `${out.status}, lastError=${stream.lastError?.message ?? 'null'}`);
    check(
      '★ 깨진 프레임이 칸에 눌러앉지 않는다 (남으면 같은 실패가 영원히 반복된다)',
      !stream.hasPending,
    );

    stream.push({ frame: 2, mesh: frameAt(2) });
    check('깨진 프레임 뒤에도 다음 프레임은 적용된다 (한 프레임만 버린다)',
      stream.drain(rec.sink).status === 'applied' && rec.calls.length === 1);
    check('디코딩 실패로는 멈추지 않는다 (토폴로지 불일치와 다른 사건이다)',
      !stream.stalled && stream.stats.failed === 1, `failed ${stream.stats.failed}`);
  }

  // ── 토폴로지 불일치 → 정지 → 복구 ───────────────────────────
  {
    const seen: TopologyMismatch[] = [];
    const stream = new FrameStream({ onMismatch: (i) => seen.push(i) });
    // 화면에는 5패턴이 서 있는데 프레임은 2패턴짜리다.
    const rec = recordingSink(5);
    rec.reject();

    stream.push({ frame: 1, mesh: frameAt(1) });
    const out = stream.drain(rec.sink);
    check(
      '★ updatePositions가 false면 멈춘다 (삼키면 "시뮬은 도는데 옷이 안 움직인다"가 된다)',
      out.status === 'mismatch' && stream.stalled,
      `${out.status}, stalled=${stream.stalled}`,
    );
    check('무엇과 무엇이 어긋났는지 위로 알린다 (main.ts가 이걸 받아 재로드한다)',
      seen[0]?.frame === 1 && seen[0]?.incoming === 2 && seen[0]?.current === 5,
      JSON.stringify(seen[0] ?? null));

    stream.push({ frame: 2, mesh: frameAt(2) });
    stream.push({ frame: 3, mesh: frameAt(3) });
    const out2 = stream.drain(rec.sink);
    check('정지 중에는 디코딩도 하지 않고 버린다',
      out2.status === 'stalled' && rec.calls.length === 1, `${out2.status}, sink ${rec.calls.length}회`);
    check(
      '★ onMismatch는 정지당 한 번뿐이다 (매 프레임 부르면 103MB 재로드가 40/s로 쏟아진다)',
      seen.length === 1, `${seen.length}회`,
    );

    rec.allow();
    stream.push({ frame: 4, mesh: frameAt(4) });
    stream.resume();
    check(
      '★ resume()이 정지를 풀고 칸도 비운다 (옛 토폴로지 프레임이 남으면 복구하자마자 또 멈춘다)',
      !stream.stalled && !stream.hasPending,
      `stalled=${stream.stalled}, pending=${stream.hasPending}`,
    );
    stream.push({ frame: 5, mesh: frameAt(5) });
    check('복구 뒤 프레임이 다시 흐른다', stream.drain(rec.sink).status === 'applied');

    rec.reject();
    stream.push({ frame: 6, mesh: frameAt(6) });
    stream.drain(rec.sink);
    check('정지가 풀린 뒤 다시 어긋나면 다시 한 번 알린다 (한 번뿐 ≠ 영영 한 번)',
      seen.length === 2, `${seen.length}회`);
  }

  // ── 콜백이 던져도 rAF는 산다 ────────────────────────────────
  {
    const stream = new FrameStream({
      onMismatch: () => { throw new Error('콜백 폭발'); },
    });
    const rec = recordingSink(9);
    rec.reject();
    stream.push({ frame: 1, mesh: frameAt(1) });
    let threw = false;
    try {
      stream.drain(rec.sink);
    } catch {
      threw = true;
    }
    check(
      '★ onMismatch가 던져도 drain은 던지지 않는다 (rAF가 멎지 않는다)',
      !threw && stream.lastError?.message === '콜백 폭발',
      threw ? '던졌다' : `lastError=${stream.lastError?.message ?? 'null'}`,
    );
  }

  // ── fps: 주입한 시계로 결정적으로 ───────────────────────────
  {
    const clock = fakeClock();
    const stream = new FrameStream({ now: clock.now, fpsWindow: 30 });
    const rec = recordingSink();
    check('★ 대조군 — 프레임이 없으면 fps는 0이다', stream.stats.fps === 0, String(stream.stats.fps));

    // 25ms 간격 11회 적용 → 10구간 / 250ms = 40fps
    for (let i = 0; i < 11; i++) {
      stream.push({ frame: i, mesh: frameAt(i) });
      stream.drain(rec.sink);
      clock.advance(25);
    }
    check(
      '★ fps는 받은 수가 아니라 적용된 수로 잰다 (25ms 간격 11회 → 40fps)',
      Math.abs(stream.stats.fps - 40) < 0.01, stream.stats.fps.toFixed(2),
    );
    clock.advance(1_500);
    check(
      '★ 멈추면 fps가 0으로 내려간다 (옛 값이 남으면 "도는 중"으로 오독한다)',
      stream.stats.fps === 0, stream.stats.fps.toFixed(2),
    );

    stream.reset();
    const s = stream.stats;
    check('reset()이 누적 카운터를 0으로 되돌린다',
      s.received === 0 && s.applied === 0 && s.dropped === 0 && s.lastApplied === null,
      JSON.stringify(s));
  }
}

// ── §8-6. 스트림 → 진짜 three 버퍼 ────────────────────────────
//
// §8-5가 흐름 제어를 봤다면 여기는 **그 흐름이 GPU로 가는 마지막 한 칸**이다.
// 가짜 sink로는 볼 수 없는 셋이 여기서만 나온다: 좌표가 실제로 바뀌는가,
// `version` 이 오르는가(= GPU 업로드가 예약되는가), 그리고 **지오메트리가 다시
// 만들어지지 않는가.** 셋째가 특히 중요하다 — 매 프레임 `setTopology()` 를
// 부르는 구현도 화면상으로는 똑같이 "움직이는 옷"이라 눈으로는 절대 못 잡는다.

function sectionFrameStreamCloth(): void {
  section('§8-6. 프레임 스트림 → 진짜 three 버퍼 (frameStream + cloth)');

  const cloth = new ClothObject();
  cloth.setTopology([synthPattern('p0', 6, 4, 1), synthPattern('p1', 5, 3, 1)]);
  const p0 = cloth.patterns[0];
  const p1 = cloth.patterns[1];
  if (!p0 || !p1) {
    check('패턴 둘이 섰다', false);
    return;
  }

  // 프레임이 흐르기 전의 기준선. 아래 단언이 전부 이것과 비교된다.
  const attr0 = p0.position;
  const geo0 = p0.geometry;
  const v0 = attr0.version;
  const x0 = (attr0.array as Float32Array)[0];
  const children0 = cloth.group.children.length;

  const stream = new FrameStream();

  // ── 대조군 둘. 이게 없으면 아래 단언들은 "우연히 통과"와 구분되지 않는다 ──
  const idle = stream.drain(cloth);
  check(
    '★ 대조군 ① — 프레임이 없으면 드레인해도 좌표도 version도 그대로다',
    idle.status === 'idle' && attr0.version === v0 && (attr0.array as Float32Array)[0] === x0,
    `${idle.status}, version ${attr0.version}, x ${(attr0.array as Float32Array)[0]}`,
  );

  const next = [synthPattern('p0', 6, 4, 7), synthPattern('p1', 5, 3, 7)];
  stream.push({ frame: 100, mesh: frameMeshOf(next) });
  check(
    '★ 대조군 ② — push만 하고 드레인하지 않으면 화면은 그대로다 (디코딩은 drain에서만)',
    stream.hasPending && attr0.version === v0 && (attr0.array as Float32Array)[0] === x0,
    `version ${attr0.version}, x ${(attr0.array as Float32Array)[0]}`,
  );

  // ── 정상 경로 ───────────────────────────────────────────────
  const out = stream.drain(cloth);
  check('드레인이 프레임을 적용했다', out.status === 'applied' && out.frame === 100,
    `${out.status}, frame ${out.frame}`);
  check(
    '★ 정점 좌표가 실제로 바뀐다 (= "옷이 움직인다"에서 자동화할 수 있는 전부)',
    (attr0.array as Float32Array)[0] === next[0]?.positions[0]
      && (attr0.array as Float32Array)[0] !== x0,
    `${x0} → ${(attr0.array as Float32Array)[0]}`,
  );
  check(
    '★ GPU 업로드가 예약됐다 (needsUpdate는 setter 전용 — version 증가로 본다)',
    attr0.version > v0, `${v0} → ${attr0.version}`,
  );
  check(
    '★ 지오메트리를 다시 만들지 않는다 (매 프레임 setTopology면 GPU 버퍼를 매번 새로 판다)',
    cloth.patterns[0]?.position === attr0 && cloth.patterns[0]?.geometry === geo0
      && cloth.group.children.length === children0,
    `attr 동일=${cloth.patterns[0]?.position === attr0}, geo 동일=${cloth.patterns[0]?.geometry === geo0}, children ${cloth.group.children.length}`,
  );
  check(
    '두 번째 패턴도 같이 갱신된다 (절반만 움직이는 옷이 되면 안 된다)',
    (p1.position.array as Float32Array)[0] === next[1]?.positions[0],
    `${(p1.position.array as Float32Array)[0]}`,
  );

  // ── 몰아친 프레임: 화면에는 마지막 하나만, 업로드도 한 번만 ──
  const vBefore = attr0.version;
  for (const seed of [8, 9, 10]) {
    stream.push({ frame: 100 + seed, mesh: frameAt(seed) });
  }
  stream.drain(cloth);
  check(
    '★ 세 프레임이 몰려도 화면에는 마지막 것만 서고 업로드도 한 번뿐이다',
    (attr0.array as Float32Array)[0] === 10_000 && attr0.version === vBefore + 1,
    `x ${(attr0.array as Float32Array)[0]}, version ${vBefore} → ${attr0.version}`,
  );

  // ── 토폴로지 불일치 → main.ts의 복구 경로 그대로 ────────────
  const seen: TopologyMismatch[] = [];
  const stream2 = new FrameStream({ onMismatch: (i) => seen.push(i) });
  const xNow = (attr0.array as Float32Array)[0];
  const vNow = attr0.version;
  // 패턴 1개짜리 프레임 — 다른 씬이 열렸거나 재연결로 워커가 바뀐 상황이다.
  stream2.push({ frame: 200, mesh: frameMeshOf([synthPattern('p0', 6, 4, 11)]) });
  const bad = stream2.drain(cloth);
  check(
    '★ 어긋난 프레임은 화면을 건드리지 않는다 (절반만 갱신된 옷은 원인을 눈으로 못 찾는다)',
    bad.status === 'mismatch' && (attr0.array as Float32Array)[0] === xNow
      && attr0.version === vNow,
    `${bad.status}, x ${(attr0.array as Float32Array)[0]}, version ${attr0.version}`,
  );
  check('불일치 내용이 진짜 옷의 패턴 수로 보고된다',
    seen[0]?.incoming === 1 && seen[0]?.current === 2, JSON.stringify(seen[0] ?? null));

  // main.ts가 하는 일 그대로: 토폴로지를 다시 세우고 resume().
  cloth.setTopology([synthPattern('p0', 6, 4, 12)]);
  stream2.resume();
  stream2.push({ frame: 201, mesh: frameMeshOf([synthPattern('p0', 6, 4, 13)]) });
  const fixed = stream2.drain(cloth);
  check(
    '★ 토폴로지를 다시 세우고 resume()하면 프레임이 다시 흐른다 (main.ts의 복구 경로)',
    fixed.status === 'applied' && !stream2.stalled
      && (cloth.patterns[0]?.position.array as Float32Array | undefined)?.[0] === 13_000,
    `${fixed.status}, x ${(cloth.patterns[0]?.position.array as Float32Array | undefined)?.[0]}`,
  );

  cloth.clear();
}

// ── §8-3. 실제 워커 바이트 → 화면에 설 지오메트리 ──────────────
//
// §7이 "바이트가 디코딩된다"까지 봤다면 여기는 그 다음 한 칸이다:
// 디코딩된 것이 실제로 three 지오메트리로 서는가, 그리고 그 지오메트리가
// 사람 옷의 규모인가. 후자는 사람이 화면에서 "커 보인다/작아 보인다"로만
// 판정할 수 있는 것이라, 숫자로 박아 두면 그 판정이 필요 없어진다.

async function sectionViewerRealScene(): Promise<void> {
  section('§8-3. 3D 뷰 — 실제 워커 메시로 화면에 서는가 (loader.ts)');

  if (!existsSync(EXE) || !existsSync(ZLS)) {
    note('생략', `exe=${existsSync(EXE)}, zls=${existsSync(ZLS)}`);
    return;
  }

  await withGateway(async (_gw, addr) => {
    const scene = await findOrUploadScene(addr.url);
    if (!scene) {
      check('씬 준비', false, 'sample.zls를 준비하지 못했다');
      return;
    }

    const client = new GatewayClient({ url: addr.url, requestTimeoutMs: 60_000 });
    const { viewer, cloth, framed } = stubViewer();
    try {
      await client.connect();

      const shown = await showScene(client, viewer, scene.id);
      check(
        '★ 실제 씬이 three 지오메트리로 선다 (load만으로 정지 드레이프가 나온다)',
        shown.patterns === 5 && shown.vertices === 3022 && shown.triangles === 5472,
        `패턴 ${shown.patterns}, 정점 ${shown.vertices}, 삼각형 ${shown.triangles}, ${shown.elapsedMs}ms`,
      );
      check('카메라를 맞췄다 (기본값 frameCamera:true)', framed() === 1, String(framed()));

      const allGl = cloth.patterns.every((p) => {
        const i = p.geometry.getIndex();
        return i !== null && isGlIndexArray(i.array);
      });
      check('★ 실제 인덱스도 전부 WebGL이 받는 타입이다', allGl);

      const finite = cloth.patterns.every((p) =>
        Array.from(p.position.array as Float32Array).every((v) => Number.isFinite(v)));
      check('실제 좌표가 전부 유한하다 (NaN 하나면 경계상자가 통째로 깨진다)', finite);

      const box = cloth.boundingBox();
      const size = box.getSize(new THREE.Vector3());
      // 엔진 좌표는 cm다. 옷 한 벌이 대략 100cm 높이 — 여기가 어긋나면 화면에서
      // 옷이 점으로 보이거나 카메라 안에 파묻힌다.
      check(
        '★ 씬 규모가 cm 단위 옷이다 (높이 50~200cm)',
        size.y > 50 && size.y < 200 && size.x > 5 && size.z > 5,
        `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} cm`,
      );

      // #15(2D 펼침)가 uvs를 **cm 좌표**로 쓴다. 누가 정규화하면 조용히 깨진다.
      const uvs = cloth.patterns[0]?.uvs;
      const uvMax = uvs ? Math.max(...Array.from(uvs)) : NaN;
      check(
        '★ uvs가 0~1로 정규화돼 있지 않다 (cm 단위 2D 패턴 좌표 — #15의 전제)',
        Number.isFinite(uvMax) && uvMax > 2,
        `최대 ${uvMax.toFixed(2)}`,
      );

      // ── 재로드 멱등. main.ts의 재연결 핸들러가 정확히 이 호출을 한다 ──
      const again = await showScene(client, viewer, scene.id, { frameCamera: false });
      check(
        '★ 같은 씬을 다시 로드해도 메시가 겹쳐 쌓이지 않는다 (재연결 재로드 경로)',
        cloth.group.children.length === 5 && again.vertices === shown.vertices,
        `children=${cloth.group.children.length}, 정점 ${again.vertices}`,
      );
      check('frameCamera:false면 카메라를 다시 맞추지 않는다 (사용자 시점을 뺏지 않는다)',
        framed() === 1, String(framed()));
    } finally {
      cloth.clear();
      await client.close().catch(() => {});
    }
  }, { sessions: { idleTimeout: 0, requestTimeoutMs: 60_000 } });
}

// ── §8-4. 게이트웨이를 죽였다 살린다 ───────────────────────────
//
// §4가 재연결을 보지만 가짜 게이트웨이라 "붙었다"까지다. 실제로 끊겼다 붙으면
// **워커 프로세스가 새로 뜨고 씬이 로드돼 있지 않다.** main.ts는 그때
// showScene()을 다시 부르는데, 그게 정말 되는지는 여기서만 확인된다.
// (Builder가 못 한 자리다. DOM이 필요한 것은 main.ts의 배선 한 줄뿐이고,
//  그 한 줄이 부르는 대상 전체가 여기서 실제로 검증된다.)

async function sectionReconnectReload(): Promise<void> {
  section('§8-4. 3D 뷰 — 게이트웨이 재시작 → 자동 재연결 → 씬 재로드');

  if (!existsSync(EXE) || !existsSync(ZLS)) {
    note('생략', `exe=${existsSync(EXE)}, zls=${existsSync(ZLS)}`);
    return;
  }

  const port = await freePort();
  const opts: GatewayOptions = {
    port,
    onLog: () => {},
    sessions: { idleTimeout: 0, requestTimeoutMs: 60_000 },
  };

  let gw1: Gateway | null = createGateway(opts);
  let gw2: Gateway | null = null;
  const client = new GatewayClient({
    url: `http://127.0.0.1:${port}`,
    requestTimeoutMs: 60_000,
    reconnect: { minDelayMs: 300, maxDelayMs: 1_500, maxAttempts: 10 },
  });
  const opens: { reconnected: boolean; attempt: number }[] = [];
  client.on('open', (e) => opens.push({ reconnected: e.reconnected, attempt: e.attempt }));

  const { viewer, cloth } = stubViewer();
  try {
    const addr = await gw1.start();
    const scene = await findOrUploadScene(addr.url);
    if (!scene) {
      check('씬 준비', false, 'sample.zls를 준비하지 못했다');
      return;
    }

    await client.connect();
    const first = await showScene(client, viewer, scene.id);
    check('재시작 전에 씬이 서 있다', first.patterns === 5, `패턴 ${first.patterns}`);

    // 죽인다. 소켓이 끊기고 워커도 같이 사라진다.
    await gw1.close();
    gw1 = null;
    check('끊긴 것을 클라이언트가 안다', await until(() => !client.connected, 5_000),
      `state=${client.state}`);

    // 같은 포트로 살린다. 브라우저에서 게이트웨이를 재시작한 것과 같은 상황이다.
    gw2 = createGateway(opts);
    await gw2.start();

    const back = await until(() => opens.length === 2, 20_000);
    check('★ 자동으로 다시 붙는다', back, `opens=${opens.length}, state=${client.state}`);
    check('★ 두 번째 open은 reconnected로 표시된다 (main.ts가 이걸 보고 재로드한다)',
      opens[1]?.reconnected === true, JSON.stringify(opens));

    if (back) {
      // main.ts의 재연결 핸들러가 하는 일 그대로.
      const reloaded = await showScene(client, viewer, scene.id, { frameCamera: false });
      check(
        '★ 새 워커에 씬이 다시 로드되고 지오메트리가 다시 선다',
        reloaded.patterns === 5 && reloaded.vertices === first.vertices,
        `패턴 ${reloaded.patterns}, 정점 ${reloaded.vertices}`,
      );
      check('재로드 후에도 메시가 5개다 (겹쳐 쌓이지 않았다)',
        cloth.group.children.length === 5, String(cloth.group.children.length));
    }
  } catch (err: unknown) {
    check('재연결 재로드 종단', false, messageOf(err));
  } finally {
    cloth.clear();
    await client.close().catch(() => {});
    await gw1?.close().catch(() => {});
    await gw2?.close().catch(() => {});
  }
}

// ── §8-7. 실제 워커 프레임 → 옷이 실제로 움직인다 ──────────────
//
// §8-5·§8-6은 합성 좌표를 넣고 그 좌표가 나오는지 봤다. 그것만으로는
// **자기충족**이다 — "내가 넣은 값이 나온다"는 시뮬레이션이 실제로 옷을
// 움직인다는 것도, 워커의 프레임 mesh가 우리가 만든 모양과 같다는 것도
// 증명하지 않는다. 여기서는 진짜 워커를 띄우고, 진짜 물리 프레임을
// main.ts와 **똑같은 배선**(핸들러는 push만 / rAF 대역이 drain)으로 흘린다.
// 사람이 브라우저에서 보게 될 것과 다른 점은 WebGL 컨텍스트 하나뿐이다.

async function sectionRealFrames(): Promise<void> {
  section('§8-7. 프레임 스트리밍 종단 — 실제 워커 프레임으로 옷이 움직인다');

  if (!existsSync(EXE) || !existsSync(ZLS)) {
    note('생략', `exe=${existsSync(EXE)}, zls=${existsSync(ZLS)}`);
    return;
  }

  await withGateway(async (_gw, addr) => {
    const scene = await findOrUploadScene(addr.url);
    if (!scene) {
      check('씬 준비', false, 'sample.zls를 준비하지 못했다');
      return;
    }

    const client = new GatewayClient({ url: addr.url, requestTimeoutMs: 60_000 });
    const { viewer, cloth } = stubViewer();
    const stream = new FrameStream();
    // ★ main.ts의 배선 그대로 — 핸들러는 얹기만 한다.
    client.on('frame', (ev) => stream.push(ev));

    try {
      await client.connect();
      await showScene(client, viewer, scene.id);

      const p0 = cloth.patterns[0];
      if (!p0) {
        check('실제 씬이 섰다', false);
        return;
      }
      const attr0 = p0.position;
      const geo0 = p0.geometry;
      const v0 = attr0.version;
      const children0 = cloth.group.children.length;
      // 로드 직후의 정지 드레이프. 시뮬이 돌면 여기서 벗어나야 한다.
      const atLoad = (attr0.array as Float32Array).slice(0, 3);

      // subscribe를 start보다 **먼저**. 반대면 그 사이 프레임이 mesh 없이 지나간다.
      await client.subscribe();
      await client.start();

      // rAF 대역. 브라우저처럼 **주기적으로 한 번씩만** 드레인한다 —
      // 도착할 때마다 푸는 구현이면 아래 dropped가 0이 되어 최신-only의
      // 의미가 사라진다.
      let applied = 0;
      let firstApplied: Float32Array | null = null;
      const t0 = Date.now();
      while (applied < 10 && Date.now() - t0 < 30_000) {
        if (stream.drain(cloth).status === 'applied') {
          applied += 1;
          if (!firstApplied) firstApplied = (attr0.array as Float32Array).slice(0, 3);
        }
        await sleep(16);
      }
      await client.pause();
      await client.unsubscribe();

      const s = stream.stats;
      const now3 = (attr0.array as Float32Array).slice(0, 3);
      const moved = (a: Float32Array, b: Float32Array): boolean =>
        Array.from(a).some((v, i) => Math.abs(v - (b[i] ?? 0)) > 1e-4);

      check('★ 실제 워커 프레임이 옷에 붙는다', applied >= 10,
        `적용 ${applied} / 수신 ${s.received}`);
      check(
        '★ 구독이 켜져 있었다 (received와 withMesh가 갈라지면 구독이 안 켜진 것이다)',
        s.withMesh === s.received && s.withMesh > 0, `${s.withMesh}/${s.received}`,
      );
      check(
        '★ 실제 정점이 실제로 움직였다 (합성 데이터의 자기충족이 아니다)',
        moved(now3, atLoad), `${head3(atLoad)} → ${head3(now3)}`,
      );
      check(
        '★ 프레임 사이에도 계속 움직인다 (한 번 튀고 멎는 것이 아니다)',
        firstApplied !== null && moved(now3, firstApplied),
        firstApplied === null ? '적용된 프레임이 없다' : `${head3(firstApplied)} → ${head3(now3)}`,
      );
      check(
        '★ version이 적용 횟수만큼 올랐다 (GPU 업로드가 프레임마다 예약된다)',
        attr0.version === v0 + s.applied, `${v0} → ${attr0.version} (적용 ${s.applied})`,
      );
      check(
        '★ 지오메트리를 한 번도 다시 만들지 않았다 (같은 BufferAttribute를 끝까지 쓴다)',
        cloth.patterns[0]?.position === attr0 && cloth.patterns[0]?.geometry === geo0
          && cloth.group.children.length === children0,
        `attr 동일=${cloth.patterns[0]?.position === attr0}, children ${cloth.group.children.length}`,
      );
      check(
        '실제 좌표가 갱신 뒤에도 전부 유한하다 (NaN 하나면 경계상자가 통째로 깨진다)',
        cloth.patterns.every((p) =>
          Array.from(p.position.array as Float32Array).every((v) => Number.isFinite(v))),
      );
      check(
        '종단에서 디코딩 실패도 역행도 정지도 없었다',
        s.failed === 0 && s.outOfOrder === 0 && s.mismatched === 0 && !s.stalled,
        `failed ${s.failed}, outOfOrder ${s.outOfOrder}, mismatched ${s.mismatched}, stalled ${s.stalled}`,
      );
      note('실측', `수신 ${s.received} / 적용 ${s.applied} / 버림 ${s.dropped}, ${s.fps.toFixed(1)}fps, 마지막 프레임 ${s.lastApplied}`);

      // 정지 뒤에는 흐르는 것이 없어야 한다 — 워커는 maxFrame이 바뀔 때만 낸다.
      const afterPause = s.received;
      await sleep(300);
      check(
        '정지하면 프레임이 더 오지 않는다 (구독을 켜 둔 채 정지해도 0바이트다)',
        stream.stats.received === afterPause,
        `${afterPause} → ${stream.stats.received}`,
      );
    } catch (err: unknown) {
      check('프레임 스트리밍 종단', false, messageOf(err));
    } finally {
      cloth.clear();
      await client.close().catch(() => {});
    }
  }, { sessions: { idleTimeout: 0, requestTimeoutMs: 60_000 } });
}

// ─────────────────────────────────────────────────────────────
// §9. 좀비 프로세스
// ─────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);

async function sectionZombies(): Promise<void> {
  section('§9. 좀비 프로세스');
  if (process.platform !== 'win32') {
    note('생략', `windows가 아니다 (${process.platform})`);
    return;
  }
  try {
    const { stdout } = await execFileAsync('tasklist', [
      '/FI', 'IMAGENAME eq zelusSandBoxd-demo.exe', '/NH',
    ]);
    const lines = stdout.split(/\r?\n/).filter((l) => l.includes('zelusSandBoxd-demo.exe'));
    check(
      '워커 프로세스가 남지 않았다',
      lines.length === 0,
      lines.length === 0 ? '0개' : lines.join(' / '),
    );
  } catch (err: unknown) {
    note('tasklist 실패', messageOf(err));
  }
}

// ── main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== 프론트엔드 프로토콜 스모크 테스트 (#11) ===');
  const t0 = performance.now();

  // ── 하네스가 조용히 사라지지 않게 하는 두 줄 ────────────────
  //
  // ① exitCode를 미리 1로 둔다. 끝까지 도달해야만 0으로 내린다.
  //    이게 없으면 중간에 프로세스가 죽어도 exit 0이라 "통과"로 보인다 —
  //    실제로 아래 ②를 만들기 전에 정확히 그 일이 일어났다.
  // ② keep-alive. 클라이언트의 재시도·타임아웃 타이머는 전부 unref다
  //    (브라우저에는 없는 배려지만 Node에서는 이벤트 루프를 안 붙잡는다).
  //    소켓이 없는 백오프 구간에서는 붙잡는 핸들이 하나도 남지 않아
  //    Node가 "할 일 없음"으로 판단하고 **정상 종료**해버린다.
  process.exitCode = 1;
  const keepAlive = setInterval(() => {}, 1_000);

  sectionEndpoints();
  sectionDecodeLength();
  await sectionAlignment();
  await sectionCorrelation();
  await sectionReconnect();
  await sectionViteProxy();
  await sectionStatic();
  await sectionRealWorker();
  sectionClothTopology();
  sectionClothFrames();
  sectionFrameStreamQueue();
  sectionFrameStreamCloth();
  await sectionViewerRealScene();
  await sectionReconnectReload();
  await sectionRealFrames();
  await sectionZombies();

  clearInterval(keepAlive);
  console.log(`\n${failures === 0 ? '전부 통과' : `${failures}건 실패`}  (${ms(performance.now() - t0)})\n`);
  process.exitCode = failures > 0 ? 1 : 0;

  // 이벤트 루프가 안 비는 경우를 대비한 워치독. 판정은 이미 끝났다.
  const wd = setTimeout(() => {
    console.log('(열린 핸들이 남아 강제 종료한다)');
    process.exit(failures > 0 ? 1 : 0);
  }, 3_000);
  wd.unref?.();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
