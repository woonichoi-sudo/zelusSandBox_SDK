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
  AvatarMeasureController,
  AvatarViewController,
  addStats,
  statsOf,
  TextureOptions,
  DrapingPanel,
  SideTabsPanel,
  SideDrawerPanel,
  narrowQuery,
  SurfaceSizePanel,
  PlaybackController,
  shortcutFor,
  shortcutHint,
  viewHint,
  initLang,
  onLangChange,
  t,
  type AvatarCause,
  type MessageVars,
  type AvatarMeasureView,
  type AvatarViewState,
  type DrapingView,
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
  type TextureAsset,
  type SceneSummary,
} from './protocol/index.ts';
import {
  applyStaticText,
  AvatarMeasurePanel,
  AvatarPanel,
  AvatarViewSwitch,
  Design2DOptions,
  LangSwitch,
  ParamsPanel,
  SideTabs,
  SideDrawer,
  SurfacePanel,
  TextureSwitch,
} from './ui/index.ts';
import { Unfolder, UnfoldController, Viewer2D } from './viewer2d/index.ts';
import {
  fetchTopology,
  FrameStream,
  installTopology,
  showScene,
  SnapshotLoader,
  SnapshotStaleError,
  Viewer3D,
  type DecodedTopology,
  type FrameStreamStats,
  type ParsedSnapshot,
  type SnapshotLoaderStats,
} from './viewer3d/index.ts';

// ── 언어 (I-1) ──────────────────────────────────────────────
//
// ★ **무엇보다 먼저 부른다.** 아래 위젯들이 생성자에서 `t()` 를 읽으므로,
//   저장된 언어를 여기서 정해 두지 않으면 화면이 한국어로 한 번 서고 나서
//   영어로 덜컥 바뀐다. `localStorage` 가 없거나 던져도(사생활 모드) 조용히
//   한국어로 떨어진다 — 이 한 줄 때문에 화면이 죽지 않는다.
initLang();

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
  // 재단 도면의 표시 스위치가 그려질 자리 (D2-e)
  draft2dOpts: el<HTMLElement>('draft2dOpts'),
  // 실시간 뷰의 아바타 스위치가 그려질 자리 (AM-1)
  view3dOpts: el<HTMLElement>('view3dOpts'),
  scene: el<HTMLSelectElement>('scene'),
  load: el<HTMLButtonElement>('load'),
  file: el<HTMLInputElement>('file'),
  // 감춘 입력 대신 고른 파일 이름을 보여주는 자리 (I-1). 네이티브 표시를
  // 없앤 대가라 이것이 없으면 무엇을 골랐는지 알 수 없다.
  fileName: el<HTMLElement>('fileName'),
  upload: el<HTMLButtonElement>('upload'),
  play: el<HTMLButtonElement>('play'),
  // ⛔ `#step` 은 없다 — 워커의 step op 이 no-op 이라 화면에 올리지 않았다
  //    (`index.html` 의 주석에 실측이 있다).
  reset: el<HTMLButtonElement>('reset'),
  clear: el<HTMLButtonElement>('clear'),
  // 저장된 드레이프 적용 (W-1). 사유·결과는 툴팁이 아니라 `#drapestat` 글자다
  drape: el<HTMLButtonElement>('drape'),
  drapestat: el<HTMLElement>('drapestat'),
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
  // 아바타 탭 안의 두 자리. 위가 체형 슬라이더 29개 (L-3a), 아래가 치수
  // 25개 (W-2). **둘 다 `#avatarPanel` 안쪽이어야 한다** — 탭 가시성이 그
  // 상자에만 걸린다(index.html 의 주석 참고).
  avatarShape: el<HTMLElement>('avatarShape'),
  avatarMeasure: el<HTMLElement>('avatarMeasure'),
  // 옷 사이즈 패널 (L-3b). 같은 칸의 두 번째 탭이다
  surfacePanel: el<HTMLElement>('surfacePanel'),
  // 오른쪽 칸의 탭 바 (L-3c). 버튼은 `ui/sideTabs.ts` 가 만든다
  sideTabs: el<HTMLElement>('sideTabs'),
  // 탭 전환 시 위치를 기억·복원할 스크롤 상자
  sideScroll: el<HTMLElement>('sideScroll'),
  // 좁은 창에서 서랍이 될 칸 자체. 그 안의 탭·패널은 그대로 굴러간다
  sidePanel: el<HTMLElement>('sidePanel'),
  // 여닫기 버튼이 들어갈 상단 바
  bar: el<HTMLElement>('bar'),
  // 2D 펼침 (#15-b). 슬라이더 하나와 글자 두 자리 — 판단은 `viewer2d/` 다.
  unfold: el<HTMLInputElement>('unfold'),
  unfoldStat: el<HTMLElement>('unfoldStat'),
  unfoldWhy: el<HTMLElement>('unfoldWhy'),
};

/** 3D 칸 왼쪽 위 한 줄. 조작 설명과 단축키가 **한 언어**로 붙는다 (I-1) */
function paintHint(): void {
  ui.hint.textContent = `${viewHint()}  |  ${shortcutHint()}`;
}

const LOG_LIMIT = 300;
const lines: string[] = [];

/**
 * 로그 한 줄.
 *
 * ⛔ **로그 문구는 번역 범위 밖이다** (I-1, 사용자가 좁혔다: "로그는 안해도 돼
 *    사용자가 보는 ui만"). 이 함수에 들어오는 문자열은 한국어 그대로다 —
 *    접힌 `#logWrap` 안에만 쌓이기 때문이다. 예외는 `status()` 가 남기는
 *    메아리인데, 그쪽은 본적이 상태줄이라 이미 번역돼 들어온다.
 */
function log(line: string): void {
  lines.push(`${new Date().toLocaleTimeString('ko-KR')}  ${line}`);
  if (lines.length > LOG_LIMIT) lines.splice(0, lines.length - LOG_LIMIT);
  ui.log.textContent = lines.join('\n');
  ui.log.scrollTop = ui.log.scrollHeight;
}

/**
 * ── 지난 문장을 **값이 아니라 다시 만드는 법으로** 기억한다 (I-1) ──
 *
 * 상태줄·메시 통계·스냅샷 요약은 한 번 찍히면 다음 조작까지 화면에 남는다.
 * 그동안 언어를 바꾸면 그 세 자리만 옛 언어로 굳는다 — 다시 그릴 근거(키와
 * 값)를 우리가 안 들고 있기 때문이다. 그래서 **찍는 함수 자체**를 슬롯에
 * 넣어 두고, 언어가 바뀌면 그대로 한 번 더 부른다.
 *
 * 값을 저장하지 않는 이유: 값(패턴 24개, 4.3초…)과 키가 짝을 이뤄야 문장이
 * 되는데, 그 짝을 따로 들고 다니면 한쪽만 갱신되는 날이 온다.
 */
type TextSlot = 'status' | 'stat' | 'snapstat' | 'filename';
const slotPainters = new Map<TextSlot, () => void>();

function say(slot: TextSlot, paint: (() => void) | null): void {
  if (paint === null) {
    slotPainters.delete(slot);
    return;
  }
  slotPainters.set(slot, paint);
  paint();
}

/**
 * 상태줄에 이미 번역된 글자를 찍는다. **패널이 훅으로 부르는 문**이라
 * 서명을 바꾸지 않는다(`ParamsPanelHooks.status` 등).
 *
 * ⚠️ 이 문으로 들어온 글자는 **언어를 바꿔도 다시 그려지지 않는다** — 무슨
 *    키였는지 모르기 때문이다. 그래서 슬롯을 비운다(옛 문장을 다시 찍는 것이
 *    더 나쁘다). 키를 아는 자리는 아래 `statusT` 를 쓴다.
 */
function status(text: string, isError = false): void {
  say('status', null);
  ui.status.removeAttribute('data-i18n');
  ui.status.textContent = text;
  ui.status.classList.toggle('err', isError);
  log(isError ? `⚠ ${text}` : text);
}

/** 사전 키로 상태줄을 찍는다. 언어를 바꾸면 이 문장이 그대로 따라온다 */
function statusT(key: string, vars?: MessageVars, isError = false): void {
  say('status', () => {
    // 기동 직후의 자리채움(`data-i18n="bar.status.booting"`)을 뗀다. 안 떼면
    // 언어를 바꿀 때 `applyStaticText()` 가 "시작하는 중…" 으로 되돌린다.
    ui.status.removeAttribute('data-i18n');
    ui.status.textContent = t(key, vars);
    ui.status.classList.toggle('err', isError);
  });
  const text = t(key, vars);
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
  // 지난 세션의 드레이프 결과는 이 워커의 것이 아니다 (W-1).
  draping.reset();
  // 치수도 같다 (W-2). 특히 **"이 아바타는 치수 변형을 지원하지 않는다" 는
  // 기억을 지워야 한다** — 새 워커에는 아직 씬조차 없다.
  avatarMeasure.reset();
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
  statusT(willReconnect ? 'status.closed.retry' : 'status.closed', { code }, true);
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

/**
 * 화면을 다시 세운 결과 셋 (`restageTopology`).
 *
 * `superseded` 를 `failed` 와 **가른 것이 요점이다** — 더 새로운 재구성에
 * 자리를 내준 것은 정상 동작이고, 실패로 취급해 로그를 찍으면 없는 고장이
 * 화면에 뜬다.
 */
type RestageOutcome = 'staged' | 'superseded' | 'failed';

/**
 * 마지막으로 **시작한** 재구성의 번호. 늦게 온 응답을 버리는 유일한 장치다.
 *
 * ★ **"마지막에 시작한 것이 마지막에 도착한다" 는 거짓이다.** A 가 먼저
 *   시작하고 B 가 뒤에 시작해도 A 의 `meshData` 왕복이 더 오래 걸리면 A 가
 *   마지막에 화면을 세운다. 그러면 **옛 지오메트리가 서고 다시 고칠 계기가
 *   없다** — 재생 중이 아니면 `onMismatch` 조차 안 오기 때문이다. 낭비가
 *   아니라 결함이라 검사가 필요하다.
 *
 * `restageTopology` 만 올리는 것이 아니다. 씬을 통째로 갈아 끼우는
 * `show()`·`clearScene()` 도 올린다 — 그쪽이 더 새로운 진실이기 때문이다.
 */
let restageSeq = 0;

const stream = new FrameStream({
  // frame 이벤트의 mesh 에는 indices·uvs 가 없어서 스트림 혼자서는 토폴로지를
  // 다시 세울 수 없다. `meshData(true)` 를 다시 받는 것이 복구이고, 그건
  // 프로토콜을 아는 이쪽의 일이다.
  //
  // ★ **씬을 다시 열지 않는다** (L-3d). 예전에는 여기가 `show()` 였는데 그
  //   안의 `client.load()` 가 `.zls` 를 디스크에서 다시 열어, 어긋남의 원인이
  //   된 워커 쪽 편집(옷 사이즈 등)을 통째로 되돌렸다 — 실측 2/2 재현.
  //   `restageTopology` 는 `load` 없이 `meshData(true)` 부터 한다.
  onMismatch: ({ frame, incoming, current }) => {
    log(`프레임 ${frame} 의 토폴로지가 화면과 다릅니다 (패턴 ${incoming} vs ${current})`);
    if (!currentScene) return;
    if (topologyRecoveries >= MAX_TOPOLOGY_RECOVERIES) {
      statusT('status.topology.giveUp', undefined, true);
      return;
    }
    topologyRecoveries += 1;
    statusT('status.topology.retry', { n: topologyRecoveries, max: MAX_TOPOLOGY_RECOVERIES });
    void restageTopology('토폴로지 복구');
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
  root: ui.avatarShape,
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

/**
 * 워커의 체형·치수를 다시 읽어 화면에 붓는다. 씬이 없으면 비운다.
 *
 * ★ **왕복 하나로 두 패널을 채운다** (W-2). `avatarBody` 응답이 체형 29개와
 *   치수 25개를 같이 주므로 두 모듈에 같은 응답을 먹인다 — 치수를 따로
 *   읽는 op 을 만들면 로드마다 왕복이 하나 더 늘고, 두 표가 서로 다른
 *   시점의 몸을 가리키는 순간이 생긴다.
 */
async function refreshAvatarBody(): Promise<void> {
  if (!currentScene || !client.connected) {
    avatarBody.clear();
    avatarMeasure.clear();
    avatarPanel.render();
    measurePanel.render();
    return;
  }
  try {
    const res = await client.avatarBody();
    avatarBody.setFromWorker(res);
    // ⚠️ 여기서 낡음이 풀린다 — 방금 읽은 스냅샷이 곧 지금 몸이다.
    avatarMeasure.setFromWorker(res);
  } catch (err: unknown) {
    // 못 읽었으면 **옛 값을 남기지 않는다.** 남기면 화면이 지금 아바타와
    // 무관한 숫자를 "현재 체형" 이라고 말한다.
    avatarBody.clear();
    avatarMeasure.clear();
    log(`아바타 체형을 읽지 못했습니다: ${message(err)}`);
  }
  avatarPanel.render();
  measurePanel.render();
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
    // ★ **이 경로에는 치수 되읽기가 없다** — 셰이퍼가 몸을 바꿨는데
    //   `measurements[*].real` 은 씬 데이터 사본이라 안 움직인다. 그 사실을
    //   치수 패널에 알려 화면이 "이 숫자는 그 전에 잰 값" 이라고 말하게
    //   한다. 이 한 줄이 없으면 화면이 조용히 거짓말을 한다.
    avatarMeasure.noteBodyParamsApplied();
    // ★ 몸이 실제로 다시 만들어졌다 (AM-1). 슬라이더 29개는 정규화 값이라
    //   숫자만 봐서는 몸이 어떻게 변했는지 알 수 없다 — 이 한 줄이 그 결과를
    //   화면에 세운다. `refreshPose` 를 안 쓰는 이유는 **옷은 안 움직이기
    //   때문**이다(셰이퍼는 시뮬을 되돌리지 않는다).
    void avatarView.refresh('체형');
    log(
      `아바타 체형 — 적용 ${res.applied.length}개`
      + (res.unknown.length > 0 ? ` · ⚠ 모르는 키 ${res.unknown.join(', ')}` : ''),
    );
    if (res.unknown.length > 0) {
      // ⛔ `res.unknown` 안의 이름은 엔진의 체형 파라미터 키다 — 번역하지 않는다
      statusT('status.body.unknownKeys', { keys: res.unknown.join(', ') }, true);
    }
  } catch (err: unknown) {
    statusT('status.body.failed', { why: message(err) }, true);
  }
  avatarPanel.render();
  measurePanel.render();
}

// ── 아바타 치수 (W-2) ───────────────────────────────────────
//
// 같은 탭의 아래 칸이고 같은 3층이되, 판단 쪽이 **왕복까지 스스로 한다**
// (`panels/avatarMeasure.ts`) — `draping.ts` 와 같은 계열이다. 이유는 시간이다:
// [적용] 한 번이 10초 넘게 걸리고 그 사이의 "적용 중" 도 상태이므로, 그것을
// main.ts 의 불리언으로 두면 자동 테스트가 원리적으로 못 붙는다(ISSUE-009).
//
// ★ **`frame:-1` 뒤처리를 새로 만들지 않는다.** 이 op 도 엔진 안에서
//   시뮬을 되돌리므로 W-1 의 드레이프와 사정이 정확히 같다 — `refreshPose()`
//   + `playback.syncFromWorker()` 를 그대로 재사용한다.
const avatarMeasure: AvatarMeasureController = new AvatarMeasureController({
  port: client,
  hooks: {
    log,
    onChange: paintMeasure,
    afterApplied: async (res) => {
      // ★ 체형 슬라이더도 같이 갱신한다. `res.avatar` 는 **워커가 다시 읽은**
      //   체형이라, 치수로 몸을 만들면 29개 값이 실제로 어떻게 움직였는지가
      //   그대로 화면에 드러난다(요청값의 메아리가 아니다).
      avatarBody.setFromWorker(res.avatar);
      avatarPanel.render();
      // 아래 둘은 리셋이 하는 것과 똑같다 — 새로 만들지 않는다.
      await refreshPose('치수');
      await playback.syncFromWorker();
    },
  },
});

const measurePanel = new AvatarMeasurePanel({
  root: ui.avatarMeasure,
  panel: avatarMeasure,
  onEdit: (key, value) => {
    avatarMeasure.edit(key, value);
    // `edit` 이 이미 onChange 를 낸다. 여기서 또 그리면 타이핑 중인 칸을
    // 두 번 훑는다 — 배선은 알리기만 한다.
  },
  onApply: () => void applyAvatarMeasurements(),
  onRevert: () => avatarMeasure.revert(),
});

/**
 * 치수를 적용한다. **바뀐 것만 나간다** (판단은 컨트롤러가 한다).
 *
 * ⚠️ 여기서 하는 유일한 판단은 **화면 전체를 잠그는 것**이다. 이 op 이 도는
 *    동안 워커는 stdin 을 순차 처리하느라 다른 요청에 답하지 못한다 — 재생·
 *    리셋·로드 버튼이 살아 있으면 누른 뒤 15초를 아무 반응 없이 기다리게
 *    된다. `setBusy` 는 로드가 이미 쓰는 장치라 새로 만들 것이 없다.
 */
async function applyAvatarMeasurements(): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    await avatarMeasure.apply();
  } finally {
    setBusy(false);
  }
  measurePanel.render();
}

/** 표 하나와 글자 한 줄. **상태는 만들지 않는다 — 받은 것만 그린다** */
function paintMeasure(view: AvatarMeasureView = avatarMeasure.view): void {
  measurePanel.render(view);
}

// ── 실시간 뷰의 아바타 (AM-1) ───────────────────────────────
//
// 여기 있는 것도 배선뿐이다. **언제 다시 받을지는 `panels/avatarView.ts`**
// (DOM 없음 → Node 테스트가 붙는 자리), **그리는 것은 `viewer3d/avatar.ts`**,
// 체크박스는 `ui/avatarViewSwitch.ts` 다.
//
// ★ **새 갱신 경로를 만들지 않는다.** 몸이 바뀌는 시점은 옷의 포즈가 바뀌는
//   시점과 같아서(로드 · 체형 · 치수 · 드레이프 · 리셋), 이미 있는
//   `refreshPose()` 와 `applyAvatarBody()` 자리에 한 줄씩 끼우는 것이 전부다.
//   유일하게 새로 생긴 것이 **재생 중 폴링**이고, 그것도 rAF 에 `tick` 한 줄이다.
//
// `client` 를 어댑터 없이 넘길 수 있는 이유는 `PlaybackPort` 와 같다 —
// `AvatarViewPort` 가 구조적 타입이라 `GatewayClient` 가 이미 만족하고,
// `viewer.avatar`(AvatarObject)가 `AvatarViewSink` 를 이미 만족한다.
const avatarView = new AvatarViewController({
  port: client,
  sink: viewer.avatar,
  hooks: {
    log,
    onChange: (view) => paintAvatarViewAndTextures(view),
    now: () => performance.now(),
  },
});

/**
 * 아바타 상태가 바뀌면 텍스처 통계도 다시 센다 (materials-c).
 *
 * 여기 두는 이유: `refresh()` 를 부르는 자리가 여섯 곳(로드·체형·치수·드레이프·
 * 리셋·폴링)이라, 그 자리마다 한 줄씩 넣으면 언젠가 하나를 빠뜨린다. 상태
 * 변화를 한 곳에서 받는 편이 낫다 — 세는 것이 표 10칸이라 공짜다.
 */
function paintAvatarViewAndTextures(view: AvatarViewState): void {
  paintAvatarView(view);
  syncTextureStats();
}

const avatarSwitch = new AvatarViewSwitch({
  root: ui.view3dOpts,
  port: avatarView,
});

/** 체크박스 하나와 글자 한 줄. **상태는 만들지 않는다 — 받은 것만 그린다** */
function paintAvatarView(view: AvatarViewState = avatarView.view): void {
  avatarSwitch.render(view);
}

// ── 실시간 뷰의 텍스처 (materials-c) ────────────────────────
//
// 여기 있는 것도 배선뿐이다. 반복 배수·슬롯 해석은 `panels/textures.ts`,
// 실제로 받아 거는 것은 `viewer3d/textures.ts`, 체크박스는
// `ui/textureSwitch.ts` 다.
//
// ★ **표는 두 곳에서 온다** — 옷은 `showScene`(meshData topology:true), 아바타는
//   `avatarView`(avatarMesh topology:true). 둘은 **별개의 왕복**이라 도착 시점이
//   다르고, 어느 쪽이 늦게 와도 화면 글자가 맞아야 한다. 그래서 각자 도착할 때
//   `syncTextureStats()` 를 부르고 그 함수가 둘을 **합쳐서** 다시 센다.
/** 마지막으로 화면에 반영한 켜짐 상태. 통계만 바뀐 갱신에 재질을 안 건드린다 */
let texturesApplied = true;

const textureOptions = new TextureOptions({
  log,
  onChange: (state) => {
    textureSwitch.render(state);
    // ⚠️ `setStats` 로도 이 콜백이 온다. 그때마다 재질을 다시 만지면 셰이더가
    //    괜히 재컴파일된다 — 바뀐 것이 켜짐/꺼짐일 때만 화면을 건드린다.
    if (state.enabled !== texturesApplied) {
      texturesApplied = state.enabled;
      applyTextures();
    }
  },
});

const textureSwitch = new TextureSwitch({
  root: ui.view3dOpts,
  port: textureOptions,
});

/** 옷 쪽 표. 아바타 것은 `avatarView.textures` 가 정본이라 사본을 두지 않는다 */
let clothTextures: readonly (TextureAsset | null)[] = [];

/**
 * 두 표를 합쳐 화면 글자를 갱신한다.
 *
 * ⚠️ 사본을 하나로 합쳐서 들고 있으면 안 된다 — 옷과 아바타의 색인 공간이
 *    **다르기 때문이다**(각 응답이 자기 표를 0번부터 센다). 합치는 것은
 *    사람이 읽는 숫자뿐이고, 그리는 쪽은 각자 자기 표를 쓴다.
 */
function syncTextureStats(): void {
  textureOptions.setStats(addStats(statsOf(clothTextures), statsOf(avatarView.textures)));
}

/**
 * 스위치가 바뀌었다. **왕복이 없다** — 이미 받아 둔 것을 걸었다 뗀다.
 *
 * 로드 때 다시 부를 필요가 없다: 두 객체가 켜짐 상태를 **자기 안에** 들고 있어서
 * (`applyTextures` 가 세운 값), 다음 `setTopology` 가 그대로 따라간다.
 */
function applyTextures(): void {
  const on = textureOptions.enabled;
  viewer.cloth.applyTextures(on);
  viewer.avatar.applyTextures(on);
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
 * 재단 도면의 디자인 정보를 읽어 가운데 칸에 세운다 (D2-c).
 *
 * ★ **좌표를 다시 변환하지 않는다.** 워커가 `atWorld` 로 배치를 끝낸 값을
 *   준다 — 같은 칸의 옷 메시는 `unfolder2d` 가 `transform2d` 를 곱해 세우지만
 *   이쪽에 또 곱하면 두 번 적용된다. 그 증상은 "패턴이 좀 흩어져 보인다" 라서
 *   원인을 못 찾는다.
 *
 * 화각(`fit`)은 **손대지 않는다.** 도면 범위는 이미 `unfolder2d` 가 옷 메시의
 * 점에서 정했고, 커브는 그 안에 있다. 여기서 다시 맞추면 사용자가 맞춰 둔
 * 확대가 로드마다 튄다.
 *
 * @param stillWanted 왕복이 돌아온 **뒤에** 물어보는 것. `false` 면 화면을
 *   한 곳도 만지지 않고 조용히 빠진다. 이 왕복도 `meshData` 와 똑같이 늦게
 *   도착할 수 있어서, 겹쳤을 때 **새 도면 위에 옛 봉제선**이 그려지는 것을
 *   막는 유일한 장치다 (`restageTopology` 의 순번을 그대로 물려받는다).
 *   기본값은 "항상 원한다" — 로드 경로(`show()`)는 `busy` 로 이미 겹치지 않는다.
 */
async function refreshDesign2d(stillWanted: () => boolean = () => true): Promise<void> {
  if (!currentScene || !client.connected) {
    viewer2d.design.clear();
    return;
  }
  try {
    const design = await client.design2d();
    if (!stillWanted()) return;
    viewer2d.design.build(design);
    const v = viewer2d.design.view;
    log(
      `2D 디자인 — 커브 ${v.curves} · 제어점 ${v.vertices} · 봉제선 ${v.seams}`
      + ` (대응선 ${v.links}) · 스티치 ${v.stitches}`,
    );
  } catch (err: unknown) {
    // 실패도 늦게 도착하면 버린다 — 지나간 왕복의 실패로 방금 선 커브를
    // 지우면, 화면만 보고는 무엇이 실패했는지 알 길이 없다.
    if (!stillWanted()) return;
    // 옛 씬의 커브를 남기지 않는다. 남기면 새 패턴 위에 옛 봉제선이 겹쳐서,
    // 화면만 보면 "도면이 이상하게 그려졌다" 로 보인다.
    viewer2d.design.clear();
    log(`2D 디자인 정보를 읽지 못했습니다: ${message(err)}`);
  }
}

/**
 * 행 하나를 보낸다.
 *
 * ★ 응답이 **바꾼 뒤의 전체 목록**이라 그대로 부으면 된다. 엔진이 값을
 *   조정했으면(실측: 폭을 +30% 하면 높이가 0.03% 흔들린다) 그 사실이 화면에
 *   그대로 드러난다 — 요청값을 화면에 남기면 그 조정이 가려진다.
 *
 * ★ **성공하면 화면을 다시 세운다** (L-3d). 이게 없으면 워커는 정확히 바뀐
 *   값을 주는데 화면 셋(3D 옷 · 2D 흰 천 · 2D 도면 커브)이 전부 옛것이다 —
 *   실측: 적용 전후로 정점 해시가 비트 단위로 같았다. "숫자만 바뀌고 그림은
 *   안 바뀐다" 는 원인이 화면 어디에도 안 남는 실패다.
 *   도면 커브까지 `restageTopology` 가 맡는다 — 여기서 따로 부르면 왕복이
 *   겹치고, 어느 쪽 응답이 마지막인지 다시 알 수 없게 된다.
 */
async function applySurfaceSize(uuid: string): Promise<void> {
  const size = surfaceSize.payload(uuid);
  if (!size) return;
  let applied = false;
  try {
    const res = await client.setSurfaceSize(uuid, size);
    surfaceSize.setFromWorker(res.surfaces);
    const now = res.surfaces.find((s) => s.uuid === uuid);
    log(
      `옷 사이즈 — ${now?.name ?? uuid}`
      + (now ? ` → ${now.width.toFixed(2)} × ${now.height.toFixed(2)}cm` : ''),
    );
    applied = true;
  } catch (err: unknown) {
    statusT('status.surface.failed', { why: message(err) }, true);
  }
  // 값을 먼저 그린다. 아래 왕복이 도는 동안에도 패널의 숫자는 새것이어야 한다.
  surfacePanel.render();
  // 실패했으면 화면을 건드리지 않는다 — 옷은 안 바뀌었으므로 다시 세울 것이 없다.
  if (!applied) return;
  // 옷 메시와 도면 커브. **씬을 다시 열지 않는다** — 열면 방금 보낸 편집이
  // 사라진다. 커브는 `restageTopology` 가 자기 순번과 함께 부른다.
  await restageTopology('옷 사이즈');
}

// ── 재단 도면의 표시 스위치 (D2-e) ──────────────────────────
//
// 껍데기만이다. 갈래 목록도 켜짐/꺼짐도 `viewer2d/design.ts` 가 들고 있고,
// 여기서는 위젯을 그 레이어에 물리기만 한다.
//
// ★ 참조를 남기지 않는다 — 클릭 → `setLayerVisible()` → 다시 그리기가 닫힌
//   고리라 바깥에서 부를 일이 없다(`SideTabs` 와 같은 판단이다). 씬이 바뀌어도
//   `build()` 끝에서 레이어가 스스로 꺼짐 상태를 다시 입힌다.
// ★ 참조를 **하나만** 남긴다 — 언어 전환 때 체크박스 여섯 개의 글자를 다시
//   써야 해서다 (I-1). 그 외에는 여전히 스스로 굴러간다.
const design2dOptions = new Design2DOptions({
  root: ui.draft2dOpts,
  layer: viewer2d.design,
  onChange: (key, on) => log(`2D 도면 — ${key} ${on ? '표시' : '숨김'}`),
});

// ── 오른쪽 칸의 탭 (L-3c) ───────────────────────────────────
//
// 껍데기만이다. 두 패널의 내용은 위 배선이 그대로 그리고, 이 아래는 **어느
// 상자가 보이는지**만 정한다.
//
// ★ 갱신을 탭에 매달지 않는다. `refreshAvatarBody()`·`refreshSurfaces()` 는
//   탭과 무관하게 씬마다 둘 다 돈다 — 숨은 탭을 안 그리면 "탭을 한 번 눌러야
//   값이 맞는" 화면이 되고, 그건 화면이 잠깐 거짓말을 하는 상태다. 왕복이
//   로드당 두 번뿐이라 아낄 값어치가 없다.
// 탭 위젯은 스스로 굴러간다 — 클릭 → `SideTabsPanel.select()` → 가시성이
// 닫힌 고리라 바깥에서 부를 일이 없었다.
// ★ 그런데도 참조를 남기는 이유는 `Design2DOptions` 와 같다 — 탭 이름이
//   언어를 따라와야 한다 (I-1).
const sideTabs = new SideTabs({
  root: ui.sideTabs,
  scroll: ui.sideScroll,
  panel: new SideTabsPanel(),
});

// ── 좁은 창에서는 그 칸이 서랍이 된다 ───────────────────────
//
// 여기 있는 것은 **`matchMedia` 를 위젯에 잇는 배선 세 줄**이다. 문턱은
// `panels/sideDrawer.ts` 의 `NARROW_MAX_PX` 가 정본이고 CSS 에는 미디어
// 쿼리가 없다 — 숫자를 두 곳에 두면 한쪽만 고치는 날 화면이 어긋난다.
//
// ⓘ 뷰포트 크기 갱신을 안 매단다. 두 뷰어가 `ResizeObserver` 로 자기 칸을
//   보고 있어서 격자가 2열로 바뀌면 알아서 따라온다.
// ★ `drawer` 만 블록 밖으로 나왔다 — 버튼 글자와 툴팁이 언어를 따라와야
//   한다 (I-1). 나머지(`mq`·`sync`)는 그대로 이 블록 안이다.
const drawer = new SideDrawer({
  body: document.body,
  panel: ui.sidePanel,
  bar: ui.bar,
  state: new SideDrawerPanel(),
  onChange: (open) => log(`설정 칸 ${open ? '펼침' : '접음'}`),
});

{
  const mq = window.matchMedia(narrowQuery());
  const sync = (): void => drawer.setNarrow(mq.matches);

  // ★ 지금 상태를 **먼저 한 번** 반영한다. 리스너만 걸면 좁은 창으로 새로
  //   연 사용자는 창을 한 번 흔들기 전까지 3분할이 찌그러진 화면을 본다.
  sync();
  mq.addEventListener('change', sync);
  // ⚠️ **`matchMedia` 의 change 만 믿지 않는다.** 실측 — 브라우저 창을 도구로
  //    800px 로 줄였을 때 `mq.matches` 는 `true` 가 됐는데 `change` 는 오지
  //    않았다(뷰포트를 에뮬레이션으로 바꾸는 경로). 안 오면 칸이 찌그러진 채
  //    그대로라 화면만 봐서는 원인을 읽을 수 없다.
  //    `setNarrow` 는 바뀔 때만 다시 그리므로(안 바뀌면 불리언 비교 하나)
  //    resize 마다 불러도 값이 싸다.
  window.addEventListener('resize', sync);
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

// ── 저장된 드레이프 (W-1) ───────────────────────────────────
//
// 판단은 `panels/draping.ts`(DOM 없음), 배선만 여기다 — 재생 컨트롤과 같은 3층이다.
//
// ★ **`reset` 과 같은 자리의 op 이다.** 워커의 `LoadDrapingItem` 이 안에서
//   `ztSimulationManager::Reset()` 을 부르므로 성공하면 프레임 카운터가 -1 로
//   되돌아간다. 그래서 뒤처리를 **새로 만들지 않고 리셋의 것을 그대로 쓴다** —
//   `refreshPose()`(화면의 포즈)와 `playback.syncFromWorker()`(재생 상태·프레임
//   번호) 둘이고, 이는 `PlaybackHooks.afterReset` + `#run` 이 하는 일과 같다.
// 타입을 손으로 적는다. `paintDraping` 의 기본 인자가 이 상수를 다시 보므로
// (hooks.onChange → paintDraping → draping.view) 추론이 자기 자신을 물어 TS7022 가 된다.
const draping: DrapingPanel = new DrapingPanel({
  port: client,
  hooks: {
    log,
    onChange: paintDraping,
    afterApplied: async () => {
      // 옷의 포즈가 바뀌었다. 시뮬이 멈춰 있으면 frame 이벤트가 한 건도 안
      // 오므로(워커는 maxFrame 이 바뀔 때만 낸다) 여기서 안 받으면 **화면은
      // 펼쳐진 옷 그대로**다 — 리셋과 정확히 같은 계열의 거짓말이다.
      await refreshPose('드레이프');
      // 프레임 카운터가 -1 이 됐고 시뮬 모드도 달라졌을 수 있다. 믿음이 아니라
      // 워커의 사실로 덮어쓴다.
      await playback.syncFromWorker();
    },
  },
});

/** 버튼 하나와 글자 한 줄. **상태는 만들지 않는다 — 받은 것만 그린다** */
function paintDraping(view: DrapingView = draping.view): void {
  ui.drape.disabled = busy || !view.canApply;
  ui.drapestat.textContent = view.text;
  ui.drapestat.classList.toggle('err', view.isError);
}

ui.drape.addEventListener('click', () => void draping.apply());

// 연결 전에도 이유가 보여야 한다 — 빈 자리에는 "왜 못 누르는지" 가 없다.
paintDraping();

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
 *
 * ★ 드레이프 적용(W-1)도 **같은 이유로 같은 것을 부른다.** 엔진이 안에서
 *   `Reset()` 하므로 사정이 정확히 같다 — 그래서 로그 문구만 갈라 두고 구현은
 *   하나로 둔다(두 벌이 되면 한쪽만 고쳐지는 날이 온다).
 */
async function refreshPose(cause: AvatarCause = '리셋'): Promise<void> {
  if (!currentScene || !client.connected) return;
  // ★ **몸도 같이 온다** (AM-1). 이 함수를 부르는 세 자리(리셋 · 드레이프 ·
  //   치수)가 전부 아바타를 움직인다 — 드레이프는 팔이 내려오고(실측: x 범위
  //   ±61.3 → ±29.9cm), 치수는 정점 28,564개가 100% 이동하고, 리셋은
  //   애니메이션을 처음으로 되돌린다. 안 받으면 **옷만 새 자세이고 몸은 옛
  //   자세**라, 화면에서는 좌표계가 틀렸을 때와 구분되지 않는다.
  //
  //   옷보다 **먼저** 보낸다. 워커는 stdin 을 순차 처리하므로 순서가 곧 화면에
  //   반영되는 순서인데, 몸이 뒤면 옷이 새 자세로 튄 다음 몸이 따라오는 것이
  //   눈에 보인다. `topology` 판단은 컨트롤러가 한다 — 여기서 정하지 않는다.
  await avatarView.refresh(cause);
  // 칸에 남아 있는 옛 런의 프레임을 먼저 버린다. 안 그러면 방금 받은 리셋
  // 포즈를 다음 rAF 가 드레이프된 프레임으로 덮어쓴다.
  stream.resume();
  const patterns = decodePatterns(await client.meshData(false));
  if (!viewer.cloth.updatePositions(patterns)) {
    log(`${cause} 후 포즈가 화면의 토폴로지와 다릅니다 — 씬을 다시 로드하세요`);
    return;
  }
  // 정점 버퍼가 방금 3D 로 덮였다. 펼침의 원본도 같이 갱신해야 한다 —
  // 안 하면 t>0 인 채로 리셋했을 때 화면이 리셋 전 포즈에 멎는다
  // (`sync` 가 다시 쓰라고 표시까지 해 준다).
  unfolder.sync(viewer.cloth.patterns);
  log(`${cause} — 포즈를 다시 받아 화면에 반영했습니다 (패턴 ${patterns.length})`);
}

/**
 * `clear` 뒤에 화면을 비운다. **씬이 워커에서 내려갔으므로 화면에 남은 옷은
 * 이미 아무것도 가리키지 않는다.**
 *
 * 잃는 것은 시뮬 진행뿐이다 — `.zls` 는 게이트웨이에 그대로 있고 [로드] 한
 * 번이면 돌아온다. 상태줄이 그 방법을 말해 주는 이유가 그것이다.
 */
function clearScene(): void {
  // 씬이 내려간다. 날고 있는 재구성이 뒤늦게 도착해 빈 화면에 옛 옷을
  // 세우지 못하도록 번호부터 올린다 (`show()` 와 같은 판단이다).
  restageSeq += 1;
  viewer.cloth.clear();
  // 메시 통계는 이제 아무것도 가리키지 않는다. 슬롯도 같이 비운다 (I-1) —
  // 안 비우면 언어를 바꿀 때 이미 없는 메시의 숫자가 되살아난다.
  say('stat', null);
  // 몸도 씬에 딸려 있다 (AM-1). 옷만 지우면 **몸만 남아 서 있어서** 씬이 아직
  // 있는 것처럼 보인다 — 가운데 칸에서 커브만 남던 것과 같은 계열의 사고다.
  avatarView.clear();
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
  // 커브·봉제선도 같이 내린다 (D2-c). 옷만 지우면 **선만 남아 떠 있어서**
  // 씬이 아직 있는 것처럼 보인다 — 옷 메시와 그룹이 갈려 있는 대가다.
  viewer2d.design.clear();
  paintDraft2d();
  // 무늬도 씬에 딸려 있다 (materials-c). 남겨 두면 "무늬 4장 · 13.9MB" 가
  // 씬이 내려간 뒤에도 화면에 남아 아직 뭔가 있는 것처럼 말한다.
  clothTextures = [];
  textureOptions.clear();
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
  statusT('status.cleared');
  setBusy(false);
}

/** 버튼 네 개의 글자와 활성 상태. **상태는 만들지 않는다 — 받은 것만 그린다** */
function paintPlayback(view: PlaybackView = playback.view): void {
  ui.play.textContent = view.playLabel;
  ui.play.disabled = busy || !view.canPlay;
  ui.reset.disabled = busy || !view.canReset;
  ui.clear.disabled = busy || !view.canClear;
  ui.sim.textContent = view.text;
  // ★ 드레이프 버튼의 활성 조건도 **여기서 나오는 사실**을 쓴다 (W-1).
  //   `currentScene`(우리가 보고 싶은 것)이 아니라 `view.scene`(워커에 로드돼
  //   있다고 아는 것)이라야 한다 — 재연결 직후처럼 둘이 갈라지는 순간에
  //   currentScene 을 믿으면 버튼이 켜져 있는데 워커는 "씬이 없다" 로 답한다.
  draping.setScene(view.scene !== null);
  paintDraping();
  // ★ 치수 패널도 같은 사실을 쓴다 (W-2). `currentScene`(우리가 보고 싶은 것)
  //   이 아니라 `view.scene`(워커에 로드돼 있다고 아는 것)이라야 한다 —
  //   재연결 직후처럼 둘이 갈라지면 [적용] 이 켜져 있는데 워커는 "씬이 없다"
  //   로 답하고, 그 왕복은 15초짜리로 오해받는다.
  avatarMeasure.setScene(view.scene !== null);
  // ★ 몸도 같은 사실을 쓴다 (AM-1). `currentScene` 이 아니라 `view.scene` 이라야
  //   한다 — 재연결 직후처럼 둘이 갈라지면 448KB~1.9MB 짜리 왕복이 "씬이 없다"
  //   로 실패하고, 그 실패가 화면에 빨간 글자로 남는다(고장이 아닌데).
  avatarView.setScene(view.scene !== null);
  // ★ 재생 중에는 파라미터 [적용] 을 잠근다. **위젯은 열어 둔다** — 값을 미리
  //   맞춰 두고 정지한 뒤 한 번에 보낼 수 있다. 잠그는 이유는 시뮬이 도는
  //   도중의 변경이 어떻게 반영되는지 **측정한 적이 없어서**다. 한 런의
  //   프레임들이 서로 다른 파라미터로 계산되면 그 결과를 무엇으로 만들었다고
  //   말할 수 없게 된다. 사용자가 [⏸ 정지] 로 스스로 풀 수 있고, 잠긴 이유는
  //   패널에 글자로 뜬다 (`ui/paramsPanel.ts` 머리말 참고).
  params.setBlocked(
    view.playing
      ? t('params.blocked.playing')
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
  // ★ 재생 중 몸 갱신 (AM-1). **여기서 조건을 보지 않는다** — 폴링 간격도,
  //   애니메이션이 끝났는지도, 왕복이 겹치는지도 전부 컨트롤러가 판단한다.
  //   그 판단이 이 파일로 새는 순간 Node 테스트가 원리적으로 못 붙는다
  //   (ISSUE-009 가 그 반대편에서 났다). 여기 있는 것은 "지금 재생 중인가"
  //   라는 사실 하나를 넘기는 것뿐이고, 대부분의 프레임에서 불리언 비교
  //   몇 개로 끝난다.
  avatarView.tick(playback.playing);
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
    t('stat.frames', {
      frame: s.lastApplied ?? '-',
      applied: s.applied,
      dropped: s.dropped,
      fps: s.fps.toFixed(1),
    })
    + (s.stalled ? t('stat.frames.stalled') : '');
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
    // 진행률은 1초에 몇 번씩 갈리므로 슬롯에 넣지 않는다 (I-1) — 다음 갱신이
    // 바로 오고, 끝나면 아래 `takeSnapshot()` 이 요약을 슬롯에 넣는다.
    if (p.phase === 'exporting') {
      ui.snapstat.textContent = t('snap.exporting', { sec: (p.elapsedMs / 1000).toFixed(1) });
    } else if (p.phase === 'downloading') {
      ui.snapstat.textContent = p.total
        ? t('snap.downloading.total', { loaded: fmtBytes(p.loaded), total: fmtBytes(p.total) })
        : t('snap.downloading', { loaded: fmtBytes(p.loaded) });
    } else if (p.phase === 'parsing') {
      // 36.5MB 파싱은 메인 스레드를 잡는다. 미리 말해 두지 않으면 "멈췄다" 로 읽힌다.
      ui.snapstat.textContent = t('snap.parsing', { total: fmtBytes(p.total) });
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
  statusT('status.snap.making');
  try {
    const r = await snapshots.load();
    // 성공했으니 화면을 스냅샷으로 돌린다. 이 한 줄이 유일한 전환 지점이다.
    setMode('snapshot', { refit: true });
    say('snapstat', () => {
      ui.snapstat.textContent = t('snap.summary', {
        bytes: fmtBytes(r.info.bytes),
        meshes: r.stats.meshes,
        vertices: r.stats.vertices.toLocaleString('ko-KR'),
        materials: r.stats.materials,
        textures: r.stats.textures,
      });
    });
    log(
      `스냅샷 완료 ${r.elapsedMs}ms `
      + `(익스포트 ${r.timings.exportMs} / 다운로드 ${r.timings.downloadMs}`
      + ` / 파싱 ${r.timings.parseMs} / 부착 ${r.timings.installMs})`,
    );
    // ⛔ `r.info.name` 은 익스포트 파일명이라 번역하지 않는다
    statusT('status.snap.showing', { name: r.info.name });
  } catch (err: unknown) {
    if (err instanceof SnapshotStaleError) {
      // 취소다. 사용자가 그 사이에 다른 씬을 눌렀다는 뜻이므로 오류가 아니다.
      log(err.message);
    } else {
      say('snapstat', null);
      ui.snapstat.textContent = '';
      statusT('status.snap.failed', { why: message(err) }, true);
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
    statusT(mode === 'snapshot' ? 'status.mode.snapshot' : 'status.mode.live');
  }
}

/** 스냅샷이 사라져야 할 때. **씬이 바뀌면 이전 씬의 아바타는 거짓이다** */
function dropSnapshot(): void {
  snapshots.clear();
  viewer.setMode('live');
  say('snapstat', null);
  ui.snapstat.textContent = '';
  paintSnap();
}

function paintSnap(): void {
  const has = snapshots.present;
  ui.snap.disabled = busy || currentScene === null || !client.connected || snapshots.busy;
  // `data-i18n` 자리채움을 뗀다 — 안 떼면 언어 전환이 "🧍 다시 찍기" 를
  // "🧍 스냅샷" 으로 되돌린다 (I-1).
  ui.snap.removeAttribute('data-i18n');
  ui.mode.removeAttribute('data-i18n');
  ui.snap.textContent = has ? t('bar.snap.again') : t('bar.snap');
  ui.mode.hidden = !has;
  ui.mode.disabled = !has;
  ui.mode.textContent = viewer.mode === 'snapshot' ? t('bar.mode.live') : t('bar.mode.snapshot');
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
    statusT('status.scenes.failed', { why: message(err) }, true);
    return [];
  }

  ui.scene.replaceChildren();
  if (scenes.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    // `data-i18n` 을 달아 두면 언어를 바꿀 때 `applyStaticText()` 가 채운다 —
    // 씬 목록을 다시 받는 왕복을 만들지 않는다 (I-1).
    opt.dataset['i18n'] = 'bar.scene.empty';
    opt.textContent = t('bar.scene.empty');
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

/**
 * **씬을 다시 열지 않고** 토폴로지만 다시 받아 화면 셋을 맞춘다 (L-3d).
 *
 * 워커에서 옷이 바뀌었는데(옷 사이즈 [적용], 프레임 토폴로지 어긋남) 화면이
 * 옛것인 자리를 전부 여기로 모은다. 예전에는 이 자리가 `show()` 였고, 그래서
 * `.zls` 를 디스크에서 다시 열어 **워커의 편집을 통째로 버렸다** — 실측으로
 * 재로드 3.2초 뒤 방금 바꾼 크기가 원래 값으로 돌아왔다.
 *
 * ★ **화각을 건드리지 않는다.** `installTopology` 의 `frameCamera` 기본값이
 *   그래서 반대다 — 크기를 한 칸 바꿀 때마다 사용자가 조각을 보려고 잡아 둔
 *   시점을 빼앗으면 정작 바뀐 것을 볼 수 없다.
 *
 * ★ **순번 검사는 딱 한 곳, `meshData` 가 돌아온 직후다.** 그 아래는 전부
 *   동기라 검사와 반영 사이에 아무것도 끼어들 수 없고, 그래서 `setTopology`
 *   뿐 아니라 **후속 작업 전체가 같은 보호를 받는다.** 늦게 온 응답이
 *   `setTopology` 만 건너뛰고 `unfolder.build` 나 `#stat` 을 실행하면 화면과
 *   글자가 서로 다른 순간을 말하는, 더 진단하기 어려운 상태가 된다.
 *   유일한 예외가 도면 커브인데(왕복이 하나 더 있다) 그쪽은 같은 순번을
 *   `stillWanted` 로 물려준다.
 *
 * ★ **`stream.resume()` 을 앞에서 부르지 않는다.** `show()` 는 로드 전후로 두
 *   번 부르지만(아래), 여기서 앞의 한 번은 **해롭다**: 이 함수의 주 호출자
 *   중 하나가 `onMismatch` 이고 그쪽은 스트림이 방금 **정지된** 상태로
 *   들어온다. 앞에서 풀어 버리면 왕복이 도는 동안 새 토폴로지 프레임이 옛
 *   지오메트리에 다시 적용을 시도해 또 어긋나고, 복구 예산만 태운다. 정지된
 *   채로 두면 `drain` 이 조용히 버린다.
 *   버려지는 호출(`superseded`)은 **절대 재개시키지 않는다** — 아직 서지도
 *   않은 토폴로지에 프레임을 흘려보내는 셈이고, 어차피 자리를 물려받은 쪽이
 *   자기 차례에 푼다.
 */
async function restageTopology(cause: string): Promise<RestageOutcome> {
  // 씬이 없거나 소켓이 없으면 받아 올 곳이 없다.
  if (!currentScene || !client.connected) return 'failed';
  // 로드가 도는 중이면 물러난다. `show()` 가 어차피 토폴로지를 통째로 다시
  // 세우고 `stream.resume()` 까지 부른다 — 우리가 나중에 도착해 옛것을
  // 세우면 안 되므로, 이건 실패가 아니라 자리를 내준 것이다.
  if (busy) return 'superseded';
  const seq = (restageSeq += 1);
  let decoded: DecodedTopology;
  try {
    decoded = await fetchTopology(client);
  } catch (err: unknown) {
    if (seq !== restageSeq) return 'superseded';
    log(`${cause} — 토폴로지를 다시 받지 못했습니다: ${message(err)}`);
    // 여기서만 정지를 푼다. `onMismatch` 로 들어온 경우 스트림이 멈춘 채인데,
    // 안 풀면 **다시 어긋날 계기조차 없어** 재생이 영영 멎는다. 풀어 두면
    // 다음 프레임이 또 어긋나며 재시도가 걸리고, 그 횟수는 복구 예산이 막는다.
    stream.resume();
    return 'failed';
  }
  // ★ 순번 검사. 여기부터 끝까지 `await` 이 없다 — 그게 이 검사 하나로
  //   아래 전부를 지킬 수 있는 이유다.
  if (seq !== restageSeq) return 'superseded';

  const staged = installTopology(viewer, decoded, {
    // 가운데 칸의 옷도 **같은 디코딩 결과**에서 세운다 (L-2a). 따로 받으면
    // 두 칸이 서로 다른 순간의 토폴로지를 들 수 있다.
    mirror: viewer2d.cloth,
  });
  // 재질이 새로 만들어졌다. 표를 안 바꾸면 화면 글자가 이미 없는 텍스처를
  // 센다 (`showScene` 뒤에서 하는 것과 같은 일이다).
  clothTextures = staged.textures;
  syncTextureStats();
  // 새 토폴로지가 섰다. 칸에 남아 있던 옛 프레임을 버리고 정지 상태를 푼다.
  stream.resume();
  // ★ 토폴로지가 갈릴 때마다 다시 불러야 하는 것들. **`show()` 와 같은 순서가
  //   정본이다** — 빠뜨리면 도면이 옛 좌표로 남거나 면이 흰 종이가 아니게 된다.
  unfolder.build(viewer.cloth.patterns);
  unfoldControl.setScene(true);
  unfoldControl.setStats(unfolder.stats);
  unfolder2d.build(viewer2d.cloth.patterns);
  unfolder2d.apply(viewer2d.cloth.patterns, 1);
  viewer2d.paperize();
  paintDraft2d();
  // 도면 범위가 바뀌었으므로 슬라이더의 글자와 정사영 화각도 따라가야 한다.
  // `show()` 는 `setBusy(false)` 를 지나며 이걸 하는데, 이 갈래는 `busy` 를
  // 건드리지 않으므로 직접 부른다.
  paintUnfold();
  // 정점·삼각형 수가 바뀐다(패턴을 키우면 다시 삼각형이 잘린다). 옛 숫자를
  // 남겨 두면 상태줄이 화면에 없는 메시를 말한다.
  say('stat', () => {
    ui.stat.textContent = t('stat.mesh', {
      patterns: staged.patterns,
      vertices: staged.vertices,
      triangles: staged.triangles,
    });
  });
  log(`${cause} — 토폴로지를 다시 받았습니다 (패턴 ${staged.patterns} · 정점 ${staged.vertices})`);

  // ★ 도면 커브·봉제선 (D2-c). **규칙을 하나로 둔다 — 토폴로지가 갈리면
  //   커브도 다시 받는다.** "누가 바꿨는지" 로 생략을 정하면, 서피스를
  //   건드리는 경로가 하나만 늘어도 조용히 깨진다. 그 깨진 모습이 "도면
  //   선만 옛 좌표" 라서 눈에 거의 안 띈다.
  //
  //   **성패에 묶지 않는다** — `show()` 와 같은 판단이다(아래 주석). 커브가
  //   없어도 옷은 서야 하므로 여기서 기다리지 않고, 이 함수는 이미 `staged` 다.
  //   대신 순번을 물려줘서, 늦게 도착한 커브가 새 도면 위에 그려지는 것은
  //   막는다.
  void refreshDesign2d(() => seq === restageSeq);
  return 'staged';
}

async function show(sceneId: string, opts: { refit?: boolean } = {}): Promise<void> {
  if (busy) return;
  // ★ 이 로드가 **가장 새로운 재구성**이다. 번호를 올려 아직 날고 있는
  //   `restageTopology` 를 전부 무효로 만든다 — 안 그러면 로드가 끝난 뒤에
  //   도착한 옛 왕복이 방금 연 씬 위에 이전 씬의 토폴로지를 세운다.
  //   `busy` 가드는 **앞으로의** 겹침만 막지, 이미 날고 있는 것은 못 막는다.
  restageSeq += 1;
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
  statusT('status.loading');
  try {
    const shown = await showScene(client, viewer, sceneId, {
      // 재연결 후 다시 로드할 때는 사용자가 맞춰 둔 시점을 빼앗지 않는다.
      frameCamera: opts.refit !== false,
      // 가운데 칸의 옷도 같은 디코딩 결과에서 세운다 (L-2a). 따로 받으면
      // 두 칸이 서로 다른 순간의 토폴로지를 들 수 있다.
      mirror: viewer2d.cloth,
    });
    currentScene = sceneId;
    // ★ 옷의 직물 무늬 (materials-c). `showScene` 이 이미 화면에 걸었고, 여기서
    //   하는 일은 화면 글자를 위해 표를 들고 있는 것뿐이다. 아바타 쪽 표는
    //   `avatarView` 가 자기 왕복에서 가져오고, 둘을 합치는 것이 아래 함수다.
    clothTextures = shown.textures;
    syncTextureStats();
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
    // ★ 면을 흰 종이로 (D2-c). `showScene` 이 재질을 새로 만들므로 **로드마다**
    //   불러야 한다. 도면에서는 색을 선이 지고 있어서 면까지 칠하면 선이 묻힌다.
    viewer2d.paperize();
    paintDraft2d();
    // 디자인 정보 (D2-c). 옷 메시와 달리 **왕복이 따로다** — 커브·봉제선은
    // 메시가 아니라 디자인 계층에 있고, 실패해도 도면 자체는 서야 하므로
    // 로드의 성패에 묶지 않는다.
    void refreshDesign2d();
    // ★ 실시간 뷰의 몸 (AM-1). **로드의 성패에 묶지 않는다** — 1.9MB 라
    //   눈에 띄게 걸리고, 몸이 없어도 옷은 서야 한다(디자인 정보와 같은 판단).
    //   `playback.sceneLoaded` 가 방금 지났으므로 컨트롤러는 씬을 알고 있다.
    //
    //   ⓘ 카메라를 **몸이 도착한 뒤에 한 번 더** 맞춘다. 위 `showScene` 의
    //     `frameCamera` 는 옷(약 100cm)만 보고 잡은 것이라, 그대로 두면
    //     177cm 짜리 몸의 머리가 화면 밖으로 나간다. 사용자가 시점을 잡아 둔
    //     경우(재연결 재로드, `refit:false`)에는 빼앗지 않는다.
    const refit = opts.refit !== false;
    void avatarView.refresh('로드').then((r) => {
      if (r.installedTopology && refit) viewer.frameCamera();
    });
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
    say('stat', () => {
      ui.stat.textContent = t('stat.mesh', {
        patterns: shown.patterns,
        vertices: shown.vertices,
        triangles: shown.triangles,
      });
    });
    statusT('status.loaded', { ms: shown.elapsedMs });
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
    viewer2d.design.clear();
    paintDraft2d();
    statusT('status.load.failed', { why: message(err) }, true);
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
  if (err) statusT('status.action.failed', { action: t(LABEL[action]), why: err.message }, true);
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

/**
 * 실패 문구에 들어갈 조작 이름의 **사전 키**. 글자가 아니라 키인 이유는
 * 이 상수가 모듈 로드 때 한 번 만들어지기 때문이다 (I-1) — `act()` 가
 * `t(LABEL[action])` 로 그때의 언어로 꺼낸다.
 */
const LABEL: Record<PlaybackCommand, string> = {
  toggle: 'action.toggle',
  play: 'action.play',
  pause: 'action.pause',
  reset: 'action.reset',
  clear: 'action.clear',
  step: 'action.step',
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

/**
 * 고른 파일 이름을 우리가 보여준다 (I-1).
 *
 * 네이티브 `<input type=file>` 의 글자를 번역할 수 없어 입력을 감췄는데,
 * 그 대가로 **브라우저가 보여주던 파일 이름도 같이 사라졌다.** 이 자리가
 * 그것을 대신한다 — 없으면 무엇을 골랐는지 확인할 방법이 없다.
 *
 * ⚠️ 파일 이름 자체는 번역하지 않는다(사용자의 파일이다). 안 골랐을 때의
 *    문구만 사전을 탄다. 그래서 이름이 있으면 `data-i18n` 을 떼고, 없으면
 *    다시 달아 `applyStaticText()` 가 언어 전환 때 채우게 둔다.
 */
function paintFileName(): void {
  const name = ui.file.files?.[0]?.name;
  if (name === undefined) {
    ui.fileName.dataset['i18n'] = 'bar.file.none';
    ui.fileName.textContent = t('bar.file.none');
  } else {
    ui.fileName.removeAttribute('data-i18n');
    ui.fileName.textContent = name;
  }
  ui.fileName.title = name ?? '';
}

ui.file.addEventListener('change', () => {
  ui.upload.disabled = busy || !ui.file.files?.length;
  say('filename', paintFileName);
});

ui.upload.addEventListener('click', () => {
  const file = ui.file.files?.[0];
  if (!file) return;
  void (async (): Promise<void> => {
    setBusy(true);
    // ⛔ `file.name` 은 사용자가 고른 파일 이름이라 번역하지 않는다
    statusT('status.uploading', { name: file.name, size: fmtBytes(file.size) });
    try {
      const scene = await uploadScene(file.name, file);
      log(`업로드 완료: ${scene.id}`);
      await refreshScenes(scene.id);
      setBusy(false);
      await show(scene.id);
    } catch (err: unknown) {
      statusT('status.upload.failed', { why: message(err) }, true);
      setBusy(false);
    }
  })();
});

// ── 언어 전환의 배선 (I-1) ──────────────────────────────────
//
// ★ **새로고침을 요구하지 않는다.** 씬 로드가 2~3초(103MB)라 새로고침을
//   요구하면 언어를 바꿀 때마다 씬을 다시 열게 된다. 대신 화면을 만드는
//   자리를 **전부 한 번씩 다시 부른다** — 그 자리들이 이미 "상태를 만들지
//   않고 받은 것만 그린다" 는 규약을 지키고 있어서, 다시 부르는 것이 안전하다.
//
// ⚠️ **여기 한 줄을 빠뜨리면 그 위젯만 한국어로 남는다.** 그리고 Node 는
//    DOM 이 없어 그것을 못 본다(사전 키가 맞아도 부르는 자리가 없으면 그만이다).
//    그래서 화면 확인은 사람이 브라우저에서 눈으로 한다.
function repaintForLang(): void {
  // ① `index.html` 에 박힌 정적 글자와 `<title>`·`<html lang>`
  applyStaticText();
  langSwitch.render();
  paintHint();

  // ② 지난 문장 (상태줄·메시 통계·스냅샷 요약). 위 `say()` 머리말 참고
  for (const paint of slotPainters.values()) paint();

  // ③ 스스로 다시 그리는 위젯들. 순서에 뜻은 없다 — 전부 멱등이다
  paintPlayback();
  paintDraping();
  paintUnfold();
  paintSnap();
  paintFrames();
  paintMeasure();
  paintAvatarView();
  textureSwitch.render();
  avatarPanel.render();
  surfacePanel.render();
  design2dOptions.render();
  sideTabs.render();
  drawer.render();
  params.relabel();
}

const langSwitch = new LangSwitch({
  root: ui.bar,
  onChange: repaintForLang,
});

// 기동 때 한 번. 저장된 언어가 영어면 마크업의 한국어가 **한 번도 안 보인 채**
// 영어로 선다 — `initLang()` 이 위에서 이미 언어를 정해 뒀기 때문이다.
repaintForLang();

// 다른 곳(콘솔의 `cobalt` 창구 등)에서 `setLang` 을 불러도 화면이 따라온다.
onLangChange(() => repaintForLang());

// ── 기동 ────────────────────────────────────────────────────

void (async (): Promise<void> => {
  const health = await fetchHealth();
  if (!health) {
    statusT('status.gateway.down', undefined, true);
    return;
  }
  log(`게이트웨이 ok — node ${health.node}, pid ${health.pid}`);

  const scenes = await refreshScenes();

  statusT('status.connecting');
  try {
    await client.connect();
  } catch (err: unknown) {
    statusT('status.connect.failed', { why: message(err) }, true);
    return;
  }

  const v = await client.version().catch(() => null);
  if (v) log(`엔진 — Zelus ${v.zelus} / Lumia ${v.lumia}`);

  const first = scenes[0];
  if (!first) {
    statusT('status.connected.empty');
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
    /**
     * W-1 의 진단 표면 — 저장된 드레이프. `draping.view.text` 가 화면이 말하고
     * 있어야 하는 글자이고, `draping.stats.noAutoItem` 이 0 이 아니면 **씬에
     * 자동 드레이프가 없어서** 아무 일도 안 일어난 것이다(실패가 아니다).
     */
    draping: DrapingPanel;
    /**
     * W-2 의 진단 표면 — 치수(cm). `avatarMeasure.view.text` 가 화면이 말하고
     * 있어야 하는 글자다.
     *
     * ★ `view.rows[*].current` 가 **되읽기의 정본**이다 — 마지막
     *   `setAvatarMeasurements` 응답의 `measured` 로 덮인 값이고,
     *   `avatarBody.view` 쪽 숫자와는 다른 것이다(씬 데이터 사본은 이 op 으로
     *   안 움직인다). `view.stale` 이 참이면 아직 그 정본이 없다는 뜻이다.
     *
     * `stats.notSupported` 가 0 이 아니면 이 씬의 아바타가 `ztDesignZeta` 가
     * 아니어서(예: `sample.zls`) 치수 변형이 원리적으로 안 되는 것이다 —
     * UI 를 의심할 자리가 아니다.
     */
    avatarMeasure: AvatarMeasureController;
    /**
     * AM-1 의 진단 표면 — 실시간 뷰의 몸.
     *
     * `avatarView.view.text` 가 화면이 말하고 있어야 하는 글자다. 몸이 안
     * 보일 때 여기서 세 가지가 갈린다: `view.visible` 이 false 면 **사용자가
     * 꺼 둔 것**, `view.phase` 가 'noAvatar' 면 **씬에 아바타가 없는 것**,
     * 'error' 면 `stats.lastError` 가 이유다. 셋 다 화면상 똑같이 보인다.
     *
     * ★ `stats.resyncs` 가 0 이 아니면 **`topology:false` 로 받은 몸의 모양이
     *   달라진 적이 있다**는 뜻이다 — AM-1 의 실측("드레이프 뒤에도 uuid·파트·
     *   정점 수는 그대로")이 이 씬에서는 성립하지 않는다는 증거이고, 그
     *   사실만으로 프로토콜 쪽을 볼 이유가 생긴다.
     * `stats.polls` 는 재생 중 폴링 횟수다. 애니메이션이 끝났는데도 계속
     * 오르면 `frameInfo` 판정(`isAnimationFinished`)이 안 먹고 있는 것이다.
     *
     * `cobalt.viewer.avatar.boundingBox()` 가 몸이 선 자리이고, 옷의
     * `cobalt.viewer.cloth.boundingBox()` 와 **같은 공간에 있어야 한다** —
     * 어긋나면 몸에서 옷이 떨어져 보인다(ISSUE-011 의 증상).
     */
    avatarView: AvatarViewController;
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
  draping,
  avatarMeasure,
  avatarView,
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
