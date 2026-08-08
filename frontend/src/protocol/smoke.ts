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
import {
  SnapshotLoader,
  SnapshotStaleError,
  type SnapshotResult,
  type SnapshotSource,
  type SnapshotStats,
  type SnapshotTarget,
} from '../viewer3d/snapshot.ts';
import {
  parseSnapshot,
  SnapshotObject,
  SNAPSHOT_SCALE,
  type ParsedSnapshot,
} from '../viewer3d/snapshotView.ts';
import type { Viewer3D } from '../viewer3d/viewer.ts';

import {
  base64ToBytes,
  decodeFloat32,
  decodeInt32,
  decodePattern,
  decodePatterns,
  downloadExport,
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
  type ExportFormat,
  type ExportResult,
  type FrameMesh,
  type PatternData,
  type SceneSummary,
} from './index.ts';
// `PatternTransform` 만은 배럴(`index.ts`)이 재export 하지 않아 여기서 직접 꺼낸다.
// (`types.ts` 가 `sdk/protocol.ts` 의 정의를 재export 하는 그 타입이다.)
import type { PatternTransform } from './types.ts';

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

  // ── transform (ISSUE-011) — 없으면 identity, 틀리면 던진다 ───
  //
  // 이 갈림이 이 단위에서 가장 조용한 실패다. **형식이 틀린 것을 통과시키면**
  // `Mesh.position.fromArray` 가 undefined 를 읽어 좌표가 NaN 이 되고, three 는
  // 예외도 경고도 없이 **아무것도 그리지 않는다** — 화면은 비는데 정점 수는
  // 정상으로 찍히므로 원인을 화면에서 읽을 방법이 없다. 반대로 **없는 것을
  // 오류로 만들면** 프레임 이벤트의 mesh 마다 던져서 옷이 아예 안 움직인다.
  // 두 방향 모두 못으로 박는다.
  const tBase: PatternData = {
    uuid: 'p-t',
    vertices: 2,
    triangles: 1,
    positions: f32Base64([0, 0, 0, 1, 1, 1]),
    indices: i32Base64([0, 1, 0]),
  };
  /** 타입이 막는 모양을 일부러 넣는다 — 워커는 타입 검사를 지나지 않는다 */
  const withTransform = (raw: unknown): PatternData =>
    ({ ...tBase, transform: raw } as unknown as PatternData);

  const rt = decodePattern(withTransform({
    translation: [1, 2, 3],
    rotation: [0, 0.7071067811865476, 0, 0.7071067811865476],
    scale: [1, 2, 3],
  })).transform;
  check(
    'transform 왕복 — 열 개 숫자가 순서 그대로 실린다',
    rt !== undefined
      && rt.translation.join(',') === '1,2,3'
      && rt.rotation.length === 4 && rt.rotation[1] === 0.7071067811865476
      && rt.scale.join(',') === '1,2,3',
    JSON.stringify(rt),
  );
  // 던지는 쪽으로 뒤집히면 이 절 앞의 `decodePattern(good)` 에서 먼저 죽어
  // 스모크가 통째로 멎는다. 그래도 **여기가 빨간불이 되도록** 잡아 둔다 —
  // "테스트가 안 끝난다" 보다 "이 단언이 깨졌다" 가 원인을 지목한다.
  const absent = (label: string, p: PatternData): { ok: boolean; detail: string } => {
    try {
      const d = decodePattern(p);
      return {
        ok: d.transform === undefined && !('transform' in d),
        detail: 'transform' in d ? `${label}: 키가 남았다 ${JSON.stringify(d.transform)}` : `${label}: 키 자체가 없다`,
      };
    } catch (err: unknown) {
      return { ok: false, detail: `${label}: 던졌다 — ${messageOf(err)}` };
    }
  };
  const noKey = absent('키 없음', tBase);
  const nullKey = absent('null', withTransform(null));
  check(
    '★ transform 이 없으면 undefined 다 (프레임 이벤트·구버전 워커 → identity)',
    noKey.ok, noKey.detail,
  );
  check(
    '★ null 도 오류가 아니다 (JSON 이 null 을 실어 보내도 identity 로 간다)',
    nullKey.ok, nullKey.detail,
  );

  const badTransforms: [string, unknown, string][] = [
    ['★ rotation 이 3개 (쿼터니언을 오일러각으로 착각한 워커)',
      { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      'transform.rotation 는 길이 4'],
    ['★ translation 이 4개',
      { translation: [0, 0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      'transform.translation 는 길이 3'],
    ['★ scale 이 2개',
      { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1] },
      'transform.scale 는 길이 3'],
    ['★ translation 에 NaN (fromArray 가 그대로 삼켜 화면이 빈다)',
      { translation: [0, Number.NaN, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      'transform.translation 에 숫자가 아닌 값'],
    ['★ rotation 에 Infinity',
      { translation: [0, 0, 0], rotation: [0, 0, 0, Number.POSITIVE_INFINITY], scale: [1, 1, 1] },
      'transform.rotation 에 숫자가 아닌 값'],
    ['★ scale 에 문자열 ("1" 은 숫자가 아니다)',
      { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: ['1', 1, 1] },
      'transform.scale 에 숫자가 아닌 값'],
    ['★ translation 이 배열이 아니라 객체 ({x,y,z} 로 보낸 워커)',
      { translation: { x: 0, y: 0, z: 0 }, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      'transform.translation 는 길이 3'],
    ['★ 키가 통째로 빠졌다 (rotation 없음)',
      { translation: [0, 0, 0], scale: [1, 1, 1] },
      'transform.rotation 는 길이 4'],
    ['★ transform 이 객체가 아니다 (4×4 행렬을 평평하게 보낸 워커)',
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      'transform.translation 는 길이 3'],
    ['★ transform 이 숫자다',
      42,
      'transform 이 객체가 아닙니다'],
  ];
  for (const [label, raw, expect] of badTransforms) {
    let msg = '';
    try {
      decodePattern(withTransform(raw));
    } catch (err: unknown) {
      msg = messageOf(err);
    }
    check(
      `${label} → 던진다`,
      msg.includes(expect) && msg.includes('p-t'),
      msg || '조용히 통과해버렸다 — 화면이 비고 원인을 못 읽는다',
    );
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
      /** 로드 직후의 변환 원문. 시뮬을 돌린 뒤 그대로인지 아래에서 다시 본다 */
      let transformsAtLoad: string | null = null;
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

        // ── 패턴 변환 (ISSUE-011) — 원문 JSON 수준에서 ─────────
        //
        // 여기서 보는 것은 "워커가 무엇을 실었는가" 하나다. 그 값이 **옳은가**는
        // 정답지(익스포트한 glTF)와 대조해야 하고, 그건 §8-10 이 한다.
        const raws = md.patterns.map((p) => (p as unknown as Record<string, unknown>)['transform']);
        transformsAtLoad = JSON.stringify(raws);
        check(
          '★ topology:true 응답의 모든 패턴에 transform 이 실려 있다 (ISSUE-011)',
          raws.length > 0 && raws.every((t) => t !== undefined && t !== null),
          `${raws.filter((t) => t !== undefined && t !== null).length}/${raws.length}개`,
        );
        check(
          '★ decodePattern 이 그 형식을 통과시킨다 (길이 3/4/3, 전부 유한)',
          patterns.length > 0 && patterns.every((p) => p.transform !== undefined),
          `${patterns.filter((p) => p.transform).length}/${patterns.length}개`,
        );
        const quats = patterns.map((p) => p.transform?.rotation).filter((r) => r !== undefined);
        check(
          '★ 쿼터니언이 단위 쿼터니언이다 (노름 1 — 아니면 three 가 메시를 늘리거나 찌그러뜨린다)',
          quats.length === patterns.length
            && quats.every((q) => Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) < 1e-4),
          quats.map((q) => Math.hypot(q[0], q[1], q[2], q[3]).toFixed(6)).join(' '),
        );
        check(
          '★ scale 이 0 이 아니다 (0 이면 그 패널이 한 점으로 찌부러져 화면에서 사라진다)',
          patterns.every((p) => (p.transform?.scale ?? [1, 1, 1]).every((v) => Math.abs(v) > 1e-9)),
          patterns.map((p) => (p.transform?.scale ?? []).join('/')).join(' '),
        );
        // 회전각 분포는 씬이 정하는 값이라 판정에 넣지 않는다. 다만 **이 씬에는
        // 180° 패널이 있다** 는 사실이 §8-11 의 방향 단언이 왜 필요한지의 근거다.
        const angles = patterns.map((p) => {
          const q = p.transform?.rotation;
          return q ? 2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180 / Math.PI : 0;
        });
        note('회전각', `${angles.map((a) => `${a.toFixed(1)}°`).join(', ')} — 0°가 아닌 것이 ${angles.filter((a) => a > 1).length}개`);
        note('변환', patterns.map((p) => {
          const t = p.transform?.translation;
          return t ? `[${t.map((v) => v.toFixed(2)).join(',')}]` : '없음';
        }).join(' '));

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

      // ── 변환은 프레임 이벤트에 실리지 않는다 (ISSUE-011) ────
      //
      // 프레임마다 실어 보내면 대역폭은 프레임당 40바이트뿐이라 문제가 아니지만,
      // **이 사실이 뒤집히면 클라이언트 쪽 가정이 뒤집힌다** — `cloth.ts` 의
      // `updatePositions()` 는 변환을 다시 걸지 않고 `Mesh` 에 남은 값을 믿는다.
      // 반대로 워커가 나중에 프레임에도 싣기 시작하면 그건 회귀가 아니라 설계
      // 변경이고, 그때는 `updatePositions()` 도 함께 고쳐야 한다.
      const framePatterns = withMesh.flatMap((f) => f.mesh?.patterns ?? []);
      const withTransformKey = framePatterns.filter(
        (p) => 'transform' in (p as unknown as Record<string, unknown>),
      ).length;
      check(
        '★★ 프레임 이벤트의 mesh 에는 transform 키가 아예 없다 (topology:true 에만 실린다)',
        framePatterns.length > 0 && withTransformKey === 0,
        `패턴 ${framePatterns.length}개 중 ${withTransformKey}개에 실렸다`,
      );

      // ── 프레임 불변 — 워커가 "한 번만 보낸다"는 근거 ────────
      //
      // 시뮬을 11프레임 이상 돌린 **뒤** 다시 물어 로드 직후 값과 비교한다.
      // 문자열 비교라 부동소수 반올림도 잡는다. 이게 깨진다면 대역폭 문제가
      // 아니라 **화면이 틀린다** — 클라이언트는 첫 값을 계속 쓰므로 정점만
      // 흔들리고 옷 전체가 옛 자리에 고정된다.
      const md2 = await client.meshData(true);
      const raws2 = JSON.stringify(
        md2.patterns.map((p) => (p as unknown as Record<string, unknown>)['transform']),
      );
      check(
        '★★ 시뮬을 돌린 뒤에도 transform 이 한 글자도 안 바뀐다 (프레임 불변 — 한 번만 보내는 근거)',
        transformsAtLoad !== null && raws2 === transformsAtLoad,
        transformsAtLoad === null ? '로드 직후 값을 못 받았다'
          : raws2 === transformsAtLoad ? `${md2.patterns.length}개 동일 (frame ${reached}+)` : `달라졌다: ${raws2.slice(0, 160)}`,
      );
      check(
        '대조군 — 그 사이 정점은 실제로 움직였다 (아무것도 안 변한 것이 아니다)',
        (() => {
          const a = md.patterns[0]?.positions;
          const b = md2.patterns[0]?.positions;
          return typeof a === 'string' && typeof b === 'string' && a !== b;
        })(),
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
// §8-11. 패턴 변환 — 옷이 제자리에 서는가 (ISSUE-011)
//
// 정점은 **패턴 로컬 좌표**로 오고, 월드 위치는 패턴마다 딸려 오는 `transform`
// (TRS)을 곱해야 정해진다. 여기가 뚫리면 옷은 그려지는데 **원점 근처에 뭉쳐**
// 서고, 아바타(#14 이후)를 얹는 순간 몸에서 떨어진다.
//
// ★ 이 절이 존재하는 진짜 이유는 **회전**이다. 경계 상자만 보는 단언은 회전을
//   거의 못 잡는다 — 특히 sample.zls 의 절반 이상인 **Y축 180° 뒤집기**
//   (`rotation ≈ [0, 1, 0, 3e-7]`, w 가 0 에 가깝다)는, 로컬 형상이 x·z 에
//   대칭이면 AABB 가 **한 치도 변하지 않는다.** "w 가 거의 0이니 회전은 없는
//   셈" 으로 다루거나 쿼터니언을 wxyz 로 읽어도 상자는 그대로다. 그래서 여기서는
//   상자가 아니라 **점이 어디로 가는가**를 단언한다. 아래에 그 둘의 차이를
//   같은 데이터로 나란히 보여 두는 항목이 있다.
// ─────────────────────────────────────────────────────────────

/** 로컬 좌표를 손으로 준 패턴 하나 (+ 선택적 변환) */
function localPattern(
  uuid: string,
  coords: readonly number[],
  transform?: PatternTransform,
): DecodedPattern {
  const vertices = coords.length / 3;
  const p: DecodedPattern = {
    uuid,
    positions: Float32Array.from(coords),
    indices: Int32Array.from([0, 1, 2]),
    vertices,
    triangles: 1,
  };
  if (transform) p.transform = transform;
  return p;
}

/** 로컬 점 하나를 그 패턴 메시의 월드 좌표로 옮긴다 (three 가 실제로 쓰는 행렬로) */
function toWorld(cloth: ClothObject, uuid: string, x: number, y: number, z: number): THREE.Vector3 {
  const mesh = cloth.patterns.find((p) => p.uuid === uuid)?.mesh;
  if (!mesh) return new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
  return new THREE.Vector3(x, y, z).applyMatrix4(mesh.matrixWorld);
}

function near(v: THREE.Vector3, x: number, y: number, z: number, eps = 1e-4): boolean {
  return Math.abs(v.x - x) < eps && Math.abs(v.y - y) < eps && Math.abs(v.z - z) < eps;
}

function xyz(v: THREE.Vector3): string {
  return `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
}

const IDENTITY: PatternTransform = {
  translation: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

function sectionClothTransform(): void {
  section('§8-11. 3D 뷰 — 패턴 변환 (ISSUE-011, cloth.ts, DOM 없이)');

  // ── ① TRS 가 지오메트리가 아니라 Mesh 에 걸린다 ──────────────
  //
  // 정점에 미리 곱하면 #15 의 2D 펼침 뷰가 로컬 좌표를 되찾을 방법이 없어진다.
  {
    const t: PatternTransform = {
      translation: [10, 20, 30],
      rotation: [0, 0, 0, 1],
      scale: [2, 3, 4],
    };
    const cloth = new ClothObject();
    cloth.setTopology([localPattern('a', [1, 0, 0, 0, 1, 0, 0, 0, 1], t)]);
    const p = cloth.patterns[0];
    if (!p) {
      check('패턴이 섰다', false);
      return;
    }
    check(
      '★ translation/scale 이 Mesh 에 그대로 걸린다',
      p.mesh.position.x === 10 && p.mesh.position.y === 20 && p.mesh.position.z === 30
        && p.mesh.scale.x === 2 && p.mesh.scale.y === 3 && p.mesh.scale.z === 4,
      `pos ${p.mesh.position.toArray().join(',')} scale ${p.mesh.scale.toArray().join(',')}`,
    );
    check(
      '★★ 정점에는 미리 곱하지 않는다 (#15 의 2D 펼침이 로컬 좌표를 원한다)',
      (p.position.array as Float32Array)[0] === 1
        && (p.position.array as Float32Array)[1] === 0
        && (p.position.array as Float32Array)[2] === 0,
      Array.from((p.position.array as Float32Array).slice(0, 3)).join(','),
    );
    check(
      '★ 렌더를 한 번도 안 돌렸는데 matrixWorld 가 이미 맞다 (카메라 맞춤·레이캐스팅이 렌더보다 먼저 온다)',
      near(toWorld(cloth, 'a', 0, 0, 0), 10, 20, 30),
      xyz(toWorld(cloth, 'a', 0, 0, 0)),
    );
    check(
      '★ 스케일이 실제로 곱해진다 (로컬 (1,1,1) → (2,3,4) 만큼 이동)',
      near(toWorld(cloth, 'a', 1, 1, 1), 12, 23, 34),
      xyz(toWorld(cloth, 'a', 1, 1, 1)),
    );
    cloth.clear();
  }

  // ── ② 쿼터니언 순서 — [x, y, z, w] 이지 [w, x, y, z] 가 아니다 ─
  //
  // 순서를 바꿔 읽어도 **노름이 1이라 아무 검사에도 안 걸린다.** 걸리는 것은
  // 점이 어디로 가는가뿐이다. Z축 90°를 쓰는 이유: wxyz 로 읽으면 X축 90°가
  // 되는데, 두 결과가 명확히 다른 점을 고를 수 있다.
  {
    const s = Math.SQRT1_2; // sin45 = cos45
    const zq90: PatternTransform = { ...IDENTITY, rotation: [0, 0, s, s] };
    const cloth = new ClothObject();
    cloth.setTopology([localPattern('z90', [1, 0, 0, 0, 1, 0, 0, 0, 1], zq90)]);
    check(
      '★★ [x,y,z,w] 로 읽는다 — Z축 90°: 로컬 +X 가 월드 +Y 로 간다 (wxyz 면 +X 에 그대로 남는다)',
      near(toWorld(cloth, 'z90', 1, 0, 0), 0, 1, 0),
      xyz(toWorld(cloth, 'z90', 1, 0, 0)),
    );
    check(
      '★ 같은 회전에서 로컬 +Z 는 제자리다 (축이 Z 라는 것까지 고정한다)',
      near(toWorld(cloth, 'z90', 0, 0, 1), 0, 0, 1),
      xyz(toWorld(cloth, 'z90', 0, 0, 1)),
    );
    cloth.clear();
  }

  // ── ③ Y축 180° 뒤집기 — 이 절의 핵심 ────────────────────────
  //
  // sample.zls 의 패턴 5개 중 3개가 |w| ≈ 3e-7 인 **180°** 회전이다. 부호만
  // 보고 "거의 0이니 없는 셈" 으로 다루면 그 패널이 뒤집힌 채 놓인다.
  {
    const flip: PatternTransform = {
      translation: [100, 200, 300],
      // 실제 씬에서 나온 모양 그대로 — w 가 3e-7 이다.
      rotation: [0, 1, 0, 3.1391647326017846e-7],
      scale: [1, 1, 1],
    };
    const cloth = new ClothObject();
    // x·z 에 **대칭이 아닌** 형상. 방향을 읽을 수 있어야 한다.
    cloth.setTopology([localPattern('flip', [7, 0, 3, 0, 5, 0, 0, 0, 0], flip)]);
    const w = toWorld(cloth, 'flip', 7, 0, 3);
    check(
      '★★ Y축 180° 가 실제로 걸린다 — 로컬 (7,0,3) 이 월드에서 (−7,0,−3)+t 로 간다',
      near(w, 100 - 7, 200, 300 - 3, 1e-3),
      `${xyz(w)} (기대 (93, 200, 297) / 회전을 무시하면 (107, 200, 303))`,
    );
    check(
      '★ w 가 3e-7 이어도 회전각은 180° 다 (2·acos|w| — 부호 크기로 판정하면 안 된다)',
      Math.abs(2 * Math.acos(Math.min(1, Math.abs(flip.rotation[3]))) * 180 / Math.PI - 180) < 0.01,
      `${(2 * Math.acos(Math.abs(flip.rotation[3])) * 180 / Math.PI).toFixed(4)}°`,
    );

    // ── 경계 상자만 보는 단언이 왜 이걸 못 잡는지 ───────────────
    //
    // 같은 변환을 **x·z 에 대칭인** 형상에 걸면 AABB 가 한 치도 안 변한다.
    // 이 두 줄이 "경계 상자 대조로 충분하다"는 판단을 막는다.
    const sym = [4, 0, 2, -4, 0, -2, 4, 1, -2];
    const rotated = new ClothObject();
    rotated.setTopology([localPattern('s', sym, { ...flip, translation: [0, 0, 0] })]);
    const plain = new ClothObject();
    plain.setTopology([localPattern('s', sym)]);
    const br = rotated.boundingBox();
    const bp = plain.boundingBox();
    check(
      '★★ 대칭 형상에서는 180° 회전이 경계 상자를 전혀 바꾸지 않는다 (상자 대조만으로는 못 잡는다는 증거)',
      br.min.distanceTo(bp.min) < 1e-4 && br.max.distanceTo(bp.max) < 1e-4,
      `회전 ${xyz(br.min)}~${xyz(br.max)} / 무회전 ${xyz(bp.min)}~${xyz(bp.max)}`,
    );
    check(
      '★★ 같은 데이터에서 점의 행선지는 확실히 다르다 (그래서 위의 방향 단언이 필요하다)',
      !near(toWorld(rotated, 's', 4, 0, 2), 4, 0, 2, 1e-3)
        && near(toWorld(plain, 's', 4, 0, 2), 4, 0, 2),
      `회전 ${xyz(toWorld(rotated, 's', 4, 0, 2))} vs 무회전 ${xyz(toWorld(plain, 's', 4, 0, 2))}`,
    );
    rotated.clear();
    plain.clear();
    cloth.clear();
  }

  // ── ④ 변환이 없으면 identity — 그리고 잔류하지 않는다 ────────
  {
    const cloth = new ClothObject();
    cloth.setTopology([localPattern('none', [1, 2, 3, 0, 0, 0, 0, 0, 0])]);
    const p = cloth.patterns[0];
    check(
      '★ transform 이 없으면 identity 다 (구버전 워커·프레임 이벤트 — NaN 이 아니라 옛 화면)',
      p !== undefined && p.mesh.position.length() === 0 && p.mesh.scale.x === 1
        && p.mesh.quaternion.w === 1 && p.mesh.quaternion.x === 0,
      p === undefined ? '패턴 없음'
        : `pos ${p.mesh.position.toArray().join(',')} quat ${p.mesh.quaternion.toArray().join(',')}`,
    );
    check(
      'identity 면 로컬 좌표가 곧 월드 좌표다',
      near(toWorld(cloth, 'none', 1, 2, 3), 1, 2, 3),
      xyz(toWorld(cloth, 'none', 1, 2, 3)),
    );

    // 변환이 있는 씬을 열었다가 없는 씬으로 갈아 끼운다 (재연결·다른 씬).
    cloth.setTopology([localPattern('none', [1, 2, 3, 0, 0, 0, 0, 0, 0], {
      ...IDENTITY, translation: [50, 60, 70],
    })]);
    cloth.setTopology([localPattern('none', [1, 2, 3, 0, 0, 0, 0, 0, 0])]);
    check(
      '★ 변환이 남아 있지 않다 (setTopology 는 메시를 새로 만든다 — 옛 씬의 위치가 새 씬에 새지 않는다)',
      near(toWorld(cloth, 'none', 0, 0, 0), 0, 0, 0),
      xyz(toWorld(cloth, 'none', 0, 0, 0)),
    );
    cloth.clear();
  }

  // ── ⑤ boundingBox() 가 월드 좌표다 (스냅샷과 같은 공간) ──────
  //
  // 로컬 상자를 그대로 합치면 카메라가 옷이 없는 자리를 겨눈다. 그리고
  // `snapshotView.boundingBox()` 와 공간이 달라져 §8-10 의 대조가 성립하지 않는다.
  {
    const t: PatternTransform = { ...IDENTITY, translation: [0, 100, 0] };
    const moved = new ClothObject();
    moved.setTopology([localPattern('m', [-1, -1, -1, 1, 1, 1, 0, 0, 0], t)]);
    const local = new ClothObject();
    local.setTopology([localPattern('m', [-1, -1, -1, 1, 1, 1, 0, 0, 0])]);

    const bm = moved.boundingBox();
    const bl = local.boundingBox();
    check(
      '★★ boundingBox() 가 월드다 (변환만큼 통째로 옮겨진 상자)',
      Math.abs(bm.min.y - 99) < 1e-4 && Math.abs(bm.max.y - 101) < 1e-4,
      `${xyz(bm.min)} ~ ${xyz(bm.max)}`,
    );
    check(
      '★ 대조군 — 변환을 안 걸면 같은 정점이 원점 근처에 남는다 (ISSUE-011 이전의 화면)',
      Math.abs(bl.min.y + 1) < 1e-4 && Math.abs(bl.max.y - 1) < 1e-4,
      `${xyz(bl.min)} ~ ${xyz(bl.max)}`,
    );
    check(
      '★ 크기는 같고 자리만 다르다 (변환이 상자를 부풀리지 않았다)',
      Math.abs(bm.getSize(new THREE.Vector3()).length()
        - bl.getSize(new THREE.Vector3()).length()) < 1e-4,
    );
    moved.clear();
    local.clear();
  }

  // ── ⑥ 프레임 갱신이 변환을 지우지 않는다 ────────────────────
  //
  // frame 이벤트의 mesh 에는 transform 이 오지 않는다. `updatePositions()` 가
  // 그때 변환을 건드리면 **정점은 흔들리는데 옷이 원점으로 튀어간다.**
  {
    const t: PatternTransform = {
      translation: [12.436, 54.653, 15],
      rotation: [0, 1, 0, 3.1391647326017846e-7],
      scale: [1, 1, 1],
    };
    const cloth = new ClothObject();
    cloth.setTopology([localPattern('f', [1, 0, 0, 0, 1, 0, 0, 0, 1], t)]);
    const before = toWorld(cloth, 'f', 0, 0, 0).clone();

    // 프레임 이벤트가 주는 모양 그대로 — positions 만 있고 transform 은 없다.
    const frame: DecodedPattern = {
      uuid: 'f',
      positions: Float32Array.from([2, 0, 0, 0, 2, 0, 0, 0, 2]),
      vertices: 3,
      triangles: 1,
    };
    const ok = cloth.updatePositions([frame]);
    const after = toWorld(cloth, 'f', 0, 0, 0);
    check(
      '★★ transform 없는 프레임을 100번 먹여도 옷이 제자리에 남는다',
      ok && (() => {
        for (let i = 0; i < 100; i++) cloth.updatePositions([frame]);
        return near(toWorld(cloth, 'f', 0, 0, 0), before.x, before.y, before.z, 1e-6);
      })(),
      `${xyz(before)} → ${xyz(after)}`,
    );
    check(
      '★ 그 사이 정점은 실제로 갈렸다 (움직이지 않는 것과 구분한다)',
      (cloth.patterns[0]?.position.array as Float32Array)[0] === 2,
      String((cloth.patterns[0]?.position.array as Float32Array)[0]),
    );
    check(
      '★ 갱신 뒤 경계 상자도 여전히 월드다 (computeBoundingBox 를 다시 부르면서 변환을 잃지 않는다)',
      Math.abs(cloth.boundingBox().getCenter(new THREE.Vector3()).y - 54.653) < 2,
      xyz(cloth.boundingBox().getCenter(new THREE.Vector3())),
    );
    cloth.clear();
  }
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
// §8-8 ~ §8-10. 스냅샷 (익스포트한 glTF 를 화면에)
//
// 통과 기준은 "아바타와 진짜 옷 색이 보인다" 하나이고 verify 는 manual 이다.
// 그런데 **사람이 보는 것은 마지막 한 칸뿐이다** — 그 앞의 네 칸(익스포트 요청 →
// 다운로드 → 파싱 → 부착)이 어디서 어긋나도 화면에는 "아무것도 안 뜬다" 또는
// "이상한 크기로 뜬다" 로만 나타난다. 아래 셋이 그 네 칸을 전부 가른다:
//
//   §8-8  상태 기계 — 실패·취소·중복·세대전환. 주입이 열려 있어 전부 결정적이다
//   §8-9  부착 — 스케일 100 과 GPU 해제. three 는 쓰되 DOM 은 안 쓴다
//   §8-10 실제 익스포트 — 진짜 워커의 glTF 로 §8-8·§8-9 를 한 번 더, 진짜 값으로
//
// 특히 §8-8 의 `SnapshotStaleError` 집계가 뒤집히면 **정상 동작이 빨간 오류로
// 찍힌다** — 사용자가 기다리다 다른 씬을 눌렀을 뿐인데 "익스포트 실패" 가
// 보고된다. 화면으로는 절대 구분되지 않는 종류다.
// ─────────────────────────────────────────────────────────────

/** 밖에서 풀어 주는 약속. 진행 중 상태를 **원하는 지점에서 멈춰** 세운다 */
function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function exportInfo(bytes = 1024): ExportResult {
  return {
    id: 'a'.repeat(32),
    format: 'gltf',
    bytes,
    name: 'sample.gltf',
    createdAt: new Date(0).toISOString(),
    url: `/api/exports/${'a'.repeat(32)}`,
  };
}

/**
 * 주입 가능한 가짜 source/target 한 벌.
 *
 * 각 단계를 `defer` 로 붙잡아 두면 **"익스포트 중에 씬이 바뀌었다"** 같은
 * 시간이 걸린 상황을 경합 없이 만들 수 있다. 실제 게이트웨이로는 4.3초짜리
 * 창을 노려야 하는 것들이라 결정적으로 재현할 방법이 없다.
 */
function fakeSnapshotRig(): {
  source: SnapshotSource;
  target: SnapshotTarget<string>;
  calls: { export: number; download: number; parse: number; install: number; clear: number; dispose: number };
  progress: { loaded: number; total: number }[];
  installed: string[];
  disposed: string[];
  gates: {
    export: { promise: Promise<ExportResult>; resolve: (v: ExportResult) => void; reject: (e: unknown) => void };
    download: { promise: Promise<ArrayBuffer>; resolve: (v: ArrayBuffer) => void; reject: (e: unknown) => void };
    parse: { promise: Promise<string>; resolve: (v: string) => void; reject: (e: unknown) => void };
  };
  /** 세 단계를 순서대로 즉시 통과시킨다 */
  passAll: (bytes?: number) => void;
  /** `install` 이 던지게 한다 */
  breakInstall: () => void;
  stats: SnapshotStats;
  formats: ExportFormat[];
} {
  const calls = { export: 0, download: 0, parse: 0, install: 0, clear: 0, dispose: 0 };
  const progress: { loaded: number; total: number }[] = [];
  const installed: string[] = [];
  const disposed: string[] = [];
  const formats: ExportFormat[] = [];
  const stats: SnapshotStats = { meshes: 27, vertices: 33_087, materials: 13, textures: 8 };
  let installThrows = false;

  const gates = {
    export: defer<ExportResult>(),
    download: defer<ArrayBuffer>(),
    parse: defer<string>(),
  };

  const source: SnapshotSource = {
    requestExport: (format) => {
      calls.export += 1;
      formats.push(format);
      return gates.export.promise;
    },
    download: (_url, onProgress, expectedBytes) => {
      calls.download += 1;
      // 실제 `downloadExport` 처럼 중간 보고를 낸다. 화면의 진행률이 이 값이다.
      onProgress(0, expectedBytes);
      onProgress(Math.floor(expectedBytes / 2), expectedBytes);
      onProgress(expectedBytes, expectedBytes);
      return gates.download.promise;
    },
  };

  const target: SnapshotTarget<string> = {
    parse: () => {
      calls.parse += 1;
      return gates.parse.promise;
    },
    install: (content) => {
      calls.install += 1;
      if (installThrows) throw new Error('install 실패');
      installed.push(content);
      return stats;
    },
    clear: () => {
      calls.clear += 1;
    },
    dispose: (content) => {
      calls.dispose += 1;
      disposed.push(content);
    },
  };

  return {
    source,
    target,
    calls,
    progress,
    installed,
    disposed,
    gates,
    stats,
    formats,
    passAll: (bytes = 1024): void => {
      gates.export.resolve(exportInfo(bytes));
      gates.download.resolve(new ArrayBuffer(bytes));
      gates.parse.resolve('내용');
    },
    breakInstall: (): void => {
      installThrows = true;
    },
  };
}

/** 마이크로태스크가 다 흐르도록 한 박자 쉰다 (실제 시간은 안 쓴다) */
function tick(): Promise<void> {
  return new Promise<void>((res) => setImmediate(res));
}

/**
 * `caught()` 인데 **제 시간 안에 끝나지 않으면 그 사실을 값으로** 돌려준다.
 *
 * 세대 검사가 사라지면 취소된 시도가 다음 단계에서 영원히 매달린다(그 단계의
 * gate 를 아무도 풀어 주지 않는다). 그때 스모크가 통째로 멎으면 **어느 단언이
 * 깨졌는지가 아니라 "테스트가 안 끝난다" 만 남는다** — 실제로 돌연변이를
 * 심었을 때 그렇게 됐다. 멎는 대신 그 항목만 빨간불이 되게 한다.
 */
function caughtWithin<T>(p: Promise<T>, msec = 3_000): Promise<unknown> {
  const overdue = new Error(`${msec}ms 안에 끝나지 않았다`);
  return Promise.race([caught(p), sleep(msec).then(() => overdue)]);
}

async function sectionSnapshotMachine(): Promise<void> {
  section('§8-8. 스냅샷 상태 기계 (snapshot.ts, DOM 도 three 도 없이)');

  // ── 대조군: 아무것도 안 했을 때 ──────────────────────────────
  {
    const rig = fakeSnapshotRig();
    const loader = new SnapshotLoader<string>({ source: rig.source, target: rig.target });
    const s = loader.stats;
    check(
      '대조군 — 부르기 전에는 아무것도 없다 (present:false, idle, 시도 0)',
      s.present === false && s.phase === 'idle' && s.attempts === 0 && s.succeeded === 0
        && s.failed === 0 && s.discarded === 0 && s.lastResult === null && s.lastError === null
        && loader.busy === false,
      JSON.stringify({ phase: s.phase, present: s.present, attempts: s.attempts }),
    );
  }

  // ── 성공 경로 + 주입 시계로 구간별 소요를 고정한다 ───────────
  {
    const rig = fakeSnapshotRig();
    // 시계를 손으로 돌린다. `#run` 이 `now()` 를 부르는 순서는 다섯 번
    // (시작 / 익스포트 뒤 / 다운로드 뒤 / 파싱 뒤 / 부착 뒤) + onProgress 마다.
    let clock = 0;
    const phases: string[] = [];
    const progress: { phase: string; loaded: number; total: number; elapsedMs: number }[] = [];
    const loader = new SnapshotLoader<string>({
      source: rig.source,
      target: {
        parse: rig.target.parse.bind(rig.target),
        // 부착은 동기라 밖에서 시계를 돌릴 틈이 없다. **부착이 도는 동안**
        // 1ms 가 흘렀다고 해 두면 installMs 가 그 구간을 재는지 보인다.
        install: (c) => {
          clock += 1;
          return rig.target.install(c);
        },
        clear: rig.target.clear.bind(rig.target),
        dispose: rig.target.dispose?.bind(rig.target) ?? ((): void => {}),
      },
      now: () => clock,
      onProgress: (p) => {
        phases.push(p.phase);
        progress.push({ phase: p.phase, loaded: p.loaded, total: p.total, elapsedMs: p.elapsedMs });
      },
    });

    const pending = loader.load();
    await tick();
    check('시작하면 exporting 이고 busy 다 (버튼을 잠그는 조건)',
      loader.phase === 'exporting' && loader.busy, `${loader.phase}, busy=${loader.busy}`);

    clock = 4_300; // 익스포트 4.3초 (사용자 씬 실측)
    rig.gates.export.resolve(exportInfo(36_500_000));
    await tick();
    clock = 4_732; // 다운로드 432ms
    rig.gates.download.resolve(new ArrayBuffer(8));
    await tick();
    check('다운로드가 끝나면 parsing 이다', loader.phase === 'parsing', loader.phase);
    clock = 5_302; // 파싱 570ms (부착 1ms 는 install 대역이 직접 흘린다)
    rig.gates.parse.resolve('내용');

    const r = await pending;
    check('★ 성공하면 ready 이고 화면에 서 있다 (present)',
      loader.phase === 'ready' && loader.present,
      `${loader.phase}, present=${loader.present}`);
    // 자물쇠는 결과보다 한 마이크로태스크 늦게 풀린다 (아래 "함정" 항목 참고).
    await tick();
    check('끝나면 자물쇠가 풀린다 (버튼이 다시 눌린다)', !loader.busy, `busy=${loader.busy}`);
    check('단계가 순서대로 지나간다 (건너뛰거나 되돌아가지 않는다)',
      phases.join('>') === 'exporting>downloading>downloading>downloading>downloading>parsing>ready',
      phases.join('>'));
    check('★ 구간별 소요가 실제 시각차다 (어디가 느린지가 곧 다음에 고칠 곳이다)',
      r.timings.exportMs === 4_300 && r.timings.downloadMs === 432
        && r.timings.parseMs === 570 && r.timings.installMs === 1 && r.elapsedMs === 5_303,
      JSON.stringify(r.timings) + ` 합 ${r.elapsedMs}`,
    );
    check('install 이 돌려준 통계가 그대로 결과에 실린다 (화면에 찍히는 숫자)',
      r.stats.meshes === 27 && r.stats.vertices === 33_087 && r.stats.textures === 8,
      JSON.stringify(r.stats));
    check('export 응답이 그대로 실린다 (파일명·크기를 화면에 쓴다)',
      r.info.bytes === 36_500_000 && r.info.name === 'sample.gltf', JSON.stringify(r.info.name));
    check('기본 형식은 gltf 다', rig.formats.join(',') === 'gltf', rig.formats.join(','));

    // 진행률 — 다운로드 보고가 화면에 그대로 찍힌다.
    const dl = progress.filter((p) => p.phase === 'downloading');
    check(
      '★ 다운로드 진행률이 그대로 전달된다 (36MB 동안 화면이 말을 한다)',
      dl.length === 4 && dl[1]?.loaded === 0 && dl[3]?.loaded === 36_500_000
        && dl.every((p) => p.total === 36_500_000),
      dl.map((p) => `${p.loaded}/${p.total}`).join(' '),
    );
    check('진행 보고의 elapsedMs 가 단조 증가한다',
      progress.every((p, i) => i === 0 || p.elapsedMs >= (progress[i - 1]?.elapsedMs ?? 0)),
      progress.map((p) => p.elapsedMs).join(','));
    check('한 번 성공에 익스포트는 한 번뿐이다 (36MB 를 두 번 쓰지 않는다)',
      rig.calls.export === 1 && rig.calls.download === 1 && rig.calls.parse === 1
        && rig.calls.install === 1,
      JSON.stringify(rig.calls));

    const s = loader.stats;
    check('집계 — 성공 1, 실패 0, 버림 0',
      s.attempts === 1 && s.succeeded === 1 && s.failed === 0 && s.discarded === 0
        && s.coalesced === 0,
      JSON.stringify({ a: s.attempts, s: s.succeeded, f: s.failed, d: s.discarded }));

    // clear() — 씬을 갈아 끼우는 자리
    loader.clear();
    check('★ clear() 는 화면에서 내리고 target 까지 해제한다',
      rig.calls.clear === 1 && !loader.present && loader.phase === 'idle',
      `clear ${rig.calls.clear}, present ${loader.present}, ${loader.phase}`);
  }

  // ── 중복 호출: 진행 중이면 새로 시작하지 않는다 ──────────────
  {
    const rig = fakeSnapshotRig();
    const loader = new SnapshotLoader<string>({ source: rig.source, target: rig.target });
    const a = loader.load();
    const b = loader.load();
    const c = loader.load();
    check('★ 진행 중 재호출은 같은 약속을 돌려준다 (버튼 연타가 36MB 를 세 번 쓰지 않는다)',
      a === b && b === c, `a===b ${a === b}, b===c ${b === c}`);
    check('★ 익스포트를 다시 시작하지 않았다', rig.calls.export === 1, String(rig.calls.export));
    const s0 = loader.stats;
    check('합쳐진 호출이 attempts 가 아니라 coalesced 로 세어진다',
      s0.attempts === 1 && s0.coalesced === 2, `attempts ${s0.attempts}, coalesced ${s0.coalesced}`);

    rig.passAll();
    const [ra, rb] = await Promise.all([a, b]);
    check('합쳐진 호출도 같은 결과를 받는다', ra === rb && ra.stats.meshes === 27);

    // 끝난 뒤에는 다시 시작한다 — 자물쇠가 풀렸는가
    const rig2 = loader.load();
    check('★ 끝난 뒤에는 새로 시작한다 (자물쇠가 풀렸다)',
      rig.calls.export === 2 && loader.stats.attempts === 2,
      `export ${rig.calls.export}, attempts ${loader.stats.attempts}`);
    void rig2.catch(() => {});
    loader.clear(); // 두 번째 시도를 정리한다
    await caughtWithin(rig2);
  }

  // ── 실패: 세 단계 각각 ───────────────────────────────────────
  for (const stage of ['export', 'download', 'parse'] as const) {
    const rig = fakeSnapshotRig();
    const loader = new SnapshotLoader<string>({ source: rig.source, target: rig.target });
    const p = loader.load();
    if (stage !== 'export') rig.gates.export.resolve(exportInfo());
    if (stage === 'parse') rig.gates.download.resolve(new ArrayBuffer(8));
    await tick();
    rig.gates[stage].reject(new Error(`${stage} 실패`));

    const err = await caughtWithin(p);
    const s = loader.stats;
    check(
      `${stage} 가 실패하면 실패로 세고 이유가 남는다 (phase error)`,
      err instanceof Error && messageOf(err) === `${stage} 실패`
        && s.failed === 1 && s.discarded === 0 && s.succeeded === 0
        && s.phase === 'error' && s.lastError === err && !loader.busy,
      `${messageOf(err)}, failed ${s.failed}, phase ${s.phase}`,
    );
    check(
      `${stage} 실패 뒤에는 화면에 아무것도 세우지 않는다`,
      !loader.present && rig.calls.install === 0,
      `present ${loader.present}, install ${rig.calls.install}`,
    );
  }

  // install 이 던지는 경우 — 여기까지 왔으면 바이트는 멀쩡한데 three 가 거부한 것이다
  {
    const rig = fakeSnapshotRig();
    rig.breakInstall();
    const loader = new SnapshotLoader<string>({ source: rig.source, target: rig.target });
    const p = loader.load();
    rig.passAll();
    const err = await caughtWithin(p);
    check('install 이 던져도 실패로 잡힌다 (예외가 새어 나가지 않는다)',
      messageOf(err) === 'install 실패' && loader.stats.failed === 1 && !loader.present,
      `${messageOf(err)}, present ${loader.present}`);
  }

  // ── 대조군: 이미 선 스냅샷이 있는 상태에서 다시 찍는다 ───────
  {
    const rig = fakeSnapshotRig();
    const loader = new SnapshotLoader<string>({ source: rig.source, target: rig.target });
    const first = loader.load();
    rig.passAll(); // 세 gate 가 모두 resolve 된 상태로 남는다 → 두 번째도 즉시 통과
    await first;
    await tick(); // 자물쇠가 풀리기를 기다린다 (바로 아래 항목 참고)

    const second = await loader.load();
    check(
      '대조군 — 이미 선 스냅샷이 있어도 다시 찍으면 새로 익스포트해서 갈아 끼운다',
      loader.stats.succeeded === 2 && loader.present && rig.calls.install === 2
        && second.stats.meshes === 27,
      `succeeded ${loader.stats.succeeded}, install ${rig.calls.install}`,
    );
    check(
      '★ 다시 찍을 때 target.clear() 를 호출자가 따로 부르지 않는다 (install 이 이전 것을 해제한다)',
      rig.calls.clear === 0, `clear ${rig.calls.clear}`,
    );
  }

  // ── 함정 기록: 끝나자마자(같은 마이크로태스크 턴) 다시 부르면 ─
  //
  // 자물쇠(`#inFlight`)를 푸는 것은 `promise.catch().finally()` 라, **결과가
  // 나온 turn 보다 한 마이크로태스크 늦다.** 그래서 `await load()` 바로 다음
  // 줄의 `load()` 는 이미 끝난 시도에 합쳐져 **옛 결과를 그대로 돌려준다** —
  // 새 익스포트가 돌지 않는다. 사람이 버튼을 누르는 간격은 매크로태스크
  // 단위라 UI 에서는 닿지 않지만, 코드로 연달아 부르면 닿는다.
  {
    const rig = fakeSnapshotRig();
    const loader = new SnapshotLoader<string>({ source: rig.source, target: rig.target });
    const p = loader.load();
    rig.passAll();
    await p;
    const immediate = loader.load();
    check(
      '함정 — 끝난 직후 같은 턴에 다시 부르면 새로 시작하지 않고 옛 결과를 돌려준다',
      immediate === p && rig.calls.export === 1 && loader.stats.coalesced === 1,
      `같은 약속 ${immediate === p}, export ${rig.calls.export}, coalesced ${loader.stats.coalesced}`,
    );
    await caughtWithin(immediate);
  }

  // ── 세대전환 ①: 익스포트 중에 clear() ────────────────────────
  {
    const rig = fakeSnapshotRig();
    const loader = new SnapshotLoader<string>({ source: rig.source, target: rig.target });
    const p = loader.load();
    loader.clear(); // 사용자가 다른 씬을 눌렀다
    rig.gates.export.resolve(exportInfo());
    const err = await caughtWithin(p);
    const s = loader.stats;
    check(
      '★ 취소는 SnapshotStaleError 다 (main.ts 가 이걸로 오류와 가른다)',
      err instanceof SnapshotStaleError && (err as Error).name === 'SnapshotStaleError',
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
    check(
      '★★ 취소는 failed 가 아니라 discarded 로 세어진다 (뒤집히면 정상 동작이 빨간 오류가 된다)',
      s.discarded === 1 && s.failed === 0 && s.succeeded === 0,
      `discarded ${s.discarded}, failed ${s.failed}`,
    );
    check(
      '★ 취소는 phase 를 error 로 덮지 않는다 (clear 가 정한 idle 이 남는다)',
      s.phase === 'idle', s.phase,
    );
    check('★ 취소된 뒤에는 더 내려받지 않는다 (36MB 를 헛되이 받지 않는다)',
      rig.calls.download === 0 && rig.calls.parse === 0 && rig.calls.install === 0,
      JSON.stringify(rig.calls));
    check('취소 뒤에도 자물쇠는 풀린다', !loader.busy, `busy ${loader.busy}`);
  }

  // ── 세대전환 ②: 파싱이 끝난 **뒤에** 세대가 바뀌었다 ─────────
  //    여기서만은 GPU 자원이 이미 만들어져 있다. 참조를 놓는 것으로는 안 된다.
  {
    const rig = fakeSnapshotRig();
    const loader = new SnapshotLoader<string>({ source: rig.source, target: rig.target });
    const p = loader.load();
    rig.gates.export.resolve(exportInfo());
    await tick();
    rig.gates.download.resolve(new ArrayBuffer(8));
    await tick();
    check('파싱 직전까지 왔다', loader.phase === 'parsing' && rig.calls.parse === 1, loader.phase);
    loader.clear(); // 파싱이 도는 사이에 씬이 바뀌었다
    rig.gates.parse.resolve('버려질 내용');
    const err = await caughtWithin(p);
    check(
      '★ 늦게 온 파싱 결과는 씬에 붙이지 않는다 (다른 씬의 아바타가 서 있게 된다)',
      err instanceof SnapshotStaleError && rig.calls.install === 0,
      `${messageOf(err)}, install ${rig.calls.install}`,
    );
    check(
      '★ 버릴 때 dispose 로 넘긴다 (텍스처가 GPU 에 남는다 — 참조를 놓는 것으로는 안 된다)',
      rig.calls.dispose === 1 && rig.disposed[0] === '버려질 내용',
      `dispose ${rig.calls.dispose}, ${rig.disposed.join(',')}`,
    );
    check('이 경우도 discarded 다', loader.stats.discarded === 1 && loader.stats.failed === 0,
      `discarded ${loader.stats.discarded}, failed ${loader.stats.failed}`);
  }

  // ── 세대전환 ③: dispose 가 없는 target 이어도 깨지지 않는다 ──
  {
    const rig = fakeSnapshotRig();
    const noDispose: SnapshotTarget<string> = {
      parse: rig.target.parse.bind(rig.target),
      install: rig.target.install.bind(rig.target),
      clear: rig.target.clear.bind(rig.target),
    };
    const loader = new SnapshotLoader<string>({ source: rig.source, target: noDispose });
    const p = loader.load();
    rig.gates.export.resolve(exportInfo());
    await tick();
    rig.gates.download.resolve(new ArrayBuffer(8));
    await tick();
    loader.clear();
    rig.gates.parse.resolve('x');
    check('dispose 가 선택적이다 (없어도 취소가 성립한다)',
      (await caughtWithin(p)) instanceof SnapshotStaleError && loader.stats.discarded === 1);
  }

  // ── 진행 보고가 던져도 흐름을 깨지 않는다 ────────────────────
  {
    const rig = fakeSnapshotRig();
    const loader = new SnapshotLoader<string>({
      source: rig.source,
      target: rig.target,
      onProgress: () => {
        throw new Error('화면 갱신이 던졌다');
      },
    });
    const p = loader.load();
    rig.passAll();
    const err = await caughtWithin(p);
    check(
      '★ 진행률 콜백이 던져도 스냅샷은 완성된다 (숫자 찍는 코드가 36MB 를 죽이지 않는다)',
      err === null && loader.present && loader.stats.succeeded === 1,
      err === null ? 'ok' : messageOf(err),
    );
  }

  // ── 함정 기록: clear() 직후의 load() ─────────────────────────
  //
  // clear() 는 세대만 올릴 뿐 진행 중인 시도를 **끊지 않는다.** 그래서 그
  // 시도가 아직 살아 있는 동안의 load() 는 (중복 방지 규칙에 따라) 이미
  // 죽기로 된 약속을 그대로 받는다 — 새 익스포트가 시작되지 않는다.
  // main.ts 에서는 `snapshots.busy` 로 버튼이 잠겨 있어 사람이 이 경로에
  // 들어가지 못하지만, 그 잠금이 사라지면 "스냅샷을 눌렀는데 취소됐다고
  // 나온다" 가 된다. 지금 동작을 못으로 박아 둔다.
  {
    const rig = fakeSnapshotRig();
    const loader = new SnapshotLoader<string>({ source: rig.source, target: rig.target });
    const p1 = loader.load();
    void p1.catch(() => {});
    loader.clear();
    const p2 = loader.load();
    check(
      '함정 — clear() 직후 load() 는 새 익스포트가 아니라 버려질 시도에 합쳐진다',
      p1 === p2 && rig.calls.export === 1 && loader.stats.coalesced === 1,
      `같은 약속 ${p1 === p2}, export ${rig.calls.export}`,
    );
    rig.gates.export.resolve(exportInfo());
    check('그 결과는 취소로 온다 (busy 잠금이 사라지면 사용자에게 보인다)',
      (await caughtWithin(p2)) instanceof SnapshotStaleError);
  }
}

// ─────────────────────────────────────────────────────────────
// §8-9. 스냅샷 부착 — 스케일 100 과 GPU 해제 (snapshotView.ts)
//
// 이 파일은 브라우저 전용으로 **표시돼 있지만**, DOM 이 실제로 필요한 것은
// `parseSnapshot` 하나뿐이다(GLTFLoader 가 임베드 이미지를 `ImageBitmapLoader`
// 로 연다 — §8-10 이 그 경계를 실제로 확인한다). `SnapshotObject` 는 three 의
// 데이터 구조만 쓰므로 `cloth.ts` 와 같은 이유로 Node 에서 그대로 돈다.
//
// 그래서 이 단위에서 사람이 눈으로 판정해야 할 것 중 **두 가지**를 여기서
// 뺏어 올 수 있다:
//   - 스케일: 아바타가 격자 한 칸 안의 점으로 나오는가 / 사람 크기인가
//   - 해제 : 다시 찍을 때마다 GPU 메모리가 느는가 (눈으로는 아예 안 보인다)
// ─────────────────────────────────────────────────────────────

/** 텍스처를 단 메시 하나. `install` 통계와 해제를 볼 최소 단위 */
function texturedMesh(size: number, tex: THREE.Texture, extraSlot = false): THREE.Mesh {
  const geo = new THREE.BoxGeometry(size, size, size);
  const mat = new THREE.MeshStandardMaterial({ map: tex });
  if (extraSlot) {
    // 이름으로 나열하지 않고 값으로 훑는다는 계약. 로더가 KHR 확장 슬롯에
    // 텍스처를 꽂아도 새어 나가면 안 된다.
    (mat as unknown as Record<string, unknown>)['훗날생길확장Map'] = tex;
  }
  return new THREE.Mesh(geo, mat);
}

function countingTexture(): { tex: THREE.Texture; disposals: () => number } {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  let n = 0;
  tex.addEventListener('dispose', () => {
    n += 1;
  });
  return { tex, disposals: () => n };
}

function sectionSnapshotObject(): void {
  section('§8-9. 스냅샷 부착 — 스케일과 해제 (snapshotView.ts, DOM 없이)');

  // ── 스케일: 익스포터가 건 0.01 의 역수라는 관계 ──────────────
  check(
    '★ SNAPSHOT_SCALE 은 익스포터가 루트에 거는 0.01 의 역수다 (100 × 0.01 = 1, 근사가 아니다)',
    SNAPSHOT_SCALE === 100 && SNAPSHOT_SCALE * 0.01 === 1,
    String(SNAPSHOT_SCALE),
  );

  const obj = new SnapshotObject();
  check('그룹에 그 스케일이 걸려 있다',
    obj.group.scale.x === SNAPSHOT_SCALE && obj.group.scale.y === SNAPSHOT_SCALE
      && obj.group.scale.z === SNAPSHOT_SCALE,
    obj.group.scale.toArray().join(','));
  check(
    '★ 처음에는 보이지 않는다 (붙는 순간 실시간 옷과 겹쳐 보이는 한 프레임을 만들지 않는다)',
    obj.group.visible === false, String(obj.group.visible),
  );
  check('대조군 — 아무것도 안 붙였으면 present 가 false 이고 경계상자가 비어 있다',
    obj.present === false && obj.boundingBox().isEmpty() && obj.stats.meshes === 0);

  // ── install: 통계와 좌표 ─────────────────────────────────────
  const { tex, disposals } = countingTexture();
  const root = new THREE.Object3D();
  // 익스포터의 계층을 흉내낸다: 루트에 0.01, 옷 노드에 translation.
  root.scale.setScalar(0.01);
  const inner = new THREE.Object3D();
  inner.position.set(0, 54.7, 0);
  // 한 텍스처를 **두 메시가 공유**한다. 실제 파일이 그렇다(머티리얼 14 / 텍스처 8).
  inner.add(texturedMesh(100, tex));
  inner.add(texturedMesh(50, tex, true));
  root.add(inner);

  const stats = obj.install({ scene: root });
  check('통계 — 메시 수와 정점 수', stats.meshes === 2 && stats.vertices === 48,
    JSON.stringify(stats));
  check('★ 공유 텍스처를 두 번 세지 않는다 (머티리얼 2 / 텍스처 1)',
    stats.materials === 2 && stats.textures === 1, JSON.stringify(stats));
  check('present 와 stats 가 같이 선다', obj.present && obj.stats.vertices === 48);

  const box = obj.boundingBox();
  const size = box.getSize(new THREE.Vector3());
  check(
    '★★ 익스포터의 0.01 이 상쇄돼 엔진 좌표(cm)로 복원된다 (100 × 0.01 = 1)',
    Math.abs(size.y - 100) < 1e-6 && Math.abs(box.min.y - (54.7 - 50)) < 1e-4,
    `높이 ${size.y.toFixed(3)}cm, 바닥 y=${box.min.y.toFixed(3)}`,
  );
  check(
    '★ 노드 변환을 손대지 않는다 (옷 노드의 translation 이 그대로 남아 아바타와 맞는다)',
    Math.abs(inner.position.y - 54.7) < 1e-6 && root.scale.x === 0.01,
    `inner.y=${inner.position.y}, root.scale=${root.scale.x}`,
  );
  check('감싸는 그룹에 붙었다 (씬에 넣을 것이 여기 있다)',
    obj.group.children.length === 1 && obj.group.children[0] === root,
    String(obj.group.children.length));

  // ── 다시 install: 이전 것이 해제되는가 ───────────────────────
  const { tex: tex2 } = countingTexture();
  const root2 = new THREE.Object3D();
  root2.add(texturedMesh(10, tex2));
  const stats2 = obj.install({ scene: root2 });
  check(
    '★ 다시 찍으면 이전 것이 해제된다 (안 하면 다시 찍을 때마다 GPU 메모리가 는다)',
    disposals() === 1, `이전 텍스처 dispose ${disposals()}회`,
  );
  check('★ 공유 텍스처를 두 번 해제하지 않는다 (머티리얼 2개가 물고 있었다)',
    disposals() === 1, String(disposals()));
  check('겹쳐 쌓이지 않는다 (children 1, 통계도 갈아 끼워진다)',
    obj.group.children.length === 1 && stats2.meshes === 1 && stats2.textures === 1,
    `children ${obj.group.children.length}, ${JSON.stringify(stats2)}`);

  // ── clear ────────────────────────────────────────────────────
  const { tex: tex3, disposals: d3 } = countingTexture();
  const root3 = new THREE.Object3D();
  const mesh3 = texturedMesh(10, tex3, true);
  root3.add(mesh3);
  const geo3 = mesh3.geometry;
  let geoDisposed = 0;
  geo3.addEventListener('dispose', () => {
    geoDisposed += 1;
  });
  obj.install({ scene: root3 });
  obj.clear();
  check(
    '★ clear() 가 지오메트리·텍스처까지 해제한다',
    d3() === 1 && geoDisposed === 1, `텍스처 ${d3()}, 지오메트리 ${geoDisposed}`,
  );
  check('clear() 뒤에는 present 도 통계도 비어 있다',
    !obj.present && obj.stats.meshes === 0 && obj.group.children.length === 0
      && obj.boundingBox().isEmpty());
  check('clear() 를 두 번 불러도 안전하다 (해제가 두 번 일어나지 않는다)',
    (() => {
      obj.clear();
      return d3() === 1;
    })(), String(d3()));

  // ── dispose(content): 붙이지 못한 결과 ───────────────────────
  const { tex: tex4, disposals: d4 } = countingTexture();
  const orphan = new THREE.Object3D();
  orphan.add(texturedMesh(10, tex4));
  obj.dispose({ scene: orphan });
  check(
    '★ 붙이지 못한 파싱 결과도 해제된다 (세대가 바뀐 36MB 가 GPU 에 남지 않는다)',
    d4() === 1 && orphan.children.length === 0, `dispose ${d4()}, 남은 자식 ${orphan.children.length}`,
  );

  // ── 슬롯을 이름으로 나열하지 않는다 ──────────────────────────
  const { tex: tex5, disposals: d5 } = countingTexture();
  const exotic = new THREE.Object3D();
  const m = new THREE.MeshStandardMaterial();
  // `map` 도 `normalMap` 도 아닌, 이름 목록에 있을 리 없는 슬롯.
  (m as unknown as Record<string, unknown>)['앞으로생길KHR확장Map'] = tex5;
  exotic.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m));
  const exoticStats = obj.install({ scene: exotic });
  check(
    '★ 모르는 이름의 슬롯에 달린 텍스처도 센다 (isTexture 값으로 훑는다)',
    exoticStats.textures === 1, JSON.stringify(exoticStats),
  );
  obj.clear();
  check('★ 모르는 이름의 슬롯도 해제된다 (새 KHR 확장이 조용히 새어 나가지 않는다)',
    d5() === 1, String(d5()));
}

// ─────────────────────────────────────────────────────────────
// §8-10. 실제 익스포트 → 화면 직전까지 (진짜 워커 glTF 한 번)
//
// §8-8·§8-9 는 전부 **우리가 만든 값**으로 돈다. 그것만으로는 "익스포터가
// 정말 루트에 0.01 을 거는가", "그 파일에 아바타와 텍스처가 정말 들어 있는가"
// 를 증명하지 않는다 — 그리고 그 둘이 이 단위의 통과 기준 전부다.
//
// 그래서 여기서는 **익스포트를 딱 한 번** 돌린다. sample.zls 로 9.7MB / 1~2초다
// (사용자 씬은 36.5MB / 4.3초라 자동 테스트에 넣을 크기가 아니고, 애초에
// 저장소에 없다). 그 한 파일로 세 가지를 본다:
//
//   ① 실제 source(client.exportScene + downloadExport)로 상태 기계가 도는가
//   ② 파일에 아바타·머티리얼·이미지가 실제로 들어 있는가 (= "진짜 색")
//   ③ 그 파일이 우리 씬에 섰을 때 **사람 크기(cm)** 인가
//
// ③ 은 `parseSnapshot` 이 브라우저 전용이라 그대로는 못 돌린다. 무엇이 DOM 을
// 요구하는지 정확히 짚어 그 부분만 덜어낸다 — 아래 `stripImages` 참고. 덜어낸
// 뒤에도 **지오메트리·노드 계층·루트 0.01 은 실제 파일 그대로다.**
// ─────────────────────────────────────────────────────────────

/** 이 절에서 실제로 읽는 glTF 필드만 (전체 스키마를 옮겨 적지 않는다) */
interface GltfNode {
  name?: string;
  /** [x, y, z]. 없으면 원점 */
  translation?: number[];
  /** [x, y, z, w]. glTF 규약이 three.js 와 같은 순서다 */
  rotation?: number[];
  scale?: number[];
  children?: number[];
}
interface GltfShape {
  nodes?: GltfNode[];
  scenes?: { nodes?: number[] }[];
  meshes?: unknown[];
  materials?: unknown[];
  images?: unknown[];
}

/** `cloth0003_side1` → 3. 옷 패턴 노드가 아니면 null */
function clothPatternIndex(name: string): number | null {
  const m = /^cloth(\d+)_side\d+$/.exec(name);
  return m?.[1] === undefined ? null : Number(m[1]);
}

/** 두 배열의 성분별 최대 절대 편차. 길이가 다르면 Infinity */
function maxDiff(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return d;
}

/** 쿼터니언 회전각(도). w 의 크기만 보면 180° 를 0° 로 착각한다 */
function angleDeg(q: readonly number[]): number {
  return 2 * Math.acos(Math.min(1, Math.abs(q[3] ?? 1))) * 180 / Math.PI;
}

/**
 * glTF 에서 **이미지만** 덜어낸다. 나머지(정점·노드 변환·머티리얼 색)는 그대로다.
 *
 * 왜 필요한가: `GLTFLoader` 는 이미지를 만나면 `ImageBitmapLoader` 로 가고
 * 그 안에서 `self` 를 읽는다. Node 에는 없다 — 그래서 `parseSnapshot` 이
 * `snapshot.ts` 밖(브라우저 쪽)에 있는 것이다. 이 함수는 그 경계를 **우회하는
 * 것이 아니라 정확히 어디인지 표시한다**: 이미지를 뺀 같은 파일은 Node 에서
 * 그대로 열린다(아래에서 원본이 실패하는 것도 함께 확인한다).
 */
function stripImages(bytes: ArrayBuffer): { data: ArrayBuffer; json: GltfShape } {
  const json = JSON.parse(new TextDecoder().decode(bytes)) as GltfShape;
  const stripped = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
  delete stripped['images'];
  delete stripped['textures'];
  delete stripped['samplers'];
  const drop = (o: unknown): void => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k.endsWith('Texture')) delete (o as Record<string, unknown>)[k];
      else drop(v);
    }
  };
  for (const m of (stripped['materials'] ?? []) as unknown[]) drop(m);
  // `bufferViews` 를 지우지 않는 것이 중요하다 — 정점이 거기 들어 있다.
  // 이미지가 쓰던 view 는 참조가 사라져 아무도 읽지 않는다.
  const encoded = new TextEncoder().encode(JSON.stringify(stripped));
  return { data: encoded.buffer.slice(0, encoded.byteLength) as ArrayBuffer, json };
}

/**
 * Node 에 없는 `ProgressEvent` 를 잠깐 세워 둔다 (three 의 `FileLoader` 가
 * data URI 를 읽을 때 만든다). **DOM 을 흉내내려는 것이 아니다** — 이 한
 * 생성자만 없어서 버퍼 경로가 막히는 것을 열어, 진짜 경계(이미지)를 드러낸다.
 */
function withProgressEvent<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as Record<string, unknown>;
  const had = 'ProgressEvent' in g;
  if (!had) {
    g['ProgressEvent'] = class extends Event {
      lengthComputable = false;
      loaded = 0;
      total = 0;
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type);
        Object.assign(this, init);
      }
    };
  }
  return fn().finally(() => {
    if (!had) delete g['ProgressEvent'];
  });
}

/**
 * ★ ISSUE-011 의 **유일한 진짜 증명.** 실시간 옷과 스냅샷 옷이 같은 자리에 오는가.
 *
 * ── 왜 여기에 얹었는가 ──────────────────────────────────────
 * 이 대조에는 **정답지가 필요하다** — 익스포트한 glTF 의 노드 계층은 엔진이
 * 직접 만든 것이라 옳다고 간주한다. 그런데 정답지를 얻으려면 실제 워커로
 * 익스포트를 돌려야 하고(9.7MB / 1~2초), 그것만으로 독립 절을 세우면 스모크가
 * 통째로 그만큼 느려진다. §8-10 이 **이미 그 익스포트를 하고 파싱까지 해 둔다.**
 * 여기에 더해지는 비용은 `meshData(topology:true)` 한 번(~30ms)뿐이다.
 *
 * ── 무엇을 대조하는가 ───────────────────────────────────────
 * 두 층이다. 둘 다 있어야 한다:
 *   ⓐ **TRS 성분별** — 워커가 실은 열 개 숫자 vs 익스포터가 노드에 쓴 열 개 숫자.
 *      **회전을 여기서 잡는다.** 경계 상자는 회전에 거의 반응하지 않는다(§8-11).
 *   ⓑ **월드 경계 상자** — 그 숫자가 three 의 행렬을 타고 나온 결과. ⓐ 가 맞아도
 *      `cloth.ts` 가 그것을 안 걸거나 `boundingBox()` 가 로컬을 돌려주면 어긋난다.
 *
 * ── 그리고 대조군 ───────────────────────────────────────────
 * 같은 패턴에서 `transform` 만 뺀 `ClothObject` 를 하나 더 세운다. 이것이
 * **ISSUE-011 이전의 동작**이다. 이게 없으면 "원래 맞았던 것 아닌가" 를 배제할
 * 방법이 없다 — 위 두 대조가 통과해도 그 사실만으로는 변환이 일을 했다는
 * 증거가 되지 않는다.
 *
 * ⚠️ 씬별 좌표값을 박지 않는다. 박는 것은 **관계**뿐이고("정답지와 같다",
 *    "대조군은 다르다"), 정답지는 같은 실행에서 방금 뽑은 파일이다.
 */
async function compareLiveToGltf(
  client: GatewayClient,
  json: GltfShape,
  parsed: ParsedSnapshot,
  obj: SnapshotObject,
): Promise<void> {
  // ── 정답지: glTF 노드의 TRS ────────────────────────────────
  const truth = new Map<number, { t: number[]; r: number[]; s: number[]; nodes: number }>();
  let inconsistentSides = 0;
  for (const n of (json['nodes'] ?? []) as GltfNode[]) {
    const i = clothPatternIndex(n.name ?? '');
    if (i === null) continue;
    const trs = {
      t: n.translation ?? [0, 0, 0],
      r: n.rotation ?? [0, 0, 0, 1],
      s: n.scale ?? [1, 1, 1],
    };
    const seen = truth.get(i);
    if (!seen) {
      truth.set(i, { ...trs, nodes: 1 });
      continue;
    }
    seen.nodes += 1;
    // 한 패턴의 side 노드들은 같은 변환을 가져야 한다. 정답지 자신의 무결성 검사다.
    if (maxDiff(seen.t, trs.t) > 1e-6 || maxDiff(seen.r, trs.r) > 1e-6
      || maxDiff(seen.s, trs.s) > 1e-6) inconsistentSides += 1;
  }

  check(
    '★ 정답지가 성립한다 — glTF 에 옷 패턴 노드가 있고 side 노드끼리 변환이 같다',
    truth.size > 0 && inconsistentSides === 0,
    `패턴 ${truth.size}개 / side 불일치 ${inconsistentSides}건`,
  );

  // ── 실시간 경로: 같은 세션의 meshData(topology:true) ────────
  const live = decodePatterns(await client.meshData(true));
  const cloth = new ClothObject();
  const control = new ClothObject();
  try {
    cloth.setTopology(live);
    // 대조군 — `transform` 만 뺀다. ISSUE-011 이전의 `cloth.ts` 가 하던 일이다.
    control.setTopology(live.map((p) => {
      const { transform: _drop, ...rest } = p;
      return rest;
    }));

    check(
      '★ 실시간 패턴 수와 정답지의 옷 패턴 수가 같다 (짝을 지을 수 있다)',
      live.length === truth.size && live.length > 0,
      `실시간 ${live.length} / glTF ${truth.size}`,
    );

    // ── ⓐ TRS 성분별 대조 ────────────────────────────────────
    //
    // 두 값의 출처는 엔진 안에서 같아야 한다(`GetTransformIn3D()`). 달라진다면
    // 둘 중 하나가 잘못된 것을 보고 있다는 뜻이고, 그건 회귀가 아니라 설계 사고다.
    let worstT = 0;
    let worstR = 0;
    let worstS = 0;
    let missing = 0;
    let unmatched = 0;
    const rows: string[] = [];
    live.forEach((p, i) => {
      const g = truth.get(i);
      const t = p.transform;
      if (!g) {
        unmatched += 1;
        return;
      }
      if (!t) {
        missing += 1;
        return;
      }
      const dt = maxDiff(t.translation, g.t);
      const dr = maxDiff(t.rotation, g.r);
      const ds = maxDiff(t.scale, g.s);
      worstT = Math.max(worstT, dt);
      worstR = Math.max(worstR, dr);
      worstS = Math.max(worstS, ds);
      rows.push(`#${i} Δt=${dt.toExponential(1)} Δr=${dr.toExponential(1)} ${angleDeg(g.r).toFixed(0)}°`);
    });

    check(
      '★★ 실시간 변환이 정답지(익스포트한 glTF 노드)와 일치한다 — translation',
      missing === 0 && unmatched === 0 && worstT < 1e-3,
      `최대 편차 ${worstT.toExponential(2)}cm (없음 ${missing}, 짝 못 지음 ${unmatched})`,
    );
    check(
      '★★ 같은 대조 — rotation (쿼터니언 4성분. 순서가 틀리면 여기서 벌어진다)',
      missing === 0 && worstR < 1e-5,
      `최대 편차 ${worstR.toExponential(2)}`,
    );
    check(
      '★★ 같은 대조 — scale',
      missing === 0 && worstS < 1e-6,
      `최대 편차 ${worstS.toExponential(2)}`,
    );
    note('패턴별', rows.join('  '));

    // ── ⓐ-2 회전이 실제로 일을 했다 ──────────────────────────
    //
    // 위 세 줄이 통과해도, 정답지 자체가 전부 identity 면 "회전을 무시하는 구현"
    // 도 통과한다. 이 씬은 그렇지 않다는 것을 먼저 확인하고, 그 비자명 회전이
    // three 의 행렬까지 실제로 도달했는지를 **점의 행선지로** 본다 —
    // 180° 회전은 경계 상자를 안 바꿀 수 있기 때문이다(§8-11 참고).
    const spun = [...truth.entries()].filter(([, g]) => angleDeg(g.r) > 1);
    check(
      '★ 이 씬에는 회전이 자명하지 않은 패턴이 있다 (identity 뿐이면 아래 단언에 이빨이 없다)',
      spun.length > 0,
      `${spun.length}/${truth.size}개 — ${spun.map(([i, g]) => `#${i} ${angleDeg(g.r).toFixed(0)}°`).join(', ')}`,
    );
    let rotatedApplied = 0;
    let rotatedTotal = 0;
    for (const [i, g] of spun) {
      const p = live[i];
      const mesh = p ? cloth.patterns.find((m) => m.uuid === p.uuid)?.mesh : undefined;
      if (!mesh) continue;
      rotatedTotal += 1;
      // 정답지의 행렬로 옮긴 점 vs 실시간 메시의 행렬로 옮긴 점.
      const probe = new THREE.Vector3(10, 20, 30);
      // ⚠️ 순서는 T·R·S — **스케일이 먼저**다. 뒤집어 적으면 이 씬(scale
      //    [1,1,1])에서는 우연히 같은 값이 나오고, 스케일이 1이 아닌 씬이
      //    들어오는 순간 멀쩡한 구현을 빨간불로 만든다.
      const expect = probe.clone()
        .multiply(new THREE.Vector3().fromArray(g.s))
        .applyQuaternion(new THREE.Quaternion().fromArray(g.r))
        .add(new THREE.Vector3().fromArray(g.t));
      const got = probe.clone().applyMatrix4(mesh.matrixWorld);
      // 회전을 무시했을 때 갔을 자리. 여기로 가면 안 된다.
      const naive = probe.clone().add(new THREE.Vector3().fromArray(g.t));
      if (got.distanceTo(expect) < 1e-2 && got.distanceTo(naive) > 1) rotatedApplied += 1;
    }
    check(
      '★★ 비자명 회전이 three 의 행렬까지 실제로 도달했다 (180° 패널이 뒤집힌 채 놓이지 않는다)',
      rotatedTotal > 0 && rotatedApplied === rotatedTotal,
      `${rotatedApplied}/${rotatedTotal}개 — 회전을 무시했다면 0이 된다`,
    );

    // ── ⓑ 월드 경계 상자 대조 ────────────────────────────────
    //
    // 정답지 쪽은 **옷 노드만** 골라 잰다. 스냅샷 전체 상자에는 아바타가 들어
    // 있어 실시간(옷만)과 같은 대상이 아니다.
    obj.boundingBox(); // group.matrixWorld 를 갱신시킨다 (렌더를 안 돌렸다)
    const gltfCloth = new THREE.Box3();
    const tmp = new THREE.Box3();
    parsed.scene.traverse((o) => {
      if (clothPatternIndex(o.name) === null) return;
      gltfCloth.union(tmp.setFromObject(o));
    });

    const liveBox = cloth.boundingBox();
    const ctrlBox = control.boundingBox();
    const minGap = liveBox.min.distanceTo(gltfCloth.min);
    const maxGap = liveBox.max.distanceTo(gltfCloth.max);

    check(
      '★ 정답지에서 옷 노드만 골라낸 상자가 서 있다 (아바타가 섞이지 않았다)',
      !gltfCloth.isEmpty(),
      `${xyz(gltfCloth.min)} ~ ${xyz(gltfCloth.max)}`,
    );
    check(
      '★★★ 실시간 옷의 월드 경계 상자가 정답지와 같은 자리에 있다 (ISSUE-011 의 통과 기준)',
      !liveBox.isEmpty() && minGap < 0.5 && maxGap < 0.5,
      `min 차 ${minGap.toFixed(3)}cm / max 차 ${maxGap.toFixed(3)}cm`,
    );
    note('LIVE ', `${xyz(liveBox.min)} ~ ${xyz(liveBox.max)}`);
    note('GLTF ', `${xyz(gltfCloth.min)} ~ ${xyz(gltfCloth.max)}`);
    note('LOCAL', `${xyz(ctrlBox.min)} ~ ${xyz(ctrlBox.max)}  (대조군)`);

    // ── 대조군 — 변환을 빼면 확실히 어긋난다 ──────────────────
    const ctrlGap = ctrlBox.min.distanceTo(gltfCloth.min);
    check(
      '★★ 대조군 — 변환을 빼면 정답지에서 확연히 벗어난다 ("원래 맞았던 것 아닌가"를 배제한다)',
      ctrlGap > 10 && ctrlGap > minGap * 20,
      `대조군 ${ctrlGap.toFixed(1)}cm 어긋남 vs 변환 적용 ${minGap.toFixed(3)}cm`,
    );
    check(
      '★ 대조군의 옷은 원점을 중심에 두고 절반이 바닥 아래로 내려간다 (ISSUE-011 의 증상 그대로)',
      ctrlBox.min.y < 0 && Math.abs(ctrlBox.getCenter(new THREE.Vector3()).y) < 20,
      `바닥 y=${ctrlBox.min.y.toFixed(2)}, 중심 y=${ctrlBox.getCenter(new THREE.Vector3()).y.toFixed(2)}`,
    );
    check(
      '★ 두 상자의 **크기**는 대조군도 비슷하다 (달라진 것은 자리이지 형상이 아니다)',
      Math.abs(ctrlBox.getSize(new THREE.Vector3()).y - liveBox.getSize(new THREE.Vector3()).y)
        < liveBox.getSize(new THREE.Vector3()).y,
      `대조군 높이 ${ctrlBox.getSize(new THREE.Vector3()).y.toFixed(1)} / 적용 ${liveBox.getSize(new THREE.Vector3()).y.toFixed(1)}cm`,
    );

    // ── 그리고 아바타와의 관계 (#14 가 이 위에 쌓인다) ────────
    //
    // ISSUE-011 이 **차단**인 이유가 여기다. 옷이 몸 안쪽 높이에 오는가.
    const avatar = new THREE.Box3();
    parsed.scene.traverse((o) => {
      if (!o.name.startsWith('zeta_body')) return;
      avatar.union(tmp.setFromObject(o));
    });
    check(
      '★★ 실시간 옷이 아바타의 높이 범위 안에 든다 (아바타를 얹어도 몸에서 떨어지지 않는다)',
      !avatar.isEmpty() && liveBox.min.y > avatar.min.y - 5 && liveBox.max.y < avatar.max.y + 5,
      `옷 y ${liveBox.min.y.toFixed(1)}~${liveBox.max.y.toFixed(1)} / 아바타 y ${avatar.min.y.toFixed(1)}~${avatar.max.y.toFixed(1)}`,
    );
    check(
      '★ 대조군은 그 범위를 벗어난다 (이 단언에 이빨이 있다는 증거)',
      !avatar.isEmpty() && ctrlBox.min.y < avatar.min.y - 5,
      `대조군 바닥 y=${ctrlBox.min.y.toFixed(1)} vs 아바타 바닥 ${avatar.min.y.toFixed(1)}`,
    );
  } finally {
    cloth.clear();
    control.clear();
  }
}

async function sectionSnapshotRealExport(): Promise<void> {
  section('§8-10. 스냅샷 종단 — 실제 워커가 뽑은 glTF (익스포트 1회)');

  if (!existsSync(EXE) || !existsSync(ZLS)) {
    note('생략', `exe=${existsSync(EXE)}, zls=${existsSync(ZLS)}`);
    return;
  }

  // 산출물은 임시 디렉토리로 보낸다. 기본값(`backend/data/exports`)을 쓰면
  // 스모크를 한 번 돌 때마다 9.7MB 가 쌓인다 — TTL 은 게이트웨이가 살아 있는
  // 동안만 도는데 이 게이트웨이는 몇 초 뒤에 닫힌다.
  await withTempDir(async (tmp) => await withGateway(async (_gw, addr) => {
    const scene = await findOrUploadScene(addr.url);
    if (!scene) {
      check('씬 준비', false, 'sample.zls를 준비하지 못했다');
      return;
    }

    const client = new GatewayClient({ url: addr.url, requestTimeoutMs: 120_000 });
    try {
      await client.connect();
      await client.load(scene.id);

      // ── ① 실제 source 로 상태 기계를 돌린다 ──────────────────
      //
      // target 은 Node 에서 돌 수 있는 대역이다(파싱만 JSON 으로 대신한다).
      // 여기서 보는 것은 **바이트가 상태 기계를 타고 끝까지 오는가**이고,
      // 그 바이트로 무엇을 하는지는 ②·③ 이 본다.
      const progress: { loaded: number; total: number }[] = [];
      let received: ArrayBuffer | null = null;
      const loader = new SnapshotLoader<ArrayBuffer>({
        source: {
          requestExport: (format) => client.exportScene(format),
          download: (url, onProgress, expectedBytes) =>
            downloadExport(url, {
              base: addr.url,
              expectedBytes,
              onProgress: ({ loaded, total }) => onProgress(loaded, total),
            }),
        },
        target: {
          parse: async (bytes) => bytes,
          install: (bytes) => {
            received = bytes;
            return { meshes: 0, vertices: 0, materials: 0, textures: 0 };
          },
          clear: () => {},
        },
        onProgress: (p) => {
          if (p.phase === 'downloading') progress.push({ loaded: p.loaded, total: p.total });
        },
        now: () => performance.now(),
      });

      const r: SnapshotResult = await loader.load();
      const bytes = received as ArrayBuffer | null;
      check(
        '★ 실제 익스포트가 상태 기계를 타고 끝까지 온다 (export → GET → parse → install)',
        loader.phase === 'ready' && loader.present && bytes !== null,
        `${loader.phase}, ${r.elapsedMs}ms`,
      );
      if (!bytes) {
        check('받은 바이트가 있다', false);
        return;
      }
      check(
        '★ export 가 말한 크기와 실제로 받은 바이트가 같다 (중간에 잘리면 파싱이 실패한다)',
        bytes.byteLength === r.info.bytes, `${bytes.byteLength} === ${r.info.bytes}`,
      );
      check(
        '진행률이 단조 증가해 전체에 도달한다 (36MB 동안 화면이 멈춘 것처럼 보이지 않는다)',
        progress.length > 1
          && progress.every((p, i) => i === 0 || p.loaded >= (progress[i - 1]?.loaded ?? 0))
          && progress[progress.length - 1]?.loaded === bytes.byteLength,
        `보고 ${progress.length}회, 마지막 ${progress[progress.length - 1]?.loaded}/${progress[progress.length - 1]?.total}`,
      );
      note('실측', `${(r.info.bytes / (1 << 20)).toFixed(1)}MB — 익스포트 ${r.timings.exportMs}ms / 다운로드 ${r.timings.downloadMs}ms`);

      // ── ② 파일 안에 무엇이 들어 있는가 ───────────────────────
      const { data: strippedBytes, json } = stripImages(bytes);
      const nodes = (json['nodes'] ?? []) as GltfNode[];
      const rootIdx = ((json['scenes'] ?? [])[0]?.nodes ?? [])[0] as number | undefined;
      const rootNode = rootIdx === undefined ? undefined : nodes[rootIdx];

      check(
        '★★ 익스포터가 루트에 거는 스케일이 0.01 이다 — SNAPSHOT_SCALE 100 의 근거',
        rootNode?.scale?.length === 3 && rootNode.scale.every((v) => v === 0.01)
          && SNAPSHOT_SCALE * (rootNode.scale[0] ?? 0) === 1,
        `root scale = ${JSON.stringify(rootNode?.scale)}`,
      );
      const names = nodes.map((n) => n.name ?? '');
      const avatars = names.filter((n) => n.startsWith('zeta_body')).length;
      const cloths = names.filter((n) => n.startsWith('cloth')).length;
      check(
        '★ 한 파일에 아바타와 옷이 같이 들어 있다 (실시간 경로에는 아바타가 없다 — 이게 스냅샷의 이유다)',
        avatars > 0 && cloths > 0, `아바타 노드 ${avatars}, 옷 노드 ${cloths}`,
      );
      check(
        '★ 머티리얼과 임베드 이미지가 들어 있다 (= "진짜 옷 색")',
        ((json['materials'] ?? []) as unknown[]).length > 0
          && ((json['images'] ?? []) as unknown[]).length > 0,
        `머티리얼 ${((json['materials'] ?? []) as unknown[]).length}, 이미지 ${((json['images'] ?? []) as unknown[]).length}`,
      );

      // ── ③ 진짜 GLTFLoader 로 세워 본다 ───────────────────────
      //
      // 이미지만 덜어낸 같은 파일이다. 정점·노드 변환·루트 0.01 은 실제 그대로라
      // **크기와 위치**는 사람이 브라우저에서 보게 될 것과 정확히 같다.
      await withProgressEvent(async () => {
        // 대조군: 원본 그대로는 Node 에서 열리지 않는다. 이 실패가 곧
        // `parseSnapshot` 이 `snapshot.ts` 밖에 있는 이유이고, 그래서
        // 파싱만은 자동으로 못 덮는다는 사실의 증거다.
        const rawErr = await caught(parseSnapshot(bytes));
        check(
          '★ 대조군 — 임베드 이미지가 있는 원본은 Node 에서 못 연다 (파싱이 주입인 이유)',
          rawErr !== null, rawErr === null ? '열렸다(예상 밖)' : messageOf(rawErr),
        );

        const obj = new SnapshotObject();
        try {
          const parsed: ParsedSnapshot = await parseSnapshot(strippedBytes);
          const stats = obj.install(parsed);
          check(
            '★ 실제 glTF 가 three 씬 그래프로 선다 (메시·정점이 파일과 맞는다)',
            stats.meshes === ((json['meshes'] ?? []) as unknown[]).length && stats.vertices > 10_000,
            `메시 ${stats.meshes}, 정점 ${stats.vertices.toLocaleString('ko-KR')}, 머티리얼 ${stats.materials}`,
          );

          const box = obj.boundingBox();
          const size = box.getSize(new THREE.Vector3());
          // ★ 이 한 줄이 "아바타가 격자 한 칸 안의 점으로 보인다" 를 막는다.
          //   스케일이 1 이면 높이가 1.8cm 가 되고, 화면에서는 그냥 안 보인다.
          check(
            '★★ 실제 파일이 사람 크기(cm)로 선다 (높이 150~200cm) — 스케일 100 의 종단 확인',
            size.y > 150 && size.y < 200,
            `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} cm`,
          );
          check(
            '★ 발이 바닥(y≈0)에 있다 (격자 위에 서 있다 — 카메라 맞춤이 이 경계에 걸려 있다)',
            Math.abs(box.min.y) < 5, `바닥 y = ${box.min.y.toFixed(2)}cm`,
          );
          check(
            '옷이 아바타 안쪽 높이에 있다 (노드 translation 이 살아 있다)',
            size.y > 100, `높이 ${size.y.toFixed(1)}cm`,
          );
          note('실측', `bbox ${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} cm, 바닥 y=${box.min.y.toFixed(2)}`);

          // ── ④ 정답지 대조 (ISSUE-011) ──────────────────────
          await compareLiveToGltf(client, json, parsed, obj);
        } catch (err: unknown) {
          check('이미지를 덜어낸 실제 glTF 파싱', false, messageOf(err));
        } finally {
          obj.clear();
        }
      });
    } catch (err: unknown) {
      check('스냅샷 종단', false, messageOf(err));
    } finally {
      await client.close().catch(() => {});
    }
  }, {
    exportDir: path.join(tmp, 'exports'),
    sessions: { idleTimeout: 0, requestTimeoutMs: 120_000 },
  }));
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
  sectionClothTransform();
  sectionFrameStreamQueue();
  sectionFrameStreamCloth();
  await sectionSnapshotMachine();
  sectionSnapshotObject();
  await sectionViewerRealScene();
  await sectionReconnectReload();
  await sectionRealFrames();
  await sectionSnapshotRealExport();
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
