/**
 * 앱 배선 — 게이트웨이 ↔ 3D 뷰 (#12).
 *
 * 이 파일이 하는 일은 넷뿐이다: 씬 목록을 채우고, 연결하고, 고른 씬을 띄우고,
 * 상태를 보여준다. **렌더링은 `viewer3d/` 가, 통신은 `protocol/` 이 한다** —
 * 여기에 three 나 WebSocket 코드를 늘리면 두 계층의 경계가 흐려진다.
 *
 * ── UI 를 여기서 더 늘리지 말 것 ────────────────────────────
 * 재생 컨트롤(#14), 2D 펼침 뷰(#15), 파라미터 패널(#16)은 각각 자기 단위가
 * 있다. #12 의 판정 기준은 "브라우저에 옷이 뜬다" 하나이고, 버튼이 늘어날수록
 * 그 판정이 무엇 때문에 실패했는지 흐려진다.
 *
 * ── 재연결은 복구가 아니다 ──────────────────────────────────
 * 끊겼다 붙으면 **새 워커 프로세스**다. 씬이 로드돼 있지 않고, 시뮬 상태도
 * 파라미터도 구독도 초기값이다. 그래서 `open` 의 `reconnected` 를 보고 씬을
 * 다시 로드한다 — 아래 유일한 재로드 지점이 그것이다. 이 코드가 없으면 화면에
 * 남아 있는 옷은 이미 죽은 세션의 잔상이고, 다음 op 은 "씬이 없다" 로 실패한다.
 */

import {
  fetchHealth,
  GatewayClient,
  listScenes,
  uploadScene,
  type SceneSummary,
} from './protocol/index.ts';
import { showScene, Viewer3D } from './viewer3d/index.ts';

// ── DOM ─────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} 가 없습니다`);
  return node as T;
}

const ui = {
  canvas: el<HTMLCanvasElement>('view'),
  scene: el<HTMLSelectElement>('scene'),
  load: el<HTMLButtonElement>('load'),
  file: el<HTMLInputElement>('file'),
  upload: el<HTMLButtonElement>('upload'),
  stat: el<HTMLElement>('stat'),
  status: el<HTMLElement>('status'),
  log: el<HTMLElement>('log'),
};

const LOG_LIMIT = 300;
const lines: string[] = [];
function log(line: string): void {
  lines.push(`${new Date().toLocaleTimeString('ko-KR')}  ${line}`);
  if (lines.length > LOG_LIMIT) lines.splice(0, lines.length - LOG_LIMIT);
  ui.log.textContent = lines.join('\n');
  ui.log.scrollTop = ui.log.scrollHeight;
}

function status(text: string, isError = false): void {
  ui.status.textContent = text;
  ui.status.classList.toggle('err', isError);
  log(isError ? `⚠ ${text}` : text);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── 뷰어 ────────────────────────────────────────────────────

const viewer = new Viewer3D({ canvas: ui.canvas });
viewer.start();

// ── 클라이언트 ──────────────────────────────────────────────
//
// url 을 주지 않는다 = 같은 오리진. 개발에서는 Vite 가 /ws 를 게이트웨이로
// 프록시하고, 배포에서는 게이트웨이 자신이다 — 프론트 코드는 양쪽에서 같다.
const client = new GatewayClient({
  onLog: log,
  // 켠 이유는 아래 open 핸들러가 재로드를 책임지기 때문이다. 그 코드 없이
  // 켜면 "빈 세션에 붙은 채로 화면엔 옛 옷이 남아 있는" 상태가 된다.
  reconnect: { minDelayMs: 800, maxDelayMs: 8_000, maxAttempts: 6 },
});

/** 지금 화면에 떠 있어야 할 씬. 재연결 후 무엇을 다시 로드할지의 정본이다 */
let currentScene: string | null = null;
let busy = false;

client.on('open', ({ reconnected, attempt }) => {
  if (!reconnected) return;
  log(`재연결됨 (${attempt}회) — 새 워커 세션이므로 씬을 다시 로드합니다`);
  if (currentScene) void show(currentScene, { refit: false });
});

client.on('close', ({ code, willReconnect }) => {
  status(`연결이 끊겼습니다 (code=${code})${willReconnect ? ' — 재시도 중' : ''}`, true);
  if (code === 1006 && !willReconnect) {
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

client.on('engineMessage', ({ message: m }) => log(`[엔진] ${m}`));
client.on('protocolError', ({ error, raw }) => log(`[프로토콜] ${error.message}  ← ${raw}`));
client.on('error', ({ error }) => log(`[오류] ${error.message}`));

// ★ #13 이 얹히는 자리.
//   지금은 세는 것 말고 아무것도 하지 않는다. 구독(subscribe)도 걸지 않으므로
//   mesh 키는 아예 오지 않는다 — `mesh === null` 로 검사하면 영원히 거짓이다.
//   #13 은 여기서 `ev.mesh` 를 **디코딩하지 말고** 최신 것만 보관했다가
//   rAF 에서 `decodePatterns()` → `viewer.cloth.updatePositions()` 하면 된다.
//   40/s × 47.8KB 라 핸들러 안에서 풀면 프레임을 놓친다.
let frames = 0;
client.on('frame', () => {
  frames += 1;
});

// ── 씬 목록 ─────────────────────────────────────────────────

function fmtBytes(n: number): string {
  return n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}MB` : `${(n / 1024).toFixed(0)}KB`;
}

async function refreshScenes(select?: string): Promise<SceneSummary[]> {
  let scenes: SceneSummary[] = [];
  try {
    scenes = await listScenes();
  } catch (err: unknown) {
    status(`씬 목록을 읽지 못했습니다: ${message(err)}`, true);
    return [];
  }

  ui.scene.replaceChildren();
  if (scenes.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '업로드된 씬이 없습니다 — .zls 를 올리세요';
    ui.scene.append(opt);
  }
  for (const s of scenes) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.name}  (${fmtBytes(s.bytes)})`;
    ui.scene.append(opt);
  }
  if (select) ui.scene.value = select;
  ui.load.disabled = scenes.length === 0;
  return scenes;
}

// ── 로드 → 화면 ─────────────────────────────────────────────

function setBusy(on: boolean): void {
  busy = on;
  ui.load.disabled = on || ui.scene.value === '';
  ui.upload.disabled = on || !ui.file.files?.length;
  ui.scene.disabled = on;
}

async function show(sceneId: string, opts: { refit?: boolean } = {}): Promise<void> {
  if (busy) return;
  setBusy(true);
  status('씬을 로드하는 중… (103MB 면 1초쯤 걸립니다)');
  try {
    const shown = await showScene(client, viewer, sceneId, {
      // 재연결 후 다시 로드할 때는 사용자가 맞춰 둔 시점을 빼앗지 않는다.
      frameCamera: opts.refit !== false,
    });
    currentScene = sceneId;
    ui.stat.textContent = `패턴 ${shown.patterns} · 정점 ${shown.vertices} · 삼각형 ${shown.triangles}`;
    status(`로드 완료 (${shown.elapsedMs}ms)`);
  } catch (err: unknown) {
    status(`로드 실패: ${message(err)}`, true);
  } finally {
    setBusy(false);
  }
}

ui.load.addEventListener('click', () => {
  const id = ui.scene.value;
  if (id) void show(id);
});

ui.file.addEventListener('change', () => {
  ui.upload.disabled = busy || !ui.file.files?.length;
});

ui.upload.addEventListener('click', () => {
  const file = ui.file.files?.[0];
  if (!file) return;
  void (async (): Promise<void> => {
    setBusy(true);
    status(`업로드 중… ${file.name} (${fmtBytes(file.size)})`);
    try {
      const scene = await uploadScene(file.name, file);
      log(`업로드 완료: ${scene.id}`);
      await refreshScenes(scene.id);
      setBusy(false);
      await show(scene.id);
    } catch (err: unknown) {
      status(`업로드 실패: ${message(err)}`, true);
      setBusy(false);
    }
  })();
});

// ── 기동 ────────────────────────────────────────────────────

void (async (): Promise<void> => {
  const health = await fetchHealth();
  if (!health) {
    status('게이트웨이가 응답하지 않습니다 — backend 에서 `npm run serve` 를 띄우세요', true);
    return;
  }
  log(`게이트웨이 ok — node ${health.node}, pid ${health.pid}`);

  const scenes = await refreshScenes();

  status('세션을 여는 중… (워커 프로세스가 뜹니다)');
  try {
    await client.connect();
  } catch (err: unknown) {
    status(`연결 실패: ${message(err)}`, true);
    return;
  }

  const v = await client.version().catch(() => null);
  if (v) log(`엔진 — Zelus ${v.zelus} / Lumia ${v.lumia}`);

  const first = scenes[0];
  if (!first) {
    status('연결됨 — .zls 를 업로드하세요');
    return;
  }
  // 씬이 있으면 바로 띄운다. 첫 화면이 곧 이 단위의 판정 기준이다.
  await show(first.id);
})();

// 콘솔용 창구. 화면이 이상할 때 여기서 직접 만진다.
declare global {
  // eslint-disable-next-line no-var
  var cobalt: {
    client: GatewayClient;
    viewer: Viewer3D;
    show: typeof show;
    get frames(): number;
  };
}
globalThis.cobalt = {
  client,
  viewer,
  show,
  get frames(): number {
    return frames;
  },
};
