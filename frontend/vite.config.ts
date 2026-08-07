/**
 * 개발 서버 설정 — 핵심은 **오리진을 하나로 유지하는 것** 하나다 (#11).
 *
 * 브라우저는 언제나 한 곳(개발: Vite 5173, 배포: 게이트웨이)만 본다. 그래서
 * preflight 가 발생하지 않고, 게이트웨이에 CORS 미들웨어를 넣을 이유도 없다
 * (ISSUE-002 의 결정). 개발에서 그 전제를 지켜 주는 것이 아래 proxy 두 줄이다:
 * `/api` 와 `/ws` 만 게이트웨이로 넘기고 나머지는 Vite 가 처리한다.
 *
 * ⚠️ 이 전제는 프론트를 CDN 이나 별도 도메인에 올리는 순간 깨진다. 그때는
 *    CORS 가 되살아나므로 배포 방식을 바꾸기 전에 ISSUE-002 를 먼저 읽을 것.
 *
 * ⚠️ `ws: true` 가 없으면 `/ws` 업그레이드가 프록시를 타지 못하고, 브라우저는
 *    이유를 모르는 close 1006 만 본다. `/api/health` 는 되는데 WS 만 안 되면
 *    거의 항상 이 줄이다.
 *
 * 게이트웨이 주소는 GATEWAY_URL 로 바꾼다 (기본 http://127.0.0.1:3000).
 * localhost 가 아니라 127.0.0.1 인 이유: Node 18+ 는 localhost 를 ::1 로 먼저
 * 풀 수 있는데 게이트웨이는 기본적으로 IPv4 에만 바인딩한다 — 그러면 프록시가
 * ECONNREFUSED 로 죽는다.
 */

import { defineConfig } from 'vite';

const GATEWAY = process.env['GATEWAY_URL'] ?? 'http://127.0.0.1:3000';
const GATEWAY_WS = GATEWAY.replace(/^http/, 'ws');

export default defineConfig({
  // 게이트웨이가 dist/ 를 루트에서 서빙하므로 절대경로 에셋이면 된다.
  base: '/',

  server: {
    port: Number(process.env['PORT'] ?? 5173),
    // 포트가 이미 쓰이면 조용히 다른 포트로 옮겨가지 않는다 — 그러면
    // "왜 내 변경이 안 보이지"가 된다.
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: GATEWAY,
        // 같은 오리진 흉내가 목적이므로 Host 헤더를 바꾸지 않는다.
        changeOrigin: false,
      },
      '/ws': {
        target: GATEWAY_WS,
        ws: true,
        changeOrigin: false,
      },
    },
  },

  // `npm run preview` 도 같은 프록시를 쓴다. 빌드 산출물을 게이트웨이 없이
  // 확인할 때 필요하다 (게이트웨이가 dist 를 서빙하는 경로와는 별개다).
  preview: {
    port: Number(process.env['PREVIEW_PORT'] ?? 4173),
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: GATEWAY, changeOrigin: false },
      '/ws': { target: GATEWAY_WS, ws: true, changeOrigin: false },
    },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 소스맵이 있어야 배포된 번들에서 온 스택트레이스를 읽을 수 있다.
    sourcemap: true,
  },
});
