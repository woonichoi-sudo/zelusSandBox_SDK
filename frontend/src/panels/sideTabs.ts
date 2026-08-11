/**
 * 오른쪽 칸의 탭 전환 판단 (L-3c) — **DOM 도 three 도 만지지 않는다.**
 *
 * `avatarBody.ts` · `surfaceSize.ts` 와 같은 규약이다. 그리는 것은
 * `ui/sideTabs.ts`, 배선은 `main.ts` 다.
 *
 * ── 왜 탭인가 ───────────────────────────────────────────────
 *
 * L-3a·L-3b 가 오른쪽 칸에 아바타 체형(슬라이더 29 + 치수 25)과 옷 사이즈
 * (행 24)를 **한 줄로 이어** 놓았다. 78행이 한 스크롤에 들어가면 아래쪽 옷
 * 사이즈는 사실상 안 보인다 — 스크롤 막대가 이미 다 내려간 것처럼 짧아서
 * "더 있다" 는 신호가 화면에 남지 않는다.
 *
 * ── ★ 여기가 갖는 유일한 사실: 탭 ↔ 상자의 짝 ───────────────
 *
 * `paneId` 를 `main.ts` 가 아니라 이 모듈이 들고 있는 이유다. "아바타 탭이
 * 켜지면 `#avatarPanel` 이 보인다" 는 **판단**이고, 배선에 두면 Node 에서
 * 확인할 방법이 사라진다. 문자열 하나를 갖고 있을 뿐 `document` 를 부르지
 * 않으므로 이 디렉토리의 규칙은 그대로다 — 상자를 실제로 찾아내는 것은
 * `ui/sideTabs.ts` 의 일이다.
 *
 * ── 기본 탭이 아바타인 이유 ─────────────────────────────────
 *
 * 옷 사이즈는 몸이 정해진 다음의 조정이다. 순서가 거꾸로면 사용자가 옷을
 * 맞춰 놓고 몸을 바꿔 그 조정을 무르게 된다.
 */

export type SideTabId = 'avatar' | 'surface';

/** 탭 하나의 정의. **순서가 곧 화면 순서다** */
export interface SideTabDef {
  id: SideTabId;
  label: string;
  /**
   * 이 탭이 보여 주는 상자의 `id`. 위 머리말 참고 — DOM 을 만지는 것이
   * 아니라 짝을 기억하는 것이다.
   */
  paneId: string;
}

/**
 * 탭 목록. `avatarBody.ts` 의 `LABELS` 와 달리 이쪽은 **진짜 목록이다** —
 * 오른쪽 칸의 상자는 우리가 `index.html` 에 박은 것이라 엔진이 늘리지 않는다.
 */
export const SIDE_TABS: readonly SideTabDef[] = [
  { id: 'avatar', label: '아바타', paneId: 'avatarPanel' },
  { id: 'surface', label: '옷 사이즈', paneId: 'surfacePanel' },
];

/** 화면에 그릴 탭 한 개 */
export interface SideTabItem extends SideTabDef {
  active: boolean;
}

export interface SideTabsView {
  active: SideTabId;
  tabs: SideTabItem[];
}

/** 기본 활성 탭 (머리말 참고) */
export const DEFAULT_SIDE_TAB: SideTabId = 'avatar';

export function isSideTabId(id: string): id is SideTabId {
  return SIDE_TABS.some((t) => t.id === id);
}

/**
 * 오른쪽 칸의 탭 상태. **DOM 을 모른다.**
 *
 * 패널 둘의 내용은 이 모듈이 전혀 건드리지 않는다 — 어느 쪽이 보이는지만
 * 정한다. 그래서 숨은 탭도 계속 갱신되고(`main.ts` 가 씬마다 둘 다 그린다),
 * 탭을 켜는 순간 이미 최신이다.
 */
export class SideTabsPanel {
  #active: SideTabId = DEFAULT_SIDE_TAB;

  get active(): SideTabId {
    return this.#active;
  }

  /**
   * 탭을 켠다.
   *
   * **모르는 id 는 조용히 무시한다.** 던지면 배선(클릭 핸들러)이 죽는데,
   * 탭 하나를 잘못 부른 대가로 오른쪽 칸 전체가 멎는 것은 과하다.
   *
   * @returns 실제로 바뀌었으면 참. 부르는 쪽이 스크롤 저장/복원을 이때만
   *          하도록 쓴다 — 같은 탭을 다시 눌러 스크롤이 튀면 안 된다.
   */
  select(id: string): boolean {
    if (!isSideTabId(id)) return false;
    if (id === this.#active) return false;
    this.#active = id;
    return true;
  }

  /** 기본 탭으로 되돌린다 */
  reset(): void {
    this.#active = DEFAULT_SIDE_TAB;
  }

  get view(): SideTabsView {
    return {
      active: this.#active,
      tabs: SIDE_TABS.map((t) => ({ ...t, active: t.id === this.#active })),
    };
  }
}
