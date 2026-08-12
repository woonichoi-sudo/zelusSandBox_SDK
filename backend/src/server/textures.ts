/**
 * 텍스처 파일 서빙 — **워커가 준 서버 절대경로를 브라우저가 안전하게 받는 길.**
 *
 * 씬(`SceneStore`)·익스포트(`ExportStore`)와 같은 규칙 위에 서 있지만
 * **방향이 하나 더 있다**. 그래서 `files.ts` 에 세 번째 저장소로 넣지 않고 갈랐다:
 *
 *   씬        클라이언트가 올린다 → 우리가 경로를 만든다   (경로의 주인 = 우리)
 *   익스포트  우리가 경로를 만든다 → 워커가 쓴다          (경로의 주인 = 우리)
 *   텍스처    **워커가 경로를 준다** → 우리가 내보낸다     (경로의 주인 = 엔진)
 *
 * 앞의 둘은 "클라이언트 문자열은 경로가 되지 않는다"로 끝났다. 여기서는 경로를
 * 만드는 쪽이 우리가 아니라서 그 문장이 성립하지 않는다 — 대신 두 문장이 필요하다:
 *
 *   ① **워커가 준 경로도 검사한다.** 워커는 우리가 띄운 프로세스지만, 그 경로는
 *      결국 **씬 파일 안의 문자열**에서 왔다. 사용자가 올린 `.zls` 가 지어낸
 *      경로를 그대로 열면, 업로드 하나로 서버의 임의 파일을 읽는 길이 생긴다.
 *      → 허용 뿌리 화이트리스트 + 확장자 + 실경로(심볼릭 링크 해소) 확인.
 *   ② **경로를 URL 에 싣지 않는다.** 서버 절대경로가 브라우저에 나가면 #5·#7 이
 *      세운 규칙이 무너지고, 그 순간 URL 이 곧 "아무 파일이나 요청하는 폼"이 된다.
 *      → id ↔ 경로 매핑. **등록된 것만 열린다.**
 *
 * ── 왜 id 가 난수가 아니라 경로의 해시인가 ──────────────────
 * 씬·익스포트의 id 는 `randomBytes(16)` 이다. 여기서는 일부러 **결정적**으로 만든다:
 * 같은 파일이면 언제나 같은 URL 이어야 브라우저 캐시가 산다. 난수면 씬을 다시
 * 로드할 때마다 URL 이 바뀌어 19.7MB 를 매번 다시 받는다 — 이 단위의 값어치가
 * 통째로 사라진다.
 *
 * 해시라서 **id 를 지어낼 수 있다**는 점이 문제가 되지 않는 이유: 지어내려면
 * 경로를 알아야 하고, 알아맞혀도 `#byId` 에 **등록돼 있지 않으면 열리지 않는다.**
 * 등록은 워커 응답을 지나야 하고 그때 뿌리 검사를 이미 통과한 것뿐이다.
 * 즉 추측으로 얻는 것은 "이미 화면에 그려지고 있는 이미지" 하나뿐이다.
 *
 * ── ★ 캐시 규약 — mtime 을 쓰지 않는다 ──────────────────────
 * `ETag` 로 **재검증**시킨다(`max-age=0`). 두 번째 요청부터 304 + 0 바이트다.
 *
 * ⚠️ **express 의 기본 ETag(크기 + mtime)를 쓰면 캐시가 통째로 죽는다.** 실측:
 *
 *   ① 씬에서 풀린 직물 파일의 mtime 이 **1657년**이다(엔진이 압축을 풀 때
 *      타임스탬프를 안 챙긴다). 그게 `Last-Modified: Tue, 01 Dec 2065` 로
 *      나가고, 브라우저는 그런 응답을 저장하지 않는다.
 *   ② 더 큰 문제 — **씬을 로드할 때마다 그 파일을 다시 푼다.** 같은 씬을 두 번
 *      열면 mtime 이 바뀌고(`2c0c1141070` → `2c0c11dfb80`), 내용이 한 바이트도
 *      안 달라졌는데 ETag 가 달라져 **13.9MB 를 다시 받는다.** 실측으로 아바타
 *      6장(mtime 정상)은 300바이트씩 304 인데 직물 4장만 매번 전량이었다.
 *
 * 그래서 ETag 를 **`"<id>-<크기>"`** 로 우리가 직접 만든다. id 는 실경로의
 * 해시라 안 변하고, 크기는 내용이 진짜로 바뀌면 거의 항상 따라 바뀐다.
 *
 * 대가: **같은 경로에 크기가 똑같은 다른 직물이 풀리면 낡은 것을 내준다.**
 * 내용 해시가 정답이지만 등록마다 19.6MB 를 읽어야 하고, 그래 봐야 등록 시점
 * 이후의 변경은 어차피 못 잡는다(우리는 파일을 감시하지 않는다). 크기 비교는
 * 그 위험을 거의 같은 수준으로 유지하면서 공짜다.
 */

import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { Express, NextFunction, Request, Response } from 'express';

import type { TextureAsset } from '../sdk/protocol.ts';
import type { RouteRegistrar } from './index.ts';

/** 저장 id 의 유일한 형태. 여기서 벗어나면 조회조차 하지 않는다 */
const ID_RE = /^[0-9a-f]{32}$/;

/**
 * 내보낼 수 있는 확장자 → content-type.
 *
 * `ExportStore` 의 `EXPORT_CONTENT_TYPE` 과 같은 판단이다(ISSUE-003) — express 가
 * 확장자로 추측하게 두지 않는다. 그리고 이 표가 **확장자 화이트리스트를 겸한다**:
 * 여기 없는 것은 등록 자체가 안 되므로 `.zls`·`.exe`·`.json` 이 새어 나갈 자리가 없다.
 *
 * 실측된 것은 `.png` 와 `.jpg` 둘뿐이다. `.jpeg` 는 같은 포맷의 다른 표기라 넣는다.
 * `.webp`·`.tga`·`.exr` 은 **일부러 뺐다** — 나오는 것을 본 적이 없고, 화이트리스트는
 * 관측된 것만 담는 편이 낫다.
 */
const TEXTURE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/**
 * 파일 하나의 상한. 실측 최대가 9.54MB(`TOP_Mesh.png`)다.
 *
 * 64MB 는 그 6배 남짓이고, 넘는 것이 나오면 그건 텍스처가 아니라 뭔가 잘못된
 * 것이다. 상한이 하는 일은 "브라우저에 수백 MB 를 흘리는 경로를 없애는 것"이다.
 */
export const DEFAULT_MAX_TEXTURE_BYTES = 64 * 1024 * 1024;

/**
 * 등록을 기억하는 최대 칸 수.
 *
 * 무한정 쌓이면 게이트웨이 수명 동안 새는 맵이 된다. 한 씬이 쓰는 것이 실측
 * 10칸(아바타 6 + 옷 4)이므로 512 면 씬 50개분이다. 넘치면 **가장 오래 전에
 * 등록된 것부터** 버린다 — 버려진 URL 은 404 가 되지만, 그 씬을 다시 열면
 * 같은 id 로 다시 등록된다(결정적 해시의 부수 효과다).
 */
export const DEFAULT_MAX_TEXTURE_ENTRIES = 512;

/** 등록된 파일 한 칸 */
interface TextureFile {
  id: string;
  /** 심볼릭 링크까지 해소한 실경로. **밖으로 나가지 않는다** */
  realPath: string;
  bytes: number;
  contentType: string;
  /** `"<id>-<크기 16진수>"`. **mtime 이 안 들어간다** (머리말 참고) */
  etag: string;
}

export interface TextureStoreOptions {
  /**
   * 허용 뿌리. **여기 아래가 아닌 경로는 절대 열리지 않는다.**
   *
   * 비어 있으면 이 저장소는 아무것도 등록하지 않는다(= 텍스처 기능이 꺼진다).
   * 빈 목록을 "전부 허용"으로 해석하면, 설정을 빠뜨렸을 때 가장 나쁜 쪽으로
   * 열리게 된다.
   */
  roots: readonly string[];
  maxBytes?: number;
  maxEntries?: number;
  /** 거절 사유를 알리는 자리. 게이트웨이 로그로 간다 */
  onLog?: (line: string) => void;
}

/**
 * 게이트웨이가 기본으로 쓰는 허용 뿌리.
 *
 * 엔진의 appdata 뿌리는 `%LOCALAPPDATA%\z-emotion\<exe 이름>\` 이고, 워커의
 * exe 이름은 `zelusSandBoxd-demo` 다(Debug·Release 동일). **한 단계 위인
 * `z-emotion` 까지만 허용**하는 이유는 exe 이름이 바뀌어도 따라가되, 사용자
 * 문서·저장소·시스템 디렉토리에는 절대 닿지 않게 하기 위해서다.
 *
 * `TEXTURE_ROOTS` 환경변수(`;` 구분)로 바꿀 수 있다. 넘기면 **대체한다** —
 * 더하지 않는다. 운영에서 뿌리를 좁히려는 사람이 기본값에 발목 잡히면 안 된다.
 */
export function defaultTextureRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env['TEXTURE_ROOTS'];
  if (typeof override === 'string' && override.trim() !== '') {
    return override.split(';').map((s) => s.trim()).filter(Boolean).map((s) => path.resolve(s));
  }
  const local = env['LOCALAPPDATA'];
  if (typeof local !== 'string' || local === '') return [];
  return [path.resolve(local, 'z-emotion')];
}

/**
 * 경로 하나가 뿌리 아래인지. **`startsWith` 로 하면 안 된다** —
 * `C:\a\z-emotion-evil` 이 `C:\a\z-emotion` 으로 시작한다.
 */
function isUnder(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  // rel === '' 은 뿌리 자신이다. 디렉토리라 어차피 파일 검사에서 떨어지지만,
  // 여기서 먼저 거절해 두면 "뿌리를 통째로 내보낸다"는 모양 자체가 없어진다.
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * `#registerUncached` 의 결말. **거절을 두 갈래로 가르는 것이 요점이다.**
 *
 * `path`  경로 문자열만 보고 정했다 → 다시 물어도 답이 같으므로 기억해도 된다.
 * `state` 그 순간의 디스크를 보고 정했다 → **기억하면 안 된다.** 파일이
 *         나중에 생기거나 다 써질 수 있다.
 *
 * 갈래를 불리언(`cacheable`)이 아니라 이름으로 둔 이유: 새 검사를 넣는 사람이
 * "true 가 뭐였더라" 를 되짚지 않아도 `rejectPath` / `rejectState` 중 어느
 * 문을 쓸지가 그 자리에서 정해진다.
 */
type RegisterResult =
  | { ok: true; asset: TextureAsset }
  | { ok: false; kind: 'path' | 'state' };

/** 등록된 텍스처의 id ↔ 경로 매핑. 게이트웨이 수명과 같다 */
export class TextureStore {
  readonly roots: readonly string[];
  readonly maxBytes: number;
  readonly maxEntries: number;

  readonly #log: (line: string) => void;
  /** 삽입 순서를 유지한다 — 넘치면 앞에서부터 버린다 */
  readonly #byId = new Map<string, TextureFile>();
  /**
   * 이미 거절한 경로. **경로 모양 때문에 거절한 것만 담는다.**
   *
   * 그런 사유(뿌리 밖 · 확장자 · UNC · 상대경로 · 널바이트)는 경로 문자열만
   * 보고 정해지므로 다시 물어도 답이 같다. 기억해 두지 않으면 뿌리 설정이
   * 틀렸을 때 체형을 만질 때마다 같은 검사를 다시 돈다.
   *
   * ── ★★ 파일시스템 상태 거절은 여기 들어오면 안 된다 ────────
   *
   * ⚠️ **원래는 전부 담았고, 그게 버그였다.** `파일이 없습니다`·`빈 파일`
   *    같은 사유는 **그 순간의 디스크 상태**라 다음에 물으면 답이 달라진다.
   *    한 번 담기면 파일이 멀쩡해져도 이 프로세스가 사는 내내 거절이라,
   *    **게이트웨이를 재시작하기 전에는 복구할 방법이 없었다.**
   *
   *    실제로 밟았다(2026-08-12): 씬 하나를 여는 동안 엔진이 `fabric_infile`
   *    을 다시 푸는데(머리말 ②) 그 사이에 등록이 걸리면 4칸이 `파일이
   *    없습니다` 로 떨어진다. 그 뒤로는 재로드해도 `⚠ 거절 4칸` 이 그대로였고
   *    화면에서는 **옷 색이 통째로 사라진 것**으로 보였다. 파일은 디스크에
   *    멀쩡히 있었다.
   *
   *    창이 열리는 원인은 따로 있다(씬을 두 번 연다 — ISSUE-025). 그것을
   *    고치더라도 **일시적 실패를 영구 실패로 승격시키는 것 자체가 틀렸다** —
   *    바이러스 검사·백업·네트워크 드라이브 어느 것이든 같은 창을 만든다.
   *
   * ⚠️ 그리고 **성공은 여전히 캐시하지 않는다** — 엔진이 씬을 열 때마다 직물
   *    파일을 다시 풀기 때문이다(머리말 ②). 크기가 달라졌는데 옛 ETag 를
   *    들고 있으면 낡은 이미지를 계속 내주게 된다. 등록은 파일당 응답당 한
   *    번뿐이고(워커가 표에서 이미 중복을 없앴다) stat 열 번은 공짜다.
   */
  readonly #rejected = new Set<string>();

  /**
   * 이미 로그에 남긴 거절. **판단이 아니라 로그 도배 방지 전용이다.**
   *
   * 상태 거절을 다시 검사하게 만든 대가로, 정말로 없는 파일은 로드마다 같은
   * 경고를 다시 찍게 된다. 그래서 **검사는 매번 하되 경고는 한 번만** 한다 —
   * `#rejected` 가 원래 겸하던 두 역할(기억 / 조용히 하기) 중 뒤엣것만 여기로
   * 뗀 것이다.
   *
   * 키에 사유를 붙이는 이유: 같은 경로가 `빈 파일` → `상한 초과` 로 바뀌면
   * 그건 새 사실이라 한 번은 보여야 한다.
   */
  readonly #warned = new Set<string>();

  #served = 0;

  constructor(opts: TextureStoreOptions) {
    this.roots = opts.roots.map((r) => path.resolve(r));
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_TEXTURE_BYTES;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_TEXTURE_ENTRIES;
    this.#log = opts.onLog ?? ((): void => {});
    if (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error(`텍스처 maxBytes 가 올바르지 않습니다: ${String(opts.maxBytes)}`);
    }
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new Error(`텍스처 maxEntries 가 올바르지 않습니다: ${String(opts.maxEntries)}`);
    }
  }

  /** 등록된 파일 수 (진단용) */
  get size(): number {
    return this.#byId.size;
  }

  /** 내보낸 횟수 (진단용). 304 는 세지 않는다 */
  get served(): number {
    return this.#served;
  }

  /** 이 저장소가 무엇이든 열 수 있는가. 뿌리가 없으면 기능이 꺼진 것이다 */
  get enabled(): boolean {
    return this.roots.length > 0;
  }

  /**
   * 워커가 준 경로 하나를 등록하고 다운로드 자산을 돌려준다. **거절이면 null.**
   *
   * 거절 사유를 클라이언트에게 알리지 않는다 — 사유가 곧 "그 경로가 있느냐
   * 없느냐"라서, 알려 주면 파일 존재 여부를 묻는 신호가 된다. 로그에는 남긴다.
   */
  async register(raw: unknown): Promise<TextureAsset | null> {
    if (typeof raw !== 'string' || raw === '') return null;
    if (this.#rejected.has(raw)) return null;

    const result = await this.#registerUncached(raw);
    if (result.ok) return result.asset;
    // ★ **`path` 갈래만 기억한다.** `state` 는 다음에 물으면 답이 달라질 수
    //   있다 — 위 `#rejected` 주석이 그 이유이자 이 코드가 존재하는 이유다.
    if (result.kind === 'path') this.#rejected.add(raw);
    return null;
  }

  async #registerUncached(raw: string): Promise<RegisterResult> {
    /** 한 번만 찍는다. 같은 경로+사유의 반복은 새 사실이 아니다 */
    const warn = (why: string): void => {
      const key = `${raw} ${why}`;
      if (this.#warned.has(key)) return;
      this.#warned.add(key);
      this.#log(`[warn] 텍스처를 거절했습니다 (${why})`);
    };

    /** 경로 문자열만 보고 내린 거절. 다시 물어도 답이 같으므로 기억한다 */
    const rejectPath = (why: string): RegisterResult => {
      warn(why);
      return { ok: false, kind: 'path' };
    };

    /**
     * 그 순간의 디스크 상태를 보고 내린 거절. **기억하지 않는다** —
     * 파일이 나중에 생기거나, 다 써지거나, 작아질 수 있다.
     */
    const rejectState = (why: string): RegisterResult => {
      warn(why);
      return { ok: false, kind: 'state' };
    };

    if (!this.enabled) return rejectPath('허용 뿌리가 설정되지 않았습니다');
    // 널바이트는 경로 API 를 통과하면서 문자열을 자를 수 있다.
    if (raw.includes('\u0000')) return rejectPath('널바이트');

    // resolve 가 `..` 를 접는다. 상대경로는 여기서 프로세스 cwd 기준이 되는데,
    // **그런 것은 애초에 오면 안 된다** — 워커가 appdata 뿌리를 붙여 절대경로로
    // 보내기 때문이다. 상대경로가 왔다는 것은 워커가 옛 버전이라는 뜻이다.
    if (!path.isAbsolute(raw)) return rejectPath('절대경로가 아닙니다 — 워커가 옛 버전일 수 있습니다');

    const resolved = path.resolve(raw);
    // UNC(`\\서버\공유`)는 네트워크 경로다. 뿌리 검사를 통과할 수 없지만,
    // 검사 전에 끊어 두면 "원격을 읽으러 나간다"는 동작 자체가 없어진다.
    if (resolved.startsWith('\\\\') || resolved.startsWith('//')) return rejectPath('UNC 경로');

    const ext = path.extname(resolved).toLowerCase();
    const contentType = TEXTURE_TYPES[ext];
    if (contentType === undefined) return rejectPath(`허용되지 않는 확장자 ${ext || '(없음)'}`);

    if (!this.roots.some((root) => isUnder(root, resolved))) {
      return rejectPath('허용 뿌리 밖');
    }

    // ── 여기부터 디스크를 본다 → 전부 `rejectState` ─────────────
    //
    // ★ 아래 사유는 **하나도 기억하지 않는다.** 지금 없는 파일이 다음 로드에는
    //   있을 수 있고(엔진이 직물을 다시 푸는 중이었을 뿐), 지금 0바이트인
    //   파일이 다 써지면 정상이 된다. 기억하면 그 순간의 사고가 영구 고장이
    //   된다 — 위 `#rejected` 주석의 실측이 정확히 그 사고다.

    // ★ 심볼릭 링크·정션 해소. 뿌리 **안**에 밖을 가리키는 링크를 하나 두면
    //   위 검사만으로는 통과한다. 실경로로 한 번 더 본다.
    let realPath: string;
    try {
      realPath = await realpath(resolved);
    } catch {
      return rejectState('파일이 없습니다');
    }
    // 링크가 가리키는 곳은 **언제든 바뀔 수 있다.** 지금 거절하는 것은 맞지만
    // 경로 모양이 아니라 상태라서 기억해서는 안 된다.
    if (!this.roots.some((root) => isUnder(root, realPath))) {
      return rejectState('심볼릭 링크가 허용 뿌리 밖을 가리킵니다');
    }
    // 실경로의 확장자도 다시 본다 — `a.png` → `b.exe` 링크를 막는다.
    const realExt = path.extname(realPath).toLowerCase();
    if (TEXTURE_TYPES[realExt] === undefined) {
      return rejectState(`심볼릭 링크의 실제 확장자가 허용되지 않습니다 (${realExt || '없음'})`);
    }

    let bytes: number;
    try {
      const st = await stat(realPath);
      // 디렉토리·파이프·장치는 파일이 아니다.
      if (!st.isFile()) return rejectState('일반 파일이 아닙니다');
      bytes = st.size;
    } catch {
      return rejectState('파일이 없습니다');
    }
    // ⚠️ **여기가 가장 흔한 일시적 실패다.** 엔진이 파일을 만들고 아직 다 쓰지
    //    않았으면 0바이트로 보인다.
    if (bytes === 0) return rejectState('빈 파일');
    if (bytes > this.maxBytes) return rejectState(`상한 초과 (${bytes} > ${this.maxBytes})`);

    // 실경로의 해시다. 대소문자를 접는 이유: Windows 파일시스템이 그렇고,
    // 같은 파일이 두 id 를 갖게 되면 브라우저가 두 번 받는다.
    const id = createHash('sha256').update(realPath.toLowerCase(), 'utf8')
      .digest('hex').slice(0, 32);

    // 재등록이면 값을 갱신하고 **맨 뒤로 보낸다**(가장 최근에 쓰인 것).
    this.#byId.delete(id);
    this.#byId.set(id, {
      id, realPath, bytes, contentType,
      etag: `"${id}-${bytes.toString(16)}"`,
    });
    while (this.#byId.size > this.maxEntries) {
      const oldest = this.#byId.keys().next();
      if (oldest.done) break;
      this.#byId.delete(oldest.value);
    }

    return { ok: true, asset: { id, url: `/api/textures/${id}`, bytes } };
  }

  /**
   * 워커 응답의 `textures` 표 전체를 다시 쓴다.
   *
   * 색인이 밀리면 머티리얼이 엉뚱한 이미지를 가리키므로 **칸을 지우지 않는다** —
   * 거절한 칸은 `null` 로 남긴다.
   */
  async registerAll(raws: readonly unknown[]): Promise<(TextureAsset | null)[]> {
    return Promise.all(raws.map((r) => this.register(r)));
  }

  /** id → 등록된 파일. 등록된 적 없으면 null */
  get(id: string): TextureFile | null {
    if (!ID_RE.test(id)) return null;
    return this.#byId.get(id) ?? null;
  }

  /** 라우트가 실제로 내보낸 뒤 부른다 (진단용 카운터) */
  countServed(): void {
    this.#served += 1;
  }
}

/**
 * `GET /api/textures/:id`.
 *
 * **목록 라우트를 두지 않는다** — `createExportRoutes` 와 같은 판단이다. 목록이
 * 열리면 이 게이트웨이가 어떤 파일을 들고 있는지가 그대로 보이고, 인증이 없는
 * 지금 그 id 는 곧 열람 권한이다. 자기 화면이 쓰는 id 는 메시 응답으로 이미 왔다.
 */
export function createTextureRoutes(store: TextureStore): RouteRegistrar {
  return (app: Express, ctx) => {
    app.get('/api/textures/:id', (req: Request, res: Response, next: NextFunction) => {
      // express 5 의 params 는 `string | string[]` 이다(반복 파라미터 때문).
      const rawId = req.params['id'];
      const id = typeof rawId === 'string' ? rawId : '';

      const file = store.get(id);
      // ★ 형식이 틀린 것과 등록 안 된 것을 **구분하지 않는다.** 둘 다 404 다 —
      //   400 을 따로 주면 "이 id 는 형식은 맞는데 없다"가 신호가 된다.
      if (!file) {
        res.status(404).json({ error: `텍스처를 찾을 수 없습니다: ${id}` });
        return;
      }

      // content-type 을 **먼저** 정한다. sendFile 은 이미 잡힌 값을 안 덮는다.
      res.type(file.contentType);
      // ★ 우리 ETag 를 먼저 건다. `send` 는 아래에서 자기 것을 만들지 않으므로
      //   (`etag: false`) 이 값이 그대로 나가고, 조건부 GET 판정도 이것으로 한다.
      res.setHeader('ETag', file.etag);

      res.sendFile(file.realPath, {
        // 0 이면 `send` 가 `Cache-Control: public, max-age=0` 을 붙인다.
        // 매번 재검증하되 바뀐 게 없으면 304 + 0 바이트다 — 이 단위의 값어치가
        // 정확히 여기 있다.
        maxAge: 0,
        // ⚠️ 둘 다 끈다. **mtime 이 못 믿을 값이라서다** (머리말 ①②). 켜 두면
        //    씬을 다시 열 때마다 ETag 가 달라져 13.9MB 를 다시 받고,
        //    `Last-Modified: 2065` 는 브라우저가 응답 저장 자체를 포기하게 만든다.
        etag: false,
        lastModified: false,

        // 경로가 서버가 들고 있던 실경로뿐이라 이 옵션은 이중 방어다.
        dotfiles: 'deny',
        // 상대경로였다면 root 가 필요하지만, 우리 것은 언제나 절대경로다.
      }, (err?: Error) => {
        if (!err) {
          // ⚠️ **304 는 세지 않는다.** 이 콜백은 조건부 GET 이 304 로 끝나도
          //    에러 없이 불린다. 그대로 세면 "내보낸 횟수" 가 재검증까지
          //    포함하게 되는데, 이 단위의 값어치가 정확히 "304 라서 안
          //    내보냈다" 이므로 카운터가 그 반대를 말하게 된다.
          if (res.statusCode !== 304) store.countServed();
          return;
        }
        // 전송 도중 끊겼으면 헤더가 이미 나갔다. next() 로 넘기면 에러 JSON 이
        // 이미지 바이트 뒤에 덧붙어 응답이 깨진다 (`createExportRoutes` 와 같다).
        if (res.headersSent) {
          res.end();
          return;
        }
        next(err);
      });
    });

    ctx.log(
      store.enabled
        ? `텍스처 서빙: 허용 뿌리 ${store.roots.length}개 — ${store.roots.join(', ')}`
        : '텍스처 서빙: 허용 뿌리가 없어 꺼져 있습니다 (LOCALAPPDATA / TEXTURE_ROOTS)',
    );
  };
}
