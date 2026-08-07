/**
 * 최소 페이지 — 프로토콜 계층(#11)이 살아 있다는 것만 눈으로 확인한다.
 *
 * **여기에 UI 를 늘리지 마라.** 3D 뷰(three.js), 2D 패턴 뷰, 컨트롤 패널은
 * 전부 #12 이후다. 이 파일이 하는 일은 셋뿐이다: 연결, 상태 표시, 로그.
 *
 * 대신 콘솔에서 손으로 만질 수 있게 클라이언트를 `window.gateway` 로 노출한다.
 * 렌더링 없이 프로토콜을 확인하는 가장 빠른 길이고, #12 를 붙이기 전에
 * 게이트웨이 동작을 확인할 때도 그대로 쓴다:
 *
 *   const s = await gateway.uploadScene(file)   // <input type=file> 의 File
 *   await gateway.load(s.id); await gateway.start()
 */

import {
  decodePatterns,
  fetchHealth,
  GatewayClient,
  meshStats,
  uploadScene,
  type SceneSummary,
} from './protocol/index.ts';

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} 가 없습니다`);
  return node;
}

const view = {
  state: el('state'),
  ws: el('ws'),
  health: el('health'),
  version: el('version'),
  frame: el('frame'),
  engine: el('engine'),
  pending: el('pending'),
  log: el('log'),
};

const LOG_LIMIT = 200;
const lines: string[] = [];
function log(line: string): void {
  lines.push(`${new Date().toLocaleTimeString('ko-KR')}  ${line}`);
  if (lines.length > LOG_LIMIT) lines.splice(0, lines.length - LOG_LIMIT);
  view.log.textContent = lines.join('\n');
  view.log.scrollTop = view.log.scrollHeight;
}

// url 을 주지 않는다 = 같은 오리진. 개발에서는 Vite 가 /ws 를 게이트웨이로
// 프록시하고, 배포에서는 게이트웨이 자신이다 — 프론트 코드는 양쪽에서 같다.
const client = new GatewayClient({ onLog: log });
view.ws.textContent = client.wsUrl;

client.on('state', ({ state, previous }) => {
  view.state.textContent = state;
  log(`상태 ${previous} → ${state}`);
});

client.on('open', ({ reconnected, attempt }) => {
  if (reconnected) {
    // 재연결 = **새 워커 세션**이다. 씬도 시뮬 상태도 구독도 전부 초기값이다.
    log(`⚠ 재연결됨 (${attempt}회) — 새 세션이므로 씬을 다시 로드해야 합니다`);
  }
  void client.version().then(
    (v) => {
      view.version.textContent = `Zelus ${v.zelus} / Lumia ${v.lumia}`;
    },
    (err: unknown) => log(`version 실패: ${String(err)}`),
  );
});

client.on('close', ({ code, reason, willReconnect }) => {
  view.version.textContent = '-';
  log(`닫힘 code=${code}${reason ? ` (${reason})` : ''}${willReconnect ? ' — 재시도' : ''}`);
  if (code === 1006) {
    // 브라우저는 핸드셰이크 거절의 본문을 못 읽는다. 되물어야 안다.
    void client.diagnose().then((d) => {
      log(
        d === 'gateway-down'
          ? '진단: 게이트웨이가 응답하지 않습니다'
          : d === 'refused'
            ? '진단: 게이트웨이는 살아 있습니다 — 세션 상한(503)이나 워커 실패(502)일 수 있습니다'
            : '진단: 원인 불명',
      );
    });
  }
});

let frames = 0;
client.on('frame', (ev) => {
  frames += 1;
  const suffix = ev.mesh ? `  mesh ${JSON.stringify(meshStats(ev.mesh))}` : '';
  view.frame.textContent = `${ev.frame} (누적 ${frames})${suffix}`;
});

client.on('engineMessage', ({ message }) => {
  view.engine.textContent = message;
});

client.on('protocolError', ({ error, raw }) => log(`[프로토콜] ${error.message}  ← ${raw}`));
client.on('error', ({ error }) => log(`[오류] ${error.message}`));

setInterval(() => {
  view.pending.textContent = String(client.pending);
}, 250);

void (async (): Promise<void> => {
  const health = await fetchHealth();
  view.health.textContent = health
    ? `ok — node ${health.node}, pid ${health.pid}`
    : '응답 없음 (게이트웨이가 떠 있습니까? PORT=3000)';
  if (!health) return;

  try {
    await client.connect();
  } catch (err: unknown) {
    log(`연결 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
})();

// 콘솔용 창구. UI 가 없는 동안 여기로 만진다.
declare global {
  // eslint-disable-next-line no-var
  var gateway: GatewayClient & {
    uploadScene: (file: File) => Promise<SceneSummary>;
    decodePatterns: typeof decodePatterns;
  };
}
Object.assign(client, {
  uploadScene: (file: File) => uploadScene(file.name, file),
  decodePatterns,
});
globalThis.gateway = client as typeof globalThis.gateway;
log('window.gateway 로 클라이언트를 만질 수 있습니다');
