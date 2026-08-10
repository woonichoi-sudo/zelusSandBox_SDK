/**
 * 펼침 컨트롤의 **상태와 판정** — DOM 없음.
 *
 * `panels/playback.ts` 와 같은 자리에 있는 파일이다. 화면에 남길 글자와 "지금
 * 만질 수 있는가" 를 여기서 정하고, `main.ts` 는 그 결과를 그리기만 한다.
 * 값이 하나(`t`)뿐인데도 모듈을 따로 두는 이유는 ISSUE-009 때문이다 — 그때
 * 재생 상태가 `main.ts` 의 불리언 두 개로 흩어져 있어서 "버튼은 정지인데 시뮬은
 * 멈춰 있다" 를 자동 테스트가 한 줄도 덮지 못했다. **화면이 말하는 것과 실제가
 * 갈라질 수 있는 곳은 전부 DOM 밖으로 뺀다.**
 */

import type { UnfoldStats } from './unfold.ts';

/** 화면이 그대로 그리면 되는 한 벌. **여기 없는 것은 화면에 없다** */
export interface UnfoldView {
  /** 0 = 3D, 1 = 2D 도면 */
  t: number;
  /** 슬라이더를 만질 수 있는가 */
  enabled: boolean;
  /** 상태 글자 */
  label: string;
  /**
   * 만질 수 없는 이유, 또는 도면이 불완전한 이유. 없으면 null.
   *
   * ⚠️ 비활성을 **회색으로만** 두지 않는다 — #16 이 세운 규칙이다. 왜 못
   *    만지는지가 화면에 글자로 남아야 한다.
   */
  reason: string | null;
  /** 완전히 3D 인가 (t === 0) */
  is3d: boolean;
  /** 완전히 도면인가 (t === 1) */
  is2d: boolean;
}

/**
 * 펼침 상태 하나. **`t` 의 정본이다.**
 *
 * 슬라이더의 `value` 를 정본으로 삼지 않는 이유: 씬이 없거나 배치를 못 받았을
 * 때 슬라이더는 비활성이지만 값은 남아 있다. 그 값을 그대로 믿으면 "만질 수
 * 없는데 2D 로 보이는" 상태가 만들어진다.
 */
export class UnfoldController {
  #t = 0;
  #stats: UnfoldStats | null = null;
  #hasScene = false;

  get t(): number {
    return this.#t;
  }

  /** 실제로 화면에 반영해야 할 값. 만질 수 없는 상태면 **항상 0 이다** */
  get effectiveT(): number {
    return this.#usable ? this.#t : 0;
  }

  get #usable(): boolean {
    return this.#hasScene && (this.#stats?.placed ?? 0) > 0;
  }

  /** 씬이 섰다 / 내려갔다 */
  setScene(has: boolean): void {
    this.#hasScene = has;
    // 씬이 내려가면 펼침도 의미가 없다. 값을 남겨 두면 다음 씬이 뜨는 순간
    // 사용자가 지시한 적 없는 2D 화면이 나온다.
    if (!has) this.#t = 0;
  }

  /** `Unfolder.build()` 결과를 받는다 */
  setStats(stats: UnfoldStats | null): void {
    this.#stats = stats;
    if (!this.#usable) this.#t = 0;
  }

  /** 슬라이더가 움직였다. 범위를 벗어난 값은 잘라 넣는다 */
  set(t: number): void {
    if (!Number.isFinite(t)) return;
    if (!this.#usable) {
      this.#t = 0;
      return;
    }
    this.#t = t <= 0 ? 0 : t >= 1 ? 1 : t;
  }

  get view(): UnfoldView {
    const s = this.#stats;
    const t = this.effectiveT;

    if (!this.#hasScene) {
      return {
        t: 0, enabled: false, is3d: true, is2d: false,
        label: '—',
        reason: '씬이 없습니다',
      };
    }
    if (!s || s.placed === 0) {
      return {
        t: 0, enabled: false, is3d: true, is2d: false,
        label: '—',
        reason: s && s.patterns > 0
          // 워커가 서피스를 모르는 경우다. 화면이 "안 된다" 가 아니라 **왜**
          // 안 되는지를 말해야 다음 사람이 워커를 볼 생각을 한다.
          ? `패턴 ${s.patterns}개 모두 2D 배치가 없습니다 — 도면을 그릴 수 없습니다`
          : '패턴이 없습니다',
      };
    }

    const pct = Math.round(t * 100);
    return {
      t,
      enabled: true,
      is3d: t === 0,
      is2d: t === 1,
      // 화면이 좁다(아래쪽 가운데 띠가 252px). 글자를 짧게 두되 양 끝이
      // 무엇인지는 남긴다 — 퍼센트만 있으면 100% 가 3D 인지 2D 인지 모른다.
      label: t === 0 ? '0% 3D' : t === 1 ? '100% 2D' : `${pct}%`,
      // ★ 배치를 못 받은 패턴이 있으면 **항상** 말한다. t 와 무관하다 —
      //   도면이 불완전하다는 사실은 3D 로 돌아가 있어도 참이다.
      //   (그 패턴들은 `Unfolder` 가 모핑에서 빼 두므로 t=1 에서 혼자 3D 로
      //    떠 있게 된다. 그 낯선 그림의 이유가 이 글자다.)
      reason: s.unplaced > 0
        ? `패턴 ${s.unplaced}개는 2D 배치가 없어 3D 자리에 남습니다`
        : null,
    };
  }
}
