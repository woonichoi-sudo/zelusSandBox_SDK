/**
 * 씬 파일 저장소와 업로드/목록 라우트.
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
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Express, Request, Response } from 'express';

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
