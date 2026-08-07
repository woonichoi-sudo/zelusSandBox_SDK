/**
 * 씬 파일 저장소(업로드/목록)와 익스포트 산출물 저장소(다운로드).
 *
 * 두 저장소가 한 파일에 있는 이유는 **같은 규칙 위에 서 있기 때문**이다:
 * 클라이언트가 준 문자열은 경로가 되지 않고, 경로는 서버가 만든 128비트 id로만
 * 조립되며, 사이드카 JSON이 "완결됐다"의 유일한 표시다. 방향만 반대다 —
 * 씬은 들어오고(업로드) 익스포트는 나간다(다운로드).
 *
 * ── 씬 저장소 ─────────────────────────────────────────────
 *
 * 설계의 뿌리는 두 가지 사실이다:
 *
 *   1. `.zls`는 크다. 검증용 sample.zls가 103MB고 실서비스는 더 커진다.
 *      본문을 메모리에 올리는 순간 동시 업로드 몇 건에 프로세스가 죽는다.
 *      → 요청 스트림을 파일로 **직접 흘린다**. Buffer로 모으는 지점이 없다.
 *
 *   2. 파일명은 클라이언트가 준다. 그걸로 경로를 만들면 traversal이 열린다.
 *      → **경로를 이름으로 만들지 않는다.** 저장 파일명은 서버가 만든
 *        128비트 난수 id뿐이고(`<id>.zls`), 클라이언트 이름은 사이드카
 *        JSON에 **데이터로만** 들어간다. 검증을 뚫려도 경로가 안 바뀐다 —
 *        방어가 아니라 구조로 막는 쪽이다.
 *
 * 저장 레이아웃 (dir 하나, 평평하게):
 *
 *   <id>.zls    씬 본체
 *   <id>.json   { id, name, bytes, uploadedAt }
 *   <id>.part   업로드 진행 중인 임시 파일 (성공하면 rename으로 사라진다)
 *
 * 목록은 **사이드카를 훑어서** 만든다. 그리고 사이드카는 본체 rename이
 * 끝난 뒤에 쓴다. 그래서 "목록에 보인다 ⇒ 본체가 완결돼 있다"가 성립한다 —
 * 반쯤 쓰인 .part는 어떤 경로로도 목록에 오르지 못한다. #6이 목록을 보고
 * load를 부르므로 이 불변식이 곧 다음 단계의 안정성이다.
 *
 * ── 익스포트 저장소 (#10) ─────────────────────────────────
 *
 * 아래 `ExportStore`. 씬과 결정적으로 다른 점이 하나 있고, 정리 정책이 전부
 * 거기서 나온다: **파일을 쓰는 것이 우리가 아니라 워커 프로세스다.** 그래서
 * `.part` → rename 트릭을 쓸 수 없다(워커는 우리가 준 경로에 그대로 쓴다).
 * 대신 **사이드카를 완결 표시로 쓰는 규칙은 그대로 유지한다** —
 * `commit()`이 파일을 stat 해서 실재를 확인한 뒤에야 `<id>.json`을 쓰고,
 * 다운로드·조회는 사이드카만 본다. 워커가 실패했거나 중간에 죽어 남은
 * 반쪽짜리 파일은 사이드카가 없으므로 **아무도 내려받을 수 없고**, TTL 청소가
 * 회수한다.
 *
 * 왜 정리 정책이 이 단위의 일부인가: `export`는 게이트웨이가 **디스크를 쓰는
 * 유일한 op**이고 산출물이 크다(실측 9.7MB~36.5MB, 1.6~4.3초). 지우는 규칙
 * 없이 열면 기능이 아니라 디스크 고갈 경로가 하나 생긴다. 그래서 세 겹이다:
 *
 *   ① 세션당 개수 상한  — 한 연결이 만든 것이 상한을 넘으면 **가장 오래된 것**을
 *                          즉시 지운다. 상한 자리는 bridge.ts(연결이 자기 것을
 *                          아는 유일한 곳)이고, 여기는 `maxPerSession` 값과
 *                          `discard()`만 제공한다.
 *   ② TTL 청소          — mtime이 `ttlMs`를 넘긴 파일은 전부 지운다. 세션이
 *                          끝나면 ①을 발동시킬 주체가 사라지므로, **연결 수명을
 *                          넘겨 살아남은 파일을 회수하는 것은 이쪽뿐이다.**
 *   ③ 실패 즉시 폐기     — 워커가 export에 실패하면 bridge가 `discard()`를 부른다.
 *                          ②가 있어도 30분짜리 지연 회수라, 실패를 아는 순간
 *                          지우는 편이 싸다.
 *
 * **연결이 닫힐 때 그 세션의 산출물을 지우지 않는다.** 다운로드는 WS가 아니라
 * 별개의 HTTP 요청이고 수명이 다르다 — 탭을 닫는 순간 WS가 먼저 끊기므로,
 * 연결 수명에 묶으면 진행 중인 다운로드가 그때마다 죽는다. 그 대가로 남는
 * "주인 없는 파일"을 ②가 받아낸다.
 *
 * **청소에 타이머를 쓰지 않는다.** `RouteHooks`에는 `prepare`만 있고 종료 훅이
 * 없어서(index.ts), 인터벌을 두면 `Gateway.close()`가 정리해야 할 수명이 하나
 * 는다. 대신 기동 시 한 번과 **새 익스포트를 만들기 직전**에 쓸어낸다(60초
 * 스로틀). 디스크가 느는 계기가 export 하나뿐이므로 그 자리에서 쓸면 충분하다.
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Express, NextFunction, Request, Response } from 'express';

import type { RouteRegistrar } from './index.ts';

/** 목록·업로드 응답의 씬 한 건. 서버 경로는 **의도적으로 없다** */
export interface SceneRecord {
  /** 32자리 hex. 이후 단계가 씬을 가리키는 유일한 이름 */
  id: string;
  /** 클라이언트가 준 원본 파일명 (표시용) */
  name: string;
  /** 저장된 바이트 수 */
  bytes: number;
  /** ISO 8601 */
  uploadedAt: string;
}

export interface SceneStoreOptions {
  /** 저장 디렉토리. 절대경로 권장 */
  dir: string;
  /** 업로드 1건의 상한(바이트). 기본 512MiB */
  maxBytes?: number;
}

/** 기본 상한 512MiB — sample.zls(103MB)의 5배. 넉넉하되 무제한은 아니다 */
export const DEFAULT_MAX_SCENE_BYTES = 512 * 1024 * 1024;

/**
 * 상한을 넘긴 요청의 남은 본문을 버려가며 더 읽어줄 최대량.
 *
 * 순수하게 **에러 메시지를 전달하기 위한** 예산이다. 아래 create() 참고.
 * 8MiB면 흔한 초과(상한 바로 위)는 전부 덮으면서, 무한정 받아주는 일도 없다.
 */
const OVERFLOW_DRAIN_BUDGET = 8 * 1024 * 1024;

/** 저장 파일명에 쓰이는 id의 유일한 형태. 여기서 벗어나면 경로를 만들지 않는다 */
const ID_RE = /^[0-9a-f]{32}$/;

/** 받아들이는 확장자 (소문자 비교) */
const ALLOWED_EXT = '.zls';

/** 이름의 최대 길이. 파일명이 아니라 메타데이터지만 무한정 받을 이유가 없다 */
const MAX_NAME_LENGTH = 128;

/**
 * Windows 예약 장치명. 저장 경로에는 안 쓰이지만, #10 다운로드가 이 이름을
 * Content-Disposition에 실으면 클라이언트 쪽에서 문제가 된다.
 */
const RESERVED_BASENAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * 이름에 있으면 무조건 거부하는 문자.
 *
 * `/` `\`는 경로 구분자, `:`는 드라이브 문자와 NTFS ADS(`a.zls:evil`),
 * 나머지는 Windows 금지 문자이거나 헤더·쉘에서 말썽이 되는 것들이다.
 * 제어문자(C0/DEL/C1)는 널바이트 잘림과 헤더 인젝션을 동시에 막는다.
 */
const FORBIDDEN_NAME_CHARS = /[\u0000-\u001F\u007F-\u009F/\\:*?"<>|]/;

/** status를 달아 던진다. index.ts의 에러 핸들러가 이 필드를 존중한다 */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * 클라이언트가 준 이름을 검증한다. 통과하면 NFC 정규화된 이름을 돌려준다.
 *
 * **중요**: 이 함수의 반환값은 경로 조립에 쓰이지 않는다. 저장 경로는 서버가
 * 만든 id로만 만들어지므로, 여기가 뚫려도 파일이 dir 밖으로 나가지 않는다.
 * 그래도 검증하는 이유는 (a) 목록·다운로드에 그대로 노출되고 (b) #10이
 * Content-Disposition에 실을 값이며 (c) 엔진이 못 여는 파일을 받아두면
 * 실패가 로드 시점까지 미뤄지기 때문이다.
 *
 * 규칙을 하나씩 따로 검사하는 건 취향이 아니라 진단 때문이다 — 정규식 하나로
 * 뭉치면 클라이언트가 "왜 400인지"를 알 수 없다.
 */
export function validateSceneName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw httpError(400, '씬 이름이 필요합니다 (예: POST /api/scenes?name=sample.zls)');
  }

  // 정규화를 먼저 한다. 이후 검사가 보는 문자열과 저장되는 문자열이 같아야 한다.
  const name = raw.normalize('NFC');

  if (name.length > MAX_NAME_LENGTH) {
    throw httpError(400, `씬 이름이 너무 깁니다 (${name.length}자, 최대 ${MAX_NAME_LENGTH}자)`);
  }
  if (FORBIDDEN_NAME_CHARS.test(name)) {
    throw httpError(400, '씬 이름에 쓸 수 없는 문자가 있습니다 (경로 구분자·제어문자·: * ? " < > |)');
  }
  // `..`와 `.`은 위 문자 검사를 통과한다. 경로로 안 쓰더라도 이름으로서 무의미하다.
  if (name === '.' || name === '..') {
    throw httpError(400, '씬 이름이 올바르지 않습니다');
  }
  // Windows는 끝의 공백·점을 조용히 잘라낸다. 받은 이름과 보이는 이름이 달라진다.
  if (name !== name.trim() || name.endsWith('.')) {
    throw httpError(400, '씬 이름의 앞뒤에 공백이나 점을 둘 수 없습니다');
  }

  const lower = name.toLowerCase();
  if (!lower.endsWith(ALLOWED_EXT)) {
    // 엔진이 여는 건 .zls뿐이다. 아무거나 받아두면 실패가 #6의 load까지
    // 미뤄지고, 그쪽 에러 메시지는 원인을 지목하지 못한다.
    throw httpError(415, `${ALLOWED_EXT} 파일만 업로드할 수 있습니다 (받은 이름: ${name})`);
  }
  if (lower === ALLOWED_EXT) {
    throw httpError(400, '확장자만으로는 이름이 될 수 없습니다');
  }
  if (RESERVED_BASENAMES.has(lower.slice(0, -ALLOWED_EXT.length))) {
    throw httpError(400, 'Windows 예약 장치명은 씬 이름으로 쓸 수 없습니다');
  }

  return name;
}

function isSceneRecord(v: unknown): v is SceneRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' && ID_RE.test(r['id'])
    && typeof r['name'] === 'string'
    && typeof r['bytes'] === 'number'
    && typeof r['uploadedAt'] === 'string'
  );
}

/**
 * 디스크 위의 씬 저장소.
 *
 * 라우트와 분리해 둔 이유는 #6이다 — 워커의 load op은 **파일 절대경로**를
 * 받는데, 그 경로를 아는 건 여기뿐이다. 게이트웨이는 `gw.scenes.pathOf(id)`로
 * id를 경로로 바꾸고, 클라이언트는 경로를 영영 보지 못한다.
 */
export class SceneStore {
  readonly dir: string;
  readonly maxBytes: number;

  constructor(opts: SceneStoreOptions) {
    this.dir = path.resolve(opts.dir);
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_SCENE_BYTES;
    if (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error(`maxBytes가 올바르지 않습니다: ${String(opts.maxBytes)}`);
    }
  }

  /** start()가 리스닝 직전에 부른다. 재기동마다 불리므로 멱등해야 한다 */
  async prepare(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /**
   * id → 씬 파일 절대경로. #6이 워커의 load op에 넘길 값이다.
   *
   * 형태 검사가 곧 traversal 방어의 두 번째 층이다. id는 서버가 만든
   * 것뿐이지만, 이 함수는 언젠가 요청 파라미터(`/api/scenes/:id`)를 받게
   * 된다 — 그때 방어가 이미 여기 있어야 한다.
   */
  pathOf(id: string): string {
    if (!ID_RE.test(id)) throw httpError(400, `씬 id 형식이 올바르지 않습니다: ${id}`);
    return path.join(this.dir, `${id}${ALLOWED_EXT}`);
  }

  #metaPath(id: string): string {
    if (!ID_RE.test(id)) throw httpError(400, `씬 id 형식이 올바르지 않습니다: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  /** 한 건 조회. 없으면 null (사이드카가 없거나 본체가 사라진 경우 포함) */
  async get(id: string): Promise<SceneRecord | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#metaPath(id), 'utf8'));
    } catch {
      return null;
    }
    if (!isSceneRecord(parsed) || parsed.id !== id) return null;
    try {
      await stat(this.pathOf(id));
    } catch {
      return null; // 사이드카만 남고 본체가 없다 — 없는 것으로 취급한다
    }
    return parsed;
  }

  /** 최신 업로드가 먼저. 본체가 확인되는 것만 나온다 */
  async list(): Promise<SceneRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return []; // prepare 전이거나 디렉토리가 지워졌다
    }

    const ids = entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .filter((id) => ID_RE.test(id));

    const records = await Promise.all(ids.map((id) => this.get(id)));
    return records
      .filter((r): r is SceneRecord => r !== null)
      .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0));
  }

  /**
   * 스트림을 새 씬으로 받아 적는다.
   *
   * 성공 경로: `<id>.part`에 흘려 적기 → `<id>.zls`로 rename → 사이드카 쓰기.
   * rename은 같은 볼륨 안이라 원자적이므로, `<id>.zls`가 존재한다면 그건
   * 항상 완결된 파일이다. 실패하면 .part를 지우고 던진다 — 목록은 사이드카를
   * 보므로, 지우기까지 실패해도(프로세스 강제 종료 등) 잔해가 목록에 뜨지 않는다.
   *
   * id가 매번 새로 생기므로 **이름 충돌이라는 개념 자체가 없다.** 같은 이름을
   * 두 번 올리면 서로 다른 씬 두 건이 된다. 덮어쓰기가 없으니 진행 중인 다른
   * 세션의 파일을 밟는 사고도 없다.
   */
  async create(name: string, source: Readable, declaredBytes?: number): Promise<SceneRecord> {
    if (declaredBytes !== undefined && declaredBytes > this.maxBytes) {
      throw httpError(
        413,
        `씬이 너무 큽니다: ${declaredBytes} 바이트 (상한 ${this.maxBytes})`,
      );
    }

    const id = randomBytes(16).toString('hex');
    const tmpPath = path.join(this.dir, `${id}.part`);
    const finalPath = this.pathOf(id);
    const max = this.maxBytes;

    let bytes = 0;
    try {
      // 요청 스트림 → 파일. 중간에 Buffer로 모으는 지점이 없다.
      // 카운터를 제너레이터로 끼우는 이유: content-length는 클라이언트가
      // 주장하는 값이고 chunked 인코딩에는 아예 없다. 실제로 흘러간 양을
      // 세야 상한이 상한이 된다.
      await pipeline(
        source,
        async function* count(chunks: AsyncIterable<Buffer>) {
          let overflow = false;
          let drained = 0;

          for await (const chunk of chunks) {
            if (overflow) {
              // 상한을 넘긴 뒤에도 **조금은 더 읽어준다**. 여기서 바로 던지면
              // pipeline이 요청 스트림을 파괴하고, 아직 본문을 보내는 중인
              // 클라이언트는 413 응답 대신 ECONNRESET을 본다 — 실제로 그렇게
              // 동작하는 걸 확인했다. 남은 본문이 이 예산 안에서 끝나면 연결이
              // 멀쩡한 채로 413이 전달된다. 예산을 넘기면 그때는 끊는다.
              drained += chunk.length;
              if (drained > OVERFLOW_DRAIN_BUDGET) {
                throw httpError(413, `씬이 너무 큽니다: 상한 ${max} 바이트를 넘었습니다`);
              }
              continue;
            }
            bytes += chunk.length;
            if (bytes > max) {
              overflow = true;
              continue;
            }
            yield chunk;
          }

          // 본문을 끝까지 읽고 나서 던진다. 이 시점엔 요청이 이미 끝나 있어
          // 스트림을 파괴해도 RST가 나지 않는다.
          if (overflow) {
            throw httpError(413, `씬이 너무 큽니다: ${bytes} 바이트 (상한 ${max})`);
          }
        },
        createWriteStream(tmpPath),
      );
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }

    if (bytes === 0) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw httpError(400, '본문이 비어 있습니다');
    }

    await rename(tmpPath, finalPath);

    const record: SceneRecord = {
      id,
      name,
      bytes,
      uploadedAt: new Date().toISOString(),
    };
    try {
      // 사이드카가 마지막이다 — 이게 있으면 본체는 이미 완결돼 있다.
      await writeFile(this.#metaPath(id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    } catch (err) {
      await rm(finalPath, { force: true }).catch(() => {});
      throw err;
    }
    return record;
  }
}

/** 요청 스트림을 그대로 흘려야 하므로, 바디 파서가 먼저 먹으면 안 되는 타입들 */
function assertStreamableBody(req: Request): void {
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

  // index.ts의 전역 express.json({limit:'1mb'})은 content-type이
  // application/json일 때만 동작한다. 그 경우 요청 스트림이 이미 소진돼
  // 0바이트 파일이 생기거나, 1MB를 넘으면 파서가 413으로 먼저 끊는다.
  // 둘 다 원인을 지목하지 못하는 실패라 여기서 명시적으로 막는다.
  if (type === 'application/json') {
    throw httpError(
      415,
      '업로드 본문은 application/json일 수 없습니다. application/octet-stream으로 보내세요',
    );
  }
  // multipart는 파싱하지 않는다(의존성 추가 없이 스트리밍 파서를 쓰기 어렵고,
  // 원시 본문이면 파일 바이트가 그대로 디스크로 간다 — 해시가 정확히 일치한다).
  if (type === 'multipart/form-data') {
    throw httpError(
      415,
      'multipart는 지원하지 않습니다. 파일 바이트를 본문에 그대로 담고 이름은 ?name= 로 보내세요',
    );
  }
}

/** content-length를 숫자로. 없거나 이상하면 undefined (chunked 등) */
function declaredLength(req: Request): number | undefined {
  const raw = req.headers['content-length'];
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** 쿼리 파라미터 하나를 문자열로. 배열/객체로 오면 거부 대상이 되게 undefined */
function queryString(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * 씬 라우트를 등록한다. index.ts의 "라우트 등록 지점"에서 부른다.
 *
 * 저장소를 인자로 받는 이유는 게이트웨이가 같은 인스턴스를 #6에 넘겨야 하기
 * 때문이다. 여기서 만들어 감춰버리면 세션 라우트가 경로를 알 길이 없다.
 */
export function createSceneRoutes(store: SceneStore): RouteRegistrar {
  return (app: Express, ctx) => {
    app.post('/api/scenes', async (req: Request, res: Response) => {
      assertStreamableBody(req);
      const name = validateSceneName(queryString(req, 'name'));

      const started = performance.now();
      let record;
      try {
        record = await store.create(name, req, declaredLength(req));
      } catch (err) {
        // 업로드가 중간에 끊긴 요청은 본문이 다 읽히지 않은 채로 남는다.
        // 그 소켓을 keep-alive로 돌려주면 두 가지가 동시에 나빠진다:
        //   - Node가 응답 후 남은 본문을 끝까지 읽어 버린다. 거절해 놓고
        //     상한만큼이 아니라 요청 전체를 받는 셈이라 상한이 무의미해진다.
        //   - 실제로는 스트림이 파괴되며 RST가 나가, 그 소켓을 재사용한
        //     클라이언트의 **다음** 요청이 ECONNRESET으로 죽는다 (재현됨).
        // Connection: close로 이 소켓은 여기서 끝임을 명시한다.
        //
        // 본문을 끝까지 읽은 뒤의 실패(상한 초과를 드레인으로 확인한 경우 등)는
        // 소켓이 멀쩡하므로 그대로 재사용하게 둔다 — 클라이언트가 413 하나
        // 때문에 연결을 새로 맺을 이유는 없다.
        if (!res.headersSent && !req.readableEnded) res.set('Connection', 'close');

        // 클라이언트가 업로드 도중 끊은 것(탭 닫기, 네트워크 끊김)은 서버
        // 장애가 아니다. status 없이 던지면 500 [error]로 찍히는데, 대용량
        // 업로드에서는 흔한 일이라 진짜 장애가 그 로그에 묻힌다. 499
        // (nginx 관례: client closed request)로 낮춰 [warn]으로 보낸다.
        // 어차피 소켓이 죽어 응답은 나가지 않으므로 코드 선택의 부작용은 없다.
        if (
          err instanceof Error
          && typeof (err as { status?: unknown }).status !== 'number'
          && !req.readableEnded
        ) {
          (err as Error & { status?: number }).status = 499;
        }
        throw err;
      }
      const ms = Math.round(performance.now() - started);

      ctx.log(`씬 업로드 ${record.id} "${record.name}" ${record.bytes} 바이트, ${ms}ms`);
      res.status(201).json({ scene: record });
    });

    app.get('/api/scenes', async (_req: Request, res: Response) => {
      const scenes = await store.list();
      res.json({ scenes, count: scenes.length });
    });

    return { prepare: () => store.prepare() };
  };
}

// ══ 익스포트 산출물 (#10) ═══════════════════════════════════════

/**
 * 워커가 만들 수 있는 산출물 형식. `protocol.cpp`의 export op이 아는 값과 같다.
 *
 * `.zbin`은 **쓰기 전용**이다 — 엔진에 역직렬화 경로가 없어 우리도 남도 다시
 * 못 읽는다(CLAUDE.md). 그래도 막지 않는 이유는 데스크톱 앱이 제공하는 기능을
 * 게이트웨이가 임의로 줄일 근거가 없어서다. 사용처를 아는 쪽은 사용자다.
 */
export type ExportFormat = 'gltf' | 'zbin';

/**
 * 형식 → 확장자. **경로에 확장자가 들어오는 유일한 통로가 이 표다.**
 * 클라이언트 문자열이 여기 없는 값이면 `pathOf`가 던지므로, 확장자를 통한
 * 경로 조작(`../x`, `.gltf:evil`)이 성립할 자리가 없다.
 */
const EXPORT_EXT: Record<ExportFormat, string> = {
  gltf: '.gltf',
  zbin: '.zbin',
};

/**
 * 형식 → 다운로드 content-type. **명시적으로 정한다.**
 *
 * express가 확장자로 추측하게 두지 않는 이유는 ISSUE-003의 교훈이다 —
 * content-type을 프레임워크의 기본값에 맡기면, 그게 바뀌었을 때 아무도
 * 모르고 증상은 엉뚱한 곳(브라우저의 파서)에서 나온다.
 * `model/gltf+json`은 IANA 등록 타입이고 three.js의 `GLTFLoader`가 받는다.
 */
const EXPORT_CONTENT_TYPE: Record<ExportFormat, string> = {
  gltf: 'model/gltf+json; charset=utf-8',
  zbin: 'application/octet-stream',
};

export function isExportFormat(v: unknown): v is ExportFormat {
  return v === 'gltf' || v === 'zbin';
}

/** 익스포트 한 건. 씬과 마찬가지로 **서버 경로는 의도적으로 없다** */
export interface ExportRecord {
  /** 32자리 hex. 다운로드 URL이 되는 유일한 이름 */
  id: string;
  /** 다운로드 시 브라우저에 제안할 파일명. **경로가 아니라 헤더 값이다** */
  name: string;
  format: ExportFormat;
  bytes: number;
  /** ISO 8601 */
  createdAt: string;
  /** 만든 연결(세션)의 id. 진단용이며 접근 제어에 쓰이지 않는다 */
  sessionId: string;
}

export interface ExportStoreOptions {
  /** 저장 디렉토리. 절대경로 권장 */
  dir: string;
  /** 산출물의 수명(ms). 기본 30분 */
  ttlMs?: number;
  /** 한 연결이 동시에 보유할 수 있는 산출물 수. 기본 4 */
  maxPerSession?: number;
}

/**
 * 산출물 수명 기본값 30분.
 *
 * 위로: 다운로드는 익스포트 **직후 몇 초 안에** 일어난다(브라우저가 URL을 받자
 * 마자 받는다). 30분이면 "탭을 열어 둔 채 자리를 비웠다 돌아온" 경우까지 덮는다.
 * 아래로: 36.5MB짜리가 세션당 4개씩 쌓이므로, 수명이 시간 단위가 되면 하루
 * 몇십 세션만으로 수 GB가 된다. 다운로드 성공률과 디스크가 만나는 지점이 이쯤이다.
 */
export const DEFAULT_EXPORT_TTL_MS = 30 * 60 * 1000;

/**
 * 연결 하나가 보유할 수 있는 산출물 수 기본값 4.
 *
 * 근거는 크기다 — 실측 9.7MB(sample.zls) ~ 36.5MB(사용자 씬 24패턴)이므로
 * 4개면 최악 **세션당 약 146MB**다. 세션 수는 라이선스 인스턴스가 이미
 * 상한을 걸고 있어(`maxTotal`) 곱한 값이 예측 가능한 범위에 머문다.
 *
 * 왜 1이 아닌가: 같은 씬을 프레임을 달리해 뽑거나 형식을 바꿔 비교하는 것이
 * 익스포트의 정상적인 쓰임이고, 1이면 방금 받은 링크가 다음 클릭에 죽는다.
 * 왜 더 크지 않은가: 5개째가 필요한 시나리오가 떠오르지 않고, 상한이 하는
 * 일은 "사용자가 실수로 연타했을 때 디스크를 지키는 것"이라 낮을수록 낫다.
 */
export const DEFAULT_MAX_EXPORTS_PER_SESSION = 4;

/**
 * 청소를 다시 돌기까지의 최소 간격. 익스포트를 연타해도 readdir+stat이
 * 익스포트 자체(1.6초 이상)보다 자주 돌 이유가 없다.
 */
const SWEEP_MIN_INTERVAL_MS = 60 * 1000;

/** 다운로드 파일명의 최대 길이 (확장자 제외) */
const MAX_DOWNLOAD_BASE_LENGTH = 96;

function isExportRecord(v: unknown): v is ExportRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' && ID_RE.test(r['id'])
    && typeof r['name'] === 'string'
    && isExportFormat(r['format'])
    && typeof r['bytes'] === 'number'
    && typeof r['createdAt'] === 'string'
    && typeof r['sessionId'] === 'string'
  );
}

/**
 * 다운로드 시 제안할 파일명을 만든다. 통과 못 하면 `export<ext>`로 떨어진다.
 *
 * **이 값은 경로 조립에 쓰이지 않는다.** 디스크 위의 이름은 언제나 `<id><ext>`고,
 * 이건 `Content-Disposition` 헤더에만 들어간다 — `validateSceneName`이 씬
 * 이름에 대해 갖는 관계와 정확히 같다(그쪽 주석 참고). 그래도 검사하는 이유는
 * (a) 제어문자·따옴표가 헤더 인젝션이 되고 (b) 경로 구분자가 섞이면 브라우저마다
 * 다르게 잘라내며 (c) Windows 예약 장치명은 저장 자체가 실패하기 때문이다.
 *
 * 씬 이름은 이미 `validateSceneName`을 통과한 값이라 대부분 그대로 나가지만,
 * 여기서 다시 보는 것은 **출처를 믿지 않기 위해서다** — 사이드카는 디스크에
 * 있고 그 사이 무엇이든 될 수 있다.
 */
export function exportDownloadName(base: string | undefined, format: ExportFormat): string {
  const ext = EXPORT_EXT[format];
  const fallback = `export${ext}`;
  if (typeof base !== 'string') return fallback;

  // 원본 확장자(.zls 등)를 떼고 우리 확장자를 붙인다.
  const stem = base.normalize('NFC').trim().replace(/\.[^.\\/]*$/, '').trim();
  if (stem.length === 0 || stem === '.' || stem === '..') return fallback;
  if (FORBIDDEN_NAME_CHARS.test(stem)) return fallback;
  if (RESERVED_BASENAMES.has(stem.toLowerCase())) return fallback;

  // Windows가 끝의 점을 조용히 잘라내면 확장자가 붙는 자리가 흐트러진다.
  const clipped = stem.slice(0, MAX_DOWNLOAD_BASE_LENGTH).replace(/[. ]+$/, '');
  return clipped.length === 0 ? fallback : `${clipped}${ext}`;
}

/**
 * 디스크 위의 익스포트 산출물 저장소.
 *
 * 씬 저장소와 마찬가지로 라우트와 분리돼 있다. 이유도 같다 — 워커의 export op은
 * **파일 절대경로**를 받고, 그 경로를 아는 것은 여기뿐이다. 브리지는
 * `allocate()`로 경로를 얻어 워커에 넘기고, 클라이언트는 id만 본다.
 *
 * 씬과 달리 쓰는 주체가 워커라 흐름이 세 걸음이다:
 *
 *   allocate() → (워커가 그 경로에 쓴다) → commit() → 다운로드 가능
 *                                        ↘ 실패하면 discard()
 */
export class ExportStore {
  readonly dir: string;
  readonly ttlMs: number;
  readonly maxPerSession: number;

  /** 마지막 청소 시각. 스로틀 판정에만 쓴다 */
  #lastSweep = 0;

  constructor(opts: ExportStoreOptions) {
    this.dir = path.resolve(opts.dir);
    this.ttlMs = opts.ttlMs ?? DEFAULT_EXPORT_TTL_MS;
    this.maxPerSession = opts.maxPerSession ?? DEFAULT_MAX_EXPORTS_PER_SESSION;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error(`익스포트 ttlMs가 올바르지 않습니다: ${String(opts.ttlMs)}`);
    }
    if (!Number.isInteger(this.maxPerSession) || this.maxPerSession <= 0) {
      throw new Error(`익스포트 maxPerSession이 올바르지 않습니다: ${String(opts.maxPerSession)}`);
    }
  }

  /**
   * start()가 리스닝 직전에 부른다 (멱등).
   *
   * 여기서 청소를 **강제로** 한 번 돌린다. 재기동은 산출물이 회수되는 유일한
   * 다른 계기다 — 프로세스가 죽으면 세션당 상한을 발동시킬 주체가 통째로
   * 사라지므로, 지난 실행이 남긴 것을 여기서 걷지 않으면 영영 남는다.
   */
  async prepare(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.sweep(true);
  }

  /**
   * id + 형식 → 산출물 절대경로. 워커에 넘길 값이다.
   *
   * 형태 검사 두 개가 곧 traversal 방어다. id는 서버가 만든 것뿐이지만 이
   * 함수는 **요청 파라미터(`/api/exports/:id`)를 직접 받는다** — 씬 쪽
   * `pathOf`가 "언젠가 그렇게 된다"고 적어 둔 상황이 여기서는 이미 현실이다.
   */
  pathOf(id: string, format: ExportFormat): string {
    if (!ID_RE.test(id)) throw httpError(400, `익스포트 id 형식이 올바르지 않습니다: ${id}`);
    if (!isExportFormat(format)) {
      throw httpError(400, `알 수 없는 익스포트 형식입니다: ${String(format)}`);
    }
    return path.join(this.dir, `${id}${EXPORT_EXT[format]}`);
  }

  #metaPath(id: string): string {
    if (!ID_RE.test(id)) throw httpError(400, `익스포트 id 형식이 올바르지 않습니다: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  /**
   * 새 산출물 자리를 잡는다. **파일은 아직 없다** — 워커가 쓴다.
   *
   * 사이드카를 여기서 쓰지 않는 것이 요점이다. 사이드카가 곧 "완결됐다"이므로,
   * 워커가 실패하거나 도중에 죽으면 남는 것은 아무도 못 찾는 파일 하나뿐이고
   * TTL 청소가 회수한다.
   */
  async allocate(format: ExportFormat): Promise<{ id: string; path: string }> {
    // 디스크가 느는 유일한 계기가 여기다. 새로 쌓기 전에 만료된 것을 걷는다.
    await this.sweep();
    const id = randomBytes(16).toString('hex');
    return { id, path: this.pathOf(id, format) };
  }

  /**
   * 워커가 썼다고 한 파일을 확인하고 사이드카를 남긴다. 이 뒤로 다운로드가 된다.
   *
   * **stat이 형식적인 절차가 아니다.** `protocol.cpp:606`의 `ExportGltf`는
   * 반환값을 확인하지 않아 실패해도 `ok:true`가 나간다. 여기서 실재를 확인하지
   * 않으면 게이트웨이가 "받아 가라"고 URL을 주고 클라이언트는 404를 만난다 —
   * 실패가 한 단계 뒤로 밀려 원인을 지목하지 못한다.
   */
  async commit(
    id: string,
    opts: { format: ExportFormat; sessionId: string; sceneName?: string | undefined },
  ): Promise<ExportRecord> {
    const file = this.pathOf(id, opts.format);

    let bytes: number;
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
      bytes = st.size;
    } catch {
      // 메시지에 경로를 넣지 않는다 — 이 문자열은 클라이언트에게 그대로 간다.
      throw new Error('익스포트 파일이 만들어지지 않았습니다');
    }
    if (bytes === 0) {
      await rm(file, { force: true }).catch(() => {});
      throw new Error('익스포트 파일이 비어 있습니다');
    }

    const record: ExportRecord = {
      id,
      name: exportDownloadName(opts.sceneName, opts.format),
      format: opts.format,
      bytes,
      createdAt: new Date().toISOString(),
      sessionId: opts.sessionId,
    };
    try {
      await writeFile(this.#metaPath(id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    } catch (err) {
      await rm(file, { force: true }).catch(() => {});
      throw err;
    }
    return record;
  }

  /** 한 건 조회. 없거나 본체가 사라졌으면 null (씬 저장소와 같은 규약) */
  async get(id: string): Promise<ExportRecord | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#metaPath(id), 'utf8'));
    } catch {
      return null;
    }
    if (!isExportRecord(parsed) || parsed.id !== id) return null;
    try {
      await stat(this.pathOf(id, parsed.format));
    } catch {
      return null; // 사이드카만 남고 본체가 없다 — 없는 것으로 취급한다
    }
    return parsed;
  }

  /**
   * 한 건을 지운다. 세션당 상한(밀려난 것)과 실패 폐기가 부른다.
   *
   * 사이드카를 **먼저** 지운다. 그래야 중간에 실패하더라도 "내려받을 수 있는데
   * 본체가 없는" 상태가 생기지 않고, 남은 본체는 TTL이 걷어 간다.
   * 형식을 모르므로 확장자를 모두 시도한다 — 실패 폐기 경로에서는 애초에
   * 사이드카가 없어 형식을 물어볼 곳이 없기 때문이다.
   */
  async discard(id: string): Promise<void> {
    if (!ID_RE.test(id)) return;
    await rm(this.#metaPath(id), { force: true }).catch(() => {});
    for (const ext of Object.values(EXPORT_EXT)) {
      await rm(path.join(this.dir, `${id}${ext}`), { force: true }).catch(() => {});
    }
  }

  /**
   * mtime이 TTL을 넘긴 파일을 전부 지운다. 지운 개수를 돌려준다.
   *
   * 사이드카와 본체를 구분하지 않는 이유: 둘은 거의 같은 시각에 생기고, 남은
   * 한쪽만 있는 상태는 `get()`이 이미 "없음"으로 취급한다. 구분해서 짝을 맞추면
   * 코드만 늘고 결과가 같다. **사이드카 없는 고아 파일**(워커가 실패했거나
   * 게이트웨이가 죽어 commit에 못 간 것)도 같은 규칙으로 걷힌다는 것이
   * 이 단순함의 값어치다.
   *
   * `force`가 아니면 60초 스로틀에 걸려 아무것도 하지 않는다.
   */
  async sweep(force = false): Promise<number> {
    const now = Date.now();
    if (!force && now - this.#lastSweep < SWEEP_MIN_INTERVAL_MS) return 0;
    this.#lastSweep = now;

    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return 0; // prepare 전이거나 디렉토리가 지워졌다
    }

    let removed = 0;
    for (const entry of entries) {
      // readdir이 돌려주는 것은 basename뿐이라 경로가 밖으로 나갈 수 없다.
      const full = path.join(this.dir, entry);
      let mtimeMs: number;
      try {
        const st = await stat(full);
        if (!st.isFile()) continue;
        mtimeMs = st.mtimeMs;
      } catch {
        continue; // 그 사이 누가 지웠다
      }
      if (now - mtimeMs < this.ttlMs) continue;
      await rm(full, { force: true }).catch(() => {});
      removed += 1;
    }
    return removed;
  }
}

/**
 * 익스포트 다운로드 라우트. index.ts의 "라우트 등록 지점"에서 부른다.
 *
 * **다운로드만 있다. 목록(`GET /api/exports`)은 두지 않는다.**
 * 씬 목록과 대칭이라 넣고 싶어지지만, 씬은 모두가 공유하는 입력이고 익스포트는
 * **한 세션이 방금 만든 산출물**이다. 목록을 열면 다른 세션의 id가 그대로
 * 보이고, 이 게이트웨이에는 아직 인증이 없으므로 그 id가 곧 다운로드 권한이
 * 된다. 자기가 만든 것의 id는 export 응답으로 이미 받았으니 목록이 없어도
 * 아쉬울 것이 없다 — 늘려서 얻는 것 없이 노출만 넓히는 쪽을 택하지 않는다.
 */
export function createExportRoutes(store: ExportStore): RouteRegistrar {
  return (app: Express, ctx) => {
    app.get('/api/exports/:id', async (req: Request, res: Response, next: NextFunction) => {
      // express 5의 params는 `string | string[]`이다(반복 파라미터 때문).
      // 배열이면 우리 라우트에서는 있을 수 없는 모양이므로 그대로 떨어뜨린다.
      const raw = req.params['id'];
      const id = typeof raw === 'string' ? raw : '';
      // ★ 클라이언트 문자열이 경로에 닿기 전의 관문. 32자리 hex가 아니면
      //   pathOf를 부르지도 않는다.
      if (!ID_RE.test(id)) {
        throw httpError(400, `익스포트 id 형식이 올바르지 않습니다: ${id}`);
      }

      const record = await store.get(id);
      if (!record) {
        // 만료·상한·실패를 구분해 주지 않는다. 셋 다 "지금은 없다"이고,
        // 구분하려면 지운 이력을 남겨야 하는데 그건 정리 정책과 반대다.
        throw httpError(
          404,
          `익스포트를 찾을 수 없습니다: ${id} (수명이 지났거나 세션당 상한에 밀려 지워졌을 수 있습니다)`,
        );
      }

      // content-type을 **먼저** 정한다. express의 send는 이미 잡힌 Content-Type을
      // 덮지 않으므로, 확장자 추측이 아니라 위의 표가 정본이 된다.
      res.type(EXPORT_CONTENT_TYPE[record.format]);
      // 수명이 짧고 언제든 사라지는 자원이다. 중간 캐시가 들고 있다가
      // 지워진 뒤에 내주면 "지웠는데 받아진다"가 된다.
      res.setHeader('Cache-Control', 'private, no-store');

      const file = store.pathOf(record.id, record.format);
      // res.download이 Content-Disposition을 만든다 — 비ASCII 파일명의
      // `filename*` 인코딩까지 express가 처리한다. 직접 문자열을 조립하면
      // 그 인코딩을 우리가 틀리게 된다.
      res.download(file, record.name, { dotfiles: 'deny' }, (err?: Error) => {
        if (!err) {
          ctx.log(`익스포트 다운로드 ${record.id} "${record.name}" ${record.bytes} 바이트`);
          return;
        }
        // 전송 도중 끊겼으면 헤더가 이미 나갔다. 여기서 next()로 넘기면
        // 에러 JSON이 파일 바이트 뒤에 덧붙어 응답이 깨진다 (index.ts의
        // 정적 서빙이 같은 이유로 같은 처리를 한다).
        if (res.headersSent) {
          res.end();
          return;
        }
        next(err);
      });
    });

    return { prepare: () => store.prepare() };
  };
}
