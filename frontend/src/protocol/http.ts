/**
 * 게이트웨이의 REST 표면 (`/api/*`).
 *
 * WS 와 파일을 갈라 둔 것은 게이트웨이의 결정이다 — 씬 업로드는 103MB 짜리가
 * 오갈 수 있어서 op 요청과 같은 통로에 둘 수 없다. 여기서는 그 결정을 그대로
 * 따르고, 대신 **거절을 읽을 수 있는 유일한 채널**이라는 점을 이용한다:
 *
 * ⚠️ WS 핸드셰이크 거절(503 만석 / 502 워커 실패 / 404 없는 씬)은 업그레이드
 *    **전에** HTTP 응답으로 끝난다. 브라우저 WebSocket API 는 그 본문도
 *    상태코드도 노출하지 않고 **close 1006 만 준다.** 그래서 "만석인가, 서버가
 *    죽었나" 를 구분하려면 여기 `fetchHealth()` 로 되물어야 한다.
 *    `GatewayClient.diagnose()` 가 정확히 그 일을 한다.
 */

import type { HealthBody, SceneSummary } from './types.ts';

/** 게이트웨이가 4xx/5xx 로 답했다. 본문의 `{ error }` 가 message 다 */
export class ApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
  }
}

interface ApiOptions {
  /** `http://host:port`. 브라우저에서 같은 오리진이면 생략한다 */
  base?: string | undefined;
  signal?: AbortSignal | undefined;
}

function join(base: string | undefined, path: string): string {
  return base ? `${base.replace(/\/+$/, '')}${path}` : path;
}

/**
 * 응답을 JSON 으로 읽는다. 실패해도 **던지지 않는 정보를 최대한 건진다** —
 * 게이트웨이는 404 도 500 도 `{ error }` JSON 이라(index.ts 의 결정) 본문에
 * 사람이 읽을 이유가 들어 있다. 다만 정적 서빙이 켜진 배포에서 경로를 잘못
 * 적으면 HTML 이 올 수도 있으므로, 파싱 실패를 상태코드로 대체한다.
 */
async function readJson(res: Response, url: string): Promise<unknown> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body
      && typeof (body as { error: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, url, message);
  }
  return body;
}

/**
 * `GET /api/health`.
 *
 * **던지지 않는다.** 이 함수의 쓰임새가 "서버가 살아 있는가" 이므로, 서버가
 * 죽어 있을 때 예외를 던지면 부르는 쪽이 항상 try 로 감싸야 한다. 살아 있으면
 * 본문, 아니면 `null` 이다.
 */
export async function fetchHealth(opts: ApiOptions = {}): Promise<HealthBody | null> {
  const url = join(opts.base, '/api/health');
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return typeof body === 'object' && body !== null && (body as HealthBody).status === 'ok'
      ? (body as HealthBody)
      : null;
  } catch {
    return null;
  }
}

/** `GET /api/scenes` */
export async function listScenes(opts: ApiOptions = {}): Promise<SceneSummary[]> {
  const url = join(opts.base, '/api/scenes');
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const body = await readJson(res, url);
  const scenes = (body as { scenes?: unknown })?.scenes;
  return Array.isArray(scenes) ? (scenes as SceneSummary[]) : [];
}

/**
 * `POST /api/scenes?name=<파일명>` — 본문은 **바이트 그대로**다.
 *
 * multipart 가 아니다. 103MB 짜리 `.zls` 를 base64 나 폼 경계로 감싸면 메모리와
 * 시간이 그만큼 더 든다. `File` 을 그대로 넘길 수 있으므로 브라우저에서는
 * `<input type=file>` 의 값이 곧 인자다.
 */
export async function uploadScene(
  name: string,
  data: BodyInit,
  opts: ApiOptions = {},
): Promise<SceneSummary> {
  const url = `${join(opts.base, '/api/scenes')}?name=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', accept: 'application/json' },
    // `File`·`Blob`·`ArrayBuffer`·`Uint8Array` 를 그대로 넘긴다.
    // `ReadableStream` 을 쓰려면 `duplex: 'half'` 가 추가로 필요하다 —
    // 지금은 필요한 경우가 없어서 넣지 않는다.
    body: data,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const body = await readJson(res, url);
  const scene = (body as { scene?: unknown })?.scene;
  if (!scene || typeof scene !== 'object') {
    throw new ApiError(res.status, url, '업로드 응답에 scene 이 없습니다');
  }
  return scene as SceneSummary;
}

/** `downloadExport` 진행 보고. `total` 을 모르면 0 이다 */
export interface DownloadProgress {
  loaded: number;
  total: number;
}

/**
 * `GET /api/exports/:id` — 익스포트 산출물을 **바이트 그대로** 받는다 (#10).
 *
 * ── 왜 `arrayBuffer()` 인가 ─────────────────────────────────
 * `res.text()` 로 받으면 UTF-8 디코딩을 한 번 지난다. glTF 는 JSON 이라 그래도
 * 파싱은 되지만, `GLTFLoader.parse()` 가 ArrayBuffer 를 받으면 GLB 매직을 먼저
 * 보고 **아니면 스스로 디코딩한다** — 즉 우리가 미리 문자열로 만들면 GLB(`.glb`)
 * 로 형식이 바뀌는 순간 조용히 깨진다. 바이트를 그대로 넘기면 형식 판별이
 * 로더에게 남는다.
 *
 * ── 왜 진행률을 스스로 세는가 ───────────────────────────────
 * 사용자 씬이 **36.5MB / 4.3초**다(#10 실측). 그 4.3초 동안 화면이 아무 말도
 * 안 하면 멈춘 것과 구분되지 않는다. `fetch` 는 진행 이벤트를 주지 않으므로
 * 본문 스트림을 직접 읽어 센다. 스트림을 못 쓰는 환경(구형 브라우저, 일부
 * 프록시)에서는 `arrayBuffer()` 로 조용히 되돌아간다 — **진행률은 편의이지
 * 기능이 아니다.**
 *
 * ⚠️ 응답이 `Content-Disposition: attachment` 라도 `fetch` 는 다운로드 창을
 *    띄우지 않는다. 그 헤더는 `<a download>` 로 갈 때만 의미가 있다.
 */
export async function downloadExport(
  url: string,
  opts: ApiOptions & {
    onProgress?: ((p: DownloadProgress) => void) | undefined;
    /** `Content-Length` 가 없을 때 쓸 기대 크기. `export` 응답의 `bytes` */
    expectedBytes?: number | undefined;
  } = {},
): Promise<ArrayBuffer> {
  const full = join(opts.base, url);
  const res = await fetch(full, {
    headers: { accept: 'model/gltf+json, application/octet-stream' },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (!res.ok) {
    // 실패 본문은 게이트웨이의 `{ error }` JSON 이다 — readJson 이 그걸 던진다.
    await readJson(res, full);
    // readJson 은 !ok 면 반드시 던진다. 여기 오면 그쪽 계약이 깨진 것이다.
    throw new ApiError(res.status, full, `${res.status} 응답을 해석하지 못했습니다`);
  }

  const header = Number(res.headers.get('content-length') ?? '');
  const total = Number.isFinite(header) && header > 0 ? header : (opts.expectedBytes ?? 0);
  const body = res.body;
  const report = opts.onProgress;

  if (!body || !report) {
    return await res.arrayBuffer();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  report({ loaded: 0, total });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loaded += value.byteLength;
    report({ loaded, total });
  }

  // 마지막에 한 번만 합친다. 청크마다 이어붙이면 36MB 에서 O(n²) 가 된다.
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}
