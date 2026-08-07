/**
 * "게이트웨이가 어디 있는가" 를 한 곳에서만 답한다.
 *
 * 이 프로젝트는 **같은 오리진**을 전제한다 — 개발은 Vite 가 `/api`·`/ws` 를
 * 게이트웨이로 프록시하고, 배포는 게이트웨이가 `dist/` 를 서빙한다. 그래서
 * 브라우저에서는 base 를 주지 않는 것이 정상이고, 그때 이 함수가 현재 오리진을
 * 그대로 쓴다. base 를 넘기는 경우는 사실상 둘뿐이다:
 *   - Node 스모크 (location 이 없다)
 *   - 게이트웨이를 다른 호스트에서 임시로 붙여 볼 때 (CORS 가 되살아난다)
 *
 * http↔ws 변환을 여기에 가둔 이유는, 이게 손으로 문자열을 이어 붙이면 반드시
 * 틀리는 종류의 코드이기 때문이다 (https 인데 ws:// 로 붙어서 브라우저가
 * 혼합 콘텐츠로 막는 실패가 특히 조용하다).
 */

/** 게이트웨이 한 곳을 가리키는 주소 두 벌 */
export interface Endpoints {
  /** `http://host:port` — fetch 의 베이스. 끝에 슬래시가 없다 */
  httpBase: string;
  /** `ws://host:port/ws` — 쿼리 없음 */
  wsBase: string;
}

/**
 * @param base  `http://…` / `https://…` / `ws://…` / `wss://…`. 없으면 현재 오리진
 * @param wsPath WS 엔드포인트 경로. 게이트웨이 기본값은 `/ws`
 */
export function resolveEndpoints(base?: string | undefined, wsPath = '/ws'): Endpoints {
  const origin = base ?? globalThis.location?.origin;
  if (!origin) {
    throw new Error(
      '게이트웨이 주소를 알 수 없습니다. 브라우저 밖에서는 base 를 명시하세요 '
      + "(예: 'http://127.0.0.1:3000')",
    );
  }

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`게이트웨이 주소를 해석할 수 없습니다: ${origin}`);
  }

  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  if (!secure && url.protocol !== 'http:' && url.protocol !== 'ws:') {
    throw new Error(`지원하지 않는 프로토콜입니다: ${url.protocol} (http/https/ws/wss)`);
  }

  // base 에 경로가 붙어 있으면(예: 'ws://host/ws') 그걸 존중한다.
  // 없으면(경로가 '/') wsPath 를 쓴다.
  const path = url.pathname === '/' || url.pathname === '' ? wsPath : url.pathname;

  return {
    httpBase: `${secure ? 'https:' : 'http:'}//${url.host}`,
    wsBase: `${secure ? 'wss:' : 'ws:'}//${url.host}${path}`,
  };
}

/**
 * `?scene=` 을 붙인다.
 *
 * ⚠️ 이건 **기본값이지 구속이 아니다.** 게이트웨이는 여기 실린 씬을 로드하지
 * 않고 존재만 검증한다. 로드는 `load` op 이 하고, 같은 세션에서 다른 씬을
 * 여는 것도 허용된다 (bridge.ts buildLoad).
 *
 * ⚠️ 씬 id 가 틀리면 게이트웨이는 **업그레이드 전 HTTP 400/404** 로 거절한다.
 * 브라우저는 그 본문을 못 읽고 close 1006 만 본다 — 그래서 `?scene=` 을 쓸
 * 거라면 업로드 직후의 id 를 그대로 넘기는 경로만 두는 편이 안전하다.
 */
export function withScene(wsBase: string, scene?: string | null | undefined): string {
  if (!scene) return wsBase;
  const url = new URL(wsBase);
  url.searchParams.set('scene', scene);
  return url.toString();
}
