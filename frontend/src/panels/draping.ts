/**
 * 드레이핑 보드의 판단 (W-1 / DB-1) — **DOM 도 three 도 만지지 않는다.**
 *
 * `playback.ts` 와 같은 규약이고, 실은 같은 계열의 물건이다: 무언가를 누르면
 * 왕복이 하나 나가고, 그 결과에 따라 **화면이 무엇을 말해야 하는지**가 정해진다.
 * 그리는 것은 `ui/drapingBoardPanel.ts` 와 `main.ts` 의 `paintDraping`,
 * 배선은 `main.ts` 다.
 *
 * ── 드레이핑 아이템이 무엇인가 ──────────────────────────────
 *
 * 프레임 한 장이 아니라 **완전한 세이브스테이트**다. `.zls` 안에 솔버 월드
 * 통째(2.1~2.8MB) + 그 시점의 씬 데이터 전체 사본 + 미리보기 PNG 가 들어 있고,
 * 적용은 "다시 계산" 이 아니라 **그 순간으로 되돌아가기** 다. 그래서 비싸지도
 * 않고(역직렬화뿐이다) 결정적이다 — 같은 아이템은 언제나 같은 포즈로 돌아온다.
 *
 * ── W-1 에서 무엇이 달라졌나 ────────────────────────────────
 *
 * W-1 은 **자동 아이템 하나만** 적용할 수 있었다(버튼 하나). 이름 붙은
 * 나머지는 워커 응답의 목록에 실려 오면서도 쓸 수가 없었다 — 데스크톱 앱의
 * `Draping board` 패널은 아무거나 골라 Apply 하는데(`MainGUI.cpp:197-203`)
 * 우리 쪽만 못 했다. DB-1 이 그 구멍을 메운다:
 *
 *   목록      `drapingItems` (부작용 없는 읽기)
 *   적용      `loadDraping({uuid})` — 인자 없이 부르면 여태처럼 자동
 *   미리보기  `drapingThumbnail(uuid)` — base64, 아이템당 한 번
 *
 * ── 이 op 이 왜 `reset` 과 같은 자리인가 ────────────────────
 *
 * 워커의 `LoadDrapingItem` 은 안에서 `ztSimulationManager::Reset()` 을 부르고,
 * 그래서 **적용에 성공하면 프레임 카운터가 -1 로 되돌아간다**
 * (`backend/native/src/protocol.cpp` 의 loadDraping 갈래). 즉 옷의 포즈는
 * 바뀌었는데 화면의 프레임 번호와 재생 상태는 옛 런의 것이 남는다 — ISSUE-009
 * 와 정확히 같은 계열의 거짓말이다. 그래서 이 모듈은 성공했을 때
 * `afterApplied` 를 부르고, 화면 쪽은 **리셋이 하는 것과 똑같은 뒤처리**를
 * 그 자리에 끼운다(포즈 다시 받기 + `syncFromWorker`). 새로 만들지 않는다.
 *
 * ── ★ `applied:false` 는 실패가 아니다 ──────────────────────
 *
 * 씬에 자동 드레이프가 저장돼 있지 않으면 워커는 **성공 응답**에
 * `applied:false, reason:'noAutoItem'` 을 싣는다. 이걸 오류로 다루면 멀쩡한
 * 씬에서 빨간 글자가 뜨고, 반대로 조용히 넘기면 **눌렀는데 아무 일도 안
 * 일어난 것처럼** 보인다 — 후자가 더 나쁘다. 그래서 결과를 갈래마다 **전부
 * 글자로** 말한다. 툴팁이 아니다 — 마우스를 올려야 보이는 것은 보이는 게
 * 아니다(#16 에서 확립).
 *
 * `notFound` 만 성격이 다르다. 저것들은 씬의 사정이지만 이것은 **우리가 틀린
 * 것**이다 — 목록이 낡았거나(씬이 바뀌었다) 없는 uuid 를 보냈다. 그래서
 * 오류로 칠하고, 목록을 다시 읽는다.
 *
 * ── 선택이 없으면 자동이다 ──────────────────────────────────
 *
 * `apply()` 를 인자 없이 부르면 **고른 것**을, 고른 것이 없으면 **자동**을
 * 적용한다. 상단 바의 버튼 하나가 W-1 때와 똑같이 도는 이유가 이것이다 —
 * 보드를 한 번도 안 연 사용자에게 동작이 달라지지 않는다.
 */

import { t } from './i18n.ts';
import type {
  DrapingItem,
  DrapingItemsResult,
  DrapingThumbnailResult,
  LoadDrapingResult,
} from '../protocol/index.ts';

// ── 상태 ────────────────────────────────────────────────────

export type DrapingPhase =
  /** 소켓이 없다 */
  | 'disconnected'
  /** 붙었지만 워커에 씬이 없다 */
  | 'noScene'
  /** 왕복 중 */
  | 'applying'
  /** 누를 수 있다 */
  | 'ready';

/**
 * 목록이 지금 어디에 있는가. **적용(`phase`)과 다른 축이다** — 목록을 읽는
 * 중에도 이미 받아 둔 목록으로 적용할 수 있고, 적용 중에도 목록은 그대로다.
 */
export type DrapingListPhase =
  /** 아직 안 읽었다 (씬이 없거나, 씬은 있는데 `refresh()` 전) */
  | 'idle'
  /** 읽는 중 */
  | 'loading'
  /** 읽었다. `items` 가 비었을 수도 있다 — 그것도 답이다 */
  | 'loaded'
  /** 읽다가 실패했다 */
  | 'error';

/** 마지막 적용이 무엇으로 끝났는가. 아직 안 눌렀으면 null */
export type DrapingOutcome =
  /** 드레이프가 씌워졌다 (`applied:true`) */
  | 'applied'
  /** 씬에 자동 드레이프가 없다 (`reason:'noAutoItem'`). **오류가 아니다** */
  | 'noAutoItem'
  /** 고른 uuid 가 목록에 없다 (`reason:'notFound'`). **우리가 틀렸다** */
  | 'notFound'
  /** 엔진이 적용에 실패했다 (`reason:'loadFailed'`) */
  | 'loadFailed'
  /** 요청 자체가 실패했다 (연결·씬 없음 등) */
  | 'error';

/**
 * 워커에 op 을 보내는 쪽. **`GatewayClient` 가 구조적으로 이미 만족한다** —
 * `PlaybackPort` 와 같은 판단이라 어댑터가 필요 없다.
 */
export interface DrapingPort {
  readonly connected: boolean;
  drapingItems(): Promise<DrapingItemsResult>;
  loadDraping(uuid?: string): Promise<LoadDrapingResult>;
  drapingThumbnail(uuid: string): Promise<DrapingThumbnailResult>;
}

export interface DrapingHooks {
  /**
   * **적용에 성공한 뒤**(`applied:true`)에만 부른다. 프레임 카운터가 -1 로
   * 되돌아간 상태이므로, 화면 쪽은 여기서 리셋과 같은 뒤처리를 한다.
   *
   * 던져도 op 을 실패로 만들지 않는다 — 드레이프는 이미 씌워졌고, 포즈를 다시
   * 못 받은 것이 그 사실을 되돌리지는 않는다(`PlaybackHooks.afterReset` 과 같다).
   */
  afterApplied?: () => Promise<void> | void;
  onChange?: (view: DrapingView) => void;
  log?: (line: string) => void;
}

export interface DrapingOptions {
  port: DrapingPort;
  hooks?: DrapingHooks;
}

/**
 * 미리보기 한 칸. **`<img src>` 에 그대로 물릴 수 있는 값**이거나, 왜 없는지다.
 *
 * `panels/` 는 DOM 을 안 만지므로 여기서 만드는 것은 `Image` 가 아니라
 * **data URL 문자열**이다 — 그리는 것은 `ui/` 의 일이다.
 */
export interface DrapingThumbState {
  /** 받는 중인가 */
  loading: boolean;
  /** `data:image/png;base64,…`. 없으면 null */
  url: string | null;
  /**
   * 왜 없는가. 화면이 이 자리에 무엇을 쓸지 정하는 데 쓴다.
   * `null` 이면 아직 시도하지 않았거나 성공했다.
   */
  reason: 'notFound' | 'noImage' | 'unsupportedFormat' | 'error' | null;
}

/** 화면에 그대로 찍을 수 있는 한 벌 */
export interface DrapingView {
  phase: DrapingPhase;
  /** 적용 버튼을 누를 수 있는가 */
  canApply: boolean;
  busy: boolean;
  outcome: DrapingOutcome | null;
  /**
   * **화면 글자.** 비활성 사유든 결과든 여기 한 줄로 나온다 — 툴팁이 아니다.
   * 아직 아무 일도 없었고 누를 수 있는 상태면 빈 문자열이다(할 말이 없다).
   */
  text: string;
  /** 이 글자가 오류인가. 화면이 빨갛게 칠할지 정하는 데 쓴다 */
  isError: boolean;
  /** 씬에 저장된 드레이프 아이템 수. 아직 모르면 null */
  count: number | null;
  /** 엔진이 말하는 활성 아이템 이름. 적용의 증거다 */
  activeName: string | null;

  // ── 보드 (DB-1) ───────────────────────────────────────────

  list: DrapingListPhase;
  /** 고를 수 있는 아이템. `list !== 'loaded'` 면 낡았거나 비어 있다 */
  items: readonly DrapingItem[];
  /** 목록이 비어 있는 이유를 화면이 말할 한 줄. 말할 것이 없으면 빈 문자열 */
  listText: string;
  /** 사용자가 고른 것. **null 이면 "자동"** 이다 */
  selectedUuid: string | null;
  /** 엔진이 말하는 활성 아이템의 uuid. 목록에서 표시를 다는 데 쓴다 */
  activeUuid: string | null;
  /** 목록을 다시 읽을 수 있는가 */
  canRefresh: boolean;
  lastError: Error | null;
}

export interface DrapingStats {
  /** 실제로 보낸 적용 왕복 수 */
  calls: number;
  /** `applied:true` 로 끝난 수 */
  applied: number;
  /** 자동 드레이프가 없어 아무 일도 안 한 수. **실패가 아니다** */
  noAutoItem: number;
  /** 고른 uuid 가 목록에 없던 수. **우리가 틀린 것이다** */
  notFound: number;
  /** 엔진이 적용에 실패한 수 */
  loadFailed: number;
  /** 요청 자체가 실패한 수 */
  failures: number;
  /** 왕복 중이라 거절한 클릭 수 */
  rejected: number;
  /** 목록을 읽은 왕복 수 */
  listCalls: number;
  /** 썸네일을 실제로 받은 수. **캐시에 맞은 것은 안 센다** */
  thumbCalls: number;
}

const IDLE_STATS: DrapingStats = {
  calls: 0, applied: 0, noAutoItem: 0, notFound: 0, loadFailed: 0,
  failures: 0, rejected: 0, listCalls: 0, thumbCalls: 0,
};

const NO_THUMB: DrapingThumbState = { loading: false, url: null, reason: null };

export class DrapingPanel {
  readonly #port: DrapingPort;
  readonly #hooks: DrapingHooks;

  /** 워커에 씬이 있다고 아는가. 정본은 `PlaybackView.scene` 이다 (main.ts 가 민다) */
  #scene = false;
  #applying = false;
  #outcome: DrapingOutcome | null = null;
  #count: number | null = null;
  #activeName: string | null = null;
  #activeUuid: string | null = null;
  #lastError: Error | null = null;
  #stats: DrapingStats = { ...IDLE_STATS };

  // ── 보드 ──────────────────────────────────────────────────

  #list: DrapingListPhase = 'idle';
  #items: DrapingItem[] = [];
  #selected: string | null = null;
  /** 목록 왕복이 하나 떠 있는가. 겹쳐 부르는 것을 막는다 */
  #listing = false;

  /**
   * uuid → 미리보기. **씬이 바뀌면 통째로 버린다** — 다른 씬의 그림이 남으면
   * 화면이 없는 아이템의 그림을 그린다.
   *
   * 같은 씬 안에서는 안 변하므로(아이템은 파일에 박혀 있다) 한 번 받으면
   * 다시 안 받는다. 실측 아이템 3개 × ~100KB = 300KB 가 상한이다.
   */
  readonly #thumbs = new Map<string, DrapingThumbState>();

  constructor(opts: DrapingOptions) {
    this.#port = opts.port;
    this.#hooks = opts.hooks ?? {};
  }

  // ── 관찰 ──────────────────────────────────────────────────

  get phase(): DrapingPhase {
    if (!this.#port.connected) return 'disconnected';
    if (this.#applying) return 'applying';
    if (!this.#scene) return 'noScene';
    return 'ready';
  }

  get busy(): boolean {
    return this.#applying;
  }

  get lastError(): Error | null {
    return this.#lastError;
  }

  get stats(): DrapingStats {
    return { ...this.#stats };
  }

  get view(): DrapingView {
    const phase = this.phase;
    return {
      phase,
      canApply: phase === 'ready',
      busy: this.#applying,
      outcome: this.#outcome,
      text: this.#text(phase),
      // "자동 드레이프가 없다" 는 오류가 아니다. 빨갛게 칠하면 멀쩡한 씬이
      // 고장난 것처럼 보인다 — 알리되 경고로 만들지 않는다.
      // `notFound` 는 다르다. 우리가 없는 것을 골랐다는 뜻이라 오류가 맞다.
      isError: this.#outcome === 'error'
            || this.#outcome === 'loadFailed'
            || this.#outcome === 'notFound',
      count: this.#count,
      activeName: this.#activeName,

      list: this.#list,
      items: this.#items,
      listText: this.#listTextOf(),
      selectedUuid: this.#selected,
      activeUuid: this.#activeUuid,
      // 목록 왕복이 떠 있으면 못 누른다. **적용 중인 것은 막지 않는다** —
      // 그 둘은 다른 왕복이고, 적용이 끝나면 어차피 목록을 다시 읽는다.
      canRefresh: this.#port.connected && this.#scene && !this.#listing,
      lastError: this.#lastError,
    };
  }

  /**
   * 아이템 하나의 미리보기 상태. **여기서 요청을 내지 않는다** — 그리는 쪽이
   * 읽기만 하는 함수이므로, 받아 오는 것은 `loadThumbnail()` 의 일이다.
   * (게터가 왕복을 내면 화면을 다시 그릴 때마다 요청이 나간다.)
   */
  thumbnail(uuid: string): DrapingThumbState {
    return this.#thumbs.get(uuid) ?? NO_THUMB;
  }

  /**
   * 버튼 옆에 그대로 찍는 한 줄.
   *
   * **비활성 사유가 결과보다 먼저다.** 씬을 내린 뒤에도 "드레이프 적용됨" 이
   * 남아 있으면, 그 글자가 지금 화면의 옷을 가리키는 것처럼 읽힌다.
   */
  #text(phase: DrapingPhase): string {
    if (phase === 'disconnected') return t('drape.disconnected');
    if (phase === 'noScene') return t('drape.noScene');
    if (phase === 'applying') return t('drape.applying');

    switch (this.#outcome) {
      case 'applied':
        // ⛔ `#activeName` 은 **씬에 저장된 드레이프 이름**이라 번역하지 않는다
        return this.#activeName
          ? t('drape.applied.named', { name: this.#activeName })
          : t('drape.applied');
      case 'noAutoItem':
        // ★ 조용히 넘기지 않는다. 아무 일도 안 일어난 화면은 고장으로 보인다.
        return t('drape.noAutoItem');
      case 'notFound':
        return t('drape.notFound');
      case 'loadFailed':
        return t('drape.loadFailed');
      case 'error':
        return t('drape.failed', { why: this.#lastError?.message ?? t('err.unknown') });
      default:
        // 누를 수 있고 아직 아무 일도 없었다. 할 말이 없으면 아무 말도 안 한다.
        return '';
    }
  }

  /** 목록 자리에 찍는 한 줄. 항목이 그려지고 있으면 할 말이 없다 */
  #listTextOf(): string {
    if (!this.#port.connected) return t('drape.disconnected');
    if (!this.#scene) return t('drape.noScene');

    switch (this.#list) {
      case 'idle':    return t('drape.list.idle');
      case 'loading': return t('drape.list.loading');
      case 'error':
        return t('drape.list.failed', { why: this.#lastError?.message ?? t('err.unknown') });
      case 'loaded':
        // ★ 빈 목록은 오류가 아니다 — 드레이프를 저장하지 않은 씬일 뿐이다.
        return this.#items.length === 0 ? t('drape.list.empty') : '';
    }
  }

  // ── 밖에서 미는 사실 ──────────────────────────────────────

  /**
   * 워커에 씬이 있는가. `UnfoldController.setScene` 과 같은 자리다 —
   * 이 모듈이 씬을 스스로 알아낼 방법이 없고, 알아내려 들면 `status` 를 또
   * 물어보는 두 번째 폴링이 된다.
   *
   * 씬이 바뀌면(또는 내려가면) **지난 결과와 목록과 썸네일을 전부 지운다.**
   * 다른 씬의 것이 남아 있으면 그 글자와 그림이 지금 옷을 가리키는 것처럼
   * 읽힌다 — 썸네일은 특히 나쁘다. 없는 아이템의 사진이 화면에 남는다.
   */
  setScene(on: boolean): void {
    if (this.#scene === on) return;
    this.#scene = on;
    this.#forgetScene();
    this.#emit();

    // ★ 씬이 올라오면 **목록을 바로 읽는다.**
    //
    // 사용자가 [목록 새로고침] 을 눌러야 아이템이 보이는 화면이면, 보드를 처음
    // 연 사람은 **드레이프가 없는 씬**을 본다 — 빈 격자와 "아직 안 읽었습니다"
    // 는 구분되지만, 구분된다고 해서 사용자가 그 버튼을 찾아 누르지는 않는다.
    //
    // 여기에 두는 이유(배선이 아니라): 씬 전환을 아는 것이 이 모듈뿐이다.
    // `main.ts` 가 하려면 직전 값을 따로 기억해야 하고, 그 기억이 `#scene` 과
    // 갈라지는 날 목록이 안 읽히거나 두 번 읽힌다.
    //
    // `void` 인 이유는 `refresh()` 가 **던지지 않기** 때문이다 — 실패는
    // `view.list`/`view.listText` 로 화면에 남고, 여기서 기다릴 것이 없다.
    if (on) void this.refresh();
  }

  /** 소켓이 끊겼거나 새 워커가 붙었다. 지난 결과는 이미 죽은 세션의 것이다 */
  reset(): void {
    this.#scene = false;
    this.#applying = false;
    this.#forgetScene();
    this.#emit();
  }

  #forgetScene(): void {
    this.#outcome = null;
    this.#count = null;
    this.#activeName = null;
    this.#activeUuid = null;
    this.#lastError = null;
    this.#list = 'idle';
    this.#items = [];
    this.#selected = null;
    this.#thumbs.clear();
  }

  // ── 사용자 조작 ───────────────────────────────────────────

  /**
   * 목록에서 하나를 고른다. **왕복이 없다** — 고르는 것과 적용하는 것은
   * 다른 동작이다(데스크톱 앱도 목록에서 고르고 Apply 를 따로 누른다).
   *
   * `null` 을 주면 선택이 풀리고, 그 상태에서 `apply()` 는 **자동**을 적용한다.
   *
   * @returns 선택이 실제로 바뀌었는가. 목록에 없는 uuid 는 **거절한다** —
   *   받아 두면 `apply()` 가 `notFound` 로 끝나고, 그 실패의 원인이
   *   화면에서는 안 보인다.
   */
  select(uuid: string | null): boolean {
    if (uuid !== null && !this.#items.some((it) => it.uuid === uuid)) return false;
    if (this.#selected === uuid) return false;

    this.#selected = uuid;
    this.#emit();
    return true;
  }

  /**
   * 씬에 저장된 아이템 목록을 읽는다. **씬을 안 바꾼다.**
   *
   * **던지지 않는다** — 화면 갱신 경로에서 도는 함수라 던지면 삼켜진다
   * (`apply()` 와 같은 규약). 결과는 `view.list` 와 `view.listText` 로만 보인다.
   *
   * @returns 목록을 실제로 받았는가
   */
  async refresh(): Promise<boolean> {
    if (!this.#port.connected || !this.#scene) return false;
    if (this.#listing) return false;   // 겹쳐 부르지 않는다

    this.#listing = true;
    this.#list = 'loading';
    this.#emit();

    let res: DrapingItemsResult;
    try {
      res = await this.#port.drapingItems();
      this.#stats.listCalls += 1;
    } catch (err: unknown) {
      this.#listing = false;
      this.#stats.listCalls += 1;
      this.#list = 'error';
      this.#lastError = err instanceof Error ? err : new Error(String(err));
      this.#emit();
      return false;
    }

    this.#listing = false;
    this.#list = 'loaded';
    this.#items = res.items;
    this.#count = res.count;
    this.#activeUuid = res.activeUuid ?? null;
    this.#activeName = res.activeName ?? null;

    // 고른 것이 목록에서 사라졌다면(씬이 바뀌었다) 선택을 놓는다. 남겨 두면
    // 적용이 `notFound` 로 끝나고 화면에는 그 이유가 안 보인다.
    if (this.#selected !== null && !this.#items.some((it) => it.uuid === this.#selected)) {
      this.#selected = null;
    }

    this.#emit();
    return true;
  }

  /**
   * 아이템 하나의 미리보기를 받아 캐시에 넣는다.
   *
   * **이미 있으면(또는 받는 중이면) 아무 일도 안 한다** — 화면이 스크롤될
   * 때마다 불러도 왕복은 아이템당 한 번뿐이다.
   *
   * **던지지 않는다.** 미리보기를 못 받은 것이 보드를 못 쓰게 만들면 안 된다 —
   * 그림 없이도 이름으로 고를 수 있다.
   *
   * @returns 화면에 물릴 url 이 생겼는가
   */
  async loadThumbnail(uuid: string): Promise<boolean> {
    const have = this.#thumbs.get(uuid);
    if (have && (have.loading || have.url !== null || have.reason !== null)) {
      return have.url !== null;
    }

    this.#thumbs.set(uuid, { loading: true, url: null, reason: null });
    this.#emit();

    let res: DrapingThumbnailResult;
    try {
      res = await this.#port.drapingThumbnail(uuid);
      this.#stats.thumbCalls += 1;
    } catch (err: unknown) {
      this.#stats.thumbCalls += 1;
      this.#thumbs.set(uuid, { loading: false, url: null, reason: 'error' });
      this.#log(`드레이프 미리보기를 받지 못했습니다: ${messageOf(err)}`);
      this.#emit();
      return false;
    }

    if (!res.hasImage || !res.data || !res.mime) {
      this.#thumbs.set(uuid, {
        loading: false,
        url: null,
        reason: res.reason ?? 'error',
      });
      this.#emit();
      return false;
    }

    // ★ **`data:` URL 이다 — `URL.createObjectURL` 이 아니다.** 저쪽은 쓰고
    //   나서 `revokeObjectURL` 을 해야 하고, 그 수명 관리가 이 모듈에 DOM 의
    //   사정을 들여온다. 실측 ~100KB 짜리 3개라 문자열로 들고 있어도 싸다.
    this.#thumbs.set(uuid, {
      loading: false,
      url: `data:${res.mime};base64,${res.data}`,
      reason: null,
    });
    this.#emit();
    return true;
  }

  /**
   * 드레이프를 적용한다.
   *
   * 인자가 없으면 **고른 것**을, 고른 것이 없으면 **자동**을 적용한다 —
   * 보드를 한 번도 안 연 사용자에게는 W-1 때와 동작이 같다.
   *
   * **던지지 않는다** — 버튼 핸들러에서 도는 함수라, 던지면 `void` 로 삼켜져
   * 화면에 아무 단서도 안 남는다(`PlaybackController` 와 같은 규약). 결과는
   * `view.text` 와 돌려주는 값으로만 보인다.
   *
   * @returns **드레이프가 실제로 씌워졌는가.** `applied:false`(자동 드레이프
   *   없음·못 찾음)도 `false` 다 — 성공/실패가 아니라 "옷이 바뀌었는가" 를 답한다.
   */
  async apply(uuid?: string): Promise<boolean> {
    if (!this.#port.connected) {
      // 이 사유는 `#text()` 를 지나 **화면 글자**가 된다 — 번역 대상이다 (I-1)
      this.#fail(new Error(t('err.notConnected')));
      return false;
    }
    if (!this.#scene) {
      this.#fail(new Error(t('err.noScene')));
      return false;
    }
    if (this.#applying) {
      // 연타다. 버튼이 이미 잠겨 있으므로 화면에 새로 말할 것이 없다.
      this.#stats.rejected += 1;
      return false;
    }

    // ⚠️ `?? undefined` 가 아니라 **명시적으로 갈라야 한다.** `#selected` 가
    //    null 이면 "자동" 이라는 뜻이고, 그것은 uuid 를 **안 싣는 것**으로만
    //    표현된다(빈 문자열을 싣는 것과 다르다 — 게이트웨이가 거절한다).
    const target = uuid ?? this.#selected ?? undefined;

    this.#applying = true;
    this.#lastError = null;
    this.#emit();

    let res: LoadDrapingResult;
    try {
      res = await this.#port.loadDraping(target);
      this.#stats.calls += 1;
    } catch (err: unknown) {
      this.#applying = false;
      this.#stats.calls += 1;
      this.#fail(err instanceof Error ? err : new Error(String(err)));
      return false;
    }

    this.#applying = false;
    this.#count = res.count;
    // ★ 활성 아이템은 **엔진이 말한 것**이다. 요청을 메아리친 값이 아니라서
    //   "적용됐다" 의 증거가 된다.
    this.#activeName = res.activeName ?? null;
    this.#activeUuid = res.activeUuid ?? null;

    // 응답이 목록을 같이 싣고 온다. 따로 `refresh()` 를 부르면 왕복이 하나
    // 더 나가고, 그 사이에 목록과 활성 표시가 어긋난다.
    this.#items = res.items;
    this.#list = 'loaded';

    if (!res.applied) {
      this.#outcome = res.reason === 'loadFailed' ? 'loadFailed'
                    : res.reason === 'notFound'   ? 'notFound'
                    : 'noAutoItem';

      if (this.#outcome === 'loadFailed') this.#stats.loadFailed += 1;
      else if (this.#outcome === 'notFound') this.#stats.notFound += 1;
      else this.#stats.noAutoItem += 1;

      // 없는 것을 골랐다. 목록이 낡은 것이므로 선택을 놓는다 — 그대로 두면
      // 다음 클릭도 같은 곳에서 실패한다.
      if (this.#outcome === 'notFound') this.#selected = null;

      this.#log(
        this.#outcome === 'loadFailed'
          ? `드레이프 — 엔진이 적용에 실패했습니다 (아이템 ${res.count}개)`
          : this.#outcome === 'notFound'
            ? `드레이프 — 고른 아이템이 목록에 없습니다 (아이템 ${res.count}개)`
            : `드레이프 — 이 씬에는 자동 드레이프가 없습니다 (아이템 ${res.count}개)`,
      );
      this.#emit();
      return false;
    }

    this.#outcome = 'applied';
    this.#stats.applied += 1;
    this.#log(
      `드레이프 적용 — ${res.activeName ?? '(이름 없음)'} · 아이템 ${res.count}개`
      + ' · 프레임 카운터가 -1 로 되돌아갔습니다',
    );

    try {
      // 리셋과 같은 뒤처리. 실패해도 드레이프는 이미 씌워졌다.
      await this.#hooks.afterApplied?.();
    } catch (err: unknown) {
      this.#log(`드레이프 적용 후 화면을 갱신하지 못했습니다: ${messageOf(err)}`);
    }

    this.#emit();
    return true;
  }

  // ── 내부 ──────────────────────────────────────────────────

  #fail(err: Error): void {
    this.#outcome = 'error';
    this.#lastError = err;
    this.#stats.failures += 1;
    this.#emit();
  }

  #emit(): void {
    if (!this.#hooks.onChange) return;
    try {
      this.#hooks.onChange(this.view);
    } catch {
      // 화면을 그리다 던진 것이 조작을 죽이면 안 된다 (playback.ts 와 같다).
    }
  }

  #log(line: string): void {
    this.#hooks.log?.(line);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
