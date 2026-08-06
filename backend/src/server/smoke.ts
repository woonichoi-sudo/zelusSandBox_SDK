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

import { createServer, type Gateway, type GatewayAddress, type GatewayOptions } from './index.ts';

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

    // 진단: 생성자에서 404 catch-all이 이미 등록돼 있으므로, app 게터로
    // 나중에 붙인 라우트가 도달 가능한지는 미리 알아둘 값이다. #5가
    // 라우트를 어디에 추가해야 하는지가 여기서 갈린다.
    gw.app.get('/api/__probe', (_req, res) => {
      res.json({ probe: true });
    });
    const probe = await get(`${addr.url}/api/__probe`);
    note(
      'app 게터로 사후 등록한 라우트',
      probe.status === 200
        ? '도달함 (200)'
        : `도달 불가 (${probe.status}) — catch-all 뒤에 붙는다. #5는 index.ts 안에 라우트를 등록할 것`,
    );
  });

  // ── §4. 이후 단위가 여기에 섹션을 추가한다 ────────────
  // 예:
  //   section('5. 파일 업로드');
  //   await withServer(async (_gw, addr) => {
  //     const res = await get(`${addr.url}/api/files`, { method: 'POST', ... });
  //     check('...', res.status === 200);
  //   });
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
