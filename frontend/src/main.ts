/**
 * 앱 배선 — 게이트웨이 ↔ 3D 뷰 (#12, #13).
 *
 * 이 파일이 하는 일은 다섯뿐이다: 씬 목록을 채우고, 연결하고, 고른 씬을 띄우고,
 * **프레임을 흐르게 하고**, 상태를 보여준다. **렌더링은 `viewer3d/` 가, 통신은
 * `protocol/` 이 한다** — 여기에 three 나 WebSocket 코드를 늘리면 두 계층의
 * 경계가 흐려진다.
 *
 * ── #13 이 여기 남긴 것은 배선 세 줄뿐이다 ──────────────────
 * 프레임 로직은 전부 `viewer3d/frameStream.ts` 에 있다. 이 파일은 DOM 을 잡고
 * 있어서 Node 에서 부를 수 없고, 갱신 로직이 여기로 새는 순간 자동 테스트가
 * 사라지고 수동 확인만 남는다. 그래서 여기 있는 것은 (a) frame → `push`,
 * (b) rAF → `drain`, (c) 결과를 화면에 찍기, 셋뿐이다.
 *
 * ── UI 를 여기서 더 늘리지 말 것 ────────────────────────────
 * 재생 컨트롤(#14), 2D 펼침 뷰(#15), 파라미터 패널(#16)은 각각 자기 단위가
 * 있다. #13 의 판정 기준은 "옷이 움직인다" 하나이고, 버튼이 늘어날수록 그
 * 판정이 무엇 때문에 실패했는지 흐려진다. 아래 재생 버튼은 시뮬을 켜기 위한
 * **최소 트리거**이고, 타임라인·프레임 스크럽은 #14 의 몫이다.
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
import {
  FrameStream,
  showScene,
  Viewer3D,
  type FrameStreamStats,
} from './viewer3d/index.ts';

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
  play: el<HTMLButtonElement>('play'),
  frames: el<HTMLElement>('frames'),
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
/** 시뮬이 돌고 있다고 **우리가 믿는** 상태. 화면의 버튼 글자가 이걸 따른다 */
let playing = false;
/**
 * 이 워커 세션에서 subscribe 를 이미 보냈는가.
 *
 * ⚠️ 세션(=프로세스)마다 하나다. 재연결하면 **새 워커**라 구독이 꺼진 채로
 *    시작하므로 반드시 false 로 되돌려야 한다. 안 그러면 start 만 나가고
 *    mesh 없는 frame 이벤트만 흐른다 — 프레임 번호는 오르는데 옷은 안 움직이는,
 *    원인이 가장 안 보이는 상태다.
 */
let subscribed = false;

client.on('open', ({ reconnected, attempt }) => {
  if (!reconnected) return;
  log(`재연결됨 (${attempt}회) — 새 워커 세션이므로 씬을 다시 로드합니다`);
  // 새 워커다. 시뮬도 구독도 초기값이므로 우리 쪽 믿음을 먼저 지운다.
  playing = false;
  subscribed = false;
  paintPlay();
  if (currentScene) void show(currentScene, { refit: false });
});

client.on('close', ({ code, willReconnect }) => {
  // 소켓이 없으면 재생도 없다. 버튼이 살아 있으면 누를 때마다 "연결되어 있지
  // 않습니다" 만 나온다.
  playing = false;
  subscribed = false;
  paintPlay();
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

// ── 프레임 스트리밍 (#13) ───────────────────────────────────
//
// 여기 있는 것은 배선뿐이다. 무엇을 버리고 무엇을 푸는지는 전부
// `viewer3d/frameStream.ts` 가 정한다 — 그 파일은 DOM 을 안 만져서 Node 에서
// 그대로 돌아간다.

/** 토폴로지 자동 복구 상한. 무한 재로드(103MB!)를 막는다 */
const MAX_TOPOLOGY_RECOVERIES = 3;
let topologyRecoveries = 0;

const stream = new FrameStream({
  // frame 이벤트의 mesh 에는 indices·uvs 가 없어서 스트림 혼자서는 토폴로지를
  // 다시 세울 수 없다. `meshData(true)` 를 다시 받는 것 = showScene() 이고,
  // 그건 프로토콜을 아는 이쪽의 일이다.
  onMismatch: ({ frame, incoming, current }) => {
    log(`프레임 ${frame} 의 토폴로지가 화면과 다릅니다 (패턴 ${incoming} vs ${current})`);
    if (!currentScene) return;
    if (topologyRecoveries >= MAX_TOPOLOGY_RECOVERIES) {
      status('토폴로지를 다시 세워도 계속 어긋납니다 — 재로드를 중단합니다', true);
      return;
    }
    topologyRecoveries += 1;
    status(`토폴로지를 다시 받습니다 (${topologyRecoveries}/${MAX_TOPOLOGY_RECOVERIES})`);
    void show(currentScene, { refit: false });
  },
});

// ① 이벤트 핸들러는 **얹기만 한다.** 여기서 디코딩하면 40/s × 47.8KB 를
//    이벤트 루프에 태우게 되고, 그중 대부분은 다음 rAF 전에 덮어써진다.
client.on('frame', (ev) => stream.push(ev));

// ② rAF 에서 최신 하나만 푼다. **DOM 에 닿는 유일한 프레임 경로가 이 콜백이다.**
let statPaintedAt = 0;
viewer.onBeforeRender(() => {
  const out = stream.drain(viewer.cloth);
  if (out.status === 'error' && out.error) {
    log(`[프레임 ${out.frame}] 디코딩 실패: ${out.error.message}`);
  }
  // 한 프레임이라도 실제로 붙었으면 토폴로지는 다시 맞은 것이다. 복구 횟수를
  // 여기서만 되돌린다 — 로드 성공 시점에 되돌리면 "로드는 되는데 계속
  // 어긋나는" 경우에 상한이 무의미해져 103MB 재로드를 무한히 돈다.
  if (out.status === 'applied' && topologyRecoveries !== 0) topologyRecoveries = 0;
  // 화면에 숫자를 찍는 것은 초당 4회면 충분하다. 매 rAF 로 textContent 를
  // 건드리면 60/s 로 레이아웃을 흔들면서, 정작 읽을 수는 없다.
  const now = performance.now();
  if (now - statPaintedAt < 250) return;
  statPaintedAt = now;
  paintFrames();
});

function paintFrames(): void {
  const s = stream.stats;
  if (s.received === 0) {
    ui.frames.textContent = '-';
    return;
  }
  ui.frames.textContent =
    `프레임 ${s.lastApplied ?? '-'} · 적용 ${s.applied} · 버림 ${s.dropped}`
    + ` · ${s.fps.toFixed(1)}fps`
    + (s.stalled ? ' · ⚠정지' : '');
}

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
  ui.play.disabled = on || currentScene === null;
}

async function show(sceneId: string, opts: { refit?: boolean } = {}): Promise<void> {
  if (busy) return;
  setBusy(true);
  // 로드 중에 프레임이 들이닥치는 것을 막는다. `setTopology()` 가 지오메트리를
  // 통째로 갈아 끼우는 동안 옛 프레임을 적용하면 어긋난 메시를 그린다.
  stream.resume();
  status('씬을 로드하는 중… (103MB 면 1초쯤 걸립니다)');
  try {
    const shown = await showScene(client, viewer, sceneId, {
      // 재연결 후 다시 로드할 때는 사용자가 맞춰 둔 시점을 빼앗지 않는다.
      frameCamera: opts.refit !== false,
    });
    currentScene = sceneId;
    // 새 토폴로지가 섰다. 칸에 남아 있던 옛 프레임을 버리고 정지 상태를 푼다.
    stream.resume();
    ui.stat.textContent = `패턴 ${shown.patterns} · 정점 ${shown.vertices} · 삼각형 ${shown.triangles}`;
    status(`로드 완료 (${shown.elapsedMs}ms)`);
  } catch (err: unknown) {
    status(`로드 실패: ${message(err)}`, true);
  } finally {
    setBusy(false);
    paintPlay();
  }
}

// ── 재생 (#13 의 최소 트리거) ───────────────────────────────
//
// ── 구독은 켜면 세션이 끝날 때까지 켜 둔다 ──────────────────
// "정지할 때 unsubscribe 를 보낼 것인가" 를 코드를 보고 정했다. 워커는
// `backend/native/src/protocol.cpp:411-433` 에서 **`maxFrame` 이 바뀌었을 때만**
// frame 이벤트를 낸다. 즉 시뮬이 멈춰 있으면 구독이 켜져 있어도 흐르는 바이트가
// **0** 이다 — 정지 중 unsubscribe 로 아끼는 대역폭이 없다. 반대로 매 정지마다
// 왕복을 하나 더 만들면 "pause 는 성공했는데 unsubscribe 가 실패한" 어긋난
// 상태가 생기고, 재생할 때마다 subscribe 를 다시 보내야 한다.
// 세션이 끝날 때의 정리는 게이트웨이가 이미 한다 — `sessions.ts` 의 `#detach`
// 가 반납 직전에 워커로 unsubscribe 를 보내서, 구독이 다음 클라이언트에게
// 물려지지 않는다. 그래서 여기서는 **한 워커 세션에 subscribe 한 번**이다.
async function setPlaying(on: boolean): Promise<void> {
  if (!currentScene || !client.connected) return;
  ui.play.disabled = true;
  try {
    if (on) {
      // subscribe 를 start 보다 **먼저** 보낸다. 반대로 하면 그 사이에 진행한
      // 프레임들이 mesh 없이 지나가고, 옷은 몇 프레임 늦게 움직이기 시작한다.
      if (!subscribed) {
        await client.subscribe();
        subscribed = true;
        log('구독 켜짐 — 프레임당 약 48KB 가 흐르기 시작합니다');
      }
      await client.start();
      playing = true;
      status('시뮬레이션 실행 중');
    } else {
      await client.pause();
      playing = false;
      status('일시정지');
    }
  } catch (err: unknown) {
    // 믿음을 고치지 않는다 — 실패했으니 상태는 그대로다.
    status(`${on ? '재생' : '정지'} 실패: ${message(err)}`, true);
  } finally {
    ui.play.disabled = busy || currentScene === null;
    paintPlay();
  }
}

function paintPlay(): void {
  ui.play.textContent = playing ? '⏸ 정지' : '▶ 재생';
  ui.play.disabled = busy || currentScene === null || !client.connected;
}

ui.play.addEventListener('click', () => {
  void setPlaying(!playing);
});

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
//
// `stats` 가 #13 의 진단 표면이다: `received` 는 오르는데 `applied` 가 안 오르면
// 그리는 쪽이고, `withMesh` 가 0 이면 구독이 안 켜진 것이고, `dropped` 가 크면
// 브라우저가 디코딩을 못 따라가는 것이다.
declare global {
  // eslint-disable-next-line no-var
  var cobalt: {
    client: GatewayClient;
    viewer: Viewer3D;
    stream: FrameStream;
    show: typeof show;
    play: typeof setPlaying;
    get frames(): number;
    get stats(): FrameStreamStats;
  };
}
globalThis.cobalt = {
  client,
  viewer,
  stream,
  show,
  play: setPlaying,
  get frames(): number {
    return stream.stats.received;
  },
  get stats(): FrameStreamStats {
    return stream.stats;
  },
};
