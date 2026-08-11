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
 *   - 파라미터 스키마 — 뚫리면 슬라이더를 움직여도 워커가 `unknown`으로 되돌리고
 *     사용자는 조용히 **아무 일도 안 일어나는 것**을 본다 (§11)
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
import { existsSync, readFileSync, statSync } from 'node:fs';
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
import {
  buildSetParamsPayload,
  changedParams,
  coerceParamValue,
  disabledParams,
  fallbackParamValues,
  isTypingTarget,
  paramDisabledReason,
  paramField,
  paramGroups,
  PARAM_BY_KEY,
  PARAM_FIELDS,
  PARAM_GROUP_LABELS,
  PARAM_GROUP_ORDER,
  PlaybackController,
  readParamValues,
  shortcutFor,
  SHORTCUT_HINT,
  DEFAULT_SIDE_TAB,
  isSideTabId,
  SIDE_TABS,
  SideTabsPanel,
  type ParamField,
  type ParamKey,
  type ParamValue,
  type ParamValues,
  type PlaybackHooks,
  type PlaybackPort,
  type ShortcutAction,
  type SideTabsView,
} from '../panels/index.ts';
// L-3c 는 판단(`panels/sideTabs.ts`)과 그리기(`ui/sideTabs.ts`)가 갈려 있고,
// **둘 다** 여기서 본다. 배럴로 가져오는 것은 의도적이다 — Builder 가 이번에
// `ui/index.ts` 의 재export 를 건드렸으므로 그 줄도 같이 지난다.
import { SideTabs } from '../ui/index.ts';
// ★ #15-b 부터는 **제품의 `apply2d` 를 그대로 쓴다.** 15-a 때는 스모크가 자기
//   사본을 들고 열벡터 규약을 못박았는데, 그러면 사본만 지켜지고 제품이 갈라져도
//   초록이다. 규약을 못박는 절(§8-12 ⑤)이 제품 함수를 부르게 두면 그 틈이 닫힌다.
import {
  apply2d,
  Design2DLayer,
  DESIGN_LAYERS,
  Unfolder,
  UnfoldController,
  type DesignLayerKey,
  type UnfoldStats,
} from '../viewer2d/index.ts';
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
  type StatusResult,
} from './index.ts';
// 변환 타입 둘. ISSUE-018 부터는 배럴(`index.ts`)도 이 둘을 재export 하지만,
// 정의가 사는 곳은 `types.ts`(→ `sdk/protocol.ts`)이므로 여기서 직접 꺼낸다.
import type { PatternMaterial, PatternTransform, PatternTransform2D } from './types.ts';

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

  // ── transform2d (ISSUE-018) — 2D 도면 배치 ──────────────────
  //
  // `transform`(3D)과 **다른 것이다.** 저쪽은 옷이 몸에 둘러지는 자리, 이쪽은
  // 재단 도면 위의 자리다. 실패 양상은 같다 — 모양이 틀린 것을 통과시키면 2D
  // 좌표가 `NaN` 이 되어 그 패턴이 화면에서 통째로 사라지는데 정점 수는 정상으로
  // 찍힌다. 반대로 없는 것을 오류로 만들면 프레임 이벤트마다 던져서 2D 뷰가
  // 아예 안 선다. 두 방향 모두 못으로 박는다.
  //
  // ⚠️ 여기서 보는 것은 **모양뿐**이다. 값이 옳은가(전치되지 않았는가)는 바깥의
  //    정답지가 있어야 알 수 있고, 그건 backend 스모크 §5.7·§5.8 이 씬 파일의
  //    translateX/rotation 과 성분별로 대조해서 본다. 이 절이 그것까지 본다고
  //    착각하면 전치를 놓친다.
  const with2d = (raw: unknown): PatternData =>
    ({ ...tBase, transform2d: raw } as unknown as PatternData);

  const r2 = decodePattern(with2d([1, 2, 3, 4, 5, 6, 0, 0, 1])).transform2d;
  check(
    'transform2d 왕복 — 아홉 개 숫자가 순서 그대로 실린다 (행 우선)',
    r2 !== undefined && r2.length === 9 && r2.join(',') === '1,2,3,4,5,6,0,0,1',
    JSON.stringify(r2),
  );
  check(
    '★ 디코더가 배열을 복사한다 (워커 응답 객체를 나중에 재사용해도 값이 안 새어 나간다)',
    (() => {
      const raw = [1, 2, 3, 4, 5, 6, 0, 0, 1];
      const out = decodePattern(with2d(raw)).transform2d;
      raw[2] = 999;
      return out?.[2] === 3;
    })(),
  );

  const absent2d = (label: string, p: PatternData): { ok: boolean; detail: string } => {
    try {
      const d = decodePattern(p);
      return {
        ok: d.transform2d === undefined && !('transform2d' in d),
        detail: 'transform2d' in d
          ? `${label}: 키가 남았다 ${JSON.stringify(d.transform2d)}`
          : `${label}: 키 자체가 없다`,
      };
    } catch (err: unknown) {
      return { ok: false, detail: `${label}: 던졌다 — ${messageOf(err)}` };
    }
  };
  const no2dKey = absent2d('키 없음', tBase);
  const null2dKey = absent2d('null', with2d(null));
  check(
    '★★ transform2d 가 없으면 undefined 다 — 항등행렬로 메우지 않는다',
    no2dKey.ok, no2dKey.detail,
  );
  check(
    '★ null 도 오류가 아니다 (topology:false·서피스 없는 패턴 → "배치를 모른다")',
    null2dKey.ok, null2dKey.detail,
  );

  const bad2d: [string, unknown, string][] = [
    ['★★ 원소가 6개 (마지막 행을 잘라 보낸 워커 — 2×3 으로 착각하기 딱 좋은 모양)',
      [1, 0, 0, 0, 1, 0], '길이 6'],
    ['★ 원소가 16개 (3D 4×4 행렬을 그대로 실었다)',
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], '길이 16'],
    ['★ 원소가 하나 모자란다 (8개)',
      [1, 0, 0, 0, 1, 0, 0, 0], '길이 8'],
    ['★ 빈 배열',
      [], '길이 0'],
    ['★★ NaN 이 섞였다 (three 가 조용히 아무것도 안 그린다 — 화면에서 원인을 못 읽는다)',
      [1, 0, Number.NaN, 0, 1, 0, 0, 0, 1], '숫자가 아닌 값'],
    ['★ Infinity 가 섞였다 (0 으로 나눈 스케일)',
      [1, 0, 0, 0, Number.POSITIVE_INFINITY, 0, 0, 0, 1], '숫자가 아닌 값'],
    ['★ 숫자를 문자열로 실었다 (JSON 직렬화 사고)',
      ['1', 0, 0, 0, 1, 0, 0, 0, 1], '숫자가 아닌 값'],
    ['★ null 이 원소로 섞였다',
      [1, 0, null, 0, 1, 0, 0, 0, 1], '숫자가 아닌 값'],
    ['★★ 배열이 아니라 객체다 ({m00:…} 로 보낸 워커)',
      { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0, m20: 0, m21: 0, m22: 1 }, 'object'],
    ['★★ 3D transform 을 2D 자리에 실었다 (키 이름을 헷갈린 워커)',
      { translation: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, 'object'],
    ['★ 숫자 하나를 실었다',
      42, 'number'],
    ['★ 중첩 배열로 실었다 ([[…],[…],[…]] — 길이 3이라 길이 검사에 먼저 걸린다)',
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]], '길이 3'],
  ];
  for (const [label, raw, expect] of bad2d) {
    let msg = '';
    try {
      decodePattern(with2d(raw));
    } catch (err: unknown) {
      msg = messageOf(err);
    }
    check(
      `${label} → 던진다`,
      msg.includes(expect) && msg.includes('transform2d') && msg.includes('p-t'),
      msg || '조용히 통과해버렸다 — 패턴 하나가 화면에서 사라지고 원인을 못 읽는다',
    );
  }

  // 두 변환이 서로의 검증을 건드리지 않는다. 한쪽만 틀린 응답에서 **틀린 쪽**을
  // 지목해야 원인을 읽을 수 있다.
  {
    const both = decodePattern({
      ...tBase,
      transform: { translation: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      transform2d: [9, 8, 7, 6, 5, 4, 0, 0, 1],
    } as unknown as PatternData);
    check(
      '★ 한 패턴이 3D·2D 변환을 동시에 들 수 있다 (topology:true 응답의 실제 모양)',
      both.transform?.translation.join(',') === '1,2,3'
      && both.transform2d?.join(',') === '9,8,7,6,5,4,0,0,1',
      `${JSON.stringify(both.transform)} / ${JSON.stringify(both.transform2d)}`,
    );
    let which = '';
    try {
      decodePattern({
        ...tBase,
        transform: { translation: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        transform2d: [1, 2, 3],
      } as unknown as PatternData);
    } catch (err: unknown) {
      which = messageOf(err);
    }
    check(
      '★★ 2D 만 틀렸을 때 오류가 2D 를 지목한다 (3D 를 탓하면 엉뚱한 곳을 판다)',
      which.includes('transform2d') && !which.includes('transform.'),
      which || '던지지 않았다',
    );
  }

  // ── material (materials-a) — 패턴의 진짜 재질 ────────────────
  //
  // 위 두 변환과 **같은 일**을 하지만 실패 양상이 다르다. 변환이 `NaN` 이면
  // 그 패턴이 화면에서 통째로 사라져서 최소한 눈에는 띈다. 색은 그렇지 않다 —
  // `NaN` 이나 문자열이 섞인 색을 three 에 넘기면 그 패턴만 **검게** 그려지고,
  // 그건 "어두운 천"과 구분되지 않는다. 화면만 보고는 재질 문제인지 조명
  // 문제인지 알 수 없다. 그래서 디코더가 끊어야 한다.
  //
  // ⚠️ 여기서 보는 것은 **모양뿐**이다. 색이 씬의 값과 같은가는 바깥의 정답지가
  //    있어야 알 수 있고, 그건 backend 스모크 §5.9·§5.10 이 `.zls` 안의
  //    materials·clothPatterns 블록과 패턴별로 대조해서 본다. 이 절이 그것까지
  //    본다고 착각하면 **채널 순서가 뒤집힌 것을 놓친다** (RGB→BGR 은 이 절의
  //    모든 단언을 통과한다).
  const withMat = (raw: unknown): PatternData =>
    ({ ...tBase, material: raw } as unknown as PatternData);
  const goodMat = {
    fabricUuid: '356924893322900/1500000',
    color: [0.9254902, 0.8117647, 0.4705882],
    colorProfile: 'srgb',
    opacity: 1,
    roughness: 0.3,
    metalness: 0,
  };

  {
    const m = decodePattern(withMat(goodMat)).material;
    check(
      'material 왕복 — 여섯 필드가 그대로 실린다',
      m !== undefined
      && m.fabricUuid === goodMat.fabricUuid
      && m.color.join(',') === '0.9254902,0.8117647,0.4705882'
      && m.colorProfile === 'srgb'
      && m.opacity === 1 && m.roughness === 0.3 && m.metalness === 0,
      JSON.stringify(m),
    );
    check(
      '★ 색 배열을 복사한다 (워커 응답 객체를 나중에 재사용해도 값이 안 새어 나간다)',
      (() => {
        const raw = { ...goodMat, color: [0.1, 0.2, 0.3] };
        const out = decodePattern(withMat(raw)).material;
        raw.color[0] = 999;
        return out?.color[0] === 0.1;
      })(),
    );
    check(
      "★★ colorProfile 'linear' 도 통과한다 (씬이 선형이면 그렇게 온다 — srgb 로 넘겨짚지 않는다)",
      decodePattern(withMat({ ...goodMat, colorProfile: 'linear' })).material?.colorProfile === 'linear',
    );
  }

  // 없는 것은 오류가 아니다 — 재질 없는 패턴, topology:false 프레임.
  // ★ 흰색으로 메우면 안 된다: `sample.zls` 는 다섯 패턴이 **진짜로 전부 흰색**
  //   이라, 메우는 순간 "흰 옷"과 "색을 모름"이 화면에서 같아진다. 그러면
  //   `cloth.ts` 의 임의 팔레트로 폴백할 기회가 사라지고 옷이 흰 덩어리가 된다.
  const absentMat = (label: string, p: PatternData): { ok: boolean; detail: string } => {
    try {
      const d = decodePattern(p);
      return {
        ok: d.material === undefined && !('material' in d),
        detail: 'material' in d ? `${label}: 키가 남았다 ${JSON.stringify(d.material)}` : `${label}: 키 자체가 없다`,
      };
    } catch (err: unknown) {
      return { ok: false, detail: `${label}: 던졌다 — ${messageOf(err)}` };
    }
  };
  const noMatKey = absentMat('키 없음', tBase);
  const nullMatKey = absentMat('null', withMat(null));
  check(
    '★★ material 이 없으면 undefined 다 — 흰색으로 메우지 않는다 (진짜 흰 옷과 구분해야 팔레트로 폴백할 수 있다)',
    noMatKey.ok, noMatKey.detail,
  );
  check(
    '★ null 도 오류가 아니다 (topology:false·재질 없는 패턴 → "색을 모른다")',
    nullMatKey.ok, nullMatKey.detail,
  );

  const badMat: [string, unknown, string][] = [
    ['★★ color 가 4개다 (basecolor 를 알파까지 그대로 실은 워커 — 가장 있을 법한 사고)',
      { ...goodMat, color: [1, 1, 1, 1] }, '길이 4'],
    ['★★ color 가 2개다',
      { ...goodMat, color: [1, 1] }, '길이 2'],
    ['★ color 가 빈 배열',
      { ...goodMat, color: [] }, '길이 0'],
    ['★★ color 에 NaN 이 섞였다 (three 가 그 패턴만 검게 그린다 — "어두운 천"과 구분이 안 된다)',
      { ...goodMat, color: [1, Number.NaN, 1] }, 'material.color 에 숫자가 아닌 값'],
    ['★ color 에 Infinity 가 섞였다',
      { ...goodMat, color: [1, 1, Number.POSITIVE_INFINITY] }, 'material.color 에 숫자가 아닌 값'],
    ['★ color 를 문자열로 실었다 ("#ecCF78" 같은 hex 를 보낸 워커)',
      { ...goodMat, color: '#ecCF78' }, 'string'],
    ['★ color 원소가 문자열이다 (JSON 직렬화 사고)',
      { ...goodMat, color: ['1', 1, 1] }, 'material.color 에 숫자가 아닌 값'],
    ['★ color 원소가 null 이다',
      { ...goodMat, color: [1, null, 1] }, 'material.color 에 숫자가 아닌 값'],
    ['★ color 를 {r,g,b} 객체로 실었다',
      { ...goodMat, color: { r: 1, g: 1, b: 1 } }, 'object'],
    ['★ color 키가 아예 없다',
      { fabricUuid: 'f', colorProfile: 'srgb', opacity: 1, roughness: 1, metalness: 0 }, 'undefined'],
    ["★★ colorProfile 이 'sRGB' 다 (대소문자를 흘려 쓴 워커 — 통과시키면 색이 조용히 어긋난다)",
      { ...goodMat, colorProfile: 'sRGB' }, 'colorProfile'],
    ['★★ colorProfile 을 숫자로 실었다 (엔진 enum 을 그대로 — 0/1 중 뭐가 뭔지 받는 쪽이 모른다)',
      { ...goodMat, colorProfile: 1 }, 'colorProfile'],
    ['★★ colorProfile 키가 없다 (구버전 워커 — srgb 로 넘겨짚으면 아무도 예외를 못 본다)',
      { fabricUuid: 'f', color: [1, 1, 1], opacity: 1, roughness: 1, metalness: 0 }, 'colorProfile'],
    ['★ opacity 가 NaN',
      { ...goodMat, opacity: Number.NaN }, 'material.opacity'],
    ['★ roughness 가 문자열',
      { ...goodMat, roughness: '0.3' }, 'material.roughness'],
    ['★ metalness 키가 없다',
      { fabricUuid: 'f', color: [1, 1, 1], colorProfile: 'srgb', opacity: 1, roughness: 1 }, 'material.metalness'],
    ['★★ fabricUuid 를 숫자로 실었다 (그룹화 키가 문자열이 아니면 Map 이 조용히 갈린다)',
      { ...goodMat, fabricUuid: 356924893322900 }, 'fabricUuid'],
    ['★ fabricUuid 키가 없다',
      { color: [1, 1, 1], colorProfile: 'srgb', opacity: 1, roughness: 1, metalness: 0 }, 'fabricUuid'],
    ['★★ material 을 숫자로 실었다',
      42, 'material 이 객체가 아닙니다'],
    ['★ material 을 문자열로 실었다',
      '#ecCF78', 'material 이 객체가 아닙니다'],
    ['★★ material 자리에 색 배열만 실었다 ([r,g,b] — 필드 이름을 헷갈린 워커)',
      [1, 1, 1], 'material.color'],
    ['★★ material 자리에 transform2d 를 실었다 (필드가 셋이 되면서 생긴 새 사고)',
      [1, 0, 0, 0, 1, 0, 0, 0, 1], 'material.color'],
  ];
  for (const [label, raw, expect] of badMat) {
    let msg = '';
    try {
      decodePattern(withMat(raw));
    } catch (err: unknown) {
      msg = messageOf(err);
    }
    check(
      `${label} → 던진다`,
      msg.includes(expect) && msg.includes('material') && msg.includes('p-t'),
      msg || '조용히 통과해버렸다 — 그 패턴만 검게 그려지고 화면에서 원인을 못 읽는다',
    );
  }

  // ★ 범위(0~1)는 **일부러 안 본다.** 계약이므로 못박는다 — 여기 검사를 넣으면
  //   HDR 색을 쓰는 씬이 통째로 안 열린다. 대신 "0~255 로 냈다" 같은 사고는
  //   backend 스모크 §5.9 가 씬 정답지와 대조해서 잡는다. 이 줄이 깨진다면
  //   그건 회귀가 아니라 **계약 변경**이고, 그때 저쪽 단언도 같이 봐야 한다.
  check(
    '★★ 범위 밖 값은 통과시킨다 (음수·1 초과 — 디코더는 씬의 색을 판정할 권한이 없다)',
    (() => {
      const m = decodePattern(withMat({ ...goodMat, color: [-0.2, 1.8, 0], opacity: 2 })).material;
      return m?.color.join(',') === '-0.2,1.8,0' && m.opacity === 2;
    })(),
  );

  // 세 필드가 서로의 검증을 건드리지 않는다. 한쪽만 틀린 응답에서 **틀린 쪽**을
  // 지목해야 원인을 읽을 수 있다 — 이제 후보가 셋이라 더 중요해졌다.
  {
    const all3 = decodePattern({
      ...tBase,
      transform: { translation: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      transform2d: [9, 8, 7, 6, 5, 4, 0, 0, 1],
      material: goodMat,
    } as unknown as PatternData);
    check(
      '★★ 한 패턴이 3D·2D·재질을 동시에 들 수 있다 (topology:true 응답의 실제 모양)',
      all3.transform?.translation.join(',') === '1,2,3'
      && all3.transform2d?.join(',') === '9,8,7,6,5,4,0,0,1'
      && all3.material?.color.join(',') === '0.9254902,0.8117647,0.4705882',
      `${JSON.stringify(all3.transform2d)} / ${JSON.stringify(all3.material)}`,
    );
    let which = '';
    try {
      decodePattern({
        ...tBase,
        transform: { translation: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        transform2d: [9, 8, 7, 6, 5, 4, 0, 0, 1],
        material: { ...goodMat, color: [1, 1] },
      } as unknown as PatternData);
    } catch (err: unknown) {
      which = messageOf(err);
    }
    check(
      '★★ 재질만 틀렸을 때 오류가 재질을 지목한다 (변환을 탓하면 엉뚱한 곳을 판다)',
      which.includes('material.color') && !which.includes('transform'),
      which || '던지지 않았다',
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
      /** 같은 것을 2D 배치에 대해서도 (ISSUE-018) */
      let transform2dAtLoad: string | null = null;
      /** 그리고 재질에 대해서도 (materials-a) */
      let materialAtLoad: string | null = null;
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

        // ── 2D 도면 배치 (ISSUE-018) — 3D 와 섞이지 않는가 ──────
        //
        // 여기서 보는 것도 "워커가 무엇을 실었는가" 다. 그 행렬이 **전치되지
        // 않았는가**는 씬 파일의 정답지와 대조해야 알 수 있고, 그건 backend
        // 스모크 §5.7·§5.8 이 한다 — 이 파일에는 `.zls` 를 읽는 손이 없다.
        const raws2d = md.patterns.map((p) => (p as unknown as Record<string, unknown>)['transform2d']);
        transform2dAtLoad = JSON.stringify(raws2d);
        check(
          '★ topology:true 응답의 모든 패턴에 transform2d 가 실려 있다 (ISSUE-018)',
          raws2d.length > 0 && raws2d.every((t) => Array.isArray(t) && t.length === 9),
          `${raws2d.filter((t) => Array.isArray(t)).length}/${raws2d.length}개`,
        );
        check(
          '★ decodePattern 이 그 형식을 통과시킨다 (길이 9, 전부 유한)',
          patterns.length > 0 && patterns.every((p) => p.transform2d !== undefined),
          `${patterns.filter((p) => p.transform2d).length}/${patterns.length}개`,
        );
        check(
          '★★ 마지막 행이 [0,0,1] 이다 — 전치되면 여기에 translate 가 앉는다',
          patterns.length > 0 && patterns.every(
            (p) => p.transform2d?.[6] === 0 && p.transform2d[7] === 0 && p.transform2d[8] === 1,
          ),
          patterns.map((p) => `[${p.transform2d?.slice(6).join(',')}]`).join(' '),
        );
        check(
          '★★ 3D transform 과 2D transform2d 가 **다른 값**이다 (섞이면 ISSUE-011 을 다시 겪는다)',
          patterns.length > 0 && patterns.every((p) => {
            const t3 = p.transform;
            const t2 = p.transform2d;
            if (!t3 || !t2) return false;
            return Math.abs(t3.translation[0] - t2[2]) > 1e-3
              || Math.abs(t3.translation[1] - t2[5]) > 1e-3;
          }),
          patterns.map((p) => `3D[${p.transform?.translation.slice(0, 2).map((v) => v.toFixed(1)).join(',')}]≠2D[${p.transform2d?.[2].toFixed(1)},${p.transform2d?.[5].toFixed(1)}]`).join(' '),
        );
        note('2D 배치', patterns.map((p) => {
          const m = p.transform2d;
          return m ? `[${m[2].toFixed(1)},${m[5].toFixed(1)}]` : '없음';
        }).join(' '));

        // ── 패턴 재질 (materials-a) — 워커가 무엇을 실었나 ────────
        //
        // 값이 씬의 색과 같은가는 **여기서 못 본다** — 정답지가 `.zls` 안에
        // 있고 이 파일에는 그것을 읽는 손이 없다(backend 스모크 §5.9·§5.10 이
        // 맡는다). 여기서 보는 것은 "실제 워커가 보낸 바이트가 디코더의 모양
        // 계약을 통과하는가", 그리고 **합성 데이터로는 절대 안 나오는 사고**
        // 두 가지다: 0~255 로 냈는가, 패턴 uuid 를 fabricUuid 자리에 실었는가.
        const rawMats = md.patterns.map((p) => (p as unknown as Record<string, unknown>)['material']);
        materialAtLoad = JSON.stringify(rawMats);
        check(
          '★ topology:true 응답의 모든 패턴에 material 이 실려 있다 (materials-a)',
          rawMats.length > 0 && rawMats.every((m) => m !== null && typeof m === 'object'),
          `${rawMats.filter((m) => m !== null && typeof m === 'object').length}/${rawMats.length}개`,
        );
        check(
          '★ decodePattern 이 실제 워커의 재질을 통과시킨다 (여섯 필드가 전부 계약대로다)',
          patterns.length > 0 && patterns.every((p) => p.material !== undefined),
          `${patterns.filter((p) => p.material).length}/${patterns.length}개`,
        );
        check(
          '★★ 색 채널이 0~1 이다 (0~255 로 내면 three 가 1 초과를 잘라내서 옷이 통째로 흰색이 된다)',
          patterns.length > 0 && patterns.every(
            (p) => p.material !== undefined && p.material.color.every((v) => v >= 0 && v <= 1),
          ),
          patterns.map((p) => `[${p.material?.color.map((v) => v.toFixed(3)).join(',')}]`).join(' '),
        );
        check(
          "★★ colorProfile 이 'srgb' 다 (선형으로 착각해 칠하면 눈에 띄게 어두워진다)",
          patterns.length > 0 && patterns.every((p) => p.material?.colorProfile === 'srgb'),
          [...new Set(patterns.map((p) => p.material?.colorProfile))].join(','),
        );
        check(
          '★★ fabricUuid 가 패턴 uuid 가 아니다 (그대로 실으면 그룹이 전부 1개짜리가 되어 직물 목록이 무의미해진다)',
          patterns.length > 0 && patterns.every(
            (p) => typeof p.material?.fabricUuid === 'string'
              && p.material.fabricUuid.length > 0 && p.material.fabricUuid !== p.uuid,
          ),
          `패턴 ${patterns.length}개 → 직물 ${new Set(patterns.map((p) => p.material?.fabricUuid)).size}종`,
        );
        check(
          '★★★ 세 필드가 서로 다른 모양으로, 서로 안 섞여서 온다 (TRS 객체 / 숫자 9개 / 재질 객체)',
          patterns.length > 0 && patterns.every((p) => {
            const t2 = p.transform2d;
            const c = p.material?.color;
            if (!p.transform || !t2 || !c || Array.isArray(p.material)) return false;
            // 색이 2D 행렬 앞 세 자리로도, 3D translation 으로도 새지 않았는가
            const same = (a: readonly number[], b: readonly number[]): boolean =>
              a.every((v, i) => Math.abs(v - b[i]!) < 1e-6);
            return !same(c, [t2[0], t2[1], t2[2]]) && !same(c, p.transform.translation);
          }),
          patterns.map((p) => `색[${p.material?.color.map((v) => v.toFixed(2)).join(',')}]`).join(' '),
        );
        note('재질', patterns.map((p) => {
          const m = p.material;
          return m ? `[${m.color.map((v) => v.toFixed(3)).join(',')}] r${m.roughness} m${m.metalness} a${m.opacity}` : '없음';
        }).join(' | '));

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
      // 2D 배치도 같은 갈래에 있다. 근거는 **다르다** — 3D 쪽은 249프레임 실측
      // 불변이 근거이고, 이쪽은 "이 워커에 2D 배치를 바꿀 op 이 하나도 없다"다.
      // 2D 저작 기능이 붙는 순간 이 단언이 설계 변경을 알리는 자리가 된다.
      const with2dKey = framePatterns.filter(
        (p) => 'transform2d' in (p as unknown as Record<string, unknown>),
      ).length;
      check(
        '★★ 프레임 이벤트의 mesh 에는 transform2d 키도 아예 없다 (ISSUE-018 — topology 게이팅)',
        framePatterns.length > 0 && with2dKey === 0,
        `패턴 ${framePatterns.length}개 중 ${with2dKey}개에 실렸다`,
      );
      // 재질도 같은 갈래다. 근거는 "이 워커에 재질을 바꿀 op 이 하나도 없다"인데,
      // ⚠️ **2D 배치보다 먼저 깨진다** — 백로그의 `setFabric` 이 정확히 이 값을
      // 바꾸는 op 이다. 그때 증상은 원단을 바꿔도 색이 그대로라 "적용 버튼이 안
      // 먹는다"로 보인다. 그 순간을 잡는 파수꾼은 backend 스모크 §5.9 의
      // "워커가 아직 setFabric 을 모른다" 단언이다.
      const withMatKey = framePatterns.filter(
        (p) => 'material' in (p as unknown as Record<string, unknown>),
      ).length;
      check(
        '★★ 프레임 이벤트의 mesh 에는 material 키도 아예 없다 (materials-a — topology 게이팅)',
        framePatterns.length > 0 && withMatKey === 0,
        `패턴 ${framePatterns.length}개 중 ${withMatKey}개에 실렸다`,
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
      const raws2d2 = JSON.stringify(
        md2.patterns.map((p) => (p as unknown as Record<string, unknown>)['transform2d']),
      );
      check(
        '★★ 시뮬을 돌린 뒤에도 transform2d 가 한 글자도 안 바뀐다 (ISSUE-018 — 한 번만 보내는 근거)',
        transform2dAtLoad !== null && raws2d2 === transform2dAtLoad,
        transform2dAtLoad === null ? '로드 직후 값을 못 받았다'
          : raws2d2 === transform2dAtLoad ? `${md2.patterns.length}개 동일 (frame ${reached}+)`
            : `달라졌다: ${raws2d2.slice(0, 160)}`,
      );
      const rawsMat2 = JSON.stringify(
        md2.patterns.map((p) => (p as unknown as Record<string, unknown>)['material']),
      );
      check(
        '★★ 시뮬을 돌린 뒤에도 material 이 한 글자도 안 바뀐다 (materials-a — 한 번만 보내는 근거)',
        materialAtLoad !== null && rawsMat2 === materialAtLoad,
        materialAtLoad === null ? '로드 직후 값을 못 받았다'
          : rawsMat2 === materialAtLoad ? `${md2.patterns.length}개 동일 (frame ${reached}+)`
            : `달라졌다: ${rawsMat2.slice(0, 160)}`,
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
// §8-12. 2D 도면 배치가 3D 를 타고 흘러 내려온다 (ISSUE-018)
//
// `transform2d` 는 3D 뷰가 쓰지 않는 값인데도 `cloth.ts` 가 들고 있다 —
// `uvs` 와 짝이고, 그 둘을 함께 쥐고 있는 유일한 객체가 여기이기 때문이다
// (#15-b 의 2D 뷰가 `cloth.patterns` 에서 꺼내 간다).
//
// ★ 이 절의 값어치는 두 가지다:
//   ① **2D 행렬이 3D 로 새지 않는다** — `mesh` 에 걸리는 것은 `transform`
//      뿐이다. 2D 행렬을 실수로 `mesh.position` 에 얹으면 옷이 도면 좌표만큼
//      통째로 옮겨 가는데, 화면에서는 "옷이 좀 떠 있네" 로만 보인다.
//   ② **열벡터 규약을 실행 가능한 형태로 못박는다.** #15-b 는 이 식을 그대로
//      쓴다. 행렬을 전치해 읽어도 패턴은 흩어지고 그림은 그럴듯해서, 규약을
//      주석으로만 두면 반대로 구현해도 아무 데서도 안 걸린다.
// ─────────────────────────────────────────────────────────────

/** uv 와 2D 배치를 함께 든 패턴 하나 */
function pattern2d(
  uuid: string,
  uvs: readonly number[],
  transform2d?: readonly number[],
  transform?: PatternTransform,
): DecodedPattern {
  const vertices = uvs.length / 2;
  const p: DecodedPattern = {
    uuid,
    positions: Float32Array.from(new Array(vertices * 3).fill(0)),
    uvs: Float32Array.from(uvs),
    vertices,
    triangles: 0,
  };
  if (transform2d) p.transform2d = [...transform2d] as unknown as PatternTransform2D;
  if (transform) p.transform = transform;
  return p;
}

function sectionCloth2D(): void {
  section('§8-12. 2D 도면 배치 (ISSUE-018, cloth.ts, DOM 없이)');

  // ── ① 실려 오고, 우리 것이 된다 ─────────────────────────────
  {
    // ⚠️ 디코더가 준 **그 배열**을 건드려야 한다. 여기서 사본을 만들어 넘기면
    //    `cloth.ts` 가 참조를 그대로 들고 있어도 통과해버린다 (실제로 그렇게
    //    썼다가 돌연변이 M8 을 놓쳤다).
    const decoded = pattern2d('a', [0, 0, 1, 1], [2, 0, 0, 0, 3, 0, 0, 0, 1]);
    const src = decoded.transform2d as unknown as number[];
    const cloth = new ClothObject();
    cloth.setTopology([decoded]);
    const p = cloth.patterns[0];
    check(
      '★ PatternMesh 가 transform2d 를 든다 (uvs 와 같은 객체에서 꺼낼 수 있다 — #15-b 가 여기서 읽는다)',
      p?.transform2d?.join(',') === '2,0,0,0,3,0,0,0,1',
      JSON.stringify(p?.transform2d),
    );
    src[0] = 999;
    check(
      '★★ 복사본이다 — 디코더가 준 그 배열을 나중에 건드려도 화면 쪽 값이 안 바뀐다',
      cloth.patterns[0]?.transform2d?.[0] === 2,
      `${cloth.patterns[0]?.transform2d?.[0]} (원본은 ${src[0]} 로 바꿨다)`,
    );
    cloth.clear();
  }

  // ── ② 없으면 null. 그리고 남지 않는다 ───────────────────────
  //
  // 항등행렬로 메우면 "원점에 배치된 패턴" 과 "배치를 모르는 패턴" 이 구분되지
  // 않는다 — 2D 뷰가 배치를 못 받은 채로 **정상인 척** 그리게 된다.
  {
    const cloth = new ClothObject();
    cloth.setTopology([pattern2d('n', [0, 0, 1, 1])]);
    check(
      '★★ transform2d 가 없으면 null 이다 (항등행렬로 메우지 않는다)',
      cloth.patterns[0]?.transform2d === null,
      JSON.stringify(cloth.patterns[0]?.transform2d),
    );

    // 배치가 있는 씬 → 없는 씬 (재연결·다른 씬·구버전 워커)
    cloth.setTopology([pattern2d('n', [0, 0, 1, 1], [5, 0, 50, 0, 5, 60, 0, 0, 1])]);
    cloth.setTopology([pattern2d('n', [0, 0, 1, 1])]);
    check(
      '★ 옛 씬의 배치가 새 씬에 남지 않는다 (setTopology 는 통째로 새로 만든다)',
      cloth.patterns[0]?.transform2d === null,
      JSON.stringify(cloth.patterns[0]?.transform2d),
    );
    cloth.clear();
  }

  // ── ③ 2D 가 3D 로 새지 않는다 ───────────────────────────────
  //
  // 이 둘을 한 번이라도 같은 자리에 넣으면 ISSUE-011 을 그대로 다시 겪는다.
  {
    const cloth = new ClothObject();
    // 2D 배치만 있고 3D 변환은 없다 — 워커가 서피스는 아는데 3D 는 아직 없는 모양.
    cloth.setTopology([pattern2d('x', [0, 0, 1, 1], [1, 0, 111, 0, 1, 222, 0, 0, 1])]);
    const p = cloth.patterns[0];
    check(
      '★★★ 2D 행렬이 mesh 에 걸리지 않는다 — 3D 변환이 없으면 identity 그대로다',
      p !== undefined && p.mesh.position.length() === 0
      && p.mesh.scale.x === 1 && p.mesh.quaternion.w === 1,
      p ? `pos ${p.mesh.position.toArray().join(',')} scale ${p.mesh.scale.toArray().join(',')}` : '패턴 없음',
    );

    // 둘 다 있을 때 서로를 덮어쓰지 않는다.
    cloth.setTopology([pattern2d(
      'x', [0, 0, 1, 1],
      [1, 0, 111, 0, 1, 222, 0, 0, 1],
      { translation: [7, 8, 9], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    )]);
    const q = cloth.patterns[0];
    check(
      '★★ 둘 다 있으면 각자 제자리에 간다 (3D 는 mesh, 2D 는 필드)',
      q !== undefined && q.mesh.position.x === 7 && q.mesh.position.y === 8
      && q.transform2d?.[2] === 111 && q.transform2d[5] === 222,
      q ? `mesh ${q.mesh.position.toArray().join(',')} / 2D [${q.transform2d?.join(',')}]` : '패턴 없음',
    );
    cloth.clear();
  }

  // ── ④ 프레임 갱신이 배치를 지우지 않는다 ─────────────────────
  //
  // 프레임 이벤트에는 `transform2d` 가 안 온다. `updatePositions()` 가 그때
  // 필드를 건드리면 **2D 뷰가 첫 프레임 뒤에 통째로 원점으로 무너진다.**
  {
    const cloth = new ClothObject();
    cloth.setTopology([pattern2d('f', [0, 0, 1, 1], [1, 0, 30, 0, 1, 40, 0, 0, 1])]);
    const frame: DecodedPattern = {
      uuid: 'f',
      positions: Float32Array.from([1, 1, 1, 2, 2, 2]),
      vertices: 2,
      triangles: 0,
    };
    let ok = cloth.updatePositions([frame]);
    for (let i = 0; i < 50; i++) ok = cloth.updatePositions([frame]) && ok;
    check(
      '★★ transform2d 없는 프레임을 50번 먹여도 배치가 남는다',
      ok && cloth.patterns[0]?.transform2d?.join(',') === '1,0,30,0,1,40,0,0,1',
      JSON.stringify(cloth.patterns[0]?.transform2d),
    );
    check(
      '★ 그 사이 정점은 실제로 갈렸다 (아무 일도 안 일어난 것과 구분한다)',
      (cloth.patterns[0]?.position.array as Float32Array)[0] === 1,
      String((cloth.patterns[0]?.position.array as Float32Array)[0]),
    );
    cloth.clear();
  }

  // ── ⑤ 열벡터 규약 — #15-b 가 쓸 식을 여기서 못박는다 ─────────
  //
  // ★ 회전이 있는 행렬을 쓴다. 회전이 없으면 전치해도 **같은 답이 나와서**
  //   어느 규약인지 구분할 수 없다 (sample.zls 가 정확히 그 씬이라, 이 규약을
  //   실제 값으로 가르는 일은 backend 스모크 §5.8 이 회전 있는 씬에서 맡는다).
  {
    // 90° 회전 + (100, 200) 이동. GetMatrix33 의 모양 그대로:
    //   [ cos, −sin, tx ]   [ 0, −1, 100 ]
    //   [ sin,  cos, ty ] = [ 1,  0, 200 ]
    const m = [0, -1, 100, 1, 0, 200, 0, 0, 1];
    const [wx, wy] = apply2d(m, 3, 0);
    check(
      '★★★ 열벡터 규약: wx = m0·x + m1·y + m2 — 로컬 (3,0) 이 도면 (100, 203) 으로 간다',
      Math.abs(wx - 100) < 1e-9 && Math.abs(wy - 203) < 1e-9,
      `(${wx}, ${wy})`,
    );
    const t = [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
    const [tx, ty] = apply2d(t, 3, 0);
    check(
      '★★★ 같은 점을 전치본으로 옮기면 확실히 다른 자리다 (그래서 규약을 못박을 값어치가 있다)',
      Math.abs(tx - wx) > 1 || Math.abs(ty - wy) > 1,
      `원본 (${wx}, ${wy}) vs 전치 (${tx}, ${ty})`,
    );
    check(
      '★ 마지막 행 [0,0,1] 은 계산에 안 쓰인다 (2×3 만 있으면 되지만 3×3 으로 받는다)',
      apply2d([...m.slice(0, 6), 9, 9, 9], 3, 0).join(',') === `${wx},${wy}`,
    );

    // 그리고 그 식이 실제로 겹침을 푼다 — 같은 uv 를 든 두 패턴이 갈라진다.
    const uv = [0, 0, 10, 0, 10, 20, 0, 20];
    const cloth = new ClothObject();
    cloth.setTopology([
      pattern2d('p1', uv, [1, 0, 0, 0, 1, 0, 0, 0, 1]),
      pattern2d('p2', uv, [1, 0, 40, 0, 1, 0, 0, 0, 1]),
    ]);
    const boxOf = (i: number): { x0: number; x1: number } => {
      const p = cloth.patterns[i]!;
      let x0 = Infinity; let x1 = -Infinity;
      for (let k = 0; k + 1 < (p.uvs?.length ?? 0); k += 2) {
        const [x] = apply2d(p.transform2d!, p.uvs![k]!, p.uvs![k + 1]!);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      }
      return { x0, x1 };
    };
    const a = boxOf(0);
    const b = boxOf(1);
    check(
      '★★ 같은 uv 를 든 두 패턴이 배치를 곱하면 갈라진다 (uvs 만 쓰면 완전히 포개진다)',
      a.x1 <= b.x0,
      `p1 x [${a.x0}, ${a.x1}] / p2 x [${b.x0}, ${b.x1}] — 배치 없이는 둘 다 [0, 10]`,
    );
    cloth.clear();
  }
}

// ─────────────────────────────────────────────────────────────
// §8-13. 패턴 재질이 3D 뷰까지 실려 온다 (materials-a, cloth.ts, DOM 없이)
//
// ★ 이번 단위의 계약은 **"들고만 있는다"** 이다. 색을 실제로 칠하는 것은
//   materials-b 이고, 지금 `mesh.material.color` 는 여전히 임의 팔레트다.
//   그래서 이 절이 못박는 것은 두 방향이다:
//
//   ① 워커가 실은 값이 **손실 없이** 여기까지 온다 (materials-b 가 읽을 자리)
//   ② 그런데 아직 **화면에 새지 않았다** — 지금 화면이 바뀌면 그건 이 단위의
//      범위 밖이고, `verify/ui.ts` 의 `LIVE_PALETTE_BUCKETS`(팔레트 색상 칸에
//      없는 색이면 스냅샷에서 온 것이라는 배제 논증)가 조용히 깨진다.
//
// ⚠️ 그리고 **팔레트는 살아남아야 한다.** `sample.zls` 는 다섯 패턴이 진짜로
//    전부 흰색이라, 진짜 색만 칠하면 옷이 흰 덩어리 하나가 되어 패턴 경계가
//    안 보인다. 폴백이 없으면 #12 의 눈 판정이 통째로 불가능해진다.
// ─────────────────────────────────────────────────────────────

/** 재질을 든 패턴 하나. 값은 `W_Bra top & Leggings.zls` 의 실측 노랑이다 */
function patternMat(uuid: string, material?: Partial<PatternMaterial> | null): DecodedPattern {
  const p: DecodedPattern = {
    uuid,
    positions: Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]),
    vertices: 3,
    triangles: 0,
  };
  // 인자를 생략하면 기본 재질, **null 을 넘기면 재질 없음**. 두 경우를 다
  // 써야 해서 `undefined` 와 `null` 이 서로 다른 뜻이다.
  if (material !== null) {
    p.material = {
      fabricUuid: '356924893322900/1500000',
      color: [0.9254902, 0.8117647, 0.4705882],
      colorProfile: 'srgb',
      opacity: 1,
      roughness: 1,
      metalness: 0,
      ...material,
    } as PatternMaterial;
  }
  return p;
}

function sectionClothMaterial(): void {
  section('§8-13. 패턴 재질 (materials-a, cloth.ts, DOM 없이)');

  // ── ① 실려 오고, 우리 것이 된다 ─────────────────────────────
  {
    const decoded = patternMat('a');
    const cloth = new ClothObject();
    cloth.setTopology([decoded]);
    const p = cloth.patterns[0];
    check(
      '★ PatternMesh 가 material 을 든다 (materials-b 가 여기서 읽는다)',
      p?.material?.color.join(',') === '0.9254902,0.8117647,0.4705882'
      && p.material.fabricUuid === '356924893322900/1500000'
      && p.material.colorProfile === 'srgb'
      && p.material.roughness === 1 && p.material.metalness === 0 && p.material.opacity === 1,
      JSON.stringify(p?.material),
    );

    // ⚠️ 디코더가 준 **그 객체**를 건드려야 한다. 사본을 넘겨 놓고 통과했다고
    //    믿으면 얕은 복사(색 배열은 공유)를 놓친다 — §8-12 에서 실제로 겪었다.
    decoded.material!.color[0] = 999;
    decoded.material!.fabricUuid = '바뀜';
    check(
      '★★ 깊은 복사다 — 디코더가 준 그 객체의 **색 배열까지** 나중에 건드려도 화면 쪽이 안 바뀐다',
      cloth.patterns[0]?.material?.color[0] === 0.9254902
      && cloth.patterns[0].material.fabricUuid === '356924893322900/1500000',
      `${cloth.patterns[0]?.material?.color[0]} / ${cloth.patterns[0]?.material?.fabricUuid} (원본은 ${decoded.material!.color[0]} 로 바꿨다)`,
    );
    cloth.clear();
  }

  // ── ② 없으면 null. 그리고 남지 않는다 ───────────────────────
  //
  // 흰색으로 메우면 "진짜 흰 옷"과 "색을 모름"이 구분되지 않고, 폴백할 기회가
  // 사라진다. sample.zls 가 실제로 흰옷 씬이라 이 구분이 화면에서 바로 문제다.
  {
    const cloth = new ClothObject();
    cloth.setTopology([patternMat('n', null)]);
    check(
      '★★ material 이 없으면 null 이다 (흰색 [1,1,1] 로 메우지 않는다)',
      cloth.patterns[0]?.material === null,
      JSON.stringify(cloth.patterns[0]?.material),
    );

    // 재질이 있는 씬 → 없는 씬 (재연결·다른 씬·구버전 워커)
    cloth.setTopology([patternMat('n')]);
    cloth.setTopology([patternMat('n', null)]);
    check(
      '★ 옛 씬의 재질이 새 씬에 남지 않는다 (setTopology 는 통째로 새로 만든다)',
      cloth.patterns[0]?.material === null,
      JSON.stringify(cloth.patterns[0]?.material),
    );
    cloth.clear();
  }

  // ── ③ 아직 화면에 안 걸린다 (이번 단위의 경계) ───────────────
  //
  // ★★★ 이 절에서 가장 중요한 자리다. 여기가 통과해야 "materials-a 는 워커
  //      쪽만 고쳤다"가 참이고, `verify/ui.ts` 의 팔레트 배제 논증이 아직
  //      성립한다. materials-b 가 배선하는 순간 이 단언이 **의도적으로**
  //      빨간불이 되고, 그때 `LIVE_PALETTE_BUCKETS` 도 같이 고쳐야 한다.
  {
    const cloth = new ClothObject();
    cloth.setTopology([patternMat('x')]);
    const p = cloth.patterns[0];
    const mm = p?.mesh.material as THREE.MeshStandardMaterial | undefined;
    check(
      '★★★ 진짜 색이 mesh 에 아직 안 걸린다 — 첫 패턴은 여전히 팔레트 0번(0x7ea8d8)이다 (배선은 materials-b)',
      mm?.color.getHex() === 0x7ea8d8,
      `mesh 색 #${mm?.color.getHex().toString(16)} / 실린 재질 [${p?.material?.color.join(',')}]`,
    );
    check(
      '★★ roughness·metalness 도 mesh 로 안 샌다 (씬은 1.0 인데 뷰는 여전히 0.78 이다)',
      mm?.roughness === 0.78 && mm.metalness === 0,
      `mesh r${mm?.roughness}/m${mm?.metalness} vs 재질 r${p?.material?.roughness}/m${p?.material?.metalness}`,
    );
    cloth.clear();
  }

  // ── ④ 팔레트가 살아 있다 (회귀) ──────────────────────────────
  //
  // ⚠️ 이 다섯 색이 곧 #12 의 검증 도구다. `sample.zls` 가 전부 흰색이라
  //    폴백이 없으면 옷이 흰 덩어리가 되고, "제대로 그려진 것"과 "패턴 하나가
  //    통째로 뒤집힌 것"을 사람이 구분할 수 없게 된다.
  {
    const cloth = new ClothObject();
    // 6개를 넣어 **되감기는지**까지 본다 — 5개만 보면 배열을 잘라도 안 걸린다.
    cloth.setTopology([0, 1, 2, 3, 4, 5].map((i) => patternMat(`p${i}`)));
    const hexes = cloth.patterns.map(
      (p) => (p.mesh.material as THREE.MeshStandardMaterial).color.getHex(),
    );
    check(
      '★★★ 임의 5색 팔레트가 그대로다 — 6번째가 0번으로 되감긴다 (진짜 색이 실려 있어도 화면은 팔레트다)',
      hexes.join(',') === [0x7ea8d8, 0xd8a87e, 0x8fc9a0, 0xc98f9e, 0xb0a8d8, 0x7ea8d8].join(','),
      hexes.map((h) => `#${h.toString(16)}`).join(' '),
    );
    check(
      '★★ 다섯 색이 서로 다르다 (한 색으로 뭉개지면 패턴 경계가 안 보여 눈 판정이 불가능해진다)',
      new Set(hexes.slice(0, 5)).size === 5,
      `${new Set(hexes.slice(0, 5)).size}종`,
    );
    // 재질이 **없는** 패턴도 같은 팔레트를 받는다. materials-b 가 폴백을 쓸 때
    // 색이 갑자기 달라지면 안 되므로, 지금 기준선을 못박아 둔다.
    const bare = new ClothObject();
    bare.setTopology([0, 1, 2].map((i) => patternMat(`q${i}`, null)));
    check(
      '★ 재질 없는 패턴도 같은 팔레트 색을 받는다 (폴백의 기준선)',
      bare.patterns.map((p) => (p.mesh.material as THREE.MeshStandardMaterial).color.getHex())
        .join(',') === [0x7ea8d8, 0xd8a87e, 0x8fc9a0].join(','),
      bare.patterns.map((p) => `#${(p.mesh.material as THREE.MeshStandardMaterial).color.getHex().toString(16)}`).join(' '),
    );
    cloth.clear();
    bare.clear();
  }

  // ── ⑤ 세 필드가 서로의 자리를 안 밟는다 ──────────────────────
  //
  // `transform`(3D) · `transform2d`(2D 배치) · `material` 이 같은 객체에
  // 앉았다. 한 번이라도 섞이면 ISSUE-011 을 그대로 다시 겪는다.
  {
    const p = patternMat('m');
    p.transform = { translation: [7, 8, 9], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    p.transform2d = [1, 0, 111, 0, 1, 222, 0, 0, 1] as unknown as PatternTransform2D;
    const cloth = new ClothObject();
    cloth.setTopology([p]);
    const q = cloth.patterns[0];
    check(
      '★★★ 셋이 각자 제자리에 간다 (3D 는 mesh, 2D 는 transform2d, 재질은 material)',
      q !== undefined
      && q.mesh.position.x === 7 && q.mesh.position.y === 8
      && q.transform2d?.[2] === 111 && q.transform2d[5] === 222
      && q.material?.color.join(',') === '0.9254902,0.8117647,0.4705882',
      q ? `mesh ${q.mesh.position.toArray().join(',')} / 2D [${q.transform2d?.slice(0, 3).join(',')}…] / 색 [${q.material?.color.join(',')}]` : '패턴 없음',
    );
    check(
      '★★ 색이 2D 행렬 자리로도, 3D 위치로도 안 샌다',
      q !== undefined
      && q.transform2d?.slice(0, 3).join(',') !== q.material?.color.join(',')
      && q.mesh.position.toArray().join(',') !== q.material?.color.join(','),
    );
    cloth.clear();
  }

  // ── ⑥ 프레임 갱신이 재질을 지우지 않는다 ─────────────────────
  //
  // 프레임 이벤트에는 `material` 이 안 온다. `updatePositions()` 가 그때 필드를
  // 건드리면 **첫 프레임 뒤에 색이 통째로 사라진다** — materials-b 가 배선한
  // 다음에는 "재생을 누르면 옷이 회색이 된다"로 나타난다.
  {
    const cloth = new ClothObject();
    cloth.setTopology([patternMat('f')]);
    const frame: DecodedPattern = {
      uuid: 'f',
      positions: Float32Array.from([9, 9, 9, 8, 8, 8, 7, 7, 7]),
      vertices: 3,
      triangles: 0,
    };
    let ok = cloth.updatePositions([frame]);
    for (let i = 0; i < 50; i++) ok = cloth.updatePositions([frame]) && ok;
    check(
      '★★ material 없는 프레임을 50번 먹여도 재질이 남는다',
      ok && cloth.patterns[0]?.material?.color.join(',') === '0.9254902,0.8117647,0.4705882',
      JSON.stringify(cloth.patterns[0]?.material?.color),
    );
    check(
      '★ 그 사이 정점은 실제로 갈렸다 (아무 일도 안 일어난 것과 구분한다)',
      (cloth.patterns[0]?.position.array as Float32Array)[0] === 9,
      String((cloth.patterns[0]?.position.array as Float32Array)[0]),
    );
    cloth.clear();
  }
}

// ─────────────────────────────────────────────────────────────
// §12. 2D 펼침 — 모핑과 판정 (#15-b, viewer2d/, DOM 없이)
//
// **#15 의 통과 기준 중 "좌표 변환 자동 검증" 의 나머지 절반이다.** 15-a 는
// 워커가 실은 행렬이 옳은가를 씬 파일의 정답지로 갈랐다. 여기서 보는 것은
// **그 행렬로 만든 도면이 옳은가** — 그리고 그건 화면으로는 대부분 못 본다:
//
//   - 도면이 평평한가        → 옆에서 보지 않으면 안 보인다. 게다가 경계 상자로
//                              재면 **거짓말한다**(아래 ② 참고)
//   - 3D 변환을 되돌렸는가   → 안 되돌리면 도면이 통째로 옮겨질 뿐이라, 카메라가
//                              그 자리를 비추면 멀쩡해 보인다
//   - y 가 뒤집혔는가        → 실루엣이 대칭이라 눈으로는 절대 못 잡는다
//   - 재생 중 눌어붙는가     → 몇 초에 걸쳐 서서히 일어나 "원래 이런가" 로 보인다
//
// `viewer2d/` 의 두 모듈은 DOM 을 안 만지므로(three 자료구조만 쓴다) 여기서
// 전부 돈다. 화면 쪽(투영 보간·카메라·격자)은 `verify/ui.ts` §12 가 맡는다.
// ─────────────────────────────────────────────────────────────

/** 3D 로컬 정점 + uv + 2D 배치를 함께 든 패턴. 정점 수는 3의 배수로 준다 */
function unfoldPattern(
  uuid: string,
  opts: {
    positions: readonly number[];
    uvs?: readonly number[] | null;
    transform2d?: readonly number[] | null;
    transform?: PatternTransform;
  },
): DecodedPattern {
  const vertices = opts.positions.length / 3;
  const p: DecodedPattern = {
    uuid,
    positions: Float32Array.from(opts.positions),
    vertices,
    triangles: 0,
  };
  if (opts.uvs) p.uvs = Float32Array.from(opts.uvs);
  if (opts.transform2d) p.transform2d = [...opts.transform2d] as unknown as PatternTransform2D;
  if (opts.transform) p.transform = opts.transform;
  return p;
}

/**
 * 도면 좌표의 **독립적인** 기댓값. 행 우선 · 열벡터 규약을 손으로 적는다.
 *
 * ⚠️ 여기서 제품의 `apply2d` 를 부르면 안 된다. **그것을 전치해도 양쪽이 함께
 *    틀려서 단언이 통과해버린다** — 실제로 처음에는 제품 함수를 썼고, `apply2d`
 *    를 전치하는 돌연변이를 §12 가 통째로 놓쳤다(§8-12 ⑤ 만 잡았다). 기댓값은
 *    검사 대상과 다른 손에서 나와야 한다.
 *
 * 제품 함수 자체를 못박는 일은 §8-12 ⑤ 가 한다(90° 회전에서 (3,0) → (100,203)).
 * 그쪽은 **숫자가 하드코딩**이라 같은 함정에 빠지지 않는다.
 */
function expect2d(m: readonly number[], x: number, y: number): [number, number] {
  return [
    (m[0] ?? 0) * x + (m[1] ?? 0) * y + (m[2] ?? 0),
    (m[3] ?? 0) * x + (m[4] ?? 0) * y + (m[5] ?? 0),
  ];
}

/** 정점 하나를 그 패턴의 **3D 월드**로 옮긴다 (Mesh 에 걸린 변환을 태운다) */
function vertexWorld(cloth: ClothObject, uuid: string, i: number): THREE.Vector3 {
  const p = cloth.patterns.find((m) => m.uuid === uuid);
  if (!p) return new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
  const a = p.position.array as Float32Array;
  return new THREE.Vector3(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]).applyMatrix4(p.mesh.matrix);
}

/** 패턴 전체 정점의 월드 z 범위. **점으로 잰다** — 경계 상자는 아래 ② 참고 */
function worldZSpan(cloth: ClothObject): { min: number; max: number; span: number } {
  let min = Infinity;
  let max = -Infinity;
  const v = new THREE.Vector3();
  for (const p of cloth.patterns) {
    const a = p.position.array as Float32Array;
    for (let i = 0; i + 2 < a.length; i += 3) {
      v.set(a[i] ?? 0, a[i + 1] ?? 0, a[i + 2] ?? 0).applyMatrix4(p.mesh.matrix);
      if (v.z < min) min = v.z;
      if (v.z > max) max = v.z;
    }
  }
  return { min, max, span: max - min };
}

/** 정점 버퍼 전체의 사본. 비트 단위로 비교할 때 쓴다 */
function snapshotVertices(cloth: ClothObject): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  for (const p of cloth.patterns) out.set(p.uuid, new Float32Array(p.position.array as Float32Array));
  return out;
}

function sameVertices(cloth: ClothObject, snap: Map<string, Float32Array>): boolean {
  for (const p of cloth.patterns) {
    const was = snap.get(p.uuid);
    const now = p.position.array as Float32Array;
    if (!was || was.length !== now.length) return false;
    for (let i = 0; i < now.length; i++) if (now[i] !== was[i]) return false;
  }
  return true;
}

/**
 * 이 절 전체가 쓰는 표본 하나.
 *
 * ★ **3D 변환이 항등이 아니어야 한다.** 항등이면 `M3d⁻¹` 를 곱하든 말든 결과가
 *   같아서, "되돌렸는가" 를 묻는 단언이 통째로 이빨을 잃는다.
 *
 * ⚠️ **그런데 회전축이 Z 이면 안 된다.** 도면은 월드 z=0 평면이고 Z축 회전은 그
 *    평면을 자기 자신으로 보내므로, 되돌린 로컬 좌표도 z=0 에 남는다 — 그러면
 *    아래 ② 의 "경계 상자가 부푼다" 가 재현되지 않는다(처음에 Z축 90° 로 썼다가
 *    상자 z 두께가 0.00 으로 나와 그 절이 빨간불이 됐다). X축으로 기울여야
 *    로컬 평면이 비스듬해지고 그 AABB 가 두꺼워진다 — **실제 씬이 그 상태다.**
 *
 * ★ **2D 배치도 회전이 있어야 한다.** 회전이 없으면 `apply2d` 를 전치해도 값이
 *   같다(15-a 에서 sample.zls 가 정확히 그 씬이었다).
 */
const A50 = (50 * Math.PI) / 180;
/** X축 50° + 이동. 되돌리지 않으면 확실히 다른 자리로 간다 */
const T3D: PatternTransform = {
  translation: [30, 40, 50],
  rotation: [Math.sin(A50 / 2), 0, 0, Math.cos(A50 / 2)],
  scale: [1, 1, 1],
};
/** 2D 배치: 30° 회전 + (100, 200) 이동. 전치하면 다른 그림이 된다 */
const A30 = Math.PI / 6;
const T2D: readonly number[] = [
  Math.cos(A30), -Math.sin(A30), 100,
  Math.sin(A30), Math.cos(A30), 200,
  0, 0, 1,
];
/** 삼각형 두 장. x·y 에 대칭이 아니라 방향을 읽을 수 있다 */
const UV6: readonly number[] = [0, 0, 12, 0, 12, 7, 0, 0, 12, 7, 3, 7];
const POS6: readonly number[] = [
  0, 0, 0, 12, 0, 2, 12, 7, -3,
  0, 0, 0, 12, 7, -3, 3, 7, 1,
];

function buildSample(): { cloth: ClothObject; unf: Unfolder } {
  const cloth = new ClothObject();
  cloth.setTopology([
    unfoldPattern('a', { positions: POS6, uvs: UV6, transform2d: T2D, transform: T3D }),
  ]);
  const unf = new Unfolder();
  unf.build(cloth.patterns);
  return { cloth, unf };
}

function sectionUnfold(): void {
  section('§12. 2D 펼침 — 모핑 (#15-b, viewer2d/unfold.ts)');

  // ── ① 도면 좌표가 옳다 + 3D 변환을 되돌렸다 ─────────────────
  //
  // ★★ 이 절에서 가장 값진 단언이다. `t=1` 의 정점 버퍼는 **메시 로컬**이므로,
  //    거기에 `Mesh` 의 변환을 도로 곱하면 `apply2d(transform2d, uv)` 가 나와야
  //    한다. 이 한 줄이 셋을 동시에 본다:
  //      - `apply2d` 를 열벡터 규약으로 썼는가 (전치하면 어긋난다)
  //      - `M3d⁻¹` 를 곱했는가 (안 곱하면 3D 변환이 두 번 걸린다)
  //      - 도면을 z=0 평면에 놓았는가
  {
    const { cloth, unf } = buildSample();
    check(
      '★ 배치가 있는 패턴이 도면에 놓인다',
      unf.ready && unf.stats.placed === 1 && unf.stats.unplaced === 0
      && unf.stats.vertices === 6,
      JSON.stringify({ ...unf.stats, bounds: undefined }),
    );

    const touched = unf.apply(cloth.patterns, 1);
    check('★ apply(1) 이 버퍼를 실제로 건드린다', touched);

    let worst = 0;
    let worstZ = 0;
    for (let i = 0; i < 6; i++) {
      const [wx, wy] = expect2d(T2D, UV6[i * 2] ?? 0, UV6[i * 2 + 1] ?? 0);
      const got = vertexWorld(cloth, 'a', i);
      worst = Math.max(worst, Math.hypot(got.x - wx, got.y - wy));
      worstZ = Math.max(worstZ, Math.abs(got.z));
    }
    check(
      '★★★ t=1 의 정점을 3D 변환으로 되돌리면 정확히 M · [u, v, 1]ᵀ 다'
      + ' (기댓값은 제품의 apply2d 가 아니라 손으로 적은 식이다 — 전치·M3d⁻¹ 누락을 여기서 가른다)',
      worst < 1e-3,
      `최대 어긋남 ${worst.toExponential(2)}cm`,
    );
    check(
      '★★ 그리고 z = 0 이다 — 도면은 월드 XY 평면 위에 있다',
      worstZ < 1e-3,
      `최대 |z| ${worstZ.toExponential(2)}cm`,
    );

    // 대조군 — 되돌리지 않았다면 어디로 갔을까. 이 거리가 크지 않으면 위
    // 단언에 이빨이 없다는 뜻이다(3D 변환이 항등에 가까운 표본을 골랐다).
    const naive = new THREE.Vector3(
      ...(() => {
        const [wx, wy] = expect2d(T2D, UV6[0] ?? 0, UV6[1] ?? 0);
        return [wx, wy, 0] as [number, number, number];
      })(),
    ).applyMatrix4(cloth.patterns[0]!.mesh.matrix);
    const [ax, ay] = expect2d(T2D, UV6[0] ?? 0, UV6[1] ?? 0);
    check(
      '★★ 대조군 — M3d⁻¹ 를 안 곱했다면 도면이 확연히 다른 자리로 간다 (위 단언에 이빨이 있다는 증거)',
      Math.hypot(naive.x - ax, naive.y - ay, naive.z) > 10,
      `되돌리지 않은 자리 ${xyz(naive)} vs 도면 (${ax.toFixed(2)}, ${ay.toFixed(2)}, 0)`,
    );

    // bounds 가 실제 도면 범위와 같은가 — 카메라 화각이 여기 걸려 있다.
    const b = unf.stats.bounds;
    let bMinX = Infinity; let bMaxX = -Infinity; let bMinY = Infinity; let bMaxY = -Infinity;
    for (let i = 0; i < 6; i++) {
      const [wx, wy] = expect2d(T2D, UV6[i * 2] ?? 0, UV6[i * 2 + 1] ?? 0);
      bMinX = Math.min(bMinX, wx); bMaxX = Math.max(bMaxX, wx);
      bMinY = Math.min(bMinY, wy); bMaxY = Math.max(bMaxY, wy);
    }
    check(
      '★ stats.bounds 가 실제 도면 범위와 같다 (카메라 화각이 이 값에 걸려 있다)',
      b !== null
      && Math.abs(b.minX - bMinX) < 1e-3 && Math.abs(b.maxX - bMaxX) < 1e-3
      && Math.abs(b.minY - bMinY) < 1e-3 && Math.abs(b.maxY - bMaxY) < 1e-3
      && Math.abs(b.width - (bMaxX - bMinX)) < 1e-3
      && Math.abs(b.centerY - (bMinY + bMaxY) / 2) < 1e-3,
      b ? `${b.minX.toFixed(2)}~${b.maxX.toFixed(2)} × ${b.minY.toFixed(2)}~${b.maxY.toFixed(2)}` : 'null',
    );
    cloth.clear();
  }

  // ── ② 평평한가는 **점으로** 잰다 (경계 상자가 거짓말한다) ────
  //
  // ★ `cloth.boundingBox()` 는 패턴마다 **로컬 AABB 의 모서리 8개를** 변환해
  //   합친다. 도면은 로컬 좌표계에서 기울어진 평면이라 그 상자는 부푼다 —
  //   Builder 실측으로 t=1 에서 z 범위가 [−12, +10.4] 로 나왔다. 평면인데도
  //   그렇다. **ISSUE-011 의 교훈이 여기서 또 나왔다**: 상자로 재면 통과도
  //   실패도 엉터리다. 아래 두 줄이 그 사실 자체를 못박는다.
  {
    const { cloth, unf } = buildSample();
    const before = worldZSpan(cloth);
    unf.apply(cloth.patterns, 1);
    const after = worldZSpan(cloth);
    const box = cloth.boundingBox();

    check(
      '★★★ t=1 에서 **모든 정점**의 월드 z 가 0 이다 (도면이 진짜로 평평하다)',
      after.span < 1e-3 && Math.abs(after.min) < 1e-3,
      `z ${after.min.toExponential(2)} ~ ${after.max.toExponential(2)} (t=0 일 때는 ${before.span.toFixed(2)}cm 두께였다)`,
    );
    check(
      '★ 대조군 — t=0 의 옷은 확실히 입체였다 (평평해진 것이 원래부터 평평했던 것이 아니다)',
      before.span > 1,
      `${before.span.toFixed(2)}cm`,
    );
    check(
      '★★ 같은 상태에서 **경계 상자는 평평하지 않다고 말한다** — 상자로 재면 안 된다는 증거',
      box.max.z - box.min.z > after.span * 100 + 1,
      `상자 z ${(box.max.z - box.min.z).toFixed(2)}cm vs 점 z ${after.span.toExponential(2)}cm`,
    );
    note(
      '왜 부푸는가',
      '패턴마다 로컬 AABB 의 모서리 8개를 변환해 합치기 때문이다. 기울어진 평면의 AABB 는 두껍다',
    );
    cloth.clear();
  }

  // ── ③ 보간과 헛일 안 하기 ───────────────────────────────────
  {
    const { cloth, unf } = buildSample();
    const origin = snapshotVertices(cloth);

    check(
      '★★ t=0 은 아무 일도 하지 않는다 (2D 를 안 쓰는 동안 이 단위의 비용이 0 이라는 계약)',
      unf.apply(cloth.patterns, 0) === false && sameVertices(cloth, origin),
    );

    unf.apply(cloth.patterns, 1);
    const at1 = snapshotVertices(cloth);
    check(
      '★ 같은 t 를 다시 주면 다시 쓰지 않는다',
      unf.apply(cloth.patterns, 1) === false,
    );

    unf.apply(cloth.patterns, 0.5);
    const half = cloth.patterns[0]!.position.array as Float32Array;
    const o = origin.get('a')!;
    const one = at1.get('a')!;
    let worst = 0;
    for (let i = 0; i < half.length; i++) {
      worst = Math.max(worst, Math.abs((half[i] ?? 0) - ((o[i] ?? 0) + (one[i] ?? 0)) / 2));
    }
    check(
      '★★ t=0.5 는 3D 원본과 도면의 정확한 중점이다 (선형 보간)',
      worst < 1e-4,
      `최대 어긋남 ${worst.toExponential(2)}`,
    );

    check(
      '★★ t 를 0 으로 되돌리면 3D 원본이 **비트 단위로** 돌아온다 (모핑이 원본을 갉아먹지 않는다)',
      unf.apply(cloth.patterns, 1) && unf.apply(cloth.patterns, 0) && sameVertices(cloth, origin),
    );
    check(
      '★ 범위 밖 t 는 잘라 넣는다 (t=5 는 t=1, t=−3 은 t=0)',
      (() => {
        unf.apply(cloth.patterns, 5);
        const clampedHigh = sameVertices(cloth, at1);
        unf.apply(cloth.patterns, -3);
        return clampedHigh && sameVertices(cloth, origin);
      })(),
    );

    // GPU 로 올라가는가. 이게 없으면 배열만 바뀌고 화면은 그대로다.
    const v0 = cloth.patterns[0]!.position.version;
    unf.apply(cloth.patterns, 1);
    check(
      '★★ position.version 이 오른다 (three 가 GPU 로 올리는 근거 — 없으면 배열만 바뀌고 화면은 멎는다)',
      cloth.patterns[0]!.position.version > v0,
      `${v0} → ${cloth.patterns[0]!.position.version}`,
    );
    check(
      '★ 경계구를 다시 만든다 (프러스텀 컬링에 잘려 사라지지 않는다)',
      (cloth.patterns[0]!.geometry.boundingSphere?.radius ?? 0) > 0,
      String(cloth.patterns[0]!.geometry.boundingSphere?.radius?.toFixed(2)),
    );
    cloth.clear();
  }

  // ── ④ 배치를 모르는 패턴 — **실측으로는 못 태운 갈래다** ─────
  //
  // 두 실측 씬 모두 `unplaced = 0` 이라(24/24, 5/5 배치됨) 실제 워커로는 이
  // 경로를 한 번도 지나간 적이 없다. 여기가 유일한 검증이다.
  //
  // 정해진 동작: 항등행렬로 **메우지 않고**, 숨기지도 않고, **모핑에서 뺀다.**
  // t=1 에서 평평한 도면 옆에 그 패턴만 3D 로 떠 있어 눈에 띈다.
  {
    const cloth = new ClothObject();
    cloth.setTopology([
      unfoldPattern('placed', { positions: POS6, uvs: UV6, transform2d: T2D, transform: T3D }),
      // 서피스가 없는 패턴 — 워커가 `transform2d` 키를 아예 안 싣는다
      unfoldPattern('no2d', { positions: POS6, uvs: UV6, transform: T3D }),
      // uv 가 없는 패턴 (topology 없이 온 경우)
      unfoldPattern('nouv', { positions: POS6, transform2d: T2D, transform: T3D }),
      // uv 길이가 어긋난 패턴 — 조용히 잘라 쓰면 정점 몇 개가 원점에 붙는다
      unfoldPattern('baduv', { positions: POS6, uvs: [0, 0, 1, 1], transform2d: T2D, transform: T3D }),
    ]);
    const unf = new Unfolder();
    unf.build(cloth.patterns);

    check(
      '★★ 배치를 모르는 패턴은 stats 에 unplaced 로 남는다 (조용히 사라지지 않는다)',
      unf.stats.patterns === 4 && unf.stats.placed === 1 && unf.stats.unplaced === 3
      && unf.stats.vertices === 6,
      JSON.stringify({ patterns: unf.stats.patterns, placed: unf.stats.placed, unplaced: unf.stats.unplaced }),
    );

    const before = snapshotVertices(cloth);
    unf.apply(cloth.patterns, 1);

    const moved = cloth.patterns.filter((p) => {
      const was = before.get(p.uuid)!;
      const now = p.position.array as Float32Array;
      for (let i = 0; i < now.length; i++) if (now[i] !== was[i]) return true;
      return false;
    }).map((p) => p.uuid);
    check(
      '★★★ t=1 에서 배치를 모르는 패턴의 정점은 **한 비트도** 안 움직인다 (3D 자리에 그대로 남는다)',
      moved.length === 1 && moved[0] === 'placed',
      `움직인 패턴 [${moved.join(', ')}]`,
    );
    check(
      '★★ 항등행렬로 메우지 않았다 — 그랬다면 도면 원점 근처로 끌려갔을 것이다',
      (() => {
        const p = cloth.patterns.find((x) => x.uuid === 'no2d')!;
        const a = p.position.array as Float32Array;
        const w = new THREE.Vector3(a[0], a[1], a[2]).applyMatrix4(p.mesh.matrix);
        // 항등행렬이었다면 uv(0,0) → 도면 (0,0,0) 으로 갔을 것이다.
        return w.length() > 10;
      })(),
      xyz(vertexWorld(cloth, 'no2d', 0)),
    );
    check(
      '★ 그 패턴들은 여전히 입체다 (숨기지 않는다 — 존재한다는 사실까지 지우면 안 된다)',
      (() => {
        const p = cloth.patterns.find((x) => x.uuid === 'no2d')!;
        let min = Infinity; let max = -Infinity;
        const a = p.position.array as Float32Array;
        for (let i = 0; i + 2 < a.length; i += 3) {
          const z = new THREE.Vector3(a[i], a[i + 1], a[i + 2]).applyMatrix4(p.mesh.matrix).z;
          min = Math.min(min, z); max = Math.max(max, z);
        }
        return max - min > 1;
      })(),
    );
    cloth.clear();
  }

  // 전부 배치가 없는 씬 — 슬라이더가 아예 안 움직여야 한다
  {
    const cloth = new ClothObject();
    cloth.setTopology([
      unfoldPattern('n1', { positions: POS6, uvs: UV6, transform: T3D }),
      unfoldPattern('n2', { positions: POS6, uvs: UV6, transform: T3D }),
    ]);
    const unf = new Unfolder();
    unf.build(cloth.patterns);
    const before = snapshotVertices(cloth);
    check(
      '★★ 배치가 하나도 없으면 ready 가 false 이고 apply 가 아무 일도 안 한다',
      !unf.ready && unf.stats.placed === 0 && unf.stats.bounds === null
      && unf.apply(cloth.patterns, 1) === false && sameVertices(cloth, before),
      JSON.stringify({ ready: unf.ready, placed: unf.stats.placed, bounds: unf.stats.bounds }),
    );
    cloth.clear();
  }

  // ── ⑤ sync 순서 — 재생 중 옷이 눌어붙지 않는가 ──────────────
  //
  // ⚠️ **이 절이 잡는 것은 `Unfolder` 가 아니라 그것을 부르는 순서다.**
  //    `sync` 는 정점 버퍼에 3D 가 들어 있을 때만 불러야 한다. 뒤집히면 섞인
  //    값을 원본으로 착각하고, 그 위에 또 섞으므로 옷이 프레임마다 도면 쪽으로
  //    끌려가다 완전히 눌어붙는다 — 화면에서는 "재생하면 옷이 서서히
  //    납작해진다" 로 보이고 원인이 어디에도 안 남는다.
  //
  //    실제 순서는 `main.ts` 의 rAF 안에 있어 DOM 이 필요하다. 여기서는 두
  //    순서를 **둘 다** 돌려 오염 메커니즘 자체를 못박아 두고, 실제 배선이 어느
  //    쪽인지는 `verify/ui.ts` §12 가 재생 중에 확인한다.
  //
  // ⚠️ **브라우저에서의 증상은 여기서 재현한 것과 다르다** (돌연변이로 확인했다).
  //    실제 rAF 는 시뮬(~10fps)보다 훨씬 자주 돌아서, 프레임이 붙지 않은 rAF 가
  //    사이사이 끼어든다. 그러면 `apply` 의 "같은 t 는 다시 쓰지 않는다" 가드가
  //    시뮬 프레임과 맞물려, 오염이 누적되는 대신 **그 프레임만 3D 원본이 화면에
  //    남는다** — 눌어붙는 대신 **덜덜 떤다**(실측: t=0.5 에서 두께가 12.2 ↔ 24.4
  //    로 매 시뮬 프레임마다 튄다. 올바른 순서면 변동폭 0.86cm).
  //    그래서 `verify/ui.ts` 는 최종 상태가 아니라 **프레임마다 표본을 떠서**
  //    본다. 아래 대조군은 가드가 개입하지 않는 순수한 형태의 오염이다.
  {
    /** 프레임이 온 것처럼 3D 정점을 새로 써 넣는다 (진폭이 있는 흔들림) */
    const feed = (cloth: ClothObject, k: number): void => {
      const a = cloth.patterns[0]!.position.array as Float32Array;
      for (let i = 0; i < POS6.length; i++) {
        a[i] = (POS6[i] ?? 0) + (i % 3 === 2 ? Math.sin(k * 0.7) * 2 : 0);
      }
    };

    // 올바른 순서: 프레임을 쓴다 → sync → apply
    const good = buildSample();
    for (let k = 0; k < 100; k++) {
      feed(good.cloth, k);
      good.unf.sync(good.cloth.patterns);
      good.unf.apply(good.cloth.patterns, 0.5);
    }
    good.unf.apply(good.cloth.patterns, 0);
    const goodSpan = worldZSpan(good.cloth);

    // 뒤집힌 순서: apply → sync (섞인 값을 원본으로 착각한다)
    const bad = buildSample();
    for (let k = 0; k < 100; k++) {
      feed(bad.cloth, k);
      bad.unf.apply(bad.cloth.patterns, 0.5);
      bad.unf.sync(bad.cloth.patterns);
    }
    bad.unf.apply(bad.cloth.patterns, 0);
    const badSpan = worldZSpan(bad.cloth);

    check(
      '★★★ 올바른 순서(sync → apply)로 100프레임을 돌려도 t=0 으로 돌아오면 옷이 여전히 입체다',
      goodSpan.span > 1,
      `z 두께 ${goodSpan.span.toFixed(2)}cm`,
    );
    check(
      '★★★ 대조군 — 순서를 뒤집으면 옷이 도면 쪽으로 눌어붙는다 (t=0 인데 납작하다)',
      badSpan.span < goodSpan.span / 10,
      `뒤집힌 순서 ${badSpan.span.toExponential(2)}cm vs 올바른 순서 ${goodSpan.span.toFixed(2)}cm`,
    );
    good.cloth.clear();
    bad.cloth.clear();
  }

  // ── ⑥ 씬을 갈아 끼운다 ──────────────────────────────────────
  {
    const { cloth, unf } = buildSample();
    unf.apply(cloth.patterns, 1);
    unf.clear();
    check(
      '★ clear 뒤에는 stats 가 비고 apply 가 아무것도 안 한다 (옛 씬의 도면 좌표가 새 씬에 안 섞인다)',
      unf.stats.placed === 0 && unf.stats.bounds === null && !unf.ready
      && unf.apply(cloth.patterns, 1) === false,
      JSON.stringify({ placed: unf.stats.placed, patterns: unf.stats.patterns }),
    );
    cloth.clear();
  }
}

// ─────────────────────────────────────────────────────────────
// §12-2. 펼침 컨트롤 — 화면이 말하는 것과 실제 (#15-b, control.ts)
//
// `panels/playback.ts` 와 같은 이유로 존재하는 절이다. ISSUE-009 는 재생 상태가
// `main.ts` 의 불리언 두 개로 흩어져 있어서 "버튼은 정지인데 시뮬은 멈춰 있다"
// 를 자동 테스트가 한 줄도 못 덮은 사건이었다. 여기서 보는 것도 같은 종류다 —
// **슬라이더가 오른쪽에 있는데 화면은 3D** 같은 상태가 만들어지지 않는가.
//
// ⚠️ 문구를 통째로 박지 않는다. 계약은 **"이유가 있고, 몇 개인지 말한다"** 이고
//    문장은 바뀔 수 있다. 문구를 박으면 다듬는 날 하네스가 빨간불이 되고,
//    고치는 사람이 회귀부터 의심하게 된다 (#16-a 가 세운 기준).
// ─────────────────────────────────────────────────────────────

function statsOf(patterns: number, placed: number): UnfoldStats {
  return {
    patterns,
    placed,
    unplaced: patterns - placed,
    vertices: placed * 6,
    bounds: placed > 0
      ? { minX: 0, minY: 0, maxX: 10, maxY: 20, width: 10, height: 20, centerX: 5, centerY: 10 }
      : null,
  };
}

function sectionUnfoldControl(): void {
  section('§12-2. 2D 펼침 — 컨트롤 상태 (#15-b, viewer2d/control.ts)');

  // ── ① 씬이 없다 ────────────────────────────────────────────
  {
    const c = new UnfoldController();
    const v = c.view;
    check(
      '★ 씬이 없으면 만질 수 없고, **이유가 글자로 남는다**',
      !v.enabled && v.t === 0 && v.is3d && !v.is2d
      && v.reason !== null && v.reason.length > 0,
      `enabled=${v.enabled} reason=${JSON.stringify(v.reason)}`,
    );
    c.set(1);
    check(
      '★★ 씬이 없을 때 밀어도 t 가 안 오른다 (만질 수 없는데 2D 로 보이는 상태를 만들지 않는다)',
      c.t === 0 && c.effectiveT === 0 && c.view.t === 0,
      `t=${c.t} effective=${c.effectiveT}`,
    );
  }

  // ── ② 배치가 하나도 없다 — 워커가 서피스를 모르는 경우 ───────
  {
    const c = new UnfoldController();
    c.setScene(true);
    c.setStats(statsOf(24, 0));
    const v = c.view;
    check(
      '★★ 배치가 0 이면 비활성 + 이유가 **몇 개인지까지** 말한다 (다음 사람이 워커를 볼 생각을 하게)',
      !v.enabled && v.reason !== null && v.reason.includes('24') && v.reason.includes('배치'),
      JSON.stringify(v.reason),
    );
    c.set(0.7);
    check('★ 그 상태에서 밀어도 t 가 0 이다', c.t === 0 && c.effectiveT === 0);

    // 패턴 자체가 없는 씬은 **다른 이유**여야 한다. 같은 문구면 워커를 의심할지
    // 씬을 의심할지 알 수 없다.
    c.setStats(statsOf(0, 0));
    const empty = c.view;
    check(
      '★ 패턴이 0 인 씬은 배치가 없는 씬과 **다른 이유**를 말한다',
      empty.reason !== null && empty.reason !== v.reason,
      `${JSON.stringify(empty.reason)} ≠ ${JSON.stringify(v.reason)}`,
    );
  }

  // ── ③ 정상 — 그리고 일부만 배치가 없다 ──────────────────────
  {
    const c = new UnfoldController();
    c.setScene(true);
    c.setStats(statsOf(24, 24));
    check(
      '★ 배치가 다 있으면 만질 수 있고 이유가 없다',
      c.view.enabled && c.view.reason === null && c.view.is3d,
      JSON.stringify(c.view),
    );

    c.set(0.5);
    check('★ t 가 반영되고 라벨이 퍼센트를 말한다', c.view.t === 0.5 && c.view.label.includes('50'), c.view.label);
    c.set(1);
    check(
      '★ 양 끝의 라벨은 퍼센트만으로는 모자란다 — 어느 쪽 끝인지 말한다',
      c.view.is2d && /2D|도면/.test(c.view.label) && !c.view.is3d,
      `t=1 → ${JSON.stringify(c.view.label)}`,
    );
    c.set(0);
    check(
      '★ 반대쪽 끝도 마찬가지',
      c.view.is3d && /3D/.test(c.view.label),
      `t=0 → ${JSON.stringify(c.view.label)}`,
    );

    // ★ 일부만 배치가 없다 — 그 사실은 t 와 무관하게 참이다.
    c.setStats(statsOf(24, 22));
    c.set(0);
    const at0 = c.view;
    c.set(1);
    const at1 = c.view;
    check(
      '★★ 일부만 배치가 없으면 **만질 수는 있고**, 몇 개가 3D 에 남는지 말한다',
      at1.enabled && at1.reason !== null && at1.reason.includes('2'),
      JSON.stringify(at1.reason),
    );
    check(
      '★★ 그 이유는 3D 로 돌아가 있어도 그대로다 (도면이 불완전하다는 사실은 t 와 무관하다)',
      at0.reason === at1.reason && at0.reason !== null,
      `t=0 ${JSON.stringify(at0.reason)} / t=1 ${JSON.stringify(at1.reason)}`,
    );
  }

  // ── ④ 값을 다루는 손 ────────────────────────────────────────
  {
    const c = new UnfoldController();
    c.setScene(true);
    c.setStats(statsOf(5, 5));

    c.set(3);
    check('범위를 넘으면 잘라 넣는다 (위)', c.t === 1, String(c.t));
    c.set(-2);
    check('범위를 넘으면 잘라 넣는다 (아래)', c.t === 0, String(c.t));

    c.set(0.4);
    c.set(Number.NaN);
    check('★ NaN 은 무시한다 (옛 값이 남는다 — 0 으로 튀지 않는다)', c.t === 0.4, String(c.t));
    c.set(Number.POSITIVE_INFINITY);
    check('★ Infinity 도 무시한다', c.t === 0.4, String(c.t));

    // ★ 씬이 내려가면 t 가 0 으로 돌아간다. 남겨 두면 다음 씬이 뜨는 순간
    //   사용자가 지시한 적 없는 2D 화면이 나온다.
    c.set(1);
    c.setScene(false);
    check(
      '★★ 씬이 내려가면 t 가 0 으로 돌아간다 (다음 씬이 2D 로 시작하지 않는다)',
      c.t === 0 && c.effectiveT === 0 && !c.view.enabled,
      `t=${c.t}`,
    );

    // ★ effectiveT 와 t 가 갈릴 수 있다 — 화면에 반영되는 것은 effectiveT 다.
    c.setScene(true);
    c.set(1);
    check('되돌아오면 다시 만질 수 있다', c.view.enabled && c.t === 1);
    c.setStats(null);
    check(
      '★★ stats 가 사라지면(로드 실패) effectiveT 가 0 이다 — 화면이 2D 라고 거짓말하지 않는다',
      c.effectiveT === 0 && !c.view.enabled && c.view.t === 0,
      `t=${c.t} effective=${c.effectiveT}`,
    );
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
// §10. 재생 상태 기계 (#14) — 화면 없이 전이 전체를 돈다
//
// **이 절이 존재하는 이유가 곧 ISSUE-009 다.** 재생 상태가 `main.ts` 의 모듈
// 스코프 불리언 두 개로 흩어져 있던 동안 자동 테스트가 한 줄도 덮지 못했고,
// "버튼은 정지라고 쓰여 있는데 시뮬은 멈춰 있다" 를 사람이 브라우저에서 눈으로
// 찾아야 했다. `panels/playback.ts` 가 DOM 을 안 만지므로 여기서 가짜 포트 하나로
// 전이 전체를 돌린다.
//
// ── 무엇을 여기에 두고 무엇을 verify/ui.ts 에 두었는가 ───────
// **상태 기계는 여기, 버튼·키·화면은 저기다.** 가르는 기준은 "실패했을 때
// 원인이 어디에 남는가" 하나다:
//
//   여기(Node)  전이·파생·계측기·훅 순서·연타·끊김. 결정적이고 30ms 면 끝난다.
//               브라우저로 하면 타이밍에 흔들리고 실패 원인이 화면에 안 남는다.
//   ui.ts       버튼이 실제로 그 메서드에 붙어 있는가, 키가 실제로 먹는가,
//               리셋 뒤 **화면의 옷이 돌아오는가**. 여기서는 원리상 볼 수 없다.
//
// 겹치는 것이 하나 있다 — **"재생 중 재로드 → 버튼이 정직해진다"** 는 양쪽에
// 다 둔다. 여기서는 `sceneLoading()` 이 믿음을 내리는 것을 증명하고, 저기서는
// **[로드] 버튼이 그 함수를 실제로 부르는지**를 증명한다. 배선이 끊기면 여기는
// 초록인 채로 화면만 거짓말한다 — ISSUE-009 가 정확히 그 모양이었다.
//
// ── 가짜 포트는 워커를 **실측 그대로** 흉내낸다 ──────────────
// 아래 `makePort()` 는 편한 대로 만든 모형이 아니라 워커의 실제 거동이다
// (`backend/native/src/protocol.cpp` + Builder 실측). 모형이 실제와 갈라지면
// 이 절 전체가 환상을 검증하게 되므로, §10-10 이 **실제 워커로 그 다섯 가지를
// 다시 확인한다.**
// ─────────────────────────────────────────────────────────────

/** 가짜 포트가 받는 op. `PlaybackPort` 의 메서드 이름 그대로다 */
type PortOp = 'start' | 'pause' | 'reset' | 'clear' | 'step' | 'subscribe' | 'status';

/**
 * 워커의 시뮬 상태 모형. **다섯 가지가 실측이고, 그게 이 절의 전제다:**
 *
 *   ① `start`/`pause` 가 mode 를 바꾼다
 *   ② **시뮬이 서면 `curFrame` 이 -1 이 된다** (엔진 콜백이 그렇게 준다)
 *   ③ **`reset` 은 `maxFrame` 만 -1 로 되돌리고 `curFrame` 은 옛 봉우리로 남긴다**
 *   ④ `clear` 는 씬을 내린다. `reset` 은 남긴다
 *   ⑤ **`step` 은 응답만 `{mode:"step"}` 이고 아무 일도 하지 않는다**
 *
 * ②③⑤ 가 이 단위의 함정 전부다. §10-10 이 실제 워커로 다섯 가지를 확인한다.
 */
interface WorkerModel {
  loaded: boolean;
  mode: StatusResult['mode'];
  /** 워커의 `curFrame`. 시뮬이 서면 -1 로 보고된다 */
  curFrame: number;
  maxFrame: number;
  subscribed: boolean;
}

interface FakePort extends PlaybackPort {
  connected: boolean;
  /** op 과 훅 호출이 **한 줄로** 쌓인다. 순서 단언이 여기서 나온다 */
  trace: string[];
  worker: WorkerModel;
  /** 이 op 은 워커에 닿기 전에 실패한다 */
  failing: Set<PortOp>;
  /** 이 op 은 **워커에 반영된 뒤** 실패한다 (타임아웃의 모양이다) */
  failAfter: Set<PortOp>;
  /** 이 promise 가 풀릴 때까지 응답을 붙잡는다 — 왕복 중 상태를 관찰한다 */
  held: Map<PortOp, Promise<void>>;
  /** 워커에 씬이 올라갔다 (`load` op 은 이 포트를 지나지 않는다) */
  putScene(): void;
  /** 시뮬이 프레임 n 까지 갔다 */
  advanceTo(n: number): void;
  count(op: PortOp): number;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makePort(trace: string[] = []): FakePort {
  const worker: WorkerModel = {
    loaded: false, mode: 'pause', curFrame: -1, maxFrame: -1, subscribed: false,
  };
  const failing = new Set<PortOp>();
  const failAfter = new Set<PortOp>();
  const held = new Map<PortOp, Promise<void>>();

  async function call<T>(op: PortOp, effect: () => T): Promise<T> {
    trace.push(op);
    const hold = held.get(op);
    if (hold) await hold;
    if (failing.has(op)) throw new Error(`${op} 이 워커에 닿지 못했다(가짜)`);
    const out = effect();
    if (failAfter.has(op)) throw new Error(`${op} 은 됐는데 응답을 못 받았다(가짜)`);
    return out;
  }

  return {
    connected: true,
    trace,
    worker,
    failing,
    failAfter,
    held,
    putScene(): void {
      // 워커의 `load` 는 시뮬을 초기화하고 maxFrame 을 -1 로 되돌린다.
      worker.loaded = true;
      worker.mode = 'pause';
      worker.curFrame = -1;
      worker.maxFrame = -1;
    },
    advanceTo(n: number): void {
      worker.curFrame = n;
      worker.maxFrame = n;
    },
    count(op: PortOp): number {
      return trace.filter((t) => t === op).length;
    },
    start: () => call('start', () => {
      worker.mode = 'play';
      return { mode: 'play' };
    }),
    pause: () => call('pause', () => {
      worker.mode = 'pause';
      return { mode: 'pause' };
    }),
    // ★ 실측 ③ — maxFrame 만 되돌린다. curFrame 은 옛 봉우리로 남는다.
    reset: () => call('reset', () => {
      worker.mode = 'pause';
      worker.maxFrame = -1;
      return { mode: 'reset' };
    }),
    clear: () => call('clear', () => {
      worker.loaded = false;
      worker.mode = 'pause';
      worker.maxFrame = -1;
      return { cleared: true };
    }),
    // ★ 실측 ⑤ — 응답만 step 이고 워커는 아무것도 하지 않는다.
    step: () => call('step', () => ({ mode: 'step' })),
    subscribe: () => call('subscribe', () => {
      worker.subscribed = true;
      return { subscribed: true };
    }),
    status: () => call('status', () => ({
      loaded: worker.loaded,
      simInitialized: worker.loaded,
      mode: worker.mode,
      // ★ 실측 ② — 시뮬이 서 있으면 엔진 콜백이 -1 을 준다.
      frame: worker.mode === 'play' ? worker.curFrame : -1,
      maxFrame: worker.maxFrame,
      subscribed: worker.subscribed,
    })),
  };
}

/** 훅 호출을 `port.trace` 에 같은 줄로 섞어 넣는다. 순서 단언이 여기서 나온다 */
function tracingHooks(trace: string[], extra: PlaybackHooks = {}): PlaybackHooks {
  return {
    beforePlay: () => {
      trace.push('hook:beforePlay');
      extra.beforePlay?.();
    },
    afterReset: async () => {
      trace.push('hook:afterReset');
      await extra.afterReset?.();
    },
    afterClear: () => {
      trace.push('hook:afterClear');
      extra.afterClear?.();
    },
    onChange: (v) => {
      extra.onChange?.(v);
    },
    log: (l) => {
      extra.log?.(l);
    },
  };
}

/** 씬이 올라가 있고 정지 상태인 컨트롤러 하나. 대부분의 절이 여기서 시작한다 */
async function ready(
  extra: PlaybackHooks = {},
): Promise<{ pb: PlaybackController; port: FakePort; trace: string[] }> {
  const trace: string[] = [];
  const port = makePort(trace);
  const pb = new PlaybackController({ port, hooks: tracingHooks(trace, extra) });
  port.putScene();
  pb.sceneLoaded('scene-1');
  await pb.syncFromWorker();
  trace.length = 0;
  return { pb, port, trace };
}

/** 두 글자 중 하나만 들어 있는가. `verify/ui.ts` 의 ensurePlaying 이 읽는 방식이다 */
function readsAs(label: string, want: '재생' | '정지'): boolean {
  const other = want === '재생' ? '정지' : '재생';
  return label.includes(want) && !label.includes(other);
}

// ── §10-1. 상태는 파생이다 ───────────────────────────────────
//
// 필드로 들면 "끊겼는데 playing" 같은 조합이 **표현 가능해지고**, 그게 곧
// ISSUE-009 의 형태다. 여기서 보는 것은 그 조합들이 하나도 만들어지지 않는가다.

async function sectionPlaybackDerived(): Promise<void> {
  section('§10-1. 재생 상태 기계 — 상태는 파생이다 (playback.ts, DOM 없이)');

  {
    const port = makePort();
    const pb = new PlaybackController({ port });
    check('붙었지만 씬이 없으면 noScene', pb.state === 'noScene', pb.state);
    port.connected = false;
    check('소켓이 없으면 disconnected', pb.state === 'disconnected', pb.state);
  }

  // ★ 이 절의 핵심. 재생 중에 소켓이 사라지면 **어느 경로로도** playing 이
  //   남을 수 없어야 한다. 상태를 필드로 들면 여기가 뚫린다.
  {
    const { pb, port } = await ready();
    await pb.play();
    check('재생을 켜면 playing', pb.state === 'playing' && pb.view.playing, pb.state);
    check(
      '버튼 글자가 "정지" 쪽으로 읽힌다 (ui.ts 의 ensurePlaying 이 이 글자를 본다)',
      readsAs(pb.view.playLabel, '정지'), pb.view.playLabel,
    );

    // 소켓만 사라뜨린다 — 컨트롤러에는 아무것도 알리지 않는다.
    port.connected = false;
    check(
      '★★ 재생 중에 소켓이 사라지면 아무도 안 알려줘도 disconnected 다 (파생의 증거)',
      pb.state === 'disconnected' && !pb.view.playing,
      `${pb.state} / playing=${String(pb.view.playing)}`,
    );
    check(
      '★★ 그때 버튼 글자도 "재생" 으로 읽힌다 ("끊겼는데 ⏸ 정지" 가 표현 불가능하다)',
      readsAs(pb.view.playLabel, '재생'), pb.view.playLabel,
    );
    check(
      '★ 그 상태에서는 어떤 버튼도 안 눌린다',
      !pb.view.canPlay && !pb.view.canReset && !pb.view.canClear && !pb.view.canStep,
      `play=${String(pb.view.canPlay)} reset=${String(pb.view.canReset)}`,
    );

    // 되붙이면 원래 상태가 그대로 돌아온다 — 파생이라 잃어버릴 것이 없다.
    port.connected = true;
    check('소켓이 돌아오면 상태도 돌아온다', pb.state === 'playing', pb.state);
  }

  // loading 은 scene 보다 앞선다 — 로드 중에 "씬 있음/재생 중" 이 보이면 안 된다.
  {
    const { pb } = await ready();
    await pb.play();
    pb.sceneLoading();
    check(
      '★ 씬이 있어도 로드 중이면 loading 이 이긴다',
      pb.state === 'loading' && !pb.view.playing, pb.state,
    );
    pb.sceneLoadFailed();
    check(
      '로드 실패는 씬 유무를 스스로 정하지 않는다 (sync 에 맡긴다)',
      pb.view.scene === 'scene-1', String(pb.view.scene),
    );
  }

  // 진행 중 op(`pending`)은 상태가 아니다.
  {
    const { pb, port } = await ready();
    const gate = deferred();
    port.held.set('start', gate.promise);
    const p = pb.play();
    await sleep(10);
    check(
      '★ 왕복 중이어도 state 는 다섯 개 중 하나다 (pending 은 상태가 아니다)',
      pb.state === 'paused', pb.state,
    );
    check('그동안 busy 가 서 있고 버튼은 잠긴다', pb.busy && !pb.view.canPlay,
      `busy=${String(pb.busy)} canPlay=${String(pb.view.canPlay)}`);
    check('view.pending 이 어떤 op 인지 말한다', pb.view.pending === 'play', String(pb.view.pending));
    gate.resolve();
    await p;
    check('끝나면 pending 이 비고 상태가 넘어간다',
      pb.view.pending === null && pb.state === 'playing', pb.state);
  }

  // 재연결은 복구가 아니라 빈 세션이다.
  {
    const { pb, port } = await ready();
    await pb.play();
    pb.connectionLost();
    check('끊기면 재생 믿음과 구독이 함께 내려간다',
      !pb.view.playing && !pb.view.subscribed,
      `playing=${String(pb.view.playing)} subscribed=${String(pb.view.subscribed)}`);
    pb.sessionStarted();
    check(
      '★ 새 세션은 빈 세션이다 (씬도 프레임도 초기값 — 화면에 옛 옷이 남지 않는다)',
      pb.view.scene === null && pb.view.frame === null && pb.state === 'noScene',
      `scene=${String(pb.view.scene)} frame=${String(pb.view.frame)} state=${pb.state}`,
    );
    check('워커의 mode 도 "아직 안 물었다" 로 되돌아간다',
      pb.view.workerMode === null, String(pb.view.workerMode));
    port.connected = false;
    check('끊긴 뒤의 상태줄은 연결을 말한다', pb.view.text.includes('연결'), pb.view.text);
  }
}

// ── §10-2. ★ ISSUE-009 ───────────────────────────────────────
//
// 증상: 재생 중에 씬을 다시 로드하면 워커는 멈추는데 버튼은 `⏸ 정지` 로 남는다.
// 닫은 방법: 1안(로드 시작 자리에서 믿음을 내린다) + 3안(전이가 끝나는 자리마다
// 워커에 되묻는다). `stats.corrections` 가 그 계측기다.
//
// **계측기만으로는 아무것도 증명하지 못한다** — 늘 0 인 죽은 카운터일 수도 있다.
// 그래서 세 가지를 같이 본다: ⓐ 정상 경로에서 0 (대조군), ⓑ 믿음을 안 내리면
// 1 (그게 ISSUE-009 다), ⓒ 워커가 혼자 멎으면 1 (계측기가 살아 있다).

async function sectionPlaybackIssue009(): Promise<void> {
  section('§10-2. ★ ISSUE-009 — 재생 중 재로드에서 화면이 거짓말하지 않는다');

  // ── ⓐ 정상 경로: 재생 중 재로드 ────────────────────────────
  {
    const { pb, port } = await ready();
    await pb.play();
    port.advanceTo(120);
    pb.noteFrame(120);
    check('전제 — 재생 중이고 프레임이 흐른다',
      pb.state === 'playing' && pb.view.frame === 120, `frame=${String(pb.view.frame)}`);

    // ★ 로드가 시작된다. 아직 **아무것도 await 하지 않았다** — 103MB 면 1초쯤
    //   걸리는 구간이고, ISSUE-009 는 그 1초 동안 화면이 거짓말하는 것이었다.
    pb.sceneLoading();
    check(
      '★★★ 로드가 시작된 그 자리에서 즉시 재생 믿음이 내려간다 (성공을 기다리지 않는다)',
      !pb.view.playing && pb.state === 'loading',
      `state=${pb.state} playing=${String(pb.view.playing)}`,
    );
    check(
      '★★★ 그 순간 버튼 글자가 "재생" 으로 읽힌다 — ISSUE-009 의 증상 그 자체',
      readsAs(pb.view.playLabel, '재생'), pb.view.playLabel,
    );
    check('로드 중에는 프레임 번호도 비운다 (옛 런의 봉우리가 남지 않는다)',
      pb.view.frame === null, String(pb.view.frame));

    // 워커가 로드를 마쳤다 (시뮬 초기화 + maxFrame -1).
    port.putScene();
    pb.sceneLoaded('scene-1');
    // ★ **되묻기 전**이다. `loading` 이 걷힌 이 한 칸에서 믿음이 되살아나면
    //   버튼이 다시 `⏸ 정지` 로 깜빡인다 — `main.ts` 는 여기서 `setBusy(false)`
    //   와 `paintSnap()` 을 지나 실제로 다시 그린다. 파생만으로는 못 막는
    //   자리이고(로드 중에는 `loading` 이 가려 준다), `sceneLoading()` 이
    //   믿음을 내려 뒀는지가 여기서만 드러난다.
    check(
      '★★★ 로드가 끝난 직후, 되묻기 전에도 여전히 "재생" 이다 (믿음이 되살아나지 않는다)',
      !pb.view.playing && readsAs(pb.view.playLabel, '재생') && pb.state === 'paused',
      `state=${pb.state} label=${pb.view.playLabel}`,
    );
    await pb.syncFromWorker();
    check('로드가 끝나면 paused 로 선다', pb.state === 'paused', pb.state);
    check(
      '★★★ 대조군 — 이 경로 내내 corrections 가 0 이다 (믿음이 사실과 한 번도 갈라지지 않았다)',
      pb.stats.corrections === 0, `corrections=${pb.stats.corrections}`,
    );
  }

  // ── ⓑ 믿음을 안 내리면 어떻게 되는가 (= ISSUE-009) ──────────
  //
  // `sceneLoading()` 을 빼고 같은 일을 한다. 이것이 #14 이전의 동작이고,
  // 계측기가 그것을 **잡아낸다**는 것이 이 절이 성립하는 근거다.
  {
    const { pb, port } = await ready();
    await pb.play();
    port.advanceTo(120);
    // 로드 경로를 타지 않는다 — 워커만 씬을 다시 올린다.
    port.putScene();
    check(
      '★ (재현) 믿음을 안 내리면 워커는 멈췄는데 화면은 "⏸ 정지" 다',
      pb.view.playing && readsAs(pb.view.playLabel, '정지'), pb.view.playLabel,
    );
    await pb.syncFromWorker();
    check(
      '★★ 그때 되묻기가 그 거짓말을 잡아낸다 (corrections 가 오른다)',
      pb.stats.corrections === 1 && !pb.view.playing,
      `corrections=${pb.stats.corrections} playing=${String(pb.view.playing)}`,
    );
    check('되묻고 나면 화면이 사실을 말한다', readsAs(pb.view.playLabel, '재생'), pb.view.playLabel);
  }

  // ── ⓒ 워커가 혼자 멎었다 — 우리 손을 안 지나는 어긋남 ───────
  {
    const { pb, port } = await ready();
    await pb.play();
    port.worker.mode = 'pause'; // 워커만 멎었다. 우리는 모른다.
    check('전제 — 우리 믿음은 아직 재생이다', pb.view.playing, pb.state);
    await pb.syncFromWorker();
    check(
      '★★ 워커가 혼자 멎어도 다음 되묻기에서 화면이 따라간다',
      !pb.view.playing && pb.stats.corrections === 1,
      `corrections=${pb.stats.corrections}`,
    );
  }

  // ── ⓓ 씬이 워커에서 사라진 경우도 같은 계측기에 걸린다 ──────
  {
    const { pb, port } = await ready();
    port.worker.loaded = false;
    await pb.syncFromWorker();
    check(
      '★ 씬이 워커에서 사라진 것도 되묻기가 잡는다 (noScene 으로 내려간다)',
      pb.state === 'noScene' && pb.stats.corrections === 1,
      `state=${pb.state} corrections=${pb.stats.corrections}`,
    );
  }

  // ── ⓔ op 이 끝나는 자리마다 되묻는다 (폴링이 아니다) ────────
  {
    const { pb, port, trace } = await ready();
    await pb.play();
    check('★ op 뒤에는 반드시 status 가 따라온다',
      trace[trace.length - 1] === 'status', trace.join(' → '));
    const syncs0 = pb.stats.syncs;
    const status0 = port.count('status');
    await sleep(300);
    check(
      '★ 가만히 두면 되묻지 않는다 (폴링이 아니라 전이 자리에서만 묻는다)',
      pb.stats.syncs === syncs0 && port.count('status') === status0,
      `syncs ${syncs0} → ${pb.stats.syncs} · status ${status0} → ${port.count('status')}`,
    );
    await pb.pause();
    check(
      '★ op 하나에 되묻기가 정확히 하나 붙는다 (왕복이 op 당 두 번으로 늘지 않는다)',
      pb.stats.syncs - syncs0 === 1 && port.count('status') - status0 === 1,
      `syncs +${pb.stats.syncs - syncs0} / status +${port.count('status') - status0}`,
    );
  }

  // ── ⓕ 실패한 op 이 워커에 닿아 있었던 경우 ──────────────────
  //
  // 타임아웃의 모양이다: 워커는 재생을 시작했는데 우리는 응답을 못 받았다.
  // 여기서 화면이 "정지" 로 남으면 그것도 ISSUE-009 다.
  {
    const { pb, port } = await ready();
    port.failAfter.add('start');
    const ok = await pb.play();
    check('응답을 못 받은 play 는 false 를 돌려준다 (던지지 않는다)', ok === false, String(ok));
    check(
      '★★ 그래도 화면은 워커를 따라 "재생 중" 이 된다 (실패했을 때가 더 중요하다)',
      pb.view.playing && pb.stats.corrections === 1,
      `playing=${String(pb.view.playing)} corrections=${pb.stats.corrections}`,
    );
    check('실패는 실패대로 남는다', pb.stats.failures === 1 && pb.lastError !== null,
      `failures=${pb.stats.failures}`);
  }
}

// ── §10-3. 프레임 번호 — 함정 두 개 ──────────────────────────
//
// 워커의 `status.frame` 은 화면에 쓸 수 없다. 함정이 **양쪽에** 있다:
//   ① 멈추면 -1 이 온다 → 그대로 쓰면 화면이 "-1"
//   ② "마지막 유효값 보관" 으로 가리면, `reset` 이 curFrame 을 안 건드리므로
//      리셋한 뒤에도 옛 봉우리(249)가 남는다
// 두 함정을 같은 절에서 덮는다. 한쪽만 덮으면 반대쪽으로 고치는 사람이 생긴다.

async function sectionPlaybackFrames(): Promise<void> {
  section('§10-3. 재생 상태 기계 — 프레임 번호의 함정 두 개');

  const { pb, port } = await ready();
  await pb.play();
  port.advanceTo(249);
  pb.noteFrame(249);
  check('재생 중에는 frame 이벤트의 번호가 그대로 화면에 간다',
    pb.view.frame === 249, String(pb.view.frame));
  check('상태줄에 그 번호가 실린다', pb.view.text.includes('249'), pb.view.text);

  // ── 함정 ①: 멈추면 status.frame 이 -1 ─────────────────────
  await pb.pause();
  const s1 = await pb.syncFromWorker();
  note('워커가 말한 것(정지 직후)', `frame=${s1?.frame} maxFrame=${s1?.maxFrame}`);
  check(
    '★★ 정지 뒤에도 화면의 프레임은 249 다 (status.frame 을 썼다면 -1 이 찍힌다)',
    pb.view.frame === 249, String(pb.view.frame),
  );
  check(
    '★ 음수가 온 사실은 계측기에 남는다 (워커를 고치면 0 이 된다)',
    pb.stats.negativeFrames > 0, `negativeFrames=${pb.stats.negativeFrames}`,
  );

  // ── 함정 ②: "마지막 유효값 보관" 의 반대쪽 함정 ────────────
  //
  // 함정 ①을 "음수가 오면 직전의 유효한 값을 그대로 들고 있기" 로 가리면,
  // **리셋해도 그 값을 버릴 계기가 없다** — 워커는 maxFrame 만 -1 로 되돌리고
  // 프레임 이벤트는 한 건도 안 오므로, 화면에는 옛 봉우리 249 가 남는다.
  // 아래가 그 구현이 남겼을 값이고, 실제 값이 그것과 달라야 한다.
  const wouldHold = pb.view.frame; // "마지막 유효값 보관" 구현이 들고 있었을 수
  const before = pb.stats.negativeFrames;
  await pb.reset();
  const s2 = await pb.syncFromWorker();
  note('워커가 말한 것(리셋 직후)', `frame=${s2?.frame} maxFrame=${s2?.maxFrame}`);
  check(
    '★★★ 리셋하면 화면의 프레임이 비워진다 ("마지막 유효값 보관" 이면 249 가 남는다)',
    pb.view.frame === null && wouldHold === 249, `${String(wouldHold)} → ${String(pb.view.frame)}`,
  );
  check(
    '★ 그때 상태줄에는 프레임 항목이 아예 없다 ("-" 를 읽을 이유가 없다)',
    !pb.view.text.includes('프레임') && pb.view.text.includes('일시정지'), pb.view.text,
  );
  check('리셋에서도 음수 계측기는 계속 센다', pb.stats.negativeFrames > before,
    `${before} → ${pb.stats.negativeFrames}`);

  // ── frame 이벤트도 -1 을 실어 올 수 있다 ───────────────────
  pb.noteFrame(-1);
  check('★ frame 이벤트의 -1 은 버린다 (리셋 직후 한 건이 지나갈 수 있다)',
    pb.view.frame === null, String(pb.view.frame));
  pb.noteFrame(3);
  pb.noteFrame(-1);
  check('이미 숫자가 있어도 -1 로 덮어쓰지 않는다', pb.view.frame === 3, String(pb.view.frame));

  // ── noteFrame 은 다시 그리라고 하지 않는다 (40/s) ──────────
  {
    let changes = 0;
    const port2 = makePort();
    const pb2 = new PlaybackController({
      port: port2, hooks: { onChange: () => { changes += 1; } },
    });
    port2.putScene();
    pb2.sceneLoaded('s');
    await pb2.syncFromWorker();
    const c0 = changes;
    for (let i = 0; i < 40; i++) pb2.noteFrame(i);
    check(
      '★ noteFrame 은 onChange 를 부르지 않는다 (40/s 로 DOM 을 흔들지 않는다)',
      changes === c0, `${c0} → ${changes} (40회 호출)`,
    );
    check('그래도 값은 반영돼 있다', pb2.view.frame === 39, String(pb2.view.frame));
  }

  // ── 화면 프레임의 출처는 maxFrame 하나다 ───────────────────
  {
    const { pb: pb3, port: port3 } = await ready();
    await pb3.play();
    port3.worker.curFrame = 999; // curFrame 만 크게. maxFrame 은 그대로.
    port3.worker.maxFrame = 7;
    await pb3.syncFromWorker();
    check(
      '★★ 화면의 프레임은 maxFrame 을 따른다 (curFrame 999 를 따라가지 않는다)',
      pb3.view.frame === 7, String(pb3.view.frame),
    );
  }
}

// ── §10-4. 구독은 세션당 한 번 ───────────────────────────────

async function sectionPlaybackSubscribe(): Promise<void> {
  section('§10-4. 재생 상태 기계 — 구독은 세션당 한 번');

  const { pb, port, trace } = await ready();
  await pb.play();
  check(
    '★ subscribe 가 start 보다 먼저 나간다 (반대면 첫 몇 프레임이 mesh 없이 지나간다)',
    trace.indexOf('subscribe') >= 0 && trace.indexOf('subscribe') < trace.indexOf('start'),
    trace.join(' → '),
  );

  await pb.pause();
  await pb.play();
  await pb.reset();
  await pb.play();
  await pb.pause();
  await pb.clear();
  port.putScene();
  pb.sceneLoaded('scene-1');
  await pb.syncFromWorker();
  await pb.play();
  check(
    '★★ 재생·정지·리셋·clear·재로드를 지나도 subscribe 는 1회다',
    pb.stats.subscribes === 1 && port.count('subscribe') === 1,
    `stats ${pb.stats.subscribes} / 실제 전송 ${port.count('subscribe')}`,
  );

  // 재연결 = 새 워커. 구독이 꺼진 채로 시작하므로 반드시 다시 보내야 한다.
  pb.connectionLost();
  pb.sessionStarted();
  const port2Worker = port.worker;
  port2Worker.subscribed = false; // 새 워커다
  port.putScene();
  pb.sceneLoaded('scene-1');
  await pb.syncFromWorker();
  await pb.play();
  check(
    '★★ 재연결 뒤에는 다시 보낸다 (새 워커라 구독이 꺼져 있다)',
    pb.stats.subscribes === 2, `subscribes=${pb.stats.subscribes}`,
  );

  // 믿음이 아니라 사실을 따른다 — 워커가 아니라고 하면 다시 켠다.
  port.worker.subscribed = false;
  await pb.syncFromWorker();
  check('되묻기가 구독 여부도 사실로 덮는다', !pb.view.subscribed, String(pb.view.subscribed));
  await pb.pause();
  await pb.play();
  check(
    '★ 그러면 다음 재생에서 다시 구독한다 (믿음이 아니라 사실을 따라간다)',
    pb.stats.subscribes === 3, `subscribes=${pb.stats.subscribes}`,
  );
}

// ── §10-5. 훅 — 순서와 격리 ──────────────────────────────────
//
// 훅은 화면이 끼워 넣는 것이라 **던질 수 있다.** 숫자를 찍는 코드가 시뮬 제어를
// 죽이면 원인을 찾을 길이 없다. 어디까지 격리되는지를 여기서 못으로 박는다.

async function sectionPlaybackHooks(): Promise<void> {
  section('§10-5. 재생 상태 기계 — 훅의 순서와 격리');

  // ── 순서 ───────────────────────────────────────────────────
  {
    const { pb, trace } = await ready();
    await pb.play();
    check(
      '★ play: beforePlay → subscribe → start → status',
      trace.join(' → ') === 'hook:beforePlay → subscribe → start → status', trace.join(' → '),
    );
    trace.length = 0;
    await pb.reset();
    check(
      '★ reset: reset → afterReset → status (포즈를 다시 받은 뒤에 되묻는다)',
      trace.join(' → ') === 'reset → hook:afterReset → status', trace.join(' → '),
    );
    trace.length = 0;
    await pb.clear();
    check('★ clear: clear → afterClear → status',
      trace.join(' → ') === 'clear → hook:afterClear → status', trace.join(' → '));
  }

  // ── afterReset 은 리셋의 성패를 좌우하지 않는다 ─────────────
  //
  // 포즈를 다시 못 받은 것이 리셋 실패는 아니다. 리셋은 이미 됐다.
  {
    const logs: string[] = [];
    const { pb } = await ready({
      afterReset: () => {
        throw new Error('포즈 재수신 실패(가짜)');
      },
      log: (l) => logs.push(l),
    });
    const ok = await pb.reset();
    check(
      '★★ afterReset 이 던져도 reset 은 성공이다 (리셋은 이미 워커에서 됐다)',
      ok === true && pb.stats.resets === 1 && pb.stats.failures === 0,
      `ok=${String(ok)} failures=${pb.stats.failures}`,
    );
    check('대신 이유가 로그에 남는다',
      logs.some((l) => l.includes('포즈')), logs.join(' | ') || '(없음)');
  }

  // ── onChange 가 던져도 시뮬 제어는 산다 ────────────────────
  {
    const port = makePort();
    const pb = new PlaybackController({
      port,
      hooks: { onChange: () => { throw new Error('그리다 죽었다(가짜)'); } },
    });
    port.putScene();
    pb.sceneLoaded('s');
    await pb.syncFromWorker();
    const ok = await pb.play();
    check(
      '★★ onChange 가 던져도 재생은 된다 (숫자를 찍는 코드가 시뮬을 죽이지 않는다)',
      ok === true && pb.state === 'playing', `ok=${String(ok)} state=${pb.state}`,
    );
  }

  // ── beforePlay / afterClear 는 격리되지 않는다 ─────────────
  //
  // ⚠️ `PlaybackHooks` 머리말은 "전부 …던져도 op 을 실패시키지 않는다" 고
  //    적었는데 이 둘은 그렇지 않다. 아래는 **지금 동작을 그대로 못으로 박지
  //    않고**, 어느 쪽이든 성립해야 하는 것 — 즉 **상태가 정직한가** — 만 단언한다.
  //    (반환값의 어긋남은 Tester 보고서에 적었다.)
  {
    const { pb, port } = await ready({
      beforePlay: () => {
        throw new Error('실시간 복귀 실패(가짜)');
      },
    });
    await pb.play();
    check(
      '★ beforePlay 가 던지면 start 가 나가지 않고, 믿음도 재생이 되지 않는다',
      port.count('start') === 0 && !pb.view.playing && pb.state === 'paused',
      `start ${port.count('start')} / state ${pb.state}`,
    );
  }
  {
    const { pb, port } = await ready({
      afterClear: () => {
        throw new Error('화면 정리 실패(가짜)');
      },
    });
    await pb.clear();
    check(
      '★★ afterClear 가 던져도 씬은 내려간 상태다 (화면 정리 실패가 상태를 되돌리지 않는다)',
      pb.state === 'noScene' && port.worker.loaded === false,
      `state=${pb.state} worker.loaded=${String(port.worker.loaded)}`,
    );
  }

  // 훅이 하나도 없어도 돈다 (main.ts 말고 다른 화면이 붙을 수 있다).
  {
    const port = makePort();
    const pb = new PlaybackController({ port });
    port.putScene();
    pb.sceneLoaded('s');
    await pb.syncFromWorker();
    check('훅 없이도 전이가 돈다', (await pb.play()) && pb.state === 'playing', pb.state);
  }
}

// ── §10-6. 실패·연타·못 하는 조작 ────────────────────────────
//
// 전부 `Promise<boolean>` 이고 **던지지 않는다.** 버튼 핸들러에서 도는 함수라,
// 던지면 `void` 로 삼켜져 unhandled rejection 만 남고 화면에는 단서가 안 생긴다.

async function sectionPlaybackFailures(): Promise<void> {
  section('§10-6. 재생 상태 기계 — 실패·연타·못 하는 조작');

  // ── 던지지 않는다 ──────────────────────────────────────────
  {
    const { pb, port } = await ready();
    for (const op of ['start', 'pause', 'reset', 'clear', 'step'] as const) port.failing.add(op);
    port.failing.add('status');
    const results = [
      await pb.play(), await pb.pause(), await pb.reset(),
      await pb.clear(), await pb.step(),
    ];
    check(
      '★★ 조작 다섯 개가 전부 실패해도 하나도 던지지 않는다 (false 로 돌아온다)',
      results.every((r) => r === false), results.map(String).join(','),
    );
    check('실패가 계측기에 남는다', pb.stats.failures === 5, `failures=${pb.stats.failures}`);
    check('마지막 오류를 화면이 읽을 수 있다',
      pb.lastError instanceof Error, pb.lastError?.message ?? '(없음)');
    check(
      '★ status 까지 실패해도 던지지 않는다 (되묻기 실패가 op 을 실패로 만들지 않는다)',
      (await pb.syncFromWorker()) === null, '되묻기 실패는 null',
    );
  }

  // ── 연타 ───────────────────────────────────────────────────
  {
    const { pb, port } = await ready();
    const gate = deferred();
    port.held.set('start', gate.promise);
    const first = pb.play();
    await sleep(5);
    const second = await pb.pause();
    const third = await pb.reset();
    gate.resolve();
    check(
      '★★ 왕복 중인 op 이 있으면 다른 조작을 거절한다 (마지막 응답이 이기는 경합을 막는다)',
      second === false && third === false, `pause=${String(second)} reset=${String(third)}`,
    );
    check('거절은 실패가 아니라 거절로 센다',
      pb.stats.rejected === 2 && pb.stats.failures === 0,
      `rejected=${pb.stats.rejected} failures=${pb.stats.failures}`);
    check('첫 op 은 그대로 완주한다', (await first) === true && pb.state === 'playing', pb.state);
    check('거절된 op 은 워커에 나가지도 않았다',
      port.count('pause') === 0 && port.count('reset') === 0,
      `pause ${port.count('pause')} / reset ${port.count('reset')}`);
  }

  // ── 못 하는 조작은 워커에 나가지 않는다 ────────────────────
  {
    const { pb, port } = await ready();
    port.connected = false;
    const n0 = port.trace.length;
    const ok = await pb.play();
    check(
      '★ 연결이 없으면 아무것도 보내지 않는다',
      ok === false && port.trace.length === n0, `${n0} → ${port.trace.length}`,
    );
    check('이유가 lastError 에 있다',
      (pb.lastError?.message ?? '').includes('연결'), pb.lastError?.message ?? '');
    port.connected = true;
    await pb.clear();
    const n1 = port.trace.length;
    const ok2 = await pb.play();
    check(
      '★ 씬이 없으면 아무것도 보내지 않는다 (워커가 조용히 성공시키는 것을 막는다)',
      ok2 === false && port.trace.length === n1,
      `${pb.lastError?.message ?? ''}`,
    );
    pb.sceneLoading();
    const n2 = port.trace.length;
    await pb.play();
    check('로드 중에도 마찬가지다', port.trace.length === n2, `${n2} → ${port.trace.length}`);
  }

  // 끊긴 상태에서는 되묻지도 않는다.
  {
    const { pb, port } = await ready();
    port.connected = false;
    const n = port.count('status');
    check('★ 끊긴 상태에서 되묻기는 왕복을 만들지 않는다',
      (await pb.syncFromWorker()) === null && port.count('status') === n, `status ${n}`);
  }
}

// ── §10-7. reset 과 clear 는 다르다 ──────────────────────────

async function sectionPlaybackResetClear(): Promise<void> {
  section('§10-7. 재생 상태 기계 — reset 은 남기고 clear 는 내린다');

  {
    const { pb, port, trace } = await ready();
    await pb.play();
    const ok = await pb.reset();
    check('★ reset 은 씬을 남긴다 (시뮬만 처음으로)',
      ok && pb.state === 'paused' && pb.view.scene === 'scene-1' && port.worker.loaded,
      `state=${pb.state} scene=${String(pb.view.scene)}`);
    check('reset 은 재생도 멈춘다', !pb.view.playing, String(pb.view.playing));
    check('reset 뒤에도 버튼이 전부 살아 있다',
      pb.view.canPlay && pb.view.canReset && pb.view.canClear,
      `play=${String(pb.view.canPlay)}`);
    check('★ reset 뒤에 포즈를 다시 받는 훅이 불린다 (리셋은 frame 이벤트를 한 건도 안 낸다)',
      trace.includes('hook:afterReset'), trace.join(' → '));
  }

  {
    const { pb, port, trace } = await ready();
    await pb.play();
    const ok = await pb.clear();
    check('★★ clear 는 씬을 내린다 (되돌리려면 다시 로드해야 한다)',
      ok && pb.state === 'noScene' && pb.view.scene === null && !port.worker.loaded,
      `state=${pb.state} worker.loaded=${String(port.worker.loaded)}`);
    check('clear 뒤에는 재생·리셋 버튼이 잠긴다',
      !pb.view.canPlay && !pb.view.canReset && !pb.view.canClear, 'canPlay=false');
    check('★ 상태줄이 되돌리는 방법을 말한다',
      pb.view.text.includes('.zls') || pb.view.text.includes('로드'), pb.view.text);
    check('clear 는 프레임 번호도 비운다', pb.view.frame === null, String(pb.view.frame));
    check('afterClear 훅이 불린다 (화면에서 옷을 내리는 자리)',
      trace.includes('hook:afterClear'), trace.join(' → '));

    // 다시 로드하면 그대로 돌아온다 — 잃은 것은 시뮬 진행뿐이다.
    port.putScene();
    pb.sceneLoaded('scene-1');
    await pb.syncFromWorker();
    check('★ 다시 로드하면 돌아온다 (확인창을 안 단 근거)',
      pb.state === 'paused' && pb.view.canPlay, pb.state);
  }

  // toggle 은 지금 상태를 보고 정한다 — 눌린 횟수를 세지 않는다.
  {
    const { pb, port } = await ready();
    await pb.toggle();
    check('toggle: 정지 → 재생', pb.state === 'playing', pb.state);
    await pb.toggle();
    check('toggle: 재생 → 정지', pb.state === 'paused', pb.state);
    // 워커만 몰래 재생으로 바꾼 뒤 되묻게 하면, toggle 은 **사실** 을 보고 정한다.
    port.worker.mode = 'play';
    await pb.syncFromWorker();
    await pb.toggle();
    check(
      '★ toggle 은 눌린 횟수가 아니라 지금 상태를 본다 (워커가 재생 중이면 정지한다)',
      pb.state === 'paused' && port.count('pause') === 2,
      `state=${pb.state} pause ${port.count('pause')}`,
    );
  }
}

// ── §10-8. step — 워커가 아무 일도 안 하는 op ────────────────
//
// **[실측]** 응답은 `{mode:"step"}` 인데 곧바로 `status` 를 물으면 `mode:"pause"`
// 이고 `maxFrame` 은 5초가 지나도 그대로다(정지 상태에서 3회 연속 14→14→14→14).
//
// ── 이 사실을 테스트에서 어떻게 다룰 것인가 ─────────────────
// **워커의 no-op 을 단언하지 않는다.** 그건 제품 코드의 성질이 아니라 지금
// 워커의 결함이고, 고쳐지는 날 이 절이 빨간불이 되면 고친 사람이 회귀를 먼저
// 의심하게 된다. 대신 **no-op 이든 아니든 성립해야 하는 것** 을 단언한다:
//   ① 컨트롤러의 믿음이 워커의 사실(`mode:"pause"`)과 어긋나지 않는다
//   ② 화면 표면(버튼·단축키)에 올라가 있지 않다 — 눌러도 안 움직이는 컨트롤이
//      없다는 것이 이 단위의 통과 기준 자체다
// 워커의 no-op 자체는 §10-10 이 실제 워커로 **관찰만** 한다(note).

async function sectionPlaybackStep(): Promise<void> {
  section('§10-8. 재생 상태 기계 — step (워커가 no-op 인 동안)');

  // ── 정지 상태에서의 step ───────────────────────────────────
  {
    const { pb, port } = await ready();
    port.advanceTo(14);
    pb.noteFrame(14);
    const ok = await pb.step();
    check('step 은 성공으로 돌아온다 (워커가 응답은 준다)', ok === true, String(ok));
    check(
      '★★ step 뒤 화면과 워커가 같은 것을 말한다 (믿음도 사실도 정지)',
      !pb.view.playing && pb.view.workerMode === 'pause' && pb.stats.corrections === 0,
      `playing=${String(pb.view.playing)} workerMode=${String(pb.view.workerMode)}`
      + ` corrections=${pb.stats.corrections}`,
    );
    check('★ 워커가 아무 일도 안 한 것이 화면의 숫자를 흔들지 않는다',
      pb.view.frame === 14 && pb.stats.steps === 1, String(pb.view.frame));
    note(
      'step 의 워커 거동(모형)',
      `응답 mode=step / 되물으면 mode=${String(pb.view.workerMode)},`
      + ` maxFrame 은 ${port.worker.maxFrame} 에서 그대로 — 실측과 같다`,
    );
  }

  // ── 재생 중의 step ─────────────────────────────────────────
  //
  // 주석은 "워커의 SetAnimationMode(STEP) 이 PLAY 를 대체하므로 결과적으로
  // '멈추고 한 칸' 이 된다" 고 적었는데, **step 이 no-op 인 지금은 그렇지 않다** —
  // 워커는 계속 돈다. 그래서 여기서 단언하는 것은 "정지가 된다" 가 아니라
  // **화면이 워커와 같은 것을 말한다** 다. 워커가 고쳐지든 아니든 성립한다.
  {
    const { pb } = await ready();
    await pb.play();
    await pb.step();
    check(
      '★★ 재생 중 step 을 불러도 화면은 워커를 따른다 (믿음을 내렸다가 사실로 되돌린다)',
      pb.view.playing === (pb.view.workerMode === 'play'),
      `화면 playing=${String(pb.view.playing)} / 워커 mode=${String(pb.view.workerMode)}`,
    );
    note(
      '재생 중 step',
      `믿음을 정지로 내렸다가 되묻기가 사실(mode=${String(pb.view.workerMode)})로 되돌린다`
      + ` — corrections=${pb.stats.corrections}. 워커의 step 이 고쳐지면 0 이 된다`,
    );
  }

  // ★ 화면 표면에 없다. 되살릴 때 고쳐야 할 자리가 정확히 두 줄이라는 것도 함께.
  check(
    '★★ SPACE 는 지금 아무 조작도 만들지 않는다 (눌러도 안 움직이는 컨트롤을 두지 않는다)',
    shortcutFor({ key: ' ' }) === null && shortcutFor({ key: 'Spacebar' }) === null,
    `' ' → ${String(shortcutFor({ key: ' ' }))}`,
  );
  check(
    '★ 단축키 힌트도 SPACE 를 말하지 않는다 (표와 글자가 한 곳에서 나온다)',
    !SHORTCUT_HINT.includes('SPACE') && !SHORTCUT_HINT.toLowerCase().includes('space'),
    SHORTCUT_HINT,
  );
}

// ── §10-9. 단축키 표 ─────────────────────────────────────────
//
// 데스크톱 기능 #60~#63 과 같은 배치다. 순수 함수라 표 전체를 한 번에 돈다.

function sectionPlaybackShortcuts(): void {
  section('§10-9. 단축키 표 (shortcuts.ts, DOM 없이)');

  const table: [string, ShortcutAction][] = [
    ['s', 'toggle'], ['S', 'toggle'],
    ['r', 'reset'], ['R', 'reset'],
    ['c', 'clear'], ['C', 'clear'],
  ];
  const wrong = table.filter(([key, want]) => shortcutFor({ key }) !== want);
  check(
    '★ S=토글 · R=리셋 · C=씬내림 (대소문자 무관 — 데스크톱 #60~#62 와 같다)',
    wrong.length === 0,
    wrong.map(([k, w]) => `${k}→${String(shortcutFor({ key: k }))}(≠${w})`).join(', ') || '6/6',
  );
  check('모르는 키는 null 이다 (그때 preventDefault 를 걸지 않는다)',
    shortcutFor({ key: 'q' }) === null && shortcutFor({ key: 'Enter' }) === null, 'q/Enter → null');

  // ── 수식키: 브라우저·OS 의 것을 빼앗지 않는다 ───────────────
  const mods: [string, Record<string, boolean>][] = [
    ['Ctrl+R', { ctrlKey: true }],
    ['Cmd+R', { metaKey: true }],
    ['Alt+R', { altKey: true }],
    ['Shift+R', { shiftKey: true }],
  ];
  const leaked = mods.filter(([, m]) => shortcutFor({ key: 'r', ...m }) !== null);
  check(
    '★★ 수식키가 눌려 있으면 손대지 않는다 (Ctrl+R 이 새로고침으로 남는다)',
    leaked.length === 0, leaked.map(([n]) => n).join(', ') || '4/4 양보',
  );

  check('★ IME 조합 중에는 손대지 않는다 (한글 입력의 ㄴ 을 조작으로 읽지 않는다)',
    shortcutFor({ key: 's', isComposing: true }) === null, 'isComposing → null');
  check('★ 누르고 있는 중(repeat)에는 op 을 초당 수십 번 보내지 않는다',
    shortcutFor({ key: 's', repeat: true }) === null, 'repeat → null');

  // ── 대상 요소에 양보 ───────────────────────────────────────
  const yields = ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'OPTION', 'A'];
  const stolen = yields.filter((tagName) => shortcutFor({ key: 's' }, { tagName }) !== null);
  check(
    '★★ 상호작용 요소가 대상이면 양보한다 (씬 선택 중 s 가 시뮬을 켜지 않는다)',
    stolen.length === 0, stolen.join(', ') || `${yields.length}/${yields.length} 양보`,
  );
  check('소문자 태그 이름으로 와도 양보한다',
    shortcutFor({ key: 's' }, { tagName: 'input' }) === null, 'input → null');
  check('contentEditable 도 양보한다',
    shortcutFor({ key: 's' }, { isContentEditable: true }) === null, 'null');
  check('★ 캔버스·본문에서는 그대로 먹는다',
    shortcutFor({ key: 's' }, { tagName: 'CANVAS' }) === 'toggle'
    && shortcutFor({ key: 's' }, { tagName: 'BODY' }) === 'toggle', 'CANVAS/BODY → toggle');
  check('대상이 없어도(null) 먹는다',
    shortcutFor({ key: 's' }, null) === 'toggle', 'null → toggle');
  check('isTypingTarget 이 같은 판단을 단독으로도 한다',
    isTypingTarget({ tagName: 'INPUT' }) && !isTypingTarget({ tagName: 'DIV' })
    && !isTypingTarget(null), 'INPUT=true / DIV=false / null=false');

  check(
    '단축키 힌트가 세 키를 전부 말한다 (표와 글자가 갈라지지 않는다)',
    SHORTCUT_HINT.includes('S') && SHORTCUT_HINT.includes('R') && SHORTCUT_HINT.includes('C'),
    SHORTCUT_HINT,
  );
}

// ── §10-10. 실제 워커로 모형을 검증한다 ──────────────────────
//
// §10-1~§10-9 는 전부 `makePort()` 위에서 돈다. **모형이 실제와 갈라지면 그
// 아홉 절이 통째로 환상을 검증하게 된다.** 그래서 실제 워커로 다섯 가지를
// 확인한다 — 그리고 그 김에 `GatewayClient` 가 어댑터 없이 `PlaybackPort` 를
// 만족한다는 것(구조적 타입)도 실행으로 확인된다.
//
// ⚠️ 여기서 워커의 거동이 달라지면 **모형을 고쳐야 한다는 신호**다. 그게 이
//    절의 존재 이유이므로 note 가 아니라 check 로 둔다.

async function sectionPlaybackRealWorker(): Promise<void> {
  section('§10-10. 재생 상태 기계 — 실제 워커로 모형 검증 (#14)');

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

    const client = new GatewayClient({ url: addr.url, requestTimeoutMs: 120_000 });
    // ★ 어댑터가 없다. `GatewayClient` 를 그대로 포트로 넣는다.
    const pb = new PlaybackController({ port: client });
    try {
      await client.connect();
      client.on('frame', (ev) => pb.noteFrame(ev.frame));

      pb.sceneLoading();
      await client.load(scene.id);
      pb.sceneLoaded(scene.id);
      const loaded = await pb.syncFromWorker();
      check(
        '★ GatewayClient 가 어댑터 없이 포트가 된다 (구조적 타입 — 실행으로 확인)',
        loaded !== null && pb.state === 'paused',
        `state=${pb.state}`,
      );
      check(
        '모형 ④ — 로드 직후 워커의 maxFrame 은 -1 이다',
        loaded?.maxFrame === -1, `maxFrame=${String(loaded?.maxFrame)}`,
      );

      // ── ① start / pause 가 mode 를 바꾼다 ───────────────────
      await pb.play();
      check('모형 ① — play 를 보내면 워커가 mode=play 라고 답한다',
        pb.view.workerMode === 'play', String(pb.view.workerMode));
      const ran = await until(() => (pb.view.frame ?? -1) >= 3, 30_000);
      check('★ 실제로 프레임이 흐른다 (frame 이벤트의 번호가 화면 값이 된다)',
        ran, `frame=${String(pb.view.frame)}`);
      const peak = pb.view.frame ?? -1;

      await pb.pause();
      const paused = await pb.syncFromWorker();
      check('모형 ① — pause 를 보내면 mode=pause 다',
        paused?.mode === 'pause', String(paused?.mode));

      // ── ② 멈추면 status.frame 이 프레임 번호가 아니다 ───────
      note('정지 직후 워커', `frame=${String(paused?.frame)} maxFrame=${String(paused?.maxFrame)}`);
      check(
        '★★ 모형 ② — 정지 중 status.frame 은 음수다 (화면에 쓰면 "-1" 이 찍힌다)',
        (paused?.frame ?? 0) < 0, `frame=${String(paused?.frame)}`,
      );
      check(
        '★★ 그래서 화면은 maxFrame 을 쓴다 — 정지해도 봉우리가 그대로 남는다',
        pb.view.frame !== null && pb.view.frame >= peak,
        `화면 ${String(pb.view.frame)} / 봉우리 ${peak}`,
      );
      check('워커가 음수를 준 사실이 계측기에 남는다',
        pb.stats.negativeFrames > 0, `negativeFrames=${pb.stats.negativeFrames}`);

      // ── ③ reset 은 maxFrame 만 되돌린다 ────────────────────
      await pb.reset();
      const afterReset = await pb.syncFromWorker();
      note('리셋 직후 워커', `frame=${String(afterReset?.frame)} maxFrame=${String(afterReset?.maxFrame)}`);
      check(
        '★★ 모형 ③ — reset 은 maxFrame 을 -1 로 되돌린다',
        afterReset?.maxFrame === -1, `maxFrame=${String(afterReset?.maxFrame)}`,
      );
      check(
        '★★★ 그래서 화면의 프레임이 비워진다 ("마지막 유효값 보관" 이면 봉우리가 남는다)',
        pb.view.frame === null && !pb.view.text.includes('프레임'),
        `frame=${String(pb.view.frame)} · "${pb.view.text}"`,
      );

      // ── ⑤ step 은 아무 일도 하지 않는다 (관찰) ──────────────
      const before = (await pb.syncFromWorker())?.maxFrame ?? -1;
      await pb.step();
      await sleep(700);
      const afterStep = await pb.syncFromWorker();
      note(
        'step 의 실제 거동',
        `응답은 step / 되물으면 mode=${String(afterStep?.mode)},`
        + ` maxFrame ${before} → ${String(afterStep?.maxFrame)}`
        + `${before === afterStep?.maxFrame ? ' (변화 없음 — 실측과 같다)' : ' ★ 워커가 고쳐진 것 같다'}`,
      );
      check(
        '★★ step 뒤에도 화면이 워커와 어긋나지 않는다 (no-op 이든 아니든)',
        pb.view.playing === (afterStep?.mode === 'play'),
        `화면 playing=${String(pb.view.playing)} / 워커 mode=${String(afterStep?.mode)}`,
      );

      // ── 씬은 남았다 / 내린다 ────────────────────────────────
      check('모형 ④ — reset·step 을 지나도 씬은 워커에 남아 있다',
        afterStep?.loaded === true, String(afterStep?.loaded));
      await pb.clear();
      const cleared = await pb.syncFromWorker();
      check(
        '★ clear 뒤 화면은 씬 없음이고 버튼이 잠긴다 (reset 과 다르다)',
        pb.state === 'noScene' && !pb.view.canPlay && pb.view.frame === null,
        `state=${pb.state} canPlay=${String(pb.view.canPlay)}`,
      );
      check(
        '★★ 되묻기가 내려간 씬을 되살리지 않는다 (status.loaded 로 씬을 만들어내지 않는다)',
        pb.view.scene === null, String(pb.view.scene),
      );
      // ⚠️ 실제 워커의 quirk — 아래 값은 `false` 가 아니다.
      note(
        '⚠ 워커 quirk',
        `clear 를 보낸 뒤에도 status.loaded=${String(cleared?.loaded)} 다`
        + ' — ZestManager::Clear() 가 IsLoadedZls() 를 되돌리지 않는다'
        + ' (protocol.cpp:559-566 이 Clear 를 부르고 :604 가 그 플래그를 읽는다).'
        + ' 화면은 clear op 의 성공으로 씬을 내리므로 지금은 영향이 없지만,'
        + ' "워커에 씬이 있는가" 를 이 필드로 판정하는 코드를 새로 쓰면 안 된다',
      );

      // ── 대조군: 정상 경로 내내 믿음이 사실과 갈라지지 않았다 ─
      check(
        '★★★ 대조군 — 로드·재생·정지·리셋·스텝·clear 를 지나는 동안 corrections 가 0 이다',
        pb.stats.corrections === 0, `corrections=${pb.stats.corrections}`,
      );
      check(
        '★★ 그 전 구간에서 subscribe 는 1회다 (세션당 한 번)',
        pb.stats.subscribes === 1, `subscribes=${pb.stats.subscribes}`,
      );
      check('op 이 하나도 실패하지 않았다',
        pb.stats.failures === 0 && pb.stats.rejected === 0,
        `failures=${pb.stats.failures} rejected=${pb.stats.rejected}`);
      note(
        '실제 워커 계측기',
        `plays=${pb.stats.plays} pauses=${pb.stats.pauses} resets=${pb.stats.resets}`
        + ` clears=${pb.stats.clears} steps=${pb.stats.steps} syncs=${pb.stats.syncs}`
        + ` negativeFrames=${pb.stats.negativeFrames} corrections=${pb.stats.corrections}`,
      );
    } catch (err: unknown) {
      check('실제 워커로 모형 검증', false, messageOf(err));
    } finally {
      await client.close().catch(() => {});
    }
  }, { sessions: { idleTimeout: 0, requestTimeoutMs: 120_000 } });
}

// ─────────────────────────────────────────────────────────────
// §11. 파라미터 스키마 (#16-a) — 이름 하나가 어긋나면 화면이 조용해진다
//
// `panels/params.ts` 는 표 하나로 위젯·페이로드·검증을 전부 덮는다. 그래서
// **표가 틀리면 전부 틀린다.** 여기서 겨냥하는 것은 세 가지다:
//
//   ① 키 이름 — 한 글자만 달라도 워커는 `unknown` 으로 되돌려주고 화면은
//      아무 말도 안 한다. 정본은 `backend/native/src/protocol.cpp` 의
//      `ReadParams`/`ApplyParams` 이므로 **그 파일을 읽어 대조한다.**
//      스키마 쪽에 22개를 손으로 베껴 두면 둘이 같이 틀릴 수 있다.
//   ② 죽은 필드가 페이로드에 새어 들어가는 것 — 그러면 워커가 "적용됨" 으로
//      답하고 화면이 그 거짓말을 그대로 옮긴다 (ISSUE-014 §전수 측정).
//   ③ 비활성인데 이유가 없는 것 — #14 가 없애려던 바로 그 거짓말이다.
//
// ── 무엇을 고정하고 무엇을 고정하지 않았는가 ────────────────
//
// **고정한다(계약)**: 키 22개와 그 이름 · 분류 17/3/2 와 그 소속 · 죽은 필드가
// 페이로드에 없다 · `requires`/`lockedWhenSimInit` 이 붙는 필드 · 열거형 값이
// 엔진 enum 의 인덱스와 같다 · 비활성 사유의 우선순위와 문구의 존재 ·
// **ISSUE-014 가 실측한 기본값 22개**.
//
// **고정하지 않는다(현재 값)**: min/max/step 의 숫자 · 라벨/설명/note 의 문장.
// 이것들은 조정될 수 있고, 조정할 때마다 테스트가 빨개지면 사람이 무심코
// 테스트를 고치게 된다. 대신 **불변식**으로 본다 — min<max, fallback 이 범위
// 안, int 는 정수 경계, 실측 기본값이 범위 밖으로 잘려 나가지 않는다.
// 범위를 좁혀 실측값이 잘리면 그때 빨개진다. 그건 진짜 결함이다.
// ─────────────────────────────────────────────────────────────

const PROTOCOL_CPP = path.resolve(ROOT, 'backend/native/src/protocol.cpp');

/** C++ 함수 본문을 중괄호 깊이로 잘라 낸다. 정규식이 옆 함수까지 먹지 않게 */
function cppBody(src: string, signature: string): string {
  const at = src.indexOf(signature);
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

/**
 * 워커가 각 키를 어느 타입으로 꺼내는가 — `F`=float `I`=int `B`=bool.
 * `ApplyParams` 를 한 번만 읽어 캐시한다. §11-1(이름 대조)과 §11-3(소수 왕복)이
 * 같은 출처를 본다 — 표를 두 벌 두면 그 둘이 어긋날 수 있다.
 */
let workerKindCache: Map<string, string> | null = null;
function workerParamKinds(): Map<string, string> {
  if (workerKindCache !== null) return workerKindCache;
  const m = new Map<string, string>();
  if (existsSync(PROTOCOL_CPP)) {
    const body = cppBody(readFileSync(PROTOCOL_CPP, 'utf8'), 'void ApplyParams');
    for (const x of body.matchAll(/k == "(\w+)"\)\s*([FIB])\(/g)) m.set(x[1] ?? '', x[2] ?? '');
  }
  workerKindCache = m;
  return m;
}

/**
 * 스키마의 `kind` ↔ 워커가 쓰는 꺼내기 함수의 **정확한** 대응.
 *
 * ★ `int → F` 를 한때 "안전" 으로 봤다(`timeStep` 이 그랬다). 아니다. 워커가
 *   float 로 읽는 필드를 스키마가 정수로 다루면 **워커가 준 소수를 UI 가
 *   반올림해 되돌려보낸다** — 사용자가 만지지도 않은 값이 바뀐다. 대응은
 *   양방향이어야 한다.
 */
const WORKER_KIND: Readonly<Record<string, string>> = {
  bool: 'B', enum: 'I', int: 'I', float: 'F',
};

/**
 * **[실측] ISSUE-014 §전수 측정(2026-08-09)의 기준선이다.**
 * `W_Bra top & Leggings.zls` 로드 직후 `getParams()` 가 준 22개 값.
 *
 * ★ 이 표는 **스키마가 아니라 측정을 고정한다.** 스키마의 min/max 를 조정해도
 *   이 숫자는 안 바뀐다 — 오히려 조정한 범위가 이 값을 잘라내면 그게 결함이다.
 *   워커가 준 값을 UI 가 클램프해 되돌려보내면 사용자가 만지지도 않은 값이
 *   바뀌고, 그 변경은 화면 어디에도 안 남는다.
 */
const MEASURED_DEFAULTS: Readonly<Record<string, ParamValue>> = {
  timeStep: 45,
  subStep: 1,
  drapingTime: 0.4,
  gravityY: -980,
  groundPlane: true,
  groundFriction: 0.2,
  groundMargin: 0.5,
  useWind: false,
  windMagnitude: 30,
  solverType: 0,
  preconditioner: 2,
  nonlinearIterations: 1,
  maxSolverIterations: 600,
  solverTolerance: 1e-4,
  useIEQS: false,
  staticCouplingMethod: 4,
  dynamicCouplingMethod: 3,
  dynCouplingStiffness: 750,
  dynCouplingDamping: 0.1,
  untanglingStiffness: 20000,
  untanglingDamping: 250,
  meshingEdgeLength: 1,
};

/** ISSUE-014 의 분류. 여기 적힌 것이 사실이고 스키마가 따라와야 한다 */
const DEAD_KEYS = ['subStep', 'meshingEdgeLength'];
const CONDITIONAL_KEYS = ['groundPlane', 'groundFriction', 'windMagnitude'];

function sortedKeys(v: readonly string[]): string {
  return [...v].sort().join(',');
}

/** **스키마 자신의 규칙으로** 값이 유효한지 본다. 숫자를 베껴 두지 않는다 */
function validForField(field: ParamField, v: ParamValue): boolean {
  if (field.kind === 'bool') return typeof v === 'boolean';
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  if (field.kind === 'enum') return (field.options ?? []).some((o) => o.value === v);
  if (field.kind === 'int' && !Number.isInteger(v)) return false;
  if (field.min !== null && v < field.min) return false;
  if (field.max !== null && v > field.max) return false;
  return true;
}

// ── §11-1. 워커 프로토콜과 이름이 같은가 ─────────────────────
//
// 이 절만이 "스키마가 실재를 가리키는가" 를 본다. 나머지 절은 전부 스키마
// 안에서의 일관성이라, 22개를 통째로 잘못 베꼈어도 통과한다.

function sectionParamKeys(): void {
  section('§11-1. 워커 프로토콜과 키 이름 대조 (protocol.cpp 를 읽는다)');

  if (!existsSync(PROTOCOL_CPP)) {
    check('protocol.cpp 를 찾았다', false, PROTOCOL_CPP);
    return;
  }
  const src = readFileSync(PROTOCOL_CPP, 'utf8');
  const readBody = cppBody(src, 'json ReadParams');
  const applyBody = cppBody(src, 'void ApplyParams');

  const readKeys = [...readBody.matchAll(/\{\s*"(\w+)"\s*,/g)].map((m) => m[1] ?? '');
  const applyPairs = [...applyBody.matchAll(/k == "(\w+)"\)\s*([FIB])\(/g)]
    .map((m) => ({ key: m[1] ?? '', kind: m[2] ?? '' }));

  // 대조군 — 정규식이 아무것도 못 잡으면 아래 집합 비교가 "둘 다 비었으니 같다"
  // 로 통과해버린다. 개수를 먼저 못 박는다.
  check(
    '★ 대조군: protocol.cpp 에서 22개를 실제로 파싱했다 (정규식이 헛돌면 여기서 걸린다)',
    readKeys.length === 22 && applyPairs.length === 22,
    `ReadParams=${readKeys.length}개, ApplyParams=${applyPairs.length}개`,
  );

  const schemaKeys = PARAM_FIELDS.map((f) => String(f.key));
  const missing = readKeys.filter((k) => !schemaKeys.includes(k));
  const extra = schemaKeys.filter((k) => !readKeys.includes(k));
  check(
    '★★ 스키마 키 22개가 워커 `ReadParams` 와 정확히 같다 (한 글자만 달라도 워커가 unknown 으로 되돌린다)',
    missing.length === 0 && extra.length === 0 && schemaKeys.length === 22,
    missing.length + extra.length === 0
      ? `${schemaKeys.length}/22 일치`
      : `스키마에 없음=[${missing.join(',')}] 워커에 없음=[${extra.join(',')}]`,
  );

  const applyKeys = applyPairs.map((p) => p.key);
  check(
    '워커의 읽기(ReadParams)와 쓰기(ApplyParams)가 같은 이름을 쓴다 — 읽히는데 안 써지는 키가 없다',
    sortedKeys(readKeys) === sortedKeys(applyKeys),
    `${applyKeys.length}개`,
  );

  // ── 타입 대조 ──────────────────────────────────────────────
  //
  // 워커는 `v.get<bool>()`/`get<int>()`/`get<float>()` 로 꺼낸다. 두 방향으로
  // 아프다: bool 자리에 숫자를 보내면 nlohmann 이 던져 요청 하나가 통째로
  // 실패하고, **워커가 float 로 읽는 필드를 스키마가 int 로 다루면 워커가 준
  // 소수를 UI 가 반올림해 되돌려보낸다**(§11-3 이 그 왕복을 실제로 돌려 본다).
  // 그래서 대응을 **정확히** 본다 — 한쪽으로만 느슨하게 두지 않는다.
  const kindOf = workerParamKinds();
  const wrongKind = PARAM_FIELDS.filter((f) => {
    const w = kindOf.get(String(f.key));
    if (w === undefined) return false;              // 위 검사에서 이미 잡힌다
    return w !== WORKER_KIND[f.kind];
  });
  check(
    '★★ 스키마의 kind 가 워커가 꺼내는 타입과 **정확히** 대응한다 (bool⇔B · enum⇒I · int⇔I · float⇔F)',
    wrongKind.length === 0 && kindOf.size === 22,
    wrongKind.map((f) => `${String(f.key)}:${f.kind}→${WORKER_KIND[f.kind] ?? '?'} 인데 워커는 ${kindOf.get(String(f.key)) ?? '?'}`).join(', ')
    || `${PARAM_FIELDS.length}/22`,
  );
  check(
    '★ timeStep 은 float 이다 — 데스크톱이 매 프레임 `(int)` 로 자르는 것(MainGUI.cpp:393-395)은 그쪽 결함이고, 엔진·프로토콜의 타입은 float 이다',
    PARAM_BY_KEY['timeStep']?.kind === 'float' && kindOf.get('timeStep') === 'F',
    `스키마=${String(PARAM_BY_KEY['timeStep']?.kind)} / 워커=${kindOf.get('timeStep') ?? '?'}`,
  );
  note('applyPairs', `${applyPairs.length}쌍을 §11-1 이 직접 파싱했고 캐시(${kindOf.size}개)와 같은 출처다`);

  if (sortedKeys(readKeys) === sortedKeys(schemaKeys)) {
    note('순서', readKeys.join(',') === schemaKeys.join(',')
      ? '스키마 나열 순서가 protocol.cpp 와 같다 (우연이다 — 그룹을 다시 묶으면 갈라진다. 판정 안 함)'
      : '스키마 나열 순서가 protocol.cpp 와 다르다 (문제 아님 — 그룹으로 다시 묶었다)');
  }
}

// ── §11-2. 분류가 측정과 일치하는가 + 표의 불변식 ────────────

function sectionParamSchema(): void {
  section('§11-2. 스키마 분류와 불변식 (ISSUE-014 전수 측정)');

  check('필드가 22개다', PARAM_FIELDS.length === 22, `${PARAM_FIELDS.length}개`);
  check(
    '★ 대조군: 키가 중복되지 않는다 (PARAM_BY_KEY 가 Object.fromEntries 라 중복은 조용히 덮인다)',
    Object.keys(PARAM_BY_KEY).length === PARAM_FIELDS.length,
    `BY_KEY=${Object.keys(PARAM_BY_KEY).length}개`,
  );
  check(
    'PARAM_BY_KEY 가 PARAM_FIELDS 와 같은 객체를 가리킨다 (둘이 갈라질 수 없다)',
    PARAM_FIELDS.every((f) => PARAM_BY_KEY[f.key] === f),
    `${PARAM_FIELDS.length}/22`,
  );

  const dead = PARAM_FIELDS.filter((f) => f.effect === 'dead').map((f) => String(f.key));
  const cond = PARAM_FIELDS.filter((f) => f.effect === 'conditional').map((f) => String(f.key));
  const eff = PARAM_FIELDS.filter((f) => f.effect === 'effective');
  check(
    '★★ 죽은 필드가 정확히 subStep · meshingEdgeLength 다 (ISSUE-014 §전수 측정 ③)',
    sortedKeys(dead) === sortedKeys(DEAD_KEYS), dead.join(',') || '없음',
  );
  check(
    '★ 조건부가 정확히 groundPlane · groundFriction · windMagnitude 다 (같은 §의 ①②)',
    sortedKeys(cond) === sortedKeys(CONDITIONAL_KEYS), cond.join(',') || '없음',
  );
  check('반영됨이 17개다 (17/3/2 로 갈린다)', eff.length === 17, `${eff.length}개`);

  // ── requires / lockedWhenSimInit — 붙는 자리가 하나씩뿐이다 ──
  const requiring = PARAM_FIELDS.filter((f) => f.requires !== null);
  check(
    '★★ `requires` 를 쓰는 필드는 windMagnitude 하나이고 게이트가 useWind 다 (측정에서 63배로 갈렸다)',
    requiring.length === 1 && String(requiring[0]?.key) === 'windMagnitude'
    && String(requiring[0]?.requires) === 'useWind',
    requiring.map((f) => `${String(f.key)}→${String(f.requires)}`).join(', ') || '없음',
  );
  check(
    '게이트가 스키마에 실재하고 bool 이다 (없는 키를 가리키면 영원히 비활성이 된다)',
    requiring.every((f) => {
      const gate = f.requires === null ? undefined : PARAM_BY_KEY[f.requires];
      return gate !== undefined && gate.kind === 'bool';
    }),
    'useWind: bool',
  );
  const locked = PARAM_FIELDS.filter((f) => f.lockedWhenSimInit);
  check(
    '★ `lockedWhenSimInit` 은 solverType 하나다 (MainGUI.cpp:459 가 그 하나만 감춘다)',
    locked.length === 1 && String(locked[0]?.key) === 'solverType',
    locked.map((f) => String(f.key)).join(', ') || '없음',
  );
  check(
    '죽은 필드에는 잠금·종속이 겹치지 않는다 (겹치면 화면이 이유를 하나만 말한다)',
    PARAM_FIELDS.filter((f) => f.effect === 'dead')
      .every((f) => !f.lockedWhenSimInit && f.requires === null),
    `${dead.length}개 확인`,
  );

  // ── 표의 불변식 — 숫자를 베끼지 않고 관계만 본다 ────────────
  const badText = PARAM_FIELDS.filter(
    (f) => f.label.trim() === '' || f.description.trim() === '' || (f.note !== null && f.note.trim() === ''),
  );
  check('모든 필드에 라벨과 설명이 있다 (화면에 빈 칸이 안 생긴다)',
    badText.length === 0, badText.map((f) => String(f.key)).join(', ') || `${PARAM_FIELDS.length}/22`);
  check('죽은 필드·조건부 필드에는 note 가 있다 (왜 그런지가 화면에 남는다)',
    PARAM_FIELDS.filter((f) => f.effect !== 'effective').every((f) => f.note !== null && f.note.length > 5),
    `${dead.length + cond.length}개`);

  const badShape = PARAM_FIELDS.filter((f) => {
    if (f.kind === 'int' || f.kind === 'float') return f.min === null || f.max === null || f.options !== null;
    if (f.kind === 'enum') return f.min !== null || f.max !== null || f.options === null;
    return f.min !== null || f.max !== null || f.options !== null;   // bool
  });
  check('숫자 필드에만 min/max 가 있고 enum 에만 options 가 있다',
    badShape.length === 0, badShape.map((f) => String(f.key)).join(', ') || `${PARAM_FIELDS.length}/22`);

  const badRange = PARAM_FIELDS.filter((f) => {
    if (f.min === null || f.max === null) return false;
    if (!(f.min < f.max)) return true;
    if (typeof f.fallback !== 'number') return true;
    if (f.fallback < f.min || f.fallback > f.max) return true;
    if (f.step !== null && !(f.step > 0)) return true;
    if (f.kind === 'int' && !(Number.isInteger(f.min) && Number.isInteger(f.max)
      && Number.isInteger(f.fallback) && (f.step === null || Number.isInteger(f.step)))) return true;
    return false;
  });
  check(
    '★ min<max · fallback 이 범위 안 · step>0 · int 는 경계까지 정수다',
    badRange.length === 0,
    badRange.map((f) => `${String(f.key)}[${String(f.min)},${String(f.max)}]f=${String(f.fallback)}`).join(', ')
    || `${PARAM_FIELDS.filter((f) => f.min !== null).length}개 숫자 필드`,
  );

  // ── 열거형 — 값이 인덱스와 같아야 라벨이 안 밀린다 ──────────
  const enums = PARAM_FIELDS.filter((f) => f.kind === 'enum');
  const badEnum = enums.filter((f) => {
    const o = f.options ?? [];
    if (o.length === 0) return true;
    if (!o.every((x, i) => x.value === i)) return true;        // 값 = 인덱스
    if (!o.every((x) => x.label.trim() !== '')) return true;
    return !o.some((x) => x.value === f.fallback);
  });
  check(
    '★★ 열거형 값이 0..n-1 인덱스와 같고 fallback 이 선택지에 있다 (데스크톱이 콤보 인덱스를 그대로 대입한다 — 어긋나면 라벨이 한 칸씩 밀린다)',
    badEnum.length === 0 && enums.length === 4,
    badEnum.map((f) => String(f.key)).join(', ') || `${enums.length}개 열거형`,
  );

  // 라벨 문장 전체를 스냅샷으로 박지 않는다 — 대신 **엔진 enum 의 의미**에만
  // 앵커를 건다. 배열을 한 칸 밀면 값은 그대로 0..n-1 이라 위 검사는 통과한다.
  const labelOf = (key: ParamKey, value: number): string =>
    (PARAM_BY_KEY[key]?.options ?? []).find((o) => o.value === value)?.label ?? '';
  check(
    '★★ 전처리기 라벨이 엔진 enum 의 자리와 맞는다 (0=IDENTITY, 2=BLOCK_JACOBI)',
    labelOf('preconditioner', 0).includes('Identity') && labelOf('preconditioner', 2).includes('Block'),
    `0=${labelOf('preconditioner', 0)} / 2=${labelOf('preconditioner', 2)}`,
  );
  check(
    '★★ 커플링 라벨이 엔진 enum 의 자리와 맞는다 (0=NONE, 3=PENALTY, 4=PROJECTIVE — 실측 기본값 static=4·dynamic=3 이 데스크톱의 "권장"과 맞아떨어진다)',
    labelOf('staticCouplingMethod', 0) === '없음'
    && labelOf('staticCouplingMethod', 3).includes('페널티')
    && labelOf('staticCouplingMethod', 4).includes('투영')
    && labelOf('dynamicCouplingMethod', 3).includes('페널티'),
    `3=${labelOf('staticCouplingMethod', 3)} / 4=${labelOf('staticCouplingMethod', 4)}`,
  );
  check(
    '★ 적분기 라벨이 밀리지 않았다 (2=XPBD. 데스크톱은 3·4 배정밀도를 노출하지 않는다)',
    labelOf('solverType', 2).includes('XPBD') && (PARAM_BY_KEY['solverType']?.options ?? []).length === 3,
    `2=${labelOf('solverType', 2)}`,
  );
  check(
    '★ 충돌 솔버(Gauss-Seidel/Jacobi/ICA)가 solverType 에 섞이지 않았다 (MainGUI 의 필드 충돌 버그를 옮기지 않는다)',
    !(PARAM_BY_KEY['solverType']?.options ?? []).some(
      (o) => /gauss|jacobi|ica/i.test(o.label)),
    (PARAM_BY_KEY['solverType']?.options ?? []).map((o) => o.label).join(' / '),
  );

  // ── 그룹 ───────────────────────────────────────────────────
  const groups = paramGroups();
  const flat = groups.flatMap((g) => g.fields);
  check('그룹으로 묶어도 필드가 하나도 안 사라지고 안 늘어난다',
    flat.length === PARAM_FIELDS.length && PARAM_FIELDS.every((f) => flat.filter((x) => x === f).length === 1),
    `${flat.length}개 / ${groups.length}그룹`);
  check('빈 그룹은 안 나오고, 순서가 PARAM_GROUP_ORDER 의 부분수열이다',
    groups.every((g) => g.fields.length > 0)
    && groups.map((g) => g.group).join(',')
      === PARAM_GROUP_ORDER.filter((g) => groups.some((x) => x.group === g)).join(','),
    groups.map((g) => `${g.group}:${g.fields.length}`).join(' '));
  check('그룹 헤더 글자가 PARAM_GROUP_LABELS 에서만 온다 (화면과 표가 갈라지지 않는다)',
    groups.every((g) => g.label === PARAM_GROUP_LABELS[g.group]),
    groups.map((g) => g.label).join('/'));
  check('★ 대조군: PARAM_GROUP_ORDER 와 PARAM_GROUP_LABELS 의 키가 같다 (라벨 없는 그룹은 undefined 헤더가 된다)',
    sortedKeys(PARAM_GROUP_ORDER as readonly string[]) === sortedKeys(Object.keys(PARAM_GROUP_LABELS)),
    `${PARAM_GROUP_ORDER.length}개`);
  check('모든 필드의 group 이 PARAM_GROUP_ORDER 안에 있다',
    PARAM_FIELDS.every((f) => (PARAM_GROUP_ORDER as readonly string[]).includes(f.group)),
    `${PARAM_FIELDS.length}/22`);

  const fb = fallbackParamValues();
  check('fallbackParamValues() 가 22개를 전부 채운다 (위젯이 값 없이 그려지지 않는다)',
    Object.keys(fb).length === 22 && PARAM_FIELDS.every((f) => fb[f.key] === f.fallback),
    `${Object.keys(fb).length}개`);
}

// ── §11-3. 실측 기본값 — 측정을 고정한다 ─────────────────────
//
// 사용자가 첫 화면에서 겪는 경로는 정확히 이것이다: 워커가 `getParams` 로 준
// 값을 화면이 받아 들고, 사용자가 슬라이더 **하나**를 만지고, 그 결과가
// `setParams` 로 돌아간다. 이 왕복에서 **만지지 않은 값이 달라지면 안 된다.**

function sectionParamMeasured(): void {
  section('§11-3. 실측 기본값과 왕복 안정성 (ISSUE-014 기준선)');

  const schemaKeys = PARAM_FIELDS.map((f) => String(f.key));
  check(
    '★ 대조군: 실측 표가 스키마 22개를 그대로 덮는다 (표가 낡으면 아래가 전부 헛돈다)',
    sortedKeys(Object.keys(MEASURED_DEFAULTS)) === sortedKeys(schemaKeys),
    `${Object.keys(MEASURED_DEFAULTS).length}개`,
  );

  // ★ 이 절의 핵심. 스키마가 실측값을 잘라내면 사용자가 만지지도 않은 값이 바뀐다.
  const clipped = PARAM_FIELDS.filter((f) => !coerceParamValue(f, MEASURED_DEFAULTS[String(f.key)]).ok);
  check(
    '★★ 실측 기본값 22개가 전부 스키마 범위 안이다 — 손대지 않고 통과한다',
    clipped.length === 0,
    clipped.map((f) => {
      const c = coerceParamValue(f, MEASURED_DEFAULTS[String(f.key)]);
      return `${String(f.key)}: ${String(MEASURED_DEFAULTS[String(f.key)])}→${String(c.value)}`;
    }).join(', ') || '22/22',
  );

  const fbDiff = PARAM_FIELDS.filter((f) => f.fallback !== MEASURED_DEFAULTS[String(f.key)]);
  check(
    'fallback 이 실측치와 같다 (params.ts 머리말이 그렇게 주장한다)',
    fbDiff.length === 0,
    fbDiff.map((f) => `${String(f.key)}: ${String(f.fallback)}≠${String(MEASURED_DEFAULTS[String(f.key)])}`).join(', ')
    || '22/22',
  );

  // ── 왕복: 워커가 준 값 → 화면 → 다시 워커 ──────────────────
  const read = readParamValues(MEASURED_DEFAULTS);
  check('readParamValues 가 워커의 22개를 하나도 안 흘린다',
    Object.keys(read).length === 22, `${Object.keys(read).length}개`);

  // 워커가 언젠가 문자열이나 객체를 실어 보내면(프로토콜 확장·버그) 그 값이
  // 화면 상태로 들어가 그대로 setParams 로 되돌아간다. 여기서 잘라야 한다.
  const dirty = readParamValues({
    timeStep: '45', useWind: 'true', gravityY: null, drapingTime: {},
    solverType: [0], preconditioner: undefined, subStep: 2, groundPlane: true,
    없는키: 1, __proto__: 9,
  } as unknown as Record<string, unknown>);
  check(
    '★★ readParamValues 는 아는 키 + number|boolean 만 통과시킨다 (문자열 "45" 가 상태에 들어가면 그대로 워커로 되돌아간다)',
    sortedKeys(Object.keys(dirty)) === sortedKeys(['subStep', 'groundPlane'])
    && dirty.subStep === 2 && dirty.groundPlane === true,
    JSON.stringify(dirty),
  );
  check(
    '★ 워커가 빠뜨린 키를 fallback 으로 메우지 않는다 (없는 것을 있는 것처럼 그리지 않는다)',
    Object.keys(readParamValues({})).length === 0
    && Object.keys(readParamValues({ timeStep: 45 })).length === 1,
    '{} → {} · {timeStep} → 1개',
  );

  const round = buildSetParamsPayload(read);
  const changedByRoundTrip = Object.entries(round.payload)
    .filter(([k, v]) => v !== MEASURED_DEFAULTS[k]);
  check(
    '★★ 아무것도 안 만졌는데 값이 달라지지 않는다 (getParams → setParams 왕복)',
    changedByRoundTrip.length === 0 && round.adjusted.length === 0,
    changedByRoundTrip.map(([k, v]) => `${k}: ${String(MEASURED_DEFAULTS[k])}→${String(v)}`).join(', ')
    || `${Object.keys(round.payload).length}개 그대로`,
  );
  check(
    '★★ 그 왕복에서 죽은 필드 2개만 빠지고 dropped 로 보고된다',
    Object.keys(round.payload).length === 20
    && sortedKeys(round.dropped.map(String)) === sortedKeys(DEAD_KEYS)
    && round.unknown.length === 0,
    `payload=${Object.keys(round.payload).length} dropped=[${round.dropped.join(',')}] unknown=[${round.unknown.join(',')}]`,
  );

  // ── ★ 소수가 왕복에서 살아남는가 ──────────────────────────
  //
  // 워커가 `get<float>()` 로 읽는 필드는 씬에 따라 **소수를 들고 온다.**
  // 스키마가 그걸 정수로 다루면 화면을 여는 것만으로 값이 반올림돼 되돌아간다.
  // 데스크톱이 정확히 그 결함을 갖고 있고(`MainGUI.cpp:393-395` 가 조건 없이
  // 매 프레임 `(int)` 로 자른다) 우리는 그걸 옮기지 않기로 했다.
  //
  // 필드 이름을 손으로 적지 않고 **워커가 F 로 읽는 필드 전부**를 돈다 —
  // 나중에 어떤 필드가 int 로 되돌려져도 여기서 걸린다.
  const floatKeys = PARAM_FIELDS.filter(
    (f) => workerParamKinds().get(String(f.key)) === 'F' && f.effect !== 'dead');
  const fractional: Record<string, number> = {};
  for (const f of floatKeys) {
    const lo = f.min ?? 0;
    const hi = f.max ?? 1;
    const mid = (lo + hi) / 2;
    fractional[String(f.key)] = Number.isInteger(mid) ? mid + 0.5 : mid;
  }
  check('★ 대조군: 워커가 실수로 읽는 필드를 실제로 골라냈다 (0개면 아래가 헛돈다)',
    floatKeys.length > 0 && Object.values(fractional).every((v) => !Number.isInteger(v)),
    `${floatKeys.length}개`);
  const fracOut = buildSetParamsPayload(fractional);
  const lost = Object.entries(fractional).filter(([k, v]) => fracOut.payload[k] !== v);
  check(
    '★★★ 워커가 실수로 읽는 필드는 소수가 왕복에서 그대로 살아남는다 (스키마가 int 로 다루면 사용자가 만지지도 않은 값이 반올림돼 돌아간다)',
    lost.length === 0 && fracOut.adjusted.length === 0,
    lost.map(([k, v]) => `${k}: ${v}→${String(fracOut.payload[k])}`).join(', ') || `${floatKeys.length}개 그대로`,
  );
  const ts = PARAM_BY_KEY['timeStep'];
  const tsRound = ts === undefined ? null : buildSetParamsPayload(
    readParamValues({ ...MEASURED_DEFAULTS, timeStep: 33.5 }));
  check(
    '★★ 소수 타임스텝을 가진 씬이 와도 값이 안 잘린다 (33.5Hz → 33.5)',
    ts !== undefined && coerceParamValue(ts, 45.5).ok && coerceParamValue(ts, 45.5).value === 45.5
    && tsRound?.payload['timeStep'] === 33.5 && tsRound.adjusted.length === 0,
    `coerce(45.5)=${String(ts === undefined ? '?' : coerceParamValue(ts, 45.5).value)} / 왕복=${String(tsRound?.payload['timeStep'])}`,
  );

  check('changedParams: 같은 값이면 아무것도 안 보낸다 (applied 가 22개로 도배되지 않는다)',
    Object.keys(changedParams(read, read)).length === 0, '{}');
  const one = changedParams(read, { ...read, timeStep: 60 });
  check('changedParams: 하나 만지면 하나만 나온다',
    Object.keys(one).length === 1 && one.timeStep === 60, JSON.stringify(one));
  const fresh = changedParams({}, { timeStep: 60 });
  check('changedParams: current 에 없던 키는 바뀐 것으로 본다 (워커가 안 준 필드를 우리가 처음 정하는 경우)',
    Object.keys(fresh).length === 1 && fresh.timeStep === 60, JSON.stringify(fresh));
  check('changedParams: 스키마에 없는 키는 통과하지 못한다',
    Object.keys(changedParams({}, { 없는키: 1 } as never)).length === 0, '{}');
  check('changedParams: false → true 도 변경이다 (0/false 를 undefined 로 오해하지 않는다)',
    changedParams({ useWind: false }, { useWind: true }).useWind === true
    && Object.keys(changedParams({ groundPlane: true }, { groundPlane: false })).length === 1,
    'bool 양방향');
}

// ── §11-4. coerce — 던지지 않고 항상 유효한 값을 준다 ────────
//
// 입력 이벤트 핸들러에서 도는 함수다. 던지면 화면에 단서가 하나도 안 남고,
// 유효하지 않은 값을 돌려주면 그 값이 그대로 워커로 간다.

function sectionParamCoerce(): void {
  section('§11-4. coerceParamValue — 던지지 않고 항상 유효 (22 × 적대적 입력)');

  const hostile: [string, unknown][] = [
    ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity],
    ['null', null], ['undefined', undefined],
    ['빈 문자열', ''], ['문자열', 'abc'], ['숫자꼴 문자열', '45'],
    ['객체', {}], ['배열', []], ['배열(값1개)', [1]],
    ['true', true], ['false', false],
    ['-1e30', -1e30], ['1e30', 1e30], ['0', 0], ['-0', -0],
    ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER], ['1e-323', 1e-323],
    ['bigint', 10n], ['심볼', Symbol('x')], ['함수', () => 1],
  ];

  const threw: string[] = [];
  const invalid: string[] = [];
  const contract: string[] = [];
  for (const f of PARAM_FIELDS) {
    for (const [label, raw] of hostile) {
      try {
        const c = coerceParamValue(f, raw);
        if (!validForField(f, c.value)) invalid.push(`${String(f.key)}/${label}→${String(c.value)}`);
        if ((c.ok && c.reason !== null) || (!c.ok && c.reason === null)) {
          contract.push(`${String(f.key)}/${label}`);
        }
      } catch (err: unknown) {
        threw.push(`${String(f.key)}/${label}: ${messageOf(err)}`);
      }
    }
  }
  check(`★★ 적대적 입력 ${hostile.length}종 × 22필드에서 한 번도 던지지 않는다`,
    threw.length === 0, threw.slice(0, 3).join(' | ') || `${hostile.length * 22}회`);
  check('★★ 그 모든 경우에 value 가 **그 필드에 유효한 값**이다 (못 고칠 입력이면 fallback)',
    invalid.length === 0, invalid.slice(0, 5).join(' | ') || `${hostile.length * 22}회`);
  check('ok ⇔ reason===null 이 항상 성립한다 (화면이 "왜 바뀌었는지" 를 못 찾는 일이 없다)',
    contract.length === 0, contract.slice(0, 5).join(' | ') || `${hostile.length * 22}회`);

  // ── 대조군: 멀쩡한 값을 뭉개지 않는다 ──────────────────────
  // (전부 fallback 을 돌려주는 구현이면 위 세 검사는 전부 통과한다)
  const untouched = PARAM_FIELDS.filter((f) => {
    const c = coerceParamValue(f, f.fallback);
    return !(c.ok && c.value === f.fallback && c.reason === null);
  });
  check('★ 대조군: 유효한 값은 손대지 않고 그대로 돌려준다',
    untouched.length === 0, untouched.map((f) => String(f.key)).join(', ') || '22/22');
  const mid = PARAM_BY_KEY['maxSolverIterations'];
  check('★ 대조군: fallback 이 아닌 유효값도 그대로 통과한다 (전부 fallback 으로 뭉개는 구현이 아니다)',
    mid !== undefined && coerceParamValue(mid, 123).value === 123 && coerceParamValue(mid, 123).ok,
    '123 → 123');

  // ── 클램프 — 경계 숫자를 베끼지 않고 스키마에서 꺼낸다 ─────
  const numeric = PARAM_FIELDS.filter((f) => f.min !== null && f.max !== null);
  const badLow = numeric.filter((f) => {
    const c = coerceParamValue(f, (f.min ?? 0) - 1);
    return !(c.value === f.min && !c.ok && c.reason !== null);
  });
  const badHigh = numeric.filter((f) => {
    const c = coerceParamValue(f, (f.max ?? 0) + 1);
    return !(c.value === f.max && !c.ok && c.reason !== null);
  });
  check('★★ min 아래는 min 으로, 이유와 함께 (부등호가 뒤집히면 여기서 걸린다)',
    badLow.length === 0, badLow.map((f) => String(f.key)).join(', ') || `${numeric.length}개`);
  check('★★ max 위는 max 로, 이유와 함께',
    badHigh.length === 0, badHigh.map((f) => String(f.key)).join(', ') || `${numeric.length}개`);
  const atEdge = numeric.filter((f) => !coerceParamValue(f, f.min ?? 0).ok || !coerceParamValue(f, f.max ?? 0).ok);
  check('경계값 자체는 유효하다 (min/max 를 배타 구간으로 읽지 않는다)',
    atEdge.length === 0, atEdge.map((f) => String(f.key)).join(', ') || `${numeric.length}개`);

  // ── int 반올림 · float 은 안 한다 ──────────────────────────
  //
  // 개수를 박지 않는다. 어느 필드가 int 인지는 **현재 값**이고(`timeStep` 이
  // int→float 으로 옮겨 갔다), 계약은 "int 는 반올림하고 float 은 안 한다" 다.
  // 대신 양쪽 집합이 비지 않았는지를 대조군으로 둔다 — 한쪽이 비면 그쪽
  // 검사가 조용히 공회전한다.
  const ints = PARAM_FIELDS.filter((f) => f.kind === 'int');
  const floats = PARAM_FIELDS.filter((f) => f.kind === 'float');
  const midOf = (f: ParamField): number => Math.floor(((f.min ?? 0) + (f.max ?? 0)) / 2);
  const badRound = ints.filter((f) => {
    const base = midOf(f);
    return coerceParamValue(f, base + 0.4).value !== base
      || coerceParamValue(f, base + 0.6).value !== base + 1
      || coerceParamValue(f, base + 0.4).ok;      // 고쳤으면 ok 가 아니어야 한다
  });
  check('★ int 필드는 반올림한다 (.4 는 내리고 .6 은 올린다) — 고쳤다고 말하면서',
    badRound.length === 0, badRound.map((f) => String(f.key)).join(', ') || `${ints.length}개 int`);
  const badKeep = floats.filter((f) => {
    const v = midOf(f) + 0.4;
    if (v < (f.min ?? 0) || v > (f.max ?? 0)) return false;
    const c = coerceParamValue(f, v);
    return !(c.ok && c.value === v);
  });
  check('★★ 대조군: float 필드는 소수를 깎지 않는다 (반올림이 온 필드로 번지면 여기서 걸린다)',
    badKeep.length === 0, badKeep.map((f) => String(f.key)).join(', ') || `${floats.length}개 float`);
  check('★ 대조군: int·float 집합이 둘 다 비어 있지 않다 (위 두 검사가 공회전하지 않는다)',
    ints.length > 0 && floats.length > 0, `int ${ints.length}개 / float ${floats.length}개`);

  // ── 사유가 둘이면 둘 다 남는다 ─────────────────────────────
  //
  // int 필드에 `max + 0.6` 을 넣으면 **반올림과 클램프가 함께** 일어난다.
  // 예전 구현은 `reason` 을 덮어써서 뒤에 온 클램프만 남겼고, 그러면 사용자가
  // 넣은 소수가 어디로 갔는지 화면 어디에도 안 남았다.
  //
  // ⚠️ 문구를 통째로 박지 않는다 — 사람이 읽는 글이라 문장이 바뀐다. 대신
  //    **구분자(` · `)로 사유가 몇 개인지**와 **원본 숫자가 문구에 남았는지**만 본다.
  const badBoth = ints.filter((f) => {
    const raw = (f.max ?? 0) + 0.6;
    const c = coerceParamValue(f, raw);
    if (c.value !== f.max || c.ok || c.reason === null) return true;
    if (c.reason.split(' · ').length !== 2) return true;       // 사유 둘
    return !c.reason.includes(String(raw));                    // 원본 소수가 남는다
  });
  check(
    '★★ 반올림 + 클램프가 함께 일어나면 사유가 둘 다 남는다 (하나만 남기면 넣은 소수가 어디로 갔는지 안 보인다)',
    badBoth.length === 0,
    badBoth.map((f) => `${String(f.key)}: "${String(coerceParamValue(f, (f.max ?? 0) + 0.6).reason)}"`).join(' | ')
    || `${ints.length}개 int`,
  );
  const badSingle = floats.filter((f) => {
    const c = coerceParamValue(f, (f.max ?? 0) + 1);
    return c.reason === null || c.reason.split(' · ').length !== 1;
  });
  check(
    '★ 대조군: 사유가 하나면 하나만 남는다 (구분자를 항상 붙이는 구현이 아니다)',
    badSingle.length === 0, badSingle.map((f) => String(f.key)).join(', ') || `${floats.length}개 float`,
  );
  note('두 사유 예시', String(ints[0] === undefined ? '' : coerceParamValue(ints[0], (ints[0].max ?? 0) + 0.6).reason));

  // ── float 은 step 으로 스냅하지 않는다 (step 은 전부 추정이다) ──
  const stepped = PARAM_FIELDS.filter((f) => f.kind === 'float' && f.step !== null);
  const snapped = stepped.filter((f) => {
    const v = (f.min ?? 0) + (f.step ?? 1) * 0.37;
    const c = coerceParamValue(f, v);
    return !(c.ok && c.value === v);
  });
  check(
    '★ float 은 step 격자로 깎지 않는다 (step 은 근거 없는 추정이라 그걸로 사용자 입력을 바꾸면 안 된다)',
    snapped.length === 0, snapped.map((f) => String(f.key)).join(', ') || `${stepped.length}개`,
  );

  // ── enum — 가까운 값으로 붙이지 않는다 ─────────────────────
  const enums = PARAM_FIELDS.filter((f) => f.kind === 'enum');
  const badEnum = enums.filter((f) => {
    const max = Math.max(...(f.options ?? []).map((o) => o.value));
    const over = coerceParamValue(f, max + 1);          // 바로 위 값
    const frac = coerceParamValue(f, 1.5);              // 선택지 사이
    const neg = coerceParamValue(f, -1);
    return over.value !== f.fallback || frac.value !== f.fallback || neg.value !== f.fallback
      || over.ok || frac.ok || neg.ok;
  });
  check(
    '★★ 열거형은 없는 값을 가까운 선택지로 붙이지 않고 fallback 으로 되돌린다 (열거형에서 "가깝다"는 의미가 없다)',
    badEnum.length === 0, badEnum.map((f) => String(f.key)).join(', ') || `${enums.length}개`,
  );
  const okEnum = enums.every((f) => (f.options ?? []).every((o) => {
    const c = coerceParamValue(f, o.value);
    return c.ok && c.value === o.value;
  }));
  check('대조군: 선택지에 있는 값은 전부 그대로 통과한다', okEnum, `${enums.length}개 전 선택지`);

  // ── bool ───────────────────────────────────────────────────
  const bools = PARAM_FIELDS.filter((f) => f.kind === 'bool');
  const badBool = bools.filter((f) => {
    const t = coerceParamValue(f, true);
    const one = coerceParamValue(f, 1);
    const zero = coerceParamValue(f, 0);
    const str = coerceParamValue(f, 'true');
    return !(t.ok && t.value === true)
      || !(one.value === true && !one.ok) || !(zero.value === false && !zero.ok)
      || !(str.value === f.fallback && !str.ok);
  });
  check(
    '★ bool 은 boolean 을 그대로, 0/1 은 변환해 받고, 그 밖(문자열 "true" 포함)은 fallback 이다',
    badBool.length === 0 && bools.length === 3,
    badBool.map((f) => String(f.key)).join(', ') || `${bools.length}개 bool`,
  );
  check(
    '숫자 필드에 boolean 이 오면 받지 않는다 (true 를 1 로 삼키지 않는다)',
    PARAM_FIELDS.filter((f) => f.kind !== 'bool')
      .every((f) => coerceParamValue(f, true).value === f.fallback && !coerceParamValue(f, true).ok),
    '19개 필드',
  );
}

// ── §11-5. 비활성 판정 — 회색이면 반드시 이유가 있다 ─────────

function sectionParamDisabled(): void {
  section('§11-5. 비활성 사유 (회색만 되고 이유가 없으면 그게 #14 의 거짓말이다)');

  const cases: [string, { values: ParamValues; simInitialized: boolean }, string[]][] = [
    ['워커에 붙기 전 (값이 없다)', { values: {}, simInitialized: false },
      ['subStep', 'meshingEdgeLength', 'windMagnitude']],
    ['바람 꺼짐 · 시뮬 전', { values: { useWind: false }, simInitialized: false },
      ['subStep', 'meshingEdgeLength', 'windMagnitude']],
    ['바람 켜짐 · 시뮬 전', { values: { useWind: true }, simInitialized: false },
      ['subStep', 'meshingEdgeLength']],
    ['바람 켜짐 · 시뮬 초기화됨', { values: { useWind: true }, simInitialized: true },
      ['subStep', 'meshingEdgeLength', 'solverType']],
    ['바람 꺼짐 · 시뮬 초기화됨', { values: { useWind: false }, simInitialized: true },
      ['subStep', 'meshingEdgeLength', 'windMagnitude', 'solverType']],
  ];
  for (const [label, ctx, want] of cases) {
    const got = disabledParams(ctx).map((d) => String(d.key));
    check(`비활성 집합 — ${label}`, sortedKeys(got) === sortedKeys(want),
      `[${got.join(',')}] (기대 [${[...want].sort().join(',')}])`);
  }

  check(
    '★ 조건부 3개 중 groundPlane·groundFriction 은 끄지 않는다 (조건을 프런트가 알 수 없다 — 모르면서 끄면 만질 수 있는 걸 못 만지게 된다)',
    !disabledParams({ values: { useWind: true }, simInitialized: false })
      .some((d) => d.key === 'groundPlane' || d.key === 'groundFriction'),
    'groundPlane·groundFriction 활성',
  );

  // ── 문구 ───────────────────────────────────────────────────
  const all = cases.flatMap(([, ctx]) => disabledParams(ctx));
  const mute = all.filter((d) => d.text.trim().length < 8);
  check('★★ 모든 비활성 사유에 사람이 읽을 문구가 있다',
    mute.length === 0, mute.map((d) => `${String(d.key)}:"${d.text}"`).join(', ') || `${all.length}건`);
  check('사유의 key 가 그 필드를 가리킨다 (화면이 엉뚱한 위젯에 회색을 칠하지 않는다)',
    PARAM_FIELDS.every((f) => {
      const d = paramDisabledReason(f, { values: {}, simInitialized: true });
      return d === null || d.key === f.key;
    }), `${PARAM_FIELDS.length}/22`);
  const deadText = all.find((d) => d.cause === 'dead')?.text ?? '';
  check('★ 죽은 필드의 문구가 근거(ISSUE-014)와 "보내지 않는다"를 둘 다 말한다',
    deadText.includes('ISSUE-014') && deadText.includes('전송하지 않'), deadText);
  const depText = all.find((d) => d.cause === 'dependency')?.text ?? '';
  check('★ 종속 문구가 게이트를 **라벨**로 말한다 (`useWind` 라는 내부 키를 사용자에게 보이지 않는다)',
    depText.includes(PARAM_BY_KEY['useWind']?.label ?? ' ') && !depText.includes('useWind'), depText);
  const lockText = all.find((d) => d.cause === 'simInitialized')?.text ?? '';
  check('시뮬 잠금 문구가 있다', lockText.length > 8, lockText);

  // ── 우선순위 — 합성 필드로만 볼 수 있다 ────────────────────
  //
  // 실제 22개 중 사유가 **둘 이상 겹치는 필드가 하나도 없다.** 그래서 실제
  // 스키마만으로는 우선순위를 뒤집어도 아무 검사도 안 깨진다. 합성 필드를
  // 만들어 직접 물어본다 (`paramDisabledReason` 이 필드를 인자로 받는 덕이다).
  const base = PARAM_BY_KEY['windMagnitude'];
  check('전제: 우선순위를 볼 기준 필드가 있다', base !== undefined, 'windMagnitude');
  if (base !== undefined) {
    const ctx = { values: { useWind: false }, simInitialized: true };
    const three: ParamField = { ...base, effect: 'dead', lockedWhenSimInit: true };
    const two: ParamField = { ...base, effect: 'conditional', lockedWhenSimInit: true };
    const one: ParamField = { ...base, effect: 'conditional', lockedWhenSimInit: false };
    check('★★ 우선순위 dead > simInitialized (되돌리기 어려운 것을 먼저 말한다)',
      paramDisabledReason(three, ctx)?.cause === 'dead',
      String(paramDisabledReason(three, ctx)?.cause));
    check('★★ 우선순위 simInitialized > dependency',
      paramDisabledReason(two, ctx)?.cause === 'simInitialized',
      String(paramDisabledReason(two, ctx)?.cause));
    check('세 번째가 dependency 다',
      paramDisabledReason(one, ctx)?.cause === 'dependency',
      String(paramDisabledReason(one, ctx)?.cause));
    const free: ParamField = { ...base, effect: 'effective', requires: null, lockedWhenSimInit: false };
    check('★ 대조군: 사유가 없으면 null 이다 (전부 비활성으로 만드는 구현이 아니다)',
      paramDisabledReason(free, ctx) === null, 'null');
    check('★ conditional 자체는 비활성 사유가 아니다',
      paramDisabledReason({ ...base, effect: 'conditional', requires: null },
        { values: {}, simInitialized: false }) === null, 'null');
  }

  check('disabledParams 의 순서가 PARAM_FIELDS 순서다 (화면이 위에서 아래로 훑는다)',
    (() => {
      const got = disabledParams({ values: {}, simInitialized: true }).map((d) => String(d.key));
      const want = PARAM_FIELDS.map((f) => String(f.key)).filter((k) => got.includes(k));
      return got.join(',') === want.join(',');
    })(), '순서 일치');
}

// ── §11-6. buildSetParamsPayload — 죽은 필드가 새지 않는다 ───
//
// **이 단위가 존재하는 이유다.** 워커는 `subStep` 을 받아 `applied` 에 넣어
// 성공으로 답하고, 물리는 그 값을 보지 않는다. 보내는 순간 화면은 "적용됨"
// 이라고 말할 근거를 얻고, 그 말은 거짓이다.

function sectionParamPayload(): void {
  section('§11-6. setParams 페이로드 변환 (#16 통과 기준)');

  // 죽은 필드를 **온갖 방법으로** 밀어 넣어 본다.
  const pushes: [string, unknown][] = [
    ['유효값', 4], ['fallback', 1], ['범위 밖', 999], ['문자열', '4'],
    ['NaN', NaN], ['null', null], ['true', true], ['0', 0],
  ];
  const leaked: string[] = [];
  for (const key of DEAD_KEYS) {
    for (const [label, v] of pushes) {
      const r = buildSetParamsPayload({ [key]: v });
      if (Object.keys(r.payload).length !== 0) leaked.push(`${key}/${label}`);
      if (!r.dropped.map(String).includes(key)) leaked.push(`${key}/${label}(dropped 누락)`);
    }
  }
  check(
    '★★★ 죽은 필드는 어떤 값으로도 페이로드에 들어가지 않고 dropped 로 보고된다',
    leaked.length === 0, leaked.slice(0, 4).join(', ') || `2필드 × ${pushes.length}종`,
  );

  const everything = buildSetParamsPayload(fallbackParamValues());
  check(
    '★★ 22개를 전부 넣어도 페이로드는 20개다 (죽은 2개가 빠진 자리)',
    Object.keys(everything.payload).length === 20
    && !DEAD_KEYS.some((k) => k in everything.payload)
    && sortedKeys(everything.dropped.map(String)) === sortedKeys(DEAD_KEYS),
    `payload=${Object.keys(everything.payload).length} dropped=[${everything.dropped.join(',')}]`,
  );
  check(
    '★ 종속이 안 맞아도 windMagnitude 는 보낸다 (빼면 나중에 바람을 켠 순간 옛 세기가 살아난다)',
    'windMagnitude' in buildSetParamsPayload({ useWind: false, windMagnitude: 77 }).payload,
    'windMagnitude 포함',
  );
  check(
    '★ 잠긴 필드(solverType)도 보낸다 (위젯을 막는 규칙이지 전송 규칙이 아니다)',
    buildSetParamsPayload({ solverType: 1 }).payload['solverType'] === 1,
    'solverType=1',
  );

  // ── 모르는 키를 조용히 삼키지 않는다 ───────────────────────
  const typo = buildSetParamsPayload({ timestep: 45, TimeStep: 45, gravity: -980, '': 1 });
  check(
    '★★ 대소문자·이름이 틀린 키는 전부 unknown 이고 페이로드는 빈다 (조용히 먹히면 디버깅이 지옥이 된다)',
    Object.keys(typo.payload).length === 0 && typo.unknown.length === 4,
    `unknown=[${typo.unknown.join(',')}]`,
  );
  const empty = buildSetParamsPayload({});
  check('빈 입력이면 전부 빈다 (없는 것을 지어내지 않는다)',
    Object.keys(empty.payload).length === 0 && empty.dropped.length === 0
    && empty.unknown.length === 0 && empty.adjusted.length === 0, '{} → 전부 0');

  // ── 고친 값은 반드시 보고된다 ──────────────────────────────
  //
  // 반올림을 겪을 필드를 **이름으로 적지 않고 스키마에서 고른다** — `timeStep`
  // 이 int→float 으로 옮겨 가며 이 예제가 한 번 낡았다. 뽑는 조건이 계약이다.
  const roundee = PARAM_FIELDS.find((f) => f.kind === 'int' && f.effect !== 'dead');
  check('전제: 반올림을 겪을 int 필드가 스키마에 있다', roundee !== undefined,
    String(roundee?.key));
  if (roundee !== undefined) {
    const rk = String(roundee.key);
    const rawInt = Math.floor(((roundee.min ?? 0) + (roundee.max ?? 0)) / 2) + 0.7;
    const b = buildSetParamsPayload({
      [rk]: rawInt, subStep: 8, windMagnitude: 1e6, nope: 1, solverType: 9,
    });
    check(
      '★ 고친 값 · 뺀 값 · 모르는 키가 한 번에 정확히 보고된다',
      b.payload[rk] === Math.round(rawInt) && b.payload['windMagnitude'] === 500
      && b.payload['solverType'] === 0
      && Object.keys(b.payload).length === 3
      && b.dropped.map(String).join(',') === 'subStep'
      && b.unknown.join(',') === 'nope'
      && b.adjusted.length === 3,
      `payload=${JSON.stringify(b.payload)} adjusted=${b.adjusted.length}건`,
    );
    const adj = buildSetParamsPayload({ [rk]: rawInt }).adjusted[0];
    check('adjusted 가 원본(from)도 들고 있다 (화면이 "45.7 → 46" 처럼 말할 수 있다)',
      adj?.from === rawInt && adj?.to === Math.round(rawInt),
      JSON.stringify(adj));
  }
  check(
    '★★ 워커가 실수로 읽는 필드는 소수를 넣어도 adjusted 가 생기지 않는다 (조용히 반올림하지 않는다)',
    (() => {
      const f = PARAM_FIELDS.find(
        (x) => workerParamKinds().get(String(x.key)) === 'F' && x.effect !== 'dead');
      if (f === undefined) return false;
      const v = ((f.min ?? 0) + (f.max ?? 0)) / 2 + 0.25;
      const r = buildSetParamsPayload({ [String(f.key)]: v });
      return r.payload[String(f.key)] === v && r.adjusted.length === 0;
    })(),
    'float 필드 무손실',
  );
  const noSilent = PARAM_FIELDS.filter((f) => {
    // 각 필드에 확실히 못 쓰는 값을 넣고, 값이 바뀌었으면 반드시 adjusted 에 남는지
    const r = buildSetParamsPayload({ [String(f.key)]: 'x' });
    if (f.effect === 'dead') return false;
    const sent = r.payload[String(f.key)];
    return sent !== f.fallback || r.adjusted.length !== 1 || r.adjusted[0]?.reason === '';
  });
  check(
    '★★ 값을 고쳤으면 반드시 이유와 함께 adjusted 에 남는다 (몰래 바꾸지 않는다)',
    noSilent.length === 0, noSilent.map((f) => String(f.key)).join(', ') || '20개 필드',
  );
  // ── 페이로드는 워커가 받는 타입만 담는다 ───────────────────
  const typed = buildSetParamsPayload(
    Object.fromEntries(PARAM_FIELDS.map((f) => [String(f.key), 'x'])));
  const badType = Object.entries(typed.payload).filter(
    ([, v]) => !(typeof v === 'number' || typeof v === 'boolean'));
  check('페이로드 값이 전부 number|boolean 이다 (게이트웨이가 문자열을 막기 전에 우리가 막는다)',
    badType.length === 0, badType.map(([k]) => k).join(', ') || '20개');
  const boolKeys = PARAM_FIELDS.filter((f) => f.kind === 'bool').map((f) => String(f.key));
  check(
    '★ bool 필드는 boolean 으로, 나머지는 number 로 나간다 (워커의 get<bool>/get<float> 가 던지지 않는다)',
    Object.entries(typed.payload).every(
      ([k, v]) => (boolKeys.includes(k) ? typeof v === 'boolean' : typeof v === 'number')),
    `bool 3개 / number 17개`,
  );

  // ── ★ 프로토타입 이름의 키 ─────────────────────────────────
  //
  // `PARAM_BY_KEY` 가 `Object.fromEntries` 산물이던 시절, `Object.prototype` 의
  // 이름이 전부 "스키마에 있는 필드" 로 읽혔다. `PARAM_BY_KEY['constructor']` 는
  // `Object` 생성자 함수라 `!== undefined` 를 통과하고, 그 "필드" 의 `key` 가
  // `undefined` 라서 **`"undefined"` 라는 키가 워커로 나갔다.** 동시에 그 키는
  // `unknown` 에 안 담겨 "오타를 조용히 삼키지 않는다" 가 정확히 뒤집혔다.
  //
  // ⚠️ 객체 리터럴의 `__proto__` 는 소유 속성이 아니라 프로토타입 지정이다.
  //    워커 응답이 오는 경로와 같게 하려면 **`JSON.parse` 로 만들어야** 한다.
  const protoKeys = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];
  const proto = buildSetParamsPayload(
    JSON.parse(`{${protoKeys.map((k) => `"${k}":1`).join(',')},"nope":2}`) as Record<string, unknown>);
  check(
    '★★★ 프로토타입 이름의 키가 필드로 둔갑하지 않는다 — 전부 unknown 이고 페이로드는 빈다',
    Object.keys(proto.payload).length === 0
    && sortedKeys(proto.unknown) === sortedKeys([...protoKeys, 'nope']),
    `payload=${JSON.stringify(proto.payload)} unknown=[${proto.unknown.join(',')}]`,
  );
  check(
    '★★ 그래서 `"undefined"` 라는 키가 워커로 나가지 않는다 (증상은 이 한 글자로만 드러났다)',
    !('undefined' in proto.payload), `keys=[${Object.keys(proto.payload).join(',')}]`,
  );
  check(
    '★★ paramField() 가 그 이름들에 null 을 준다 (조회 지점이 늘어도 같은 답을 준다)',
    protoKeys.every((k) => paramField(k) === null) && paramField('nope') === null,
    `${protoKeys.length + 1}개 → null`,
  );
  check(
    '★ 대조군: paramField() 는 진짜 키에는 필드를 준다 (전부 null 을 주는 구현이 아니다)',
    PARAM_FIELDS.every((f) => paramField(String(f.key)) === f),
    `${PARAM_FIELDS.length}/22`,
  );
  check(
    '★ PARAM_BY_KEY 자체에 프로토타입이 없다 (바깥에서 맨손으로 읽어도 안 뚫린다)',
    Object.getPrototypeOf(PARAM_BY_KEY) === null,
    String(Object.getPrototypeOf(PARAM_BY_KEY)),
  );
}

// ── §11-7. 실제 워커로 스키마를 검증한다 ─────────────────────
//
// §11-1 은 `protocol.cpp` 를 **글자로** 읽었다. 그 파일이 실제로 빌드된
// 워커와 같다는 보장은 없다(빌드가 오래됐을 수 있다). 여기서 진짜 워커에
// 스키마가 만든 페이로드를 그대로 던져 `unknown` 이 비는지 본다. 이 절이
// 통과하면 "슬라이더를 움직였는데 아무 일도 안 일어난다" 의 절반(이름)이
// 구조적으로 배제된다. 나머지 절반(물리 반영)은 ISSUE-014 의 측정이 덮는다.

async function sectionParamRealWorker(): Promise<void> {
  section('§11-7. 실제 워커 대조 (스키마 → setParams)');

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
    try {
      await client.connect();
      await client.load(scene.id);

      const raw = await client.getParams() as unknown as Record<string, unknown>;
      const schemaKeys = PARAM_FIELDS.map((f) => String(f.key));
      const workerKeys = Object.keys(raw);
      check(
        '★★ 살아 있는 워커의 getParams 키가 스키마 22개와 정확히 같다',
        sortedKeys(workerKeys) === sortedKeys(schemaKeys),
        `워커=${workerKeys.length}개 / 스키마=${schemaKeys.length}개`,
      );

      const values = readParamValues(raw);
      check('readParamValues 가 워커 응답에서 22개를 전부 건진다 (타입 필터에 걸려 새는 것이 없다)',
        Object.keys(values).length === 22, `${Object.keys(values).length}개`);

      // ★ 실측 표는 W_Bra 씬의 것이라 sample.zls 의 값은 다르다. 그래서 값이
      //   아니라 **범위 밖으로 잘리는가**만 본다 — 잘리면 사용자가 만지지도
      //   않은 값이 바뀐다.
      const clipped = PARAM_FIELDS.filter((f) => {
        const v = values[f.key];
        return v !== undefined && !coerceParamValue(f, v).ok;
      });
      check(
        '★★ 이 씬(sample.zls)의 값도 스키마 범위 안이다 — UI 가 워커 값을 몰래 클램프하지 않는다',
        clipped.length === 0,
        clipped.map((f) => {
          const v = values[f.key];
          return `${String(f.key)}=${String(v)}→${String(coerceParamValue(f, v).value)}`;
        }).join(', ') || '22/22',
      );
      note('sample.zls 실측', PARAM_FIELDS.slice(0, 6)
        .map((f) => `${String(f.key)}=${String(values[f.key])}`).join(' '));

      const built = buildSetParamsPayload(values);
      const res = await client.setParams(built.payload as Parameters<GatewayClient['setParams']>[0]);
      check(
        '★★★ 스키마가 만든 페이로드를 워커가 하나도 모르는 키 없이 받는다',
        res.unknown.length === 0 && res.applied.length === 20,
        `applied=${res.applied.length} unknown=[${res.unknown.join(',')}]`,
      );
      check(
        '★ applied 가 우리가 보낸 20개와 같은 이름이다 (죽은 2개는 애초에 안 갔다)',
        sortedKeys(res.applied) === sortedKeys(Object.keys(built.payload)),
        `${res.applied.length}개`,
      );

      const after = await client.getParams() as unknown as Record<string, unknown>;
      const drifted = PARAM_FIELDS.filter((f) => {
        const a = values[f.key];
        const b = after[String(f.key)];
        return typeof b !== 'object' && a !== b;
      });
      check(
        '★★ 왕복 뒤 워커의 값이 하나도 안 달라졌다 (아무것도 안 만졌으므로)',
        drifted.length === 0,
        drifted.map((f) => `${String(f.key)}: ${String(values[f.key])}→${String(after[String(f.key)])}`)
          .join(', ') || '22/22',
      );

      // ── 죽은 필드를 보냈다면 워커가 뭐라고 답하는가 ──────────
      // ISSUE-014 의 전제를 여기서 못 박는다: **워커는 성공으로 답한다.**
      // 그래서 이 값을 보내면 화면이 "적용됨" 이라는 거짓말을 하게 된다.
      const deadEcho = await client.setParams({ subStep: 8, meshingEdgeLength: 4 });
      check(
        '★★ 전제 확인: 죽은 2개도 워커는 "적용됨"으로 답한다 — 그래서 보내면 안 된다',
        deadEcho.applied.length === 2 && deadEcho.unknown.length === 0,
        `applied=[${deadEcho.applied.join(',')}] unknown=[${deadEcho.unknown.join(',')}]`,
      );
      const typoEcho = await client.setParams({ timestep: 45 });
      check(
        '★★ 전제 확인: 키 한 글자가 틀리면 워커는 unknown 으로 되돌린다 (§11-1 이 막는 것이 이것이다)',
        typoEcho.unknown.join(',') === 'timestep' && typoEcho.applied.length === 0,
        `unknown=[${typoEcho.unknown.join(',')}]`,
      );
    } catch (err: unknown) {
      check('§11-7 실제 워커 대조', false, messageOf(err));
    } finally {
      await client.close().catch(() => {});
    }
  }, { sessions: { idleTimeout: 0, requestTimeoutMs: 120_000 } });
}

// ─────────────────────────────────────────────────────────────
// §13. 오른쪽 칸의 탭 (L-3c) — 판단 (panels/sideTabs.ts, DOM 없이)
//
// L-3a·L-3b 가 오른쪽 칸에 체형 54행 + 옷 사이즈 24행을 **한 스크롤로 이어**
// 놓았고, L-3c 가 그것을 탭 둘로 갈랐다. 여기서 못박는 것은 그 가름의 **판단**
// 이다 — 탭이 몇 개인지 · 어느 상자와 짝인지 · 기본이 무엇인지 · 같은 탭을
// 다시 눌렀을 때 "바뀌었다" 고 답하지 않는지.
//
// 마지막 항목이 이 절에서 제일 무겁다. `SideTabsPanel.select()` 의 반환값이
// 곧 "스크롤을 저장·복원해도 되는가" 의 답이라, 여기가 참을 헤프게 돌려주면
// 화면에서는 **같은 탭을 다시 눌렀더니 보던 자리가 튀는** 증상으로만 드러난다.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// §14. 재단 도면의 표시 스위치 (D2-e, viewer2d/design.ts)
// ─────────────────────────────────────────────────────────────
//
// 좁게 겨냥한 절이다. `design.ts` 전체(폴리라인 변환·센티넬 걸러내기·z 순서·
// 색 폴백)는 아직 무테스트이고 별도 단위로 뗐다 — 여기서 보는 것은 **깨지면
// 조용한 두 가지**뿐이다:
//
//   ① 접두사 우선순위 — `seam:links` 가 `seam:` 보다 먼저 걸려야 한다.
//      `DESIGN_LAYERS` 의 **순서를 바꾸는 것만으로** "봉제선 끄기" 가 대응선
//      까지 끈다. 화면은 그럴듯해서 눈으로는 못 잡는다.
//   ② `build()` 뒤 상태 유지 — 새 객체에 꺼짐을 다시 안 입히면, 씬을 다시
//      로드할 때 **체크박스는 꺼져 있는데 선은 보이는** 화면이 된다. 두 번
//      로드해야 드러나므로 사람이 발견하기 가장 나쁜 모양이다.
//
// DOM 을 안 쓰므로 워커도 GPU 도 필요 없다.

/** 실제 응답과 같은 모양의 최소 씬. **이름이 진짜와 같아야** 접두사를 본다 */
function fakeDesign2D(): Parameters<Design2DLayer['build']>[0] {
  const line = (x: number) => ({
    uuid: `c${x}`,
    kind: 'outer' as const,
    isLine: true,
    cp: [x, 0, x, 1, x, 2, x, 3],
    pts: [x, 0, x, 3],
  });
  return {
    surfaces: [
      {
        uuid: 's1',
        name: 'pattern 1',
        curves: [line(0), { ...line(1), kind: 'inner' as const, isLine: false }],
      },
    ],
    seams: [
      {
        uuid: 'seam-1',
        sides: [[{ curve: 'c0', surface: 's1', t0: 0, t1: 1, pts: [0, 0, 0, 3] }], []],
        links: [[0, 0, 1, 0], [0, 3, 1, 3]],
        color: [1, 0, 0, 1],
      },
      {
        uuid: 'seam-2',
        sides: [[{ curve: 'c1', surface: 's1', t0: 1, t1: 0, pts: [1, 0, 1, 3] }], []],
        links: [[1, 1, 2, 1]],
        color: null,
      },
    ],
    stitches: [
      {
        uuid: 'st-1',
        surface: 's1',
        color: [0.4, 0.4, 0.4, 1],
        curves: [line(2)],
      },
    ],
  };
}

/** 이름이 `prefix` 로 시작하는 객체들의 `visible` */
function visibilityOf(layer: Design2DLayer, prefix: string): boolean[] {
  return layer.group.children
    .filter((c) => c.name === prefix || c.name.startsWith(prefix))
    .map((c) => c.visible);
}

function sectionDesignLayers(): void {
  section('§14. 재단 도면의 표시 스위치 — 갈래 (D2-e, viewer2d/design.ts)');

  // ── ① 목록 자체 ────────────────────────────────────────────
  {
    const keys = DESIGN_LAYERS.map((l) => l.key).join(',');
    check('갈래가 6개다', DESIGN_LAYERS.length === 6, keys);
    check(
      '키가 서로 다르다 (같으면 스위치 하나가 다른 것을 덮는다)',
      new Set(DESIGN_LAYERS.map((l) => l.key)).size === DESIGN_LAYERS.length,
      keys,
    );
    check(
      '갈래마다 글자가 있다 (빈 체크박스가 서지 않는다)',
      DESIGN_LAYERS.every((l) => l.label.trim().length > 0),
      DESIGN_LAYERS.map((l) => l.label).join(' / '),
    );

    // ★★★ 이 절의 핵심. 순서가 뒤집히면 화면은 멀쩡한데 스위치가 거짓말한다
    const iLinks = DESIGN_LAYERS.findIndex((l) => l.key === 'links');
    const iSeams = DESIGN_LAYERS.findIndex((l) => l.key === 'seams');
    check(
      '★★★ `links` 가 `seams` 보다 **먼저** 온다 — `seam:links` 가 `seam:` 에 먼저 먹히면 안 된다',
      iLinks >= 0 && iSeams >= 0 && iLinks < iSeams,
      `links=${iLinks} seams=${iSeams}`,
    );
    check(
      '대조군: 두 접두사가 실제로 포함 관계다 (그래서 순서가 문제가 된다)',
      'seam:links'.startsWith(DESIGN_LAYERS[iSeams]!.prefix)
      && DESIGN_LAYERS[iLinks]!.prefix === 'seam:links',
      `${DESIGN_LAYERS[iSeams]!.prefix} ⊃ ${DESIGN_LAYERS[iLinks]!.prefix}`,
    );
  }

  // ── ② 기본값과 갈래별 독립 ─────────────────────────────────
  {
    const layer = new Design2DLayer();
    layer.build(fakeDesign2D());

    check(
      '처음엔 전부 켜져 있다',
      layer.layers.every((l) => l.on) && layer.group.children.every((c) => c.visible),
      layer.layers.map((l) => `${l.key}:${l.on ? 'on' : 'off'}`).join(' '),
    );

    // ★★★ 봉제선을 꺼도 대응선은 살아야 한다
    layer.setLayerVisible('seams', false);
    const seamCurves = layer.group.children
      .filter((c) => c.name.startsWith('seam:') && c.name !== 'seam:links');
    check(
      '★★★ "봉제선" 을 꺼도 **대응선은 살아 있다** (접두사 우선순위가 실제로 먹는다)',
      seamCurves.length > 0 && seamCurves.every((c) => !c.visible)
      && visibilityOf(layer, 'seam:links').every((v) => v),
      `봉제선 ${seamCurves.filter((c) => !c.visible).length}/${seamCurves.length} 숨김 · 대응선 ${visibilityOf(layer, 'seam:links').join(',')}`,
    );

    layer.setLayerVisible('seams', true);
    layer.setLayerVisible('links', false);
    check(
      '★★ 거꾸로도 성립한다 — 대응선만 꺼지고 봉제선은 보인다',
      visibilityOf(layer, 'seam:links').every((v) => !v)
      && seamCurves.every((c) => c.visible),
      `대응선 ${visibilityOf(layer, 'seam:links').join(',')} · 봉제선 보임 ${seamCurves.filter((c) => c.visible).length}`,
    );
    layer.setLayerVisible('links', true);

    // 나머지 갈래가 서로를 안 건드리는지. 하나씩 끄고 **다른 것들이 다 켜져
    // 있는지**를 본다 — "꺼졌다" 만 보면 전부 끄는 구현도 통과한다.
    for (const target of DESIGN_LAYERS) {
      layer.setLayerVisible(target.key, false);
      const others = DESIGN_LAYERS.filter((l) => l.key !== target.key);
      const bleed = others.filter((o) => visibilityOf(layer, o.prefix).some((v) => !v));
      // ⚠️ `seams`(`seam:`)를 끌 때 `links`(`seam:links`)가 같이 걸리는 것은
      //    위에서 이미 봤으므로 여기서는 접두사 포함 관계를 뺀다.
      const real = bleed.filter((o) => !o.prefix.startsWith(target.prefix) && !target.prefix.startsWith(o.prefix));
      check(
        `${target.label} 만 꺼진다 (다른 갈래로 안 번진다)`,
        real.length === 0,
        real.length === 0 ? '번짐 없음' : `번짐: ${real.map((o) => o.key).join(',')}`,
      );
      layer.setLayerVisible(target.key, true);
    }

    check(
      '전부 되돌리면 다시 다 보인다',
      layer.group.children.every((c) => c.visible),
      `${layer.group.children.filter((c) => c.visible).length}/${layer.group.children.length}`,
    );
  }

  // ── ③ ★ `build()` 를 다시 해도 꺼짐이 유지된다 ──────────────
  //
  // 씬 재로드가 이 경로다. 안 지켜지면 체크박스와 화면이 갈라지는데, 두 번
  // 로드해야 드러나므로 사람이 발견하기 가장 나쁜 모양이다.
  {
    const layer = new Design2DLayer();
    layer.build(fakeDesign2D());
    layer.setLayerVisible('links', false);
    layer.setLayerVisible('vertices', false);

    // 씬을 다시 로드한 셈
    layer.build(fakeDesign2D());

    check(
      '★★★ 다시 build() 해도 꺼 뒀던 갈래가 그대로 꺼져 있다 (재로드 때 체크박스와 안 갈라진다)',
      visibilityOf(layer, 'seam:links').every((v) => !v)
      && visibilityOf(layer, 'vertices:').every((v) => !v),
      `대응선 ${visibilityOf(layer, 'seam:links').join(',')} · 제어점 ${visibilityOf(layer, 'vertices:').join(',')}`,
    );
    check(
      '★★ 상태 표도 그대로다 (화면이 읽는 값이 사실과 같다)',
      !layer.isLayerVisible('links') && !layer.isLayerVisible('vertices')
      && layer.isLayerVisible('outer'),
      layer.layers.map((l) => `${l.key}:${l.on ? 'on' : 'off'}`).join(' '),
    );
    check(
      '대조군: 안 껐던 갈래는 다시 세운 뒤에도 보인다 (전부 꺼 버리는 구현이 아니다)',
      visibilityOf(layer, 'curves:outer').every((v) => v),
      visibilityOf(layer, 'curves:outer').join(','),
    );

    // `clear()` 는 상태를 지우지 않는다 — 씬을 내렸다 다시 올려도 사용자가
    // 꺼 둔 것은 그대로여야 한다.
    layer.clear();
    layer.build(fakeDesign2D());
    check(
      '★★ clear() → build() 를 지나도 꺼짐이 살아남는다 (씬 내림 → 재로드)',
      visibilityOf(layer, 'seam:links').every((v) => !v),
      visibilityOf(layer, 'seam:links').join(','),
    );
  }

  // ── ④ 색 폴백 ──────────────────────────────────────────────
  //
  // 엔진 색이 정본이고 우리 팔레트는 폴백이다(D2-d). 뒤집히면 화면이
  // 데스크톱과 다른 색을 내는데, 그 차이는 눈으로 못 가른다.
  {
    const layer = new Design2DLayer();
    layer.build(fakeDesign2D());
    const s1 = layer.group.children.find((c) => c.name === 'seam:seam-1') as { material?: { color?: { getHex(): number } } } | undefined;
    const s2 = layer.group.children.find((c) => c.name === 'seam:seam-2') as { material?: { color?: { getHex(): number } } } | undefined;
    check(
      '★★ 엔진이 색을 주면 그 색을 쓴다 (빨강 [1,0,0])',
      s1?.material?.color?.getHex() === 0xff0000,
      `#${(s1?.material?.color?.getHex() ?? 0).toString(16).padStart(6, '0')}`,
    );
    check(
      '★ 색이 null 이면 폴백 팔레트로 떨어진다 (빨강이 아니다)',
      s2?.material?.color !== undefined && s2.material.color.getHex() !== 0xff0000,
      `#${(s2?.material?.color?.getHex() ?? 0).toString(16).padStart(6, '0')}`,
    );
  }
}

function sectionSideTabs(): void {
  section('§13. 오른쪽 칸의 탭 — 판단 (L-3c, panels/sideTabs.ts)');

  // ── ① 목록과 짝 ────────────────────────────────────────────
  {
    const ids = SIDE_TABS.map((t) => t.id).join(',');
    check(
      '탭이 정확히 2개이고 순서가 아바타 → 옷 사이즈다',
      ids === 'avatar,surface',
      ids,
    );
    const byId = new Map(SIDE_TABS.map((t) => [t.id, t.paneId]));
    check(
      '★★ 탭 ↔ 상자의 짝이 못박혀 있다 (뒤바뀌면 아바타 탭에 옷 사이즈가 뜬다)',
      byId.get('avatar') === 'avatarPanel' && byId.get('surface') === 'surfacePanel',
      SIDE_TABS.map((t) => `${t.id}→${t.paneId}`).join(' '),
    );
    check(
      '두 탭이 서로 다른 상자를 가리킨다 (같으면 한쪽 내용이 영영 안 보인다)',
      new Set(SIDE_TABS.map((t) => t.paneId)).size === SIDE_TABS.length,
      SIDE_TABS.map((t) => t.paneId).join(' / '),
    );
    check(
      '탭마다 글자가 있다 (빈 버튼이 서지 않는다)',
      SIDE_TABS.every((t) => t.label.trim().length > 0),
      SIDE_TABS.map((t) => t.label).join(' / '),
    );
    check(
      '★ 기본 탭이 아바타다 — 옷 사이즈는 몸이 정해진 다음의 조정이다',
      DEFAULT_SIDE_TAB === 'avatar',
      DEFAULT_SIDE_TAB,
    );
    check(
      '기본 탭이 실제 목록 안에 있다 (없으면 첫 화면에 아무 상자도 안 뜬다)',
      SIDE_TABS.some((t) => t.id === DEFAULT_SIDE_TAB),
      DEFAULT_SIDE_TAB,
    );
  }

  // ── ② id 판정 ──────────────────────────────────────────────
  {
    check(
      'isSideTabId 가 진짜 id 둘을 받는다',
      isSideTabId('avatar') && isSideTabId('surface'),
    );
    // `avatarPanel`·`surfacePanel` 이 여기 섞여 있는 것이 핵심이다 — 상자 id 와
    // 탭 id 는 다른 이름 공간인데, 배선에서 헷갈리기 가장 쉬운 자리다.
    const bogus = [
      '', ' ', 'Avatar', 'AVATAR', 'avatars', 'surface ',
      'avatarPanel', 'surfacePanel', 'constructor', '__proto__', 'toString', 'valueOf',
    ];
    const wrong = bogus.filter((b) => isSideTabId(b));
    check(
      '★★ 대소문자·공백·상자 id·프로토타입 이름은 전부 거짓이다',
      wrong.length === 0,
      wrong.length === 0 ? `${bogus.length}개 전부 거부` : `통과해버린 것: ${wrong.join(',')}`,
    );
  }

  // ── ③ 마크업과의 대조 ──────────────────────────────────────
  //
  // 짝을 `panels/` 가 들고 있어 Node 에서 볼 수 있게 된 대신, **그 문자열이
  // 실제 마크업과 갈라졌는지**는 여전히 아무도 안 본다. `ui/sideTabs.ts` 의
  // 생성자가 던지긴 하지만 그건 브라우저를 띄워야 알고, 그 시점엔 오른쪽 칸이
  // 통째로 안 뜬다. index.html 을 글자로 읽어 그 한 칸을 미리 막는다.
  {
    const html = readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
    const missing = SIDE_TABS.filter((t) => !html.includes(`id="${t.paneId}"`));
    check(
      '★★ 탭이 가리키는 상자가 index.html 에 실재한다 (갈라지면 오른쪽 칸이 통째로 안 뜬다)',
      missing.length === 0,
      missing.length === 0
        ? SIDE_TABS.map((t) => `#${t.paneId}`).join(' ')
        : `없는 상자: ${missing.map((t) => t.paneId).join(',')}`,
    );
    check(
      '★ main.ts 가 찾는 `#sideTabs`·`#sideScroll` 이 index.html 에 있다',
      html.includes('id="sideTabs"') && html.includes('id="sideScroll"'),
    );
    // ⚠️ 탭 바가 **스크롤 상자 안**에 있으면 내용과 함께 굴러 올라가 버린다
    //    (`SideTabsOptions.root` 의 "스크롤 상자 바깥이어야 한다"). 마크업
    //    한 줄을 들여 쓰는 것만으로 그렇게 되는데, 위젯 쪽에서는 아무 티도
    //    안 난다 — 두 상자가 형제인지를 글자로 본다.
    {
      const iTabs = html.indexOf('id="sideTabs"');
      const iScroll = html.indexOf('id="sideScroll"');
      check(
        '★★ 탭 바가 스크롤 상자 **바깥**이다 (안에 있으면 바가 내용과 같이 굴러 올라간다)',
        iTabs > 0 && iScroll > iTabs && html.slice(iTabs, iScroll).includes('</div>'),
        iTabs > 0 && iScroll > iTabs ? '#sideTabs 가 #sideScroll 앞에서 닫힌다' : `iTabs=${iTabs} iScroll=${iScroll}`,
      );
    }
    // ★ 배선은 Node 가 원리적으로 못 본다 — 하지만 **배선이 통째로 사라진 것**
    //   만큼은 글자로 잡힌다. 이 다섯 줄이 없으면 위 단언 51개가 전부 초록인
    //   채로 오른쪽 칸에 탭이 하나도 안 뜬다 (직전 단위에서 겪은 계열이다).
    {
      const main = readFileSync(path.join(FRONTEND, 'src/main.ts'), 'utf8');
      check(
        '★★ main.ts 가 두 상자를 실제로 집는다 (el(\'sideTabs\')·el(\'sideScroll\'))',
        main.includes("'sideTabs'") && main.includes("'sideScroll'"),
      );
      check(
        '★★★ main.ts 가 SideTabs 를 세우고 그 둘을 넘긴다 — 배선이 빠지면 스모크는 초록인데 탭이 안 뜬다',
        /new SideTabs\(\{[\s\S]{0,400}?\}\)/.test(main)
        && /new SideTabs\(\{[\s\S]{0,400}?root:\s*ui\.sideTabs/.test(main)
        && /new SideTabs\(\{[\s\S]{0,400}?scroll:\s*ui\.sideScroll/.test(main)
        && /new SideTabs\(\{[\s\S]{0,400}?panel:\s*new SideTabsPanel\(\)/.test(main),
      );
    }
    // ⚠️ 문구가 아니라 **규칙**을 본다. 브라우저 기본 `[hidden]{display:none}`
    //    은 작성자 규칙에 지므로, 이 한 줄이 없으면 두 상자에 나중에 `display:`
    //    가 붙는 순간 탭이 조용히 안 갈린다 (L-2a 에서 실제로 겪었다).
    check(
      '★★ index.html 이 `.sidepane[hidden]` 을 display:none 으로 못박는다 (속성만 믿으면 L-2a 재발)',
      /\.sidepane\[hidden\][^{]*\{[^}]*display\s*:\s*none/.test(html),
    );
    // 그 규칙이 걸릴 표식을 붙이는 것은 `ui/sideTabs.ts` 다 — 규칙과 표식이
    // 서로 다른 파일에 있으므로 이름이 갈라지는지 한 번 본다.
    check(
      '★ 그 규칙이 쓰는 클래스 이름을 ui/sideTabs.ts 가 실제로 붙인다',
      readFileSync(path.join(FRONTEND, 'src/ui/sideTabs.ts'), 'utf8').includes("'sidepane'"),
    );
  }

  // ── ④ 상태 전이 ────────────────────────────────────────────
  {
    const p = new SideTabsPanel();
    check('새 패널의 활성 탭이 기본값이다', p.active === DEFAULT_SIDE_TAB, p.active);
    check(
      '★★ 다른 탭을 고르면 참을 돌려주고 실제로 바뀐다 (부르는 쪽이 이 참으로 스크롤을 저장한다)',
      p.select('surface') === true && p.active === 'surface',
      p.active,
    );
    check(
      '★★★ 같은 탭을 다시 고르면 거짓이다 — 보던 자리가 저장값으로 튀지 않는 근거가 이 한 줄이다',
      p.select('surface') === false && p.active === 'surface',
      p.active,
    );
    let threw = '';
    let ret: boolean | null = null;
    try {
      ret = p.select('nope');
    } catch (err: unknown) {
      threw = messageOf(err);
    }
    check(
      '★★ 모르는 id 는 던지지 않고 거짓이며 활성 탭도 그대로다 (클릭 핸들러가 죽으면 칸 전체가 멎는다)',
      threw === '' && ret === false && p.active === 'surface',
      threw ? `던졌다: ${threw}` : `ret=${ret} active=${p.active}`,
    );
    check(
      '★ 프로토타입 이름도 탭이 되지 않는다',
      ['constructor', '__proto__', 'toString', 'valueOf'].every((k) => p.select(k) === false)
      && p.active === 'surface',
      p.active,
    );
    p.reset();
    check('reset() 이 기본 탭으로 되돌린다', p.active === DEFAULT_SIDE_TAB, p.active);
  }

  // ── ⑤ view ─────────────────────────────────────────────────
  {
    const on = (v: SideTabsView): string[] => v.tabs.filter((t) => t.active).map((t) => t.id);
    const p = new SideTabsPanel();
    const v = p.view;
    check('view.active 가 active 와 같다', v.active === p.active, `${v.active} / ${p.active}`);
    check(
      'view.tabs 가 SIDE_TABS 와 같은 순서·같은 짝을 그대로 싣는다',
      v.tabs.map((t) => `${t.id}:${t.paneId}:${t.label}`).join(',')
      === SIDE_TABS.map((t) => `${t.id}:${t.paneId}:${t.label}`).join(','),
      v.tabs.map((t) => `${t.id}:${t.paneId}`).join(','),
    );
    check(
      '★★ 켜진 탭이 정확히 하나이고 그것이 active 다 (0 이면 칸이 비고, 2 면 상자가 겹친다)',
      on(v).length === 1 && on(v)[0] === v.active,
      `on=[${on(v).join(',')}] active=${v.active}`,
    );
    p.select('surface');
    const v2 = p.view;
    check(
      '★★ 탭을 바꿔도 켜진 것은 하나뿐이고 그것이 바뀐 탭이다',
      on(v2).length === 1 && on(v2)[0] === 'surface',
      `on=[${on(v2).join(',')}]`,
    );
    check(
      '대조군: 꺼진 탭도 하나 있다 (전부 참을 돌려주는 구현이 아니다)',
      v2.tabs.filter((t) => !t.active).length === 1,
      `off=${v2.tabs.filter((t) => !t.active).length}`,
    );
    // 뷰를 밖에서 주물러도 상태가 안 흔들린다. `SIDE_TABS` 를 그대로 내보내면
    // 여기가 무너지고, 화면 한 곳의 실수가 다른 곳까지 옮는다.
    v2.active = 'avatar';
    const first = v2.tabs[0];
    if (first) first.active = true;
    check(
      '★ view 를 바깥에서 고쳐도 패널의 상태는 그대로다 (뷰는 사본이다)',
      p.active === 'surface' && on(p.view).join(',') === 'surface',
      `active=${p.active} on=[${on(p.view).join(',')}]`,
    );
    check(
      '★ SIDE_TABS 원본도 안 오염됐다',
      SIDE_TABS.every((t) => !('active' in t)),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// §13-2. 오른쪽 칸의 탭 — 그리기 (ui/sideTabs.ts, 최소 DOM 스텁)
//
// ⚠️ **여기는 브라우저가 아니다.** 초록이라고 화면이 맞는다는 뜻은 아니다
//    (직전 단위에서 결함 12건이 전부 스모크 초록 · 화면 빨강이었다). 반대는
//    성립한다 — 여기가 빨간불이면 화면도 반드시 틀렸다.
//
// 그럼에도 스텁을 세우는 이유는 하나다: L-3c 의 설계 판단 중 **제일 미묘한
// 것이 DOM 층에 산다**. "스크롤 위치를 탭마다 기억하고, 복원은 render() 뒤에
// 한다" 는 규칙은 `panels/` 에서 잴 수 없는데, 이걸 안 재면 다음 사람이 두 줄
// 순서를 바꿔도 아무 자국이 안 남는다.
//
// ★ 스텁이 **일부러 정확하게** 흉내내는 것은 `scrollTop` 의 잘림이다. 대입하는
//   순간 `scrollHeight - clientHeight` 로 잘린다 — 상자가 짧다는 사실이 화면에
//   드러나는 방식이 바로 이것이고, 이게 없으면 "복원을 render() 앞으로" 라는
//   결함이 스텁 위에서 아무 자국도 안 남는다. 그래서 아래 ④에 **대조군**을 둬
//   스텁이 진짜로 자르는지부터 확인한다.
//
// 새 의존성(jsdom 등)은 들이지 않는다. `ui/sideTabs.ts` 가 쓰는 DOM 표면은
// 열 개 남짓이라 그만큼만 흉내낸다.
// ─────────────────────────────────────────────────────────────

class FakeClassList {
  readonly #set = new Set<string>();
  add(...names: string[]): void {
    for (const n of names) this.#set.add(n);
  }
  remove(...names: string[]): void {
    for (const n of names) this.#set.delete(n);
  }
  contains(n: string): boolean {
    return this.#set.has(n);
  }
  toggle(n: string, force?: boolean): boolean {
    const on = force ?? !this.#set.has(n);
    if (on) this.#set.add(n);
    else this.#set.delete(n);
    return on;
  }
  get list(): string[] {
    return [...this.#set];
  }
  reset(value: string): void {
    this.#set.clear();
    for (const n of value.split(/\s+/).filter(Boolean)) this.#set.add(n);
  }
}

class FakeEl {
  readonly tag: string;
  id = '';
  type = '';
  textContent = '';
  hidden = false;
  tabIndex = 0;
  /** 스텁 전용: 이 상자가 보일 때 차지하는 높이 */
  contentHeight = 0;
  /** 스텁 전용: 스크롤 상자의 보이는 높이 */
  clientHeight = 0;
  readonly children: FakeEl[] = [];
  readonly attrs = new Map<string, string>();
  readonly classList = new FakeClassList();
  readonly #clicks: Array<() => void> = [];
  #scrollTop = 0;

  constructor(tag: string) {
    this.tag = tag;
  }

  get className(): string {
    return this.classList.list.join(' ');
  }
  set className(v: string) {
    this.classList.reset(v);
  }

  /** 보이는 자식만 높이에 든다 — `hidden` 이 곧 레이아웃이다 */
  get scrollHeight(): number {
    return this.children.reduce((s, c) => s + (c.hidden ? 0 : c.contentHeight), 0);
  }
  get maxScroll(): number {
    return Math.max(0, this.scrollHeight - this.clientHeight);
  }
  get scrollTop(): number {
    return Math.min(this.#scrollTop, this.maxScroll);
  }
  /** ★ 브라우저와 같이 **대입하는 순간** 잘린다 */
  set scrollTop(v: number) {
    this.#scrollTop = Math.min(Math.max(0, v), this.maxScroll);
  }

  setAttribute(n: string, v: string): void {
    this.attrs.set(n, String(v));
  }
  getAttribute(n: string): string | null {
    return this.attrs.get(n) ?? null;
  }
  append(...kids: FakeEl[]): void {
    this.children.push(...kids);
  }
  addEventListener(type: string, fn: () => void): void {
    if (type === 'click') this.#clicks.push(fn);
  }
  click(): void {
    for (const fn of [...this.#clicks]) fn();
  }
}

interface FakeDom {
  /** `#sideTabs` — 버튼이 붙을 자리 */
  tabs: FakeEl;
  /** `#sideScroll` — 위치를 기억·복원할 상자 */
  scroll: FakeEl;
  panes: Map<string, FakeEl>;
  buttons(): FakeEl[];
}

/** `document` 를 잠깐 갈아끼운다. **반드시** 원복한다 */
function withFakeDom<T>(paneIds: readonly string[], fn: (dom: FakeDom) => T): T {
  const registry = new Map<string, FakeEl>();
  const scroll = new FakeEl('div');
  scroll.id = 'sideScroll';
  const tabs = new FakeEl('div');
  tabs.id = 'sideTabs';
  const panes = new Map<string, FakeEl>();
  for (const id of paneIds) {
    const p = new FakeEl('div');
    p.id = id;
    registry.set(id, p);
    panes.set(id, p);
    scroll.append(p);
  }
  const g = globalThis as unknown as Record<string, unknown>;
  const had = 'document' in g;
  const prev = g['document'];
  g['document'] = {
    getElementById: (id: string): FakeEl | null => registry.get(id) ?? null,
    createElement: (tag: string): FakeEl => new FakeEl(tag),
  };
  try {
    return fn({ tabs, scroll, panes, buttons: () => tabs.children });
  } finally {
    if (had) g['document'] = prev;
    else delete g['document'];
  }
}

function makeSideTabs(dom: FakeDom, onChange?: (id: string) => void): SideTabs {
  const opts = {
    root: dom.tabs as unknown as HTMLElement,
    scroll: dom.scroll as unknown as HTMLElement,
    panel: new SideTabsPanel(),
    ...(onChange ? { onChange } : {}),
  };
  return new SideTabs(opts);
}

function sectionSideTabsDom(): void {
  section('§13-2. 오른쪽 칸의 탭 — 버튼·가시성·스크롤 (L-3c, ui/sideTabs.ts)');
  const paneIds = SIDE_TABS.map((t) => t.paneId);

  // ── ① 첫 그림 ──────────────────────────────────────────────
  withFakeDom(paneIds, (dom) => {
    const seen: string[] = [];
    makeSideTabs(dom, (id) => seen.push(id));

    const btns = dom.buttons();
    check(
      '탭 버튼이 탭 수만큼 생기고 글자가 목록 순서와 같다',
      btns.length === SIDE_TABS.length
      && btns.map((b) => b.textContent).join(',') === SIDE_TABS.map((t) => t.label).join(','),
      btns.map((b) => b.textContent).join(' / '),
    );
    check(
      '탭 바가 tablist 이고 버튼이 전부 tab 이다',
      dom.tabs.getAttribute('role') === 'tablist'
      && btns.every((b) => b.getAttribute('role') === 'tab'),
    );
    check(
      '★ 버튼의 aria-controls 가 짝 상자를 가리키고, 상자는 그 버튼을 되가리킨다',
      SIDE_TABS.every((t, i) => {
        const b = btns[i];
        const p = dom.panes.get(t.paneId);
        return !!b && !!p
          && b.getAttribute('aria-controls') === t.paneId
          && p.getAttribute('role') === 'tabpanel'
          && p.getAttribute('aria-labelledby') === b.id;
      }),
      btns.map((b) => `${b.id}→${b.getAttribute('aria-controls')}`).join(' '),
    );
    check(
      '★ 두 상자에 `sidepane` 표식이 붙는다 (index.html 의 display:none 규칙이 걸릴 자리)',
      [...dom.panes.values()].every((p) => p.classList.contains('sidepane')),
    );

    const shown = (): string[] => [...dom.panes.entries()].filter(([, p]) => !p.hidden).map(([id]) => id);
    check(
      '★★ 처음엔 아바타 상자만 보인다 (기본 탭이 곧 보이는 상자다)',
      shown().join(',') === 'avatarPanel',
      `보이는 것: [${shown().join(',')}]`,
    );
    check(
      '★ 켜진 버튼이 정확히 하나이고 aria-selected 도 하나다',
      btns.filter((b) => b.classList.contains('on')).length === 1
      && btns.filter((b) => b.getAttribute('aria-selected') === 'true').length === 1
      && btns[0]?.classList.contains('on') === true,
      btns.map((b) => `${b.textContent}:${b.getAttribute('aria-selected')}`).join(' '),
    );
    check(
      '★ 켜진 버튼만 tabIndex 0 이고 나머지는 -1 이다 (비활성으로 만들면 키보드로 못 넘어간다)',
      btns.map((b) => b.tabIndex).join(',') === '0,-1',
      btns.map((b) => b.tabIndex).join(','),
    );
    check(
      '생성만으로는 onChange 가 울리지 않는다',
      seen.length === 0,
      `[${seen.join(',')}]`,
    );

    // ── ② 클릭 ───────────────────────────────────────────────
    const surfaceBtn = btns[1];
    surfaceBtn?.click();
    check(
      '★★★ 옷 사이즈 버튼을 누르면 **그 짝 상자만** 보인다 (짝이 뒤바뀌면 여기서 갈린다)',
      shown().join(',') === 'surfacePanel',
      `보이는 것: [${shown().join(',')}]`,
    );
    check(
      '★★ 보이는 상자는 언제나 하나다 (둘 다 뜨면 겹치고, 하나도 없으면 칸이 빈다)',
      shown().length === 1,
      `${shown().length}개`,
    );
    check(
      '버튼 표식도 같이 넘어간다 (.on · aria-selected · tabIndex)',
      btns[1]?.classList.contains('on') === true && btns[0]?.classList.contains('on') === false
      && btns[1]?.getAttribute('aria-selected') === 'true'
      && btns[0]?.getAttribute('aria-selected') === 'false'
      && btns.map((b) => b.tabIndex).join(',') === '-1,0',
      btns.map((b) => `${b.textContent}:${b.tabIndex}`).join(' '),
    );
    check(
      'onChange 가 바뀐 탭 id 로 한 번 울렸다',
      seen.join(',') === 'surface',
      `[${seen.join(',')}]`,
    );
    surfaceBtn?.click();
    check(
      '★★ 같은 버튼을 다시 눌러도 onChange 가 또 울리지 않는다 (안 바뀌었으므로)',
      seen.join(',') === 'surface',
      `[${seen.join(',')}]`,
    );
    btns[0]?.click();
    check(
      '아바타로 되돌아온다 (왕복이 된다)',
      shown().join(',') === 'avatarPanel' && seen.join(',') === 'surface,avatar',
      `보이는 것: [${shown().join(',')}] onChange=[${seen.join(',')}]`,
    );
  });

  // ── ③ 마크업이 어긋나면 ────────────────────────────────────
  withFakeDom(['avatarPanel'], (dom) => {
    let msg = '';
    try {
      makeSideTabs(dom);
    } catch (err: unknown) {
      msg = messageOf(err);
    }
    check(
      '★★ 상자가 없으면 생성자가 던진다 — 탭만 있고 내용이 없는 칸을 조용히 만들지 않는다',
      msg !== '' && msg.includes('surfacePanel'),
      msg || '(던지지 않았다)',
    );
  });

  // ── ④ 스크롤 기억 ──────────────────────────────────────────
  //
  // 아바타는 슬라이더 29 + 치수 25 로 길고 옷 사이즈는 24행으로 짧다. 그
  // **길이 차이**가 이 절이 존재하는 이유다 — 짧은 탭에서 긴 탭으로 돌아올 때
  // 복원 순서가 틀리면 그때만 자국이 남는다.
  withFakeDom(paneIds, (dom) => {
    dom.scroll.clientHeight = 400;
    const avatarPane = dom.panes.get('avatarPanel');
    const surfacePane = dom.panes.get('surfacePanel');
    if (avatarPane) avatarPane.contentHeight = 2_000; // 체형 54행
    if (surfacePane) surfacePane.contentHeight = 600; // 옷 사이즈 24행
    const w = makeSideTabs(dom);

    // 대조군 ⓐ — 스텁이 정말로 브라우저처럼 자르는가. 이걸 먼저 확인하지
    // 않으면 아래 ★★★ 이 "복원을 앞으로 옮겨도 초록" 인 이빨 없는 단언이 된다.
    dom.scroll.scrollTop = 99_999;
    check(
      '대조군: 긴 탭(2000)에서는 1600 까지만 내려간다 — 스텁이 브라우저의 잘림을 흉내낸다',
      dom.scroll.scrollTop === 1_600,
      `${dom.scroll.scrollTop}`,
    );

    dom.scroll.scrollTop = 800;
    check('전제: 아바타 탭에서 800 까지 내려가 있다', dom.scroll.scrollTop === 800, `${dom.scroll.scrollTop}`);

    w.select('surface');
    check(
      '★★ 처음 여는 탭은 0 에서 시작한다 (직전 탭의 위치를 물려받지 않는다)',
      dom.scroll.scrollTop === 0,
      `${dom.scroll.scrollTop}`,
    );

    // 대조군 ⓑ — 짧은 탭에서는 200 이 천장이다. 즉 800 은 이 상태에서 대입하면
    // 반드시 200 으로 잘린다 → 복원이 render() 앞이면 아래 ★★★ 이 빨간불이 된다.
    dom.scroll.scrollTop = 99_999;
    check(
      '대조군: 짧은 탭(600)에서는 200 까지만 내려간다 (800 을 여기서 대입하면 잘린다)',
      dom.scroll.scrollTop === 200,
      `${dom.scroll.scrollTop}`,
    );

    dom.scroll.scrollTop = 150;
    check('전제: 옷 사이즈 탭에서 150 까지 내려가 있다', dom.scroll.scrollTop === 150, `${dom.scroll.scrollTop}`);

    w.select('avatar');
    check(
      '★★★ 돌아오면 떠날 때 보던 자리(800)가 그대로다 — 복원이 render() **뒤**라서 짧은 탭 높이에 안 잘린다',
      dom.scroll.scrollTop === 800,
      `${dom.scroll.scrollTop}`,
    );

    w.select('surface');
    check(
      '★★ 반대쪽도 각자 기억한다 (두 탭이 값 하나를 나눠 쓰지 않는다)',
      dom.scroll.scrollTop === 150,
      `${dom.scroll.scrollTop}`,
    );

    dom.scroll.scrollTop = 40;
    w.select('surface');
    check(
      '★★★ 같은 탭을 다시 눌러도 보던 자리가 안 튄다 (저장·복원은 실제로 바뀔 때만)',
      dom.scroll.scrollTop === 40,
      `${dom.scroll.scrollTop}`,
    );

    w.select('avatar');
    check(
      '★★ 재클릭 뒤에도 기억이 안 망가졌다 (아바타는 여전히 800)',
      dom.scroll.scrollTop === 800,
      `${dom.scroll.scrollTop}`,
    );
    w.select('surface');
    check(
      '★★ 재클릭 직전에 보던 40 이 옷 사이즈의 새 기억이다 (150 이 아니다)',
      dom.scroll.scrollTop === 40,
      `${dom.scroll.scrollTop}`,
    );
  });

  // ── ⑤ onChange 가 보는 상태 ────────────────────────────────
  //
  // ★ 돌연변이 검증에서 **아무 단언도 안 잡던 자리**라 뒤늦게 못박는다.
  //   `onChange` 를 복원보다 **먼저** 울리게 바꿔도 54건이 전부 초록이었다.
  //
  // 지금은 `main.ts` 가 `onChange` 를 넘기지 않아 화면에 자국이 안 남지만,
  // 바깥이 이 콜백 안에서 스크롤 위치를 읽거나 패널을 다시 그리기 시작하는
  // 순간 순서가 곧 정확성이 된다 — 복원보다 먼저 울리면 핸들러가 **떠나기 전
  // 탭의 자리**(그것도 짧은 탭 높이로 잘린 값)를 보고 판단한다. 두 줄의
  // 순서라 다음 사람이 뒤집어도 아무 데서도 안 걸린다.
  withFakeDom(paneIds, (dom) => {
    dom.scroll.clientHeight = 400;
    const avatarPane = dom.panes.get('avatarPanel');
    const surfacePane = dom.panes.get('surfacePanel');
    if (avatarPane) avatarPane.contentHeight = 2_000;
    if (surfacePane) surfacePane.contentHeight = 600;
    const seenAt: number[] = [];
    const w = makeSideTabs(dom, () => seenAt.push(dom.scroll.scrollTop));

    dom.scroll.scrollTop = 800;
    w.select('surface'); // 처음 여는 탭 → 0
    w.select('avatar'); // 돌아오면 800
    check(
      '★★ onChange 는 스크롤 복원이 **끝난 뒤** 울린다 (핸들러가 떠난 탭의 자리를 보지 않는다)',
      seenAt.join(',') === '0,800',
      `[${seenAt.join(',')}]`,
    );
  });

  check(
    '스텁 DOM 을 원복했다 (뒤 절이 가짜 document 를 물려받지 않는다)',
    !('document' in (globalThis as unknown as Record<string, unknown>)),
  );
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
  sectionCloth2D();
  sectionClothMaterial();
  sectionUnfold();
  sectionUnfoldControl();
  sectionFrameStreamQueue();
  sectionFrameStreamCloth();
  await sectionSnapshotMachine();
  sectionSnapshotObject();
  await sectionViewerRealScene();
  await sectionReconnectReload();
  await sectionRealFrames();
  await sectionSnapshotRealExport();
  // #14 재생 상태 기계. §10-1~§10-9 는 가짜 포트라 즉시 끝나고, §10-10 만
  // 실제 워커를 하나 띄운다 — 그 모형이 실제와 같은지 확인하는 절이다.
  await sectionPlaybackDerived();
  await sectionPlaybackIssue009();
  await sectionPlaybackFrames();
  await sectionPlaybackSubscribe();
  await sectionPlaybackHooks();
  await sectionPlaybackFailures();
  await sectionPlaybackResetClear();
  await sectionPlaybackStep();
  sectionPlaybackShortcuts();
  await sectionPlaybackRealWorker();
  // #16-a 파라미터 스키마. §11-1~§11-6 은 순수 함수라 즉시 끝나고, §11-7 만
  // 실제 워커를 하나 띄운다 — 스키마의 키가 **빌드된 워커**와 같은지 보는 절이다.
  sectionParamKeys();
  sectionParamSchema();
  sectionParamMeasured();
  sectionParamCoerce();
  sectionParamDisabled();
  sectionParamPayload();
  await sectionParamRealWorker();
  // L-3c 오른쪽 칸의 탭. 워커가 필요 없다 — 판단(§13)과 스텁 DOM 위의
  // 그리기(§13-2)뿐이라 즉시 끝난다.
  sectionSideTabs();
  sectionSideTabsDom();
  // D2-e 재단 도면의 표시 스위치. DOM 도 워커도 안 쓴다 — 깨지면 조용한
  // 두 가지(접두사 우선순위 · 재로드 후 상태 유지)만 좁게 본다.
  sectionDesignLayers();
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
