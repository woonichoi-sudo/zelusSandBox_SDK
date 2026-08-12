/**
 * 저장된 드레이프 적용의 판단 (W-1) — **DOM 도 three 도 만지지 않는다.**
 *
 * `playback.ts` 와 같은 규약이고, 실은 같은 계열의 물건이다: 버튼 하나를 누르면
 * 왕복이 하나 나가고, 그 결과에 따라 **화면이 무엇을 말해야 하는지**가 정해진다.
 * 그리는 것은 `main.ts` 의 `paintDraping`, 배선도 거기다.
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
 * 씬에서 빨간 글자가 뜨고, 반대로 조용히 넘기면 **버튼을 눌렀는데 아무 일도
 * 안 일어난 것처럼** 보인다 — 후자가 더 나쁘다. 그래서 결과는 세 갈래
 * (적용됨 / 적용할 것이 없음 / 실패)로 갈라서 **전부 글자로** 말한다.
 * 툴팁이 아니다 — 마우스를 올려야 보이는 것은 보이는 게 아니다(#16 에서 확립).
 */

import { t } from './i18n.ts';
import type { LoadDrapingResult } from '../protocol/index.ts';

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

/** 마지막 왕복이 무엇으로 끝났는가. 아직 안 눌렀으면 null */
export type DrapingOutcome =
  /** 드레이프가 씌워졌다 (`applied:true`) */
  | 'applied'
  /** 씬에 자동 드레이프가 없다 (`applied:false, reason:'noAutoItem'`). **오류가 아니다** */
  | 'noAutoItem'
  /** 엔진이 적용에 실패했다 (`applied:false, reason:'loadFailed'`) */
  | 'loadFailed'
  /** 요청 자체가 실패했다 (연결·씬 없음 등) */
  | 'error';

/**
 * 워커에 op 을 보내는 쪽. **`GatewayClient` 가 구조적으로 이미 만족한다** —
 * `PlaybackPort` 와 같은 판단이라 어댑터가 필요 없다.
 */
export interface DrapingPort {
  readonly connected: boolean;
  loadDraping(): Promise<LoadDrapingResult>;
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

/** 화면에 그대로 찍을 수 있는 한 벌 */
export interface DrapingView {
  phase: DrapingPhase;
  /** 버튼을 누를 수 있는가 */
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
  lastError: Error | null;
}

export interface DrapingStats {
  /** 실제로 보낸 왕복 수 */
  calls: number;
  /** `applied:true` 로 끝난 수 */
  applied: number;
  /** 자동 드레이프가 없어 아무 일도 안 한 수. **실패가 아니다** */
  noAutoItem: number;
  /** 엔진이 적용에 실패한 수 */
  loadFailed: number;
  /** 요청 자체가 실패한 수 */
  failures: number;
  /** 왕복 중이라 거절한 클릭 수 */
  rejected: number;
}

const IDLE_STATS: DrapingStats = {
  calls: 0, applied: 0, noAutoItem: 0, loadFailed: 0, failures: 0, rejected: 0,
};

export class DrapingPanel {
  readonly #port: DrapingPort;
  readonly #hooks: DrapingHooks;

  /** 워커에 씬이 있다고 아는가. 정본은 `PlaybackView.scene` 이다 (main.ts 가 민다) */
  #scene = false;
  #applying = false;
  #outcome: DrapingOutcome | null = null;
  #count: number | null = null;
  #activeName: string | null = null;
  #lastError: Error | null = null;
  #stats: DrapingStats = { ...IDLE_STATS };

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
      isError: this.#outcome === 'error' || this.#outcome === 'loadFailed',
      count: this.#count,
      activeName: this.#activeName,
      lastError: this.#lastError,
    };
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
      case 'loadFailed':
        return t('drape.loadFailed');
      case 'error':
        return t('drape.failed', { why: this.#lastError?.message ?? t('err.unknown') });
      default:
        // 누를 수 있고 아직 아무 일도 없었다. 할 말이 없으면 아무 말도 안 한다.
        return '';
    }
  }

  // ── 밖에서 미는 사실 ──────────────────────────────────────

  /**
   * 워커에 씬이 있는가. `UnfoldController.setScene` 과 같은 자리다 —
   * 이 모듈이 씬을 스스로 알아낼 방법이 없고, 알아내려 들면 `status` 를 또
   * 물어보는 두 번째 폴링이 된다.
   *
   * 씬이 바뀌면(또는 내려가면) **지난 결과를 지운다.** 다른 씬의 결과가 남아
   * 있으면 그 글자가 지금 옷을 가리키는 것처럼 읽힌다.
   */
  setScene(on: boolean): void {
    if (this.#scene === on) return;
    this.#scene = on;
    this.#outcome = null;
    this.#count = null;
    this.#activeName = null;
    this.#lastError = null;
    this.#emit();
  }

  /** 소켓이 끊겼거나 새 워커가 붙었다. 지난 결과는 이미 죽은 세션의 것이다 */
  reset(): void {
    this.#scene = false;
    this.#applying = false;
    this.#outcome = null;
    this.#count = null;
    this.#activeName = null;
    this.#lastError = null;
    this.#emit();
  }

  // ── 사용자 조작 ───────────────────────────────────────────

  /**
   * 저장된 자동 드레이프를 적용한다.
   *
   * **던지지 않는다** — 버튼 핸들러에서 도는 함수라, 던지면 `void` 로 삼켜져
   * 화면에 아무 단서도 안 남는다(`PlaybackController` 와 같은 규약). 결과는
   * `view.text` 와 돌려주는 값으로만 보인다.
   *
   * @returns **드레이프가 실제로 씌워졌는가.** `applied:false`(자동 드레이프
   *   없음)도 `false` 다 — 성공/실패가 아니라 "옷이 바뀌었는가" 를 답한다.
   */
  async apply(): Promise<boolean> {
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

    this.#applying = true;
    this.#lastError = null;
    this.#emit();

    let res: LoadDrapingResult;
    try {
      res = await this.#port.loadDraping();
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

    if (!res.applied) {
      this.#outcome = res.reason === 'loadFailed' ? 'loadFailed' : 'noAutoItem';
      if (this.#outcome === 'loadFailed') this.#stats.loadFailed += 1;
      else this.#stats.noAutoItem += 1;
      this.#log(
        this.#outcome === 'loadFailed'
          ? `드레이프 — 엔진이 적용에 실패했습니다 (아이템 ${res.count}개)`
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
