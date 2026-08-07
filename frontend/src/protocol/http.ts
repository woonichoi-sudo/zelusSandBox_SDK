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
