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

import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  createServer,
  type Gateway,
  type GatewayAddress,
  type GatewayOptions,
  type RouteContext,
  type RouteRegistrar,
} from './index.ts';

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
