/**
 * 재생 상태 기계 (#14) — **DOM 도 three 도 만지지 않는다.**
 *
 * `frameStream.ts` · `snapshot.ts` 와 같은 규약이다. 그 규약이 여기서 특히
 * 중요한 이유는 [ISSUE-009](../../../ISSUES.md) 가 정확히 그 반대편에서 났기
 * 때문이다: 재생 상태가 `main.ts` 의 모듈 스코프 불리언 두 개로 흩어져 있어서
 * **자동 테스트가 한 줄도 덮지 못했고**, 그래서 "버튼은 정지라고 쓰여 있는데
 * 시뮬은 멈춰 있다" 를 사람이 브라우저에서 눈으로 찾아야 했다. 상태와 전이를
 * 여기로 옮기면 Node 에서 가짜 포트 하나로 전이 전체를 돌릴 수 있다.
 *
 * ── 상태 다섯 개 ────────────────────────────────────────────
 *
 *   disconnected → 소켓이 없다. 어떤 op 도 못 보낸다
 *   noScene      → 붙었지만 워커에 씬이 없다 (기동 직후 / clear 직후 / 재연결 직후)
 *   loading      → 씬을 로드하는 중. **워커의 시뮬은 이 구간에 멈춰 있다**
 *   paused       → 씬이 있고 시뮬이 서 있다
 *   playing      → 씬이 있고 시뮬이 돈다
 *
 * 상태를 필드로 들지 않고 `connected`·`scene`·`loading`·`playing` 에서
 * **파생**시킨다. 필드로 들면 "연결이 끊겼는데 state 는 playing" 같은 조합이
 * 표현 가능해지고, 그게 곧 ISSUE-009 의 형태다 — 표현할 수 없으면 어긋날 수 없다.
 *
 * 진행 중인 op(`pending`)은 상태가 **아니다.** 상태로 두면 "op 이 끝나면 어디로
 * 돌아가는가" 를 따로 기억해야 하는데, 그 기억이 또 하나의 믿음이 된다.
 *
 * ── 전이를 일으키는 것은 다섯 가지뿐이다 ────────────────────
 *
 *   ① 사용자 조작    play / pause / toggle / reset / clear / step
 *   ② 씬 로드        sceneLoading → sceneLoaded | sceneLoadFailed
 *   ③ 소켓           connectionLost / sessionStarted
 *   ④ 프레임 이벤트  noteFrame (숫자만 갱신한다 — 상태는 안 건드린다)
 *   ⑤ 워커의 사실    syncFromWorker (status op)
 *
 * ── ★ ISSUE-009 를 어떻게 닫는가 ────────────────────────────
 * 검토된 3안 중 **1안(로드 경로에서 믿음을 내린다) + 3안(워커에 되묻는다)** 을
 * 함께 쓴다. 2안(로드 후 자동 재시작)은 버렸다 — 사용자가 지시하지 않은 상태
 * 변경이고, 103MB 를 막 올린 직후에 시뮬이 저절로 도는 것이 항상 바람직하지도
 * 않으며, 로드 실패 갈래가 하나 더 는다.
 *
 * 1안만으로도 오늘의 증상은 사라진다. 그런데 1안은 **"로드하면 워커가 멈춘다"
 * 를 우리가 외워 두는 것**이라, 워커가 언젠가 다르게 굴면 거짓말이 그대로
 * 돌아온다. 그래서 로드·op·재연결이 끝나는 자리마다 `status` 를 한 번 물어
 * 믿음을 사실로 덮어쓴다. 3안의 유일한 걱정은 폴링 비용이었는데, **폴링하지
 * 않는다** — 워커의 시뮬 상태를 바꿀 수 있는 사건이 위 다섯 가지뿐이고 그게
 * 전부 우리 손을 지나므로, 그 순간에만 물으면 된다. 왕복 한 번은 프레임
 * 하나(48KB)보다 싸다.
 *
 * ── ★ `status.frame` 은 화면에 쓰지 않는다 (인계된 함정) ────
 * **[실측]** 재생 중에는 `frame` 이 정상 증가하는데, **멈춘 뒤 조회하면
 * `frame: -1, maxFrame: 249`** 가 온다. 워커의 `curFrame` 은 엔진 콜백이 주는
 * 값을 그대로 담는 필드이고(`backend/native/src/protocol.cpp:433-437`), 시뮬이
 * 서면 그 콜백이 -1 로 들어온다.
 *
 * 이걸 "마지막 유효값을 따로 들고 있기" 로 가리려 했더니 반대쪽 함정이 나왔다:
 * `reset` op 은 `maxFrame` 만 -1 로 되돌리고 **`curFrame` 은 그대로 둔다**
 * (`protocol.cpp:577-583`). 즉 리셋 직후의 `frame` 은 249 라는 **옛 봉우리**다.
 * 마지막 유효값을 붙들면 리셋해도 249 가 화면에 남는다 — 가리려던 거짓말을
 * 다른 방향으로 다시 만드는 셈이다.
 *
 * 그래서 **`frame` 을 아예 쓰지 않고 `maxFrame` 만 본다.** 근거:
 *   - `maxFrame` 은 한 런 안에서 단조 증가하고, 런이 리셋되는 자리
 *     (load / clear / reset)에서 워커가 정확히 -1 로 되돌린다. 즉 우리가 원하는
 *     "이 런에서 어디까지 갔는가" 와 정의가 같다
 *   - **frame 이벤트가 싣고 오는 숫자가 이미 `maxFrame` 이다**
 *     (`protocol.cpp:464`). 화면의 프레임 번호와 이벤트의 프레임 번호가 같은
 *     출처가 되어, 둘이 어긋날 수 없다
 *   - 음수는 "프레임 없음" 이지 프레임이 아니다. `null` 로 바꿔 `-` 로 찍는다
 *
 * 워커를 고치지 않은 이유는 범위다(C++ 재빌드 = 게이트웨이 정지). 다만 고칠
 * 필요도 크지 않다 — `curFrame` 을 쓰는 화면이 하나도 없다. `status.frame` 이
 * 음수로 온 횟수는 `stats.negativeFrames` 로 세어 둔다.
 *
 * ── reset 과 clear 는 다르다 (되돌릴 수 있는가) ─────────────
 *
 *   reset : `SetAnimationMode(RESET)` + `maxFrame = -1`. **씬은 그대로 있다.**
 *           시뮬만 처음으로 돌아간다 (`protocol.cpp:577-583`)
 *   clear : `ZestManager::Clear()`. **씬이 워커에서 내려간다** (364MB → 24MB).
 *           프로세스는 산다 (`protocol.cpp:559-566`)
 *
 * clear 는 화면의 옷을 지우므로 확인 창을 다는 것을 검토했다가 **달지 않았다.**
 * (a) `.zls` 는 게이트웨이에 그대로 남아 있어서 [로드] 한 번이면 되돌아온다 —
 * 잃는 것은 시뮬 진행뿐이다. (b) `confirm()` 은 DOM 이라 이 파일에 둘 수 없고,
 * `main.ts` 에 두면 Playwright 가 기본으로 대화상자를 **취소**해서 자동 검증이
 * "clear 가 아무 일도 안 한다" 로 보인다. 대신 clear 뒤의 상태줄이 되돌리는
 * 방법을 말한다.
 */

import type { StatusResult } from '../protocol/index.ts';

// ── 상태 ────────────────────────────────────────────────────

export type PlaybackState =
  /** 소켓이 없다 */
  | 'disconnected'
  /** 붙었지만 워커에 씬이 없다 */
  | 'noScene'
  /** 씬을 로드하는 중 — 워커의 시뮬은 멈춰 있다 */
  | 'loading'
  /** 씬이 있고 시뮬이 서 있다 */
  | 'paused'
  /** 씬이 있고 시뮬이 돈다 */
  | 'playing';

/** 왕복이 필요한 사용자 조작. 한 번에 하나만 진행한다 */
export type PlaybackAction = 'play' | 'pause' | 'reset' | 'clear' | 'step';

/**
 * 워커에 op 을 보내는 쪽. **`GatewayClient` 가 구조적으로 이미 만족한다** —
 * 어댑터가 필요 없다. Node 테스트는 이 여섯 함수만 가진 가짜를 넣으면 된다.
 */
export interface PlaybackPort {
  /** 소켓이 살아 있는가. `GatewayClient.connected` */
  readonly connected: boolean;
  start(): Promise<unknown>;
  pause(): Promise<unknown>;
  reset(): Promise<unknown>;
  /** ⚠️ 씬을 워커에서 내린다. 시뮬 리셋이 아니다 */
  clear(): Promise<unknown>;
  step(): Promise<unknown>;
  subscribe(): Promise<{ subscribed: boolean }>;
  status(): Promise<StatusResult>;
}

/**
 * 화면 쪽이 끼워 넣는 것들. **전부 선택이고, 던져도 op 을 실패시키지 않는다** —
 * 숫자를 찍는 코드가 시뮬 제어를 죽이면 원인을 찾을 길이 없다.
 */
export interface PlaybackHooks {
  /**
   * 재생을 켜기 **직전**. `main.ts` 는 여기서 스냅샷(정지 화면)에서 실시간
   * 뷰로 되돌린다 — 정지 화면 위에서 시뮬을 켜면 "재생을 눌렀는데 아무것도
   * 안 움직인다" 가 되고 그 실패는 화면 어디에도 원인이 안 남는다.
   */
  beforePlay?: () => void;
  /**
   * `reset` 이 성공한 **뒤**. 화면의 포즈를 다시 받아 오는 자리다.
   *
   * 왜 필요한가: 워커는 `maxFrame` 이 **바뀔 때만** frame 이벤트를 낸다.
   * 리셋은 그걸 -1 로 되돌리므로 다시 재생하기 전까지 이벤트가 한 건도 안
   * 온다 — 즉 시뮬은 처음으로 돌아갔는데 **화면은 드레이프된 옷 그대로**다.
   * ISSUE-009 와 정확히 같은 계열의 거짓말이라 여기서 막는다.
   */
  afterReset?: () => Promise<void> | void;
  /** `clear` 가 성공한 뒤. 화면에서 옷·스냅샷을 내리는 자리 */
  afterClear?: () => void;
  /** 상태가 바뀔 때마다. **프레임 번호 갱신으로는 부르지 않는다** (아래 참고) */
  onChange?: (view: PlaybackView) => void;
  log?: (line: string) => void;
}

export interface PlaybackOptions {
  port: PlaybackPort;
  hooks?: PlaybackHooks;
}

/** 화면에 그대로 찍을 수 있는 한 벌. 버튼의 활성 조건까지 여기서 나온다 */
export interface PlaybackView {
  state: PlaybackState;
  /**
   * `#play` 버튼 글자.
   *
   * ⚠️ **'▶ 재생' / '⏸ 정지' 두 개뿐이다.** `verify/ui.ts` 의 `ensurePlaying`
   *    이 이 글자에서 '재생'/'정지' 를 찾아 상태를 읽는다(`ui.ts:470-486`).
   *    문구를 바꾸면 하네스가 토글을 반대 위상으로 돌린다.
   */
  playLabel: string;
  playing: boolean;
  /** 왕복 중인 op. 있으면 버튼을 전부 잠근다 */
  pending: PlaybackAction | null;
  busy: boolean;
  canPlay: boolean;
  canReset: boolean;
  canClear: boolean;
  canStep: boolean;
  /** **워커의 `maxFrame` 이다** (`status.frame` 이 아니다 — 머리말 참고). 없으면 null */
  frame: number | null;
  /** 워커가 마지막으로 말한 mode. **믿음이 아니라 사실이다.** 아직 안 물었으면 null */
  workerMode: StatusResult['mode'] | null;
  /** 워커에 로드돼 있다고 아는 씬 id */
  scene: string | null;
  subscribed: boolean;
  /** 상태줄에 그대로 쓰는 한 줄 */
  text: string;
  lastError: Error | null;
}

export interface PlaybackStats {
  plays: number;
  pauses: number;
  resets: number;
  clears: number;
  steps: number;
  /** subscribe 를 실제로 보낸 수. **세션당 1이어야 한다** */
  subscribes: number;
  /** status op 을 보낸 수 */
  syncs: number;
  /** 다른 op 이 진행 중이라 거절한 조작 수. 연타 방지가 실제로 일한 횟수 */
  rejected: number;
  /** op 이 실패한 수 */
  failures: number;
  /**
   * `status.frame` 이 음수로 온 수. **인계된 함정의 계측기다** — 워커를 고치면
   * 이 값이 0 이 된다. 화면에는 애초에 안 쓰므로 여기 세는 것 외에 영향이 없다.
   */
  negativeFrames: number;
  /** 믿음과 워커의 사실이 갈라져 sync 가 고친 수. **ISSUE-009 의 계측기다** */
  corrections: number;
}

const IDLE_STATS: PlaybackStats = {
  plays: 0, pauses: 0, resets: 0, clears: 0, steps: 0,
  subscribes: 0, syncs: 0, rejected: 0, failures: 0,
  negativeFrames: 0, corrections: 0,
};

export class PlaybackController {
  readonly #port: PlaybackPort;
  readonly #hooks: PlaybackHooks;

  /** 워커에 로드돼 있다고 아는 씬. null 이면 `noScene` */
  #scene: string | null = null;
  /** 시뮬이 돈다고 믿는 상태. **sync 가 이걸 사실로 덮어쓴다** */
  #playing = false;
  /**
   * 이 워커 세션에서 subscribe 를 이미 보냈는가.
   *
   * ⚠️ 세션(=프로세스)마다 하나다. 재연결하면 새 워커라 반드시 false 로 되돌린다.
   *
   * ── reset/clear 뒤에도 유지되는가 → **유지된다** ────────────
   * 워커가 명시적으로 그렇게 만들어져 있다: "씬 상태가 아니라 클라이언트의
   * 전송 취향이므로 load/clear/reset에서 건드리지 않는다. 프로세스(=세션)
   * 수명 내내 유지된다"(`protocol.cpp:455-459`, 게이트웨이 `bridge.ts:757` 도
   * 같은 말을 적어 두었다). 그래서 #13 이 정한 "세션당 한 번 켜고 끄지
   * 않는다" 는 reset·clear 를 지나서도 그대로 성립한다. 게다가 `syncFromWorker`
   * 가 매번 `status.subscribed` 로 이 값을 덮으므로, 혹시 워커가 달라지면
   * 믿음이 아니라 사실을 따라간다.
   */
  #subscribed = false;
  #loading = false;
  #pending: PlaybackAction | null = null;
  /** 화면에 찍을 프레임 = 워커의 maxFrame. 음수는 null 로 접는다 */
  #frame: number | null = null;
  #workerMode: StatusResult['mode'] | null = null;
  #lastError: Error | null = null;
  #stats: PlaybackStats = { ...IDLE_STATS };

  constructor(opts: PlaybackOptions) {
    this.#port = opts.port;
    this.#hooks = opts.hooks ?? {};
  }

  // ── 관찰 ──────────────────────────────────────────────────

  get state(): PlaybackState {
    if (!this.#port.connected) return 'disconnected';
    if (this.#loading) return 'loading';
    if (this.#scene === null) return 'noScene';
    return this.#playing ? 'playing' : 'paused';
  }

  get playing(): boolean {
    return this.state === 'playing';
  }

  get busy(): boolean {
    return this.#pending !== null;
  }

  get frame(): number | null {
    return this.#frame;
  }

  get subscribed(): boolean {
    return this.#subscribed;
  }

  get lastError(): Error | null {
    return this.#lastError;
  }

  get stats(): PlaybackStats {
    return { ...this.#stats };
  }

  get view(): PlaybackView {
    const state = this.state;
    const live = state === 'playing' || state === 'paused';
    const free = live && this.#pending === null;
    return {
      state,
      playLabel: state === 'playing' ? '⏸ 정지' : '▶ 재생',
      playing: state === 'playing',
      pending: this.#pending,
      busy: this.#pending !== null,
      canPlay: free,
      canReset: free,
      canClear: free,
      canStep: free,
      frame: this.#frame,
      workerMode: this.#workerMode,
      scene: this.#scene,
      subscribed: this.#subscribed,
      text: this.#text(state),
      lastError: this.#lastError,
    };
  }

  /** 상태줄 한 줄. 프레임 번호가 없으면 아예 안 붙인다 — `-` 를 읽을 이유가 없다 */
  #text(state: PlaybackState): string {
    const at = this.#frame === null ? '' : ` · 프레임 ${this.#frame}`;
    switch (state) {
      case 'disconnected': return '연결 없음';
      case 'noScene': return '씬 없음 — .zls 를 로드하세요';
      case 'loading': return '씬을 로드하는 중…';
      case 'playing': return `시뮬레이션 실행 중${at}`;
      case 'paused': return `일시정지${at}`;
    }
  }

  // ── 사용자 조작 ───────────────────────────────────────────
  //
  // 전부 `Promise<boolean>` 이다 — **던지지 않는다.** 버튼 핸들러에서 도는
  // 함수라, 던지면 `void` 로 삼켜져 unhandled rejection 만 남고 화면에는 아무
  // 단서도 안 생긴다. 실패는 `false` + `lastError` + `stats.failures` 로 보인다.

  async play(): Promise<boolean> {
    return this.#run('play', async () => {
      this.#hooks.beforePlay?.();
      // subscribe 를 start 보다 **먼저** 보낸다. 반대로 하면 그 사이에 진행한
      // 프레임들이 mesh 없이 지나가고, 옷은 몇 프레임 늦게 움직이기 시작한다.
      if (!this.#subscribed) {
        const r = await this.#port.subscribe();
        this.#subscribed = r.subscribed !== false;
        this.#stats.subscribes += 1;
        this.#log('구독 켜짐 — 프레임당 약 48KB 가 흐르기 시작합니다');
      }
      await this.#port.start();
      this.#playing = true;
      this.#stats.plays += 1;
    });
  }

  async pause(): Promise<boolean> {
    return this.#run('pause', async () => {
      await this.#port.pause();
      this.#playing = false;
      this.#stats.pauses += 1;
    });
  }

  /** 버튼 하나로 쓰는 자리. **지금 상태를 보고 정한다** — 눌린 횟수를 세지 않는다 */
  async toggle(): Promise<boolean> {
    return this.playing ? this.pause() : this.play();
  }

  /**
   * 시뮬을 처음으로 되돌린다. **씬은 남는다.**
   *
   * 워커가 `maxFrame` 을 -1 로 되돌리므로 프레임 번호도 즉시 비운다 — sync 를
   * 기다리는 동안 화면에 옛 봉우리가 남아 있으면 "리셋이 안 먹었다" 로 읽힌다.
   */
  async reset(): Promise<boolean> {
    return this.#run('reset', async () => {
      await this.#port.reset();
      this.#playing = false;
      this.#frame = null;
      this.#stats.resets += 1;
      try {
        await this.#hooks.afterReset?.();
      } catch (err: unknown) {
        // 포즈를 다시 못 받은 것이 리셋 실패는 아니다. 리셋은 이미 됐다.
        this.#log(`리셋 후 포즈를 다시 받지 못했습니다: ${messageOf(err)}`);
      }
    });
  }

  /** ⚠️ **씬을 워커에서 내린다.** 되돌리려면 다시 로드해야 한다 (~1초, 103MB) */
  async clear(): Promise<boolean> {
    return this.#run('clear', async () => {
      await this.#port.clear();
      this.#playing = false;
      this.#scene = null;
      this.#frame = null;
      this.#stats.clears += 1;
      this.#hooks.afterClear?.();
    });
  }

  /**
   * 한 프레임만 진행한다 (데스크톱 #63 / SPACE).
   *
   * ⛔ **[실측] 지금 워커에서 아무 일도 하지 않는다.** 응답은 `{mode:"step"}`
   *    인데 곧바로 `status` 를 물으면 `mode:"pause"` 이고 `maxFrame` 은 5초가
   *    지나도 그대로다(정지 상태에서 3회 연속: 14 → 14 → 14 → 14). 그래서 화면
   *    쪽에서는 버튼도 단축키도 **꺼 두었다** — 눌러도 안 움직이는 컨트롤은 이
   *    단위가 없애려던 바로 그 거짓말이다. 이 메서드는 남긴다: 워커가 고쳐지면
   *    `index.html` 의 버튼 한 줄과 `shortcuts.ts` 의 표 한 줄로 되살아난다.
   *
   * 재생 중에 불러도 막지 않는다 — 워커의 `SetAnimationMode(STEP)` 이 PLAY 를
   * 대체하므로 결과적으로 "멈추고 한 칸" 이 된다. 데스크톱도 같다. 다만 우리
   * 믿음은 반드시 정지로 내려야 한다. 안 그러면 버튼은 `⏸ 정지` 인데 시뮬은
   * 서 있는, ISSUE-009 와 같은 모양이 된다.
   */
  async step(): Promise<boolean> {
    const wasPlaying = this.playing;
    return this.#run('step', async () => {
      await this.#port.step();
      this.#playing = false;
      this.#stats.steps += 1;
      if (wasPlaying) this.#log('스텝 — 재생 중이었으므로 한 프레임 진행하고 멈춥니다');
    });
  }

  // ── 씬 로드 경로 (★ ISSUE-009) ────────────────────────────

  /**
   * 씬을 로드하기 **시작했다.**
   *
   * ★ 여기가 ISSUE-009 를 닫는 자리다. 워커의 `load` 는 시뮬 상태를 초기화하고
   *   `maxFrame` 을 -1 로 되돌린다(`protocol.cpp:545-557`). 즉 로드가 시작된
   *   순간 "재생 중" 이라는 믿음은 이미 거짓이다. 성공을 기다렸다가 내리면
   *   그 사이(103MB 면 1초쯤)에 화면이 계속 거짓말을 한다.
   */
  sceneLoading(): void {
    this.#loading = true;
    this.#playing = false;
    this.#frame = null;
    this.#emit();
  }

  /** 로드가 성공했다. **부른 쪽이 이어서 `syncFromWorker()` 를 await 한다** */
  sceneLoaded(scene: string): void {
    this.#loading = false;
    this.#scene = scene;
    this.#emit();
  }

  /**
   * 로드가 실패했다. 씬이 워커에 남아 있는지 **모른다** — 그래서 `scene` 을
   * 지우지도 유지하지도 않고, 곧이어 부를 `syncFromWorker()` 의 `loaded` 에
   * 맡긴다. 여기서 찍으면 그게 또 하나의 믿음이 된다.
   */
  sceneLoadFailed(): void {
    this.#loading = false;
    this.#emit();
  }

  // ── 소켓 ──────────────────────────────────────────────────

  /**
   * 소켓이 끊겼다. 보낼 곳이 없으므로 진행 중 op 도 이미 거부됐다.
   *
   * `subscribed` 를 내리는 것이 핵심이다 — 재연결하면 **새 워커**라 구독이 꺼진
   * 채로 시작한다. 안 내리면 다음 재생에서 start 만 나가고 mesh 없는 frame 만
   * 흘러, 프레임 번호는 오르는데 옷은 안 움직인다.
   */
  connectionLost(): void {
    this.#playing = false;
    this.#subscribed = false;
    this.#loading = false;
    this.#pending = null;
    this.#workerMode = null;
    this.#emit();
  }

  /**
   * 새 워커 세션이 붙었다 (첫 연결이든 재연결이든).
   *
   * 씬도 초기값이다 — 재연결은 복구가 아니라 **빈 세션**이다. `scene` 을
   * 비워 두면 부르는 쪽이 다시 로드할 때 `sceneLoading()` 부터 정상 경로를 탄다.
   */
  sessionStarted(): void {
    this.#playing = false;
    this.#subscribed = false;
    this.#loading = false;
    this.#pending = null;
    this.#scene = null;
    this.#frame = null;
    this.#workerMode = null;
    this.#emit();
  }

  // ── 프레임 ────────────────────────────────────────────────

  /**
   * frame 이벤트의 번호를 받는다. **`client.on('frame')` 에 그대로 꽂는다.**
   *
   * ⚠️ **`onChange` 를 부르지 않는다.** 이 함수는 40/s 로 돌고, 여기서 다시
   *    그리면 초당 40번 DOM 을 건드리게 된다 — `main.ts` 는 이미 rAF 에서
   *    4/s 로 눌러 찍고 있으므로 거기서 `view` 를 읽어 가면 된다.
   *
   * 음수는 버린다. 이벤트가 싣고 오는 숫자는 `maxFrame` 이라(`protocol.cpp:464`)
   * 리셋 직후 -1 이 한 번 지나갈 수 있다.
   */
  noteFrame(frame: number): void {
    if (frame < 0) return;
    this.#frame = frame;
  }

  // ── 워커에 되묻기 ─────────────────────────────────────────

  /**
   * `status` 로 **믿음을 사실로 덮어쓴다.** 폴링이 아니다 — 전이가 끝나는
   * 자리에서만 부른다 (머리말 "★ ISSUE-009" 참고).
   *
   * 실패해도 던지지 않는다. 되묻기가 안 됐다고 방금 성공한 op 을 실패로
   * 만들면, 화면이 실제보다 나쁜 상태를 말하게 된다.
   */
  async syncFromWorker(): Promise<StatusResult | null> {
    if (!this.#port.connected) return null;
    let s: StatusResult;
    try {
      s = await this.#port.status();
      this.#stats.syncs += 1;
    } catch (err: unknown) {
      this.#log(`상태를 되묻지 못했습니다: ${messageOf(err)}`);
      return null;
    }

    const wasPlaying = this.#playing;
    const hadScene = this.#scene !== null;

    this.#workerMode = s.mode;
    this.#playing = s.mode === 'play';
    this.#subscribed = s.subscribed;
    // 씬 id 는 워커가 모른다(경로만 안다). 있다/없다만 사실로 받는다.
    if (!s.loaded) this.#scene = null;

    // ★ `s.frame` 을 쓰지 않는다. 머리말의 -1 함정 참고.
    if (s.frame < 0) this.#stats.negativeFrames += 1;
    this.#frame = s.maxFrame >= 0 ? s.maxFrame : null;

    if (wasPlaying !== this.#playing || hadScene !== (this.#scene !== null)) {
      this.#stats.corrections += 1;
      this.#log(
        `워커의 실제 상태로 맞췄습니다 — mode=${s.mode} · loaded=${s.loaded}`
        + ` (믿음: ${wasPlaying ? '재생' : '정지'}/${hadScene ? '씬 있음' : '씬 없음'})`,
      );
    }
    this.#emit();
    return s;
  }

  // ── 내부 ──────────────────────────────────────────────────

  /**
   * op 하나를 실행하고 그 뒤에 사실을 확인한다.
   *
   * 이미 왕복 중이면 **거절한다.** 연타로 start 와 pause 가 교차하면 마지막에
   * 도착한 응답이 이기는데, 그게 마지막에 누른 버튼이라는 보장이 없다.
   */
  async #run(action: PlaybackAction, body: () => Promise<void>): Promise<boolean> {
    if (!this.#port.connected) {
      this.#lastError = new Error('연결되어 있지 않습니다');
      return false;
    }
    // clear 는 씬을 내리는 op 이라 `scene === null` 이면 할 일이 없다. play/
    // pause/reset/step 도 씬 없이는 의미가 없다 — 워커가 조용히 성공시킨다.
    if (this.#scene === null || this.#loading) {
      this.#lastError = new Error('씬이 로드되어 있지 않습니다');
      return false;
    }
    if (this.#pending !== null) {
      this.#stats.rejected += 1;
      return false;
    }

    this.#pending = action;
    this.#lastError = null;
    this.#emit();

    let ok = true;
    try {
      await body();
    } catch (err: unknown) {
      ok = false;
      this.#stats.failures += 1;
      this.#lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      this.#pending = null;
    }

    // 성공했든 실패했든 되묻는다. **실패했을 때가 더 중요하다** — 실패한 op 이
    // 워커에 닿기는 했는지 우리는 모르고(타임아웃이 그렇다), 그 모름을 화면에
    // 그대로 두면 다시 ISSUE-009 다.
    await this.syncFromWorker();
    this.#emit();
    return ok;
  }

  #emit(): void {
    if (!this.#hooks.onChange) return;
    try {
      this.#hooks.onChange(this.view);
    } catch {
      // 화면을 그리다 던진 것이 시뮬 제어를 죽이면 안 된다.
    }
  }

  #log(line: string): void {
    this.#hooks.log?.(line);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
