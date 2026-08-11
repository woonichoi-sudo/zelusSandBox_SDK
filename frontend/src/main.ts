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
 * ── 스냅샷이 여기 남긴 것도 배선이다 ────────────────────────
 * 익스포트한 glTF(아바타·머티리얼·텍스처가 든 정지 화면)를 세우는 순서는
 * `viewer3d/snapshot.ts` 가 전부 정한다. 이 파일에 있는 것은 버튼 두 개와
 * 진행률을 찍는 콜백뿐이다. **모드 전환은 `viewer.setMode` 한 곳만 부른다** —
 * 실시간 옷과 스냅샷은 좌표계가 달라(ISSUE-011) 겹쳐 보이면 안 되는데, 그
 * 불변식을 지키는 유일한 방법이 "visible 을 정하는 자리를 하나로 두는 것" 이다.
 *
 * ── 재생 컨트롤(#14)이 여기 남긴 것도 배선이다 ──────────────
 * 상태(재생/정지/씬 없음/로드 중)와 전이는 전부 `panels/playback.ts` 에 있다.
 * 그 파일은 DOM 을 안 만져서 Node 에서 전이 전체를 돌릴 수 있다 — **ISSUE-009
 * 가 바로 그 반대편에서 났다.** 재생 상태가 이 파일의 불리언 두 개로 흩어져
 * 있어서 자동 테스트가 한 줄도 덮지 못했고, "버튼은 정지인데 시뮬은 멈춰
 * 있다" 를 사람이 눈으로 찾아야 했다. 여기 있는 것은 (a) 버튼·키 이벤트를
 * 컨트롤러로 넘기고, (b) `view` 를 글자로 찍는 것, 둘뿐이다.
 *
 * ── UI 를 여기서 더 늘리지 말 것 ────────────────────────────
 * 2D 펼침 뷰(#15), 파라미터 패널(#16)은 각각 자기 단위가 있다. 그리고 새 UI 를
 * 붙일 때는 **상태를 `panels/` 아래 DOM-free 모듈로 먼저 빼고** 여기에는
 * 배선만 남길 것. 이 파일에 로직이 들어오는 순간 그만큼 자동 테스트가 사라진다.
 *
 * ── 재연결은 복구가 아니다 ──────────────────────────────────
 * 끊겼다 붙으면 **새 워커 프로세스**다. 씬이 로드돼 있지 않고, 시뮬 상태도
 * 파라미터도 구독도 초기값이다. 그래서 `open` 의 `reconnected` 를 보고 씬을
 * 다시 로드한다 — 아래 유일한 재로드 지점이 그것이다. 이 코드가 없으면 화면에
 * 남아 있는 옷은 이미 죽은 세션의 잔상이고, 다음 op 은 "씬이 없다" 로 실패한다.
 */

import {
  AvatarBodyPanel,
  SurfaceSizePanel,
  PlaybackController,
  shortcutFor,
  SHORTCUT_HINT,
  type PlaybackView,
  type ShortcutAction,
} from './panels/index.ts';
import {
  decodePatterns,
  downloadExport,
  fetchHealth,
  GatewayClient,
  listScenes,
  uploadScene,
  type SceneSummary,
} from './protocol/index.ts';
import { AvatarPanel, ParamsPanel, SurfacePanel } from './ui/index.ts';
import { Unfolder, UnfoldController, Viewer2D } from './viewer2d/index.ts';
import {
  FrameStream,
  showScene,
  SnapshotLoader,
  SnapshotStaleError,
  Viewer3D,
  type FrameStreamStats,
  type ParsedSnapshot,
  type SnapshotLoaderStats,
} from './viewer3d/index.ts';

// ── DOM ─────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} 가 없습니다`);
  return node as T;
}

const ui = {
  canvas: el<HTMLCanvasElement>('view'),
  // 가운데 칸의 도면 캔버스 (L-2a). 왼쪽 칸과 별개의 렌더러다.
  canvas2d: el<HTMLCanvasElement>('view2d'),
  draft2dEmpty: el<HTMLElement>('draft2dEmpty'),
  scene: el<HTMLSelectElement>('scene'),
  load: el<HTMLButtonElement>('load'),
  file: el<HTMLInputElement>('file'),
  upload: el<HTMLButtonElement>('upload'),
  play: el<HTMLButtonElement>('play'),
  // ⛔ `#step` 은 없다 — 워커의 step op 이 no-op 이라 화면에 올리지 않았다
  //    (`index.html` 의 주석에 실측이 있다).
  reset: el<HTMLButtonElement>('reset'),
  clear: el<HTMLButtonElement>('clear'),
  snap: el<HTMLButtonElement>('snap'),
  mode: el<HTMLButtonElement>('mode'),
  snapstat: el<HTMLElement>('snapstat'),
  sim: el<HTMLElement>('sim'),
  frames: el<HTMLElement>('frames'),
  stat: el<HTMLElement>('stat'),
  status: el<HTMLElement>('status'),
  hint: el<HTMLElement>('hint'),
  log: el<HTMLElement>('log'),
  // 파라미터 패널 (#16). 안의 위젯 22개는 `ui/paramsPanel.ts` 가 만든다 —
  // 여기 잡는 것은 접이 상자와 그 안의 빈 자리뿐이다.
  paramsWrap: el<HTMLDetailsElement>('paramsWrap'),
  params: el<HTMLElement>('params'),
  paramsBadge: el<HTMLElement>('paramsBadge'),
  // 아바타 체형 패널이 그려질 오른쪽 칸 (L-3a)
  avatarPanel: el<HTMLElement>('avatarPanel'),
  // 옷 사이즈 패널 (L-3b). 같은 칸의 체형 아래에 이어 붙는다
  surfacePanel: el<HTMLElement>('surfacePanel'),
  // 2D 펼침 (#15-b). 슬라이더 하나와 글자 두 자리 — 판단은 `viewer2d/` 다.
  unfold: el<HTMLInputElement>('unfold'),
  unfoldStat: el<HTMLElement>('unfoldStat'),
  unfoldWhy: el<HTMLElement>('unfoldWhy'),
};

ui.hint.textContent = `${ui.hint.textContent ?? ''}  |  ${SHORTCUT_HINT}`;

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

/**
 * 가운데 칸의 재단 도면 (L-2a).
 *
 * ★ **프레임 경로에 붙지 않는다.** 도면 좌표는 `uvs`·`transform2d` 로만
 *   계산되고 둘 다 topology 와 함께 한 번만 오므로, 옷이 어떻게 드레이프
 *   되든 재단 도면은 같다. 그래서 아래 rAF 드레인(`#applyFrame`)에도,
 *   `refreshPose()` 에도 이 뷰어가 나오지 않는다 — 세우는 것은 로드당 한 번,
 *   `paintDraft2d()` 뿐이다.
 */
const viewer2d = new Viewer2D({ canvas: ui.canvas2d });
viewer2d.start();

/**
 * 가운데 칸에 도면을 세운다. **`unfolder` 와 같은 계산을 다시 하지 않는다** —
 * 왼쪽 칸의 모핑이 쓰는 것과 같은 `Unfolder` 를 한 벌 더 두고 `t = 1` 에
 * 고정한다.
 *
 * 왜 별도의 `Unfolder` 인가: `build()` 가 만드는 목표 정점은 **메시 로컬**
 * 좌표라(`unfold.ts` 머리말) 어느 메시에 걸린 3D 변환을 되돌린 것인지에
 * 의존한다. 왼쪽 옷과 가운데 옷은 서로 다른 `Mesh` 객체이므로 목표도 따로
 * 계산해야 한다. `build()` 는 로드당 한 번이라 비용이 두 배가 되어도 로드
 * 경로에만 있다.
 */
const unfolder2d = new Unfolder();

function paintDraft2d(): void {
  const b = unfolder2d.stats.bounds;
  viewer2d.fit(b);
  // 도면이 없으면 격자만 남는다. 그 상태가 무엇인지 글자로 말한다 —
  // 빈 격자만으로는 "아직 안 만든 것" 과 "고장난 것" 이 구분되지 않는다.
  ui.draft2dEmpty.hidden = b !== null;
}

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

/**
 * 지금 화면에 떠 있어야 할 씬. 재연결 후 무엇을 다시 로드할지의 정본이다.
 *
 * `playback.view.scene` 과는 다른 것이다 — 저쪽은 **워커에 로드돼 있다고
 * 아는 것**이고, 이쪽은 **우리가 보고 싶은 것**이다. 재연결처럼 워커가 비어
 * 있는데 다시 세워야 하는 순간에 둘이 갈라지고, 그 차이가 곧 재로드 지시다.
 */
let currentScene: string | null = null;
let busy = false;

client.on('open', ({ reconnected, attempt }) => {
  // 새 워커다. 시뮬도 구독도 씬도 초기값이므로 우리 쪽 믿음을 먼저 지운다.
  playback.sessionStarted();
  // 새 워커는 씬도 파라미터도 초기값이다. 화면에 남은 값은 이미 죽은 세션의 것이다.
  refreshParams();
  if (!reconnected) return;
  log(`재연결됨 (${attempt}회) — 새 워커 세션이므로 씬을 다시 로드합니다`);
  paintSnap();
  if (currentScene) void show(currentScene, { refit: false });
});

client.on('close', ({ code, willReconnect }) => {
  // 소켓이 없으면 재생도 없다. 버튼이 살아 있으면 누를 때마다 "연결되어 있지
  // 않습니다" 만 나온다.
  playback.connectionLost();
  // 소켓이 없으면 파라미터를 읽을 수도 보낼 수도 없다. 패널이 그렇게 말해야 한다.
  refreshParams();
  // 스냅샷은 **버리지 않는다.** 이미 화면에 서 있는 것은 소켓과 무관하게
  // 유효한 정지 화면이라, 끊겼다고 지우면 볼 수 있는 것까지 사라진다.
  // 새로 찍는 것만 막는다 (paintSnap 이 client.connected 를 본다).
  paintSnap();
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

// ── 2D 펼침 (#15-b) ─────────────────────────────────────────
//
// 여기 있는 것도 배선뿐이다. **좌표 변환과 보간은 `viewer2d/unfold.ts`**,
// **상태 판정은 `viewer2d/control.ts`** 에 있고 둘 다 DOM 을 안 만져서 Node 가
// 그대로 돌린다. 카메라(원근 ↔ 정사영)는 `viewer3d/viewer.ts` 의 `setUnfold` 다.
//
// ── 배타 모드와 어떻게 맞물리는가 ───────────────────────────
// **맞물리지 않는다 — 2D 는 세 번째 뷰가 아니다.** `ViewMode` 는 여전히
// `live | snapshot` 둘뿐이고, 펼침은 **실시간 옷의 자세**를 바꾼다(같은 메시,
// 같은 그룹, 정점만 이동). 그래서 `setMode` 의 불변식("둘 다 켜짐을 표현할 수
// 없다")도, UI 하네스 §7 이 검사하는 것도 그대로다.
//
// 스냅샷을 보는 중에 펼치면 어떻게 되는가 — **화면은 안 바뀐다.** 펼쳐지는
// 것은 숨어 있는 실시간 옷이고, 스냅샷(익스포트한 glTF)은 도면 좌표를 갖고
// 있지 않다. 그래서 아래에서 스냅샷 모드일 때는 슬라이더를 만지면 실시간으로
// 돌아온다 — 재생 버튼이 하는 것(`returnToLiveForPlayback`)과 같은 판단이다.
const unfolder = new Unfolder();
const unfoldControl = new UnfoldController();

/** 슬라이더·글자·카메라를 한 번에 맞춘다. **상태는 만들지 않는다** */
function paintUnfold(): void {
  const v = unfoldControl.view;
  ui.unfold.disabled = busy || !v.enabled;
  // 컨트롤러가 정본이다. 씬이 내려가 t 가 0 으로 돌아갔는데 슬라이더만 오른쪽에
  // 남아 있으면, 화면이 "2D 를 보고 있다" 고 거짓말한다.
  const want = String(Math.round(v.t * 100));
  if (ui.unfold.value !== want) ui.unfold.value = want;
  ui.unfoldStat.textContent = v.label;
  ui.unfoldWhy.textContent = v.reason ?? '';
  // 카메라·투영·격자. 정점은 아래 rAF 가 옮긴다.
  viewer.setUnfold(v.t, unfolder.stats.bounds);
}

ui.unfold.addEventListener('input', () => {
  // 스냅샷은 도면 좌표가 없다 — 펼쳐도 화면이 안 바뀐다. 재생과 같은 이유로
  // 실시간으로 돌려놓는다(원인이 화면 어디에도 안 남는 실패를 만들지 않는다).
  if (viewer.mode === 'snapshot' && Number(ui.unfold.value) > 0) {
    log('펼침 — 스냅샷에는 2D 배치가 없어 실시간 뷰로 돌아갑니다 (스냅샷은 남아 있습니다)');
    setMode('live');
  }
  unfoldControl.set(Number(ui.unfold.value) / 100);
  paintUnfold();
});

// ── 파라미터 패널 (#16) ─────────────────────────────────────
//
// 여기 있는 것도 배선뿐이다. **스키마·검증·비활성 판정은 `panels/params.ts`**
// (DOM 없음, Node 테스트가 그 위에 선다)이고, **위젯을 그리는 것은
// `ui/paramsPanel.ts`** 다. 이 파일에 남은 것은 (a) 클라이언트를 포트로
// 넘기고, (b) 값이 낡는 순간마다 다시 읽으라고 알리고, (c) 재생 중이라는
// 사실을 밀어 넣는 것, 셋뿐이다.
//
// `client` 를 어댑터 없이 넘길 수 있는 이유는 `PlaybackPort` 와 같다 —
// `ParamsPort` 가 구조적 타입이라 `GatewayClient` 가 이미 만족한다.
//
// ⚠️ 패널이 `client.status()` 를 **직접** 부른다. `PlaybackController` 가
//    `status` 를 이미 물고 있지만 `loaded`·`simInitialized` 를 밖으로 내주지
//    않고(`PlaybackView` 에 없다), `solverType` 잠금 조건이 바로
//    `simInitialized` 다. 왕복 하나를 아끼려고 `playback.ts` 의 공개 표면을
//    넓히면 스모크 573건이 서 있는 파일을 이 단위에서 건드리게 된다. 폴링이
//    아니라 **패널을 펼치거나 씬이 바뀔 때만** 부르므로 비용은 무시할 만하다.
const params = new ParamsPanel({
  root: ui.params,
  badge: ui.paramsBadge,
  port: client,
  hooks: { log, status },
});

/**
 * 워커의 파라미터가 낡았을 수 있는 자리에서 부른다.
 *
 * **접혀 있으면 왕복을 만들지 않는다.** 씬을 로드할 때마다 안 보이는 패널을
 * 위해 `status`+`getParams` 를 보낼 이유가 없다. 대신 낡았다고 표시해 두고,
 * 펼치는 순간 아래 `toggle` 이 읽는다.
 */
function refreshParams(): void {
  if (ui.paramsWrap.open) void params.refresh();
  else params.markStale();
}

ui.paramsWrap.addEventListener('toggle', () => {
  if (ui.paramsWrap.open && params.stale) void params.refresh();
});

// ── 아바타 체형 (L-3a) ──────────────────────────────────────
//
// #16 이 세운 3층을 그대로 따른다: 판단은 `panels/avatarBody.ts`(DOM 없음),
// 그리는 것은 `ui/avatarPanel.ts`, 배선은 여기.
//
// `ParamsPanel` 과 달리 이 패널은 **접히지 않는다** — 오른쪽 칸이 자기 자리라
// 항상 보인다. 그래서 `markStale`/`toggle` 같은 지연 갱신 장치가 없고, 씬이
// 바뀔 때 그냥 읽는다. 왕복 하나(값 54개)라 비용이 작다.
const avatarBody = new AvatarBodyPanel();

const avatarPanel = new AvatarPanel({
  root: ui.avatarPanel,
  panel: avatarBody,
  onEdit: (key, value) => {
    avatarBody.edit(key, value);
    avatarPanel.render();
  },
  onApply: () => void applyAvatarBody(),
  onRevert: () => {
    avatarBody.revert();
    avatarPanel.render();
  },
});

/** 워커의 체형을 다시 읽어 화면에 붓는다. 씬이 없으면 비운다 */
async function refreshAvatarBody(): Promise<void> {
  if (!currentScene || !client.connected) {
    avatarBody.clear();
    avatarPanel.render();
    return;
  }
  try {
    avatarBody.setFromWorker(await client.avatarBody());
  } catch (err: unknown) {
    // 못 읽었으면 **옛 값을 남기지 않는다.** 남기면 화면이 지금 아바타와
    // 무관한 숫자를 "현재 체형" 이라고 말한다.
    avatarBody.clear();
    log(`아바타 체형을 읽지 못했습니다: ${message(err)}`);
  }
  avatarPanel.render();
}

/**
 * 바뀐 값만 보낸다.
 *
 * ★ 응답의 `avatar` 는 **워커가 되읽은 값**이다(요청값의 메아리가 아니다).
 *   그대로 화면에 부으면, 엔진이 값을 클램프했거나 아무 일도 안 했을 때 그
 *   사실이 화면에 그대로 드러난다.
 */
async function applyAvatarBody(): Promise<void> {
  const payload = avatarBody.payload();
  if (Object.keys(payload).length === 0) return;
  try {
    const res = await client.setAvatarBody(payload);
    avatarBody.applied(res.avatar);
    log(
      `아바타 체형 — 적용 ${res.applied.length}개`
      + (res.unknown.length > 0 ? ` · ⚠ 모르는 키 ${res.unknown.join(', ')}` : ''),
    );
    if (res.unknown.length > 0) {
      status(`워커가 모르는 체형 키가 있습니다: ${res.unknown.join(', ')}`, true);
    }
  } catch (err: unknown) {
    status(`아바타 체형 적용 실패: ${message(err)}`, true);
  }
  avatarPanel.render();
}

// ── 옷 사이즈 (L-3b) ────────────────────────────────────────
//
// 체형과 같은 3층이되 **보내는 단위가 다르다** — 워커의 `setSurfaceSize` 가
// 서피스 하나를 받으므로 [적용]도 행마다다(`panels/surfaceSize.ts`).
const surfaceSize = new SurfaceSizePanel();

const surfacePanel = new SurfacePanel({
  root: ui.surfacePanel,
  panel: surfaceSize,
  onEdit: (uuid, axis, value) => {
    surfaceSize.edit(uuid, axis, value);
    surfacePanel.render();
  },
  onApply: (uuid) => void applySurfaceSize(uuid),
  onRevert: (uuid) => {
    surfaceSize.revert(uuid);
    surfacePanel.render();
  },
});

async function refreshSurfaces(): Promise<void> {
  if (!currentScene || !client.connected) {
    surfaceSize.clear();
    surfacePanel.render();
    return;
  }
  try {
    surfaceSize.setFromWorker((await client.surfaces()).surfaces);
  } catch (err: unknown) {
    // 못 읽었으면 옛 목록을 남기지 않는다 — 남기면 화면이 지금 씬에 없는
    // 패턴의 크기를 "현재 크기" 라고 말한다.
    surfaceSize.clear();
    log(`패턴 크기를 읽지 못했습니다: ${message(err)}`);
  }
  surfacePanel.render();
}

/**
 * 행 하나를 보낸다.
 *
 * ★ 응답이 **바꾼 뒤의 전체 목록**이라 그대로 부으면 된다. 엔진이 값을
 *   조정했으면(실측: 폭을 +30% 하면 높이가 0.03% 흔들린다) 그 사실이 화면에
 *   그대로 드러난다 — 요청값을 화면에 남기면 그 조정이 가려진다.
 */
async function applySurfaceSize(uuid: string): Promise<void> {
  const size = surfaceSize.payload(uuid);
  if (!size) return;
  try {
    const res = await client.setSurfaceSize(uuid, size);
    surfaceSize.setFromWorker(res.surfaces);
    const now = res.surfaces.find((s) => s.uuid === uuid);
    log(
      `옷 사이즈 — ${now?.name ?? uuid}`
      + (now ? ` → ${now.width.toFixed(2)} × ${now.height.toFixed(2)}cm` : ''),
    );
  } catch (err: unknown) {
    status(`옷 사이즈 적용 실패: ${message(err)}`, true);
  }
  surfacePanel.render();
}

// ── 재생 컨트롤 (#14) ───────────────────────────────────────
//
// 상태와 전이는 `panels/playback.ts` 가 전부 정한다. 여기 있는 것은 (a) 포트로
// `client` 를 그대로 넘기고, (b) 화면에만 할 수 있는 일 세 가지를 훅으로 끼우고,
// (c) 상태가 바뀔 때 버튼 글자를 다시 찍는 것뿐이다.
//
// `client` 를 어댑터 없이 넘길 수 있는 이유는 `PlaybackPort` 가 구조적 타입이라
// `GatewayClient` 가 이미 만족하기 때문이다 — Node 테스트는 같은 모양의 가짜를
// 넣어 전이 전체를 화면 없이 돌린다.
const playback = new PlaybackController({
  port: client,
  hooks: {
    log,
    onChange: paintPlayback,
    // 정지 화면(스냅샷) 위에서 시뮬을 켜면 "재생을 눌렀는데 아무것도 안
    // 움직인다" 가 된다. 원인이 화면 어디에도 안 남는 실패다.
    beforePlay: returnToLiveForPlayback,
    afterReset: refreshPose,
    afterClear: clearScene,
  },
});

/**
 * 리셋 뒤에 **포즈를 다시 받아 온다.**
 *
 * 워커는 `maxFrame` 이 바뀔 때만 frame 이벤트를 낸다. 리셋은 그걸 -1 로
 * 되돌리므로 다시 재생하기 전까지 이벤트가 한 건도 오지 않는다 — 즉 시뮬은
 * 처음으로 돌아갔는데 **화면은 드레이프된 옷 그대로**다. ISSUE-009 와 정확히
 * 같은 계열(화면이 거짓말한다)이라 여기서 막는다.
 *
 * 토폴로지는 리셋으로 바뀌지 않으므로 `meshData(false)`(위치만)면 충분하다 —
 * 103MB 재로드가 아니라 프레임 한 장 값이다.
 */
async function refreshPose(): Promise<void> {
  if (!currentScene || !client.connected) return;
  // 칸에 남아 있는 옛 런의 프레임을 먼저 버린다. 안 그러면 방금 받은 리셋
  // 포즈를 다음 rAF 가 드레이프된 프레임으로 덮어쓴다.
  stream.resume();
  const patterns = decodePatterns(await client.meshData(false));
  if (!viewer.cloth.updatePositions(patterns)) {
    log('리셋 후 포즈가 화면의 토폴로지와 다릅니다 — 씬을 다시 로드하세요');
    return;
  }
  // 정점 버퍼가 방금 3D 로 덮였다. 펼침의 원본도 같이 갱신해야 한다 —
  // 안 하면 t>0 인 채로 리셋했을 때 화면이 리셋 전 포즈에 멎는다
  // (`sync` 가 다시 쓰라고 표시까지 해 준다).
  unfolder.sync(viewer.cloth.patterns);
  log(`리셋 — 포즈를 다시 받아 화면에 반영했습니다 (패턴 ${patterns.length})`);
}

/**
 * `clear` 뒤에 화면을 비운다. **씬이 워커에서 내려갔으므로 화면에 남은 옷은
 * 이미 아무것도 가리키지 않는다.**
 *
 * 잃는 것은 시뮬 진행뿐이다 — `.zls` 는 게이트웨이에 그대로 있고 [로드] 한
 * 번이면 돌아온다. 상태줄이 그 방법을 말해 주는 이유가 그것이다.
 */
function clearScene(): void {
  viewer.cloth.clear();
  dropSnapshot();
  stream.resume();
  // 도면 좌표는 씬에 딸려 있다. 남겨 두면 다음 씬의 패턴에 옛 배치가 섞인다.
  unfolder.clear();
  unfoldControl.setScene(false);
  unfoldControl.setStats(null);
  paintUnfold();
  // 가운데 칸도 같이 내린다 — 씬이 워커에서 내려갔으므로 도면 역시 아무것도
  // 가리키지 않는다 (L-2a).
  viewer2d.cloth.clear();
  unfolder2d.clear();
  paintDraft2d();
  currentScene = null;
  // 아바타도 씬에 딸려 있다. `currentScene = null` 뒤에 불러야
  // `refreshAvatarBody` 가 "씬 없음" 갈래로 간다.
  void refreshAvatarBody();
  void refreshSurfaces();
  ui.stat.textContent = '-';
  ui.frames.textContent = '-';
  // 파라미터는 씬에 딸려 있다. 씬이 내려갔으면 화면의 값은 더 이상 아무것도
  // 가리키지 않는다.
  refreshParams();
  status('씬을 내렸습니다 — 다시 보려면 [로드] 를 누르세요');
  setBusy(false);
}

/** 버튼 네 개의 글자와 활성 상태. **상태는 만들지 않는다 — 받은 것만 그린다** */
function paintPlayback(view: PlaybackView = playback.view): void {
  ui.play.textContent = view.playLabel;
  ui.play.disabled = busy || !view.canPlay;
  ui.reset.disabled = busy || !view.canReset;
  ui.clear.disabled = busy || !view.canClear;
  ui.sim.textContent = view.text;
  // ★ 재생 중에는 파라미터 [적용] 을 잠근다. **위젯은 열어 둔다** — 값을 미리
  //   맞춰 두고 정지한 뒤 한 번에 보낼 수 있다. 잠그는 이유는 시뮬이 도는
  //   도중의 변경이 어떻게 반영되는지 **측정한 적이 없어서**다. 한 런의
  //   프레임들이 서로 다른 파라미터로 계산되면 그 결과를 무엇으로 만들었다고
  //   말할 수 없게 된다. 사용자가 [⏸ 정지] 로 스스로 풀 수 있고, 잠긴 이유는
  //   패널에 글자로 뜬다 (`ui/paramsPanel.ts` 머리말 참고).
  params.setBlocked(
    view.playing
      ? '재생 중에는 적용하지 않습니다 — [⏸ 정지] 후 누르세요 (시뮬 도중 변경의 반영 방식은 측정되지 않았습니다)'
      : null,
  );
  syncParamLock(view);
}

/**
 * 잠금 조건(`status.simInitialized`)을 **전이가 끝난 순간에만** 되묻는다.
 *
 * ── 왜 필요한가 ────────────────────────────────────────────
 * `simInitialized` 는 **재생을 시작하면 워커에서 켜진다.** 패널은 값을 읽을
 * 때만 그 사실을 다시 봤으므로, 재생 뒤에도 [워커에서 읽기]·씬 로드 전까지
 * `solverType` 이 열려 있었다 — 화면이 "만질 수 있다" 고 말하는데 실제로는
 * 만지면 안 되는 상태다. 이 단위가 없애려던 바로 그 거짓말이라 여기서 막는다.
 *
 * ── 폴링이 되지 않게 하는 두 겹 ─────────────────────────────
 * ① `pending !== null` 이면 건너뛴다. `paintPlayback` 은 op 하나마다 최소 두
 *    번 불린다(왕복 시작 / 끝). **끝난 것만** 본다.
 * ② `(state, workerMode)` 서명이 그대로면 건너뛴다. `workerMode` 는
 *    `syncFromWorker` 가 채우는 **워커의 사실**이라, 재생·정지·리셋·clear·로드
 *    가 전부 여기서 갈린다. 결과적으로 **사용자 조작 하나당 status 한 번**이고
 *    프레임 이벤트로는 한 번도 불리지 않는다(rAF 경로는 `ui.sim` 글자만 만진다).
 *
 * ⚠️ 패널이 접혀 있으면 왕복 대신 낡음 표시만 남긴다 — 펼치는 순간
 *    `refresh()` 가 `simInitialized` 까지 같이 읽어 온다. `refreshParams()` 를
 *    그대로 쓰지 않는 이유는 그쪽이 `getParams()` 까지 읽어 **사용자가 맞춰 둔
 *    값을 되덮기** 때문이다 — 재생 중에는 [적용] 이 잠기므로 값을 미리 맞춰
 *    두는 것이 정상 사용 경로다.
 */
let lockSignature: string | null = null;

function syncParamLock(view: PlaybackView): void {
  if (view.pending !== null) return;
  const sig = `${view.state}/${view.workerMode ?? '-'}`;
  if (sig === lockSignature) return;
  lockSignature = sig;
  if (ui.paramsWrap.open) void params.syncLock();
  else params.markStale();
}

// ① 이벤트 핸들러는 **얹기만 한다.** 여기서 디코딩하면 40/s × 47.8KB 를
//    이벤트 루프에 태우게 되고, 그중 대부분은 다음 rAF 전에 덮어써진다.
//    `noteFrame` 도 숫자 하나를 대입할 뿐이고 화면을 다시 그리지 않는다 —
//    그리는 것은 아래 rAF 가 4/s 로 눌러서 한다.
client.on('frame', (ev) => {
  stream.push(ev);
  playback.noteFrame(ev.frame);
});

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
  // ★ 2D 펼침 (#15-b). **순서가 전부다.**
  //   `sync` 는 정점 버퍼에 3D 가 들어 있을 때만 불러야 한다 — 방금 프레임이
  //   붙었을 때가 정확히 그 순간이다. 순서가 뒤집히면 섞인 값을 원본으로
  //   착각해서, 재생하는 동안 옷이 조금씩 도면 쪽으로 눌어붙는다.
  //   `apply` 는 t=0 이면 아무 일도 하지 않으므로 2D 를 안 쓰는 동안의 비용이 0 이다.
  if (out.status === 'applied') unfolder.sync(viewer.cloth.patterns);
  unfolder.apply(viewer.cloth.patterns, unfoldControl.effectiveT);
  // 화면에 숫자를 찍는 것은 초당 4회면 충분하다. 매 rAF 로 textContent 를
  // 건드리면 60/s 로 레이아웃을 흔들면서, 정작 읽을 수는 없다.
  const now = performance.now();
  if (now - statPaintedAt < 250) return;
  statPaintedAt = now;
  paintFrames();
  // 재생 중에는 프레임 번호가 40/s 로 오른다. 컨트롤러는 그때 다시 그리라고
  // 부르지 않으므로(그러면 초당 40번 DOM 을 흔든다) 여기서 같이 눌러 찍는다.
  ui.sim.textContent = playback.view.text;
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

// ── 스냅샷 (아바타 + 진짜 색) ───────────────────────────────
//
// 여기 있는 것도 배선뿐이다. 순서·중복 방지·세대 관리는 전부
// `viewer3d/snapshot.ts` 에 있고 그 파일은 DOM 을 안 만진다.
//
// ── 왜 버튼인가 (자동이 아닌 이유) ──────────────────────────
// 익스포트는 sample.zls 1.5초 / 사용자 씬 36.5MB 4.3초다(#10 실측). 씬을 열
// 때마다 자동으로 돌리면 (a) 첫 화면이 그만큼 늦어지고 (b) 사용자가 안 볼
// 수도 있는 36MB 를 워커가 매번 디스크에 쓴다. 반면 얻는 것은 "정지 화면
// 하나" 다 — 지금 필요한 순간에만 만드는 것이 맞다.
//
// ── 재생 중에도 막지 않는다 ─────────────────────────────────
// 시뮬이 도는 중에 찍으면 **그 시점의 포즈**가 나온다. 막을 이유가 없고
// 오히려 쓸모가 있다(원하는 순간의 드레이프를 아바타와 함께 본다). 대신
// 값이 흔들린다는 사실을 로그에 남긴다 — 익스포트가 도는 4.3초 동안 시뮬도
// 계속 진행하므로 **버튼을 누른 프레임과 파일에 담긴 프레임은 다르다.**
// 자동으로 pause 를 걸지 않는 이유는 사용자가 지시하지 않은 상태 변경이라서다.

const snapshots = new SnapshotLoader<ParsedSnapshot>({
  source: {
    // ⚠️ path 를 넣지 않는다 — 게이트웨이가 거부한다. 형식 하나뿐이다.
    requestExport: (format) => client.exportScene(format),
    download: (url, onProgress, expectedBytes) =>
      downloadExport(url, {
        expectedBytes,
        onProgress: ({ loaded, total }) => onProgress(loaded, total),
      }),
  },
  // `viewer.snapshot` 이 `SnapshotTarget` 을 이미 구현한다. 어댑터가 없다.
  target: viewer.snapshot,
  onProgress: (p) => {
    if (p.phase === 'exporting') {
      ui.snapstat.textContent = `익스포트 중… ${(p.elapsedMs / 1000).toFixed(1)}s`;
    } else if (p.phase === 'downloading') {
      ui.snapstat.textContent = p.total
        ? `내려받는 중… ${fmtBytes(p.loaded)} / ${fmtBytes(p.total)}`
        : `내려받는 중… ${fmtBytes(p.loaded)}`;
    } else if (p.phase === 'parsing') {
      // 36.5MB 파싱은 메인 스레드를 잡는다. 미리 말해 두지 않으면 "멈췄다" 로 읽힌다.
      ui.snapstat.textContent = `glTF 를 여는 중… (${fmtBytes(p.total)})`;
    } else if (p.phase === 'idle') {
      ui.snapstat.textContent = '';
    }
  },
  now: () => performance.now(),
});

/** 스냅샷 버튼을 눌렀다 */
async function takeSnapshot(): Promise<void> {
  if (!currentScene || !client.connected) return;
  ui.snap.disabled = true;
  if (playback.playing) {
    log('재생 중 스냅샷 — 파일에 담기는 포즈는 버튼을 누른 시점보다 몇 프레임 뒤입니다');
  }
  status('스냅샷을 만드는 중… (아바타·머티리얼이 들어간 glTF 를 받습니다)');
  try {
    const r = await snapshots.load();
    // 성공했으니 화면을 스냅샷으로 돌린다. 이 한 줄이 유일한 전환 지점이다.
    setMode('snapshot', { refit: true });
    ui.snapstat.textContent =
      `스냅샷 ${fmtBytes(r.info.bytes)} · 메시 ${r.stats.meshes}`
      + ` · 정점 ${r.stats.vertices.toLocaleString('ko-KR')}`
      + ` · 머티리얼 ${r.stats.materials} · 텍스처 ${r.stats.textures}`;
    log(
      `스냅샷 완료 ${r.elapsedMs}ms `
      + `(익스포트 ${r.timings.exportMs} / 다운로드 ${r.timings.downloadMs}`
      + ` / 파싱 ${r.timings.parseMs} / 부착 ${r.timings.installMs})`,
    );
    status(`스냅샷 표시 중 — ${r.info.name}`);
  } catch (err: unknown) {
    if (err instanceof SnapshotStaleError) {
      // 취소다. 사용자가 그 사이에 다른 씬을 눌렀다는 뜻이므로 오류가 아니다.
      log(err.message);
    } else {
      ui.snapstat.textContent = '';
      status(`스냅샷 실패: ${message(err)}`, true);
    }
  } finally {
    paintSnap();
  }
}

/**
 * 실시간 ↔ 스냅샷. **뷰어의 `setMode` 하나만 부른다** — 두 그룹의 visible 을
 * 여기서 만지기 시작하면 "둘 다 보이는" 상태가 만들어질 수 있게 된다.
 */
function setMode(
  mode: 'live' | 'snapshot',
  opts: { refit?: boolean; quiet?: boolean } = {},
): void {
  if (mode === 'snapshot' && !snapshots.present) return;
  viewer.setMode(mode);
  // 스냅샷은 아바타까지 있어 경계가 옷보다 훨씬 크다. 처음 세울 때는 맞춰
  // 주고, 되돌아올 때는 사용자가 잡아 둔 시점을 빼앗지 않는다.
  if (opts.refit) viewer.frameCamera();
  paintSnap();
  // ★ 화면이 바뀌면 상태줄도 같이 바뀌어야 한다 (#14 에서 함께 고침).
  //   실시간으로 돌아왔는데 "스냅샷 표시 중" 이 남아 있으면 ISSUE-009 와 같은
  //   계열의 거짓말이다 — 화면과 글자가 서로 다른 것을 말한다. 여기 쓰는 문구를
  //   **시뮬 상태로 채우지 않는 이유**는 그 값이 곧 낡기 때문이다. 시뮬의 지금
  //   상태는 `#sim` 이 4/s 로 계속 갱신하므로 상태줄은 "무엇을 보고 있는가" 만
  //   말한다.
  if (!opts.quiet) {
    status(
      mode === 'snapshot'
        ? '스냅샷 표시 중'
        : '실시간 뷰 — 시뮬레이션 결과를 그립니다',
    );
  }
}

/** 스냅샷이 사라져야 할 때. **씬이 바뀌면 이전 씬의 아바타는 거짓이다** */
function dropSnapshot(): void {
  snapshots.clear();
  viewer.setMode('live');
  ui.snapstat.textContent = '';
  paintSnap();
}

function paintSnap(): void {
  const has = snapshots.present;
  ui.snap.disabled = busy || currentScene === null || !client.connected || snapshots.busy;
  ui.snap.textContent = has ? '🧍 다시 찍기' : '🧍 스냅샷';
  ui.mode.hidden = !has;
  ui.mode.disabled = !has;
  ui.mode.textContent = viewer.mode === 'snapshot' ? '↩ 실시간' : '🧍 스냅샷 보기';
}

ui.snap.addEventListener('click', () => {
  void takeSnapshot();
});

ui.mode.addEventListener('click', () => {
  // 스냅샷으로 갈 때만 카메라를 다시 맞춘다 — 경계가 크게 달라지는 방향이다.
  const next = viewer.mode === 'snapshot' ? 'live' : 'snapshot';
  setMode(next, { refit: next === 'snapshot' });
});

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
  ui.snap.disabled = on || currentScene === null || !client.connected || snapshots.busy;
  // 재생 컨트롤 네 개의 활성 조건은 `playback.view` 가 정한다. 여기서 따로
  // 계산하면 조건이 두 곳에 생기고, 둘이 갈라지는 날 버튼이 거짓말을 한다.
  paintPlayback();
  // 로드 중에는 펼침도 잠근다. 토폴로지가 갈리는 도중에 슬라이더를 밀면
  // 이미 버려진 지오메트리를 대상으로 보간하게 된다.
  paintUnfold();
}

async function show(sceneId: string, opts: { refit?: boolean } = {}): Promise<void> {
  if (busy) return;
  // ★ 다른 씬이면 스냅샷을 버린다. 이전 씬의 아바타가 새 씬 위에 남아 있으면
  //   화면만 봐서는 절대 못 알아챈다 — 아바타는 씬이 달라도 거의 같아 보인다.
  //   재연결로 **같은 씬**을 다시 로드하는 경우(refit:false)에는 유지한다.
  if (sceneId !== currentScene) dropSnapshot();
  setBusy(true);
  // ★ ISSUE-009 를 닫는 자리다. 워커의 `load` 는 시뮬 상태를 초기화하고
  //   `maxFrame` 을 -1 로 되돌린다 — **로드가 시작된 순간 "재생 중" 이라는
  //   믿음은 이미 거짓이다.** 성공을 기다렸다가 내리면 103MB 면 1초쯤 되는
  //   그 사이 내내 버튼이 `⏸ 정지` 라고 거짓말을 한다.
  playback.sceneLoading();
  // 로드 중에 프레임이 들이닥치는 것을 막는다. `setTopology()` 가 지오메트리를
  // 통째로 갈아 끼우는 동안 옛 프레임을 적용하면 어긋난 메시를 그린다.
  stream.resume();
  status('씬을 로드하는 중… (103MB 면 1초쯤 걸립니다)');
  try {
    const shown = await showScene(client, viewer, sceneId, {
      // 재연결 후 다시 로드할 때는 사용자가 맞춰 둔 시점을 빼앗지 않는다.
      frameCamera: opts.refit !== false,
      // 가운데 칸의 옷도 같은 디코딩 결과에서 세운다 (L-2a). 따로 받으면
      // 두 칸이 서로 다른 순간의 토폴로지를 들 수 있다.
      mirror: viewer2d.cloth,
    });
    currentScene = sceneId;
    playback.sceneLoaded(sceneId);
    // 새 토폴로지가 섰다. 칸에 남아 있던 옛 프레임을 버리고 정지 상태를 푼다.
    stream.resume();
    // ★ 2D 도면 좌표를 여기서 한 번 만든다 (#15-b). `uvs`·`transform2d` 는
    //   topology 와 함께 한 번만 오므로 프레임마다 다시 만들 이유가 없다 —
    //   정점 3,022~13,398개에 행렬 곱이 붙는 일을 로드당 1회로 묶는다.
    unfolder.build(viewer.cloth.patterns);
    unfoldControl.setScene(true);
    unfoldControl.setStats(unfolder.stats);
    // ★ 가운데 칸 (L-2a). 도면에 **고정**한다 — `t = 1` 을 한 번 쓰고 끝이다.
    //   왼쪽 칸처럼 프레임마다 `sync`/`apply` 를 부르지 않는 이유는 목표 정점이
    //   3D 정점과 무관하기 때문이다(`viewer2d.ts` 머리말).
    unfolder2d.build(viewer2d.cloth.patterns);
    unfolder2d.apply(viewer2d.cloth.patterns, 1);
    paintDraft2d();
    // 오른쪽 칸 (L-3a). 아바타는 씬에 딸려 있으므로 씬이 바뀌면 반드시 다시
    // 읽는다 — 안 읽으면 옛 씬의 체형이 새 아바타의 값인 척한다.
    void refreshAvatarBody();
    // 패턴 크기도 씬에 딸려 있다 (L-3b).
    void refreshSurfaces();
    const u = unfolder.stats;
    log(
      `2D 도면 — 패턴 ${u.placed}/${u.patterns} 배치됨`
      + (u.bounds
        ? ` · ${u.bounds.width.toFixed(1)} × ${u.bounds.height.toFixed(1)}cm`
        : ' · 배치 없음')
      + (u.unplaced > 0 ? ` · ⚠ 배치 없는 패턴 ${u.unplaced}개` : ''),
    );
    ui.stat.textContent = `패턴 ${shown.patterns} · 정점 ${shown.vertices} · 삼각형 ${shown.triangles}`;
    status(`로드 완료 (${shown.elapsedMs}ms)`);
  } catch (err: unknown) {
    playback.sceneLoadFailed();
    // 화면에 무엇이 서 있는지 모르는 상태다. 도면 좌표를 남겨 두면 슬라이더가
    // "펼칠 수 있다" 고 말하면서 옛 씬의 배치로 보간한다.
    unfolder.clear();
    unfoldControl.setStats(null);
    // 가운데 칸도 같이 비운다. 남겨 두면 실패한 로드 뒤에 **옛 씬의 도면**이
    // 그대로 서 있어서, 화면만 보면 로드가 성공한 것처럼 보인다.
    viewer2d.cloth.clear();
    unfolder2d.clear();
    paintDraft2d();
    status(`로드 실패: ${message(err)}`, true);
  } finally {
    setBusy(false);
    paintSnap();
    // 믿음을 사실로 덮어쓴다. 로드 성공/실패 어느 쪽이든 워커가 지금 무엇을
    // 들고 있는지는 물어봐야 안다 — 실패했을 때가 특히 그렇다(요청이 워커에
    // 닿기는 했는지 우리는 모른다).
    await playback.syncFromWorker();
    // ★ **씬마다 파라미터 값이 다르다** (실측: `W_Bra top & Leggings.zls` 의
    //   timeStep 45 vs `sample.zls` 30). 로드했으면 반드시 다시 읽어야 한다 —
    //   안 그러면 이전 씬의 값을 이 씬의 값인 것처럼 보여준다.
    refreshParams();
  }
}

// ── 재생 컨트롤의 배선 (#14) ────────────────────────────────
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
// (`playback.ts` 의 `#subscribed` 주석에 reset·clear 를 지나서도 성립하는
//  근거가 코드 위치와 함께 적혀 있다.)

/**
 * 조작 하나를 실행하고, 실패했으면 **상태줄에 이유를 남긴다.**
 *
 * 컨트롤러는 던지지 않고 `false` + `lastError` 로 실패를 알린다(버튼 핸들러에서
 * 도는 함수라 던지면 삼켜진다). 그 값을 화면 글자로 바꾸는 것이 이 함수의 전부다.
 */
async function act(action: PlaybackCommand): Promise<void> {
  const ok = await RUN[action]();
  paintSnap();
  if (ok) return;
  const err = playback.lastError;
  // 실패가 아니라 "지금은 할 수 없다"(다른 op 왕복 중 등)면 조용히 넘긴다 —
  // 버튼이 이미 잠겨 있으므로 사용자가 볼 이유가 없다.
  if (err) status(`${LABEL[action]} 실패: ${err.message}`, true);
}

/** 화면이 부를 수 있는 조작. 단축키의 것에 `play`/`pause` 를 더한 것이다 */
type PlaybackCommand = ShortcutAction | 'play' | 'pause';

const RUN: Record<PlaybackCommand, () => Promise<boolean>> = {
  toggle: () => playback.toggle(),
  play: () => playback.play(),
  pause: () => playback.pause(),
  reset: () => playback.reset(),
  clear: () => playback.clear(),
  step: () => playback.step(),
};

const LABEL: Record<PlaybackCommand, string> = {
  toggle: '재생/정지',
  play: '재생',
  pause: '정지',
  reset: '리셋',
  clear: '씬 내림',
  step: '스텝',
};

/**
 * 재생을 누르면 **실시간으로 돌아온다.** (`PlaybackHooks.beforePlay`)
 *
 * 스냅샷은 정지 화면이라, 스냅샷을 보는 채로 시뮬을 켜면 "재생을 눌렀는데
 * 아무것도 안 움직인다" 가 된다. 원인이 화면 어디에도 안 남는 실패다.
 * 스냅샷 자체는 버리지 않으므로 `#mode` 버튼으로 언제든 다시 볼 수 있다.
 */
function returnToLiveForPlayback(): void {
  if (viewer.mode !== 'snapshot') return;
  log('재생 — 스냅샷은 정지 화면이라 실시간 뷰로 돌아갑니다 (스냅샷은 남아 있습니다)');
  setMode('live');
}

ui.play.addEventListener('click', () => void act('toggle'));
ui.reset.addEventListener('click', () => void act('reset'));
ui.clear.addEventListener('click', () => void act('clear'));

// ── 키보드 (#60~#63) ────────────────────────────────────────
//
// 어떤 키가 어떤 조작인지는 `panels/shortcuts.ts` 가 정한다 (수식키·입력
// 포커스·IME·반복 입력을 거르는 근거가 거기 있다). 여기 있는 것은 이벤트를
// 듣고 넘기는 것뿐이다.
//
// `preventDefault()` 는 **우리가 처리한 키에만** 건다. SPACE 는 브라우저에서
// 스크롤이고 포커스된 버튼의 재클릭이라, 안 막으면 한 번 누른 것이 두 가지
// 동작이 된다.
window.addEventListener('keydown', (ev: KeyboardEvent) => {
  const target = ev.target instanceof HTMLElement ? ev.target : null;
  const action = shortcutFor(ev, target);
  if (!action) return;
  ev.preventDefault();
  void act(action);
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
//
// #14 가 여기 더한 것은 `playback` 하나다. `playback.view` 가 화면이 무엇을
// 말하고 있어야 하는지의 정본이고, `playback.stats` 는 어긋남의 계측기다:
// `corrections` 가 0 이 아니면 우리 믿음이 워커와 갈라진 적이 있다는 뜻이고
// (ISSUE-009 의 그 갈라짐이다), `negativeFrames` 는 워커의 `status.frame` 이
// 음수로 온 횟수다 — 화면에는 안 쓰지만 세어 둔다.
declare global {
  // eslint-disable-next-line no-var
  var cobalt: {
    client: GatewayClient;
    viewer: Viewer3D;
    /**
     * L-2a 의 진단 표면 — 가운데 칸(재단 도면).
     *
     * `viewer2d.bounds` 가 null 이면 도면이 없는 상태이고(칸에 안내 글자가
     * 떠 있어야 한다), `viewer2d.renders` 가 안 오르면 **왼쪽 칸이 아니라
     * 이쪽 렌더 루프가 멎은 것**이다. 두 칸이 렌더러를 따로 쓰므로 한쪽만
     * 멎을 수 있고, 그 구분이 여기서만 난다.
     *
     * `unfolder2d` 는 왼쪽 칸의 `unfolder` 와 **다른 객체다** — 목표 정점이
     * 메시 로컬 좌표라 어느 옷의 것인지에 의존한다.
     */
    /** L-3 의 진단 표면 — 오른쪽 칸. `avatarBody.view` / `surfaceSize.view` 가
     *  화면이 무엇을 말하고 있어야 하는지의 정본이다 */
    avatarBody: AvatarBodyPanel;
    surfaceSize: SurfaceSizePanel;
    viewer2d: Viewer2D;
    unfolder2d: Unfolder;
    stream: FrameStream;
    snapshots: SnapshotLoader<ParsedSnapshot>;
    playback: PlaybackController;
    /**
     * #16 의 진단 표면. `params.phase` 가 'ready' 가 아니면 화면의 값은
     * **자리채움이다**(워커의 값이 아니다). `params.workerValues` 가 워커가
     * 마지막으로 말한 사실이고, `params.dirty` 가 아직 안 보낸 변경 수다.
     */
    params: ParamsPanel;
    /**
     * #15-b 의 진단 표면. `unfolder.stats.placed` 가 0 이면 워커가 `transform2d`
     * 를 안 실은 것이고(그때 화면의 슬라이더도 비활성이다), `unplaced` 가 0 이
     * 아니면 그 수만큼의 패턴이 t=1 에서도 3D 자리에 남는다.
     * `unfoldControl.effectiveT` 가 **화면에 실제로 반영된 값**이다 —
     * 슬라이더의 `value` 와 갈라질 수 있다(씬이 없으면 항상 0).
     */
    unfolder: Unfolder;
    unfoldControl: UnfoldController;
    show: typeof show;
    play: (on: boolean) => Promise<boolean>;
    snap: typeof takeSnapshot;
    mode: typeof setMode;
    get frames(): number;
    get stats(): FrameStreamStats;
    get snapStats(): SnapshotLoaderStats;
    get playbackView(): PlaybackView;
  };
}
globalThis.cobalt = {
  client,
  viewer,
  avatarBody,
  surfaceSize,
  viewer2d,
  unfolder2d,
  stream,
  snapshots,
  playback,
  params,
  unfolder,
  unfoldControl,
  show,
  play: (on: boolean) => (on ? playback.play() : playback.pause()),
  snap: takeSnapshot,
  mode: setMode,
  get frames(): number {
    return stream.stats.received;
  },
  get stats(): FrameStreamStats {
    return stream.stats;
  },
  get playbackView(): PlaybackView {
    return playback.view;
  },
  // 스냅샷이 안 보일 때의 진단 표면: `phase` 가 'ready' 인데 화면이 비었으면
  // 모드(`cobalt.viewer.mode`)나 카메라이고, 'error' 면 `lastError` 가 이유다.
  get snapStats(): SnapshotLoaderStats {
    return snapshots.stats;
  },
};
